#!/usr/bin/env node
/**
 * @description Vendors the Claude Harness `core/` into a target project's `.claude/`.
 *
 * Portable source resolution (Fase C, option b): the source is the claude-harness
 * repo. Pass a local path that contains `core/`, or a git URL to shallow-clone.
 * Node builtins only — no install, no node_modules (Anthropic skill best practice).
 *
 * Usage:
 *   node vendor-core.mjs --source <path-or-git-url> [--ref <tag/branch>]
 *                        [--target <project-dir>] [--date <iso>]
 *
 * Behavior (idempotent — safe to re-run to update):
 *   - framework-owned (overwritten): agents/, skills/, rules/, hooks/ (*.test.mjs excluded), CLAUDE-HARNESS-MEMORY-MODEL.md
 *   - accumulated (created only if absent, never clobbered): memory/MEMORY.md, kaizen.md
 *   - .claude/CLAUDE.md: harness block merged between markers, project content preserved
 *   - settings.json: copied if absent; if present, written as settings.harness.json for manual merge
 *   - .claude/.gitignore + .claude/.harness-version: written
 *
 * Exit codes: 0 ok · 1 usage/IO error.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_START = "<!-- harness:start — managed by initializing-projects, do not edit inside -->";
const HARNESS_END = "<!-- harness:end -->";

// Cosmetic-only, TTY-gated progress helpers (no deps — builtins only). NO_COLOR respected per
// no-color.org. `step`/`ok` print as each stage completes so `npx claude-harness init` shows live
// progress instead of one silent block followed by a final dump.
const isTTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (text) => paint(2, text);
const green = (text) => paint(32, text);
const bold = (text) => paint(1, text);

/** @description Prints a live "in progress" line for a stage about to run. */
function step(label) {
  process.stdout.write(`${dim("→")} ${label}\n`);
}

/** @description Prints a live "done" line right after a stage completes. */
function ok(label) {
  process.stdout.write(`${green("✓")} ${label}\n`);
}

const FRAMEWORK_OWNED = ["agents", "skills", "rules", "hooks"];
const FRAMEWORK_FILES = ["CLAUDE-HARNESS-MEMORY-MODEL.md"];

// Opt-in add-on modules (siblings of core/, NOT framework-owned). Each is vendored ONLY when the
// operator opts in (--with-codex) OR it is already present in the target (an update refreshes an
// existing opt-in instead of letting it go stale). Safe default: a fresh init ships NO modules.
const OPT_IN_MODULES = ["codex-adversary"];

// Lone boolean flags (no value follows). Everything else is a `--key value` pair.
const BOOLEAN_FLAGS = new Set(["with-codex"]);
const ACCUMULATED = [
  ["memory/MEMORY.md", "memory"],
  ["kaizen.md", "."],
];

// Repo-level files vendored OUTSIDE .claude/ (into the project root). Non-clobber:
// installed only if absent, so a project's own templates are never overwritten.
// Maps source path under core/ → destination relative to the target repo root.
const REPO_FILES = [
  ["github/ISSUE_TEMPLATE/harness-task.yml", ".github/ISSUE_TEMPLATE/harness-task.yml"],
  ["dev.vars.example", ".dev.vars.example"],
];

const GITIGNORE = `# Claude Harness — ephemeral, never committed
plans/
settings.local.json
*.local.md
.harness-version-check-cache
`;

/**
 * @description Parses argv into a plain object. `--key value` pairs by default; flags in
 * BOOLEAN_FLAGS (e.g. `--with-codex`) are lone booleans with no value following.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) fail(`unexpected argument: ${key}`);
    const name = key.slice(2);
    if (BOOLEAN_FLAGS.has(name)) args[name] = true;
    else args[name] = argv[++i];
  }
  return args;
}

/** @description Prints an error to stderr and exits 1. */
function fail(message) {
  process.stderr.write(`[vendor-core] ${message}\n`);
  process.exit(1);
}

