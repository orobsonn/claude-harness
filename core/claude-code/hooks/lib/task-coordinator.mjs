/**
 * @description Host coordination for Claude Code parallel task lanes (port of Pi's
 * task-coordinator.mjs): admission, durable task handles, waiting, exact integration and
 * corrections. Identity (project root, parent session) always comes from the host — the tasks CLI
 * passes `CLAUDE_CODE_SESSION_ID` and the process cwd — never from parameters. There is no
 * scheduler: the parent model picks the batch; this module validates dependencies, scope overlap
 * and the parallel limit, then launches each lane detached. Nothing is ever cleaned up: worktrees,
 * branches and jobs are retained for resume and audit.
 *
 * Extension points (Orca is out of scope here): `deps.prepareWorktree` replaces the local
 * `git worktree add` backend and `deps.startProcess` replaces the local detached launch.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isSafeSessionId, isSafeTaskId } from "../../../shared/lib/feature-id.mjs";
import { acquireLock, LOCK_STALE_MS, releaseLock } from "../../../shared/lib/file-lock.mjs";
import { buildTaskContextHandoff } from "../../../shared/lib/task-context.mjs";
import { availableTaskWorktreeName, hashTaskReceipt, taskScopesOverlap, taskWorktreeName } from "../../../shared/lib/task-contract.mjs";
import { requireCleanTaskWorktree, taskMergePreview } from "../../../shared/lib/task-git.mjs";
import { readTaskProcess, startTaskProcess, taskProcessIdentity, writeTaskJson } from "../../../shared/lib/task-process.mjs";
import { planAndSpec, readParentAuthority, requireParallelPlan } from "./task-admission.mjs";
import { claudeTaskScopeShape, laneTaskScope, pathInScope } from "./task-lane-contract.mjs";
import { inspectTaskRun, readIntegratedTaskEvidence } from "./task-receipts.mjs";
import { taskReconciliationDigest, taskScopeBase } from "./task-reconciliation.mjs";
import { captureTaskRuntime, verifyTaskRuntime } from "./task-runtime.mjs";
import {
  WAIT_MAX_SECONDS,
  featureDir,
  gateStateFile,
  hostTaskLimits,
  isVolatileHarnessPath,
  sharedContextFile,
  taskAdmissionPath,
  taskRegistryPath,
} from "./task-paths.mjs";

const TASK_WORKER = fileURLToPath(new URL("./task-worker.mjs", import.meta.url));
const SHA = /^[a-f0-9]{40}$/;
const LANE_MODELS = new Set(["haiku", "sonnet", "opus"]);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }).trim();
const fail = (reason) => ({ ok: false, reason: `[harness-tasks] ${reason}` });
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const isAncestor = (root, a, b) => {
  try {
    git(root, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
};
const checkScope = (changed, scopes) => changed.filter((file) => !pathInScope(file, scopes));
const scopeOf = (task) => laneTaskScope(task);
function requireClean(root, label = "parent") {
  requireCleanTaskWorktree(root, isVolatileHarnessPath, label);
}

export const TASK_ACTION_FIELDS = Object.freeze({
  dispatch: Object.freeze(["action", "task_ids", "task_contexts"]),
  status: Object.freeze(["action", "task_id", "compact"]),
  wait: Object.freeze(["action", "task_id", "compact", "timeout_seconds"]),
  integrate: Object.freeze(["action", "task_id", "attempt_id", "expected_head"]),
  resume: Object.freeze(["action", "task_id", "attempt_id", "instruction", "reconcile_head"]),
  "abandon-resume": Object.freeze(["action", "task_id", "attempt_id", "expected_head", "no_product_obligation", "reason"]),
});

function admission(context) {
  if (!isSafeSessionId(context.sessionId)) throw new Error("only a classified global parent session may coordinate tasks");
  if (context.isLane) throw new Error("a task lane cannot coordinate tasks");
  const root = fs.realpathSync(context.projectRoot);
  const parent = readParentAuthority({ root, sessionId: context.sessionId });
  return { root, sessionId: context.sessionId, featureId: parent.featureId, mode: parent.mode, approval: parent.approval };
}

function approvedPlan(owner) {
  const artifacts = planAndSpec(owner.root, owner.featureId);
  if (artifacts.planSha256 !== owner.approval.plan_sha256 || artifacts.specSha256 !== owner.approval.spec_sha256) {
    throw new Error("the plan-reviewer APPROVE does not match the current plan/spec");
  }
  const plan = requireParallelPlan(artifacts.plan, owner.featureId);
  for (const task of plan.tasks) scopeOf(task);
  return { plan, directory: featureDir(owner.root, owner.featureId), plan_sha256: artifacts.planSha256, spec_sha256: artifacts.specSha256, receipt: owner.approval };
}

function summary(entry, { compact = false } = {}) {
  const exposesContext = ["ready", "integrated"].includes(entry.status);
  return {
    task_id: entry.task_id,
    attempt_id: entry.attempt_id,
    status: entry.status,
    worktree: entry.worktree,
    branch: entry.branch,
    session_id: entry.result?.session_id,
    child_head: entry.result?.child_head,
    ...(!compact && exposesContext && entry.result?.context_return ? { context_return: entry.result.context_return } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.status !== "integrated" && entry.launches.length >= 6 && (entry.integration_history?.length ?? 0) >= 3
      ? { convergence_attention: {
        launch_count: entry.launches.length,
        correction_count: entry.integration_history.length,
        guidance: "Repeated correction cycle: inspect current findings and applicability before another resume; use the existing exact-attempt recovery only when its host checks pass.",
      } }
      : {}),
    launches: entry.launches.map((launch) => ({ run_id: launch.run_id, pid: launch.pid, events_path: launch.events_path })),
    ...(entry.integration ? { integration: entry.integration } : {}),
    ...(entry.abandoned_resumes?.length ? { abandoned_resumes: entry.abandoned_resumes.map((record) => ({
      reason: record.reason, abandoned_at: record.abandoned_at,
    })) } : {}),
  };
}

/** sha256 of a file at a revision, or null when the path does not exist there. */
function sha256File(root, revision, file) {
  let bytes;
  try {
    bytes = execFileSync("git", ["show", `${revision}:${file}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  return createHash("sha256").update(bytes).digest("hex");
}

/** Frozen blobs of this and every integrated task must survive the merged tree. */
function requireFrozen(root, tree, parentHead, results) {
  const parentBlobs = {};
  for (const [index, { result }] of results.entries()) {
    for (const [file, expected] of Object.entries(result?.frozen_blobs ?? {})) {
      const actual = sha256File(root, tree, file);
      if (actual === expected) continue;
      // A global base merge may have changed a frozen test before this task integrates. The task may
      // carry that parent version through unchanged; it may never supply a different version of its own.
      const parentHash = sha256File(root, parentHead, file);
      const childHash = sha256File(root, result.child_head, file);
      if (actual === null || actual !== parentHash || childHash !== expected) throw new Error(`integration would change frozen test ${file}`);
      if (index === 0) parentBlobs[file] = parentHash;
    }
  }
  return parentBlobs;
}

function receiptFor(entry, head, intent) {
  return {
    version: 1,
    written_by: "host-task-integration",
    parent_session_id: entry.parent_session_id,
    feature_id: entry.feature_id,
    task_id: entry.task_id,
    attempt_id: entry.attempt_id,
    parent_root: entry.parent_root,
    worktree: entry.worktree,
    session_id: entry.result.session_id,
    plan_sha256: entry.plan_sha256,
    spec_sha256: entry.spec_sha256,
    base_sha: entry.base_sha,
    child_head: entry.result.child_head,
    integrated_head: head,
    result_sha256: hashTaskReceipt(entry.result),
    ...(intent.already_ancestral ? { already_ancestral: true } : {}),
    ...(Object.keys(intent.frozen_parent_blobs ?? {}).length ? {
      frozen_parent: { head_sha: intent.parent_head, blobs: intent.frozen_parent_blobs, ...(intent.already_ancestral ? { ancestral: true } : {}) },
    } : {}),
  };
}

function completeCorrectionBarrier(registry, taskId) {
  if (registry.correction_barrier?.task_id !== taskId) return;
  const restored = registry.correction_barrier_stack?.pop();
  if (restored) registry.correction_barrier = restored;
  else delete registry.correction_barrier;
  if (!registry.correction_barrier_stack?.length) delete registry.correction_barrier_stack;
}

/** Finish or abort a journaled integration (crash between merge and receipt, failed pre-merge hook). */
function reconcileMerge(owner, registry, persist) {
  const intent = registry.integration_intent;
  if (!intent) return;
  const entry = registry.tasks[intent.task_id];
  if (!entry || entry.attempt_id !== intent.attempt_id || hashTaskReceipt(entry.result) !== intent.result_sha256) {
    throw new Error("integration journal identity mismatch");
  }
  const current = git(owner.root, "rev-parse", "HEAD");
  let merging;
  try { merging = git(owner.root, "rev-parse", "--verify", "-q", "MERGE_HEAD"); } catch { merging = undefined; }
  if (current === intent.parent_head) {
    if (intent.already_ancestral) {
      if (!isAncestor(owner.root, intent.child_head, current) || git(owner.root, "rev-parse", `${current}^{tree}`) !== intent.tree || merging) {
        throw new Error("ancestral integration journal differs from the parent tree");
      }
      requireClean(owner.root);
      entry.integration = receiptFor(entry, current, intent);
      entry.status = "integrated";
      delete entry.reason;
      delete registry.integration_intent;
      completeCorrectionBarrier(registry, entry.task_id);
      persist();
      return;
    }
    if (merging) {
      const untracked = git(owner.root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).filter((name) => !isVolatileHarnessPath(name));
      if (merging !== intent.child_head || git(owner.root, "write-tree") !== intent.tree || git(owner.root, "diff", "--name-only") || untracked.length) {
        throw new Error("interrupted merge has additional changes; preserve the journal and reconcile this worktree");
      }
      git(owner.root, "merge", "--abort");
    }
    requireClean(owner.root);
    delete registry.integration_intent;
    persist();
    return;
  }
  const parents = git(owner.root, "rev-list", "--parents", "-n", "1", current).split(" ").slice(1);
  if (parents.length !== 2 || parents[0] !== intent.parent_head || parents[1] !== intent.child_head ||
      git(owner.root, "rev-parse", `${current}^{tree}`) !== intent.tree) {
    throw new Error("integration journal needs reconciliation: current HEAD differs from the reserved merge");
  }
  requireClean(owner.root);
  entry.integration = receiptFor(entry, current, intent);
  entry.status = "integrated";
  delete entry.reason;
  delete registry.integration_intent;
  completeCorrectionBarrier(registry, entry.task_id);
  persist();
}

/** Any later correction invalidates the parent's aggregate approval (final review, demo). */
function invalidateAggregate(owner, registry, persist) {
  const file = gateStateFile(owner.root, owner.sessionId);
  let state = {};
  try { state = read(file); } catch { state = {}; }
  const next = { ...state };
  for (const key of ["final_review_done", "demo_done", "final_review_evidence"]) delete next[key];
  writeTaskJson(file, next);
  if (registry.correction_barrier.aggregate_invalidated !== true) {
    registry.correction_barrier.aggregate_invalidated = true;
    persist();
  }
}

function requireTaskIdentity(entry) {
  requireClean(entry.worktree, `task ${entry.task_id}`);
  if (git(entry.worktree, "branch", "--show-current") !== entry.branch || !isAncestor(entry.worktree, entry.base_sha, "HEAD")) {
    throw new Error("reserved task worktree changed identity");
  }
}

function beginConflictMerge(entry) {
  const intent = entry.reconciliation_intent;
  try {
    git(entry.worktree, "merge", "--no-ff", "--no-commit", intent.parent_head);
  } catch (error) {
    let merging;
    try { merging = git(entry.worktree, "rev-parse", "--verify", "-q", "MERGE_HEAD"); } catch { merging = undefined; }
    if (merging !== intent.parent_head) throw error;
  }
  const unresolved = git(entry.worktree, "diff", "--name-only", "--diff-filter=U", "-z").split("\0").filter(Boolean).sort();
  if (JSON.stringify(unresolved) !== JSON.stringify(intent.conflicts)) throw new Error("task conflict merge differs from its preview; preserve worktree and journal");
}

function reconcileDependentMerge(entry, persist, scopes) {
  const intent = entry.reconciliation_intent;
  if (!intent) return;
  const root = entry.worktree;
  if (intent.task_id !== entry.task_id || intent.attempt_id !== entry.attempt_id || git(root, "branch", "--show-current") !== entry.branch) {
    throw new Error("dependent reconciliation journal identity mismatch");
  }
  const head = git(root, "rev-parse", "HEAD");
  if (head === intent.pre_child_head) {
    let merging;
    try { merging = git(root, "rev-parse", "--verify", "-q", "MERGE_HEAD"); } catch { merging = undefined; }
    if (intent.conflicts?.length) {
      if (!merging) {
        requireTaskIdentity(entry);
        beginConflictMerge(entry);
        return;
      }
      if (merging !== intent.parent_head) throw new Error("task conflict merge is missing or changed; preserve the worktree and journal");
      return; // Keep native resolution work across status, restarts and resumes.
    }
    if (merging) {
      const untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).filter((name) => !isVolatileHarnessPath(name));
      if (merging !== intent.parent_head || git(root, "write-tree") !== intent.tree || git(root, "diff", "--name-only") || untracked.length) {
        throw new Error("interrupted dependent merge has additional changes; preserve the journal and reconcile this worktree");
      }
      git(root, "merge", "--abort");
    }
    requireTaskIdentity(entry);
    if (intent.kind === "aggregate-refresh") {
      git(root, "merge", "--no-ff", "--no-edit", "-m", `Reconcile harness aggregate for ${entry.task_id}`, intent.parent_head);
      return reconcileDependentMerge(entry, persist, scopes);
    }
    delete entry.reconciliation_intent;
    persist();
    return;
  }
  requireTaskIdentity(entry);
  const mergedHead = git(root, "rev-list", "--first-parent", "--reverse", `${intent.pre_child_head}..${head}`).split("\n")[0];
  const proof = { ...intent, merged_head: mergedHead };
  const proposed = { ...entry, reconciliations: [...(entry.reconciliations ?? []), proof] };
  delete proposed.reconciliation_intent;
  delete proposed.reconciliation_required;
  taskScopeBase(proposed, root, head, scopes);
  entry.reconciliations = proposed.reconciliations;
  delete entry.reconciliation_intent;
  delete entry.reconciliation_required;
  entry.result = null;
  entry.status = "blocked";
  entry.reason = "dependency correction merged; resume for current capture and reviews";
  persist();
}

async function reconcileDependent(entry, task, owner, registry, persist, deps) {
  if (entry.reconciliation_intent?.conflicts?.length) return;
  if (!entry.reconciliation_required) return;
  requireTaskIdentity(entry);
  requireClean(owner.root);
  const head = git(entry.worktree, "rev-parse", "HEAD");
  if (head !== entry.reconciliation_required.pre_child_head) throw new Error("dependent HEAD changed while upstream correction was pending; preserve and reconcile the worktree");
  const prior = { ...entry };
  delete prior.reconciliation_required;
  const scopes = scopeOf(task);
  const base = taskScopeBase(prior, entry.worktree, head, scopes);
  const changed = git(entry.worktree, "diff", "--name-only", "-z", base, head).split("\0").filter(Boolean);
  if (checkScope(changed, scopes).length) throw new Error("dependent changed paths outside canonical scope before reconciliation");
  const parentHead = git(owner.root, "rev-parse", "HEAD");
  if (!isAncestor(owner.root, base, parentHead)) throw new Error("dependent scope base is not ancestral to parent HEAD");
  const upstreams = [];
  for (const previous of Object.values(entry.reconciliation_required.upstreams ?? {})) {
    const upstream = registry.tasks[previous.task_id];
    if (upstream?.attempt_id !== previous.attempt_id || upstream.status !== "integrated" || !upstream.integration ||
        hashTaskReceipt(upstream.integration) === previous.receipt_sha256 ||
        !upstream.integration_history?.some((receipt) => hashTaskReceipt(receipt) === previous.receipt_sha256) ||
        !isAncestor(owner.root, upstream.integration.integrated_head, parentHead)) {
      throw new Error(`corrected dependency ${previous.task_id} requires a new integrated receipt in current parent ancestry`);
    }
    const checked = await deps.readIntegrated({ projectRoot: owner.root, sessionId: owner.sessionId, featureId: owner.featureId,
      taskId: previous.task_id, headSha: parentHead, reconciliationFor: { task_id: entry.task_id, attempt_id: entry.attempt_id } });
    if (!checked.ok) throw new Error(`corrected dependency ${previous.task_id}: ${checked.reason}`);
    upstreams.push({ task_id: previous.task_id, attempt_id: previous.attempt_id, previous_receipt_sha256: previous.receipt_sha256, receipt: upstream.integration });
  }
  if (!upstreams.length) throw new Error("corrected dependency identity is missing from the recovery request");
  const { tree, conflicts } = taskMergePreview(entry.worktree, head, parentHead);
  const mergedChanges = git(entry.worktree, "diff", "--name-only", "-z", parentHead, tree).split("\0").filter(Boolean);
  if (checkScope([...mergedChanges, ...conflicts], scopes).length) throw new Error("dependent merge changes paths outside canonical scope");
  entry.reconciliation_intent = {
    written_by: "host-task-reconciliation", task_id: entry.task_id, attempt_id: entry.attempt_id,
    scope_base_sha: base, pre_child_head: head, parent_head: parentHead, tree, launch_count: entry.launches.length, upstreams,
    ...(conflicts.length ? { conflicts } : {}),
  };
  persist();
  if (conflicts.length) {
    beginConflictMerge(entry);
    return;
  }
  git(entry.worktree, "merge", "--no-ff", "--no-edit", "-m", `Reconcile harness dependency correction for ${entry.task_id}`, parentHead);
  reconcileDependentMerge(entry, persist, scopes);
  if (entry.reconciliation_required) throw new Error("dependent reconciliation did not produce the reserved merge; preserve the worktree and journal");
}

function prepareIntegrationConflict(entry, task, owner, persist) {
  if (entry.reconciliation_intent || entry.reconciliation_required) return;
  const head = git(entry.worktree, "rev-parse", "HEAD");
  const parentHead = git(owner.root, "rev-parse", "HEAD");
  const preview = taskMergePreview(entry.worktree, head, parentHead);
  if (!preview.conflicts.length) return;
  requireTaskIdentity(entry);
  requireClean(owner.root);
  if (!fs.existsSync(`${entry.grant_path}.claim`)) throw new Error("complete initial task admission before resolving integration conflicts");
  const scopes = scopeOf(task);
  const base = taskScopeBase(entry, entry.worktree, head, scopes);
  const changed = git(entry.worktree, "diff", "--name-only", "-z", parentHead, preview.tree).split("\0").filter(Boolean);
  if (checkScope([...preview.conflicts, ...changed], scopes).length) throw new Error("task merge conflicts outside canonical scope; correct the reviewed plan in a new session");
  entry.reconciliation_intent = {
    written_by: "host-task-reconciliation", kind: "integration-conflict",
    task_id: entry.task_id, attempt_id: entry.attempt_id, scope_base_sha: base,
    pre_child_head: head, parent_head: parentHead, tree: preview.tree,
    conflicts: preview.conflicts, launch_count: entry.launches.length, upstreams: [],
  };
  entry.result = null;
  persist();
  beginConflictMerge(entry);
}

function previewAggregateRefresh(entry, task, owner, params) {
  if (params.reconcile_head === undefined) return null;
  if (!SHA.test(params.reconcile_head) || git(owner.root, "rev-parse", "HEAD") !== params.reconcile_head) {
    throw new Error("reconcile_head must be the exact current committed aggregate HEAD");
  }
  requireTaskIdentity(entry);
  requireClean(owner.root);
  if (entry.reconciliation_intent?.kind === "aggregate-refresh") {
    if (entry.reconciliation_intent.parent_head !== params.reconcile_head) throw new Error("aggregate refresh journal belongs to another HEAD; preserve it and use status");
    return null;
  }
  if (entry.reconciliations?.at(-1)?.kind === "aggregate-refresh" && entry.reconciliations.at(-1).parent_head === params.reconcile_head && !entry.integration) return null;
  if (!entry.integration || entry.reconciliation_required || entry.reconciliation_intent || !params.instruction?.trim()) {
    throw new Error("aggregate refresh requires an integrated task and a concrete correction instruction; finish pending dependency recovery first");
  }
  const head = git(entry.worktree, "rev-parse", "HEAD");
  if (head !== entry.integration.child_head || !isAncestor(owner.root, entry.integration.integrated_head, params.reconcile_head)) {
    throw new Error("aggregate refresh requires the task's exact historical integration in current parent ancestry");
  }
  if (isAncestor(entry.worktree, params.reconcile_head, head)) return null;
  if (!fs.existsSync(`${entry.grant_path}.claim`)) throw new Error("complete initial task admission before aggregate refresh");
  const scopes = scopeOf(task);
  const base = taskScopeBase(entry, entry.worktree, head, scopes);
  const preview = taskMergePreview(entry.worktree, head, params.reconcile_head);
  const changed = git(entry.worktree, "diff", "--name-only", "-z", params.reconcile_head, preview.tree).split("\0").filter(Boolean);
  if (checkScope([...changed, ...preview.conflicts], scopes).length) throw new Error("aggregate refresh changes paths outside canonical task scope");
  return { written_by: "host-task-reconciliation", kind: "aggregate-refresh",
    task_id: entry.task_id, attempt_id: entry.attempt_id, scope_base_sha: base,
    pre_child_head: head, parent_head: params.reconcile_head, tree: preview.tree,
    launch_count: entry.launches.length, upstreams: [],
    source_integration_sha256: hashTaskReceipt(entry.integration),
    ...(preview.conflicts.length ? { conflicts: preview.conflicts } : {}) };
}

function applyAggregateRefresh(entry, intent, task, persist) {
  if (!intent) return;
  entry.reconciliation_intent = intent;
  persist();
  if (intent.conflicts?.length) return beginConflictMerge(entry);
  git(entry.worktree, "merge", "--no-ff", "--no-edit", "-m", `Reconcile harness aggregate for ${entry.task_id}`, intent.parent_head);
  reconcileDependentMerge(entry, persist, scopeOf(task));
}

/** Local backend: worktree + branch at the batch base, plan/spec copies, deps, grant, runtime. */
async function prepareWorktree(entry, artifacts, deps) {
  if (deps.prepareWorktree) {
    await deps.prepareWorktree(entry, artifacts);
  } else if (!fs.existsSync(entry.worktree)) {
    git(entry.parent_root, "worktree", "add", "-b", entry.branch, entry.worktree, entry.base_sha);
  }
  if (git(entry.worktree, "branch", "--show-current") !== entry.branch || !isAncestor(entry.worktree, entry.base_sha, "HEAD")) {
    throw new Error("reserved task worktree changed identity");
  }
  const target = featureDir(entry.worktree, entry.feature_id);
  fs.mkdirSync(target, { recursive: true });
  for (const name of ["execution-plan.json", "spec.md"]) fs.copyFileSync(path.join(artifacts.directory, name), path.join(target, name));
  // Dependencies are copied, never symlinked: test/build caches stay local to each task.
  const modules = path.join(entry.parent_root, "node_modules");
  if (fs.existsSync(modules) && !fs.existsSync(path.join(entry.worktree, "node_modules"))) {
    fs.cpSync(modules, path.join(entry.worktree, "node_modules"), { recursive: true, verbatimSymlinks: true });
  }
  if (!fs.existsSync(entry.grant_path)) writeTaskJson(entry.grant_path, entry.grant);
  if (!entry.runtime) {
    entry.runtime = deps.captureRuntime(entry.worktree);
    return;
  }
  const checked = deps.verifyRuntime(entry.runtime);
  if (checked.ok) return;
  // A host merge may legitimately bring the parent's harness into the worktree. Accept the new
  // runtime only when it is byte-identical to the parent's current harness; a lane-edited harness
  // never matches and is refused before any launch.
  const current = deps.captureRuntime(entry.worktree);
  const parent = deps.captureRuntime(entry.parent_root);
  if (current.sha256 !== parent.sha256) throw new Error(`${checked.reason}; the worktree harness differs from the parent's installed harness`);
  entry.runtime = current;
}

const DEFAULT_PROMPT = "Execute the admitted task with the task pipeline: native TDD, the applicable task reviewers and a current capture. Return only after the task is ready for host integration.";

function launchPrompt(entry, instruction) {
  const feedback = instruction || DEFAULT_PROMPT;
  const conflict = entry.reconciliation_intent;
  const reconciliation = entry.reconciliations?.at(-1);
  if (conflict?.conflicts?.length) {
    return `The host has already started the task merge with parent ${conflict.parent_head}. Resolve the existing conflicts in ${conflict.conflicts.join(", ")} through the sniper in this same task. Preserve both the task correction and the parent's already integrated behavior. Do not start another merge, rebase or cherry-pick. Resolve only the listed conflicts, stage those paths and commit the existing merge; clean merged paths are already staged. Do not edit unrelated paths in that merge commit. Then run the tests, capture-verified and the affected reviewers on the resolved HEAD. Any further product fix uses a separate ordinary fix commit. Preserve frozen tests and valid unaffected evidence. This merge is not approval.\n\nBehavioral feedback:\n${feedback}`;
  }
  if (reconciliation) {
    return `The host merged a ${reconciliation.kind === "aggregate-refresh" ? "delivery aggregate refresh" : "dependency correction"} at ${reconciliation.merged_head}; dependency integration is already complete. Preserve the original task, scope and frozen tests. Before choosing a hand, compare the current HEAD, capture and producer evidence. If they already prove the reconciled implementation and no product delta is requested, do not dispatch the executor or sniper just for freshness; resolve only the affected test/evidence obligations. A real product finding requires the appropriate hand, commit, capture and affected eyes. Preserve valid unaffected reviews.\n\nBehavioral feedback:\n${feedback}\n\nDependency integration remains host-owned. Never merge, rebase or cherry-pick in the lane.`;
  }
  return feedback;
}

function resolveClaudeBin(deps) {
  const candidate = deps.claudeBin ?? process.env.CLAUDE_HARNESS_CLAUDE_BIN;
  if (candidate !== undefined) {
    if (!path.isAbsolute(candidate) || !fs.statSync(candidate).isFile()) throw new Error("CLAUDE_HARNESS_CLAUDE_BIN must be an absolute path to the claude executable");
    return candidate;
  }
  for (const dir of String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, "claude");
    try {
      if (fs.statSync(file).isFile()) return fs.realpathSync(file);
    } catch { /* keep looking */ }
  }
  throw new Error("the claude CLI was not found on PATH; install Claude Code or set CLAUDE_HARNESS_CLAUDE_BIN");
}

async function launchTask(entry, persist, deps, instruction) {
  const runId = randomUUID();
  const jobDir = path.join(entry.job_dir, runId);
  const launch = {
    run_id: runId,
    pid: null,
    runtime: entry.runtime,
    creator_pid: process.pid,
    creator_start_ticks: taskProcessIdentity(process.pid)?.start,
    worker_path: TASK_WORKER,
    descriptor_path: path.join(jobDir, "job.json"),
    events_path: path.join(jobDir, "events.jsonl"),
    process_path: path.join(jobDir, "process.json"),
    result_path: path.join(jobDir, "result.json"),
    descendants_path: path.join(jobDir, "descendants.json"),
  };
  let localSession;
  if (fs.existsSync(`${entry.grant_path}.claim`)) localSession = read(`${entry.grant_path}.claim`).session_id;
  if (localSession !== undefined && !isSafeSessionId(localSession)) throw new Error("task session claim is invalid");
  const laneModel = deps.laneModel ?? process.env.CLAUDE_HARNESS_LANE_MODEL ?? "sonnet";
  if (!LANE_MODELS.has(laneModel)) throw new Error("CLAUDE_HARNESS_LANE_MODEL must be haiku, sonnet or opus");
  const args = [
    entry.runtime.launcher_path,
    "--grant", entry.grant_path,
    ...(localSession ? ["--resume", localSession] : []),
    "--claude", resolveClaudeBin(deps),
    "--model", laneModel,
    "--prompt", launchPrompt(entry, instruction),
  ];
  entry.launches.push(launch);
  entry.status = "running";
  entry.result = null;
  entry.integration = null;
  delete entry.reason;
  persist();
  try {
    const handle = await deps.startProcess({
      workerPath: TASK_WORKER,
      jobDir,
      runId,
      cwd: entry.worktree,
      command: process.execPath,
      args,
      runtime: entry.runtime,
      timeoutMs: deps.limits.timeoutMs,
      trackDescendants: true,
    });
    Object.assign(launch, handle);
    persist();
  } catch (error) {
    if (error.task_launch) Object.assign(launch, error.task_launch);
    if (error.before_spawn === true) launch.start_failure = { written_by: "host-task-launch", reason: error.message, at: new Date().toISOString() };
    entry.status = "blocked";
    entry.reason = `task launch failed: ${error.message}`;
    persist();
    throw error;
  }
}

function descendants(plan, taskId) {
  const ids = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of plan.tasks) {
      if (!ids.has(task.id) && task.depends_on.some((id) => ids.has(id))) {
        ids.add(task.id);
        changed = true;
      }
    }
  }
  ids.delete(taskId);
  return [...ids];
}

