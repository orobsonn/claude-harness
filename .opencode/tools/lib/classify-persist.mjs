/** @description Persist only classify triage facts in the session gate state. */

import {
  mergeGateState as defaultMergeGateState,
  withGateStateLock as defaultWithGateStateLock,
} from "../../lib/gate-state.mjs";
import { mergeGateStatePatch } from "../../shared/lib/gate-state-shape.mjs";

export const FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE = Object.freeze([
  "brainstormed_binding",
  "adversary_fired_binding",
  "ceremony_generation",
  "ceremony_evidence",
]);

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

/** @description Merge one classify transition without creating or changing a plan artifact. */
export function persistClassifyState(input, deps = {}) {
  const removeStateKeys = Array.isArray(input.removeStateKeys)
    ? input.removeStateKeys.filter((key) => typeof key === "string")
    : [];
  const mergeGateState = removeStateKeys.length === 0
    ? deps.mergeGateState ?? defaultMergeGateState
    : (statePath, patch) => {
        const mergeAndRemove = deps.mergeGateStateAndRemove ?? mergeGateStateAndRemove;
        return mergeAndRemove(statePath, patch, removeStateKeys, deps);
      };
  const persisted = mergeGateState(input.statePath, input.statePatch);
  if (!persisted?.ok) {
    return { ok: false, reason: `gate-state persistence failed: ${String(persisted?.reason ?? "unknown")}` };
  }
  return { ok: true, state: persisted.state };
}

export default { FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE, persistClassifyState };
