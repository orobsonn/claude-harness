/**
 * @description Prepares the lifecycle-only commit used by the harness-config lane.
 * It deliberately has no product-path input: changed paths come from git and are filtered against
 * the fixed vendor ownership set before a branch, stage, or commit is attempted.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Only used to protect an old install before it has the exact vendor manifest. New lifecycle
// commits MUST use the manifest below; a directory prefix could capture a local plugin.
const LEGACY_OWNED_PREFIXES = [
  ".opencode/agents/",
  ".opencode/command/",
  ".opencode/docs/",
  ".opencode/skills/",
  ".opencode/plugin/",
  ".opencode/tools/",
  ".opencode/hands/",
  ".opencode/rules/",
  ".opencode/lib/",
  ".opencode/shared/",
  ".claude/agents/",
  ".claude/skills/",
  ".claude/rules/",
  ".claude/hooks/",
  ".claude/docs/",
];

const LEGACY_OWNED_FILES = new Set([
  ".opencode/.gitignore",
  ".opencode/.harness-version",
  ".opencode/.harness-config-manifest.json",
  ".opencode/AGENTS.md",
  ".opencode/harness.routing.json",
  ".claude/.gitignore",
  ".claude/.harness-version",
  ".claude/.harness-config-manifest.json",
  ".claude/CLAUDE.md",
  ".claude/settings.json",
  "opencode.json",
  "AGENTS.md",
  "harness.routing.json",
  ".github/ISSUE_TEMPLATE/harness-task.yml",
  ".dev.vars.example",
]);

const COMMIT_MESSAGES = {
  "updating-harness": "chore: sincroniza harness vendored",
  "configuring-model-routing": "chore: reconfigura model routing do harness",
};

/** @param {string} value */
function normalizedPath(value) {
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** @param {string} value */
export function isLifecyclePath(value) {
  const path = normalizedPath(value);
  return LEGACY_OWNED_FILES.has(path) || LEGACY_OWNED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** @param {string[]} paths */
export function selectLifecyclePaths(paths) {
  return paths.map(normalizedPath).filter(isLifecyclePath);
}

/** @param {string[]} paths @param {Set<string>} owned */
export function selectOwnedPaths(paths, owned) {
  return paths.map(normalizedPath).filter((path) => owned.has(path));
}

/** @param {string[]} paths */
export function assertLifecycleOnly(paths) {
  const foreign = paths.map(normalizedPath).filter((path) => !isLifecyclePath(path));
  if (foreign.length > 0) {
    throw new Error(`branch contains paths outside the lifecycle ownership set: ${foreign.join(", ")}`);
  }
}

/** @param {string[]} paths */
export function assertNoPreexistingManagedTrackedPath(paths) {
  const dirty = paths.map(normalizedPath).filter(isLifecyclePath);
  if (dirty.length > 0) {
    throw new Error(`pre-existing tracked change in lifecycle-owned cargo: ${dirty.join(", ")}`);
  }
}

/** @param {string[]} paths @param {Set<string>} owned @param {string} label */
function assertOwnedOnly(paths, owned, label) {
  const foreign = paths.map(normalizedPath).filter((path) => !owned.has(path));
  if (foreign.length > 0) throw new Error(`${label} contains paths outside the vendor ownership manifest: ${foreign.join(", ")}`);
}

/**
 * A completed lifecycle-only branch can be resumed. A product branch cannot, but its uncommitted
 * lifecycle update may still move safely to the default branch for an isolated commit.
 * @param {string[]} branchPaths
 * @param {string[]} workingPaths
 */
export function decideLifecyclePreparation(branchPaths, workingPaths) {
  const paths = selectLifecyclePaths(workingPaths);
  if (branchPaths.length === 0) return { action: "commit", paths };
  if (branchPaths.every(isLifecyclePath) && paths.length === 0) return { action: "resume", paths: branchPaths };
  if (paths.length > 0) return { action: "commit", paths };
  assertLifecycleOnly(branchPaths);
  return { action: "noop", paths: [] };
}

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/** @param {string} output */
function nulPaths(output) {
  return output.split("\0").filter(Boolean).map(normalizedPath);
}

function defaultBranch() {
  git(["fetch", "origin"]);
  const ref = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
  const match = ref.match(/^origin\/(main|master)$/);
  if (!match) throw new Error(`origin/HEAD must name main or master, got ${ref || "none"}`);
  return match[1];
}

/** @param {string} branch */
function existingLifecycleCommit(branch) {
  const changed = nulPaths(git(["diff", "--name-only", "-z", `origin/${branch}...HEAD`]));
  if (changed.length === 0) return null;
  return changed;
}

function currentChangedPaths() {
  const tracked = nulPaths(git(["diff", "--name-only", "-z", "HEAD"]));
  const untracked = nulPaths(git(["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])];
}

function ownershipManifest() {
  const path = ".opencode/.harness-owned-files.json";
  if (!existsSync(path)) throw new Error("missing .opencode/.harness-owned-files.json; re-run the harness update before lifecycle ship");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.files) || parsed.files.some((file) => typeof file !== "string")) {
    throw new Error("invalid .opencode/.harness-owned-files.json");
  }
  return new Set(parsed.files.map(normalizedPath));
}

function assertTrackedCleanOwnershipManifest(operation) {
  const path = ".opencode/.harness-owned-files.json";
  if (operation === "updating-harness") return;
  try {
    git(["ls-files", "--error-unmatch", path]);
    git(["diff", "--quiet", "--", path]);
    git(["diff", "--cached", "--quiet", "--", path]);
  } catch {
    throw new Error("routing requires a tracked, clean .opencode/.harness-owned-files.json");
  }
}

/** @param {string[]} trackedPaths */
export function legacyTrackedOwnership(trackedPaths) {
  return new Set(trackedPaths.map(normalizedPath).filter(isLifecyclePath));
}

function snapshotOwnershipManifest() {
  const path = ".opencode/.harness-owned-files.json";
  if (existsSync(path)) return ownershipManifest();
  return legacyTrackedOwnership(nulPaths(git(["ls-files", "-z"])));
}

/** @param {string} operation */
function baselinePath(operation) {
  return git(["rev-parse", "--git-path", `harness-lifecycle-${operation}.json`]).trim();
}

/** @param {string} operation */
function readBaseline(operation) {
  const path = baselinePath(operation);
  if (!existsSync(path)) throw new Error("missing lifecycle snapshot; run the matching snapshot command before writing");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed.paths)) throw new Error("invalid lifecycle snapshot");
  return { path, paths: new Set(parsed.paths.map(normalizedPath)) };
}

/** @param {"updating-harness" | "configuring-model-routing"} operation */
export function snapshotLifecycleShip(operation) {
  if (!(operation in COMMIT_MESSAGES)) throw new Error(`unsupported lifecycle operation: ${operation}`);
  const owned = snapshotOwnershipManifest();
  const tracked = nulPaths(git(["diff", "--name-only", "-z", "HEAD"]));
  const dirtyOwned = selectOwnedPaths(tracked, owned);
  if (dirtyOwned.length > 0) throw new Error(`pre-existing tracked change in lifecycle-owned cargo: ${dirtyOwned.join(", ")}`);
  const paths = currentChangedPaths();
  const path = baselinePath(operation);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, paths })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return { action: "snapshotted", paths: paths.length };
}

