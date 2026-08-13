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
 *   - settings.json: copied if absent; if present, MERGED via manifest/ledger (issue #487, same
 *     model as the OpenCode config migration) — harness-owned keys move forward, operator
 *     customizations survive, a stale settings.harness.json orphan from before this migration existed
 *     is consumed and removed
 *   - .claude/.gitignore + .claude/.harness-version: written
 *
 * Exit codes: 0 ok · 1 usage/IO error.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_FILENAME,
  isValidOpencodeConfigShape,
  migrateOpencodeConfig,
  normalizeOcVersionStamp as normalizeHarnessVersionStamp,
  readHarnessVersionStamp,
} from "../../../../shared/lib/opencode-config-migration.mjs";
import { sweepRetiredDispatchCleanup } from "../../../../shared/lib/active-dispatch-cleanup-migration.mjs";

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

const FRAMEWORK_OWNED = ["agents", "skills", "rules", "hooks", "docs"];
const FRAMEWORK_FILES = ["CLAUDE-HARNESS-MEMORY-MODEL.md"];

/** OpenCode framework-owned dirs (overwritten on every vendor). */
const OC_FRAMEWORK_OWNED = ["agents", "command", "docs", "skills", "plugin", "tools", "hands", "rules", "lib"];
const OC_FRAMEWORK_FILES = ["harness.routing.json", "AGENTS.md"];

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

const OC_MEMORY_SEED = `# Project Memory — Index

One line per durable, reusable, non-obvious project pattern or anti-pattern.

**Never write secrets, credentials, or PII here — this file is committed to git.**

<!-- index entries go below -->
`;

const OC_KAIZEN_SEED = `# Kaizen — Harness-Improvement Proposals (outbox)

A committed outbox for improvements to the **harness itself**. **Never auto-applied.**

**Never write secrets, credentials, or PII here — this file is committed to git.**

## Proposals

<!-- append proposals below -->
`;

const OC_GITIGNORE = `# OpenCode Harness — ephemeral, never committed
plans/
*.local.md
.harness-version-check-cache
`;

const AGENTS_START = "<!-- harness:start — managed by initializing-projects, do not edit inside -->";
const AGENTS_END = "<!-- harness:end -->";

// Repo-level files vendored OUTSIDE runtime dirs. Non-clobber: installed only if the exact
// destination is absent, so arbitrary project templates and same-path customizations survive.
const REPO_FILES = [
  ["github/ISSUE_TEMPLATE/harness-task.yml", ".github/ISSUE_TEMPLATE/harness-task.yml"],
  ["claude-code/dev.vars.example", ".dev.vars.example"],
];

const REQUIRED_OC_ISSUE_AUTHORING_SOURCE = [
  { logical: "core/opencode/skills/creating-issues", rel: "opencode/skills/creating-issues", kind: "directory" },
  { logical: "core/opencode/skills/creating-issues/SKILL.md", rel: "opencode/skills/creating-issues/SKILL.md", kind: "file" },
  {
    logical: "core/opencode/skills/creating-issues/references/submit-issue.mjs",
    rel: "opencode/skills/creating-issues/references/submit-issue.mjs",
    kind: "file",
  },
  { logical: "core/opencode/rules/creating-issues.md", rel: "opencode/rules/creating-issues.md", kind: "file" },
  {
    logical: "core/github/ISSUE_TEMPLATE/harness-task.yml",
    rel: "github/ISSUE_TEMPLATE/harness-task.yml",
    kind: "file",
  },
];

export const FRESH_NATIVE_PATHS = {
  opencode: [
    ".opencode/skills/creating-issues/SKILL.md",
    ".opencode/rules/creating-issues.md",
    ".github/ISSUE_TEMPLATE/harness-task.yml",
  ],
  claude: [
    ".claude/skills/creating-issues/SKILL.md",
    ".claude/rules/creating-issues.md",
    ".github/ISSUE_TEMPLATE/harness-task.yml",
  ],
};

// `state/` is the fleet engine's per-run stateDir (`<projectRoot>/.claude/state`) — run locks,
// observability, the issue body, and an `issue-<N>-env-<uuid>.env` holding the hand token. A repo's
// root `.env`/`.env.*` rules do NOT cover that filename, so without this line the token is merely
// untracked, one `git add -A` away from being committed.
const GITIGNORE = `# Claude Harness — ephemeral, never committed
plans/
state/
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

  return {
    coreDir,
    claudeCodeDir: resolveClaudeCodeDir(coreDir),
    version: readVersion(repoDir),
    cleanup,
  };
}

/**
 * @description Resolves the Claude Code shell source under `core/`.
 * Dual-runtime layout: framework-owned Claude shell lives at `core/claude-code/`.
 * Legacy flat layout (`core/agents|skills|hooks|…`) is still accepted as a fallback.
 * @param {string} coreDir
 * @returns {string}
 */
export function resolveClaudeCodeDir(coreDir) {
  const nested = join(coreDir, "claude-code");
  if (
    existsSync(join(nested, "agents")) ||
    existsSync(join(nested, "hooks")) ||
    existsSync(join(nested, "skills"))
  ) {
    return nested;
  }
  return coreDir;
}

/**
 * @description Resolves OpenCode shell source under `core/opencode/`.
 * @param {string} coreDir
 * @returns {string | null}
 */
export function resolveOpenCodeDir(coreDir) {
  const nested = join(coreDir, "opencode");
  if (
    existsSync(join(nested, "agents")) ||
    existsSync(join(nested, "plugin")) ||
    existsSync(join(nested, "skills"))
  ) {
    return nested;
  }
  return null;
}

/** @description Tokens that name a runtime shell (never a project directory). */
export const RUNTIME_TOKENS = new Set(["claude", "opencode", "oc", "both", "all"]);

/**
 * @description Normalize runtime target flag: claude | opencode | both.
 * Fails LOUD on an unrecognized non-empty value instead of silently defaulting
 * to claude — a typo / stale-binary / wrong-flag must never masquerade as a
 * successful claude-only vendor. Only an ABSENT (or empty) value defaults to
 * claude for backward compatibility.
 * @param {unknown} raw
 * @returns {"claude"|"opencode"|"both"}
 * @throws {Error} when raw is a non-empty string that is not a known token
 */
export function normalizeRuntimeTarget(raw) {
  const v = String(raw ?? "").toLowerCase().trim();
  if (v === "" || v === "claude") return "claude";
  if (v === "opencode" || v === "oc") return "opencode";
  if (v === "both" || v === "all") return "both";
  throw new Error(
    `invalid --runtime "${raw}" — expected one of: claude | opencode | both`,
  );
}

/**
 * @description Resolve the project destination dir from an explicit `--target`.
 * Guards the CLI↔vendor-core naming clash: the public CLI's `--target` names a
 * RUNTIME (claude|opencode|both), but vendor-core's `--target` is a DIRECTORY.
 * If a runtime token is passed where a directory is expected (and no such dir
 * exists), fail with a hint pointing at `--runtime`, instead of silently
 * creating a junk `./both/` directory.
 * @param {unknown} raw - the raw `--target` value (undefined → cwd)
 * @param {string} cwd - fallback when raw is absent
 * @returns {string} an existing directory path
 * @throws {Error} when the target is a runtime token or a non-existent dir
 */
export function resolveProjectTarget(raw, cwd) {
  if (raw == null) return pinTargetRoot(cwd);
  const value = String(raw);
  // Check the runtime-token guard FIRST (before existence): a stray `./both` dir
  // must not defeat the hint. Strip a trailing slash so `both/` is still caught.
  const bare = value.replace(/\/+$/, "").toLowerCase().trim();
  if (RUNTIME_TOKENS.has(bare)) {
    throw new Error(
      `--target "${value}" looks like a runtime, not a directory. ` +
        `vendor-core's --target is the project DIR; use --runtime ${bare} to pick the shell.`,
    );
  }
  if (!existsSync(value)) {
    throw new Error(`--target "${value}" is not an existing directory`);
  }
  try {
    return pinTargetRoot(value);
  } catch (error) {
    throw new Error(`--target "${value}" is not an existing directory or real non-symlink target: ${error.message}`);
  }
}

/** @description Pins an existing target to a stable real directory and rejects a symlink root. */
export function pinTargetRoot(targetDir) {
  const targetAbs = resolve(targetDir);
  const before = lstatSync(targetAbs);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`target root must be a real directory, not a symlink: ${targetAbs}`);
  }
  const firstReal = realpathSync(targetAbs);
  const after = lstatSync(targetAbs);
  const secondReal = realpathSync(targetAbs);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    firstReal !== secondReal
  ) {
    throw new Error(`target root changed during validation: ${targetAbs}`);
  }
  return firstReal;
}

/**
 * @description Rewrite monorepo `core/opencode/** → core/shared` imports to vendored
 * `.opencode/** → .opencode/shared` relative paths. Depth-aware; never produces absolute home paths.
 * @param {string} content
 * @param {string} relFromOpencodeRoot - e.g. `plugin/entry-gate.ts` or `lib/gate-state.mjs`
 * @returns {string}
 */
