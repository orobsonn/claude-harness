import test from "node:test";
import assert from "node:assert/strict";
import { projectTaskProgress, reconcileTaskProgress } from "./task-progress.mjs";
import { hashTaskReceipt } from "./task-contract.mjs";
import { formatPlanProgress, restorePlanSnapshot } from "./plan-tracker.mjs";

const plan = { tasks: [{ id: "inbound", title: "Inbound" }, { id: "outbound", title: "Outbound" }] };
function fixture() {
  const registry = { parent_session_id: "parent", feature_id: "issue", plan_sha256: "plan", spec_sha256: "spec", tasks: {} };
  for (const task of plan.tasks) {
    const identity = { parent_session_id: "parent", feature_id: "issue", task_id: task.id, attempt_id: task.id,
      plan_sha256: "plan", spec_sha256: "spec", child_head: "head" };
    const result = { ...identity, written_by: "host-task-inspection" };
    registry.tasks[task.id] = { ...identity, status: "integrated", result,
      integration: { ...identity, written_by: "host-task-integration", result_sha256: hashTaskReceipt(result) } };
  }
  return registry;
}

test("native integrations close every task and validation without manual plan updates", () => {
  const registry = fixture();
  const progress = { featureId: "issue", tasks: projectTaskProgress(plan, registry) };
  const snapshot = reconcileTaskProgress(undefined, progress);
  assert.deepEqual(formatPlanProgress(snapshot), ["Plano 2/2 · concluído", "Validação 2/2 · aprovada"]);
  assert.equal(reconcileTaskProgress(snapshot, progress), snapshot, "read-only refresh does not churn revisions");
  assert.deepEqual(restorePlanSnapshot([{ type: "custom", customType: "harness-plan-snapshot", data: { snapshot } }]), snapshot);
});

test("canonical IDs replace a stale 5/6-style tracker without mapping by title or ordinal", () => {
  const stale = { schemaVersion: 1, planId: "existing", revision: 70, title: "Delivery", tasks: [
    { id: "t1", title: "Outbound", status: "completed", validationStatus: "passed" },
    { id: "t2", title: "Inbound", status: "in_progress", validationStatus: "pending" },
  ] };
  const snapshot = reconcileTaskProgress(stale, { featureId: "issue", tasks: projectTaskProgress(plan, fixture()) });
  assert.equal(snapshot.planId, "existing");
  assert.equal(snapshot.revision, 71);
  assert.equal(snapshot.tasks[0].canonicalTaskId, "inbound");
  assert.ok(snapshot.tasks.every(t => t.status === "completed"));
});

test("process termination stops claiming running even before the parent polls", () => {
  const registry = fixture();
  registry.tasks.inbound.status = "running";
  registry.tasks.inbound.launches = [{}];
  const before = JSON.stringify(registry);
  let terminal = false;
  const readProcess = () => ({ ok: true, terminal });
  const live = projectTaskProgress(plan, registry, { readProcess });
  assert.equal(live[0].status, "in_progress");
  assert.equal(live[0].validationStatus, "pending");
  terminal = true;
  const ended = projectTaskProgress(plan, registry, { readProcess });
  assert.equal(ended[0].activity, "awaiting_inspection");
  const snapshot = reconcileTaskProgress(undefined, { featureId: "issue", tasks: ended });
  assert.match(formatPlanProgress(snapshot)[0], /aguardando inspeção/);
  assert.equal(ended[1].status, "completed", "sibling integration is preserved");
  assert.equal(JSON.stringify(registry), before, "UI cannot mutate scheduling or receipts");
});

test("corrupted receipts and mismatched task identity never show approved", () => {
  const registry = fixture();
  registry.tasks.inbound.result.child_head = "changed";
  assert.equal(projectTaskProgress(plan, registry)[0].status, "blocked");
  registry.tasks.outbound.task_id = "inbound";
  assert.equal(projectTaskProgress(plan, registry)[1].status, "blocked");
});

test("ready, failed and unknown process states have distinct actionable displays", () => {
  const registry = fixture();
  registry.tasks.inbound.status = "ready";
  assert.equal(projectTaskProgress(plan, registry)[0].activity, "awaiting_integration");
  registry.tasks.inbound.status = "blocked";
  registry.tasks.inbound.reason = "fixture typecheck failed";
  assert.equal(projectTaskProgress(plan, registry)[0].note, "fixture typecheck failed");
  registry.tasks.inbound.status = "running";
  registry.tasks.inbound.launches = [{}];
  assert.equal(projectTaskProgress(plan, registry, { readProcess: () => ({ ok: false, terminal: false }) })[0].status, "blocked");
});
