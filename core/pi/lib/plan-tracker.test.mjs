import assert from "node:assert/strict";
import test from "node:test";

import { applyPlanAction, formatPlanProgress, formatPlanResult, restorePlanSnapshot } from "./plan-tracker.mjs";

test("records a bounded active plan with immutable task ids", () => {
  const result = applyPlanAction(undefined, {
    action: "record",
    title: "Corrigir autenticação",
    tasks: ["Criar teste de regressão", "Implementar correção"],
  }, { now: () => 42 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot, {
    schemaVersion: 1,
    planId: "plan-16",
    revision: 1,
    title: "Corrigir autenticação",
    tasks: [
      { id: "t1", title: "Criar teste de regressão", status: "pending" },
      { id: "t2", title: "Implementar correção", status: "pending" },
    ],
  });
  assert.deepEqual(formatPlanProgress(result.snapshot), ["Plano 0/2 · pendente"]);
});

test("keeps independent tasks in progress without silently resetting either one", () => {
  const initial = applyPlanAction(undefined, {
    action: "record",
    title: "Plano",
    tasks: ["Teste", "Implementação"],
  }, { now: () => 1 }).snapshot;

  const first = applyPlanAction(initial, {
    action: "update",
    planId: initial.planId,
    revision: 1,
    taskId: "t1",
    status: "in_progress",
  });
  const second = applyPlanAction(first.snapshot, {
    action: "update",
    planId: initial.planId,
    revision: 2,
    taskId: "t2",
    status: "in_progress",
  });

  assert.equal(second.ok, true);
  assert.deepEqual(second.snapshot.tasks.map((task) => task.status), ["in_progress", "in_progress"]);
  assert.deepEqual(formatPlanProgress(second.snapshot), ["Plano 0/2 · em andamento (2): Teste, Implementação"]);
});

test("reopens one completed task and resets its validation lane to pending", () => {
  const initial = applyPlanAction(undefined, {
    action: "record",
    title: "Plano",
    tasks: [{ title: "Implementar", validation: true }, "Documentar"],
  }, { now: () => 1 }).snapshot;
  const completed = applyPlanAction(initial, {
    action: "update", planId: initial.planId, revision: 1, taskId: "t1", status: "completed",
  }).snapshot;
  const passed = applyPlanAction(completed, {
    action: "validate", planId: initial.planId, revision: 2, taskId: "t1", validationStatus: "passed",
  }).snapshot;
  const otherRunning = applyPlanAction(passed, {
    action: "update", planId: initial.planId, revision: 3, taskId: "t2", status: "in_progress",
  }).snapshot;

  const resumed = applyPlanAction(otherRunning, {
    action: "update", planId: initial.planId, revision: 4, taskId: "t1", status: "in_progress",
  });

  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.snapshot.tasks.map((task) => task.status), ["in_progress", "in_progress"]);
  assert.equal(resumed.snapshot.tasks[0].validationStatus, "pending");
  assert.deepEqual(formatPlanProgress(resumed.snapshot), [
    "Plano 0/2 · em andamento (2): Implementar, Documentar",
    "Validação 0/1 · pendente",
  ]);
});

test("rejects stale, malformed, and ambiguous updates without changing the snapshot", () => {
  const initial = applyPlanAction(undefined, {
    action: "record",
    title: "Plano",
    tasks: ["Teste"],
  }, { now: () => 1 }).snapshot;

  for (const action of [
    { action: "update", planId: initial.planId, revision: 0, taskId: "t1", status: "completed" },
    { action: "update", planId: "other", revision: 1, taskId: "t1", status: "completed" },
    { action: "update", planId: initial.planId, revision: 1, taskId: "missing", status: "completed" },
    { action: "update", planId: initial.planId, revision: 1, taskId: "t1", status: "blocked" },
  ]) {
    const result = applyPlanAction(initial, action);
    assert.equal(result.ok, false);
    assert.deepEqual(result.snapshot, initial);
  }
});

test("restores only the last valid branch snapshot", () => {
  const old = applyPlanAction(undefined, {
    action: "record",
    title: "Antigo",
    tasks: ["A"],
  }, { now: () => 1 }).snapshot;
  const current = applyPlanAction(undefined, {
    action: "record",
    title: "Atual",
    tasks: ["A", "B"],
  }, { now: () => 2 }).snapshot;

  const entries = [
    { type: "message", message: { role: "toolResult", toolName: "harness_plan", details: { snapshot: old } } },
    { type: "message", message: { role: "toolResult", toolName: "harness_plan", details: { snapshot: { schemaVersion: 99 } } } },
    { type: "message", message: { role: "toolResult", toolName: "harness_plan", details: { snapshot: current } } },
  ];

  assert.deepEqual(restorePlanSnapshot(entries), current);
});

test("tracks validation as a separate lane for tasks that require it", () => {
  const initial = applyPlanAction(undefined, {
    action: "record",
    title: "Plano",
    tasks: [{ title: "Implementar", validation: true }, "Documentar"],
  }, { now: () => 1 }).snapshot;
  const implementation = applyPlanAction(initial, {
    action: "update",
    planId: initial.planId,
    revision: 1,
    taskId: "t1",
    status: "completed",
  }).snapshot;
  const validation = applyPlanAction(implementation, {
    action: "validate",
    planId: initial.planId,
    revision: 2,
    taskId: "t1",
    validationStatus: "running",
  }).snapshot;

  assert.equal(validation.tasks[0].validationStatus, "running");
  assert.deepEqual(formatPlanProgress(validation), [
    "Plano 1/2 · pendente",
    "Validação 0/1 · atual: Implementar",
  ]);
  assert.match(formatPlanResult(validation), /planId: plan-1/);
  assert.match(formatPlanResult(validation), /t1: Implementar · concluída · validação: em andamento/);
});
