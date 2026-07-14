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
      adaptedRoles[roleName] = { ...role, model: migrateLegacyDefaultModel(role.model, target) };
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
  for (const roleName of ["plan-reviewer", "adversary"]) {
    const role = roles[roleName];
    if (role == null || typeof role !== "object" || Array.isArray(role)) continue;
    const { dual, ...primaryConfig } = role;
    const secondary = Array.isArray(dual) ? dual[0] : undefined;
    const alternates = Array.isArray(dual)
      ? dual.slice(1).map((entry) => migrateRouteModel(entry, "ollama-cloud/kimi-k2.7-code"))
      : [];
    adaptedRoles[roleName] = {
      families: {
        "family-1": {
          ...primaryConfig,
          model: migrateLegacyDefaultModel(primaryConfig.model, "openai/gpt-5.6-sol"),
          primary: true,
          optional: false,
          countsLoop: true,
        },
        "family-2": {
          ...(secondary && typeof secondary === "object" && !Array.isArray(secondary)
            ? migrateRouteModel(secondary, "ollama-cloud/kimi-k2.7-code")
            : { model: undefined }),
          ...(alternates.length > 0 ? { alternates } : {}),
          primary: false,
          optional: true,
          countsLoop: false,
        },
      },
    };
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

  return { ...config, version: 2, roles: adaptedRoles, modelCapabilities };
}

export default { adaptRoutingV1, migrateLegacyDefaultModel };