/** @param {"updating-harness" | "configuring-model-routing"} operation */
export function prepareLifecycleShip(operation) {
  const message = COMMIT_MESSAGES[operation];
  if (!message) throw new Error(`unsupported lifecycle operation: ${operation}`);

  const branch = defaultBranch();
  if (git(["rev-parse", branch]).trim() !== git(["rev-parse", `origin/${branch}`]).trim()) {
    throw new Error(`local ${branch} is not equal to origin/${branch}; refusing to branch from local commits`);
  }
  const current = currentChangedPaths();
  if (current.includes("opencode.harness.json")) {
    throw new Error("opencode.harness.json requires manual config repair and is never lifecycle cargo");
  }
  const owned = ownershipManifest();
  const resumedPaths = existingLifecycleCommit(branch) ?? [];
  // A restart may leave unrelated product work in the tree. It is harmless to resume an already
  // committed lifecycle branch, but only if neither the branch nor the working tree has an
  // uncommitted manifest-owned change that could be confused with the prior lifecycle result.
  if (resumedPaths.length > 0 && selectOwnedPaths(current, owned).length === 0) {
    assertOwnedOnly(resumedPaths, owned, "existing lifecycle branch");
    return { action: "resume", branch: git(["branch", "--show-current"]).trim(), paths: resumedPaths };
  }
  const baseline = readBaseline(operation);
  const preexistingOwned = selectOwnedPaths([...baseline.paths], owned);
  if (preexistingOwned.length > 0) {
    throw new Error(`pre-existing tracked change in lifecycle-owned cargo: ${preexistingOwned.join(", ")}`);
  }
  assertTrackedCleanOwnershipManifest(operation);
  const afterSnapshot = current.filter((path) => !baseline.paths.has(path));
  const { paths } = { paths: selectOwnedPaths(afterSnapshot, owned) };
  if (paths.length === 0) return { action: "noop", branch, paths: [] };

  git(["switch", branch]);
  git(["pull", "--ff-only"]);
  const lifecycleBranch = `chore/harness-lifecycle-${operation}-${Date.now()}`;
  git(["switch", "-c", lifecycleBranch]);
  git(["add", "--", ...paths]);
  git(["commit", "--only", "-m", message, "--", ...paths]);

  const committed = nulPaths(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"]));
  assertOwnedOnly(committed, owned, "lifecycle commit");
  renameSync(baseline.path, `${baseline.path}.consumed`);
  return { action: "committed", branch: lifecycleBranch, paths: committed };
}

function main() {
  const [command, operation] = process.argv.slice(2);
  if (!(operation in COMMIT_MESSAGES) || !["snapshot", "prepare"].includes(command)) {
    throw new Error("usage: node .opencode/tools/lifecycle-ship.mjs <snapshot|prepare> <updating-harness|configuring-model-routing>");
  }
  const result = command === "snapshot" ? snapshotLifecycleShip(operation) : prepareLifecycleShip(operation);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) main();
