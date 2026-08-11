/**
 * @description Prepares the lifecycle-only commit used by the harness-config lane.
 * It deliberately has no product-path input: changed paths come from git and are filtered against
 * the exact current vendor ownership set, plus deletions that were exactly owned before the update,
 * before a branch, stage, or commit is attempted.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Old v0.54 installs predate exact ownership manifests. The only deletion they need for this
// migration is the retired controller pair; every newer deletion is proven by its prior manifest.
const PRE_MANIFEST_RETIRED_FILES = new Set([
  ".opencode/plugin/autonomy-controller.ts",
  ".opencode/plugin/lib/autonomy-controller.mjs",
]);

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
 * The first OpenCode session after a vendor update still has the old plugin process in memory.
 * It can therefore not observe a newly added no-CI exception. The bootstrap is deliberately
 * narrower than the normal ship path: only an update commit that this helper has just verified,
 * and only a repository with zero GitHub Actions workflows, may use the GitHub merge API.
 * @param {{ operation: string, committedPaths: string[], owned: Set<string>, workflowCount: unknown }} input
 */
export function shouldBootstrapMergeWithoutCi({ operation, committedPaths, owned, workflowCount }) {
  return operation === "updating-harness" &&
    workflowCount === 0 &&
    committedPaths.length > 0 &&
    committedPaths.every((path) => owned.has(normalizedPath(path)));
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

/** @param {string[]} args */
function gitBuffer(args) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] });
}

