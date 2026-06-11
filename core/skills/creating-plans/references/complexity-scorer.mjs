#!/usr/bin/env node
/**
 * @description Dependency-free implementation-complexity scorer — Claude Harness.
 *
 * Deterministic heuristic over a source file (imports, branches, loops, async,
 * coupling, risky patterns) → a low/medium/high/x-high band used to sanity-check the
 * `complexity` the planner assigned (which routes the executor model). ADVISORY in
 * CC: the Opus planner judges residual complexity well; run this as a cross-check,
 * not an oracle. Node builtins only — no node_modules (Anthropic skills best practice).
 *
 * Caveat (N4): scores the WHOLE file, not the DELTA — a large file the task barely
 * touches over-scores. Treat a surprising band as a prompt to re-judge, not a verdict.
 *
 * Recalibration (ported from the OpenCode scorer, both tranches) so the score
 * reflects real residual complexity instead of inflating idiomatic TS/React:
 *   - perAsync 3→1, counts only `await` (not the `async` declaration keyword);
 *   - perBranch 2→1; `switch` counted once; `else`/`case`/`default` dropped (cyclomatic
 *     doesn't double-charge); loops (for/while/do) added at weight 2;
 *   - service patterns collapsed into 3 families, capped at SERVICE_SCORE_CAP;
 *   - imports capped at IMPORT_SCORE_CAP, local-deps at LOCAL_DEP_SCORE_CAP (perLocalDep 2→1),
 *     `import type` / `export type` excluded (compile-time only, zero runtime coupling);
 *   - LINES_PER_POINT 100→50 (size is the most defensible signal);
 *   - SHARED_DIR / COMPONENT_DIR anchored to path SEGMENTS (no `libraries/`/`commons/` false match);
 *   - sharedLocation 5→3, perComplexPattern / perLockPattern 5→3;
 *   - should_split fires on x-high OR code_lines > SPLIT_LINES_THRESHOLD.
 *
 * Band contract (CC): low/medium/high/x-high — 4 bands, mapping to the executor
 * tiers (haiku/sonnet/opus) + x-high force-split. Unlike the OpenCode scorer there is
 * NO `max` band here. CONTRACT with planner.md / creating-plans SKILL.md — keep 4 bands.
 *
 * Usage:   node complexity-scorer.mjs <path-to-source-file>
 * Output:  JSON verdict on stdout, exit 0. Errors on stderr, exit 1.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Score contribution per unit of each metric (recalibrated). */
const WEIGHT = {
  sharedLocation: 3,
  componentLocation: 2,
  perImport: 1,
  perLocalDep: 1,
  perBranch: 1,
  perLoop: 2,
  perAsync: 1,
  perComplexPattern: 3,
  perLockPattern: 3,
  perServicePattern: 3,
};

const LOCAL_DEP_SCORE_CAP = 4;
/** Imports score cap (import type lines excluded). */
const IMPORT_SCORE_CAP = 6;
/** Max total points from service-family patterns (3 families × weight 3 = 9; cap at 6). */
const SERVICE_SCORE_CAP = 6;
const LINES_PER_POINT = 50;
const BINARY_SNIFF_BYTES = 8000;
/** Files with more code lines than this trigger should_split regardless of band. */
const SPLIT_LINES_THRESHOLD = 400;

/** Inclusive upper bound of each band; anything above `high` is x-high (force-split).
 *  CONTRACT with planner.md / creating-plans SKILL.md — 4 bands, NO `max`. */
const BAND = { low: 10, medium: 30, high: 60 };

/** Args the agent is likely to send when it forgot to substitute a real path. */
const PLACEHOLDER_ARG = /^<.*>$|^(file|file-?path|path)$/i;

/**
 * Anchored to path segments to avoid false matches on substrings like
 * `libraries/`, `commons/`, or `my-component-lib/`.
 */
const SHARED_DIR = /(^|\/)(?:hooks|lib|utils|shared|common)(\/|$)/i;
const COMPONENT_DIR = /(^|\/)components(\/|$)/i;

const COMPLEX_PATTERNS = [
  { label: "reducer", re: /\breducer\b/i },
  { label: "state machine", re: /\bstate\s*machine\b/i },
  { label: "fsm", re: /\bfsm\b/i },
  { label: "parser", re: /\bparser\b/i },
  { label: "lexer", re: /\blexer\b/i },
  { label: "transformer", re: /\btransformer\b/i },
  { label: "compiler", re: /\bcompiler\b/i },
  { label: "interpreter", re: /\binterpreter\b/i },
  { label: "middleware", re: /\bmiddleware\b/i },
  { label: "validator", re: /\bvalidator\b/i },
];
const LOCK_PATTERNS = [
  { label: "transaction", re: /\btransaction\b/i },
  { label: "mutex", re: /\bmutex\b/i },
  { label: "lock", re: /\block\b/i },
  { label: "atomic", re: /\batomic\b/i },
  { label: "semaphore", re: /\bsemaphore\b/i },
  { label: "critical section", re: /\bcritical\s*section\b/i },
];

