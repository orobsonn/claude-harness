import { join } from "node:path";

import { RUNTIME_ROLES, isRuntimeRole } from "./roles.mjs";

// Planner and review eyes routinely need several inspect/verify cycles on a FULL
// delivery. Keep a finite ceiling as a liveness/cost rail, but leave enough
// headroom that the parent does not re-dispatch a healthy eye solely at 16 turns.
const MAX_TURNS = 144;

const INDEPENDENT_REVIEW_ROLES = new Set([
  "harness-adversary",
  "harness-discussion-adversary",
  "harness-plan-reviewer",
  "harness-compliance",
  "harness-security",
]);

/** Rotas fixas da lane Pi. O pai escolhe a complexidade do plano, mas não o modelo/effort. */
const FIXED_PI_ROUTES = Object.freeze({
  "harness-planner": Object.freeze({ model: "openai-codex/gpt-5.6-sol", thinking: "high" }),
  "harness-plan-reviewer": Object.freeze({ model: "openai-codex/gpt-6-astra", thinking: "high" }),
  "harness-adversary": Object.freeze({ model: "openai-codex/gpt-5.6-sol", thinking: "medium" }),
  "harness-security": Object.freeze({ model: "openai-codex/gpt-5.6-sol" }),
  "harness-compliance": Object.freeze({ model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" }),
  "harness-test-author": Object.freeze({ model: "openai-codex/gpt-5.6-terra", thinking: "high" }),
  "harness-harvester": Object.freeze({ model: "openai-codex/gpt-5.6-luna", thinking: "high" }),
  "harness-shipper": Object.freeze({ model: "openai-codex/gpt-5.6-luna", thinking: "high" }),
  "harness-discussion-adversary": Object.freeze({ model: "openai-codex/gpt-5.6-sol", thinking: "medium" }),
});

const HAND_PI_ROUTES = Object.freeze({
  low: Object.freeze({ model: "openai-codex/gpt-5.6-luna", thinking: "high" }),
  medium: Object.freeze({ model: "openai-codex/gpt-5.6-terra", thinking: "medium" }),
  high: Object.freeze({ model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" }),
  // O contrato de plano legado ainda aceita `max`; na rota aprovada ele colapsa no maior degrau.
  max: Object.freeze({ model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" }),
});

function deny(reason) {
  return { ok: false, reason };
}

/** @description Resolve a rota imutável de um despacho. Executor/sniper exigem a complexidade do plano. */
export function piDispatchRoute(role, complexity) {
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
 * @param {{shadowedRoles?: Set<string>}} [options]
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
  const route = piDispatchRoute(role, data.complexity);
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