function validateParams(params) {
  if (!params || typeof params !== "object" || !Object.hasOwn(TASK_ACTION_FIELDS, params.action)) throw new Error("unknown task action");
  if (params.action !== "dispatch" && params.task_ids !== undefined) throw new Error(`task_ids is only valid for dispatch; use task_id for ${params.action}`);
  if (params.action === "dispatch" && params.task_id !== undefined) throw new Error("task_id is not valid for dispatch; use task_ids");
  const allowed = TASK_ACTION_FIELDS[params.action];
  if (Object.keys(params).some((key) => !allowed.includes(key))) throw new Error(`unexpected task parameters for ${params.action}; allowed: ${allowed.join(", ")}`);
  if (params.task_id !== undefined && !isSafeTaskId(params.task_id)) throw new Error("safe task_id required");
  if (params.compact !== undefined && typeof params.compact !== "boolean") throw new Error("compact must be boolean");
}

/**
 * Run one task action under the registry lock. `context` = { projectRoot, sessionId, isLane };
 * `injected` replaces host seams in tests.
 */
export async function executeTaskAction(params, context = {}, injected = {}) {
  let lock;
  let registryPath;
  try {
    validateParams(params);
    if (params.action === "wait") throw new Error("wait is a host loop; use waitForTasks");
    const owner = admission(context);
    registryPath = taskRegistryPath(owner.root, owner.sessionId);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    lock = acquireLock(registryPath, { timeoutMs: 5, staleMs: LOCK_STALE_MS });
    if (!lock.ok) throw new Error("task coordinator busy; observe or retry the same action");
    let registry = fs.existsSync(registryPath) ? read(registryPath) : null;
    if (registry && (registry.version !== 1 || registry.parent_session_id !== owner.sessionId || registry.feature_id !== owner.featureId || !registry.tasks)) {
      throw new Error("task registry identity mismatch");
    }
    const persist = () => {
      registry.revision = (registry.revision ?? 0) + 1;
      writeTaskJson(registryPath, registry);
    };
    const deps = {
      startProcess: startTaskProcess,
      readProcess: readTaskProcess,
      captureRuntime: captureTaskRuntime,
      verifyRuntime: verifyTaskRuntime,
      inspectRun: (entry) => inspectTaskRun(entry),
      readIntegrated: (input) => readIntegratedTaskEvidence(input),
      inspectAbandonment: inspectTaskResumeAbandonment,
      limits: hostTaskLimits(),
      ...injected,
    };
    if (registry?.correction_barrier) invalidateAggregate(owner, registry, persist);
    if (registry) reconcileMerge(owner, registry, persist);
    if (registry) {
      for (const entry of Object.values(registry.tasks)) {
        if (!entry.reconciliation_intent) continue;
        if (entry.launches.some((launch) => !deps.readProcess(launch).terminal)) {
          if (entry.reconciliation_intent.conflicts?.length) continue;
          throw new Error("dependent process must terminate before reconciliation");
        }
        const task = approvedPlan(owner).plan.tasks.find((item) => item.id === entry.task_id);
        reconcileDependentMerge(entry, persist, scopeOf(task));
      }
    }
    if (params.action === "status") {
      if (!registry) return { ok: true, tasks: [], max_parallel_tasks: deps.limits.maxParallel };
      const entries = params.task_id ? [registry.tasks[params.task_id]] : Object.values(registry.tasks);
      if (entries.some((entry) => !entry)) throw new Error("unknown task");
      const diagnostics = {};
      for (const entry of entries) {
        if (entry.status === "integrated") continue;
        if (entry.reconciliation_intent?.conflicts?.length && entry.launches.every((launch) => deps.readProcess(launch).terminal)) {
          entry.status = "blocked";
          entry.reason = `merge conflicts require resolution in the same task; use resume: ${entry.reconciliation_intent.conflicts.join(", ")}`;
          continue;
        }
        if (entry.reconciliation_required && !entry.reconciliation_intent?.conflicts?.length) {
          entry.status = "blocked";
          entry.reason = `dependency correction (${Object.keys(entry.reconciliation_required.upstreams ?? {}).join(", ")}) requires reconciliation; integrate the corrected owner, then resume this dependent for current capture and reviews`;
          continue;
        }
        if (entry.launches.length === 0) {
          entry.status = "blocked";
          entry.reason = entry.reason ?? "reserved task has not started; resume this attempt";
          continue;
        }
        const lifecycle = entry.launches.map((launch) => deps.readProcess(launch));
        if (lifecycle.some((state) => !state.terminal)) {
          entry.status = "running";
          entry.reason = lifecycle.find((state) => !state.ok)?.reason;
          if (!entry.reason) delete entry.reason;
          continue;
        }
        const inspected = await deps.inspectRun(entry);
        if (inspected.ok) {
          entry.result = inspected.result;
          entry.status = "ready";
          delete entry.reason;
        } else {
          entry.status = "blocked";
          entry.reason = inspected.reason;
          if (inspected.details && typeof inspected.details === "object") {
            const current = {};
            if (inspected.details.context_return !== undefined && !params.compact) current.context_return = inspected.details.context_return;
            for (const field of ["review_findings", "task_report", "hand_report", "launch_failure", "worktree_changes"]) {
              if (inspected.details[field] !== undefined) current[field] = inspected.details[field];
            }
            if (Object.keys(current).length) diagnostics[entry.task_id] = current;
          }
        }
      }
      persist();
      return {
        ok: true,
        tasks: entries.map((entry) => summary(entry, { compact: params.compact === true })),
        ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
        max_parallel_tasks: deps.limits.maxParallel,
      };
    }
    const artifacts = approvedPlan(owner);
    if (!registry) {
      registry = { version: 1, parent_session_id: owner.sessionId, feature_id: owner.featureId,
        plan_sha256: artifacts.plan_sha256, spec_sha256: artifacts.spec_sha256, tasks: {} };
    }
    if (registry.plan_sha256 !== artifacts.plan_sha256 || registry.spec_sha256 !== artifacts.spec_sha256) {
      throw new Error("canonical plan/spec changed after task admission; a real plan change needs a new session");
    }
    const barrierTaskId = registry.correction_barrier?.task_id;
    const nestedOwnerRecovery = barrierTaskId && params.action === "resume" && params.task_id !== barrierTaskId &&
      registry.tasks[params.task_id]?.integration && descendants(artifacts.plan, params.task_id).includes(barrierTaskId);
    const idempotentIntegratedRetry = params.action === "integrate" && registry.tasks[params.task_id]?.status === "integrated" &&
      registry.tasks[params.task_id]?.integration?.child_head === params.expected_head;
    if (registry.correction_barrier && (params.action === "dispatch" || (params.task_id !== barrierTaskId && !nestedOwnerRecovery && !idempotentIntegratedRetry))) {
      throw new Error(`Correction of ${registry.correction_barrier.task_id} owns the aggregate correction barrier and must be integrated before another task can mutate or resume. Use status/wait for read-only observation; then integrate that exact attempt first.`);
    }
    if (params.action === "dispatch") {
      const limit = deps.limits.maxParallel;
      if (!Array.isArray(params.task_ids) || params.task_ids.length === 0 || params.task_ids.length > limit ||
          new Set(params.task_ids).size !== params.task_ids.length || params.task_ids.some((id) => !isSafeTaskId(id))) {
        throw new Error(`dispatch requires one to ${limit} distinct safe task_ids`);
      }
      const requested = params.task_ids.map((id) => artifacts.plan.tasks.find((task) => task.id === id));
      if (requested.some((task) => !task)) throw new Error("unknown task");
      const contexts = new Map();
      if (params.task_contexts !== undefined) {
        if (!Array.isArray(params.task_contexts) || params.task_contexts.length > requested.length) {
          throw new Error("task_contexts must contain at most one curated brief per requested task");
        }
        for (const item of params.task_contexts) {
          if (!item || typeof item !== "object" || Object.keys(item).some((key) => !["task_id", "content"].includes(key)) ||
              !params.task_ids.includes(item.task_id) || contexts.has(item.task_id)) {
            throw new Error("each task context must identify one requested task exactly once");
          }
          const snapshot = buildTaskContextHandoff({
            parentSessionId: owner.sessionId, taskId: item.task_id, content: item.content,
            readSharedContext: () => (fs.existsSync(sharedContextFile(owner.root, owner.featureId)) ? fs.readFileSync(sharedContextFile(owner.root, owner.featureId), "utf8") : null),
          });
          const existing = registry.tasks[item.task_id];
          if (existing && existing.grant.context_handoff?.content_sha256 !== snapshot.content_sha256) {
            throw new Error("admitted task context is immutable; use bounded resume feedback for corrections");
          }
          contexts.set(item.task_id, snapshot);
        }
      }
      const fresh = requested.filter((task) => !registry.tasks[task.id]);
      if (!fresh.length) return { ok: true, tasks: requested.map((task) => summary(registry.tasks[task.id])) };
      requireClean(owner.root);
      const base = git(owner.root, "rev-parse", "HEAD");
      const outstanding = Object.values(registry.tasks).filter((entry) => entry.status !== "integrated");
      if (outstanding.filter((entry) => ["running", "preparing"].includes(entry.status)).length + fresh.length > limit) {
        throw new Error("parallel task limit reached; observe existing handles");
      }
      for (const task of fresh) {
        for (const depId of task.depends_on) {
          const dep = registry.tasks[depId];
          if (dep?.status !== "integrated" || !isAncestor(owner.root, dep.integration?.integrated_head, base)) {
            throw new Error(`dependency ${depId} must be integrated before ${task.id}`);
          }
          const checked = await deps.readIntegrated({ projectRoot: owner.root, sessionId: owner.sessionId, featureId: owner.featureId, taskId: depId, headSha: base });
          if (!checked.ok) throw new Error(checked.reason);
        }
        const others = [
          ...outstanding.map((entry) => artifacts.plan.tasks.find((item) => item.id === entry.task_id)),
          ...fresh.filter((item) => item.id !== task.id),
        ];
        if (others.some((other) => taskScopesOverlap(claudeTaskScopeShape(task), claudeTaskScopeShape(other)))) {
          throw new Error(`task ${task.id} overlaps another unintegrated task, test or fixture`);
        }
      }
      const runsDir = path.dirname(registryPath);
      const taken = new Set(Object.values(registry.tasks).map((entry) => entry.worktree_name));
      for (const task of fresh) {
        const attemptId = randomUUID();
        const worktreeName = availableTaskWorktreeName(taskWorktreeName(task, artifacts.plan.tasks.indexOf(task) + 1),
          (name) => taken.has(name) || fs.existsSync(path.join(runsDir, "worktrees", name)));
        taken.add(worktreeName);
        const worktree = path.join(runsDir, "worktrees", worktreeName);
        const branch = `harness/task-${task.id}-${attemptId}`;
        const grant = {
          version: 1,
          kind: "task-run",
          parent_session_id: owner.sessionId,
          parent_root: owner.root,
          attempt_id: attemptId,
          feature_id: owner.featureId,
          task_id: task.id,
          cwd: worktree,
          branch,
          base_sha: base,
          mode: artifacts.plan.mode.toUpperCase(),
          plan_sha256: artifacts.plan_sha256,
          spec_sha256: artifacts.spec_sha256,
          ...(contexts.has(task.id) ? { context_handoff: contexts.get(task.id) } : {}),
          origin: { kind: "parent-approved-plan", plan_review_call_id: artifacts.receipt.dispatch_call_id },
          dependencies: task.depends_on.map((taskId) => {
            const receipt = registry.tasks[taskId].integration;
            return { task_id: taskId, child_head: receipt.child_head, integrated_head: receipt.integrated_head, receipt_sha256: hashTaskReceipt(receipt), receipt };
          }),
        };
        registry.tasks[task.id] = {
          task_id: task.id,
          attempt_id: attemptId,
          parent_session_id: owner.sessionId,
          parent_root: owner.root,
          feature_id: owner.featureId,
          plan_sha256: artifacts.plan_sha256,
          spec_sha256: artifacts.spec_sha256,
          base_sha: base,
          worktree_name: worktreeName,
          worktree,
          branch,
          grant_path: taskAdmissionPath(worktree, attemptId),
          grant,
          job_dir: path.join(runsDir, "jobs", attemptId),
          status: "preparing",
          launches: [],
          result: null,
          integration: null,
        };
      }
      persist();
      for (const task of fresh) {
        const entry = registry.tasks[task.id];
        try {
          await prepareWorktree(entry, artifacts, deps);
          // Canonical paths: the grant and every receipt name the real worktree path.
          const real = fs.realpathSync(entry.worktree);
          if (real !== entry.worktree) {
            entry.worktree = real;
            entry.grant = { ...entry.grant, cwd: real };
            entry.grant_path = taskAdmissionPath(real, entry.attempt_id);
            writeTaskJson(entry.grant_path, entry.grant);
          }
          persist();
          await launchTask(entry, persist, deps);
        } catch (error) {
          entry.status = "blocked";
          entry.reason = error.message;
          persist();
        }
      }
      return { ok: true, tasks: requested.map((task) => summary(registry.tasks[task.id])) };
    }
    const entry = registry.tasks[params.task_id];
    if (!entry || params.attempt_id !== entry.attempt_id) throw new Error("exact current task and attempt required");
    if (params.action === "abandon-resume") {
      if (params.no_product_obligation !== true || typeof params.reason !== "string" || !params.reason.trim() || params.reason.length > 4000) {
        throw new Error("explicit no_product_obligation declaration and a bounded reason required");
      }
      if (entry.integration || registry.correction_barrier?.task_id !== entry.task_id || registry.correction_barrier.attempt_id !== entry.attempt_id) {
        throw new Error("only the current pending integrated-task correction can be abandoned");
      }
      if (!SHA.test(params.expected_head ?? "") || git(entry.worktree, "rev-parse", "HEAD") !== params.expected_head) {
        throw new Error("exact unchanged task expected_head required");
      }
      if (entry.launches.some((launch) => !deps.readProcess(launch).terminal)) throw new Error("task processes must terminate before abandoning a resume");
      if (Object.values(registry.tasks).some((task) => task.reconciliation_required?.upstreams?.[entry.task_id])) {
        throw new Error("dependent corrections must be reconciled through ordinary task recovery");
      }
      requireTaskIdentity(entry);
      requireClean(owner.root);
      const checked = deps.inspectAbandonment(entry, { parentHead: git(owner.root, "rev-parse", "HEAD") });
      if (!checked.ok) throw new Error(checked.reason);
      (entry.abandoned_resumes ??= []).push({
        written_by: "host-task-resume-abandonment", no_product_obligation: true,
        reason: params.reason.trim(), abandoned_at: new Date().toISOString(), proof: checked.proof,
      });
      entry.integration = checked.integration;
      entry.result = checked.result;
      entry.status = "integrated";
      delete entry.reason;
      completeCorrectionBarrier(registry, entry.task_id);
      // No launch, hand, review or prior receipt is removed or rewritten; aggregate approval stays invalidated.
      persist();
      return { ok: true, tasks: [summary(entry)] };
    }
    if (params.action === "resume") {
      if (params.instruction !== undefined && (typeof params.instruction !== "string" || !params.instruction.trim() || params.instruction.length > 16000)) {
        throw new Error("resume instruction must contain at most 16000 characters");
      }
      if (entry.launches.some((launch) => !deps.readProcess(launch).terminal)) throw new Error("task is still running; use status or wait to observe it before resume");
      const task = artifacts.plan.tasks.find((item) => item.id === entry.task_id);
      const aggregateRefresh = previewAggregateRefresh(entry, task, owner, params);
      const affected = descendants(artifacts.plan, entry.task_id).filter((id) => registry.tasks[id]);
      const pending = affected.filter((id) => registry.tasks[id].status !== "integrated");
      for (const id of affected) {
        const dependent = registry.tasks[id];
        if (dependent.launches.some((launch) => !deps.readProcess(launch).terminal)) throw new Error(`dependent ${id} process group must terminate before correcting this task`);
        if (pending.includes(id)) {
          requireTaskIdentity(dependent);
          if (!fs.existsSync(`${dependent.grant_path}.claim`)) throw new Error(`dependent ${id} must complete initial admission before upstream correction; resume it first`);
        }
      }
      if (pending.length && !entry.integration && registry.correction_barrier?.task_id !== entry.task_id) throw new Error("only an integrated ancestor can start a dependent correction");
      if (entry.integration) {
        const head = git(entry.worktree, "rev-parse", "HEAD");
        for (const upstream of Object.values(registry.tasks)) {
          if (upstream.status !== "integrated" || !upstream.integration || !descendants(artifacts.plan, upstream.task_id).includes(entry.task_id) ||
              isAncestor(entry.worktree, upstream.integration.integrated_head, head)) continue;
          const previous = upstream.integration_history?.findLast((receipt) => isAncestor(entry.worktree, receipt.integrated_head, head));
          if (!previous) throw new Error(`corrected dependency ${upstream.task_id} lacks the dependent's prior integration receipt`);
          requireTaskIdentity(entry);
          entry.reconciliation_required ??= { pre_child_head: head, upstreams: {} };
          entry.reconciliation_required.upstreams[upstream.task_id] ??= { task_id: upstream.task_id, attempt_id: upstream.attempt_id, receipt_sha256: hashTaskReceipt(previous) };
        }
        for (const id of pending) {
          const dependent = registry.tasks[id];
          dependent.reconciliation_required ??= { pre_child_head: git(dependent.worktree, "rev-parse", "HEAD"), upstreams: {} };
          dependent.reconciliation_required.upstreams[entry.task_id] ??= { task_id: entry.task_id, attempt_id: entry.attempt_id, receipt_sha256: hashTaskReceipt(entry.integration) };
          if (dependent.result) {
            dependent.result_history ??= {};
            dependent.result_history[hashTaskReceipt(dependent.result)] = dependent.result;
          }
          dependent.result = null;
          dependent.status = "blocked";
          dependent.reason = `dependency ${entry.task_id} is being corrected; resume this task after reintegration`;
        }
        entry.integration_history ??= [];
        entry.integration_history.push(entry.integration);
        entry.result_history ??= {};
        entry.result_history[entry.integration.result_sha256] = entry.result;
        if (registry.correction_barrier && registry.correction_barrier.task_id !== entry.task_id) (registry.correction_barrier_stack ??= []).push(registry.correction_barrier);
        registry.correction_barrier = { task_id: entry.task_id, attempt_id: entry.attempt_id, aggregate_invalidated: false };
        entry.integration = null;
        entry.result = null;
        entry.status = "blocked";
        if (aggregateRefresh) entry.reconciliation_intent = aggregateRefresh;
        persist();
        invalidateAggregate(owner, registry, persist);
      }
      applyAggregateRefresh(entry, aggregateRefresh, task, persist);
      await reconcileDependent(entry, task, owner, registry, persist, deps);
      prepareIntegrationConflict(entry, task, owner, persist);
      await prepareWorktree(entry, artifacts, deps);
      await launchTask(entry, persist, deps, params.instruction);
      return { ok: true, tasks: [summary(entry)] };
    }
    // integrate
    if (!SHA.test(params.expected_head ?? "")) throw new Error("exact expected_head commit required");
    if (entry.status === "integrated") {
      if (entry.integration.child_head !== params.expected_head) throw new Error("integrated task HEAD differs from expected_head");
      return { ok: true, tasks: [summary(entry)] };
    }
    const checkedRuntime = deps.verifyRuntime(entry.runtime);
    if (!checkedRuntime.ok) throw new Error(checkedRuntime.reason);
    if (!isAncestor(entry.worktree, entry.base_sha, params.expected_head)) throw new Error("verified task HEAD differs from expected_head (not a commit of this task)");
    taskScopeBase(entry, entry.worktree, params.expected_head);
    if (entry.launches.some((launch) => !deps.readProcess(launch).terminal)) throw new Error("task is still running; wait before integrating");
    const inspected = await deps.inspectRun(entry);
    if (!inspected.ok) throw new Error(inspected.reason);
    if (inspected.result.child_head !== params.expected_head) throw new Error("verified task HEAD differs from expected_head");
    entry.result = inspected.result;
    requireClean(owner.root);
    const parentHead = git(owner.root, "rev-parse", "HEAD");
    if (!isAncestor(owner.root, entry.base_sha, parentHead)) throw new Error("task base is no longer an ancestor of parent HEAD");
    const alreadyAncestral = isAncestor(owner.root, params.expected_head, parentHead);
    const { tree, conflicts } = alreadyAncestral
      ? { tree: git(owner.root, "rev-parse", `${parentHead}^{tree}`), conflicts: [] }
      : taskMergePreview(owner.root, parentHead, params.expected_head);
    if (conflicts.length) throw new Error(`task merge conflicts in ${conflicts.join(", ")}; use resume on this same task/attempt to resolve with the sniper, capture and affected reviews`);
    const frozenParentBlobs = requireFrozen(owner.root, tree, parentHead, [
      { result: entry.result },
      ...Object.values(registry.tasks).filter((item) => item.status === "integrated").map((item) => ({ result: item.result })),
    ]);
    registry.integration_intent = {
      task_id: entry.task_id,
      attempt_id: entry.attempt_id,
      parent_head: parentHead,
      child_head: params.expected_head,
      tree,
      result_sha256: hashTaskReceipt(entry.result),
      ...(Object.keys(frozenParentBlobs).length ? { frozen_parent_blobs: frozenParentBlobs } : {}),
      ...(alreadyAncestral ? { already_ancestral: true } : {}),
    };
    persist();
    if (!alreadyAncestral) {
      git(owner.root, "merge", "--no-ff", "--no-edit", "-m", `Integrate harness task ${entry.task_id} (${entry.attempt_id})`, params.expected_head);
    }
    reconcileMerge(owner, registry, persist);
    return { ok: true, tasks: [summary(entry)] };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    if (lock?.ok) releaseLock(registryPath, lock.token);
  }
}