export function rewriteSharedImportsForVendor(content, relFromOpencodeRoot) {
  if (typeof content !== "string" || typeof relFromOpencodeRoot !== "string") return content;
  const parts = relFromOpencodeRoot.replace(/\\/g, "/").split("/").filter(Boolean);
  const depth = Math.max(0, parts.length - 1);
  // monorepo: from core/opencode/<path>, shared is (depth+1) levels up then shared/
  // vendored: from .opencode/<path>, shared is depth levels up then shared/
  const from = `${"../".repeat(depth + 1)}shared/`;
  const to = depth === 0 ? "shared/" : `${"../".repeat(depth)}shared/`;
  if (!content.includes(from) && !content.includes("../../shared/") && !content.includes("../../../shared/")) {
    // also fix harness.routing.json schema path written as ../../shared from opencode root
    if (depth === 0 && content.includes("../../shared/")) {
      return content.split("../../shared/").join("shared/");
    }
    return content;
  }
  return content.split(from).join(to);
}

/**
 * @description Copy a tree excluding *.test.mjs; rewrite shared imports in text sources.
 * @param {string} srcDir
 * @param {string} destDir
 * @param {string} relPrefix - path relative to opencode root for import rewrite
 */
function copyOcTree(srcDir, destDir, relPrefix = "") {
  if (!existsSync(srcDir)) return;
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    if (name.startsWith("._")) continue;
    const src = join(srcDir, name);
    const dest = join(destDir, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    const info = statSync(src);
    if (info.isDirectory()) {
      copyOcTree(src, dest, rel);
    } else if (info.isFile()) {
      if (name.endsWith(".test.mjs")) continue;
      if (/\.(mjs|ts|js|tsx|jsx|json|md)$/.test(name)) {
        const text = readFileSync(src, "utf8");
        writeFileSync(dest, rewriteSharedImportsForVendor(text, rel));
      } else {
        cpSync(src, dest);
      }
    }
  }
}

/**
 * @description Harness governance plugins that live under `.opencode/plugin/`.
 * OpenCode auto-loads `{plugin,plugins}/*.{ts,js}` from the project — do NOT also list
 * these in opencode.json `plugin[]` or every hook factory registers twice (double claim /
 * double before). Config `plugin[]` is for external package plugins only.
 * @returns {string[]} relative paths with ./ prefix (integrity / docs)
 */
export function harnessOcPluginFiles() {
  return [
    "./.opencode/plugin/entry-gate.ts",
    "./.opencode/plugin/lavish-command-gate.ts",
    "./.opencode/plugin/marker-authority.ts",
    "./.opencode/plugin/plan-gate.ts",
    "./.opencode/plugin/plan-write-gate.ts",
    "./.opencode/plugin/reinject-state.ts",
    "./.opencode/plugin/version-check.ts",
    "./.opencode/plugin/obs-plan-write.ts",
    "./.opencode/plugin/obs-eye.ts",
    "./.opencode/plugin/obs-hand.ts",
    "./.opencode/plugin/agent-idle-nudge.ts",
  ];
}

/** @description Required harness plugins that exist in source but are absent after vendoring. */
export function missingHarnessOcPluginFiles(openCodeDir, targetDir) {
  return harnessOcPluginFiles().filter((entry) => {
    const rel = entry.replace(/^\.\/\.opencode\//, "");
    const absentRetiredSource = OC_RETIRED_FILES.includes(rel) && !existsSync(join(openCodeDir, rel));
    return !absentRetiredSource && !existsSync(join(targetDir, entry.replace(/^\.\//, "")));
  });
}

/**
 * @description Paths that belong in opencode.json plugin[] — empty for harness.
 * @returns {string[]}
 */
export function defaultOcPluginPaths() {
  return [];
}

/**
 * @description True when path is under OC auto-load glob `.opencode/plugin|plugins/*`.
 * @param {unknown} p
 * @returns {boolean}
 */
export function isHarnessAutoloadPluginPath(p) {
  if (typeof p !== "string" || !p) return false;
  const n = p.replace(/^\.\//, "").replace(/\\/g, "/");
  return (
    n.startsWith(".opencode/plugin/") ||
    n.startsWith(".opencode/plugins/") ||
    n.startsWith("plugin/") ||
    n.startsWith("plugins/")
  );
}

/**
 * @description True when every plugin entry is a relative project path (not absolute/home).
 * @param {unknown} plugins
 * @returns {boolean}
 */
export function pluginsAreRelative(plugins) {
  if (!Array.isArray(plugins)) return false;
  return plugins.every((p) => {
    if (typeof p !== "string" || !p) return false;
    if (p.startsWith("/") || p.startsWith("~")) return false;
    if (/^[A-Za-z]:[\\/]/.test(p)) return false;
    if (p.includes("/Users/") || p.includes("/home/")) return false;
    return p.startsWith("./") || p.startsWith(".opencode/") || p.startsWith("../");
  });
}

/** @description Advance past one strict JSON string starting at its opening quote. */
function jsonStringEnd(source, start) {
  if (source[start] !== '"') return -1;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') return index + 1;
  }
  return -1;
}

/** @description Advance past one strict JSON value without interpreting nested object keys. */
function jsonValueEnd(source, start) {
  const first = source[start];
  if (first === '"') return jsonStringEnd(source, start);

  if (first === "{" || first === "[") {
    const stack = [first === "{" ? "}" : "]"];
    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index];
      if (char === '"') {
        const end = jsonStringEnd(source, index);
        if (end < 0) return -1;
        index = end - 1;
        continue;
      }
      if (char === "{") stack.push("}");
      else if (char === "[") stack.push("]");
      else if (char === "}" || char === "]") {
        if (stack.pop() !== char) return -1;
        if (stack.length === 0) return index + 1;
      }
    }
    return -1;
  }

  let end = start;
  while (end < source.length && !/[\s,}\]]/.test(source[end])) end += 1;
  return end === start ? -1 : end;
}

/** @description Return strict JSON root-object value spans, or null when the raw layout is unsupported. */
function topLevelJsonValueSpans(source) {
  const whitespace = /\s/;
  const skipWhitespace = (index) => {
    let next = index;
    while (next < source.length && whitespace.test(source[next])) next += 1;
    return next;
  };

  let index = skipWhitespace(0);
  if (source[index] !== "{") return null;
  index = skipWhitespace(index + 1);
  const spans = new Map();

  while (source[index] !== "}") {
    const keyEnd = jsonStringEnd(source, index);
    if (keyEnd < 0) return null;
    let key;
    try {
      key = JSON.parse(source.slice(index, keyEnd));
    } catch {
      return null;
    }
    if (typeof key !== "string" || spans.has(key)) return null;

    index = skipWhitespace(keyEnd);
    if (source[index] !== ":") return null;
    const valueStart = skipWhitespace(index + 1);
    const valueEnd = jsonValueEnd(source, valueStart);
    if (valueEnd < 0) return null;
    spans.set(key, { start: valueStart, end: valueEnd });

    index = skipWhitespace(valueEnd);
    if (source[index] === ",") {
      index = skipWhitespace(index + 1);
      continue;
    }
    if (source[index] !== "}") return null;
  }

  return skipWhitespace(index + 1) === source.length ? spans : null;
}

/** @description Leading indentation of the line containing `index`, retained for a replaced JSON value. */
function lineIndentationAt(source, index) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const prefix = source.slice(lineStart, index);
  const match = prefix.match(/^[\t ]*/);
  return match ? match[0] : "";
}

/** @description Stable JSON comparison for a JSON value, including its property order. */
function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * @description Preserve raw project formatting while replacing only harness-owned top-level
 * `plugin` / `permission` values. Null means a conservative canonical rewrite is required.
 */
