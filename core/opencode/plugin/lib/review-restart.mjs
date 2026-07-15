/** @description Derive review restart authority exclusively from canonical on-disk ceremony and plan evidence. */

import path from "node:path";
import { verifyCompletionEvidence } from "./ceremony-transition.mjs";
import { validateCeremonyBinding } from "./ceremony-binding.mjs";
import { readBoundPlanSnapshot } from "./planner-artifact.mjs";

const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @description Verify successor ceremony, current-process seals, and a new content-addressed bound snapshot. */
export function deriveCanonicalReviewRestart(projectRoot, stateValue) {
  const state = plain(stateValue);
  const sessionId = typeof state.session_id === "string" ? state.session_id : "";
  const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
  const generation = typeof state.ceremony_generation === "string" ? state.ceremony_generation : "";
  const capGeneration = typeof state.cap_generation === "string" ? state.cap_generation : "";
  if (!projectRoot || !sessionId || !featureId || !GENERATION.test(generation) || !GENERATION.test(capGeneration) || generation === capGeneration) {
    return { ok: false, reason: "canonical successor ceremony generation is invalid or unchanged" };
  }
  if (state.brainstormed !== true || state.adversary_fired !== true) {
    return { ok: false, reason: "current ceremony markers are incomplete" };
  }
  const binding = validateCeremonyBinding(state, { sessionId, featureId, required: ["brainstormed", "adversary_fired"] });
  if (!binding.ok) return { ok: false, reason: binding.reason };
  const evidence = plain(state.ceremony_evidence);
  for (const marker of ["brainstormed", "adversary_fired"]) {
    const verified = verifyCompletionEvidence(projectRoot, state, marker, evidence[marker]);
    if (!verified.ok) return { ok: false, reason: verified.reason };
  }

  const planBinding = plain(state.planner_plan_binding);
  const snapshotHash = typeof planBinding.snapshot_hash === "string" ? planBinding.snapshot_hash : "";
  const snapshotPath = typeof planBinding.snapshot_path === "string" ? planBinding.snapshot_path : "";
  const capSnapshotHash = typeof state.cap_snapshot_hash === "string" ? state.cap_snapshot_hash : "";
  const expected = path.join(".opencode", "plans", ".state", sessionId, "bound-plans", `${snapshotHash}.json`);
  if (
    !/^[0-9a-f]{64}$/.test(snapshotHash) || snapshotHash === capSnapshotHash ||
    path.normalize(snapshotPath) !== expected || planBinding.session_id !== sessionId || planBinding.feature_id !== featureId
  ) return { ok: false, reason: "new bound planner snapshot identity is invalid" };
  const snapshot = readBoundPlanSnapshot(path.join(projectRoot, snapshotPath));
  if (!snapshot.valid || snapshot.semanticHash !== snapshotHash || snapshot.plan?.feature_id !== featureId) {
    return { ok: false, reason: "new bound planner snapshot is not canonical" };
  }
  return { ok: true, generation, snapshotHash };
}

export default { deriveCanonicalReviewRestart };
