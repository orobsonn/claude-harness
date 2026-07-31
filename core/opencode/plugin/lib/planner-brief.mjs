/** @description Builds the identity-only appendix for a planner dispatch. */

/**
 * @description Keeps the plan's feature identity tied to the classified session. Review and
 * retry policy deliberately lives with the human orchestrator, not in persistent OC state.
 */
export function buildPlannerBriefAppendix(input = {}) {
  const featureId = typeof input.featureId === "string" ? input.featureId : "";
  if (!featureId) return "";
  return [
    `[HARNESS_SESSION_FEATURE_ID]${featureId}[/HARNESS_SESSION_FEATURE_ID]`,
    `The plan you return MUST carry "feature_id": "${featureId}" exactly. This is the classified session identity; record scope changes in tasks, never by renaming it.`,
  ].join("\n");
}

export default { buildPlannerBriefAppendix };
