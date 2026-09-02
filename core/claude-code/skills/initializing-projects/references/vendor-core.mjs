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
 *   - runtime markers/launchers are written for Claude Code, OpenCode, Codex, and Pi
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
  rmdirSync,
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
  isValidHarnessCompaction,
  isValidHarnessTerraContextPolicy,
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

// Codex reads project configuration, custom agents, and project skills from `.codex/`. Keep this adapter intentionally narrow: the
// source is declarative prose plus one policy hook, not a second workflow engine.
const CODEX_FRAMEWORK_OWNED = ["agents", "hooks", "rules", "docs", "lib", "skills"];
const CODEX_FRAMEWORK_FILES = ["hooks.json", "harness.routing.json", "model-routing.mjs"];
const CODEX_GITIGNORE = `# Codex Harness — local receipts and version cache, never commit
audit/
.harness-version-check-cache
`;

// `harness/state/` and `harness/plans/` are the Pi lane's mirror of `.opencode/plans/.state/` and
// `.opencode/plans/` — gate-state, hand/dispatch records, locks and execution plans. Ephemeral by
// construction: never committed. `harness/runtime/` is Pi's own data dir (real auth.json, sessions,
// mutated model store): ignored, machine-local, and NEVER written by the vendor — the launcher seeds
// it from the committed `harness/runtime-defaults/`, which is what a fresh clone actually ships.
const PI_GITIGNORE = `# Pi Harness — local sessions and package cache, never commit
harness/runtime/
harness/state/
harness/plans/
sessions/
npm/
git/
.harness-version-check-cache
`;

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
  codex: [
    ".codex/agents/planner.toml",
    ".codex/hooks.json",
    ".codex/rules/protected-operations.rules",
    ".codex/skills/harness-triage/SKILL.md",
    ".github/ISSUE_TEMPLATE/harness-task.yml",
  ],
  // Pi is vendored WHOLE (issue: cloud/headless only sees the repo). These are the canonical
  // anchors of that tree — the shim, the local launcher, one extension, one lib, the runtime
  // prompt/agents, the Codex skills, and one file from each vendored dependency root.
  pi: [
    ".pi/harness/pi-harness.mjs",
    ".pi/harness/bin/pi-harness.mjs",
    ".pi/harness/extensions/harness-bootstrap.ts",
    ".pi/harness/lib/pi-paths.mjs",
    ".pi/harness/prompts/harness-runtime.md",
    ".pi/harness/runtime-defaults/subagents.json",
    ".pi/harness/runtime-defaults/agents/harness-planner.md",
    ".pi/harness/skills/harness-triage/SKILL.md",
    ".pi/harness/vendor/shared/lib/gate-state-shape.mjs",
    ".pi/harness/vendor/opencode/lib/gate-state.mjs",
    ".pi/harness/vendor/codex/hooks/policy.mjs",
    ".pi/.harness-version",
    ".pi/.harness-owned-files.json",
  ],
};

/**
 * Every Pi extension and lib the port ships. Presence is REQUIRED in the source before a single
 * byte is copied: a vendored tree missing one gate is worse than a loud failure — the runtime
 * would come up silently ungated.
 */
const REQUIRED_PI_SOURCE = [
  { rel: "bin/pi-harness.mjs", kind: "file" },
  { rel: "prompts/harness-runtime.md", kind: "file" },
  { rel: "runtime/subagents.json", kind: "file" },
  { rel: "runtime/models-store.json", kind: "file" },
  { rel: "runtime/settings.json", kind: "file" },
  { rel: "runtime/agents", kind: "directory" },
  { rel: "lib/classify.mjs", kind: "file" },
  { rel: "lib/context-files.mjs", kind: "file" },
  { rel: "lib/dispatch-rail.mjs", kind: "file" },
  { rel: "lib/entry-gate.mjs", kind: "file" },
  { rel: "lib/marker-authority.mjs", kind: "file" },
  { rel: "lib/obs.mjs", kind: "file" },
  { rel: "lib/pi-adapter-map.mjs", kind: "file" },
  { rel: "lib/pi-child-identity.mjs", kind: "file" },
  { rel: "lib/pi-gate-state.mjs", kind: "file" },
  { rel: "lib/pi-paths.mjs", kind: "file" },
  { rel: "lib/pi-state-records.mjs", kind: "file" },
  { rel: "lib/plan-gate.mjs", kind: "file" },
  { rel: "lib/plan-tracker.mjs", kind: "file" },
  { rel: "lib/plan-write-decide.mjs", kind: "file" },
  { rel: "lib/policy.mjs", kind: "file" },
  { rel: "lib/roles.mjs", kind: "file" },
  { rel: "lib/run-hand.mjs", kind: "file" },
  { rel: "lib/session-state.mjs", kind: "file" },
  { rel: "lib/version-check.mjs", kind: "file" },
  { rel: "extensions/harness-bootstrap.ts", kind: "file" },
  { rel: "extensions/harness-classify.ts", kind: "file" },
  { rel: "extensions/harness-context-files.ts", kind: "file" },
  { rel: "extensions/harness-dispatch.ts", kind: "file" },
  { rel: "extensions/harness-entry-gate.ts", kind: "file" },
  { rel: "extensions/harness-idle-nudge.ts", kind: "file" },
  { rel: "extensions/harness-lavish-gate.ts", kind: "file" },
  { rel: "extensions/harness-marker.ts", kind: "file" },
  { rel: "extensions/harness-obs.ts", kind: "file" },
  { rel: "extensions/harness-plan-gate.ts", kind: "file" },
  { rel: "extensions/harness-plan-tracker.ts", kind: "file" },
  { rel: "extensions/harness-plan-write-gate.ts", kind: "file" },
  { rel: "extensions/harness-policy.ts", kind: "file" },
  { rel: "extensions/harness-reinject-state.ts", kind: "file" },
  { rel: "extensions/harness-run-hand.ts", kind: "file" },
  { rel: "extensions/harness-version-check.ts", kind: "file" },
];

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

/** @description Resolves the Codex shell source under `core/codex/`. */
export function resolveCodexDir(coreDir) {
  const nested = join(coreDir, "codex");
  if (
    existsSync(join(nested, "agents")) ||
    existsSync(join(nested, "skills")) ||
    existsSync(join(nested, "hooks.json"))
  ) {
    return nested;
  }
  return null;
}

/** @description Tokens that name a runtime shell (never a project directory). */
export const RUNTIME_TOKENS = new Set(["claude", "opencode", "oc", "codex", "both", "all"]);

