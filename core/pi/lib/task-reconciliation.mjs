/** Verify host merges separately from a task's immutable admission base. */
import { execFileSync } from "node:child_process";
import { checkScope } from "../../shared/lib/capture-oracle.mjs";
import { hashTaskReceipt } from "./task-contract.mjs";
import { isSafeSessionId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";

const sha = /^[a-f0-9]{40}$/;
const git = (root, ...args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const ancestor = (root, before, after) => git(root, "merge-base", "--is-ancestor", before, after);
function scoped(root, base, head, scopes) {
  const changed = git(root, "diff", "--name-only", "-z", base, head).split("\0").filter(Boolean);
  if (checkScope(changed, scopes).length) throw new Error("task changed paths outside canonical scope");
}

export function taskReconciliationDigest(entry) {
  return entry.reconciliations?.length ? hashTaskReceipt(entry.reconciliations) : null;
}

/** Throws before old or unproven content can be treated as a reviewed task result. */
export function taskScopeBase(entry, root, head, scopes) {
  if (entry.reconciliation_required || entry.reconciliation_intent)
    throw new Error("dependency correction requires reconciliation; resume this dependent task before reviewing or integrating it");
  if (entry.reconciliations !== undefined && !Array.isArray(entry.reconciliations))
    throw new Error("invalid task reconciliation history");
  let base = entry.base_sha;
  let priorHead = base;
  for (const proof of entry.reconciliations ?? []) {
    if (proof?.written_by !== "host-task-reconciliation" || proof.task_id !== entry.task_id ||
        proof.attempt_id !== entry.attempt_id || proof.scope_base_sha !== base ||
        ![proof.pre_child_head, proof.parent_head, proof.merged_head, proof.tree].every((value) => sha.test(value ?? "")) ||
        !Number.isInteger(proof.launch_count) || proof.launch_count < 1 || proof.launch_count > entry.launches.length)
      throw new Error("invalid task reconciliation identity");
    if (!Array.isArray(proof.upstreams) || !proof.upstreams.length)
      throw new Error("task reconciliation requires corrected dependency receipts");
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
      ancestor(root, receipt.child_head, receipt.integrated_head);
      ancestor(root, receipt.integrated_head, proof.parent_head);
    }
    ancestor(root, priorHead, proof.pre_child_head);
    ancestor(root, base, proof.parent_head);
    const parents = git(root, "rev-list", "--parents", "-n", "1", proof.merged_head).split(" ").slice(1);
    const tree = git(root, "merge-tree", "--write-tree", proof.pre_child_head, proof.parent_head).split("\n")[0];
    if (parents.length !== 2 || parents[0] !== proof.pre_child_head || parents[1] !== proof.parent_head ||
        tree !== proof.tree || git(root, "rev-parse", `${proof.merged_head}^{tree}`) !== tree)
      throw new Error("task reconciliation merge differs from its reserved parents or tree");
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
