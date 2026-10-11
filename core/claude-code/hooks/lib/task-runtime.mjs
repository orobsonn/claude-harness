/**
 * @description Immutable runtime manifest of a Claude Code task lane. A lane executes the vendored
 * harness of its own worktree (`.claude/hooks`, `.claude/shared`, `settings.json`, agents and the
 * lane prompt). The host hashes those files when it prepares the worktree and the worker re-verifies
 * the hash before every launch, so a lane that altered its own gates cannot be relaunched with them.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const ROOTS = [
  ".claude/hooks",
  ".claude/shared",
  ".claude/agents",
  ".claude/settings.json",
  ".claude/skills/orchestrating-delivery/references/task-runtime.md",
  ".claude/skills/orchestrating-delivery/references/eye-tier.mjs",
  ".claude/skills/creating-plans/references/validate-plan.mjs",
];
export const LANE_LAUNCHER = ".claude/hooks/lib/task-launcher.mjs";

const excluded = (relative) => /\.test\.mjs$/.test(relative) || relative.split("/").includes("__fixtures__");

function collect(root, relative, out) {
  const absolute = path.join(root, relative);
  const info = fs.lstatSync(absolute);
  if (info.isSymbolicLink()) throw new Error(`runtime asset is a symlink: ${relative}`);
  if (info.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) collect(root, path.posix.join(relative, name), out);
  } else if (info.isFile()) {
    if (!excluded(relative)) out.push(relative);
  } else {
    throw new Error(`runtime asset is not a regular file: ${relative}`);
  }
}

/** Hook wiring a lane cannot run without (event → script, all on the "*" matcher). */
const REQUIRED_LANE_HOOKS = [
  ["PreToolUse", "task-gate.mjs"],
  ["PreToolUse", "task-ledger.mjs"],
  ["PostToolUse", "task-ledger.mjs"],
  ["PostToolUseFailure", "task-ledger.mjs"],
];

/**
 * The lane is only safe when its settings wire the lane gate and ledger. vendor-core keeps a
 * consumer's customized hook arrays verbatim, which can leave them out — refuse instead of running
 * an ungated lane.
 */
export function missingLaneHooks(root) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  } catch {
    return REQUIRED_LANE_HOOKS.map(([event, script]) => `${event}:${script}`);
  }
  return REQUIRED_LANE_HOOKS.filter(([event, script]) => !(settings?.hooks?.[event] ?? []).some((group) =>
    (group?.matcher ?? "*") === "*" && (group.hooks ?? []).some((hook) => typeof hook?.command === "string" && hook.command.endsWith(`/.claude/hooks/${script}`))))
    .map(([event, script]) => `${event}:${script}`);
}

/** Hash the lane runtime of a worktree. Throws when an asset is missing or unsafe. */
export function captureTaskRuntime(worktree) {
  const root = fs.realpathSync(worktree);
  const files = [];
  for (const entry of ROOTS) {
    if (!fs.existsSync(path.join(root, entry))) {
      throw new Error(`lane runtime asset missing: ${entry}. Commit the vendored .claude/ harness (claude-harness init) before dispatching parallel tasks.`);
    }
    collect(root, entry, files);
  }
  const missing = missingLaneHooks(root);
  if (missing.length) {
    throw new Error(`the vendored .claude/settings.json does not wire the task lane hooks (${missing.join(", ")}); a customized hooks array was kept by vendor-core — add matcher "*" entries for .claude/hooks/task-gate.mjs and .claude/hooks/task-ledger.mjs, commit, and dispatch again`);
  }
  const hash = createHash("sha256");
  for (const relative of files.sort()) {
    hash.update(relative).update("\0").update(createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex")).update("\n");
  }
  return { version: 1, root, launcher_path: path.join(root, LANE_LAUNCHER), files: files.length, sha256: hash.digest("hex") };
}

/** Re-verify a captured runtime manifest against the files on disk. */
export function verifyTaskRuntime(runtime) {
  try {
    if (!runtime || runtime.version !== 1 || typeof runtime.root !== "string" || !SHA256.test(runtime.sha256 ?? "")) {
      return { ok: false, reason: "task runtime manifest is malformed" };
    }
    const current = captureTaskRuntime(runtime.root);
    if (current.root !== runtime.root || current.sha256 !== runtime.sha256 || current.launcher_path !== runtime.launcher_path) {
      return { ok: false, reason: "task runtime changed since the worktree was prepared" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `task runtime verification failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