/** @param {string} ref @param {string} path */
function refFile(ref, path) {
  try {
    return gitBuffer(["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * A lifecycle PR can be merged from another worktree while this checkout still holds the exact
 * vendor output. That is not divergent work: after staging only byte-identical owned files, a
 * fast-forward consumes it without touching any product path.
 * @param {string} ref
 * @param {string} path
 */
function matchesRefFile(ref, path) {
  const remote = refFile(ref, path);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || remote === null) return false;
    return Buffer.compare(readFileSync(path), remote) === 0;
  } catch (error) {
    if (error?.code === "ENOENT") return remote === null;
    throw error;
  }
}

/** @param {string} branch */
function localBranchIsStrictlyBehind(branch) {
  try {
    git(["merge-base", "--is-ancestor", branch, `origin/${branch}`]);
  } catch {
    return false;
  }
  try {
    git(["merge-base", "--is-ancestor", `origin/${branch}`, branch]);
    return false;
  } catch {
    return true;
  }
}

/**
 * @param {string} branch
 * @param {string[]} paths
 */
function fastForwardAlreadyMergedCargo(branch, paths) {
  if (git(["branch", "--show-current"]).trim() !== branch) return null;
  if (!localBranchIsStrictlyBehind(branch)) return null;
  const remote = `origin/${branch}`;
  if (paths.length === 0 || !paths.every((path) => matchesRefFile(remote, path))) return null;

  const present = paths.filter((path) => existsSync(path));
  const removed = paths.filter((path) => !existsSync(path));
  if (present.length > 0) git(["add", "--", ...present]);
  if (removed.length > 0) git(["add", "-u", "--", ...removed]);
  git(["pull", "--ff-only"]);
  return { action: "already-merged", branch, paths };
}

/** @param {string[]} args */
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Finishes the one backward-compatible no-CI case without asking a stale OpenCode plugin to
 * evaluate a merge command. GitHub remains the authority for rules, approvals and required
 * status checks; any API denial stops the operation and leaves the PR visible.
 * @param {{ operation: string, branch: string, lifecycleBranch: string, committedPaths: string[], owned: Set<string> }} input
 */
function bootstrapMergeWithoutCi({ operation, branch, lifecycleBranch, committedPaths, owned }) {
  let repo;
  let workflowCount;
  try {
    repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    workflowCount = Number(gh(["api", `repos/${repo}/actions/workflows`, "--jq", ".total_count"]));
  } catch {
    return null;
  }
  if (!shouldBootstrapMergeWithoutCi({ operation, committedPaths, owned, workflowCount })) return null;

  const headSha = git(["rev-parse", "HEAD"]).trim();
  let remote = "";
  try {
    remote = git(["ls-remote", "--exit-code", "origin", `refs/heads/${lifecycleBranch}`]).trim();
  } catch {
    // A just-created lifecycle branch is expected not to exist on origin yet.
  }
  const remoteSha = remote.split(/\s+/)[0];
  if (remoteSha && remoteSha !== headSha) {
    throw new Error("lifecycle bootstrap refused: remote branch SHA differs from the verified commit");
  }
  if (!remoteSha) git(["push", "-u", "origin", "HEAD"]);

  const url = gh([
    "pr", "create",
    "--base", branch,
    "--head", lifecycleBranch,
    "--title", COMMIT_MESSAGES[operation],
    "--body", "Lifecycle do harness. Commit verificado pelo manifesto do vendor.",
  ]);
  const pr = JSON.parse(gh(["pr", "view", url, "--json", "number,url,baseRefName,headRefName,headRefOid"]));
  if (
    !Number.isInteger(pr?.number) ||
    pr.baseRefName !== branch ||
    pr.headRefName !== lifecycleBranch ||
    pr.headRefOid !== headSha
  ) {
    throw new Error("lifecycle bootstrap refused: PR identity differs from the verified lifecycle commit");
  }

  const result = JSON.parse(gh([
    "api", "--method", "PUT", `repos/${repo}/pulls/${pr.number}/merge`,
    "-f", `sha=${headSha}`,
    "-f", "merge_method=squash",
  ]));
  if (result?.merged !== true) throw new Error("lifecycle bootstrap merge was not accepted by GitHub");
  git(["switch", branch]);
  git(["pull", "--ff-only"]);
  return { action: "merged", branch, paths: committedPaths, url: pr.url, reason: "old-entry-gate no-CI compatibility" };
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

const OWNERSHIP_MANIFESTS = [
  ".opencode/.harness-owned-files.json",
  ".claude/.harness-owned-files.json",
];

function parseOwnershipManifest(raw, path) {
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !Array.isArray(parsed.files) || parsed.files.some((file) => typeof file !== "string")) {
    throw new Error(`invalid ${path}`);
  }
  if (parsed.retired !== undefined && (!Array.isArray(parsed.retired) || parsed.retired.some((file) => typeof file !== "string"))) {
    throw new Error(`invalid ${path}`);
  }
  return {
    files: parsed.files.map(normalizedPath),
    retired: (parsed.retired ?? []).map(normalizedPath),
  };
}

function readOwnershipManifest(path) {
  return parseOwnershipManifest(readFileSync(path, "utf8"), path).files;
}

function ownershipManifest() {
  const present = OWNERSHIP_MANIFESTS.filter(existsSync);
  if (present.length === 0) throw new Error("missing harness ownership manifest; re-run the harness update before lifecycle ship");
  return new Set(present.flatMap(readOwnershipManifest));
}

/** @description Exact current retirement paths that the vendor declared for this release. */
function vendorDeclaredRetirements() {
  const retired = new Set();
  for (const manifest of OWNERSHIP_MANIFESTS.filter(existsSync)) {
    const parsed = parseOwnershipManifest(readFileSync(manifest, "utf8"), manifest);
    for (const path of parsed.retired) {
      if (PRE_MANIFEST_RETIRED_FILES.has(path)) retired.add(path);
    }
  }
  return retired;
}

/**
 * @description Exact owned paths committed at `ref`. This is one proof for an intentional deletion;
 * the separate pre-manifest bridge is intersected with this release's fixed retirement ledger.
 */
function committedOwnershipManifest(ref) {
  const paths = new Set();
  for (const manifest of OWNERSHIP_MANIFESTS) {
    try {
      const raw = execFileSync("git", ["show", `${ref}:${manifest}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const path of parseOwnershipManifest(raw, manifest).files) paths.add(path);
    } catch {
      // Older installs may not have an exact manifest. Do not infer deletion ownership by prefix.
    }
  }
  return paths;
}

/** @description Exact tracked deletions between `ref` and the current worktree/branch. */
function deletedTrackedPaths(ref) {
  const entries = git(["diff", "--name-status", "-z", "--diff-filter=D", ref]).split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 2) {
    if (entries[index] !== "D" || !entries[index + 1]) return [];
    paths.push(normalizedPath(entries[index + 1]));
  }
  return paths;
}

/** @description Deletions allowed only when the identical path was owned before this update. */
function priorOwnedDeletions(paths, ref) {
  return selectOwnedPaths(paths, committedOwnershipManifest(ref));
}

/**
 * @description First-update bridge for pre-manifest installs. A path must be both deleted and
 * declared by this release's finite vendor ledger; `retired` cannot authorize arbitrary cargo.
 */
export function selectVendorRetiredDeletions(paths, declaredPaths, operation) {
  if (operation !== "updating-harness") return [];
  const declared = new Set([...declaredPaths].map(normalizedPath));
  return paths.map(normalizedPath).filter((path) => PRE_MANIFEST_RETIRED_FILES.has(path) && declared.has(path));
}

function vendorDeclaredRetiredDeletions(paths, operation) {
  return selectVendorRetiredDeletions(paths, vendorDeclaredRetirements(), operation);
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
  const tracked = nulPaths(git(["ls-files", "-z"]));
  const present = OWNERSHIP_MANIFESTS.filter(existsSync);
  if (present.length === 0) return legacyTrackedOwnership(tracked);
  const owned = ownershipManifest();
  // A project updated from a release before the second runtime had an exact manifest still needs
  // protection for that shell during this one transition. The fallback sees tracked legacy paths
  // only; untracked local cargo is never promoted to lifecycle ownership.
  for (const path of tracked) {
    const shell = path.startsWith(".claude/") ? ".claude" : path.startsWith(".opencode/") ? ".opencode" : null;
    if (shell && !existsSync(`${shell}/.harness-owned-files.json`) && isLifecyclePath(path)) owned.add(path);
  }
  return owned;
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
    const deleted = deletedTrackedPaths(`origin/${branch}`);
    const resumedDeletes = [
      ...priorOwnedDeletions(deleted, `origin/${branch}`),
      ...vendorDeclaredRetiredDeletions(deleted, operation),
    ];
    assertOwnedOnly(resumedPaths, new Set([...owned, ...resumedDeletes]), "existing lifecycle branch");
    return { action: "resume", branch: git(["branch", "--show-current"]).trim(), paths: resumedPaths };
  }
  const baseline = readBaseline(operation);
  const preexistingOwned = selectOwnedPaths([...baseline.paths], owned);
  if (preexistingOwned.length > 0) {
    throw new Error(`pre-existing tracked change in lifecycle-owned cargo: ${preexistingOwned.join(", ")}`);
  }
  assertTrackedCleanOwnershipManifest(operation);
  const afterSnapshot = current.filter((path) => !baseline.paths.has(path));
  const deletedAfterSnapshot = new Set(deletedTrackedPaths("HEAD"));
  const deleted = afterSnapshot.filter((path) => deletedAfterSnapshot.has(path));
  const retired = [
    ...priorOwnedDeletions(deleted, "HEAD"),
    ...vendorDeclaredRetiredDeletions(deleted, operation),
  ];
  const allowed = new Set([...owned, ...retired]);
  const { paths } = { paths: [...new Set([...selectOwnedPaths(afterSnapshot, owned), ...retired])] };
  if (paths.length === 0) return { action: "noop", branch, paths: [] };

  git(["switch", branch]);
  git(["pull", "--ff-only"]);
  const lifecycleBranch = `chore/harness-lifecycle-${operation}-${Date.now()}`;
  git(["switch", "-c", lifecycleBranch]);
  git(["add", "--", ...paths]);
  git(["commit", "--only", "-m", message, "--", ...paths]);

  const committed = nulPaths(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"]));
  assertOwnedOnly(committed, allowed, "lifecycle commit");
  renameSync(baseline.path, `${baseline.path}.consumed`);
  const merged = bootstrapMergeWithoutCi({ operation, branch, lifecycleBranch, committedPaths: committed, owned: allowed });
  if (merged) return merged;
  return { action: "committed", branch: lifecycleBranch, paths: committed };
}

/**
 * Automatic recovery for a vendor run that completed before its lifecycle snapshot. The top-level
 * updating-harness invocation authorizes the lifecycle operation;
 * this function contributes the narrow mechanical guarantee: stage only paths named by the
 * current vendor manifest and exact deletions owned by the committed prior manifest, never any
 * product change that happens to share the worktree.
 * @param {"updating-harness"} operation
 */
export function adoptExistingLifecycleShip(operation) {
  if (operation !== "updating-harness") throw new Error("adopt supports only updating-harness");
  const branch = defaultBranch();
  const current = currentChangedPaths();
  const owned = ownershipManifest();
  const deleted = deletedTrackedPaths("HEAD");
  const retired = [
    ...priorOwnedDeletions(deleted, "HEAD"),
    ...vendorDeclaredRetiredDeletions(deleted, operation),
  ];
  const allowed = new Set([...owned, ...retired]);
  const paths = [...new Set([...selectOwnedPaths(current, owned), ...retired])];
  const alreadyMerged = fastForwardAlreadyMergedCargo(branch, paths);
  if (alreadyMerged) return alreadyMerged;
  if (git(["rev-parse", branch]).trim() !== git(["rev-parse", `origin/${branch}`]).trim()) {
    throw new Error(`local ${branch} is not equal to origin/${branch}; refusing to branch from local commits`);
  }
  if (current.includes("opencode.harness.json")) {
    throw new Error("opencode.harness.json requires manual config repair and is never lifecycle cargo");
  }
  if (paths.length === 0) return { action: "noop", branch, paths: [] };

  git(["switch", branch]);
  git(["pull", "--ff-only"]);
  const lifecycleBranch = `chore/harness-lifecycle-${operation}-${Date.now()}`;
  git(["switch", "-c", lifecycleBranch]);
  git(["add", "--", ...paths]);
  git(["commit", "--only", "-m", COMMIT_MESSAGES[operation], "--", ...paths]);

  const committed = nulPaths(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"]));
  assertOwnedOnly(committed, allowed, "lifecycle commit");
  const merged = bootstrapMergeWithoutCi({ operation, branch, lifecycleBranch, committedPaths: committed, owned: allowed });
  if (merged) return merged;
  return { action: "adopted", branch: lifecycleBranch, paths: committed };
}

function main() {
  const [command, operation] = process.argv.slice(2);
  if (!(operation in COMMIT_MESSAGES) || !["snapshot", "prepare", "adopt"].includes(command)) {
    throw new Error("usage: node .opencode/tools/lifecycle-ship.mjs <snapshot|prepare|adopt> <updating-harness|configuring-model-routing>");
  }
  const result = command === "snapshot"
    ? snapshotLifecycleShip(operation)
    : command === "adopt"
      ? adoptExistingLifecycleShip(operation)
      : prepareLifecycleShip(operation);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) main();
