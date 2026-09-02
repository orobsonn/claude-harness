/** @description Canonical Pi role catalog for the delivery harness. */

const EYE_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
const HAND_TOOLS = Object.freeze(["read", "grep", "find", "ls", "bash", "edit", "write"]);
/**
 * O planner é um olho sobre o CÓDIGO (nunca implementa), mas precisa gravar UM arquivo: o plano
 * canônico `.pi/harness/plans/<feature>/execution-plan.json` — a mesma autoridade que o planner da
 * lane OC tem via `edit: allow`. O plan-write-gate nega a esse papel qualquer outro alvo
 * ("planner may author only canonical execution plans"), então a tool a mais não é escopo a mais.
 */
const PLANNER_TOOLS = Object.freeze(["read", "grep", "find", "ls", "write"]);

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
  ...EYE_ROLES.map((name) => [
    name,
    Object.freeze({ tools: name === "harness-planner" ? PLANNER_TOOLS : EYE_TOOLS, kind: "eye" }),
  ]),
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
