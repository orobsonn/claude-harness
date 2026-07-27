/** @description Durable ceremony evidence plus ordered, idempotent marker transitions and restart recovery. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ceremonyMarkerPatch } from "./ceremony-binding.mjs";
import { mergeGateStatePatch } from "../../../shared/lib/gate-state-shape.mjs";
import { gateStateDir, planDir } from "../../../shared/lib/path-helpers.mjs";
import { parseReviewReportText, validateReviewReport } from "../../../shared/lib/review-report-schema.mjs";

const PHASES = Object.freeze([
  { marker: "brainstormed", phase: "brainstorming", proof: "brainstorming_completion_evidence" },
  { marker: "adversary_fired", phase: "spec-adversary", proof: "spec_adversary_completion_evidence" },
]);

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function deniedReport(result) {
  return /\b(?:permission denied|access denied|tool denied|request denied)\b/i.test(result);
}

function canonicalSpecPath(root, sessionId, featureId) {
  const result = planDir({ projectRoot: root, runtime: "opencode", sessionId, featureId });
  return result.ok ? path.join(result.path, "spec.md") : null;
}

function canonicalAdversaryPath(root, sessionId) {
  const result = gateStateDir({ projectRoot: root, runtime: "opencode", sessionId });
  return result.ok ? path.join(result.path, "ceremony", "spec-adversary-primary.json") : null;
}

function relative(root, file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function atomicJsonWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

/** @description Persist the trusted Task boundary result used by a later accepted adversary transition. */
export function captureSpecAdversaryResult(root, { sessionId, featureId, generation, callId, role, output }) {
  if (![sessionId, featureId, generation, callId].every((value) => typeof value === "string" && value.length > 0)) return false;
  if (role !== "adversary-family-1") return false;
  const result = typeof output === "string" ? output : JSON.stringify(output ?? "");
  if (!result.trim() || deniedReport(result)) return false;
  const report = parseReviewReportText(result);
  if (!validateReviewReport("adversary", report, 1).ok) return false;
  const file = canonicalAdversaryPath(root, sessionId);
  if (!file) return false;
  return atomicJsonWrite(file, {
    version: 1,
    session_id: sessionId,
    feature_id: featureId,
    ceremony_generation: generation,
    phase: "spec-adversary",
    role,
    call_id: callId,
    result_sha256: hash(result),
    result,
  });
}

/** @description Build evidence only from the canonical artifact/result already produced for this run. */
export function completionEvidence(root, state, marker) {
  const sessionId = typeof state?.session_id === "string" ? state.session_id : "";
  const featureId = typeof state?.feature_id === "string" ? state.feature_id : "";
  const generation = typeof state?.ceremony_generation === "string" ? state.ceremony_generation : "";
  if (!sessionId || !featureId || !generation) return { ok: false, reason: "classified session, feature, and ceremony generation are required" };
  try {
    if (marker === "brainstormed") {
      const file = canonicalSpecPath(root, sessionId, featureId);
      if (!file) return { ok: false, reason: "canonical spec artifact path is invalid" };
      const bytes = fs.readFileSync(file);
      if (bytes.length === 0) return { ok: false, reason: "canonical spec artifact is empty" };
      return { ok: true, evidence: {
        version: 1, session_id: sessionId, feature_id: featureId, ceremony_generation: generation, phase: "brainstorming",
        artifact_path: relative(root, file), artifact_sha256: hash(bytes), artifact_size: bytes.length,
      } };
    }
    if (marker === "adversary_fired") {
      const file = canonicalAdversaryPath(root, sessionId);
      if (!file) return { ok: false, reason: "canonical spec-adversary result path is invalid" };
      const bytes = fs.readFileSync(file);
      const receipt = plain(JSON.parse(bytes.toString("utf8")));
      if (
        !receipt || receipt.version !== 1 || receipt.session_id !== sessionId || receipt.feature_id !== featureId ||
        receipt.ceremony_generation !== generation ||
        receipt.phase !== "spec-adversary" || receipt.role !== "adversary-family-1" ||
        typeof receipt.call_id !== "string" || !receipt.call_id || typeof receipt.result !== "string" ||
        !receipt.result.trim() || deniedReport(receipt.result) || receipt.result_sha256 !== hash(receipt.result) ||
        !validateReviewReport("adversary", parseReviewReportText(receipt.result), 1).ok
      ) return { ok: false, reason: "canonical spec-adversary result is invalid or identity-mismatched" };
      return { ok: true, evidence: {
        version: 1, session_id: sessionId, feature_id: featureId, ceremony_generation: generation, phase: "spec-adversary",
        result_path: relative(root, file), result_sha256: hash(bytes), call_id: receipt.call_id,
      } };
    }
  } catch {
    return { ok: false, reason: marker === "brainstormed" ? "canonical spec artifact is missing" : "canonical spec-adversary result is missing" };
  }
  return { ok: false, reason: "unknown ceremony transition" };
}

