/** @description Pure validator for routing v2 schema, review families, and model capabilities. Never throws. */

/**
 * @typedef {{ ok: true } | { ok: false, reason: string }} ValidationResult
 */

const SIMPLE_ROLES = Object.freeze(["build", "planner", "compliance", "security", "test-author", "harvester", "shipper"]);
const REVIEW_ROLES = Object.freeze(["plan-reviewer", "adversary"]);
const TIERED_ROLES = Object.freeze(["executor", "sniper"]);
const REQUIRED_ROLES = Object.freeze([...SIMPLE_ROLES, ...REVIEW_ROLES, ...TIERED_ROLES]);

/**
 * @description Validate harness.routing.json config. Never throws — always returns ValidationResult.
 * @param {unknown} config
 * @returns {ValidationResult}
 */
export function validateRouting(config) {
  try {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return { ok: false, reason: "config must be object" };
    }

    const required = ["version", "roles", "constraints", "modelCapabilities"];
    for (const k of required) {
      if (!(k in config)) return { ok: false, reason: `missing ${k}` };
    }
    if (config.version !== 2) return { ok: false, reason: "version must be 2" };

    const roles = config.roles;
    if (typeof roles !== "object" || roles === null || Array.isArray(roles)) {
      return { ok: false, reason: "roles must be object" };
    }

    const constraints = config.constraints;
    if (typeof constraints !== "object" || constraints === null || Array.isArray(constraints)) {
      return { ok: false, reason: "constraints must be object" };
    }

    const caps = config.modelCapabilities;
    if (typeof caps !== "object" || caps === null || Array.isArray(caps)) {
      return { ok: false, reason: "modelCapabilities must be object" };
    }

    const roleNames = Object.keys(roles);
    for (const role of REQUIRED_ROLES) {
      if (!Object.hasOwn(roles, role)) return { ok: false, reason: `missing role ${role}` };
    }
    const unknownRole = roleNames.find((role) => !REQUIRED_ROLES.includes(role));
    if (unknownRole) return { ok: false, reason: `unknown role ${unknownRole}` };

    for (const role of SIMPLE_ROLES) {
      if (!isModelRoute(roles[role])) return { ok: false, reason: `invalid model route on ${role}` };
    }
    if (roles.planner.fallback !== undefined && !isModelRoute(roles.planner.fallback)) {
      return { ok: false, reason: "invalid fallback model route on planner" };
    }
    for (const role of TIERED_ROLES) {
      const tiers = roles[role]?.tiers;
      for (const tier of ["low", "medium", "high"]) {
        if (!isModelRoute(tiers?.[tier])) return { ok: false, reason: `invalid ${tier} tier on ${role}` };
      }
    }

    for (const key of ["requireDualOn", "crossFamilyRoles"]) {
      if (!isExactReviewRoleList(constraints[key])) {
        return { ok: false, reason: `${key} must contain exactly plan-reviewer and adversary` };
      }
    }

    for (const role of REVIEW_ROLES) {
      const r = roles[role];
      const families = r.families;
      if (!families || typeof families !== "object" || Array.isArray(families)) {
        return { ok: false, reason: `missing families on ${role}` };
      }
      const primary = families["family-1"];
      const secondary = families["family-2"];
      if (!isFamily(primary, { primary: true, optional: false, countsLoop: true })) {
        return { ok: false, reason: `invalid required family-1 on ${role}` };
      }
      if (!isFamily(secondary, { primary: false, optional: true, countsLoop: false })) {
        return { ok: false, reason: `invalid optional family-2 on ${role}` };
      }
      if (Object.keys(families).some((family) => family !== "family-1" && family !== "family-2")) {
        return { ok: false, reason: `unknown family on ${role}` };
      }
      const primaryModel = primary.model;
      const secondaryModel = secondary.model;
      if (typeof primaryModel !== "string" || !primaryModel.includes("/")) {
        return { ok: false, reason: `missing family-1 model on ${role}` };
      }
      if (typeof secondaryModel !== "string" || !secondaryModel.includes("/")) {
        return { ok: false, reason: `missing family-2 model on ${role}` };
      }
      if (primaryModel.split("/")[0] === secondaryModel.split("/")[0]) {
        return { ok: false, reason: `same provider across families for ${role}` };
      }
      if (secondary.alternates !== undefined) {
        if (!Array.isArray(secondary.alternates) || secondary.alternates.length === 0) {
          return { ok: false, reason: `invalid family-2 alternates on ${role}` };
        }
        for (const alternate of secondary.alternates) {
          if (!isModelRoute(alternate)) return { ok: false, reason: `invalid family-2 alternate on ${role}` };
        }
      }
    }

    for (const m of Object.keys(caps)) {
      const cap = caps[m];
      if (!cap || typeof cap !== "object" || typeof cap.supportsReasoningEffort !== "boolean") {
        return { ok: false, reason: `missing supportsReasoningEffort for ${m}` };
      }
    }

    const modelEntries = collectModelEntries(roles);
    for (const { model, reasoningEffort } of modelEntries) {
      const cap = caps[model];
      if (!cap || typeof cap !== "object" || typeof cap.supportsReasoningEffort !== "boolean") {
        return { ok: false, reason: `missing supportsReasoningEffort for ${model}` };
      }
      if (reasoningEffort !== undefined && cap.supportsReasoningEffort !== true) {
        return { ok: false, reason: `${model} does not support reasoningEffort` };
      }
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `validation error: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

function isFamily(value, expected) {
  return isModelRoute(value)
    && value.primary === expected.primary
    && value.optional === expected.optional
    && value.countsLoop === expected.countsLoop;
}

function isModelRoute(value) {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && typeof value.model === "string" && /^[^/\s]+\/\S+$/.test(value.model);
}

function isExactReviewRoleList(value) {
  return Array.isArray(value)
    && value.length === REVIEW_ROLES.length
    && REVIEW_ROLES.every((role) => value.includes(role));
}

function collectModelEntries(value, entries = []) {
  if (value == null || typeof value !== "object") return entries;
  if (Array.isArray(value)) {
    for (const item of value) collectModelEntries(item, entries);
    return entries;
  }
  if (typeof value.model === "string") {
    entries.push({ model: value.model, reasoningEffort: value.reasoningEffort });
  }
  for (const nested of Object.values(value)) collectModelEntries(nested, entries);
  return entries;
}

export default { validateRouting };
