/** @description Compatibility adapter for legacy OpenCode routing configurations. */

export const LEGACY_GROK_MODELS = Object.freeze([
  "xai/grok-4.3",
  "xai/grok-4.5",
  "xai/grok-build-0.1",
]);

const LEGACY_GROK_SET = new Set(LEGACY_GROK_MODELS);

export function migrateLegacyDefaultModel(model, replacement) {
  return typeof model === "string" && LEGACY_GROK_SET.has(model) ? replacement : model;
}

function migrateRouteModel(route, replacement) {
  if (!route || typeof route !== "object" || Array.isArray(route)) return route;
  if (!LEGACY_GROK_SET.has(route.model)) return { ...route };
  return { ...route, model: replacement };
}

/**
 * @description Adapt a version-1 routing object to the canonical version-2 family shape.
 * @param {unknown} config
 * @returns {unknown}
 */
export function adaptRoutingV1(config) {
  if (config == null || typeof config !== "object" || Array.isArray(config)) return config;
  if (config.version !== 1) return config;

  const roles = config.roles;
  if (roles == null || typeof roles !== "object" || Array.isArray(roles)) {
    return { ...config, version: 2 };
  }

  const adaptedRoles = { ...roles };
  const simpleTargets = {
    build: "openai/gpt-5.6-sol",
    planner: "openai/gpt-5.6-sol",
    compliance: "openai/gpt-5.5",
    security: "openai/gpt-5.5",
    "test-author": "ollama-cloud/glm-5.2",
    harvester: "openai/gpt-5.5",
    shipper: "openai/gpt-5.5",
  };
  for (const [roleName, target] of Object.entries(simpleTargets)) {
    const role = adaptedRoles[roleName];
    if (role && typeof role === "object" && !Array.isArray(role)) {
      const route = { ...role };
      if (roleName === "planner") delete route.fallback;
      adaptedRoles[roleName] = { ...route, model: migrateLegacyDefaultModel(route.model, target) };
    }
  }
  const tierTargets = {
    low: "ollama-cloud/gemma4:31b",
    medium: "ollama-cloud/glm-5.2",
    high: "ollama-cloud/kimi-k2.7-code",
  };
  for (const roleName of ["executor", "sniper"]) {
    const role = adaptedRoles[roleName];
    if (!role || typeof role !== "object" || Array.isArray(role)) continue;
    const tiers = role.tiers;
    if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) continue;
    adaptedRoles[roleName] = {
      ...role,
      tiers: Object.fromEntries(Object.entries(tiers).map(([tier, route]) => [
        tier,
        route && typeof route === "object" && !Array.isArray(route)
          ? { ...route, model: migrateLegacyDefaultModel(route.model, tierTargets[tier]) }
          : route,
      ])),
    };
  }
  // v1 dual → flat single evaluator + optional secondEyeModel (no families / requireDualOn).
  // Only known primary extensions pass through — never arbitrary keys (families, bogus, …).
  const PRIMARY_KEEP = Object.freeze(["reasoningEffort", "timeout", "label", "extension"]);
  for (const roleName of ["plan-reviewer", "adversary"]) {
    const role = roles[roleName];
    if (role == null || typeof role !== "object" || Array.isArray(role)) continue;
    const secondary = Array.isArray(role.dual) ? role.dual[0] : undefined;
    const primaryModel = migrateLegacyDefaultModel(role.model, "openai/gpt-5.6-sol");
    /** @type {Record<string, unknown>} */
    const flat = { model: primaryModel };
    for (const key of PRIMARY_KEEP) {
      if (Object.hasOwn(role, key)) flat[key] = role[key];
    }
    if (secondary && typeof secondary === "object" && !Array.isArray(secondary)) {
      const migrated = migrateRouteModel(secondary, "ollama-cloud/kimi-k2.7-code");
      if (typeof migrated?.model === "string" && migrated.model.includes("/")) {
        flat.secondEyeModel = migrated.model;
      }
    }
    adaptedRoles[roleName] = flat;
  }

  const modelCapabilities = { ...(config.modelCapabilities ?? {}) };
  for (const legacy of LEGACY_GROK_MODELS) delete modelCapabilities[legacy];
  for (const [model, supportsReasoningEffort] of Object.entries({
    "openai/gpt-5.6-sol": true,
    "openai/gpt-5.5": true,
    "ollama-cloud/gemma4:31b": false,
    "ollama-cloud/glm-5.2": false,
    "ollama-cloud/kimi-k2.7-code": false,
  })) {
    if (!Object.hasOwn(modelCapabilities, model)) {
      modelCapabilities[model] = { supportsReasoningEffort };
    }
  }
  // Caps for any secondEyeModel emitted above.
  for (const roleName of ["plan-reviewer", "adversary"]) {
    const second = adaptedRoles[roleName]?.secondEyeModel;
    if (typeof second === "string" && !Object.hasOwn(modelCapabilities, second)) {
      modelCapabilities[second] = { supportsReasoningEffort: false };
    }
  }

  // Do not inject requireDualOn — single-evaluator default; second eye is opt-in via secondEyeModel.
  const { constraints: _dropConstraints, ...rest } = config;
  return { ...rest, version: 2, roles: adaptedRoles, modelCapabilities };
}

export default { adaptRoutingV1, migrateLegacyDefaultModel };
