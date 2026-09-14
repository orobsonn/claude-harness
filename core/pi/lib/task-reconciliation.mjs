/** Verify host merges separately from a task's immutable admission base. */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkScope } from "../../shared/lib/capture-oracle.mjs";
import { hashTaskReceipt, taskRegistryPath } from "./task-contract.mjs";
import { readTaskPlanAuthority } from "./task-plan-recovery.mjs";
import { isSafeFeatureId, isSafeSessionId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";

const sha = /^[a-f0-9]{40}$/;
const git = (root, ...args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const ancestor = (root, before, after) => git(root, "merge-base", "--is-ancestor", before, after);
function scoped(root, base, head, scopes) {
  const changed = git(root, "diff", "--name-only", "-z", base, head).split("\0").filter(Boolean);
  if (checkScope(changed, scopes).length) throw new Error("task changed paths outside canonical scope");
}

/** Git exit 1 is a usable conflict preview, not an execution failure. */
export function taskMergePreview(root, before, after) {
  const result = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "-z", before, after],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status))
    throw new Error(`task merge-tree failed: ${result.error?.message ?? result.stderr}`);
  const [tree, ...fields] = result.stdout.split("\0");
  const conflicts = result.status === 1 ? fields.slice(0, fields.indexOf("")) : [];
  if (!sha.test(tree) || (result.status === 1 && !conflicts.length))
    throw new Error("task merge-tree returned an invalid preview");
  return { tree, conflicts: [...new Set(conflicts)].sort() };
}

export function taskReconciliationDigest(entry) {
  return entry.reconciliations?.length ? hashTaskReceipt(entry.reconciliations) : null;
}

function reconciliationAuthority(entry) {
  if (!isSafeFeatureId(entry.feature_id) || !isSafeSessionId(entry.parent_session_id))
    throw new Error("invalid reconciliation owner");
  const registry = JSON.parse(fs.readFileSync(taskRegistryPath(entry.parent_root, entry.parent_session_id), "utf8"));
  const bytes = fs.readFileSync(path.join(entry.parent_root, ".pi/harness/plans", entry.feature_id, "execution-plan.json"));
  const plan = JSON.parse(bytes);
  if (registry.version !== 1 || registry.parent_session_id !== entry.parent_session_id ||
      registry.feature_id !== entry.feature_id || registry.plan_sha256 !== entry.plan_sha256 ||
      registry.spec_sha256 !== entry.spec_sha256)
    throw new Error("reconciliation owner plan or registry changed");
  if (createHash("sha256").update(bytes).digest("hex") !== entry.plan_sha256)
    readTaskPlanAuthority({ projectRoot: entry.parent_root, sessionId: entry.parent_session_id,
      featureId: entry.feature_id, planSha256: entry.plan_sha256, specSha256: entry.spec_sha256,
      originCallId: entry.grant?.origin?.plan_review_call_id });
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const ancestors = new Set();
  const pending = [...(tasks.get(entry.task_id)?.depends_on ?? [])];
  while (pending.length) {
    const id = pending.pop();
    if (ancestors.has(id)) continue;
    const task = tasks.get(id);
    if (!task || id === entry.task_id) throw new Error("invalid reconciliation dependency graph");
    ancestors.add(id);
    pending.push(...task.depends_on);
  }
  return { registry, ancestors };
}

function registeredCorrection(upstream, authority, root) {
  const current = authority.registry.tasks?.[upstream.task_id];
  if (!authority.ancestors.has(upstream.task_id) || current?.attempt_id !== upstream.attempt_id || current.status !== "integrated")
    throw new Error("corrected dependency is not a registered ancestor of this task");
  const receipts = [current.integration, ...(current.integration_history ?? [])].filter(Boolean);
  const results = [current.result, ...Object.values(current.result_history ?? {})].filter(Boolean);
  for (const digest of [upstream.previous_receipt_sha256, hashTaskReceipt(upstream.receipt)]) {
    const receipt = receipts.find((item) => hashTaskReceipt(item) === digest);
    if (!receipt || receipt.task_id !== upstream.task_id || receipt.attempt_id !== upstream.attempt_id ||
        !results.some((result) => hashTaskReceipt(result) === receipt.result_sha256))
      throw new Error("corrected dependency receipt lacks matching registry history and result");
  }
  const previous = current.integration_history?.find((item) => hashTaskReceipt(item) === upstream.previous_receipt_sha256);
  if (!previous) throw new Error("previous dependency receipt is missing from integration history");
  ancestor(root, previous.integrated_head, upstream.receipt.integrated_head);
}

