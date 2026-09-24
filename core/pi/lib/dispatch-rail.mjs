import { join } from "node:path";

import { RUNTIME_ROLES, isRuntimeRole } from "./roles.mjs";
import {
  CURRENT_FIXED as FIXED_PI_ROUTES,
  CURRENT_HANDS as HAND_PI_ROUTES,
  loadModelProfileFromEnv,
  routeFromModelProfile,
} from "./model-profile.mjs";

// Planner and review eyes routinely need several inspect/verify cycles on a FULL
// delivery. Keep a finite ceiling as a liveness/cost rail, but leave enough
// headroom that the parent does not re-dispatch a healthy eye solely at 16 turns.
const MAX_TURNS = 144;

const INDEPENDENT_REVIEW_ROLES = new Set([
  "harness-support",
  "harness-adversary",
  "harness-discussion-adversary",
  "harness-plan-reviewer",
  "harness-test-reviewer",
  "harness-compliance",
  "harness-security",
]);

function deny(reason) {
  return { ok: false, reason };
}

/** @description Resolve a rota imutável de um despacho. Executor/sniper exigem a complexidade do plano. */
export function piDispatchRoute(role, complexity, profileSnapshot = loadModelProfileFromEnv()) {
  if (profileSnapshot) return routeFromModelProfile(profileSnapshot, role, complexity);
  if (role === "harness-test-author") {
    if (!["low", "medium", "high", "max"].includes(complexity)) return { ok: false, reason: "hand-complexity" };
    return { ok: true, model: "openai-codex/gpt-6-sol", thinking: "high" };
  }
  const fixed = FIXED_PI_ROUTES[role];
  if (fixed) return { ok: true, ...fixed };
  if (role === "harness-executor" || role === "harness-sniper") {
    const route = HAND_PI_ROUTES[complexity];
    return route ? { ok: true, ...route } : { ok: false, reason: "hand-complexity" };
  }
  return { ok: false, reason: "unknown-role" };
}

/**
 * @param {unknown} input
 * @param {{shadowedRoles?: Set<string>, profileSnapshot?: object}} [options]
 */
export function validateSubagentDispatch(input, options = {}) {
  const data = input && typeof input === "object" ? input : {};
  const role = data.subagent_type;
  if (!isRuntimeRole(role)) return deny("unknown-role");
  if (options.shadowedRoles?.has(role)) return deny("shadowed-role");
  if (INDEPENDENT_REVIEW_ROLES.has(role) && Boolean(data.inherit_context)) {
    return deny("context-inheritance-disabled");
  }
  // Uma cerimônia é uma execução nova, ligada ao dispatch-record atual. Reusar uma sessão filha
  // não emite o evento de identidade de filho e pode ligar estado de outra tentativa.
  if (data.resume != null) return deny("resume-disabled");
  if (data.run_in_background === true) return deny("background-disabled");
  if (typeof data.max_turns === "number" && data.max_turns > MAX_TURNS) return deny("turn-limit");
  const route = piDispatchRoute(role, data.complexity, options.profileSnapshot ?? loadModelProfileFromEnv());
  if (!route.ok) return deny(route.reason);
  if (data.model !== route.model || data.thinking !== route.thinking) return deny("model-route");
  return { ok: true };
}

/**
 * @param {string} cwd
 * @param {(path: string) => boolean} exists
 */
export function findShadowedCanonicalRoles(cwd, exists) {
  return new Set(RUNTIME_ROLES.filter((role) => exists(join(cwd, ".pi", "agents", `${role}.md`))));
}

export { HAND_PI_ROUTES, FIXED_PI_ROUTES, MAX_TURNS };