function preserveProjectConfigFormatting(existingRaw, originalConfig, migratedConfig) {
  const originalKeys = Object.keys(originalConfig);
  const migratedKeys = Object.keys(migratedConfig);
  const keys = new Set([...originalKeys, ...migratedKeys]);
  const changedKeys = [...keys].filter((key) => !sameJsonValue(originalConfig[key], migratedConfig[key]));
  if (changedKeys.length === 0 || changedKeys.some((key) => key !== "plugin" && key !== "permission")) return null;

  const spans = topLevelJsonValueSpans(existingRaw);
  if (!spans || changedKeys.some((key) => !spans.has(key))) return null;

  const newline = existingRaw.includes("\r\n") ? "\r\n" : "\n";
  const replacements = changedKeys
    .map((key) => {
      const span = spans.get(key);
      const indentation = lineIndentationAt(existingRaw, span.start);
      const value = JSON.stringify(migratedConfig[key], null, 2).replace(/\n/g, `${newline}${indentation}`);
      return { ...span, value };
    })
    .sort((left, right) => right.start - left.start);

  let candidate = existingRaw;
  for (const replacement of replacements) {
    candidate = `${candidate.slice(0, replacement.start)}${replacement.value}${candidate.slice(replacement.end)}`;
  }

  try {
    return sameJsonValue(JSON.parse(candidate), migratedConfig) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * @description Create or idempotently merge canonical plugins into a valid project-owned opencode.json.
 * Also migrates the `permission` block across harness generations (issue #479): a manifest sidecar
 * at `.opencode/.harness-config-manifest.json` records which keys are harness-owned so a retired
 * default can be safely dropped or upgraded, while every operator customization survives untouched.
 * Safety net before the rename: a structural shape-check — failing it falls to the same manual-repair
 * sidecar used for an unparseable project config, never a partial write. (A live `opencode debug
 * config` shell-out was evaluated and dropped: on a machine with the binary installed it blocked on
 * every call in testing, which would silently brick every real vendoring run — the deterministic
 * shape-check alone satisfies the gate without that operational risk.) When a tier-2 migration
 * actually removes a retired key, the pre-migration file is preserved once at
 * `opencode.json.pre-migration.bak`.
 * Issue #441: when an existing file needs no semantic mutation (plugin[] already clean of harness
 * autoload paths AND permission migration is a no-op including key order), skip the write entirely
 * and return `"unchanged"` so project formatters (Biome/Prettier) are not destroyed by a cosmetic
 * `JSON.stringify(..., null, 2)` rewrite. For a real plugin/permission migration, preserve the raw
 * project fields and replace only those two harness-owned root values; unsupported layouts safely
 * fall back to canonical JSON.
 * @param {string} openCodeDir - source core/opencode
 * @param {string} targetDir - project root
 * @param {string} [version] - harness version currently being vendored (stamped into the manifest)
 * @returns {string} status — `"created"` | `"unchanged"` | update/repair strings
 */
export function writeOpencodeConfig(openCodeDir, targetDir, version) {
  const example = join(openCodeDir, "opencode.json.example");
  let cfg;
  if (existsSync(example)) {
    try {
      cfg = JSON.parse(readFileSync(example, "utf8"));
    } catch {
      cfg = {};
    }
  } else {
    cfg = {};
  }
  // Strip harness autoload paths from example; keep only external package plugins if any.
  if (Array.isArray(cfg.plugin)) {
    cfg.plugin = cfg.plugin.filter((entry) => typeof entry === "string" && !isHarnessAutoloadPluginPath(entry));
  } else {
    cfg.plugin = [];
  }

  const dest = join(targetDir, "opencode.json");
  const ocDir = join(targetDir, ".opencode");
  const manifestPath = join(ocDir, MANIFEST_FILENAME);
  const versionPath = join(ocDir, ".harness-version");
  const backupPath = join(targetDir, "opencode.json.pre-migration.bak");
  const wasPresent = existsSync(dest);

  // Fresh project: base off the new generation's full config (plugin/model/agent/... included) so
  // permission-only migration never drops unrelated fields. Existing project: base off its own file,
  // preserving every operator top-level customization untouched.
  let existing = cfg;
  let existingRaw = null;
  /** @type {Record<string, unknown> | null} pre-mutation snapshot for #441 no-op detection */
  let originalSnapshot = null;
  if (wasPresent) {
    // Read bytes first (#441) — only this string can prove byte-identity after a no-op path.
    existingRaw = readFileSync(dest, "utf8");
    try {
      existing = JSON.parse(existingRaw);
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("not object");
    } catch {
      // Never rename/touch an unparseable project config — fall to the manual-repair sidecar untouched.
      writeFileSync(join(targetDir, "opencode.harness.json"), `${JSON.stringify(cfg, null, 2)}\n`);
      return "invalid existing config → wrote opencode.harness.json for manual repair";
    }
    // Snapshot BEFORE plugin strip / migration so we can detect a true no-op vs cosmetic rewrite.
    originalSnapshot = JSON.parse(JSON.stringify(existing));
    // Never re-inject harness paths into plugin[] — OC auto-loads .opencode/plugin/*.ts
    existing.plugin = Array.isArray(existing.plugin)
      ? existing.plugin.filter((entry) => typeof entry === "string" && !isHarnessAutoloadPluginPath(entry))
      : [];
  }

  let manifest = null;
  let existingManifestRaw = null;
  if (existsSync(manifestPath)) {
    try {
      existingManifestRaw = readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(existingManifestRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed;
      else existingManifestRaw = null;
    } catch {
      manifest = null;
      existingManifestRaw = null;
    }
  }
  const previousHarnessVersionStamp = existsSync(versionPath)
    ? readHarnessVersionStamp(readFileSync(versionPath, "utf8"))
    : null;

  const migrated = migrateOpencodeConfig({
    existingConfig: existing,
    newConfig: cfg,
    manifest,
    previousHarnessVersionStamp,
    newHarnessVersion: version ?? null,
  });

  // Validation gate BEFORE the rename — a migration that produced something un-writable never
  // touches `dest`; it falls to the same manual-repair path an unparseable project config uses.
  if (!isValidOpencodeConfigShape(migrated.config)) {
    writeFileSync(join(targetDir, "opencode.harness.json"), `${JSON.stringify(cfg, null, 2)}\n`);
    return "migration failed validation gate → wrote opencode.harness.json for manual repair";
  }

  const removedEntries = migrated.report.filter((r) => r.action === "removed-retired");
  const keptEntries = migrated.report.filter((r) => r.action === "kept-custom");

  const canonicalConfigText = `${JSON.stringify(migrated.config, null, 2)}\n`;
  const nextConfigText =
    wasPresent && originalSnapshot !== null && existingRaw !== null
      ? preserveProjectConfigFormatting(existingRaw, originalSnapshot, migrated.config) ?? canonicalConfigText
      : canonicalConfigText;
  const nextManifestText = `${JSON.stringify(migrated.manifest, null, 2)}\n`;

  // #441: skip rewriting opencode.json when nothing semantic changed — including permission key
  // order (last-match-wins). Object JSON.stringify is order-sensitive; byte equality covers the
  // already-canonical file; structural equality covers Biome/Prettier-formatted equivalents.
  const configUnchanged =
    wasPresent &&
    originalSnapshot !== null &&
    existingRaw !== null &&
    (existingRaw === canonicalConfigText ||
      JSON.stringify(originalSnapshot) === JSON.stringify(migrated.config));
  const manifestUnchanged = existingManifestRaw !== null && existingManifestRaw === nextManifestText;

  // Rollback layer 2 (layer 1 is git itself): once, only when a tier-2 ledger match actually
  // dropped something — preserves the exact pre-migration bytes, never overwritten by a later run.
  if (
    wasPresent &&
    !configUnchanged &&
    migrated.tier === 2 &&
    removedEntries.length > 0 &&
    existingRaw !== null &&
    !existsSync(backupPath)
  ) {
    writeFileSync(backupPath, existingRaw);
  }

  if (!configUnchanged) {
    const temp = `${dest}.${process.pid}.tmp`;
    writeFileSync(temp, nextConfigText);
    renameSync(temp, dest);
  }

  mkdirSync(ocDir, { recursive: true });
  if (!manifestUnchanged) {
    const manifestTemp = `${manifestPath}.${process.pid}.tmp`;
    writeFileSync(manifestTemp, nextManifestText);
    renameSync(manifestTemp, manifestPath);
  }

  if (!wasPresent) return "created";
  if (configUnchanged) return "unchanged";
  if (removedEntries.length === 0 && keptEntries.length === 0) {
    return "updated existing opencode.json plugins (stripped harness autoload paths)";
  }
  const describe = (r) => `${r.path.join(".")}=${JSON.stringify(r.value)}`;
  const removedNote = removedEntries.length ? `removed retired [${removedEntries.map(describe).join(", ")}]` : "";
  const keptNote = keptEntries.length ? `kept custom [${keptEntries.map(describe).join(", ")}]` : "";
  const migrationNote = [removedNote, keptNote].filter(Boolean).join("; ");
  return `updated existing opencode.json plugins (stripped harness autoload paths) (permission migration: ${migrationNote})`;
}

/**
 * @description Merge AGENTS.md harness block at project root (markers).
 * @param {string} openCodeDir
 * @param {string} targetDir
 * @returns {string}
 */
function mergeAgentsMd(openCodeDir, targetDir) {
  const src = join(openCodeDir, "AGENTS.md");
  if (!existsSync(src)) return "skipped (no AGENTS.md source)";
  const harness = readFileSync(src, "utf8").trim();
  const block = `${AGENTS_START}\n${harness}\n${AGENTS_END}\n`;
  const target = join(targetDir, "AGENTS.md");
  if (!existsSync(target)) {
    writeFileSync(target, block);
    return "created";
  }
  const current = readFileSync(target, "utf8");
  const startIdx = current.indexOf(AGENTS_START);
  const endIdx = current.indexOf(AGENTS_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = current.slice(0, startIdx);
    const after = current.slice(endIdx + AGENTS_END.length);
    writeFileSync(target, `${before}${block.trimEnd()}${after}`);
    return "updated";
  }
  writeFileSync(target, `${current.trimEnd()}\n\n${block}`);
  return "appended";
}

/**
 * @description Seed project-root MEMORY.md / kaizen.md only when absent.
 * @param {string} targetDir
 * @returns {string}
 */
export function seedOcAccumulated(targetDir) {
  const seeded = [];
  const memory = join(targetDir, "MEMORY.md");
  if (!existsSync(memory)) {
    writeFileSync(memory, OC_MEMORY_SEED);
    seeded.push("MEMORY.md");
  }
  const kaizen = join(targetDir, "kaizen.md");
  if (!existsSync(kaizen)) {
    writeFileSync(kaizen, OC_KAIZEN_SEED);
    seeded.push("kaizen.md");
  }
  return seeded.length ? seeded.join(", ") : "already present (non-clobber)";
}

/**
 * @description Merge .opencode/.gitignore required lines (non-clobber).
 * @param {string} ocDir
 * @returns {string}
 */
function mergeOcGitignore(ocDir) {
  const gitignore = join(ocDir, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const required = OC_GITIGNORE.split("\n").filter((line) => line.trim().length > 0);
  const missing = required.filter((line) => !present.has(line.trim()));
  if (current.trim() && missing.length === 0) return "already ignored";
  if (!current.trim()) {
    writeFileSync(gitignore, OC_GITIGNORE);
    return "created";
  }
  writeFileSync(gitignore, `${current.trimEnd()}\n${missing.join("\n")}\n`);
  return `merged (${missing.length} lines added)`;
}

function collectDestinationTree(src, destination, entries) {
  const info = statSync(src);
  entries.push({ destination, kind: info.isDirectory() ? "directory" : "file" });
  if (!info.isDirectory()) return;
  for (const name of readdirSync(src)) {
    if (name.startsWith("._")) continue;
    const child = join(src, name);
    if (statSync(child).isFile() && name.endsWith(".test.mjs")) continue;
    collectDestinationTree(child, join(destination, name), entries);
  }
}

function resolveRepoFileSource(coreDir, rel) {
  return join(coreDir, rel);
}

function validateSourceArtifact(coreReal, artifact) {
  const source = resolveRepoFileSource(coreReal, artifact.rel);
  const parts = relative(coreReal, source).split(sep).filter(Boolean);
  let current = coreReal;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const info = lstatIfPresent(current);
    if (info === null) throw new Error(`required OpenCode source artifact missing: ${artifact.logical}`);
    if (info.isSymbolicLink()) {
      throw new Error(`required OpenCode source artifact is a symlink: ${artifact.logical}`);
    }
    const final = index === parts.length - 1;
    if (!final && !info.isDirectory()) {
      throw new Error(`required OpenCode source artifact has invalid ancestor: ${artifact.logical}`);
    }
    if (final && artifact.kind === "directory" && !info.isDirectory()) {
      throw new Error(`required OpenCode source artifact is not a directory: ${artifact.logical}`);
    }
    if (final && artifact.kind === "file" && !info.isFile()) {
      throw new Error(`required OpenCode source artifact is not a regular file: ${artifact.logical}`);
    }
    const actual = realpathSync(current);
    if (!isPathContained(coreReal, actual)) {
      throw new Error(`required OpenCode source artifact escapes source root: ${artifact.logical}`);
    }
  }
}

function validateRequiredOpenCodeSource(coreDir) {
  const coreReal = pinTargetRoot(coreDir);
  for (const artifact of REQUIRED_OC_ISSUE_AUTHORING_SOURCE) validateSourceArtifact(coreReal, artifact);
  return coreReal;
}

function preflightDestination(targetReal, destination, kind) {
  const out = resolve(targetReal, destination);
  if (!isPathContained(targetReal, out)) {
    throw new Error(`vendor destination escapes target: ${destination}`);
  }
  const parts = relative(targetReal, out).split(sep).filter(Boolean);
  let current = targetReal;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const info = lstatIfPresent(current);
    if (info === null) break;
    if (info.isSymbolicLink()) throw new Error(`refusing symlink vendor destination: ${current}`);
    const final = index === parts.length - 1;
    if (!final && !info.isDirectory()) {
      throw new Error(`vendor destination ancestor is not a directory: ${current}`);
    }
    if (final && kind === "directory" && !info.isDirectory()) {
      throw new Error(`vendor directory destination is not a directory: ${current}`);
    }
    if (final && kind === "file" && !info.isFile()) {
      throw new Error(`vendor file destination is not a regular file: ${current}`);
    }
    const actual = realpathSync(current);
    if (!isPathContained(targetReal, actual)) {
      throw new Error(`vendor destination escapes target: ${current} -> ${actual}`);
    }
  }
}

/** @description Read-only, complete destination preflight performed before the first OC write. */
export function preflightOpenCodeVendor(coreDir, targetDir) {
  const targetReal = pinTargetRoot(targetDir);
  const coreReal = validateRequiredOpenCodeSource(coreDir);
  const openCodeDir = resolveOpenCodeDir(coreReal);
  if (!openCodeDir) throw new Error("no core/opencode found under source");
  const entries = [];

  for (const dir of OC_FRAMEWORK_OWNED) {
    const src = join(openCodeDir, dir);
    if (existsSync(src)) collectDestinationTree(src, join(".opencode", dir), entries);
  }
  for (const file of OC_FRAMEWORK_FILES) {
    if (existsSync(join(openCodeDir, file))) entries.push({ destination: join(".opencode", file), kind: "file" });
  }
  const sharedDir = join(coreReal, "shared");
  if (existsSync(sharedDir)) collectDestinationTree(sharedDir, join(".opencode", "shared"), entries);

  entries.push(
    { destination: ".opencode", kind: "directory" },
    { destination: ".opencode/.gitignore", kind: "file" },
    { destination: ".opencode/.harness-version", kind: "file" },
    { destination: "AGENTS.md", kind: "file" },
    { destination: "opencode.json", kind: "file" },
    { destination: "opencode.harness.json", kind: "file" },
    { destination: "MEMORY.md", kind: "file" },
    { destination: "kaizen.md", kind: "file" },
  );
  for (const [, destination] of REPO_FILES) entries.push({ destination, kind: "file" });

  for (const entry of entries) preflightDestination(targetReal, entry.destination, entry.kind);
  return { targetReal, openCodeDir, entries };
}

/** @description Writes exact current ownership plus the finite vendor retirement ledger. */
function writeOcOwnershipManifest(ocDir, entries, sourceOcDir) {
  const files = new Set(
    entries
      .filter((entry) => entry.kind === "file" && entry.destination.startsWith(join(".opencode", sep)))
      .map((entry) => entry.destination.split(sep).join("/")),
  );
  for (const path of [
    ".opencode/.gitignore",
    ".opencode/.harness-version",
    ".opencode/.harness-config-manifest.json",
    ".opencode/.harness-owned-files.json",
    ".opencode/AGENTS.md",
    ".opencode/harness.routing.json",
    "opencode.json",
    "AGENTS.md",
    ".github/ISSUE_TEMPLATE/harness-task.yml",
    ".dev.vars.example",
  ]) files.add(path);
  const retired = OC_RETIRED_FILES
    .filter((rel) => !existsWithExactCase(dirname(join(sourceOcDir, rel)), rel.split("/").pop()))
    .map((rel) => `.opencode/${rel}`);
  writeFileSync(
    join(ocDir, ".harness-owned-files.json"),
    `${JSON.stringify({ version: 1, files: [...files].sort(), retired }, null, 2)}\n`,
  );
}

/**
 * @description Writes the exact Claude files produced by this vendor run. The lifecycle shipper
 * consumes this list instead of a directory prefix, so a project's local `.claude/` cargo never
 * enters the harness PR.
 * @param {{ coreDir: string, claudeCodeDir: string, claudeDir: string, hookVpsDeps: string[], modules: string[] }} options
 */
function writeClaudeOwnershipManifest({ coreDir, claudeCodeDir, claudeDir, hookVpsDeps, modules }) {
  const entries = [];
  for (const dir of FRAMEWORK_OWNED) {
    const src = join(claudeCodeDir, dir);
    if (existsSync(src)) collectDestinationTree(src, join(".claude", dir), entries);
  }
  for (const file of FRAMEWORK_FILES) {
    const src = join(claudeCodeDir, file);
    if (existsSync(src)) entries.push({ destination: join(".claude", file), kind: "file" });
  }
  const sharedDir = join(coreDir, "shared");
  if (existsSync(sharedDir)) collectDestinationTree(sharedDir, join(".claude", "shared"), entries);
  for (const name of hookVpsDeps) entries.push({ destination: join(".claude", "vps", name), kind: "file" });
  const modulesRoot = join(coreDir, "..", "modules");
  for (const name of modules) {
    const src = join(modulesRoot, name);
    if (existsSync(src)) collectDestinationTree(src, join(".claude", "modules", name), entries);
  }

  const files = new Set(
    entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.destination.split(sep).join("/")),
  );
  for (const path of [
    ".claude/.gitignore",
    ".claude/.harness-version",
    ".claude/.harness-config-manifest.json",
    ".claude/.harness-owned-files.json",
    ".claude/CLAUDE.md",
    ".claude/settings.json",
    ".github/ISSUE_TEMPLATE/harness-task.yml",
    ".dev.vars.example",
  ]) files.add(path);
  writeFileSync(join(claudeDir, ".harness-owned-files.json"), `${JSON.stringify({ version: 1, files: [...files].sort() }, null, 2)}\n`);
}

/**
 * Harness files retired from `core/opencode/` that must be actively deleted from an
 * already-vendored `.opencode/` on update. `copyOcTree` only copies what the source still
 * has — it never diffs against the destination — so a file dropped from source stays behind
 * as a zombie: OpenCode still auto-globs `.opencode/plugin/*.{ts,js}` and re-registers it.
 * Exact relative paths ONLY (never a directory or a glob) — this must never risk deleting a
 * user's own local plugin placed alongside the harness ones in the same auto-load directory.
 */
export const OC_RETIRED_FILES = [
  "plugin/command-resolver.ts",
  "plugin/lib/command-resolver.mjs",
  "agents/executor-high-spawn.md",
  "agents/executor-low-spawn.md",
  "agents/executor-medium-spawn.md",
  "agents/sniper-high-spawn.md",
  "agents/sniper-low-spawn.md",
  "agents/sniper-medium-spawn.md",
  "agents/test-author-spawn.md",
  "plugin/loop-guard.ts",
  "plugin/lib/dual-enforcement.mjs",
  "plugin/lib/dual-enforcement.test.mjs",
  "plugin/lib/dual-merge.mjs",
  "plugin/lib/dual-merge.test.mjs",
  "plugin/lib/dual-nudge.mjs",
  "plugin/lib/marker-seal.mjs",
  "plugin/lib/marker-security.test.mjs",
  "plugin/lib/mark-gate.mjs",
  "skills/orchestrating-delivery/dual-runtime.mjs",
  "skills/orchestrating-delivery/dual-runtime.test.mjs",
  "plugin/lib/gate-state.mjs",
  "plugin/lib/entry-decide.mjs",
  "plugin/lib/dispatch-scope.mjs",
  "plugin/lib/hand-records.mjs",
  "plugin/lib/planner-state.mjs",
  "plugin/lib/obs-emit.mjs",
  "plugin/lib/plan-hash.mjs",
  "plugin/lib/planner-artifact.mjs",
  "plugin/lib/planner-fallback-config.mjs",
  "lib/planner-fallback-config.mjs",
  "plugin/lib/regate-arm.mjs",
  "plugin/lib/regate-arm.test.mjs",
  "agents/planner-fallback.md",
  "plugin/lib/roles.mjs",
  "plugin/lib/task-dispatch-identity.mjs",
  "plugin/lib/second-eye-authority.mjs",
  "plugin/lib/second-eye-authority.test.mjs",
  "plugin/second-eye-coordinator.ts",
  "plugin/second-eye-coordinator.test.mjs",
  "skills/orchestrating-delivery/second-eye-runtime.mjs",
  "skills/orchestrating-delivery/second-eye-runtime.test.mjs",
  "plugin/lib/loop-decide.mjs",
  "plugin/lib/plan-and-loop-decide.test.mjs",
  "plugin/review-guard.ts",
  "plugin/lib/review-accounting.test.mjs",
  "plugin/lib/adversary-nudge.mjs",
  "plugin/lib/adversary-nudge.test.mjs",
  "plugin/lib/revise-nudge.mjs",
  "plugin/lib/revise-nudge.test.mjs",
  "plugin/lib/review-restart.mjs",
  "skills/orchestrating-delivery/skill-plan-review-budget.test.mjs",
  "skills/orchestrating-delivery/skill-primary-failure-cap.test.mjs",
  "shared/lib/agent-retry.mjs",
  "shared/lib/agent-retry.test.mjs",
  "shared/lib/agent-retry-call.mjs",
  "shared/lib/agent-retry-call.test.mjs",
  "plugin/ceremony-coordinator.ts",
  "plugin/ceremony-coordinator.test.mjs",
  "skills/orchestrating-delivery/ceremony-runtime.mjs",
  "skills/orchestrating-delivery/ceremony-runtime.test.mjs",
  "plugin/lib/scope-runtime-composition.mjs",
  "plugin/lib/bound-plan.mjs",
  "plugin/lib/bound-plan.test.mjs",
  "plugin/lib/obs-test-isolation.mjs",
  "plugin/lib/obs-test-isolation.test.mjs",
  "plugin/eyes-permission-lockdown.test.mjs",
  "skills/orchestrating-delivery/skill-regate-stop-predicate.test.mjs",
  "skills/orchestrating-delivery/skill-regate-stagnation-ceiling.test.mjs",
  "skills/orchestrating-delivery/skill-regate-deadlock-escape.test.mjs",
  "plugin/harvest-guard.ts",
  "plugin/lib/harvest-findings.mjs",
  "plugin/autonomy-controller.ts",
  "plugin/lib/autonomy-controller.mjs",
  "plugin/lib/agent-catalog-health.mjs",
  "plugin/lib/ceremony-binding.mjs",
  "plugin/lib/ceremony-transition.mjs",
  "plugin/planner-recovery.ts",
  "plugin/planner-recovery.test.mjs",
  "plugin/lib/planner-brief.mjs",
  "plugin/lib/planner-brief.test.mjs",
  "plugin/lib/planner-result.mjs",
  "plugin/lib/planner-result.test.mjs",
  "lib/planner-state.mjs",
  "lib/planner-state.test.mjs",
  "lib/planner-artifact.mjs",
  "lib/plan-hash.mjs",
  "lib/planner-canonical-write.test.mjs",
  "lib/feature-resume.mjs",
  "lib/feature-resume.test.mjs",
  "lib/classify-resume.mjs",
  "lib/classify-resume.test.mjs",
  "lib/runtime-todo-projection.mjs",
  "lib/todo-projection.mjs",
  "lib/todo-projection.test.mjs",
  "tools/sync-harness-todo.ts",
  "plugin/lib/plan-path-session.mjs",
  "plugin/lib/plan-path-session.test.mjs",
  "plugin/lib/session-state-terminal-delivery.test.mjs",
];

/**
 * @description True when `dir/name` exists with that EXACT case (case-sensitive directory
 * listing, not a case-insensitive path lookup). Guards `pruneOcRetiredFiles` against deleting
 * a user's own same-named-but-different-case local plugin on a case-insensitive filesystem
 * (default on macOS/Windows) — `rmSync` alone would resolve the wrong file silently.
 * @param {string} dir
 * @param {string} name
 * @returns {boolean}
 */
function existsWithExactCase(dir, name) {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).includes(name);
}

