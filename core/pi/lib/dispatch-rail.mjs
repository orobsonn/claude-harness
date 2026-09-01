import { join } from "node:path";

import { CANONICAL_ROLES, isCanonicalRole } from "./roles.mjs";

const MAX_TURNS = 16;

function deny(reason) {
  return { ok: false, reason };
}

/**
 * @param {unknown} input
 * @param {{shadowedRoles?: Set<string>}} [options]
 */
export function validateSubagentDispatch(input, options = {}) {
  const data = input && typeof input === "object" ? input : {};
  const role = data.subagent_type;
  if (!isCanonicalRole(role)) return deny("unknown-role");
  if (options.shadowedRoles?.has(role)) return deny("shadowed-role");
  if (data.run_in_background === true) return deny("background-disabled");
  if (typeof data.max_turns === "number" && data.max_turns > MAX_TURNS) return deny("turn-limit");
  return { ok: true };
}

/**
 * @param {string} cwd
 * @param {(path: string) => boolean} exists
 */
export function findShadowedCanonicalRoles(cwd, exists) {
  return new Set(CANONICAL_ROLES.filter((role) => exists(join(cwd, ".pi", "agents", `${role}.md`))));
}

export { MAX_TURNS };