/** @description Verify durable evidence against its canonical artifact/result, never against an old marker. */
export function verifyCompletionEvidence(root, state, marker, evidence) {
  const expected = completionEvidence(root, state, marker);
  if (!expected.ok || !plain(evidence)) return expected.ok ? { ok: false, reason: "completion evidence is missing" } : expected;
  return JSON.stringify(evidence) === JSON.stringify(expected.evidence)
    ? { ok: true }
    : { ok: false, reason: "completion evidence is forged, stale, or identity-mismatched" };
}

function markerValid(state, marker) {
  const sessionId = state.session_id;
  const featureId = state.feature_id;
  const binding = plain(state[`${marker}_binding`]);
  return state[marker] === true && binding?.session_id === sessionId && binding?.feature_id === featureId &&
    binding?.operation === marker;
}

/** @description Apply one official transition with evidence in a single state mutation. */
export function transitionCeremony(root, state, marker, suppliedEvidence = null) {
  const index = PHASES.findIndex((phase) => phase.marker === marker);
  if (index < 0) return { ok: false, reason: "unknown ceremony transition" };
  if (index > 0 && !markerValid(state, PHASES[index - 1].marker)) {
    return { ok: false, reason: `${PHASES[index - 1].marker} transition must complete first` };
  }
  const evidenceResult = suppliedEvidence
    ? verifyCompletionEvidence(root, state, marker, suppliedEvidence)
    : completionEvidence(root, state, marker);
  if (!evidenceResult.ok) return evidenceResult;
  const evidence = suppliedEvidence ?? evidenceResult.evidence;
  if (markerValid(state, marker) && JSON.stringify(state.ceremony_evidence?.[marker]) === JSON.stringify(evidence)) {
    return { ok: true, state, changed: false };
  }
  const patch = {
    ...ceremonyMarkerPatch(marker, state.session_id, state.feature_id),
    ceremony_evidence: { ...(plain(state.ceremony_evidence) ?? {}), [marker]: evidence },
  };
  const applied = mergeGateStatePatch(state, patch);
  if (!applied.ok) return applied;
  return { ok: true, state: applied.state, changed: true };
}

export function missingCeremonyProof(marker, reason) {
  const phase = PHASES.find((candidate) => candidate.marker === marker) ?? PHASES[0];
  return {
    code: "CEREMONY_PROOF_REQUIRED",
    missing_proof: phase.proof,
    next_transition: { phase: phase.phase, action: "resume", marker: phase.marker },
    reason,
  };
}

/** @description Recover at most one provable marker so every phase has its own atomic persistence boundary. */
export function recoverCeremonyStep(root, state) {
  for (const phase of PHASES) {
    if (markerValid(state, phase.marker)) continue;
    const evidence = plain(state.ceremony_evidence)?.[phase.marker];
    const verified = verifyCompletionEvidence(root, state, phase.marker, evidence);
    if (!verified.ok) return { ok: false, error: missingCeremonyProof(phase.marker, verified.reason), state };
    const transitioned = transitionCeremony(root, state, phase.marker, evidence);
    if (!transitioned.ok) return { ok: false, error: missingCeremonyProof(phase.marker, transitioned.reason), state };
    return { ok: true, state: transitioned.state, changed: transitioned.changed, complete: false };
  }
  return { ok: true, state, changed: false, complete: true };
}

/** @description Recover all provable missing/current-process markers in strict phase order. */
export function recoverCeremony(root, state) {
  let next = state;
  let changed = false;
  while (true) {
    const step = recoverCeremonyStep(root, next);
    if (!step.ok) return { ...step, state: next, changed };
    next = step.state;
    changed = changed || step.changed;
    if (step.complete) return { ok: true, state: next, changed };
  }
}

export default { captureSpecAdversaryResult, completionEvidence, verifyCompletionEvidence, transitionCeremony, recoverCeremonyStep, recoverCeremony, missingCeremonyProof };