/**
 * @description Delete each `OC_RETIRED_FILES` entry missing from the source, but only on
 * an exact case-sensitive destination match. Paths can be predeclared before source removal.
 * @param {string} ocDir
 * @param {string} sourceOcDir
 */
export function pruneOcRetiredFiles(ocDir, sourceOcDir) {
  for (const rel of OC_RETIRED_FILES) {
    const source = join(sourceOcDir, rel);
    if (existsWithExactCase(dirname(source), rel.split("/").pop())) continue;
    const abs = join(ocDir, rel);
    if (existsWithExactCase(dirname(abs), rel.split("/").pop())) rmSync(abs, { force: true });
  }
}

/** @description Remove macOS AppleDouble metadata only from framework-owned OpenCode trees. */
function pruneOcAppleDoubleArtifacts(ocDir) {
  const pruneTree = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const entry = join(dir, name);
      const info = lstatSync(entry);
      if (name.startsWith("._")) {
        rmSync(entry, { recursive: info.isDirectory(), force: true });
        continue;
      }
      if (info.isDirectory() && !info.isSymbolicLink()) pruneTree(entry);
    }
  };
  for (const dir of OC_FRAMEWORK_OWNED) pruneTree(join(ocDir, dir));
  pruneTree(join(ocDir, "shared"));
  for (const name of readdirSync(ocDir)) {
    if (name.startsWith("._")) rmSync(join(ocDir, name), { recursive: true, force: true });
  }
}

