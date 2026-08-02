/** @description Pure projection from validated routing facts to the frozen plan strategy. */

export const MODEL_STRATEGY_EYE_KEYS = Object.freeze([
  "planner", "plan-reviewer", "compliance", "adversary", "security", "shipper", "harvester",
]);
const MODEL_STRATEGY_HAND_TIER_KEYS = Object.freeze(["low", "medium", "high"]);

/**
 * @description Project the exact R15 strategy from routing without reading disk or validating schema.
 * @param {unknown} routing
 * @returns {{ ok: true, strategy: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function projectExpectedModelStrategy(routing) {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) return { ok: false, reason: "routing must be an object" };
  const roles = routing.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return { ok: false, reason: "routing roles must be an object" };
  const handTiers = {};
  for (const tier of MODEL_STRATEGY_HAND_TIER_KEYS) {
    const model = roles.executor?.tiers?.[tier]?.model;
    if (typeof model !== "string" || model.trim().length === 0) {
      return { ok: false, reason: `routing executor ${tier} hand model missing` };
    }
    handTiers[tier] = model;
  }
  const strategy = { hand_tiers: handTiers };
  for (const role of MODEL_STRATEGY_EYE_KEYS) {
    const route = roles[role];
    const model = typeof route?.model === "string" ? route.model : route?.families?.["family-1"]?.model;
    if (typeof model !== "string" || model.trim().length === 0) return { ok: false, reason: `routing primary model missing for ${role}` };
    strategy[role] = model;
  }
  return { ok: true, strategy };
}

/** @description Check an active call's stored snapshot before it authorizes persistence. */
export function isCompleteExpectedModelStrategy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== MODEL_STRATEGY_EYE_KEYS.length + 1 || keys.some((key) => key !== "hand_tiers" && !MODEL_STRATEGY_EYE_KEYS.includes(key))) return false;
  const tiers = value.hand_tiers;
  if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) return false;
  const tierKeys = Object.keys(tiers);
  if (tierKeys.length !== MODEL_STRATEGY_HAND_TIER_KEYS.length || tierKeys.some((key) => !MODEL_STRATEGY_HAND_TIER_KEYS.includes(key))) return false;
  if (!MODEL_STRATEGY_HAND_TIER_KEYS.every((key) => typeof tiers[key] === "string" && tiers[key].trim().length > 0)) return false;
  return MODEL_STRATEGY_EYE_KEYS.every((key) => Object.hasOwn(value, key) && typeof value[key] === "string" && value[key].trim().length > 0);
}

export default { MODEL_STRATEGY_EYE_KEYS, isCompleteExpectedModelStrategy, projectExpectedModelStrategy };
