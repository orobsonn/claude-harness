/** @description Canonical Pi role catalog for the delivery harness. */

import { PLANNING_TOOLS } from "./planning-tools.mjs";
const EYE_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
const PLAN_REVIEW_TOOLS = Object.freeze([...EYE_TOOLS, ...PLANNING_TOOLS]);
const HAND_TOOLS = Object.freeze(["read", "grep", "find", "ls", "bash", "edit", "write"]);
// O shipper é a mão de entrega, não de produto: precisa de Bash para staging/commit, mas não
// recebe Write/Edit. Uma proteção redundante no plan-write-gate nega essas tools se um runtime
// antigo ainda as expuser.
const SHIPPER_TOOLS = Object.freeze(["read", "grep", "find", "ls", "bash"]);
/**
 * O planner é um olho sobre o CÓDIGO (nunca implementa), mas precisa gravar UM arquivo: o plano
 * canônico `.pi/harness/plans/<feature>/execution-plan.json` — a mesma autoridade que o planner da
 * lane OC tem via `edit: allow`. O plan-write-gate nega a esse papel qualquer outro alvo
 * ("planner may author only canonical execution plans"), então a tool a mais não é escopo a mais.
 */
const PLANNER_TOOLS = Object.freeze(["read", "grep", "find", "ls", "write", ...PLANNING_TOOLS]);

export const EYE_ROLES = Object.freeze([
  "harness-planner",
  "harness-test-reviewer",
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

/** As onze roles que participam do plano, marcadores, captura e aprovação final. */
export const DELIVERY_ROLES = Object.freeze([...EYE_ROLES, ...HAND_ROLES]);
/** Olho local de discussão: não pertence à cerimônia de delivery. */
export const DISCUSSION_ROLES = Object.freeze(["harness-discussion-adversary"]);
/** Tudo que o runtime pode materializar, sombrear e despachar. */
export const RUNTIME_ROLES = Object.freeze([...DELIVERY_ROLES, ...DISCUSSION_ROLES]);
/** Revisores independentes que podem rodar em paralelo sobre o mesmo HEAD. */
export const PARALLEL_REVIEW_ROLES = Object.freeze([
  "harness-adversary",
  "harness-compliance",
  "harness-security",
]);
// Compatibilidade para consumidores de delivery: "canonical" continua sendo o catálogo de delivery.
export const CANONICAL_ROLES = DELIVERY_ROLES;

const POLICIES = Object.freeze(Object.fromEntries([
  ...EYE_ROLES.map((name) => [
    name,
    Object.freeze({ tools: name === "harness-planner" ? PLANNER_TOOLS : name === "harness-plan-reviewer" ? PLAN_REVIEW_TOOLS : EYE_TOOLS, kind: "eye" }),
  ]),
  ...HAND_ROLES.map((name) => [
    name,
    Object.freeze({ tools: name === "harness-shipper" ? SHIPPER_TOOLS : HAND_TOOLS, kind: "hand" }),
  ]),
  ...DISCUSSION_ROLES.map((name) => [name, Object.freeze({ tools: EYE_TOOLS, kind: "discussion" })]),
]));

/** @param {unknown} name */
export function isCanonicalRole(name) {
  return typeof name === "string" && CANONICAL_ROLES.includes(name);
}

/** @param {unknown} name */
export function isDiscussionRole(name) {
  return typeof name === "string" && DISCUSSION_ROLES.includes(name);
}

/** @param {unknown} name */
export function isRuntimeRole(name) {
  return typeof name === "string" && RUNTIME_ROLES.includes(name);
}

/** @param {unknown} name */
export function isParallelReviewRole(name) {
  return typeof name === "string" && PARALLEL_REVIEW_ROLES.includes(name);
}

/** The canonical plan adds security to the two mandatory final reviewers when applicable. */
export function requiredPiFinalReviewRoles(plan) {
  return PARALLEL_REVIEW_ROLES.filter((role) => role !== "harness-security" || plan?.final_review?.security === true);
}

/** Initial implementation eyes; security applicability is expressed by its actual dispatch. */
export function requiredPiTaskReviewRoles(plan, task) {
  if (String(plan?.mode).toLowerCase() !== "full") return [];
  return PARALLEL_REVIEW_ROLES.filter((role) => role === "harness-compliance" ||
    role === "harness-adversary" && task?.adversarial?.enabled === true);
}

/** @param {unknown} name */
export function rolePolicy(name) {
  return typeof name === "string" ? POLICIES[name] ?? null : null;
}
