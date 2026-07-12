/** @description Pure validator for harness.routing.json — schema + constraint checks (cross-family, dual required, reasoningEffort flags). Never throws. */

/**
 * @typedef {{ ok: true } | { ok: false, reason: string }} ValidationResult
 */

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
    if (config.version !== 1) return { ok: false, reason: "version must be 1" };

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

    if (!Array.isArray(constraints.requireDualOn)) {
      return { ok: false, reason: "requireDualOn must be array" };
    }
    for (const role of constraints.requireDualOn) {
      if (typeof role !== "string" || !role) {
        return { ok: false, reason: "requireDualOn entries must be non-empty strings" };
      }
      const r = roles[role];
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        return { ok: false, reason: `missing dual on ${role}` };
      }
      if (!Array.isArray(r.dual) || r.dual.length === 0) {
        return { ok: false, reason: `missing dual on ${role}` };
      }
      for (const d of r.dual) {
        if (!d || typeof d !== "object" || typeof d.model !== "string" || !d.model) {
          return { ok: false, reason: `missing dual.model on ${role}` };
        }
      }
    }

    if (!Array.isArray(constraints.crossFamilyRoles)) {
      return { ok: false, reason: "crossFamilyRoles must be array" };
    }
    for (const role of constraints.crossFamilyRoles) {
      if (typeof role !== "string" || !role) continue;
      const r = roles[role];
      if (!r || typeof r !== "object" || Array.isArray(r) || !Array.isArray(r.dual)) continue;
      if (typeof r.model !== "string" || !r.model.includes("/")) {
        return { ok: false, reason: `missing model on ${role}` };
      }
      const primaryProv = r.model.split("/")[0];
      for (const d of r.dual) {
        if (!d || typeof d !== "object" || typeof d.model !== "string" || !d.model.includes("/")) {
          return { ok: false, reason: `missing dual.model on ${role}` };
        }
        const dualProv = d.model.split("/")[0];
        if (primaryProv === dualProv) {
          return { ok: false, reason: `same provider on dual for ${role}` };
        }
      }
    }

    for (const m of Object.keys(caps)) {
      const cap = caps[m];
      if (!cap || typeof cap !== "object" || typeof cap.supportsReasoningEffort !== "boolean") {
        return { ok: false, reason: `missing supportsReasoningEffort for ${m}` };
      }
    }

    if (caps["xai/grok-build-0.1"] && caps["xai/grok-build-0.1"].supportsReasoningEffort !== false) {
      return { ok: false, reason: "grok-build-0.1 must not support reasoningEffort" };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `validation error: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

export default { validateRouting };
