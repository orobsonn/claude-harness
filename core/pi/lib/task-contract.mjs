/** @description Pi paths for the task pipeline; the host-neutral contract lives in core/shared/lib/task-contract.mjs. */
import path from "node:path";

export {
  TASK_PIPELINE_VERSION,
  unsupportedTaskScopePattern,
  stableTaskJson,
  hashTaskReceipt,
} from "../../shared/lib/task-contract.mjs";
import {
  TASK_PIPELINE_VERSION,
  unsupportedTaskScopePattern,
  stableTaskJson,
  hashTaskReceipt,
} from "../../shared/lib/task-contract.mjs";

export const TASK_RUN_ENV = "PI_HARNESS_TASK_RUN";

export function taskAdmissionPath(projectRoot, attemptId) {
  return path.join(projectRoot, ".pi", "harness", "state", "task-admission", `${attemptId}.json`);
}

export function taskRegistryPath(projectRoot, parentSessionId) {
  return path.join(projectRoot, ".pi", "harness", "state", parentSessionId, "task-runs", "index.json");
}

export default {
  TASK_PIPELINE_VERSION,
  TASK_RUN_ENV,
  unsupportedTaskScopePattern,
  stableTaskJson,
  hashTaskReceipt,
  taskAdmissionPath,
  taskRegistryPath,
};