/**
 * @description Resolves the source to a local directory containing `core/`.
 * A local path is used in place; a git URL is shallow-cloned to a temp dir.
 * Returns { coreDir, version, cleanup }.
 */
function resolveSource(source, ref) {
  if (!source) fail("--source is required (local path with core/ or a git URL)");

  const looksLocal = existsSync(source);
  let repoDir = source;
  let cleanup = () => {};

  if (!looksLocal) {
    const dest = mkdtempSync(join(tmpdir(), "harness-src-"));
    const cloneArgs = ["clone", "--depth", "1"];
    if (ref) cloneArgs.push("--branch", ref);
    cloneArgs.push(source, dest);
    step(`Downloading harness${ref ? ` (${ref})` : ""} from ${source}...`);
    try {
      // stderr inherited only on a real TTY so git's own progress meter streams live; piped/CI
      // output stays silent (no half-finished progress bar noise in logs).
      execFileSync("git", cloneArgs, { stdio: ["ignore", "ignore", isTTY ? "inherit" : "pipe"] });
    } catch (err) {
      rmSync(dest, { recursive: true, force: true });
      fail(`git clone failed for "${source}": ${err.message}`);
    }
    ok("harness downloaded");
    repoDir = dest;
    cleanup = () => rmSync(dest, { recursive: true, force: true });
  }

  const coreDir = join(repoDir, "core");
  if (!existsSync(coreDir)) {
    cleanup();
    fail(`no core/ found under source "${source}"`);
  }

  return { coreDir, version: readVersion(repoDir), cleanup };
}

