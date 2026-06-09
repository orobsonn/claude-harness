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
 *   - framework-owned (overwritten): agents/, skills/, rules/, CLAUDE-HARNESS-MEMORY-MODEL.md
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
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARNESS_START = "<!-- harness:start — managed by initializing-projects, do not edit inside -->";
const HARNESS_END = "<!-- harness:end -->";

const FRAMEWORK_OWNED = ["agents", "skills", "rules"];
const FRAMEWORK_FILES = ["CLAUDE-HARNESS-MEMORY-MODEL.md"];
const ACCUMULATED = [
  ["memory/MEMORY.md", "memory"],
  ["kaizen.md", "."],
];

const GITIGNORE = `# Claude Harness — ephemeral, never committed
plans/
settings.local.json
*.local.md
`;

/** @description Parses `--flag value` pairs from argv into a plain object. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) fail(`unexpected argument: ${key}`);
    args[key.slice(2)] = argv[i + 1];
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
    try {
      execFileSync("git", cloneArgs, { stdio: "pipe" });
    } catch (err) {
      rmSync(dest, { recursive: true, force: true });
      fail(`git clone failed for "${source}": ${err.message}`);
    }
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

/** @description Copies framework-owned dirs/files into .claude/, overwriting. */
function copyFrameworkOwned(coreDir, claudeDir) {
  for (const dir of FRAMEWORK_OWNED) {
    const src = join(coreDir, dir);
    if (existsSync(src)) cpSync(src, join(claudeDir, dir), { recursive: true });
  }
  for (const file of FRAMEWORK_FILES) {
    const src = join(coreDir, file);
    if (existsSync(src)) cpSync(src, join(claudeDir, file));
  }
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

// ---------- main ----------

const args = parseArgs(process.argv.slice(2));
const target = args.target ?? process.cwd();
const claudeDir = join(target, ".claude");
const stampDate = args.date ?? new Date().toISOString();

const { coreDir, version, cleanup } = resolveSource(args.source, args.ref);

try {
  mkdirSync(claudeDir, { recursive: true });
  copyFrameworkOwned(coreDir, claudeDir);
  seedAccumulated(coreDir, claudeDir);
  const claudeMd = mergeClaudeMd(coreDir, claudeDir);
  const settings = writeSettings(coreDir, claudeDir);

  writeFileSync(join(claudeDir, ".gitignore"), GITIGNORE);
  writeFileSync(
    join(claudeDir, ".harness-version"),
    `${version}\nvendored_at: ${stampDate}\n`
  );

  process.stdout.write(
    [
      `[vendor-core] OK — harness ${version} → ${claudeDir}`,
      `  agents/skills/rules: overwritten`,
      `  memory/MEMORY.md, kaizen.md: seeded if absent`,
      `  CLAUDE.md: ${claudeMd}`,
      `  settings.json: ${settings}`,
      `  .gitignore, .harness-version: written`,
      "",
    ].join("\n")
  );
} finally {
  cleanup();
}
