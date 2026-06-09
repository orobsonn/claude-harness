#!/usr/bin/env node
/**
 * @description Dependency-free implementation-complexity scorer — Claude Harness.
 *
 * Deterministic heuristic over a source file (imports, branches, async, coupling,
 * risky patterns) → a low/medium/high/x-high band used to sanity-check the
 * `complexity` the planner assigned (which routes the executor model). ADVISORY in
 * CC: the Opus planner judges residual complexity well; run this as a cross-check,
 * not an oracle. Node builtins only — no node_modules (Anthropic skills best practice).
 *
 * Caveat (N4, pending P5): scores the WHOLE file, not the DELTA — a large file the
 * task barely touches over-scores. Treat a surprising band as a prompt to re-judge,
 * not a verdict.
 *
 * Usage:   node complexity-scorer.mjs <path-to-source-file>
 * Output:  JSON verdict on stdout, exit 0. Errors on stderr, exit 1.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const WEIGHT = {
  sharedLocation: 5,
  componentLocation: 2,
  perImport: 1,
  perLocalDep: 2,
  perBranch: 2,
  perAsync: 3,
  perComplexPattern: 5,
  perLockPattern: 5,
  perServicePattern: 3,
};
const LOCAL_DEP_SCORE_CAP = 20;
const LINES_PER_POINT = 100;
const BINARY_SNIFF_BYTES = 8000;
const BAND = { low: 10, medium: 30, high: 60 }; // above high → x-high (force-split)

const SHARED_DIR = /(hooks|lib|utils|shared|common)/i;
const COMPONENT_DIR = /components/i;

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
const SERVICE_PATTERNS = [
  { label: "fetch", re: /\bfetch\s*\(/ },
  { label: "axios", re: /\baxios\b/i },
  { label: "request", re: /\brequest\s*\(/ },
  { label: "query", re: /\.query\s*\(/ },
  { label: "execute", re: /\.execute\s*\(/ },
  { label: "database", re: /\bdatabase\b/i },
  { label: "db", re: /\bdb\./i },
  { label: "binding", re: /\bbinding\b/i },
  { label: "env", re: /\benv\./i },
  { label: "process.env", re: /\bprocess\.env\b/ },
];

/** Remove comments (and optionally string literals) preserving newlines. */
function stripComments(source, blankStrings) {
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

function countImports(codeWithStrings) {
  const lines = codeWithStrings.split("\n");
  const staticImports = lines.filter((l) => /^\s*import\b(?!\s*\()/.test(l)).length;
  const reExports = lines.filter((l) => /^\s*export\b[^;]*\bfrom\b/.test(l)).length;
  const requires = countMatches(codeWithStrings, /\brequire\s*\(/g);
  const dynamicImports = countMatches(codeWithStrings, /\bimport\s*\(/g);
  return staticImports + reExports + requires + dynamicImports;
}

const LOCAL_SPECIFIER = /(?:from|require\s*\(|import\s*\()\s*['"](?:\.|@\/|\/)/;
const countLocalImports = (codeWithStrings) =>
  codeWithStrings.split("\n").filter((l) => LOCAL_SPECIFIER.test(l)).length;

const countTernaries = (code) => countMatches(code, /(?<!\?)\?(?![.?:=])/g);
const countBranches = (code) =>
  countMatches(code, /\bif\s*\(/g) +
  countMatches(code, /\belse\b/g) +
  countMatches(code, /\bswitch\s*\(/g) +
  countMatches(code, /\bcase\b/g) +
  countMatches(code, /\bdefault\s*:/g) +
  countTernaries(code);

function classify(score) {
  if (score <= BAND.low) return "low";
  if (score <= BAND.medium) return "medium";
  if (score <= BAND.high) return "high";
  return "x-high";
}

function analyzeSource(relativePath, source) {
  const codeWithStrings = stripComments(source, false);
  const code = stripComments(source, true);
  const breakdown = {};
  let total = 0;
  const add = (metric, score, detail) => {
    breakdown[metric] = { score, detail };
    total += score;
  };

  const dir = path.dirname(relativePath);
  if (SHARED_DIR.test(dir)) add("shared-location", WEIGHT.sharedLocation, `File in shared directory: ${dir}`);
  else if (COMPONENT_DIR.test(dir)) add("component-location", WEIGHT.componentLocation, `File in components directory: ${dir}`);
  else add("isolated-location", 0, `File in isolated directory: ${dir}`);

  const importCount = countImports(codeWithStrings);
  add("imports", importCount * WEIGHT.perImport, `${importCount} import statements`);

  const localImportCount = countLocalImports(codeWithStrings);
  add("local-deps", Math.min(localImportCount * WEIGHT.perLocalDep, LOCAL_DEP_SCORE_CAP), `${localImportCount} local imports (depth proxy)`);

  const codeLines = code.split("\n").filter((l) => l.trim().length > 0).length;
  add("lines-of-code", Math.floor(codeLines / LINES_PER_POINT), `${codeLines} non-empty, non-comment lines`);

  const branchCount = countBranches(code);
  add("branches", branchCount * WEIGHT.perBranch, `${branchCount} conditional branches`);

  const asyncCount = countMatches(code, /\basync\b/g) + countMatches(code, /\bawait\b/g);
  add("async-await", asyncCount * WEIGHT.perAsync, `${asyncCount} async/await keywords`);

  const complex = listPresent(code, COMPLEX_PATTERNS);
  add("complex-patterns", complex.length * WEIGHT.perComplexPattern, `Patterns: ${complex.join(", ") || "none"}`);

  const locks = listPresent(code, LOCK_PATTERNS);
  add("locks-transactions", locks.length * WEIGHT.perLockPattern, `Patterns: ${locks.join(", ") || "none"}`);

  const services = listPresent(code, SERVICE_PATTERNS);
  add("services-bindings", services.length * WEIGHT.perServicePattern, `Patterns: ${services.join(", ") || "none"}`);

  const complexity = classify(total);
  const shouldSplit = complexity === "x-high";
  return {
    file: relativePath,
    score: total,
    complexity,
    should_split: shouldSplit,
    split_hint: shouldSplit
      ? `File scored ${total} (x-high). Split into 2-3 sub-tasks based on the ${complex.length > 0 ? "complex patterns" : "high coupling"} detected, then re-score each.`
      : "",
    breakdown,
    metrics: {
      code_lines: codeLines,
      import_count: importCount,
      local_import_count: localImportCount,
      branch_count: branchCount,
      async_count: asyncCount,
      complex_pattern_count: complex.length,
      lock_count: locks.length,
      service_count: services.length,
    },
  };
}

function looksBinary(source) {
  const sample = source.slice(0, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sample.length; i++) if (sample.charCodeAt(i) === 0) return true;
  return false;
}

// ---------- CLI ----------

const requested = (process.argv[2] || "").trim();
if (!requested || /^<.*>$|^(file|file-?path|path)$/i.test(requested)) {
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