/** @description Best-effort version string from git, else "unknown". */
function readVersion(repoDir) {
  try {
    return execFileSync("git", ["-C", repoDir, "describe", "--tags", "--always"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/**
 * @description Pure predicate for the framework-owned copy filter.
 * Returns true when the given source path should be included in the vendor copy,
 * false when it should be excluded. Only `.test.mjs` files are excluded — all other
 * files (including `settings.json` in hand-config/) survive the filter and reach
 * consumer projects.
 * @param {string} src - Absolute or relative source file path.
 * @returns {boolean} True = include, false = exclude.
 */
export function isFrameworkCopyIncluded(src) {
  return !src.endsWith(".test.mjs");
}

/** @description Copies framework-owned dirs/files into .claude/, overwriting. */
function copyFrameworkOwned(coreDir, claudeDir) {
  const filter = (src, _dest) => isFrameworkCopyIncluded(src);
  for (const dir of FRAMEWORK_OWNED) {
    const src = join(coreDir, dir);
    if (existsSync(src)) cpSync(src, join(claudeDir, dir), { recursive: true, filter });
  }
  for (const file of FRAMEWORK_FILES) {
    const src = join(coreDir, file);
    if (existsSync(src)) cpSync(src, join(claudeDir, file));
  }
}

/**
 * @description The hooks vendored into `.claude/hooks/` import runtime modules from `core/vps/`
 * (e.g. `stamp-triage.mjs` and `obs-eye-append.mjs` both `import "../vps/obs-outbox.mjs"` for the
 * observability outbox). `vps/` is NOT framework-owned, so without this the vendored hook resolves
 * an `import` path that does not exist under `.claude/` → ERR_MODULE_NOT_FOUND → the hook crashes on
 * load → `stamp-triage` never writes `triage.json` → the entry-gate blocks every delivery subagent.
 * This mirrors ONLY the vps modules the hooks actually import (transitive closure of their `./`
 * siblings inside `vps/`) into `.claude/vps/` — never the whole cron runtime.
 * @param {string} coreDir
 * @param {string} claudeDir
 * @returns {string} status string
 */
function copyHookVpsDeps(coreDir, claudeDir) {
  const hooksDir = join(coreDir, "hooks");
  if (!existsSync(hooksDir)) return "none (no hooks/)";
  const VPS_IMPORT = /from\s+['"]\.\.\/vps\/([\w.-]+\.mjs)['"]/g;
  const SIBLING_IMPORT = /from\s+['"]\.\/([\w.-]+\.mjs)['"]/g;

  // Seed the worklist from the hooks' direct `../vps/` imports. Only the hooks that are actually
  // vendored count — exclude `*.test.mjs` (same rule as isFrameworkCopyIncluded), whose imports
  // never ship, so a test-only import of a heavy vps module is not needlessly mirrored.
  const queue = [];
  for (const file of readdirSync(hooksDir)) {
    if (!file.endsWith(".mjs") || !isFrameworkCopyIncluded(file)) continue;
    const text = readFileSync(join(hooksDir, file), "utf8");
    for (const m of text.matchAll(VPS_IMPORT)) queue.push(m[1]);
  }

  // Transitive closure INSIDE vps/: an imported vps module may import a sibling vps module.
  const copied = [];
  const seen = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const src = join(coreDir, "vps", name);
    if (!existsSync(src) || src.endsWith(".test.mjs")) continue;
    mkdirSync(join(claudeDir, "vps"), { recursive: true });
    cpSync(src, join(claudeDir, "vps", name));
    copied.push(name);
    const text = readFileSync(src, "utf8");
    for (const m of text.matchAll(SIBLING_IMPORT)) queue.push(m[1]);
  }
  return copied.length ? copied.sort().join(", ") : "none (hooks import no vps modules)";
}

/**
 * @description Post-vendor integrity check over the FINAL vendored state: every `../vps/<mod>.mjs`
 * a vendored hook imports MUST exist under `.claude/vps/`. Catches the stale-jump — a project whose
 * ALREADY-vendored vendor-core predates the vps-mirroring step runs the OLD logic on an update: it
 * refreshes the hooks to a new `../vps/` import WITHOUT creating `.claude/vps/`, shipping a hook that
 * dies with ERR_MODULE_NOT_FOUND on load (invisibly, since PostToolUse hooks are fire-and-forget — the
 * only symptom is the entry-gate silently blocking every delivery subagent). Pure read-only. Returns
 * the list of `{ hook, module }` pairs still missing (empty ⇒ complete).
 * @param {string} claudeDir
 * @returns {{ hook: string, module: string }[]}
 */
export function findMissingHookVpsDeps(claudeDir) {
  const hooksDir = join(claudeDir, "hooks");
  const vpsDir = join(claudeDir, "vps");
  const missing = [];
  if (!existsSync(hooksDir)) return missing;
  const VPS_IMPORT = /from\s+['"]\.\.\/vps\/([\w.-]+\.mjs)['"]/g;
  for (const file of readdirSync(hooksDir)) {
    if (!file.endsWith(".mjs") || !isFrameworkCopyIncluded(file)) continue;
    const text = readFileSync(join(hooksDir, file), "utf8");
    for (const m of text.matchAll(VPS_IMPORT)) {
      if (!existsSync(join(vpsDir, m[1]))) missing.push({ hook: file, module: m[1] });
    }
  }
  return missing;
}

/**
 * @description Pure predicate: should this opt-in module be vendored? True when the operator opts in
 * (`--with-codex`) OR the module is ALREADY vendored in the target (so an update refreshes it instead
 * of leaving it stale — without the flag, but never against the operator's prior choice). Safe
 * default: a fresh init without the flag ships no module.
 * @param {string} claudeDir - The target `.claude/` dir.
 * @param {string} moduleName
 * @param {boolean} withCodex
 * @param {(p: string) => boolean} [exists]
 * @returns {boolean}
 */
export function shouldVendorModule(claudeDir, moduleName, withCodex, exists = existsSync) {
  if (withCodex) return true;
  return exists(join(claudeDir, "modules", moduleName));
}

/**
 * @description Copies opt-in modules (siblings of core/) into `.claude/modules/`, overwriting,
 * excluding `*.test.mjs` (the source repo is the test home). Gated per-module by shouldVendorModule.
 * Returns a status string. `modulesRoot` is `<repoDir>/modules` (core/ is `<repoDir>/core`).
 */
function copyModules(modulesRoot, claudeDir, withCodex) {
  const filter = (src, _dest) => isFrameworkCopyIncluded(src);
  const copied = [];
  for (const name of OPT_IN_MODULES) {
    const src = join(modulesRoot, name);
    if (!existsSync(src)) continue;
    if (!shouldVendorModule(claudeDir, name, withCodex)) continue;
    cpSync(src, join(claudeDir, "modules", name), { recursive: true, filter });
    copied.push(name);
  }
  return copied.length ? copied.join(", ") : "none (default off; pass --with-codex to enable)";
}

/** @description Copies accumulated stores only when absent (never clobbers). */
function seedAccumulated(coreDir, claudeDir) {
  for (const [rel, parent] of ACCUMULATED) {
    const dest = join(claudeDir, rel);
    if (existsSync(dest)) continue;
    mkdirSync(join(claudeDir, parent), { recursive: true });
    const src = join(coreDir, rel);
    if (existsSync(src)) cpSync(src, dest);
  }
}

/**
 * @description Installs repo-level files (outside .claude/) into the target repo root,
 * only when absent — never clobbers a project's own files. Returns a status string.
 */
function installRepoFiles(coreDir, targetDir) {
  const installed = [];
  for (const [rel, dest] of REPO_FILES) {
    const src = join(coreDir, rel);
    const out = join(targetDir, dest);
    if (!existsSync(src) || existsSync(out)) continue;
    mkdirSync(dirname(out), { recursive: true });
    cpSync(src, out);
    installed.push(dest);
  }
  return installed.length ? installed.join(", ") : "none (already present or no source)";
}

/**
 * @description Idempotently ensures the target repo ROOT `.gitignore` ignores the runtime
 * auth-token files. vendor ships `.dev.vars.example` to the project root and the documented
 * setup copies it to `.dev.vars` (which the dispatch runner reads from the cwd root). The
 * only ignore file vendor otherwise writes is `.claude/.gitignore`, which CANNOT cover a
 * root-level file — so without this the real Ollama token lands in a NON-ignored file and a
 * `git add` commits it. Non-clobber: only a literal bare `.dev.vars` line proves the token
 * file is ignored — a prefix match would be fooled by sibling entries vendor itself ships
 * (`.dev.vars.example`, a committed file) or a glob (`.dev.vars.*`, which does NOT match the
 * extensionless `.dev.vars`), wrongly skipping the append and leaving the token un-ignored. A
 * later `!.dev.vars` negation also un-does the ignore. Returns a status string.
 */
function ensureDevVarsIgnored(targetDir) {
  const gitignore = join(targetDir, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const hasBareEntry = lines.some((line) => line === ".dev.vars");
  const hasNegation = lines.some((line) => line === "!.dev.vars");
  if (hasBareEntry && !hasNegation) return "already ignored";

  const block =
    "\n# Claude Harness — Ollama auth token, never commit\n.dev.vars\n.dev.vars.*\n.env\n.env.*\n";
  const body = `${current.trimEnd()}${block}`;
  writeFileSync(gitignore, current.trim() ? body : body.replace(/^\n/, ""));
  return "added .dev.vars block";
}

/**
 * @description Idempotent merge of the harness entry-policy into .claude/CLAUDE.md.
 * Replaces the content between the markers if present, else appends a fresh block.
 * Project content outside the markers is preserved.
 */
function mergeClaudeMd(coreDir, claudeDir) {
  const harness = readFileSync(join(coreDir, "CLAUDE.md"), "utf8").trim();
  const block = `${HARNESS_START}\n${harness}\n${HARNESS_END}\n`;
  const target = join(claudeDir, "CLAUDE.md");

  if (!existsSync(target)) {
    writeFileSync(target, block);
    return "created";
  }

  const current = readFileSync(target, "utf8");
  const startIdx = current.indexOf(HARNESS_START);
  const endIdx = current.indexOf(HARNESS_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = current.slice(0, startIdx);
    const after = current.slice(endIdx + HARNESS_END.length);
    writeFileSync(target, `${before}${block.trimEnd()}${after}`);
    return "updated";
  }

  writeFileSync(target, `${current.trimEnd()}\n\n${block}`);
  return "appended";
}

/**
 * @description Writes settings.json if absent; otherwise writes settings.harness.json
 * so the operator merges manually (never clobber an existing config).
 */
function writeSettings(coreDir, claudeDir) {
  const src = join(coreDir, "settings.json");
  if (!existsSync(src)) return "skipped (no source settings.json)";
  const dest = join(claudeDir, "settings.json");
  if (!existsSync(dest)) {
    cpSync(src, dest);
    return "created";
  }
  cpSync(src, join(claudeDir, "settings.harness.json"));
  return "exists → wrote settings.harness.json for manual merge";
}

// ---------- main (runs only when invoked directly as a script) ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const target = args.target ?? process.cwd();
  const claudeDir = join(target, ".claude");
  const stampDate = args.date ?? new Date().toISOString();

  const { coreDir, version, cleanup } = resolveSource(args.source, args.ref);

  const startedAt = Date.now();
  try {
    mkdirSync(claudeDir, { recursive: true });

    copyFrameworkOwned(coreDir, claudeDir);
    ok("agents/skills/rules/hooks copied (*.test.mjs excluded)");

    const hookVpsDeps = copyHookVpsDeps(coreDir, claudeDir);
    ok(`hooks' vps deps → .claude/vps/: ${hookVpsDeps}`);

    const modules = copyModules(join(coreDir, "..", "modules"), claudeDir, Boolean(args["with-codex"]));
    ok(`modules: ${modules}`);

    seedAccumulated(coreDir, claudeDir);
    ok("memory/MEMORY.md, kaizen.md seeded (if absent)");

    const claudeMd = mergeClaudeMd(coreDir, claudeDir);
    ok(`CLAUDE.md: ${claudeMd}`);

    const settings = writeSettings(coreDir, claudeDir);
    ok(`settings.json: ${settings}`);

    const repoFiles = installRepoFiles(coreDir, target);
    ok(`repo files (.github/…): ${repoFiles}`);

    const devVarsIgnore = existsSync(join(coreDir, "dev.vars.example"))
      ? ensureDevVarsIgnored(target)
      : "skipped (no dev.vars.example source)";
    ok(`root .gitignore (.dev.vars): ${devVarsIgnore}`);

    // Integrity gate: FAIL LOUD (never ship a hook that will crash on load) if the final vendored
    // state is missing a `../vps/` module a hook imports. This catches the stale-jump — an update
    // driven by an OLD vendored vendor-core that refreshed the hooks but did not mirror vps/. Runs
    // BEFORE the version stamp so a broken vendor never records success.
    const missingVpsDeps = findMissingHookVpsDeps(claudeDir);
    if (missingVpsDeps.length > 0) {
      const lines = missingVpsDeps.map((m) => `    ${m.hook} imports ../vps/${m.module} — MISSING in .claude/vps/`);
      fail(
        [
          "FATAL — vendored hooks import vps modules that were not mirrored to .claude/vps/:",
          ...lines,
          "  A hook with a missing ../vps/ import crashes on load (ERR_MODULE_NOT_FOUND) and silently",
          "  blocks the entry-gate. Re-run vendor-core (this same, current copy) to mirror them.",
        ].join("\n"),
      );
    }

    writeFileSync(join(claudeDir, ".gitignore"), GITIGNORE);
    writeFileSync(
      join(claudeDir, ".harness-version"),
      `${version}\nvendored_at: ${stampDate}\n`
    );
    ok(".gitignore, .harness-version written");

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(`\n${bold(green(`✓ harness ${version} vendored → ${claudeDir} (${elapsedSec}s)`))}\n`);
  } finally {
    cleanup();
  }
}
