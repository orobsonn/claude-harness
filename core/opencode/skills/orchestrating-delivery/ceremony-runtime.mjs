/** @description Strict coordinator consumer for entry-gate ceremony denials and their only allowlisted next steps. */

const TRANSITIONS = Object.freeze({
  brainstorming_completion_evidence: Object.freeze({
    phase: "brainstorming",
    action: "resume",
    marker: "brainstormed",
    requires: ({ brainstormedCurrent }) => !brainstormedCurrent,
    step: Object.freeze({ kind: "skill", name: "brainstorming" }),
  }),
  spec_adversary_completion_evidence: Object.freeze({
    phase: "spec-adversary",
    action: "resume",
    marker: "adversary_fired",
    requires: ({ brainstormedCurrent, adversaryCurrent }) => brainstormedCurrent && !adversaryCurrent,
    step: Object.freeze({ kind: "task", subagent_type: "adversary-family-1" }),
  }),
});

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** @description Extract the exact structured object emitted as the JSON suffix of an entry-gate denial. */
export function parseCeremonyDenial(value) {
  if (!(value instanceof Error) && plain(value)) return { ok: true, denial: value };
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const start = message.indexOf("{");
  if (start < 0) return { ok: false, reason: "ceremony denial object is missing" };
  try {
    const denial = JSON.parse(message.slice(start));
    return plain(denial) ? { ok: true, denial } : { ok: false, reason: "ceremony denial must be an object" };
  } catch {
    return { ok: false, reason: "ceremony denial JSON is malformed" };
  }
}

/** @description Map one validated denial to one canonical coordinator step; unknown input fails closed. */
export function consumeNextTransition(denial, state = {}) {
  const value = plain(denial);
  const next = plain(value?.next_transition);
  if (!value || value.code !== "CEREMONY_PROOF_REQUIRED" || typeof value.missing_proof !== "string" || !next) {
    return { ok: false, code: "CEREMONY_TRANSITION_REJECTED", reason: "invalid ceremony denial contract" };
  }
  const allowedDenialKeys = new Set(["code", "missing_proof", "next_transition", "reason"]);
  const allowedNextKeys = new Set(["phase", "action", "marker"]);
  if (Object.keys(value).some((key) => !allowedDenialKeys.has(key)) || Object.keys(next).some((key) => !allowedNextKeys.has(key))) {
    return { ok: false, code: "CEREMONY_TRANSITION_REJECTED", reason: "ceremony denial contains unknown fields" };
  }
  const transition = TRANSITIONS[value.missing_proof];
  if (
    !transition || next.phase !== transition.phase || next.action !== transition.action ||
    next.marker !== transition.marker || !transition.requires(state)
  ) return { ok: false, code: "CEREMONY_TRANSITION_REJECTED", reason: "next transition is unknown or invalid for current state" };
  return {
    ok: true,
    descriptor: {
      version: 1,
      type: "ceremony_next_transition",
      phase: transition.phase,
      action: transition.action,
      marker: transition.marker,
      coordinator_step: transition.step,
      completion_transition: { tool: "mark", action: transition.marker },
    },
  };
}

export default { parseCeremonyDenial, consumeNextTransition };