/**
 * @description Normalize runtime target flag: claude | opencode | codex | both | all.
 * Fails LOUD on an unrecognized non-empty value instead of silently defaulting
 * to all — a typo / stale-binary / wrong-flag must never masquerade as a
 * successful partial vendor. Only an ABSENT (or empty) value defaults to all.
 * @param {unknown} raw
 * @returns {"claude"|"opencode"|"codex"|"both"|"all"}
 * @throws {Error} when raw is a non-empty string that is not a known token
 */
export function normalizeRuntimeTarget(raw) {
  const v = String(raw ?? "").toLowerCase().trim();
  if (v === "") return "all";
  if (v === "claude") return "claude";
  if (v === "opencode" || v === "oc") return "opencode";
  if (v === "codex") return "codex";
  if (v === "both") return "both";
  if (v === "all") return "all";
  throw new Error(
    `invalid --runtime "${raw}" — expected one of: claude | opencode | codex | both | all`,
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
 * `plugin` / `permission` / `compaction` / `provider` values. Null means a conservative canonical rewrite is required.
 */
function preserveProjectConfigFormatting(existingRaw, originalConfig, migratedConfig) {
  const originalKeys = Object.keys(originalConfig);
  const migratedKeys = Object.keys(migratedConfig);
  const keys = new Set([...originalKeys, ...migratedKeys]);
  const changedKeys = [...keys].filter((key) => !sameJsonValue(originalConfig[key], migratedConfig[key]));
  if (changedKeys.length === 0 || changedKeys.some((key) => key !== "plugin" && key !== "permission" && key !== "compaction" && key !== "provider")) return null;

  const spans = topLevelJsonValueSpans(existingRaw);
  if (!spans) return null;

  const newline = existingRaw.includes("\r\n") ? "\r\n" : "\n";
  const replacements = changedKeys
    .filter((key) => spans.has(key))
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

  const missingKeys = changedKeys.filter((key) => !spans.has(key));
  if (missingKeys.length > 0) {
    const nextSpans = topLevelJsonValueSpans(candidate);
    if (!nextSpans) return null;
    const closeIndex = candidate.lastIndexOf("}");
    if (closeIndex < 0 || candidate.slice(closeIndex + 1).trim() !== "") return null;
    const firstSpan = nextSpans.values().next().value;
    const indentation = firstSpan ? lineIndentationAt(candidate, firstSpan.start) : "  ";
    const inserted = missingKeys
      .map((key) => {
        const value = JSON.stringify(migratedConfig[key], null, 2).replace(/\n/g, `${newline}${indentation}`);
        return `${JSON.stringify(key)}: ${value}`;
      })
      .join(`,${newline}${indentation}`);
    const prefix = candidate.slice(0, closeIndex).trimEnd();
    candidate = `${prefix}${prefix.endsWith("{") ? "" : ","}${newline}${indentation}${inserted}${newline}${candidate.slice(closeIndex)}`;
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
 * autoload paths AND the harness-owned migration is a no-op including key order), skip the write entirely
 * and return `"unchanged"` so project formatters (Biome/Prettier) are not destroyed by a cosmetic
 * `JSON.stringify(..., null, 2)` rewrite. For a real plugin/permission migration, preserve the raw
 * project fields and replace only those harness-owned root values; unsupported layouts safely
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
  if (cfg.compaction !== undefined && !isValidHarnessCompaction(cfg.compaction)) {
    throw new Error("invalid harness compaction policy in opencode.json.example");
  }
  if (cfg.provider !== undefined && !isValidHarnessTerraContextPolicy(cfg.provider)) {
    throw new Error("invalid harness Terra context policy in opencode.json.example");
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
    isExistingProject: wasPresent,
  });

  // Validation gate BEFORE the rename — a migration that produced something un-writable never
  // touches `dest`; it falls to the same manual-repair path an unparseable project config uses.
  if (!isValidOpencodeConfigShape(migrated.config)) {
    writeFileSync(join(targetDir, "opencode.harness.json"), `${JSON.stringify(cfg, null, 2)}\n`);
    return "migration failed validation gate → wrote opencode.harness.json for manual repair";
  }

  const permissionReports = migrated.report.filter((r) => r.path[0] !== "compaction" && r.path[0] !== "provider");
  const removedEntries = permissionReports.filter((r) => r.action === "removed-retired");
  const keptEntries = permissionReports.filter((r) => r.action === "kept-custom");
  const compactionReport = migrated.report.find((r) => r.path[0] === "compaction");
  const providerReport = migrated.report.find((r) => r.path[0] === "provider");

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
  if (removedEntries.length === 0 && keptEntries.length === 0 && !compactionReport && !providerReport) {
    return "updated existing opencode.json harness configuration";
  }
  const describe = (r) => `${r.path.join(".")}=${JSON.stringify(r.value)}`;
  const removedNote = removedEntries.length ? `removed retired [${removedEntries.map(describe).join(", ")}]` : "";
  const keptNote = keptEntries.length ? `kept custom [${keptEntries.map(describe).join(", ")}]` : "";
  const permissionNote = [removedNote, keptNote].filter(Boolean).join("; ");
  const compactionNote = compactionReport ? `compaction: ${compactionReport.action}` : "";
  const providerNote = providerReport ? `Terra context policy: ${providerReport.action}` : "";
  const migrationNote = [permissionNote ? `permission migration: ${permissionNote}` : "", compactionNote, providerNote]
    .filter(Boolean)
    .join("; ");
  return `updated existing opencode.json harness configuration (${migrationNote})`;
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

/**
 * @description Reject source symlinks before the Codex vendor can enumerate or copy them.
 * The adapter is a trusted runtime boundary: following a source link would silently package
 * an arbitrary file outside the reviewed harness tree.
 */
function validateCodexSourceTree(root, current = root) {
  const info = lstatSync(current);
  if (info.isSymbolicLink()) {
    throw new Error(`Codex source artifact is a symlink: ${relative(root, current) || "."}`);
  }
  const actual = realpathSync(current);
  if (!isPathContained(root, actual)) {
    throw new Error(`Codex source artifact escapes source root: ${relative(root, current) || "."}`);
  }
  if (!info.isDirectory()) return;
  for (const name of readdirSync(current)) {
    if (name.startsWith("._")) continue;
    validateCodexSourceTree(root, join(current, name));
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

/** @description Read-only destination preflight for the native Codex shell. */
export function preflightCodexVendor(coreDir, targetDir) {
  const targetReal = pinTargetRoot(targetDir);
  const coreReal = pinTargetRoot(coreDir);
  const codexSource = resolveCodexDir(coreReal);
  if (!codexSource) throw new Error("Codex source missing: core/codex");
  validateCodexSourceTree(codexSource);
  const entries = [];
  for (const dir of CODEX_FRAMEWORK_OWNED) {
    const src = join(codexSource, dir);
    if (existsSync(src)) collectDestinationTree(src, join(".codex", dir), entries);
  }
  for (const file of CODEX_FRAMEWORK_FILES) {
    if (existsSync(join(codexSource, file))) entries.push({ destination: join(".codex", file), kind: "file" });
  }
  entries.push(
    { destination: ".codex", kind: "directory" },
    { destination: ".codex/config.toml", kind: "file" },
    { destination: ".codex/.gitignore", kind: "file" },
    { destination: ".codex/.harness-version", kind: "file" },
    { destination: ".codex/.harness-owned-files.json", kind: "file" },
    { destination: "AGENTS.md", kind: "file" },
    { destination: "MEMORY.md", kind: "file" },
    { destination: "kaizen.md", kind: "file" },
  );
  for (const [, destination] of REPO_FILES) entries.push({ destination, kind: "file" });
  for (const entry of entries) preflightDestination(targetReal, entry.destination, entry.kind);
  return { targetReal, codexSource, previousOwnedFiles: readPreviousCodexOwnedFiles(targetReal) };
}

/** @description Writes exact current ownership plus the deletions made by this vendor run. */
function writeOcOwnershipManifest(ocDir, entries, retired) {
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
  writeFileSync(
    join(ocDir, ".harness-owned-files.json"),
    `${JSON.stringify({ version: 1, files: [...files].sort(), retired: [...retired].sort() }, null, 2)}\n`,
  );
}

/**
 * @description Writes the exact Claude files produced by this vendor run. The lifecycle shipper
 * consumes this list instead of a directory prefix, so a project's local `.claude/` cargo never
 * enters the harness PR.
 * @param {{ coreDir: string, claudeCodeDir: string, claudeDir: string, modules: string[] }} options
 */
function writeClaudeOwnershipManifest({ coreDir, claudeCodeDir, claudeDir, modules }) {
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
  // NOTE: no more `.claude/vps/` entries here (issue #807) — the retired `core/vps/` mirror is
  // gone; `core/shared/` above already carries what was moved out of it (obs-outbox.mjs).
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
 * @description Claude-side counterpart to `OC_RETIRED_FILES`, for issue #807: files this installer
 * previously wrote into `.claude/` that source no longer has. Exact relative paths ONLY (never a
 * directory or a glob) — same safety rule as `OC_RETIRED_FILES`: this must never risk deleting a
 * project's own local file placed alongside harness output.
 * `.claude/vps/` was the mirror of the now-retired `core/vps/` engine; `obs-outbox.mjs` is the ONLY
 * module it ever held for any hook actually vendored (the closure was seeded from hooks' `../vps/`
 * imports, and obs-outbox had no vps-internal siblings that any hook imported).
 */
export const CLAUDE_RETIRED_FILES = ["vps/obs-outbox.mjs"];

/**
 * @description Cleans a legacy `.claude/vps/` mirror left behind by a vendor-core that predates the
 * retirement of `core/vps/` (issue #807). `core/shared/lib/obs-outbox.mjs` is where that module now
 * lives, already covered by `copyClaudeSharedDeps`; the old `.claude/vps/` copy is a stale second
 * copy of a live module and, once `.claude/.harness-owned-files.json` stops listing it, an
 * unattributable one — the lifecycle shipper would otherwise reclassify it as the project's own
 * cargo and it could leak into a harness PR.
 *
 * Delete set = the static `CLAUDE_RETIRED_FILES` ledger **union** any `.claude/vps/...` path listed
 * in the PRE-EXISTING `.claude/.harness-owned-files.json` (entries there are `.claude/`-prefixed,
 * e.g. `".claude/vps/obs-outbox.mjs"` — the prefix is stripped before joining to `claudeDir`).
 * The static ledger is the load-bearing half, not a fallback: on the likeliest real path — an
 * ALREADY-vendored project's older installer running against this new source — `copyHookVpsDeps` no
 * longer exists to mirror anything, so `writeClaudeOwnershipManifest` rewrites the manifest WITHOUT
 * any vps entry the very first time new code runs, orphaning the stale file before the manifest ever
 * recorded it as gone. The manifest half only catches a release that once mirrored MORE than
 * `obs-outbox.mjs`.
 *
 * MUST be called before `writeClaudeOwnershipManifest` overwrites `.harness-owned-files.json` for
 * this run — it reads the OLD manifest.
 *
 * Never touches a file the operator placed in `.claude/vps/` themselves: only exact ledger/manifest
 * paths are removed (never a glob or a recursive directory delete), and the directory itself is only
 * ever removed if left empty — `ENOTEMPTY` (something else is still in there) is a successful,
 * silent outcome, not an error.
 * @param {string} claudeDir
 * @returns {string} status string for the progress line
 */
function cleanRetiredClaudeFiles(claudeDir) {
  const manifestPath = join(claudeDir, ".harness-owned-files.json");
  const fromManifest = [];
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      for (const entry of manifest.files ?? []) {
        if (typeof entry !== "string") continue;
        const normalized = entry.split(sep).join("/");
        if (normalized.startsWith(".claude/vps/")) fromManifest.push(normalized.slice(".claude/".length));
      }
    } catch {
      // A corrupt/foreign manifest is not this function's problem — fall back to the static ledger.
    }
  }
  const deleteSet = new Set([...CLAUDE_RETIRED_FILES, ...fromManifest]);
  let removed = 0;
  for (const rel of deleteSet) {
    const abs = join(claudeDir, ...rel.split("/"));
    if (existsSync(abs)) {
      rmSync(abs, { force: true });
      removed += 1;
    }
  }
  try {
    rmdirSync(join(claudeDir, "vps"));
  } catch {
    // ENOTEMPTY (an operator's own file remains) or ENOENT (never existed) are both fine outcomes —
    // per the docstring above, only empty retired dirs are ever removed.
  }
  return removed > 0 ? `removed ${removed} file(s)` : "nothing to clean";
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
  // v2: the top-level conversation is build only. These former primary roles must be
  // removed during update as well as omitted from a fresh vendor; otherwise OpenCode
  // keeps discovering them from an already-vendored project's agents directory.
  "agents/plan.md",
  "agents/harness-config.md",
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
 * @description True when every component of `rel` exists beneath `root` with its exact case
 * (case-sensitive directory listings, not a case-insensitive path lookup). Guards
 * `pruneOcRetiredFiles` against deleting a user's same-name-different-case local file OR a file
 * below a differently-cased parent directory on macOS/Windows — `rmSync` alone could resolve
 * either path to the wrong on-disk entry.
 * @param {string} root
 * @param {string} rel
 * @returns {boolean}
 */
function existsWithExactCase(root, rel) {
  let current = root;
  for (const part of rel.split("/")) {
    if (!part || !existsSync(current) || !readdirSync(current).includes(part)) return false;
    current = join(current, part);
  }
  return true;
}

/**
 * @description Delete each `OC_RETIRED_FILES` entry missing from the source, but only on
 * an exact case-sensitive destination match. Paths can be predeclared before source removal.
 * @param {string} ocDir
 * @param {string} sourceOcDir
 */
export function pruneOcRetiredFiles(ocDir, sourceOcDir) {
  const removed = [];
  for (const rel of OC_RETIRED_FILES) {
    if (existsWithExactCase(sourceOcDir, rel)) continue;
    if (existsWithExactCase(ocDir, rel)) {
      rmSync(join(ocDir, rel), { force: true });
      removed.push(`.opencode/${rel}`);
    }
  }
  return removed;
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
  const retiredOcFiles = pruneOcRetiredFiles(ocDir, openCodeDir);
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
  const versionPath = join(ocDir, ".harness-version");
  const currentStamp = existsSync(versionPath) ? readFileSync(versionPath, "utf8") : "";
  if (!currentStamp.startsWith(`${version}\n`)) {
    writeFileSync(versionPath, `${version}\nvendored_at: ${stampDate}\n`);
  }
  writeOcOwnershipManifest(ocDir, preflight.entries, retiredOcFiles);
  ok(`.opencode/.gitignore (${gi}), .harness-version ${currentStamp.startsWith(`${version}\n`) ? "already current" : "written"}`);

  const repoFiles = installRepoFiles(coreDir, targetDir);
  ok(`repo files (.github/...): ${repoFiles}`);
  assertFreshNativeInstall(targetDir, "opencode");

  process.stdout.write(
    `${dim("!")} Project plugins execute when someone runs opencode in this repo (no hand tokens in plugins).\n`,
  );

  return { ocDir };
}

/** @description Idempotently merge only the harness instruction block into root AGENTS.md. */
function mergeCodexAgentsMd(codexDir, targetDir) {
  return mergeAgentsMd(codexDir, targetDir);
}

/** @description Merge the local Codex audit ignore without replacing project entries. */
function mergeCodexGitignore(codexDir) {
  const gitignore = join(codexDir, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const required = CODEX_GITIGNORE.split("\n").filter((line) => line.trim());
  const missing = required.filter((line) => !present.has(line.trim()));
  if (current.trim() && missing.length === 0) return "already ignored";
  if (!current.trim()) {
    writeFileSync(gitignore, CODEX_GITIGNORE);
    return "created";
  }
  writeFileSync(gitignore, `${current.trimEnd()}\n${missing.join("\n")}\n`);
  return `merged (${missing.length} lines added)`;
}

/**
 * @description Add missing activation switches without overriding explicit operator choices.
 * Codex ignores project hooks/custom agents when their feature switch is absent; silently
 * preserving an incomplete config would install a visibly inert harness.
 */
function ensureCodexRuntimeFeatures(configPath) {
  const source = readFileSync(configPath, "utf8");
  const required = ["hooks", "multi_agent"];
  // TOML permits inline tables and dotted keys. Merge only missing keys into those
  // valid forms: an explicit false survives, while an absent activation cannot make
  // the freshly-installed harness inert.
  const inline = source.match(/^(\s*features\s*=\s*\{)([^}\r\n]*)(\}[^\r\n]*)(\r?\n|$)/m);
  if (inline) {
    const [, prefix, body, suffix, newline] = inline;
    const present = new Set([...body.matchAll(/(?:^|,)\s*([A-Za-z0-9_-]+)\s*=/g)].map((match) => match[1]));
    const missing = required.filter((key) => !present.has(key));
    if (missing.length === 0) return "already declared";
    const trimmedBody = body.replace(/\s+$/, "");
    const separator = trimmedBody.length === 0 ? "" : ", ";
    const replacement = `${prefix}${trimmedBody}${separator}${missing.map((key) => `${key} = true`).join(", ")}${body.slice(trimmedBody.length)}${suffix}${newline}`;
    writeFileSync(configPath, source.replace(inline[0], replacement));
    return "missing inline activation features added";
  }
  const dotted = /^\s*features\.([A-Za-z0-9_-]+)\s*=/gm;
  const dottedKeys = new Set([...source.matchAll(dotted)].map((match) => match[1]));
  if (dottedKeys.size > 0) {
    const missing = required.filter((key) => !dottedKeys.has(key));
    if (missing.length === 0) return "already declared";
    const suffix = source.length === 0 || source.endsWith("\n") ? source : `${source}\n`;
    writeFileSync(configPath, `${suffix}${missing.map((key) => `features.${key} = true\n`).join("")}`);
    return "missing dotted activation features added";
  }
  if (/^\s*features\s*=/m.test(source)) {
    throw new Error("unsupported Codex features syntax; cannot safely merge activation keys");
  }
  const lines = source.split(/(?<=\n)/);
  const tableStart = lines.findIndex((line) => /^\s*\[features\]\s*(?:#.*)?(?:\r?\n)?$/.test(line));
  let next;
  if (tableStart === -1) {
    const suffix = source.length === 0 || source.endsWith("\n") ? source : `${source}\n`;
    next = `${suffix}\n[features]\n${required.map((key) => `${key} = true\n`).join("")}`;
  } else {
    const tableEnd = lines.findIndex((line, index) => index > tableStart && /^\s*\[/.test(line));
    const end = tableEnd === -1 ? lines.length : tableEnd;
    const present = new Set(
      lines.slice(tableStart + 1, end)
        .map((line) => line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1])
        .filter(Boolean),
    );
    const missing = required.filter((key) => !present.has(key));
    if (missing.length === 0) return "already declared";
    lines.splice(end, 0, ...missing.map((key) => `${key} = true\n`));
    next = lines.join("");
  }
  writeFileSync(configPath, next);
  return "missing activation features added";
}

/** @description Validate a manifest path before it can influence a deletion. */
function normalizeCodexOwnedPath(value) {
  if (typeof value !== "string") throw new Error("unsafe Codex ownership manifest path");
  const rel = value.replace(/\\/g, "/");
  const parts = rel.split("/");
  if (
    !rel || rel.startsWith("/") || ![".codex", ".agents"].includes(parts[0]) ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`unsafe Codex ownership manifest path: ${String(value)}`);
  }
  return rel;
}

/** @description Read and validate the previous finite ownership set before any vendor write. */
function readPreviousCodexOwnedFiles(targetDir) {
  const manifest = join(targetDir, ".codex", ".harness-owned-files.json");
  if (!existsSync(manifest)) return [];
  let previous;
  try {
    previous = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    throw new Error("invalid Codex ownership manifest");
  }
  if (previous?.version !== 1 || !Array.isArray(previous.files)) {
    throw new Error("invalid Codex ownership manifest");
  }
  return previous.files
    .filter((path) => typeof path === "string" && (path.startsWith(".codex/") || path.startsWith(".agents/")))
    .map(normalizeCodexOwnedPath);
}

/** @description Remove only manifest-listed paths (Codex or Pi) retired by the current source. */
function pruneRetiredOwnedFiles(targetDir, previousOwnedFiles, nextFiles) {
  for (const rel of previousOwnedFiles) {
    if (nextFiles.has(rel)) continue;
    const abs = join(targetDir, rel);
    const info = lstatIfPresent(abs);
    if (info?.isFile() || info?.isSymbolicLink()) rmSync(abs, { force: true });
  }
}

/** @description Write the finite set of files owned by the Codex adapter for lifecycle updates. */
function writeCodexOwnershipManifest({ codexDir, previousOwnedFiles, sourceCodexDir, targetDir }) {
  const entries = [];
  for (const dir of CODEX_FRAMEWORK_OWNED) {
    const src = join(sourceCodexDir, dir);
    if (existsSync(src)) collectDestinationTree(src, join(".codex", dir), entries);
  }
  for (const file of CODEX_FRAMEWORK_FILES) {
    const src = join(sourceCodexDir, file);
    if (existsSync(src)) entries.push({ destination: join(".codex", file), kind: "file" });
  }
  for (const path of [
    ".codex/.gitignore",
    ".codex/.harness-version",
    ".codex/.harness-owned-files.json",
    "AGENTS.md",
    ".github/ISSUE_TEMPLATE/harness-task.yml",
    ".dev.vars.example",
  ]) entries.push({ destination: path, kind: "file" });
  const files = new Set(
    entries.filter((entry) => entry.kind === "file").map((entry) => entry.destination.split(sep).join("/")),
  );
  const manifestPath = join(codexDir, ".harness-owned-files.json");
  pruneRetiredOwnedFiles(targetDir, previousOwnedFiles, files);
  writeFileSync(manifestPath, `${JSON.stringify({ version: 1, files: [...files].sort() }, null, 2)}\n`);
}

/**
 * @description Vendor the minimal native Codex adapter: config is operator-owned/non-clobber;
 * harness agents, hooks, rules, docs and skills are refreshed from explicit source paths.
 */
export function vendorCodex({ coreDir, targetDir, version, stampDate }) {
  const preflight = preflightCodexVendor(coreDir, targetDir);
  targetDir = preflight.targetReal;
  const codexSource = preflight.codexSource;
  const codexDir = join(targetDir, ".codex");
  mkdirSync(codexDir, { recursive: true });

  for (const dir of CODEX_FRAMEWORK_OWNED) {
    const src = join(codexSource, dir);
    if (existsSync(src)) copyOcTree(src, join(codexDir, dir), dir);
  }
  for (const file of CODEX_FRAMEWORK_FILES) {
    const src = join(codexSource, file);
    if (existsSync(src)) cpSync(src, join(codexDir, file));
  }
  const projectConfig = join(codexDir, "config.toml");
  if (!existsSync(projectConfig)) cpSync(join(codexSource, "config.toml"), projectConfig);
  const configFeatures = ensureCodexRuntimeFeatures(projectConfig);
  const accumulated = seedOcAccumulated(targetDir);

  const agents = mergeCodexAgentsMd(codexSource, targetDir);
  const gitignore = mergeCodexGitignore(codexDir);
  const versionPath = join(codexDir, ".harness-version");
  const currentStamp = existsSync(versionPath) ? readFileSync(versionPath, "utf8") : "";
  if (!currentStamp.startsWith(`${version}\n`)) {
    writeFileSync(versionPath, `${version}\nvendored_at: ${stampDate}\n`);
  }
  const repoFiles = installRepoFiles(coreDir, targetDir);
  writeCodexOwnershipManifest({
    codexDir,
    previousOwnedFiles: preflight.previousOwnedFiles,
    sourceCodexDir: codexSource,
    targetDir,
  });
  assertFreshNativeInstall(targetDir, "codex");
  ok(`Codex: agents/hooks/rules/skills refreshed; config ${configFeatures}; memory ${accumulated}; AGENTS.md ${agents}; .gitignore ${gitignore}; repo files ${repoFiles}`);
  return { codexDir };
}

function mergePiGitignore(piDir) {
  const gitignore = join(piDir, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const required = PI_GITIGNORE.split("\n").filter((line) => line.trim());
  const missing = required.filter((line) => !present.has(line));
  if (current.trim() && missing.length === 0) return "already ignored";
  if (!current.trim()) {
    writeFileSync(gitignore, PI_GITIGNORE);
    return "created";
  }
  writeFileSync(gitignore, `${current.trimEnd()}\n${missing.join("\n")}\n`);
  return `merged (${missing.length} lines added)`;
}

/** @description Rejects a foreign Pi harness directory before the vendor can overwrite it. */
function readPreviousPiOwnedFiles(targetReal) {
  const harnessDir = join(targetReal, ".pi", "harness");
  const manifestPath = join(targetReal, ".pi", ".harness-owned-files.json");
  if (!existsSync(harnessDir)) return [];
  if (!existsSync(manifestPath)) throw new Error("refusing foreign .pi/harness without a harness ownership manifest");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("invalid Pi ownership manifest");
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.files)) throw new Error("invalid Pi ownership manifest");
  for (const path of manifest.files) {
    if (typeof path !== "string" || !path.startsWith(".pi/") || path.includes("..")) {
      throw new Error("invalid Pi ownership manifest");
    }
  }
  return manifest.files;
}

/**
 * @description Lists every vendorable file under a source tree, POSIX-relative to `root`.
 * Excludes `*.test.mjs` (tests never ship) and AppleDouble junk; a source symlink is a hard
 * error — following one would package an arbitrary file from outside the reviewed tree.
 * @param {string} root
 * @returns {string[]}
 */
function collectPiSourceFiles(root, current = root, out = []) {
  for (const name of readdirSync(current)) {
    if (name.startsWith("._")) continue;
    const abs = join(current, name);
    const info = lstatSync(abs);
    if (info.isSymbolicLink()) throw new Error(`Pi source artifact is a symlink: ${relative(root, abs)}`);
    if (info.isDirectory()) collectPiSourceFiles(root, abs, out);
    else if (info.isFile() && !name.endsWith(".test.mjs")) out.push(relative(root, abs).split(sep).join("/"));
  }
  return out;
}

const PI_RELATIVE_IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g;

/**
 * @description Transitive closure of the files OUTSIDE `core/pi` that the Pi lane imports by
 * relative path — `core/opencode/**`, `core/shared/**`, `core/codex/hooks/policy.mjs`. Returned
 * as POSIX paths relative to `core/`, which is exactly the layout they get under
 * `.pi/harness/vendor/` (so their own `../../shared/...` imports keep resolving unchanged).
 * A specifier escaping `core/`, or naming a missing file outside `core/pi`, is a hard error;
 * a missing sibling INSIDE `core/pi` belongs to that piece's own tests — the whole `core/pi`
 * tree is copied regardless.
 * @param {string} coreDir
 * @param {string[]} piFiles - POSIX paths relative to core/pi
 * @returns {string[]}
 */
export function collectPiVendorClosure(coreDir, piFiles) {
  const piRoot = join(coreDir, "pi");
  const queue = piFiles.map((rel) => join(piRoot, ...rel.split("/")));
  const seen = new Set(queue);
  const vendored = new Set();
  while (queue.length > 0) {
    const file = queue.shift();
    if (!/\.(mjs|js|ts|tsx|jsx)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(PI_RELATIVE_IMPORT_PATTERN)) {
      const target = resolve(dirname(file), match[1]);
      const insidePi = isPathContained(piRoot, target);
      if (!existsSync(target)) {
        if (insidePi) continue;
        throw new Error(
          `Pi vendor dependency missing: ${match[1]} (imported by core/pi/${relative(piRoot, file).split(sep).join("/")})`,
        );
      }
      if (!isPathContained(coreDir, target)) {
        throw new Error(`Pi vendor dependency escapes core/: ${match[1]}`);
      }
      if (insidePi) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
        continue;
      }
      const rel = relative(coreDir, target).split(sep).join("/");
      if (!vendored.has(rel)) {
        vendored.add(rel);
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...vendored].sort();
}

/**
 * @description Rewrites a `core/pi` file's monorepo sibling imports (`../../opencode/…`,
 * `../../shared/…`, `../../codex/…`) to the vendored `vendor/` root under `.pi/harness/`.
 * Depth-aware and quote-anchored, so only string literals are touched.
 * @param {string} content
 * @param {string} relFromPiRoot - e.g. `lib/policy.mjs`
 * @returns {string}
 */
export function rewritePiImportsForVendor(content, relFromPiRoot) {
  if (typeof content !== "string" || typeof relFromPiRoot !== "string") return content;
  const depth = Math.max(0, relFromPiRoot.replace(/\\/g, "/").split("/").filter(Boolean).length - 1);
  const from = "../".repeat(depth + 1).replace(/\./g, "\\.");
  const to = depth === 0 ? "./vendor/" : `${"../".repeat(depth)}vendor/`;
  return content.replace(new RegExp(`(["'])${from}(opencode|shared|codex)/`, "g"), `$1${to}$2/`);
}

/**
 * @description Rewrites the launcher copy so its package root is the vendored `.pi/harness/`
 * itself instead of the monorepo root: `../../../` becomes `../` (from `bin/`), and the
 * `core/pi/…` / `core/codex/skills` prefixes collapse onto the vendored tree. `core/pi/runtime`
 * lands on `runtime-defaults` — the committed seed — because `.pi/harness/runtime/` is Pi's ignored
 * data dir, so the launcher must verify and materialize from the copy a fresh clone actually has.
 * Applied only when the monorepo shapes are present, so a launcher that later learns its own layout
 * is left alone.
 * @param {string} content
 * @returns {string}
 */
export function rewritePiLauncherForVendor(content) {
  if (typeof content !== "string") return content;
  return content
    .split('new URL("../../../", import.meta.url)')
    .join('new URL("../", import.meta.url)')
    .split('"core/codex/skills"')
    .join('"skills"')
    .split('"core/pi/runtime')
    .join('"runtime-defaults')
    .split('"core/pi/')
    .join('"');
}

// Pi's own data dir (`.pi/harness/runtime/`) is git-ignored and machine-local: the operator's real
// credentials and sessions live there. The vendor therefore ships the immutable defaults to
// `runtime-defaults/`, which IS committed, and the launcher seeds the data dir from it on first run.
// `auth.json` is never packaged at all — a placeholder token file has no business in a repo, and
// copying one would silently overwrite a live login on every re-vendor.
const PI_RUNTIME_CREDENTIALS = "runtime/auth.json";

/**
 * @description Destination of a `core/pi` file inside `.pi/harness/`, POSIX-relative. Identity for
 * everything but `runtime/`, which is redirected to the committed `runtime-defaults/` seed.
 * @param {string} rel
 * @returns {string}
 */
function piVendorRelative(rel) {
  return rel.startsWith("runtime/") ? `runtime-defaults/${rel.slice("runtime/".length)}` : rel;
}

/**
 * @description Read-only Pi destination preflight. Requires every Pi extension/lib in the source
 * before a byte is copied, resolves the whole vendored file plan (Pi tree + dependency closure +
 * Codex skills), and rejects a foreign `.pi/harness`. Pi's own `.pi/` settings stay operator-owned.
 * @param {string} coreDir
 * @param {string} targetDir
 */
export function preflightPiVendor(coreDir, targetDir) {
  const targetReal = pinTargetRoot(targetDir);
  const coreReal = pinTargetRoot(coreDir);
  const piSource = join(coreReal, "pi");
  if (!existsSync(piSource)) throw new Error("Pi source missing: core/pi");
  for (const artifact of REQUIRED_PI_SOURCE) {
    const abs = join(piSource, ...artifact.rel.split("/"));
    const info = lstatIfPresent(abs);
    if (info === null) throw new Error(`Pi source missing: core/pi/${artifact.rel}`);
    if (info.isSymbolicLink()) throw new Error(`Pi source artifact is a symlink: core/pi/${artifact.rel}`);
    if (artifact.kind === "directory" && !info.isDirectory()) {
      throw new Error(`Pi source artifact is not a directory: core/pi/${artifact.rel}`);
    }
    if (artifact.kind === "file" && !info.isFile()) {
      throw new Error(`Pi source artifact is not a regular file: core/pi/${artifact.rel}`);
    }
  }
  const skillsSource = join(coreReal, "codex", "skills");
  if (!existsSync(skillsSource)) throw new Error("Pi source missing: core/codex/skills");

  const piFiles = collectPiSourceFiles(piSource).filter((rel) => rel !== PI_RUNTIME_CREDENTIALS);
  const vendorFiles = collectPiVendorClosure(coreReal, piFiles);
  const skillFiles = collectPiSourceFiles(skillsSource);
  const files = [
    ...piFiles.map((rel) => ({
      source: join(piSource, ...rel.split("/")),
      destination: `.pi/harness/${piVendorRelative(rel)}`,
      transform: rel === "bin/pi-harness.mjs" ? "launcher" : rel.startsWith("runtime/") ? "raw" : "pi",
      rel,
    })),
    ...vendorFiles.map((rel) => ({
      source: join(coreReal, ...rel.split("/")),
      destination: `.pi/harness/vendor/${rel}`,
      transform: "raw",
      rel,
    })),
    ...skillFiles.map((rel) => ({
      source: join(skillsSource, ...rel.split("/")),
      destination: `.pi/harness/skills/${rel}`,
      transform: "raw",
      rel,
    })),
  ];
  const generated = [
    ".pi/harness/pi-harness.mjs",
    ".pi/.gitignore",
    ".pi/.harness-version",
    ".pi/.harness-owned-files.json",
  ];

  const previousOwnedFiles = readPreviousPiOwnedFiles(targetReal);
  preflightDestination(targetReal, ".pi", "directory");
  preflightDestination(targetReal, ".pi/harness", "directory");
  for (const entry of files) preflightDestination(targetReal, entry.destination, "file");
  for (const destination of generated) preflightDestination(targetReal, destination, "file");
  return { targetReal, piSource, files, generated, previousOwnedFiles };
}

/**
 * @description Source of the `.pi/harness/pi-harness.mjs` shim: it runs the LOCAL vendored
 * launcher (`node .pi/harness/bin/pi-harness.mjs`) — no npx, no network, no per-invocation
 * package resolution. Pi and pi-subagents come from the project's own `node_modules` (deps pinned
 * in the project `package.json`) or from `.pi/harness/node_modules`, resolved by the launcher.
 * @param {string} version
 * @returns {string}
 */
export function piLauncherSource(version) {
  return `#!/usr/bin/env node
/**
 * Claude Harness ${version} — vendored Pi entry point.
 * Runs the LOCAL launcher under .pi/harness/bin/. No download, no network: @earendil-works/pi-coding-agent
 * and @gotgenes/pi-subagents are resolved from the project's node_modules (pinned in package.json)
 * or from .pi/harness/node_modules. Every flag, --verify included, is forwarded verbatim.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = join(dirname(fileURLToPath(import.meta.url)), "bin", "pi-harness.mjs");
const result = spawnSync(process.execPath, [launcher, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`;
}

/**
 * @description Vendors the WHOLE Pi lane into `.pi/harness/` — the `core/pi` tree (bin, extensions,
 * lib, prompts, and `runtime/` as the committed `runtime-defaults/` seed, minus `auth.json`), its
 * relative-import dependency closure under `vendor/`, and the Codex
 * skills under `skills/` — plus the local shim. The ownership manifest lists every file written,
 * which is what authorizes overwriting `.pi/harness` on the next run; files that left the manifest
 * are deleted. Pi's own settings and normal Pi resources are never claimed.
 * @param {{ coreDir: string, targetDir: string, version: string, stampDate: string }} options
 */
export function vendorPi({ coreDir, targetDir, version, stampDate }) {
  const preflight = preflightPiVendor(coreDir, targetDir);
  targetDir = preflight.targetReal;
  const piDir = join(targetDir, ".pi");
  const harnessDir = join(piDir, "harness");
  mkdirSync(harnessDir, { recursive: true });

  for (const entry of preflight.files) {
    const dest = join(targetDir, ...entry.destination.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.transform === "raw") {
      cpSync(entry.source, dest);
      continue;
    }
    const text = readFileSync(entry.source, "utf8");
    const rewritten =
      entry.transform === "launcher"
        ? rewritePiLauncherForVendor(rewritePiImportsForVendor(text, entry.rel))
        : rewritePiImportsForVendor(text, entry.rel);
    writeFileSync(dest, rewritten, entry.transform === "launcher" ? { mode: 0o755 } : undefined);
  }

  writeFileSync(join(harnessDir, "pi-harness.mjs"), piLauncherSource(version), { mode: 0o755 });
  const gitignore = mergePiGitignore(piDir);
  const versionPath = join(piDir, ".harness-version");
  const currentStamp = existsSync(versionPath) ? readFileSync(versionPath, "utf8") : "";
  if (!currentStamp.startsWith(`${version}\n`)) writeFileSync(versionPath, `${version}\nvendored_at: ${stampDate}\n`);

  const files = new Set([...preflight.files.map((entry) => entry.destination), ...preflight.generated]);
  pruneRetiredOwnedFiles(targetDir, preflight.previousOwnedFiles, files);
  writeFileSync(
    join(piDir, ".harness-owned-files.json"),
    `${JSON.stringify({ version: 1, files: [...files].sort() }, null, 2)}\n`,
  );
  assertFreshNativeInstall(targetDir, "pi");
  ok(
    `Pi: ${preflight.files.length} files vendored → .pi/harness/ (tree + vendor/ + skills/); .gitignore ${gitignore}; invoke node .pi/harness/pi-harness.mjs`,
  );
  return { piDir };
}

/**
 * @description Vendor Claude shell into project `.claude/` (existing behavior).
 * @param {{ coreDir: string, claudeCodeDir: string, targetDir: string, version: string, stampDate: string, withCodex: boolean }} opts
 */
function vendorClaude({ coreDir, claudeCodeDir, targetDir, version, stampDate, withCodex }) {
  const claudeDir = join(targetDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // Must run before writeClaudeOwnershipManifest (below) overwrites the manifest this reads.
  const retiredCleanup = cleanRetiredClaudeFiles(claudeDir);
  ok(`retired .claude/vps/ mirror (#807): ${retiredCleanup}`);

  copyFrameworkOwned(claudeCodeDir, claudeDir);
  ok("agents/skills/rules/hooks copied (*.test.mjs excluded)");

  // Hooks import core/shared pure (absolution, regate, git-state, real-file, and — since #807 —
  // obs-outbox). Mirror into .claude/shared and rewrite monorepo-relative imports so vendored hooks
  // resolve. This ALSO now covers what used to be the separate .claude/vps/ mirror: obs-outbox.mjs
  // moved into core/shared/lib/, so this one blanket copy is all it needs.
  const sharedMirrored = copyClaudeSharedDeps(coreDir, claudeDir);
  ok(`hooks' shared deps → .claude/shared/: ${sharedMirrored}`);
  const sharedRewrites = rewriteClaudeSharedImports(claudeDir);
  ok(`shared import rewrites: ${sharedRewrites}`);

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

  const importScan = scanVendoredImports(claudeDir);
  if (importScan.unresolved.length > 0) {
    const lines = importScan.unresolved.map((m) => `    ${m.file} imports ${m.specifier} — UNRESOLVED`);
    fail(
      [
        "FATAL — vendored files import paths that do not exist under .claude/:",
        ...lines,
        "  A file with an unresolved import crashes on load (ERR_MODULE_NOT_FOUND) and silently",
        "  blocks the entry-gate. Re-run vendor-core (this same, current copy).",
      ].join("\n"),
    );
  }
  ok(`vendored imports resolved: ${importScan.total} specifiers checked`);

  const claudeGitignore = mergeClaudeGitignore(claudeDir);
  const versionPath = join(claudeDir, ".harness-version");
  const currentStamp = existsSync(versionPath) ? readFileSync(versionPath, "utf8") : "";
  if (!currentStamp.startsWith(`${version}\n`)) {
    writeFileSync(versionPath, `${version}\nvendored_at: ${stampDate}\n`);
  }
  writeClaudeOwnershipManifest({ coreDir, claudeCodeDir, claudeDir, modules });
  ok(`.claude/.gitignore (${claudeGitignore}), .harness-version ${currentStamp.startsWith(`${version}\n`) ? "already current" : "written"}`);
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

// Extensions this scan opens and reads. `.test.mjs` files are never vendored (isFrameworkCopyIncluded
// excludes them at copy time), so their imports never ship and are skipped here too.
const VENDORED_IMPORT_SCAN_EXTENSIONS = [".mjs", ".js", ".ts"];

// Three import shapes a vendored file may use, all textual over the SAME comment-stripped source
// (see stripCommentsForImportScan below) — `from`-shaped covers static imports and re-exports,
// `import '...'`-shaped covers a bare side-effect import, and the dynamic-call shape covers a
// deferred `await import(...)`. The dynamic shape exists in shipped code today:
// `core/claude-code/hooks/vps-access-nudge.mjs` does `await import('../skills/.../orca-doctor.mjs')`
// and its own docstring names this exact gate as the reason the specifier is a literal.
const REL_IMPORT_SHAPES = [
  /\bfrom\s*['"](\.{1,2}\/[^'"\n]+)['"]/g,
  /\bimport\s+['"](\.{1,2}\/[^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*\)/g,
];

/**
 * @description Strips comments before the import-shape regexes run, LINE-ORIENTED rather than with
 * a whole-file `/\/\*[\s\S]*?\*\//` block regex — that block form treats any in-string `/*` as a
 * comment opener, and this tree has one: `detect-stack.mjs` builds the string
 * `'node --test "**\/*.test.mjs"'`, whose `/*` would otherwise swallow everything up to the NEXT
 * `*\/` (e.g. the next JSDoc's closer), silently dropping real imports from the scan. Instead: drop
 * a line whose trimmed form starts with `*`, `//` or `/*` outright (covers JSDoc bodies and full-line
 * comments), and strip a trailing `//...` only when that `//` is not preceded by `:`, `'`, `"` or `\`
 * (a URL, a string literal boundary, or an escape are not comment openers).
 * @param {string} text
 * @returns {string}
 */
function stripCommentsForImportScan(text) {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return "";
      for (let i = 0; i < line.length - 1; i += 1) {
        if (line[i] !== "/" || line[i + 1] !== "/") continue;
        const prev = i > 0 ? line[i - 1] : "";
        if (prev === ":" || prev === "'" || prev === '"' || prev === "\\") continue;
        return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/**
 * @description Post-vendor integrity check over the FINAL vendored state (issue #807): every
 * relative import specifier in every vendored file must resolve to a file that exists under
 * `.claude/`. Generalizes the retired `.claude/vps/` mirror check (which only read `hooks/` and only
 * the `from "../vps/…"` shape) to the same failure class it was really guarding against: a vendored
 * file whose relative import does not resolve under `.claude/` crashes on load
 * (ERR_MODULE_NOT_FOUND) invisibly — PostToolUse hooks are fire-and-forget, so the only symptom is
 * the entry-gate silently blocking every delivery subagent.
 *
 * Scans the WHOLE vendored `.claude/` tree, not just `FRAMEWORK_OWNED`/`hooks/`: the old hooks-only
 * scan is why a depth-3 skill reference (`skills/orchestrating-delivery/references/descriptor-emitter.mjs`)
 * was never covered despite carrying a cross-tree import, and `shared/` — where obs-outbox.mjs now
 * lives — and `modules/` (vendored under `--with-codex`) are both reachable from `.claude/` but are
 * neither `FRAMEWORK_OWNED` nor `hooks/`.
 *
 * Pure read-only.
 * @param {string} claudeDir
 * @returns {{ total: number, unresolved: { file: string, specifier: string }[] }}
 */
function scanVendoredImports(claudeDir) {
  const unresolved = [];
  let total = 0;
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const info = lstatSync(abs);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        walk(abs);
        continue;
      }
      if (name.endsWith(".test.mjs")) continue;
      if (!VENDORED_IMPORT_SCAN_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
      const stripped = stripCommentsForImportScan(readFileSync(abs, "utf8"));
      const specifiers = new Set();
      for (const shape of REL_IMPORT_SHAPES) {
        for (const m of stripped.matchAll(shape)) specifiers.add(m[1]);
      }
      for (const specifier of specifiers) {
        total += 1;
        if (!existsSync(resolve(dirname(abs), specifier))) {
          unresolved.push({ file: relative(claudeDir, abs).split(sep).join("/"), specifier });
        }
      }
    }
  };
  walk(claudeDir);
  return { total, unresolved };
}

/**
 * @description Exported read of `scanVendoredImports` — just the unresolved list (empty ⇒ every
 * vendored relative import resolves under `.claude/`). See `scanVendoredImports` for the full
 * rationale; this wrapper exists so the FATAL-gate check in `vendorClaude` and any external caller
 * (tests, a future probe script) share one implementation.
 * @param {string} claudeDir
 * @returns {{ file: string, specifier: string }[]}
 */
export function findUnresolvedVendoredImports(claudeDir) {
  return scanVendoredImports(claudeDir).unresolved;
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
  // --target is the project DIR; --runtime is the shell (claude|opencode|codex|both|all).
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
    const doClaude = runtime === "claude" || runtime === "both" || runtime === "all";
    const doOc = runtime === "opencode" || runtime === "both" || runtime === "all";
    const doCodex = runtime === "codex" || runtime === "all";
    const doPi = runtime === "all";

    // The all-runtime path must reject a foreign Pi harness before any other
    // runtime can write to the project. The individual vendors retain their
    // own complete preflight immediately before their writes.
    if (doPi) preflightPiVendor(coreDir, target);

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

    if (doCodex) {
      step("Vendoring Codex harness → .codex/");
      const { codexDir } = vendorCodex({
        coreDir,
        targetDir: target,
        version,
        stampDate,
      });
      ok(`codex → ${codexDir}`);
    }

    if (doPi) {
      step("Vendoring Pi harness → .pi/harness/");
      const { piDir } = vendorPi({
        coreDir,
        targetDir: target,
        version,
        stampDate,
      });
      ok(`pi → ${piDir}`);
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    const dests = [
      doClaude ? join(target, ".claude") : null,
      doOc ? join(target, ".opencode") : null,
      doCodex ? join(target, ".codex") : null,
      doPi ? join(target, ".pi", "harness") : null,
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
