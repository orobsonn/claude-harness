/** @description Role helpers for OC entry/plan/loop gates. Pure. Never throws. */

/** Delivery roles gated by entry-gate (task subagent types). */
export const DELIVERY_ROLES = new Set([
  "planner",
  "executor",
  "compliance",
  "adversary",
  "sniper",
  "security",
  "harvester",
  "shipper",
  "plan-reviewer",
  "test-author",
]);

/** Hand roles that write code/tests. */
export const HAND_ROLES = new Set(["executor", "sniper", "test-author"]);

/**
 * @description Strip namespace prefix then lowercase so Executor-High is delivery.
 * @param {unknown} subagentType
 * @returns {string}
 */
export function bareRole(subagentType) {
  if (typeof subagentType !== "string") return "";
  let s = subagentType.trim();
  if (!s) return "";
  if (s.startsWith("@")) s = s.slice(1);
  if (s.includes("/")) s = s.split("/").pop() || s;
  if (s.includes(":")) s = s.slice(s.lastIndexOf(":") + 1);
  return s.replace(/\.md$/i, "").toLowerCase();
}

/**
 * @param {unknown} subagentType
 * @returns {boolean}
 */
export function isDeliveryRole(subagentType) {
  const bare = bareRole(subagentType);
  if (!bare) return false;
  if (DELIVERY_ROLES.has(bare)) return true;
  // executor-* / sniper-* tiers; dual-eye suffixes (adversary-openai, plan-reviewer-openai)
  if (bare.startsWith("executor")) return true;
  if (bare.startsWith("sniper")) return true;
  if (bare.startsWith("adversary")) return true;
  if (bare.startsWith("plan-reviewer")) return true;
  return false;
}

/**
 * @param {unknown} subagentType
 * @returns {boolean}
 */
export function isExecutorRole(subagentType) {
  const bare = bareRole(subagentType);
  return bare === "executor" || bare.startsWith("executor-");
}

/**
 * @param {unknown} subagentType
 * @returns {boolean}
 */
export function isTestAuthorRole(subagentType) {
  const bare = bareRole(subagentType);
  return bare === "test-author" || bare === "test-author-spawn";
}

/**
 * @param {unknown} subagentType
 * @returns {boolean}
 */
export function isSniperRole(subagentType) {
  const bare = bareRole(subagentType);
  return bare === "sniper" || bare.startsWith("sniper-");
}

/**
 * @param {unknown} subagentType
 * @returns {boolean}
 */
export function isPlanReviewerRole(subagentType) {
  const bare = bareRole(subagentType);
  return bare === "plan-reviewer" || bare.startsWith("plan-reviewer-");
}

/**
 * @param {unknown} subagentType
 * @returns {boolean}
 */
export function isAdversaryRole(subagentType) {
  const bare = bareRole(subagentType);
  return bare === "adversary" || bare.startsWith("adversary-");
}

/**
 * @param {unknown} subagentType
 * @returns {boolean}
 */
export function isPlannerRole(subagentType) {
  const bare = bareRole(subagentType);
  return bare === "planner";
}
