/** @description Persist a fail-closed classify reset before replacing its stub; never rolls plan bytes back. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  mergeGateState as defaultMergeGateState,
  withGateStateLock as defaultWithGateStateLock,
} from "../../lib/gate-state.mjs";
import { mergeGateStatePatch } from "../../../shared/lib/gate-state-shape.mjs";

export const FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE = Object.freeze([
  "brainstormed_binding",
  "adversary_fired_binding",
  "ceremony_generation",
  "ceremony_evidence",
]);

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

function mergeGateStateAndRemove(statePath, patch, removeStateKeys, deps = {}) {
  const withGateStateLock = deps.withGateStateLock ?? defaultWithGateStateLock;
  return withGateStateLock(statePath, (previous) => {
    const merged = mergeGateStatePatch(previous, patch);
    if (!merged.ok) return merged;
    const next = { ...merged.state };
    for (const key of removeStateKeys) delete next[key];
    return next;
  });
}

/** @description Persist reset, replace stub, then mark classify ready; no failure path rewrites the plan. */
export function persistClassifyArtifacts(input, deps = {}) {
  const removeStateKeys = Array.isArray(input.removeStateKeys)
    ? input.removeStateKeys.filter((key) => typeof key === "string")
    : [];
  const mergeGateState = removeStateKeys.length === 0
    ? deps.mergeGateState ?? defaultMergeGateState
    : (statePath, patch) => {
        const mergeAndRemove = deps.mergeGateStateAndRemove ?? mergeGateStateAndRemove;
        return mergeAndRemove(statePath, patch, removeStateKeys, deps);
      };
  const writePlan = deps.writePlan ?? atomicWrite;
  const pending = mergeGateState(input.statePath, {
    ...input.statePatch,
    classified: false,
    classify_status: "stub_pending",
  });
  if (!pending?.ok) {
    return { ok: false, reason: `gate-state persistence failed: ${String(pending?.reason ?? "unknown")}` };
  }
  try {
    writePlan(input.planPath, `${JSON.stringify(input.stub, null, 2)}\n`);
  } catch (error) {
    return { ok: false, reason: `plan write failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const finalized = mergeGateState(input.statePath, {
    ...input.statePatch,
    classified: true,
    classify_status: "ready",
  });
  if (!finalized?.ok) {
    return { ok: false, reason: `gate-state finalize failed: ${String(finalized?.reason ?? "unknown")}` };
  }
  return { ok: true, state: finalized.state };
}

export default { FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE, persistClassifyArtifacts };