/** Throws before old or unproven content can be treated as a reviewed task result. */
export function taskScopeBase(entry, root, head, scopes) {
  if (entry.reconciliation_required || entry.reconciliation_intent)
    throw new Error("dependency correction requires reconciliation; resume this dependent task before reviewing or integrating it");
  if (entry.reconciliations !== undefined && !Array.isArray(entry.reconciliations))
    throw new Error("invalid task reconciliation history");
  let base = entry.base_sha;
  let priorHead = base;
  const authority = entry.reconciliations?.length ? reconciliationAuthority(entry) : null;
  for (const proof of entry.reconciliations ?? []) {
    if (proof?.written_by !== "host-task-reconciliation" || proof.task_id !== entry.task_id ||
        proof.attempt_id !== entry.attempt_id || proof.scope_base_sha !== base ||
        ![proof.pre_child_head, proof.parent_head, proof.merged_head, proof.tree].every((value) => sha.test(value ?? "")) ||
        !Number.isInteger(proof.launch_count) || proof.launch_count < 1 || proof.launch_count > entry.launches.length)
      throw new Error("invalid task reconciliation identity");
    if (!Array.isArray(proof.upstreams) || (!proof.upstreams.length && proof.kind !== "integration-conflict"))
      throw new Error("task reconciliation requires corrected dependency receipts");
    if (proof.kind === "integration-conflict") {
      if (!proof.conflicts?.length || proof.upstreams.length)
        throw new Error("invalid integration conflict recovery");
      ancestor(entry.parent_root, proof.parent_head, "HEAD");
    }
    const ids = new Set();
    for (const upstream of proof.upstreams) {
      const receipt = upstream?.receipt;
      if (receipt?.written_by !== "host-task-integration" || receipt.version !== 1 ||
          !isSafeTaskId(upstream.task_id) || !isSafeSessionId(upstream.attempt_id) || ids.has(upstream.task_id) ||
          receipt.task_id !== upstream.task_id || receipt.attempt_id !== upstream.attempt_id ||
          !isSafeSessionId(receipt.session_id) || !/^[a-f0-9]{64}$/.test(receipt.result_sha256 ?? "") ||
          receipt.parent_session_id !== entry.parent_session_id || receipt.feature_id !== entry.feature_id ||
          receipt.parent_root !== entry.parent_root || receipt.plan_sha256 !== entry.plan_sha256 ||
          receipt.spec_sha256 !== entry.spec_sha256 ||
          !sha.test(receipt.child_head ?? "") || !sha.test(receipt.integrated_head ?? "") ||
          !/^[a-f0-9]{64}$/.test(upstream.previous_receipt_sha256 ?? "") ||
          hashTaskReceipt(receipt) === upstream.previous_receipt_sha256)
        throw new Error("invalid corrected dependency receipt in task reconciliation");
      ids.add(upstream.task_id);
      registeredCorrection(upstream, authority, root);
      ancestor(root, receipt.child_head, receipt.integrated_head);
      ancestor(root, receipt.integrated_head, proof.parent_head);
    }
    ancestor(root, priorHead, proof.pre_child_head);
    ancestor(root, base, proof.parent_head);
    const parents = git(root, "rev-list", "--parents", "-n", "1", proof.merged_head).split(" ").slice(1);
    const preview = taskMergePreview(root, proof.pre_child_head, proof.parent_head);
    const tree = git(root, "rev-parse", `${proof.merged_head}^{tree}`);
    if (parents.length !== 2 || parents[0] !== proof.pre_child_head || parents[1] !== proof.parent_head ||
        preview.tree !== proof.tree)
      throw new Error("task reconciliation merge differs from its reserved parents or tree");
    if (preview.conflicts.length) {
      if (JSON.stringify(preview.conflicts) !== JSON.stringify(proof.conflicts))
        throw new Error("task reconciliation conflicts differ from the Git preview");
      // The host imports the clean merge. The native writer resolves only its
      // conflicts; subsequent scoped fixes retain their ordinary producer proof.
      scoped(root, preview.tree, tree, proof.conflicts);
      if (scopes && checkScope(proof.conflicts, scopes).length)
        throw new Error("task merge conflicts outside canonical scope");
    } else if (tree !== preview.tree || proof.conflicts?.length) {
      throw new Error("task reconciliation merge differs from its reserved parents or tree");
    }
    if (scopes) {
      scoped(root, base, proof.pre_child_head, scopes);
      scoped(root, proof.parent_head, proof.merged_head, scopes);
    }
    base = proof.parent_head;
    priorHead = proof.merged_head;
  }
  ancestor(root, priorHead, head);
  return base;
}
