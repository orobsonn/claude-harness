/** @description Shared, dependency-free contract for the Pi task pipeline. */
import { createHash } from "node:crypto";
import path from "node:path";

export const TASK_PIPELINE_VERSION = 1;
export const TASK_RUN_ENV = "PI_HARNESS_TASK_RUN";

/** Canonical JSON used when a receipt crosses worktrees. */
export function stableTaskJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item,
  );
}

export function hashTaskReceipt(value) {
  return createHash("sha256").update(stableTaskJson(value)).digest("hex");
}

export function taskAdmissionPath(projectRoot, attemptId) {
  return path.join(projectRoot, ".pi", "harness", "state", "task-admission", `${attemptId}.json`);
}

export function taskRegistryPath(projectRoot, parentSessionId) {
  return path.join(projectRoot, ".pi", "harness", "state", parentSessionId, "task-runs", "index.json");
}

export default {
  TASK_PIPELINE_VERSION,
  TASK_RUN_ENV,
  stableTaskJson,
  hashTaskReceipt,
  taskAdmissionPath,
  taskRegistryPath,
};
