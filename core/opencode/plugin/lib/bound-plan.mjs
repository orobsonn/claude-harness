/** @description Read the sealed bound execution-plan snapshot for the A5 multitask
 * capture rail. Pure + fail-open: any missing/unsafe/unreadable/unparseable snapshot
 * yields null so the delivery gate never blocks on a plan it cannot read. */

import fsDefault from "node:fs";
import path from "node:path";

/** Snapshots live only here — reject anything that resolves outside this subtree. */
const PLANS_SUBTREE = path.join(".opencode", "plans");

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * @description Resolve + read the bound-plan snapshot referenced by
 * `gateState.planner_plan_binding.snapshot_path`. Returns the parsed plan object,
 * or null when absent/unsafe/unreadable/unparseable (fail-open).
 * @param {string} root project root
 * @param {unknown} gateState
 * @param {{ readFileSync?: (p: string, enc: string) => string }} [deps]
 * @returns {Record<string, unknown> | null}
 */
export function readBoundPlanSnapshot(root, gateState, deps = {}) {
  try {
    if (typeof root !== "string" || root.length === 0) return null;
    const binding = object(object(gateState).planner_plan_binding);
    const snapshotPath = binding.snapshot_path;
    if (typeof snapshotPath !== "string" || snapshotPath.length === 0) return null;
    const resolved = path.resolve(root, snapshotPath);
    const subtree = path.resolve(root, PLANS_SUBTREE);
    if (resolved !== subtree && !resolved.startsWith(subtree + path.sep)) return null;
    const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fsDefault.readFileSync;
    const raw = readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