/**
 * Service patterns collapsed into 3 families. Each family contributes at most once
 * to the service score; total further capped at SERVICE_SCORE_CAP. Prevents the
 * old `env.` + `process.env` double-count.
 */
const SERVICE_FAMILIES = [
  { label: "platform-access", patterns: [/\benv\./i, /\bbinding\b/i, /\bprocess\.env\b/] },
  { label: "network", patterns: [/\bfetch\s*\(/, /\baxios\b/i, /\brequest\s*\(/] },
  { label: "data", patterns: [/\.query\s*\(/, /\.execute\s*\(/, /\bdatabase\b/i, /\bdb\./i] },
];

/**
 * Remove comments (and optionally string literals) preserving newlines, so line
 * metrics stay accurate and keyword scans don't match tokens inside docs/strings.
 * @param {string} source @param {boolean} blankStrings @returns {string}
 */
export function stripComments(source, blankStrings) {
  let out = "";
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      if (!blankStrings) out += c;
      i++;
      while (i < n) {
        const ch = source[i];
        if (ch === "\\") {
          if (!blankStrings) out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === quote) {
          if (!blankStrings) out += ch;
          i++;
          break;
        }
        if (!blankStrings) out += ch;
        else if (ch === "\n") out += "\n";
        i++;
      }
      if (blankStrings) out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const countMatches = (text, re) => (text.match(re) || []).length;
const listPresent = (text, patterns) => patterns.filter((p) => p.re.test(text)).map((p) => p.label);

/**
 * Import statements: static imports, re-exports, require() and dynamic import().
 * `import type` / `export type` excluded — type-only imports erase at compile time.
 */
function countImports(codeWithStrings) {
  const lines = codeWithStrings.split("\n");
  const staticImports = lines.filter(
    (l) => /^\s*import\b(?!\s*\()/.test(l) && !/^\s*import\s+type\b/.test(l),
  ).length;
  const reExports = lines.filter(
    (l) => /^\s*export\b[^;]*\bfrom\b/.test(l) && !/^\s*export\s+type\b/.test(l),
  ).length;
  const requires = countMatches(codeWithStrings, /\brequire\s*\(/g);
  const dynamicImports = countMatches(codeWithStrings, /\bimport\s*\(/g);
  return staticImports + reExports + requires + dynamicImports;
}

const LOCAL_SPECIFIER = /(?:from|require\s*\(|import\s*\()\s*['"](?:\.|@\/|\/)/;
const countLocalImports = (codeWithStrings) =>
  codeWithStrings
    .split("\n")
    .filter(
      (l) =>
        LOCAL_SPECIFIER.test(l) &&
        !/^\s*import\s+type\b/.test(l) &&
        !/^\s*export\s+type\b/.test(l),
    ).length;

/** `?` that starts a ternary. Excludes `?.`, `??`, `?:` via lookbehind/lookahead. */
const countTernaries = (code) => countMatches(code, /(?<!\?)\?(?![.?:=])/g);

/** Conditional branches: if / switch (once) / ternary. else/case/default dropped. */
const countBranches = (code) =>
  countMatches(code, /\bif\s*\(/g) +
  countMatches(code, /\bswitch\s*\(/g) +
  countTernaries(code);

/** Real loop constructs: for / while / do. Excludes .map/.filter/.reduce. */
const countLoops = (code) =>
  countMatches(code, /\bfor\s*\(/g) +
  countMatches(code, /\bwhile\s*\(/g) +
  countMatches(code, /\bdo\s*\{/g);

/** How many service FAMILIES (out of 3) are present; each counts at most once. */
const countServiceFamilies = (code) =>
  SERVICE_FAMILIES.filter((family) => family.patterns.some((re) => re.test(code))).length;

/** @returns {"low"|"medium"|"high"|"x-high"} */
function classify(score) {
  if (score <= BAND.low) return "low";
  if (score <= BAND.medium) return "medium";
  if (score <= BAND.high) return "high";
  return "x-high";
}

/**
 * Run the full heuristic over one file's source. No side effects; exported for tests.
 * @param {string} relativePath - Path used for location heuristics.
 * @param {string} source - Raw source text.
 * @returns {object} ScoreResult with band, breakdown, split recommendation.
 */
export function analyzeSource(relativePath, source) {
  const codeWithStrings = stripComments(source, false);
  const code = stripComments(source, true);
  const breakdown = {};
  let total = 0;
  const add = (metric, score, detail) => {
    breakdown[metric] = { score, detail };
    total += score;
  };

  const dir = path.dirname(relativePath);
  if (SHARED_DIR.test(dir + "/")) add("shared-location", WEIGHT.sharedLocation, `File in shared directory: ${dir}`);
  else if (COMPONENT_DIR.test(dir + "/")) add("component-location", WEIGHT.componentLocation, `File in components directory: ${dir}`);
  else add("isolated-location", 0, `File in isolated directory: ${dir}`);

  const importCount = countImports(codeWithStrings);
  add("imports", Math.min(importCount * WEIGHT.perImport, IMPORT_SCORE_CAP), `${importCount} import statements (capped at ${IMPORT_SCORE_CAP})`);

  const localImportCount = countLocalImports(codeWithStrings);
  add("local-deps", Math.min(localImportCount * WEIGHT.perLocalDep, LOCAL_DEP_SCORE_CAP), `${localImportCount} local imports (depth proxy)`);

  const codeLines = code.split("\n").filter((l) => l.trim().length > 0).length;
  add("lines-of-code", Math.floor(codeLines / LINES_PER_POINT), `${codeLines} non-empty, non-comment lines`);

  const branchCount = countBranches(code);
  add("branches", branchCount * WEIGHT.perBranch, `${branchCount} conditional branches`);

  const loopCount = countLoops(code);
  add("loops", loopCount * WEIGHT.perLoop, `${loopCount} loop constructs (for/while/do)`);

  const asyncCount = countMatches(code, /\bawait\b/g);
  add("async-await", asyncCount * WEIGHT.perAsync, `${asyncCount} await expressions`);

  const complex = listPresent(code, COMPLEX_PATTERNS);
  add("complex-patterns", complex.length * WEIGHT.perComplexPattern, `Patterns: ${complex.join(", ") || "none"}`);

  const locks = listPresent(code, LOCK_PATTERNS);
  add("locks-transactions", locks.length * WEIGHT.perLockPattern, `Patterns: ${locks.join(", ") || "none"}`);

  const serviceFamilyCount = countServiceFamilies(code);
  add("services-bindings", Math.min(serviceFamilyCount * WEIGHT.perServicePattern, SERVICE_SCORE_CAP), `${serviceFamilyCount} service families active (capped at ${SERVICE_SCORE_CAP})`);

  const complexity = classify(total);
  const shouldSplit = complexity === "x-high" || codeLines > SPLIT_LINES_THRESHOLD;
  const splitHint = shouldSplit
    ? codeLines > SPLIT_LINES_THRESHOLD && complexity !== "x-high"
      ? `File has ${codeLines} code lines (>${SPLIT_LINES_THRESHOLD}). Split by domain responsibility even though keyword density is ${complexity}.`
      : `File scored ${total} (x-high). Split into 2-3 sub-tasks based on the ${complex.length > 0 ? "complex patterns" : "high coupling"} detected, then re-score each.`
    : "";

  return {
    file: relativePath,
    score: total,
    complexity,
    should_split: shouldSplit,
    split_hint: splitHint,
    breakdown,
    metrics: {
      code_lines: codeLines,
      import_count: importCount,
      local_import_count: localImportCount,
      branch_count: branchCount,
      loop_count: loopCount,
      async_count: asyncCount,
      complex_pattern_count: complex.length,
      lock_count: locks.length,
      service_family_count: serviceFamilyCount,
    },
  };
}

/** True when the sample contains a NUL byte — a cheap "this isn't text" signal. */
export function looksBinary(source) {
  const sample = source.slice(0, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sample.length; i++) if (sample.charCodeAt(i) === 0) return true;
  return false;
}

// ---------- CLI ----------

function main() {
  const requested = (process.argv[2] || "").trim();
  if (!requested || PLACEHOLDER_ARG.test(requested)) {
    process.stderr.write('[complexity-scorer] Pass a real source file path, e.g. "src/handlers/auth.ts".\n');
    process.exit(1);
  }
  const absolute = path.isAbsolute(requested) ? requested : path.join(process.cwd(), requested);

  let source;
  try {
    if (statSync(absolute).isDirectory()) {
      process.stderr.write("[complexity-scorer] Path is a directory — pass a single source file.\n");
      process.exit(1);
    }
    source = readFileSync(absolute, "utf8");
  } catch (err) {
    const code = err && err.code;
    process.stderr.write(`[complexity-scorer] ${code === "ENOENT" ? "File not found" : `Could not read file (${code || "error"})`}: ${absolute}\n`);
    process.exit(1);
  }
  if (looksBinary(source)) {
    process.stderr.write("[complexity-scorer] Binary or non-text file — scoring only applies to source code.\n");
    process.exit(1);
  }

  const relative = path.relative(process.cwd(), absolute) || path.basename(absolute);
  process.stdout.write(JSON.stringify(analyzeSource(relative, source), null, 2) + "\n");
  process.exit(0);
}

// Run as CLI only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) main();