/**
 * @description Vendor OpenCode harness into project `.opencode/` + root config/memory.
 * @param {{ coreDir: string, targetDir: string, version: string, stampDate: string }} opts
 * @returns {{ ocDir: string }}
 */
export function vendorOpenCode({ coreDir, targetDir, version, stampDate }) {
  const preflight = preflightOpenCodeVendor(coreDir, targetDir);
  targetDir = preflight.targetReal;
  const openCodeDir = preflight.openCodeDir;
  const sharedDir = join(coreDir, "shared");
  const ocDir = join(targetDir, ".opencode");
  mkdirSync(ocDir, { recursive: true });
  pruneOcAppleDoubleArtifacts(ocDir);

  for (const dir of OC_FRAMEWORK_OWNED) {
    const src = join(openCodeDir, dir);
    if (existsSync(src)) copyOcTree(src, join(ocDir, dir), dir);
  }
  for (const file of OC_FRAMEWORK_FILES) {
    const src = join(openCodeDir, file);
    if (!existsSync(src)) continue;
    const text = readFileSync(src, "utf8");
    writeFileSync(join(ocDir, file), rewriteSharedImportsForVendor(text, file));
  }
  pruneOcRetiredFiles(ocDir, openCodeDir);
  sweepRetiredDispatchCleanup(targetDir);

  // Runtime shared libs (plugins import via rewritten relative paths)
  if (existsSync(sharedDir)) {
    copyOcTree(sharedDir, join(ocDir, "shared"), "shared");
  }

  const agentsMd = mergeAgentsMd(openCodeDir, targetDir);
  ok(`AGENTS.md: ${agentsMd}`);

  const cfg = writeOpencodeConfig(openCodeDir, targetDir, version);
  ok(`opencode.json: ${cfg}`);
  const cfgPath = cfg.includes("manual repair")
    ? join(targetDir, "opencode.harness.json")
    : join(targetDir, "opencode.json");
  // Harness plugins are auto-loaded from disk (.opencode/plugin/*) — not listed in plugin[].
  const missingHarness = missingHarnessOcPluginFiles(openCodeDir, targetDir);
  if (missingHarness.length > 0) {
    fail(`FATAL — harness plugin files missing on disk (OC auto-load): ${missingHarness[0]}`);
  }
  const writtenPlugins = JSON.parse(readFileSync(cfgPath, "utf8")).plugin;
  if (!Array.isArray(writtenPlugins)) {
    fail("FATAL — opencode.json plugin must be an array");
  }
  const leaked = writtenPlugins.filter((entry) => isHarnessAutoloadPluginPath(entry));
  if (leaked.length > 0) {
    fail(`FATAL — harness autoload paths must not appear in plugin[] (double-load): ${leaked[0]}`);
  }

  const acc = seedOcAccumulated(targetDir);
  ok(`MEMORY.md / kaizen.md: ${acc}`);

  const gi = mergeOcGitignore(ocDir);
  writeFileSync(join(ocDir, ".harness-version"), `${version}\nvendored_at: ${stampDate}\n`);
  writeOcOwnershipManifest(ocDir, preflight.entries, openCodeDir);
  ok(`.opencode/.gitignore (${gi}), .harness-version written`);

  const repoFiles = installRepoFiles(coreDir, targetDir);
  ok(`repo files (.github/...): ${repoFiles}`);
  assertFreshNativeInstall(targetDir, "opencode");

  process.stdout.write(
    `${dim("!")} Project plugins execute when someone runs opencode in this repo (no hand tokens in plugins).\n`,
  );

  return { ocDir };
}

