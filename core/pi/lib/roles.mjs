/** @description Canonical Pi role catalog for the delivery harness. */

const EYE_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
const HAND_TOOLS = Object.freeze(["read", "grep", "find", "ls", "bash", "edit", "write"]);

export const EYE_ROLES = Object.freeze([
  "harness-planner",
  "harness-compliance",
  "harness-adversary",
  "harness-security",
  "harness-harvester",
  "harness-plan-reviewer",
]);

export const HAND_ROLES = Object.freeze([
  "harness-executor",
  "harness-sniper",
  "harness-shipper",
  "harness-test-author",
]);

export const CANONICAL_ROLES = Object.freeze([...EYE_ROLES, ...HAND_ROLES]);

const POLICIES = Object.freeze(Object.fromEntries([
  ...EYE_ROLES.map((name) => [name, Object.freeze({ tools: EYE_TOOLS, kind: "eye" })]),
  ...HAND_ROLES.map((name) => [name, Object.freeze({ tools: HAND_TOOLS, kind: "hand" })]),
]));

/** @param {unknown} name */
export function isCanonicalRole(name) {
  return typeof name === "string" && CANONICAL_ROLES.includes(name);
}

/** @param {unknown} name */
export function rolePolicy(name) {
  return typeof name === "string" ? POLICIES[name] ?? null : null;
}
