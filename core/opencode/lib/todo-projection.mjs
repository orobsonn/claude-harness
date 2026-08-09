/** @description Deterministically project the durable delivery state into OpenCode todo items. */

import { isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { matchesAbsolution } from "../../shared/lib/absolution.mjs";

function item(content, status, priority = "high") {
  return { content, status, priority };
}

function complete(value) {
  return value ? "completed" : "pending";
}

/** @description Return a stable todo list from a validated plan plus persisted workflow facts. Never throws. */
export function projectHarnessTodo(plan, state = {}) {
  const safeState = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const featureId = typeof safeState.feature_id === "string" ? safeState.feature_id : "feature";
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks.filter((task) => task && isSafeTaskId(task.id)) : [];
  const planned = tasks.length > 0;
  const out = [
    item("Approve the feature spec", complete(safeState.brainstormed === true)),
    item("Complete the spec adversarial review", complete(safeState.adversary_fired === true)),
    item("Create and validate the execution plan", complete(safeState.planner_status === "usable" && planned)),
    item("Approve the execution plan", complete(safeState.plan_review_verdict === "APPROVE")),
  ];

  for (const task of tasks) {
    const key = `${featureId}/${task.id}`;
    const captured = matchesAbsolution(key, safeState.capture_verified, () => true);
    const fidelity = matchesAbsolution(key, safeState.fidelity_pass, () => true);
    const status = captured ? "completed" : fidelity ? "in_progress" : "pending";
    out.push(item(`Deliver task: ${task.id}`, status));
  }

  const allCaptured = planned && tasks.every((task) =>
    matchesAbsolution(`${featureId}/${task.id}`, safeState.capture_verified, () => true),
  );
  out.push(item("Complete final review", complete(allCaptured && safeState.final_review_done === true)));
  out.push(item("Validate the demo", complete(safeState.demo_done === true), "medium"));
  out.push(item("Harvest evidence and deliver", complete(safeState.delivery_status === "delivered")));
  return out;
}

export default { projectHarnessTodo };