/**
 * @description Vendor Claude shell into project `.claude/` (existing behavior).
 * @param {{ coreDir: string, claudeCodeDir: string, targetDir: string, version: string, stampDate: string, withCodex: boolean }} opts
 */
function vendorClaude({ coreDir, claudeCodeDir, targetDir, version, stampDate, withCodex }) {
  const claudeDir = join(targetDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  copyFrameworkOwned(claudeCodeDir, claudeDir);
  ok("agents/skills/rules/hooks copied (*.test.mjs excluded)");

  // Hooks import core/shared pure (absolution, regate, git-state, real-file). Mirror into
  // .claude/shared and rewrite monorepo-relative imports so vendored hooks resolve.
  const sharedMirrored = copyClaudeSharedDeps(coreDir, claudeDir);
  ok(`hooks' shared deps → .claude/shared/: ${sharedMirrored}`);
  const sharedRewrites = rewriteClaudeSharedImports(claudeDir);
  ok(`shared import rewrites: ${sharedRewrites}`);

  const hookVpsDeps = copyHookVpsDeps(coreDir, claudeDir, claudeCodeDir);
  ok(`hooks' vps deps → .claude/vps/: ${hookVpsDeps.length ? hookVpsDeps.join(", ") : "none (hooks import no vps modules)"}`);

  const modules = copyModules(join(coreDir, "..", "modules"), claudeDir, Boolean(withCodex));
  ok(`modules: ${modules.length ? modules.join(", ") : "none (default off; pass --with-codex to enable)"}`);

  seedAccumulated(claudeCodeDir, claudeDir);
  ok("memory/MEMORY.md, kaizen.md seeded (if absent)");

  const claudeMd = mergeClaudeMd(claudeCodeDir, claudeDir);
  ok(`CLAUDE.md: ${claudeMd}`);

  const settings = writeSettings(claudeCodeDir, claudeDir, version);
  ok(`settings.json: ${settings}`);

  const repoFiles = installRepoFiles(coreDir, targetDir);
  ok(`repo files (.github/…): ${repoFiles}`);
  assertFreshNativeInstall(targetDir, "claude");

  const devVarsIgnore = existsSync(join(claudeCodeDir, "dev.vars.example"))
    ? ensureDevVarsIgnored(targetDir)
    : "skipped (no dev.vars.example source)";
  ok(`root .gitignore (.dev.vars): ${devVarsIgnore}`);

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

  const claudeGitignore = mergeClaudeGitignore(claudeDir);
  writeFileSync(join(claudeDir, ".harness-version"), `${version}\nvendored_at: ${stampDate}\n`);
  writeClaudeOwnershipManifest({ coreDir, claudeCodeDir, claudeDir, hookVpsDeps, modules });
  ok(`.claude/.gitignore (${claudeGitignore}), .harness-version written`);
  return { claudeDir };
}

/** @description Release version from package.json, with git/unknown only as a legacy fallback. */
function readVersion(repoDir) {
  try {
    const version = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"))?.version;
    if (typeof version === "string" && version.trim()) return `v${version.trim()}`;
  } catch {
    // A legacy/minimal source can lack package.json; retain the previous best-effort path.
  }
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
function copyFrameworkOwned(claudeCodeDir, claudeDir) {
  const filter = (src, _dest) => isFrameworkCopyIncluded(src);
  for (const dir of FRAMEWORK_OWNED) {
    const src = join(claudeCodeDir, dir);
    if (existsSync(src)) cpSync(src, join(claudeDir, dir), { recursive: true, filter });
  }
  for (const file of FRAMEWORK_FILES) {
    const src = join(claudeCodeDir, file);
    if (existsSync(src)) cpSync(src, join(claudeDir, file));
  }
}

/**
 * @description Mirror core/shared into .claude/shared (exclude *.test.mjs) so vendored
 * hooks that import shared pure modules resolve under the project.
 * @param {string} coreDir
 * @param {string} claudeDir
 * @returns {string}
 */
function copyClaudeSharedDeps(coreDir, claudeDir) {
  const sharedDir = join(coreDir, "shared");
  if (!existsSync(sharedDir)) return "skipped (no core/shared)";
  const dest = join(claudeDir, "shared");
  copyOcTree(sharedDir, dest, "shared");
  return existsSync(join(dest, "lib")) ? "copied" : "empty";
}

/**
 * @description Rewrite monorepo `core/claude-code/** → core/shared` imports to vendored
 * `.claude/** → .claude/shared` relative paths. `core/claude-code` collapses to `.claude`, so every
 * vendored file sits exactly ONE level closer to `shared/` than its monorepo original — the rewrite
 * is therefore pure depth arithmetic, identical to the OpenCode side.
 *
 * Depth-aware over the WHOLE framework tree, not just hooks/: a skill reference (depth 3, e.g.
 * `skills/orchestrating-delivery/references/spawn-hand.mjs`) importing `core/shared` would otherwise
 * keep its monorepo-depth prefix and resolve OUTSIDE `.claude/` — an ERR_MODULE_NOT_FOUND at import
 * time, i.e. a dead dispatch in every vendored project. Hooks-only was never a rule, just the only
 * case that existed; the previous hardcoded pair (hooks depth 1, hooks/lib depth 2) is reproduced
 * exactly by the arithmetic below.
 *
 * Code extensions only (.mjs/.js/.ts) — prose in a SKILL.md naming a path is documentation, not an
 * import, and must not be silently rewritten. The match is textual (as on the OpenCode side), so a
 * file must not carry its own depth's `../…/shared/` prefix as non-import text: it would be
 * rewritten too. Nothing in the tree does, and the vendored-import test would catch a real break.
 *
 * @param {string} claudeDir
 * @returns {number} files rewritten
 */
function rewriteClaudeSharedImports(claudeDir) {
  let n = 0;
  const walk = (dir, relFromClaudeRoot) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relFromClaudeRoot ? `${relFromClaudeRoot}/${name}` : name;
      if (statSync(abs).isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!name.endsWith(".mjs") && !name.endsWith(".js") && !name.endsWith(".ts")) continue;
      // depth = how many directories deep this file sits under .claude/
      const depth = rel.split("/").length - 1;
      // monorepo: from core/claude-code/<rel>, shared is (depth+1) levels up; vendored: depth levels.
      const from = `${"../".repeat(depth + 1)}shared/`;
      const to = depth === 0 ? "shared/" : `${"../".repeat(depth)}shared/`;
      const before = readFileSync(abs, "utf8");
      const after = before.split(from).join(to);
      if (after !== before) {
        writeFileSync(abs, after);
        n += 1;
      }
    }
  };
  // Every framework-owned dir — a shared import may legitimately appear in any of them.
  for (const dir of FRAMEWORK_OWNED) {
    walk(join(claudeDir, dir), dir);
  }
  return n;
}

/**
 * @description The hooks vendored into `.claude/hooks/` import runtime modules from `core/vps/`
 * (e.g. `stamp-triage.mjs` and `obs-eye-append.mjs` both `import "../vps/obs-outbox.mjs"` for the
 * observability outbox). `vps/` is NOT framework-owned, so without this the vendored hook resolves
 * an `import` path that does not exist under `.claude/` → ERR_MODULE_NOT_FOUND → the hook crashes on
 * load → `stamp-triage` never writes `triage.json` → the entry-gate blocks every delivery subagent.
 * This mirrors ONLY the vps modules the hooks actually import (transitive closure of their `./`
 * siblings inside `vps/`) into `.claude/vps/` — never the whole cron runtime.
 * Hooks live under the Claude shell (`claudeCodeDir`); the real engine modules stay at `core/vps/`.
 * @param {string} coreDir - Repo `core/` (holds the real `vps/` engine).
 * @param {string} claudeDir - Target `.claude/`.
 * @param {string} [claudeCodeDir] - Claude shell source (default: same as coreDir for legacy flat layout).
 * @returns {string} status string
 */
function copyHookVpsDeps(coreDir, claudeDir, claudeCodeDir = coreDir) {
  const hooksDir = join(claudeCodeDir, "hooks");
  if (!existsSync(hooksDir)) return [];
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
  // Always read real engine modules from core/vps/ (never monorepo-only claude-code/vps shims).
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
  return copied.sort();
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
  return copied;
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

function isPathContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertSafeDirectory(path, targetReal) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`refusing symlink directory in repo-file path: ${path}`);
  if (!info.isDirectory()) throw new Error(`repo-file ancestor is not a directory: ${path}`);
  const actual = realpathSync(path);
  if (!isPathContained(targetReal, actual)) {
    throw new Error(`repo-file path escapes target: ${path} -> ${actual}`);
  }
  return actual;
}

