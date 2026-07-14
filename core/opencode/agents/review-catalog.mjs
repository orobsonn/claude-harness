/** @description Canonical provider-agnostic OpenCode review-agent catalog and compatibility aliases. */

export const REVIEW_AGENT_CATALOG = Object.freeze({
  "plan-reviewer-family-1": Object.freeze({
    logicalRole: "plan-reviewer",
    family: 1,
    primary: true,
    optional: false,
    countsLoop: true,
  }),
  "plan-reviewer-family-2": Object.freeze({
    logicalRole: "plan-reviewer",
    family: 2,
    primary: false,
    optional: true,
    countsLoop: false,
  }),
  "adversary-family-1": Object.freeze({
    logicalRole: "adversary",
    family: 1,
    primary: true,
    optional: false,
    countsLoop: true,
  }),
  "adversary-family-2": Object.freeze({
    logicalRole: "adversary",
    family: 2,
    primary: false,
    optional: true,
    countsLoop: false,
  }),
});

export const REVIEW_AGENT_ALIASES = Object.freeze({
  "plan-reviewer": "plan-reviewer-family-1",
  "plan-reviewer-openai": "plan-reviewer-family-2",
  adversary: "adversary-family-1",
  "adversary-openai": "adversary-family-2",
});

export const REVIEW_ALIAS_COMPATIBILITY = Object.freeze({
  introducedIn: "0.44.0",
  availableReleaseLines: Object.freeze(["0.44.x", "0.45.x"]),
  removeIn: "0.46.0",
});

export const REVIEW_ALIAS_COMPATIBILITY_RELEASES =
  REVIEW_ALIAS_COMPATIBILITY.availableReleaseLines.length;

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

/** @description Resolve a review reference to canonical identity and catalog policy. */
export function reviewAgentIdentity(name) {
  const canonicalName = resolveReviewAgentName(name);
  if (!canonicalName) return null;
  return Object.freeze({ canonicalName, ...REVIEW_AGENT_CATALOG[canonicalName] });
}

/** @description Return canonical dispatch names for one logical review role. */
export function reviewDispatchFor(logicalRole) {
  const entries = Object.entries(REVIEW_AGENT_CATALOG)
    .filter(([, entry]) => entry.logicalRole === logicalRole)
    .sort(([, left], [, right]) => left.family - right.family);
  return Object.freeze({
    primary: entries.find(([, entry]) => entry.primary)?.[0] ?? null,
    secondary: entries.find(([, entry]) => entry.optional)?.[0] ?? null,
  });
}
