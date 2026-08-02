/** @description Builds the identity-only appendix for a planner dispatch. */

/**
 * @description Keeps the plan's feature identity tied to the classified session. Review and
 * retry policy deliberately lives with the human orchestrator, not in persistent OC state.
 */
export function buildPlannerBriefAppendix(input = {}) {
  const featureId = typeof input.featureId === "string" ? input.featureId : "";
  if (!featureId) return "";
  const lines = [
    `[HARNESS_SESSION_FEATURE_ID]${featureId}[/HARNESS_SESSION_FEATURE_ID]`,
    `The plan you return MUST carry "feature_id": "${featureId}" exactly. This is the classified session identity; record scope changes in tasks, never by renaming it.`,
  ];
  if (input.expectedModelStrategy && typeof input.expectedModelStrategy === "object" && !Array.isArray(input.expectedModelStrategy)) {
    lines.push(
      `[HARNESS_EXPECTED_MODEL_STRATEGY]\n${JSON.stringify(input.expectedModelStrategy)}\n[/HARNESS_EXPECTED_MODEL_STRATEGY]`,
      "Return exactly one full JSON plan. Its model_strategy must equal this snapshot: hand_tiers has low, medium and high; the seven hyphenated eye keys are fixed; fallback is optional opaque JSON. Do not use tools to write the plan; the host adapter persists your return.",
    );
  }
  return lines.join("\n");
}

export default { buildPlannerBriefAppendix };