function ensureSafeParent(targetDir, destination) {
  const targetAbs = resolve(targetDir);
  const targetInfo = lstatSync(targetAbs);
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw new Error(`repo-file target must be a real directory: ${targetAbs}`);
  }
  const targetReal = realpathSync(targetAbs);
  const out = resolve(targetAbs, destination);
  if (!isPathContained(targetAbs, out)) throw new Error(`repo-file destination escapes target: ${destination}`);

  let current = targetAbs;
  const parentRel = relative(targetAbs, dirname(out));
  for (const part of parentRel === "" ? [] : parentRel.split(sep)) {
    current = join(current, part);
    if (lstatIfPresent(current) === null) {
      try {
        mkdirSync(current);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    assertSafeDirectory(current, targetReal);
  }
  assertSafeDirectory(dirname(out), targetReal);
  return { out, parent: dirname(out), targetReal };
}

function assertSafeDestination(out, targetReal) {
  const info = lstatSync(out);
  if (info.isSymbolicLink()) throw new Error(`refusing symlink repo-file destination: ${out}`);
  if (!info.isFile()) throw new Error(`repo-file destination is not a regular file: ${out}`);
  if (!isPathContained(targetReal, realpathSync(out))) {
    throw new Error(`repo-file destination escapes target: ${out}`);
  }
}

/**
 * @description Installs repo-level files without following target symlinks. Ancestors are checked
 * component-by-component and each file is published atomically by an exclusive hard link.
 */
export function installRepoFiles(coreDir, targetDir) {
  const installed = [];
  for (const [rel, dest] of REPO_FILES) {
    const src = resolveRepoFileSource(coreDir, rel);
    if (!existsSync(src)) continue;
    const { out, parent, targetReal } = ensureSafeParent(targetDir, dest);
    if (lstatIfPresent(out) !== null) {
      assertSafeDestination(out, targetReal);
      continue;
    }
    assertSafeDirectory(parent, targetReal);
    const temp = `${out}.${process.pid}.${Date.now()}.tmp`;
    let fd;
    try {
      fd = openSync(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(fd, readFileSync(src));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      assertSafeDirectory(parent, targetReal);
      try {
        linkSync(temp, out);
      } catch (error) {
        if (error?.code === "EEXIST") {
          assertSafeDestination(out, targetReal);
          continue;
        }
        throw error;
      }
      assertSafeDestination(out, targetReal);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
    installed.push(dest);
  }
  return installed.length ? installed.join(", ") : "none (already present or no source)";
}

/** @description Returns exact required native paths absent from a fresh vendored target. */
export function findMissingFreshNativePaths(targetDir, runtime) {
  const required = FRESH_NATIVE_PATHS[runtime];
  if (!required) throw new Error(`unknown runtime for fresh-install check: ${runtime}`);
  return required.filter((rel) => !existsSync(join(targetDir, rel)));
}

/** @description Fails a fresh-install integrity check while naming every absent native path. */
export function assertFreshNativeInstall(targetDir, runtime) {
  const missing = findMissingFreshNativePaths(targetDir, runtime);
  if (missing.length > 0) {
    throw new Error(`fresh-install missing native path(s): ${missing.join(", ")}`);
  }
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
 * @description Idempotent MERGE of the ephemeral-runtime ignore lines into `.claude/.gitignore`.
 * Never clobbers: an existing `.claude/.gitignore` (a consumer may keep its own project entries there)
 * is preserved verbatim and only the MISSING required lines are appended. Each required line is checked
 * against the current file first (tracked-before) so a re-vendor is a no-op when everything is already
 * ignored. `plans/` (relative to `.claude/`) covers `.claude/plans/` and its `.state/` gate dirs.
 * Returns a status string.
 */
export function mergeClaudeGitignore(claudeDir) {
  const gitignore = join(claudeDir, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const required = GITIGNORE.split("\n").filter((line) => line.trim().length > 0);
  const missing = required.filter((line) => !present.has(line.trim()));
  if (current.trim() && missing.length === 0) return "already ignored";
  if (!current.trim()) {
    writeFileSync(gitignore, GITIGNORE);
    return "created";
  }
  const body = `${current.trimEnd()}\n${missing.join("\n")}\n`;
  writeFileSync(gitignore, body);
  return `merged (${missing.length} line${missing.length === 1 ? "" : "s"} added)`;
}

/**
 * Ledger of retired `permissions.{allow,deny,ask}` entries for the Claude Code side. Empty today —
 * settings.json has never dropped a shipped entry — but the shape mirrors the OpenCode ledger
 * (RETIRED_OC_PERMISSION_ENTRIES, core/shared/lib/opencode-config-migration.mjs) so a future
 * retirement has somewhere to land without re-deriving the mechanism. See `ledgerMatches` in
 * `mergePermissionArray` for how an entry here is consulted.
 */
const RETIRED_CC_PERMISSION_ENTRIES = Object.freeze([]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqualValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqualValue(item, b[index]));
  }
  if (typeof a !== typeof b) return false;
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && deepEqualValue(a[key], b[key]));
}

/** @description Compares two normalized generations numerically (mirrors the OC migration lib's private helper). */
function compareGeneration(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * @description Structural shape check run right before the atomic rename — catches a migration
 * that produced something un-writable-as-config before it ever reaches disk.
 */
function isValidClaudeSettingsShape(config) {
  if (!isPlainObject(config)) return false;
  if (config.permissions === undefined) return true;
  if (!isPlainObject(config.permissions)) return false;
  return ["allow", "deny", "ask"].every(
    (key) => config.permissions[key] === undefined || Array.isArray(config.permissions[key]),
  );
}

function isPermissionArrayPath(path) {
  return path.length === 2 && path[0] === "permissions" && ["allow", "deny", "ask"].includes(path[1]);
}

/**
 * Merges one `permissions.{allow,deny,ask}` array as a SET UNION: every entry the new generation
 * ships is present (added if missing — this is what carries a new secret-read deny into an
 * already-vendored project, issue #487/ac-1.1). An existing entry is dropped ONLY when it is both
 * no longer shipped AND explicitly matched by the retired-entries ledger at or before its
 * `shippedThroughGeneration` — manifest ownership alone is never sufficient (deliberately stricter
 * than the OpenCode model this mirrors: a permission array here gates SECRET-READ denies, so a
 * shrunken/corrupted/truncated source `settings.json` — a bad `--source`, a partial checkout, a
 * merge mistake — must never silently erase protection that was already in place; only a reviewed,
 * checked-in ledger entry can retire an entry). Everything else the operator added, or that the
 * harness once owned but stopped shipping without a ledger entry, survives untouched.
 */
function mergePermissionArray(path, existingArr, newArr, ledgerByPath, projectGeneration) {
  const existing = Array.isArray(existingArr) ? existingArr : [];
  const shipped = Array.isArray(newArr) ? newArr : [];
  const shippedSet = new Set(shipped);
  const report = [];
  const result = [];
  const seen = new Set();

  function ledgerMatches(entry) {
    const ledgerEntry = ledgerByPath.get(`${JSON.stringify(path)}::${entry}`);
    if (ledgerEntry === undefined || projectGeneration === null) return false;
    return compareGeneration(projectGeneration, ledgerEntry.shippedThroughGeneration) <= 0;
  }

  for (const entry of existing) {
    if (seen.has(entry)) continue;
    if (!shippedSet.has(entry) && ledgerMatches(entry)) {
      report.push({ path, action: "removed-retired", value: entry });
      continue;
    }
    if (!shippedSet.has(entry)) report.push({ path, action: "kept-custom", value: entry });
    result.push(entry);
    seen.add(entry);
  }
  for (const entry of shipped) {
    if (seen.has(entry)) continue;
    result.push(entry);
    seen.add(entry);
    report.push({ path, action: "added", value: entry });
  }

  return { value: result, owned: shipped, report };
}

/**
 * Recursively merges one node of the settings tree. Mirrors `mergeNode` in
 * core/shared/lib/opencode-config-migration.mjs, adapted for settings.json's shape: a
 * `permissions.{allow,deny,ask}` path gets set-union array treatment (`mergePermissionArray`);
 * every other array (e.g. a `hooks.*` entry) is an opaque leaf, replaced only when the existing
 * value still equals what the manifest recorded as harness-owned — never force-overwritten,
 * since there is no ledger of retired hook wiring to arbitrate a diverged value.
 */
function mergeSettingsNode(path, existingNode, newNode, ownedNode, ledgerByPath, projectGeneration) {
  if (isPermissionArrayPath(path)) {
    // No `ownedNode` here on purpose: removal from a permission array requires an explicit ledger
    // match regardless of manifest ownership (see mergePermissionArray's doc) — passing it through
    // would invite a future "restore the owned check as a shortcut" regression of issue #487.
    return mergePermissionArray(path, existingNode, newNode, ledgerByPath, projectGeneration);
  }

  const existingIsMissingOrObject = existingNode === undefined || isPlainObject(existingNode);
  if (isPlainObject(newNode) && existingIsMissingOrObject) {
    const existingObj = isPlainObject(existingNode) ? existingNode : {};
    const ownedObj = isPlainObject(ownedNode) ? ownedNode : {};
    const mergedObj = {};
    const ownedOut = {};
    const report = [];

    for (const key of Object.keys(newNode)) {
      const childPath = [...path, key];
      const result = mergeSettingsNode(childPath, existingObj[key], newNode[key], ownedObj[key], ledgerByPath, projectGeneration);
      mergedObj[key] = result.value;
      if (result.owned !== undefined) ownedOut[key] = result.owned;
      report.push(...result.report);
    }
    for (const key of Object.keys(existingObj)) {
      if (Object.hasOwn(newNode, key)) continue;
      mergedObj[key] = existingObj[key];
    }

    return { value: mergedObj, owned: ownedOut, report };
  }

  if (existingNode === undefined) {
    return { value: newNode, owned: newNode, report: [{ path, action: "added", value: newNode }] };
  }
  if (deepEqualValue(existingNode, newNode)) {
    return { value: existingNode, owned: newNode, report: [] };
  }
  const matchesOwned = ownedNode !== undefined && deepEqualValue(existingNode, ownedNode);
  if (matchesOwned) {
    return { value: newNode, owned: newNode, report: [{ path, action: "updated", from: existingNode, to: newNode }] };
  }
  return { value: existingNode, owned: undefined, report: [{ path, action: "kept-custom", value: existingNode }] };
}

/**
 * @description Migrates a project's `.claude/settings.json` from whatever generation it was last
 * vendored at to the current one, without ever discarding an operator customization. Same
 * manifest/ledger model as `migrateOpencodeConfig` (issue #479), adapted for settings.json's
 * array-based `permissions.{allow,deny,ask}` lists instead of OpenCode's nested permission map.
 * No `tier` in the return value: unlike the OpenCode side, a permission-array removal here never
 * branches on tier (see `mergePermissionArray`) — reintroducing a tier-gated field here would only
 * invite a future "restore the OC-style backup gate" regression of issue #487.
 * @param {object} params
 * @param {ReadonlyArray<{arrayPath: string[], entry: string, shippedThroughGeneration: {major:number,minor:number,patch:number}}>} [params.retiredEntries] -
 *   the ledger consulted for removal corroboration; defaults to the real `RETIRED_CC_PERMISSION_ENTRIES`. Overridable ONLY so tests can
 *   exercise the removal path without a real production retirement — callers must never override this
 *   in non-test code.
 */
function migrateClaudeSettings({
  existingConfig,
  newConfig,
  manifest = null,
  previousHarnessVersionStamp = null,
  newHarnessVersion = null,
  retiredEntries = RETIRED_CC_PERMISSION_ENTRIES,
}) {
  const ledgerByPath = new Map(retiredEntries.map((entry) => [`${JSON.stringify(entry.arrayPath)}::${entry.entry}`, entry]));
  const ownedRoot = manifest && isPlainObject(manifest.owned) ? manifest.owned : {};
  const projectGeneration = normalizeHarnessVersionStamp(previousHarnessVersionStamp ?? manifest?.harnessVersion ?? null);

  const merged = mergeSettingsNode([], existingConfig ?? {}, newConfig ?? {}, ownedRoot, ledgerByPath, projectGeneration);

  return {
    config: merged.value,
    manifest: {
      version: 1,
      harnessVersion: newHarnessVersion ?? previousHarnessVersionStamp ?? manifest?.harnessVersion ?? "unknown",
      owned: merged.owned,
    },
    report: merged.report,
  };
}

/**
 * @description Writes/merges `.claude/settings.json` (issue #487). A fresh project gets the
 * shipped config outright; an already-vendored project gets it MERGED (manifest/ledger — see
 * `migrateClaudeSettings`) instead of parked in a `settings.harness.json` sidecar nobody reads —
 * that was the bug: a project vendored before this existed never received new harness-owned keys
 * (e.g. the secret-read denies), silently running without them. A pre-existing
 * `settings.harness.json` orphan from that era is consumed (superseded by the merge) and removed.
 * Validation gate before the rename: a migration producing something un-writable falls to the same
 * manual-repair sidecar an unparseable project config uses, never a partial write.
 * @param {string} coreDir - source core/claude-code
 * @param {string} claudeDir - project's .claude/
 * @param {string} [version] - harness version currently being vendored (stamped into the manifest)
 * @param {object} [testOverrides] - test-only seam, never passed in production; see `migrateClaudeSettings`
 * @param {ReadonlyArray<object>} [testOverrides.retiredEntries] - overrides RETIRED_CC_PERMISSION_ENTRIES for a test run
 * @returns {string} status
 */
export function writeSettings(coreDir, claudeDir, version, { retiredEntries } = {}) {
  const src = join(coreDir, "settings.json");
  if (!existsSync(src)) return "skipped (no source settings.json)";

  let newConfig;
  try {
    newConfig = JSON.parse(readFileSync(src, "utf8"));
  } catch {
    return "skipped (source settings.json invalid)";
  }

  const dest = join(claudeDir, "settings.json");
  const manifestPath = join(claudeDir, MANIFEST_FILENAME);
  const versionPath = join(claudeDir, ".harness-version");
  const orphanPath = join(claudeDir, "settings.harness.json");
  const backupPath = join(claudeDir, "settings.json.pre-migration.bak");
  const wasPresent = existsSync(dest);
  const hadOrphan = existsSync(orphanPath);

  let existing = newConfig;
  let existingRaw = null;
  if (wasPresent) {
    existingRaw = readFileSync(dest, "utf8");
    try {
      existing = JSON.parse(existingRaw);
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("not object");
    } catch {
      writeFileSync(orphanPath, `${JSON.stringify(newConfig, null, 2)}\n`);
      return "invalid existing settings.json → wrote settings.harness.json for manual repair";
    }
  }

  let manifest = null;
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed;
    } catch {
      manifest = null;
    }
  }
  const previousHarnessVersionStamp = existsSync(versionPath)
    ? readHarnessVersionStamp(readFileSync(versionPath, "utf8"))
    : null;

  const migrated = migrateClaudeSettings({
    existingConfig: existing,
    newConfig,
    manifest,
    previousHarnessVersionStamp,
    newHarnessVersion: version ?? null,
    retiredEntries,
  });

  if (!isValidClaudeSettingsShape(migrated.config)) {
    writeFileSync(orphanPath, `${JSON.stringify(newConfig, null, 2)}\n`);
    return "migration failed validation gate → wrote settings.harness.json for manual repair";
  }

  const addedEntries = migrated.report.filter((r) => r.action === "added");
  const removedEntries = migrated.report.filter((r) => r.action === "removed-retired");

  // Rollback layer 2 (layer 1 is git itself): once, whenever a ledger match actually dropped
  // something — tier-agnostic on purpose (a permission-array removal here always requires an
  // explicit ledger entry, regardless of tier; gating this on tier alone would leave it permanently
  // dead for any project past its first migration, since the manifest this function writes makes
  // every later run tier 1 — adversary finding, issue #487) — preserves the exact pre-migration
  // bytes, never overwritten by a later run.
  if (wasPresent && removedEntries.length > 0 && existingRaw !== null && !existsSync(backupPath)) {
    writeFileSync(backupPath, existingRaw);
  }

  const temp = `${dest}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(migrated.config, null, 2)}\n`);
  renameSync(temp, dest);

  const manifestTemp = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(manifestTemp, `${JSON.stringify(migrated.manifest, null, 2)}\n`);
  renameSync(manifestTemp, manifestPath);

  // ac-1.2: a settings.harness.json orphan from before this migration existed is superseded by the
  // merge above — nobody was ever going to merge it by hand — so it is consumed and removed here.
  if (hadOrphan) rmSync(orphanPath);

  if (!wasPresent) return "created";
  const orphanNote = hadOrphan ? "; removed stale settings.harness.json orphan" : "";
  if (addedEntries.length === 0 && removedEntries.length === 0) {
    return `already up to date${orphanNote}`;
  }
  const describe = (r) => `${r.path.join(".")}=${JSON.stringify(r.value)}`;
  const addedNote = addedEntries.length ? `added [${addedEntries.map(describe).join(", ")}]` : "";
  const removedNote = removedEntries.length ? `removed retired [${removedEntries.map(describe).join(", ")}]` : "";
  const migrationNote = [addedNote, removedNote].filter(Boolean).join("; ");
  return `merged existing settings.json (${migrationNote})${orphanNote}`;
}