/**
 * Prove an abandoned correction produced no delta: the worktree still sits at the task's last
 * integrated child HEAD, clean, and that historical receipt is still valid in the parent.
 */
export function inspectTaskResumeAbandonment(entry, { parentHead } = {}) {
  try {
    const integration = Array.isArray(entry?.integration_history) ? entry.integration_history.at(-1) : null;
    const result = integration ? entry.result_history?.[integration.result_sha256] : null;
    if (!integration || !result || hashTaskReceipt(result) !== integration.result_sha256) return fail("abandoning a resume requires the task's previous integration and result");
    const head = git(entry.worktree, "rev-parse", "HEAD");
    if (head !== integration.child_head) return fail("the abandoned correction changed the task HEAD; integrate it through ordinary recovery instead");
    if (!SHA.test(parentHead ?? "") || !isAncestor(entry.parent_root, integration.integrated_head, parentHead)) return fail("the previous integration is not ancestral to the parent HEAD");
    return {
      ok: true,
      integration,
      result,
      proof: { parent_head: parentHead, child_head: head, launch_count: entry.launches.length, inspected_launch_count: result.launches?.length ?? 0,
        integration_sha256: hashTaskReceipt(integration), reconciliation_sha256: taskReconciliationDigest(entry) },
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const pause = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener?.("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * Block on the host (no model calls) until a running task changes, nothing runs, the window
 * expires or the caller aborts. Never kills a task. Returns `settled|changed|timeout|aborted`.
 */
export async function waitForTasks(params, context = {}, injected = {}) {
  try {
    validateParams(params);
    if (params.action !== "wait") throw new Error("waitForTasks needs action wait");
    const window = params.timeout_seconds ?? WAIT_MAX_SECONDS;
    if (!Number.isInteger(window) || window < 1 || window > WAIT_MAX_SECONDS) throw new Error(`timeout_seconds must be an integer between 1 and ${WAIT_MAX_SECONDS}`);
    const signal = injected.signal;
    const pollMs = injected.pollMs ?? 5000;
    const now = injected.now ?? Date.now;
    const deadline = now() + window * 1000;
    const statusParams = { action: "status", ...(params.task_id ? { task_id: params.task_id } : {}), ...(params.compact !== undefined ? { compact: params.compact } : {}) };
    const fingerprint = (result) => JSON.stringify(result.tasks.map((task) => [task.task_id, task.status, task.launches.at(-1)?.run_id ?? null]));
    const first = await executeTaskAction(statusParams, context, injected);
    if (!first.ok) return first;
    if (!first.tasks.some((task) => task.status === "running")) return { ...first, wait: "settled" };
    const before = fingerprint(first);
    let latest = first;
    while (true) {
      if (signal?.aborted) return { ...latest, wait: "aborted" };
      if (now() >= deadline) return { ...latest, wait: "timeout" };
      await pause(Math.min(pollMs, Math.max(1, deadline - now())), signal);
      if (signal?.aborted) return { ...latest, wait: "aborted" };
      const current = await executeTaskAction(statusParams, context, injected);
      if (!current.ok) {
        if (/coordinator busy/.test(current.reason)) continue;
        return current;
      }
      latest = current;
      if (fingerprint(current) !== before) return { ...current, wait: "changed" };
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
