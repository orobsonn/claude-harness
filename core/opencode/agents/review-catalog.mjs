/** @description Canonical single-evaluator OpenCode review-agent catalog and inverted legacy aliases. */

export const REVIEW_AGENT_CATALOG = Object.freeze({
  "plan-reviewer": Object.freeze({
    logicalRole: "plan-reviewer",
    family: 1,
    primary: true,
    optional: false,
    countsLoop: true,
  }),
  adversary: Object.freeze({
    logicalRole: "adversary",
    family: 1,
    primary: true,
    optional: false,
    countsLoop: true,
  }),
});

/** Legacy dual-family names resolve to the single evaluator agent file. removeIn two releases ahead. */
export const REVIEW_AGENT_ALIASES = Object.freeze({
  "plan-reviewer-family-1": "plan-reviewer",
  "plan-reviewer-family-2": "plan-reviewer",
  "plan-reviewer-openai": "plan-reviewer",
  "adversary-family-1": "adversary",
  "adversary-family-2": "adversary",
  "adversary-openai": "adversary",
});

export const REVIEW_ALIAS_COMPATIBILITY = Object.freeze({
  introducedIn: "0.52.0",
  availableReleaseLines: Object.freeze(["0.52.x", "0.53.x"]),
  removeIn: "0.54.0",
});

export const REVIEW_ALIAS_COMPATIBILITY_RELEASES =
  REVIEW_ALIAS_COMPATIBILITY.availableReleaseLines.length;

/** Legacy secondary markers — keep family:2 identity for dual accounting until the dual block is pruned. */
const LEGACY_SECONDARY = Object.freeze(
  new Set([
    "plan-reviewer-family-2",
    "plan-reviewer-openai",
    "adversary-family-2",
    "adversary-openai",
  ]),
);

/** @description Normalize an OpenCode agent reference before catalog lookup. */
export function normalizeReviewAgentName(name) {
  if (typeof name !== "string") return "";
  let normalized = name.trim();
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized.includes("/")) normalized = normalized.split("/").pop() || normalized;
  if (normalized.includes(":")) normalized = normalized.slice(normalized.lastIndexOf(":") + 1);
  return normalized.replace(/\.md$/i, "").toLowerCase();
}

/** @description Resolve canonical and compatibility names to one canonical review agent. */
export function resolveReviewAgentName(name) {
  const normalized = normalizeReviewAgentName(name);
  if (!normalized) return null;
  if (Object.hasOwn(REVIEW_AGENT_CATALOG, normalized)) return normalized;
  return REVIEW_AGENT_ALIASES[normalized] ?? null;
}

/**
 * @description Resolve a review reference to canonical identity and catalog policy.
 * Legacy family-2 / openai names resolve to the single evaluator agent file but keep
 * family:2 / countsLoop:false so dual accounting remains coherent until passo 5 deletes it.
 */
export function reviewAgentIdentity(name) {
  const normalized = normalizeReviewAgentName(name);
  if (!normalized) return null;
  const canonicalName = resolveReviewAgentName(normalized);
  if (!canonicalName) return null;
  const base = REVIEW_AGENT_CATALOG[canonicalName];
  if (LEGACY_SECONDARY.has(normalized)) {
    return Object.freeze({
      canonicalName,
      logicalRole: base.logicalRole,
      family: 2,
      primary: false,
      optional: true,
      countsLoop: false,
    });
  }
  return Object.freeze({ canonicalName, ...base });
}

/**
 * @description True when routing opts into a second eye for this role.
 * Honors flat `secondEyeModel` and legacy v2 `families.family-2.model` (vendored projects
 * still on the dual shape must not lose the second eye silently on re-vendor).
 * @param {unknown} roleConfig
 * @returns {boolean}
 */
export function roleHasSecondEye(roleConfig) {
  if (!roleConfig || typeof roleConfig !== "object" || Array.isArray(roleConfig)) return false;
  if (typeof roleConfig.secondEyeModel === "string" && roleConfig.secondEyeModel.includes("/")) {
    return true;
  }
  const secondary = roleConfig.families?.["family-2"];
  return Boolean(
    secondary &&
      typeof secondary === "object" &&
      typeof secondary.model === "string" &&
      secondary.model.includes("/"),
  );
}

/**
 * @description Return dispatch names for one logical review role.
 * Secondary is null unless routing declares a second eye (`secondEyeModel` or legacy families.family-2).
 * @param {string} logicalRole
 * @param {{ roles?: Record<string, unknown> } | null} [routing]
 */
export function reviewDispatchFor(logicalRole, routing = null) {
  if (!Object.hasOwn(REVIEW_AGENT_CATALOG, logicalRole)) {
    return Object.freeze({ primary: null, secondary: null });
  }
  const secondEye = roleHasSecondEye(routing?.roles?.[logicalRole])
    ? `${logicalRole}-family-2`
    : null;
  return Object.freeze({
    primary: logicalRole,
    secondary: secondEye,
  });
}