// ---------- main (runs only when invoked directly as a script) ----------

// Symlink-safe: argv may be core/skills/... while import.meta.url is core/claude-code/skills/...
if (
  process.argv[1] &&
  (() => {
    try {
      return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return process.argv[1] === fileURLToPath(import.meta.url);
    }
  })()
) {
  const args = parseArgs(process.argv.slice(2));
  const stampDate = args.date ?? new Date().toISOString();
  // --target is the project DIR; --runtime is the shell (claude|opencode|both).
  // Both resolvers fail LOUD on bad input instead of silently defaulting.
  let target;
  let runtime;
  try {
    target = resolveProjectTarget(args.target, process.cwd());
    runtime = normalizeRuntimeTarget(args.runtime);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const { coreDir, claudeCodeDir, version, cleanup } = resolveSource(args.source, args.ref);

  const startedAt = Date.now();
  try {
    const withCodex = Boolean(args["with-codex"]);
    const doClaude = runtime === "claude" || runtime === "both";
    const doOc = runtime === "opencode" || runtime === "both";

    if (doClaude) {
      step("Vendoring Claude harness → .claude/");
      const { claudeDir } = vendorClaude({
        coreDir,
        claudeCodeDir,
        targetDir: target,
        version,
        stampDate,
        withCodex,
      });
      ok(`claude → ${claudeDir}`);
    }

    if (doOc) {
      step("Vendoring OpenCode harness → .opencode/");
      const { ocDir } = vendorOpenCode({
        coreDir,
        targetDir: target,
        version,
        stampDate,
      });
      ok(`opencode → ${ocDir}`);
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    const dests = [
      doClaude ? join(target, ".claude") : null,
      doOc ? join(target, ".opencode") : null,
    ]
      .filter(Boolean)
      .join(" + ");
    process.stdout.write(
      `\n${bold(green(`✓ harness ${version} vendored → ${dests} (${elapsedSec}s)`))}\n`,
    );
  } finally {
    cleanup();
  }
}
