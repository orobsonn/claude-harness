/** @description Locks deterministic todo projection from persisted delivery facts. */

import test from "node:test";
import assert from "node:assert/strict";
import { projectHarnessTodo } from "./todo-projection.mjs";

const plan = { tasks: [{ id: "task-one" }, { id: "task-two" }] };

test("projects stable workflow and task todos from durable state", () => {
  const todo = projectHarnessTodo(plan, {
    feature_id: "todo-projection",
    brainstormed: true,
    adversary_fired: true,
    planner_status: "usable",
    plan_review_verdict: "APPROVE",
    fidelity_pass: ["todo-projection/task-one@abc"],
    capture_verified: ["todo-projection/task-two@def"],
  });
  assert.deepEqual(todo.map((entry) => [entry.content, entry.status]), [
    ["Approve the feature spec", "completed"],
    ["Complete the spec adversarial review", "completed"],
    ["Create and validate the execution plan", "completed"],
    ["Approve the execution plan", "completed"],
    ["Deliver task: task-one", "in_progress"],
    ["Deliver task: task-two", "completed"],
    ["Complete final review", "pending"],
    ["Validate the demo", "pending"],
    ["Harvest evidence and deliver", "pending"],
  ]);
});

test("never lets malformed plan or state throw", () => {
  assert.doesNotThrow(() => projectHarnessTodo({ tasks: [{ id: "../unsafe" }] }, null));
  assert.equal(projectHarnessTodo({ tasks: [{ id: "../unsafe" }] }, null).length, 7);
});
