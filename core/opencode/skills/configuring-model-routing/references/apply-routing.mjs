/**
 * @description Deterministic apply of harness.routing.json → agents frontmatter + AGENTS.md table.
 * Skill elicits; this module writes. Never throws for validation failure — returns { ok, reason }.
 */
import fs from "node:fs";
import path from "node:path";
import { validateRouting } from "../../../../shared/lib/routing-validate.mjs";

export { validateRouting };

/**
 * @description Agent basename (no .md) → resolver of route `{ model, reasoningEffort? }` from routing roles.
 * Second-eye stubs return undefined when secondEyeModel is absent (leave frontmatter inert).
 */
export const AGENT_ROUTE_RESOLVERS = Object.freeze({
  build: (r) => asAgentRoute(r.build),
  plan: (r) => asAgentRoute(r.build),
  "harness-config": (r) => asAgentRoute(r.build),
  planner: (r) => asAgentRoute(r.planner),
  compliance: (r) => asAgentRoute(r.compliance),
  security: (r) => asAgentRoute(r.security),
  harvester: (r) => asAgentRoute(r.harvester),
  shipper: (r) => asAgentRoute(r.shipper),
  "test-author": (r) => asAgentRoute(r["test-author"]),
  "plan-reviewer": (r) => asAgentRoute(r["plan-reviewer"]) ?? asAgentRoute(r["plan-reviewer"]?.families?.["family-1"]),
  "plan-reviewer-family-1": (r) =>
    asAgentRoute(r["plan-reviewer"]) ?? asAgentRoute(r["plan-reviewer"]?.families?.["family-1"]),
  // family-2 / openai: second-eye slot. Only rewrite when secondEyeModel (or legacy family-2) is set.
  "plan-reviewer-family-2": (r) =>
    secondEyeRoute(r["plan-reviewer"]) ?? asAgentRoute(r["plan-reviewer"]?.families?.["family-2"]),
  "plan-reviewer-openai": (r) =>
    secondEyeRoute(r["plan-reviewer"]) ?? asAgentRoute(r["plan-reviewer"]?.families?.["family-2"]),
  adversary: (r) => asAgentRoute(r.adversary) ?? asAgentRoute(r.adversary?.families?.["family-1"]),
  "adversary-family-1": (r) => asAgentRoute(r.adversary) ?? asAgentRoute(r.adversary?.families?.["family-1"]),
  "adversary-family-2": (r) => secondEyeRoute(r.adversary) ?? asAgentRoute(r.adversary?.families?.["family-2"]),
  "adversary-openai": (r) => secondEyeRoute(r.adversary) ?? asAgentRoute(r.adversary?.families?.["family-2"]),
  "executor-low": (r) => asAgentRoute(r.executor?.tiers?.low),
  "executor-medium": (r) => asAgentRoute(r.executor?.tiers?.medium),
  "executor-high": (r) => asAgentRoute(r.executor?.tiers?.high),
  "sniper-low": (r) => asAgentRoute(r.sniper?.tiers?.low),
  "sniper-medium": (r) => asAgentRoute(r.sniper?.tiers?.medium),
  "sniper-high": (r) => asAgentRoute(r.sniper?.tiers?.high),
});

/** @description Backward-compat: basename → model string only. */
export const AGENT_MODEL_RESOLVERS = Object.freeze(
  Object.fromEntries(
    Object.entries(AGENT_ROUTE_RESOLVERS).map(([name, resolve]) => [
      name,
      (r) => resolve(r)?.model,
    ]),
  ),
);

/**
 * @description Extract `{ model, reasoningEffort? }` from a role/tier node (drops secondEyeModel etc).
 * @param {unknown} node
 * @returns {{ model: string, reasoningEffort?: unknown } | undefined}
 */
function asAgentRoute(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  if (typeof node.model !== "string" || !node.model.includes("/")) return undefined;
  /** @type {{ model: string, reasoningEffort?: unknown }} */
  const route = { model: node.model };
  if (Object.hasOwn(node, "reasoningEffort") && node.reasoningEffort !== undefined && node.reasoningEffort !== null && node.reasoningEffort !== "") {
    route.reasoningEffort = node.reasoningEffort;
  }
  return route;
}

/**
 * @description Second-eye route carries model only (no effort field on secondEyeModel slot).
 * @param {unknown} node
 * @returns {{ model: string } | undefined}
 */
function secondEyeRoute(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  if (typeof node.secondEyeModel !== "string" || !node.secondEyeModel.includes("/")) return undefined;
  return { model: node.secondEyeModel };
}

/**
 * @description Touchpoints the skill must update (documentation + apply surface).
 * @returns {readonly string[]}
 */
export function listRoutingTouchpoints() {
  return Object.freeze([
    "harness.routing.json (roles + modelCapabilities; optional secondEyeModel + reasoningEffort)",
    "agents/*.md frontmatter model: + reasoningEffort: (all agents with model — see AGENT_ROUTE_RESOLVERS)",
    "AGENTS.md §8 Model routing table",
    "opencode.json / opencode.json.example model + small_model (when present next to root)",
  ]);
}

/**
 * @description Provider prefix of a model slug (`openai/gpt` → `openai`).
 * @param {unknown} model
 * @returns {string}
 */
export function providerOf(model) {
  if (typeof model !== "string" || !model.includes("/")) return "";
  return model.split("/")[0];
}

/**
 * @description Collect every model string referenced by a routing config.
 * @param {object} routing
 * @returns {string[]}
 */
export function collectRoutingModels(routing) {
  const out = [];
  const roles = routing?.roles ?? {};
  for (const key of ["build", "planner", "compliance", "security", "test-author", "harvester", "shipper"]) {
    if (typeof roles[key]?.model === "string") out.push(roles[key].model);
  }
  for (const tier of ["low", "medium", "high"]) {
    if (typeof roles.executor?.tiers?.[tier]?.model === "string") out.push(roles.executor.tiers[tier].model);
    if (typeof roles.sniper?.tiers?.[tier]?.model === "string") out.push(roles.sniper.tiers[tier].model);
  }
  for (const review of ["plan-reviewer", "adversary"]) {
    if (typeof roles[review]?.model === "string") out.push(roles[review].model);
    if (typeof roles[review]?.secondEyeModel === "string") out.push(roles[review].secondEyeModel);
    for (const fam of ["family-1", "family-2"]) {
      if (typeof roles[review]?.families?.[fam]?.model === "string") {
        out.push(roles[review].families[fam].model);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * @description Ensure modelCapabilities has an entry for every model in routing.
 * @param {object} routing
 * @param {{ supportsReasoningEffort?: boolean }} [defaults]
 * @returns {object}
 */
export function withCapabilitiesForModels(routing, defaults = {}) {
  const caps = { ...(routing.modelCapabilities && typeof routing.modelCapabilities === "object" ? routing.modelCapabilities : {}) };
  const defaultSre = defaults.supportsReasoningEffort === true;
  for (const model of collectRoutingModels(routing)) {
    if (!caps[model] || typeof caps[model].supportsReasoningEffort !== "boolean") {
      const provider = providerOf(model);
      const sre =
        typeof defaults.perProvider?.[provider] === "boolean"
          ? defaults.perProvider[provider]
          : provider === "openai"
            ? true
            : defaultSre;
      caps[model] = { supportsReasoningEffort: sre };
    }
  }
  return { ...routing, modelCapabilities: caps };
}

/**
 * @description Build a single-evaluator routing config from product slots.
 *
 * Coarse slots still fill clusters; optional `roles` overlays any role afterward.
 * Every model-bearing value accepts a slug string OR `{ model, reasoningEffort? }`.
 * Power-user escape hatch: pass a complete `routing` document and skip slot assembly.
 *
 * @param {object} slots
 * @returns {{ ok: true, routing: object } | { ok: false, reason: string }}
 */
const ALLOWED_SLOT_KEYS = Object.freeze([
  "primaryEye",
  "secondaryEye",
  "supportEye",
  "hands",
  "testAuthor",
  "supportsReasoningEffort",
  "roles",
  "routing",
]);
const ALLOWED_HAND_TIERS = Object.freeze(["low", "medium", "high"]);
const ALLOWED_ROLE_OVERRIDES = Object.freeze([
  "build",
  "planner",
  "plan-reviewer",
  "adversary",
  "compliance",
  "security",
  "test-author",
  "harvester",
  "shipper",
  "executor",
  "sniper",
]);
const ROUTE_KEYS = Object.freeze(["model", "reasoningEffort"]);

/**
 * @description Parse a model slug or `{ model, reasoningEffort? }` into a route object.
 * @param {unknown} value
 * @param {string} label
 * @returns {{ ok: true, route: { model: string, reasoningEffort?: unknown } } | { ok: false, reason: string }}
 */
export function parseRouteValue(value, label) {
  if (typeof value === "string") {
    const model = value.trim();
    if (!model.includes("/")) {
      return { ok: false, reason: `${label} must be a provider/model slug` };
    }
    return { ok: true, route: { model } };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const unknown = Object.keys(value).filter((k) => !ROUTE_KEYS.includes(k));
    if (unknown.length > 0) {
      return {
        ok: false,
        reason: `${label}: unknown key(s): ${unknown.join(", ")} — valid keys: ${ROUTE_KEYS.join(", ")}`,
      };
    }
    if (typeof value.model !== "string" || !value.model.trim().includes("/")) {
      return { ok: false, reason: `${label}.model must be a provider/model slug` };
    }
    /** @type {{ model: string, reasoningEffort?: unknown }} */
    const route = { model: value.model.trim() };
    if (value.reasoningEffort !== undefined && value.reasoningEffort !== null && value.reasoningEffort !== "") {
      route.reasoningEffort = value.reasoningEffort;
    }
    return { ok: true, route };
  }
  return { ok: false, reason: `${label} must be a provider/model slug or { model, reasoningEffort? }` };
}

/**
 * @description Overlay a role override onto assembled roles. Accepts simple route or tiered executor/sniper.
 * @param {object} roles
 * @param {string} roleName
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function applyRoleOverride(roles, roleName, value) {
  if (roleName === "executor" || roleName === "sniper") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, reason: `roles.${roleName} must be { tiers: { low|medium|high: route } }` };
    }
    const tiersIn = value.tiers && typeof value.tiers === "object" && !Array.isArray(value.tiers) ? value.tiers : value;
    const unknownTiers = Object.keys(tiersIn).filter((t) => !ALLOWED_HAND_TIERS.includes(t));
    if (unknownTiers.length > 0) {
      return {
        ok: false,
        reason: `roles.${roleName}: unknown tier(s): ${unknownTiers.join(", ")} — valid tiers: ${ALLOWED_HAND_TIERS.join(", ")}`,
      };
    }
    if (!roles[roleName]?.tiers) {
      roles[roleName] = { tiers: { low: { model: "" }, medium: { model: "" }, high: { model: "" } } };
    }
    for (const tier of ALLOWED_HAND_TIERS) {
      if (!Object.hasOwn(tiersIn, tier)) continue;
      const parsed = parseRouteValue(tiersIn[tier], `roles.${roleName}.${tier}`);
      if (!parsed.ok) return parsed;
      roles[roleName].tiers[tier] = { ...parsed.route };
    }
    return { ok: true };
  }

  const parsed = parseRouteValue(value, `roles.${roleName}`);
  if (!parsed.ok) return parsed;
  const prev = roles[roleName] && typeof roles[roleName] === "object" ? roles[roleName] : {};
  /** @type {Record<string, unknown>} */
  const next = { ...parsed.route };
  // Preserve optional secondEyeModel when only model/effort is overridden.
  if (typeof prev.secondEyeModel === "string") next.secondEyeModel = prev.secondEyeModel;
  roles[roleName] = next;
  return { ok: true };
}

export function buildRoutingFromSlots(slots) {
  try {
    if (!slots || typeof slots !== "object" || Array.isArray(slots)) {
      return { ok: false, reason: "slots must be an object" };
    }
    // Reject unknown/typo keys instead of silently defaulting them — a mistyped slot
    // (e.g. `supportEyes`) must fail loud, never produce a degraded-but-valid routing.
    const unknownKeys = Object.keys(slots).filter((k) => !ALLOWED_SLOT_KEYS.includes(k));
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        reason: `unknown slot key(s): ${unknownKeys.join(", ")} — valid keys: ${ALLOWED_SLOT_KEYS.join(", ")}`,
      };
    }

    // Full-document escape hatch: operator supplies a complete routing object.
    if (slots.routing !== undefined) {
      if (slots.routing == null || typeof slots.routing !== "object" || Array.isArray(slots.routing)) {
        return { ok: false, reason: "routing must be an object" };
      }
      const other = Object.keys(slots).filter((k) => k !== "routing" && k !== "supportsReasoningEffort");
      if (other.length > 0) {
        return {
          ok: false,
          reason: `routing escape hatch is exclusive — remove: ${other.join(", ")}`,
        };
      }
      const perProvider = slots?.supportsReasoningEffort ?? {};
      const withCaps = withCapabilitiesForModels(structuredClone(slots.routing), {
        supportsReasoningEffort: false,
        perProvider: { openai: true, ...perProvider },
      });
      const v = validateRouting(withCaps);
      if (!v.ok) return { ok: false, reason: v.reason };
      return { ok: true, routing: withCaps };
    }

    if (slots.hands && typeof slots.hands === "object" && !Array.isArray(slots.hands)) {
      const unknownTiers = Object.keys(slots.hands).filter((t) => !ALLOWED_HAND_TIERS.includes(t));
      if (unknownTiers.length > 0) {
        return {
          ok: false,
          reason: `unknown hands tier(s): ${unknownTiers.join(", ")} — valid tiers: ${ALLOWED_HAND_TIERS.join(", ")}`,
        };
      }
    }
    if (slots.roles !== undefined) {
      if (!slots.roles || typeof slots.roles !== "object" || Array.isArray(slots.roles)) {
        return { ok: false, reason: "roles must be an object of per-role overrides" };
      }
      const unknownRoles = Object.keys(slots.roles).filter((r) => !ALLOWED_ROLE_OVERRIDES.includes(r));
      if (unknownRoles.length > 0) {
        return {
          ok: false,
          reason: `unknown roles override(s): ${unknownRoles.join(", ")} — valid roles: ${ALLOWED_ROLE_OVERRIDES.join(", ")}`,
        };
      }
    }

    const primaryParsed = parseRouteValue(slots?.primaryEye ?? "", "primaryEye");
    if (!primaryParsed.ok) return primaryParsed;
    const primaryEye = primaryParsed.route.model;
    const primaryRoute = primaryParsed.route;

    const secondaryEyeRaw = slots?.secondaryEye;
    const secondaryEye =
      secondaryEyeRaw === undefined || secondaryEyeRaw === null || secondaryEyeRaw === ""
        ? ""
        : String(secondaryEyeRaw).trim();
    if (secondaryEye && !secondaryEye.includes("/")) {
      return { ok: false, reason: "secondaryEye must be a provider/model slug when set" };
    }
    if (secondaryEye && providerOf(primaryEye) === providerOf(secondaryEye)) {
      return {
        ok: false,
        reason: "second eye exige provider diferente do avaliador único. Escolha um secondaryEye de outro provider.",
      };
    }

    const supportParsed = parseRouteValue(slots?.supportEye ?? primaryRoute, "supportEye");
    if (!supportParsed.ok) return supportParsed;
    const supportRoute = supportParsed.route;

    const handsIn = slots?.hands ?? {
      low: "openai/gpt-5.6-luna",
      medium: "openai/gpt-5.6-luna",
      high: "openai/gpt-5.6-terra",
    };
    /** @type {Record<string, { model: string, reasoningEffort?: unknown }>} */
    const hands = {};
    for (const t of ALLOWED_HAND_TIERS) {
      const parsed = parseRouteValue(handsIn[t], `hands.${t}`);
      if (!parsed.ok) return parsed;
      hands[t] = parsed.route;
    }

    // test-author rides the eyes tier by default (oracle that makes cheap hands safe).
    const testAuthorParsed = parseRouteValue(slots?.testAuthor ?? primaryRoute, "testAuthor");
    if (!testAuthorParsed.ok) return testAuthorParsed;

    /** @type {Record<string, unknown>} */
    const reviewRole = { ...primaryRoute };
    if (secondaryEye) reviewRole.secondEyeModel = secondaryEye;

    /** @type {object} */
    const routing = {
      version: 2,
      roles: {
        build: { ...primaryRoute },
        planner: { ...primaryRoute },
        "plan-reviewer": { ...reviewRole },
        adversary: { ...reviewRole },
        compliance: { ...supportRoute },
        security: { ...supportRoute },
        executor: {
          tiers: {
            low: { ...hands.low },
            medium: { ...hands.medium },
            high: { ...hands.high },
          },
        },
        sniper: {
          tiers: {
            low: { ...hands.low },
            medium: { ...hands.medium },
            high: { ...hands.high },
          },
        },
        "test-author": { ...testAuthorParsed.route },
        harvester: { ...supportRoute },
        shipper: { ...supportRoute },
      },
      modelCapabilities: {},
    };

    if (slots.roles) {
      for (const [roleName, value] of Object.entries(slots.roles)) {
        const applied = applyRoleOverride(routing.roles, roleName, value);
        if (!applied.ok) return applied;
      }
    }

    const perProvider = slots?.supportsReasoningEffort ?? {};
    const withCaps = withCapabilitiesForModels(routing, {
      supportsReasoningEffort: false,
      perProvider: { openai: true, ...perProvider },
    });
    const v = validateRouting(withCaps);
    if (!v.ok) return { ok: false, reason: v.reason };
    return { ok: true, routing: withCaps };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "buildRoutingFromSlots failed" };
  }
}

/**
 * @description Single source of truth for the shipped default routing (the three-layer
 * OpenAI architecture: terra produces, sol verifies, luna supports and handles low/medium hands).
 * The committed `harness.routing.json` must stay deep-equal to `withCapabilitiesForModels`
 * of this constant — enforced by a drift-guard test. Presets DERIVE from here so the
 * default preset can never re-introduce a stale layout that overwrites the template.
 * No `$schema` / `modelCapabilities` here: those are added at derivation time.
 */
export const CANONICAL_DEFAULT_ROUTING = Object.freeze({
  version: 2,
  roles: {
    build: { model: "openai/gpt-5.6-terra" },
    planner: { model: "openai/gpt-5.6-sol" },
    "plan-reviewer": { model: "openai/gpt-5.6-sol" },
    adversary: { model: "openai/gpt-5.6-sol" },
    compliance: { model: "openai/gpt-5.6-terra" },
    security: { model: "openai/gpt-5.6-sol" },
    executor: {
      tiers: {
        low: { model: "openai/gpt-5.6-luna" },
        medium: { model: "openai/gpt-5.6-luna" },
        high: { model: "openai/gpt-5.6-terra" },
      },
    },
    sniper: {
      tiers: {
        low: { model: "openai/gpt-5.6-luna" },
        medium: { model: "openai/gpt-5.6-luna" },
        high: { model: "openai/gpt-5.6-terra" },
      },
    },
    "test-author": { model: "openai/gpt-5.6-sol" },
    harvester: { model: "openai/gpt-5.6-luna" },
    shipper: { model: "openai/gpt-5.6-luna" },
  },
});

/**
 * @description Deep-clone a routing object, replacing every `openai/*` eye model with `target`.
 * Ollama hands / family-2 / test-author are untouched (they are not openai-prefixed). Used to
 * derive a single-provider eye variant (e.g. Grok) from the canonical layout — a transformation,
 * not a hand-authored parallel layout that could drift.
 * @param {object} routing
 * @param {string} target  provider/model slug to substitute for openai eyes
 * @returns {object}
 */
function remapOpenAIEyesTo(routing, target) {
  const clone = structuredClone(routing);
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "model" && typeof value === "string" && value.startsWith("openai/")) {
        node[key] = target;
      } else if (value && typeof value === "object") {
        walk(value);
      }
    }
  };
  walk(clone.roles);
  return clone;
}

/**
 * @description Deep-clone routing, setting/clearing second-eye slots (flat + legacy families).
 * Used to strip optional second-eye models before the required-slot Grok ban.
 * @param {object} routing
 * @param {string} model  provider/model slug; empty clears second eye
 * @returns {object}
 */
function withSecondEyeModel(routing, model) {
  const clone = structuredClone(routing);
  for (const roleName of ["plan-reviewer", "adversary"]) {
    const role = clone.roles?.[roleName];
    if (!role || typeof role !== "object") continue;
    if (typeof model === "string" && model.includes("/")) {
      role.secondEyeModel = model;
    } else {
      delete role.secondEyeModel;
      // Legacy families shape: blank family-2 so collectRoutingModels skips the optional eye.
      if (role.families?.["family-2"] && typeof role.families["family-2"] === "object") {
        delete role.families["family-2"].model;
      }
    }
  }
  return clone;
}

/** @description Shipped single-evaluator presets (all pass validateRouting), derived from the canonical layout. */
export function listPresets() {
  const openai = withCapabilitiesForModels(structuredClone(CANONICAL_DEFAULT_ROUTING), {
    perProvider: { openai: true },
  });
  // Grok eyes + optional Ollama second eye (fail-open) + Ollama hands.
  const xai = withCapabilitiesForModels(
    withSecondEyeModel(remapOpenAIEyesTo(CANONICAL_DEFAULT_ROUTING, "xai/grok-4.5"), "ollama-cloud/kimi-k2.7-code"),
    { perProvider: { xai: true } },
  );
  return Object.freeze([
    {
      id: "openai-ollama-default",
      label_pt: "Padrão — olhos OpenAI (terra produz · sol verifica · luna suporta) + mãos Luna → Terra",
      routing: openai,
    },
    {
      id: "xai-ollama-dual",
      label_pt: "Olhos Grok (xAI) + second eye/hands Ollama (segundo olho opt-in)",
      routing: xai,
    },
  ]);
}

/**
 * @description Resolve a preset id to validated routing. A preset carries either a literal
 * `routing` (canonical-derived, preferred) or legacy `slots` (built via buildRoutingFromSlots).
 * @param {string} presetId
 * @returns {{ ok: true, routing: object, preset: object } | { ok: false, reason: string }}
 */
export function routingFromPreset(presetId) {
  const preset = listPresets().find((p) => p.id === presetId);
  if (!preset) return { ok: false, reason: `unknown preset: ${presetId}` };
  if (preset.routing) {
    const v = validateRouting(preset.routing);
    if (!v.ok) return { ok: false, reason: `preset ${presetId}: ${v.reason}` };
    return { ok: true, routing: preset.routing, preset };
  }
  if (preset.slots) {
    const built = buildRoutingFromSlots(preset.slots);
    if (!built.ok) return built;
    return { ok: true, routing: built.routing, preset };
  }
  return { ok: false, reason: `preset ${presetId} has neither routing nor slots` };
}

/**
 * @description Replace frontmatter `model:` line in agent markdown (effort untouched).
 * @param {string} body
 * @param {string} model
 * @returns {{ ok: true, body: string, changed: boolean } | { ok: false, reason: string }}
 */
export function replaceFrontmatterModel(body, model) {
  if (typeof body !== "string" || !body.startsWith("---")) {
    return { ok: false, reason: "agent file missing frontmatter" };
  }
  if (typeof model !== "string" || !model.includes("/")) {
    return { ok: false, reason: "invalid model slug" };
  }
  const end = body.indexOf("\n---", 3);
  if (end < 0) return { ok: false, reason: "agent frontmatter not closed" };
  const fm = body.slice(0, end + 4);
  const rest = body.slice(end + 4);
  if (!/^model:\s*\S+/m.test(fm)) {
    return { ok: true, body, changed: false };
  }
  const nextFm = fm.replace(/^model:\s*\S+/m, `model: ${model}`);
  return { ok: true, body: nextFm + rest, changed: nextFm !== fm };
}

/**
 * @description Replace frontmatter `model:` and sync `reasoningEffort:` from a route.
 * When route has no reasoningEffort, any existing frontmatter effort line is removed
 * so stale effort cannot stick after a reconfigure.
 * OpenCode passes unknown agent frontmatter keys through to the provider (reasoningEffort).
 * @param {string} body
 * @param {{ model: string, reasoningEffort?: unknown }} route
 * @returns {{ ok: true, body: string, changed: boolean } | { ok: false, reason: string }}
 */
export function replaceFrontmatterRoute(body, route) {
  const modelOnly = replaceFrontmatterModel(body, route?.model);
  if (!modelOnly.ok) return modelOnly;

  const end = modelOnly.body.indexOf("\n---", 3);
  if (end < 0) return { ok: false, reason: "agent frontmatter not closed" };
  const fm = modelOnly.body.slice(0, end + 4);
  const rest = modelOnly.body.slice(end + 4);

  const hasEffort = route
    && Object.hasOwn(route, "reasoningEffort")
    && route.reasoningEffort !== undefined
    && route.reasoningEffort !== null
    && route.reasoningEffort !== "";
  const effortLineRe = /^reasoningEffort:\s*.+$/m;
  let nextFm = fm;

  if (hasEffort) {
    const effortLine = `reasoningEffort: ${stringifyFrontmatterScalar(route.reasoningEffort)}`;
    if (effortLineRe.test(nextFm)) {
      nextFm = nextFm.replace(effortLineRe, effortLine);
    } else {
      // Insert immediately after the model line so provider options stay grouped.
      nextFm = nextFm.replace(/^(model:\s*\S+)(\r?\n)/m, `$1$2${effortLine}$2`);
    }
  } else if (effortLineRe.test(nextFm)) {
    nextFm = nextFm.replace(/^reasoningEffort:\s*.+(\r?\n)?/m, "");
  }

  const nextBody = nextFm + rest;
  return { ok: true, body: nextBody, changed: nextBody !== body };
}

/**
 * @description YAML-ish scalar for frontmatter (strings unquoted when safe).
 * @param {unknown} value
 * @returns {string}
 */
function stringifyFrontmatterScalar(value) {
  if (typeof value === "string") {
    // Quote only when the value would be ambiguous in YAML.
    if (value === "" || /[:#{}[\],&*!|>'"%@`]|^\s|\s$/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * @description Rewrite AGENTS.md §8 model table from routing.
 * @param {string} agentsMd
 * @param {object} routing
 * @returns {{ ok: true, body: string, changed: boolean } | { ok: false, reason: string }}
 */
export function rewriteAgentsModelTable(agentsMd, routing) {
  if (typeof agentsMd !== "string") return { ok: false, reason: "AGENTS.md missing" };
  const roles = routing?.roles;
  if (!roles) return { ok: false, reason: "routing.roles missing" };
  const planReviewer =
    roles["plan-reviewer"]?.model ?? roles["plan-reviewer"]?.families?.["family-1"]?.model;
  const adversary =
    roles.adversary?.model ?? roles.adversary?.families?.["family-1"]?.model;
  const secondEye =
    roles.adversary?.secondEyeModel ??
    roles["plan-reviewer"]?.secondEyeModel ??
    roles.adversary?.families?.["family-2"]?.model ??
    roles["plan-reviewer"]?.families?.["family-2"]?.model;
  const secondEyeLine = secondEye
    ? `Optional \`secondEyeModel\` \`${secondEye}\` is fail-open — never blocks delivery.`
    : "Optional `secondEyeModel` (absent by default) is fail-open — never blocks delivery.";
  const table = [
    "## 8. Model routing (operator default)",
    "",
    "| Role | Model |",
    "|---|---|",
    `| build | \`${roles.build?.model}\` |`,
    `| planner | \`${roles.planner?.model}\` |`,
    `| plan-reviewer | \`${planReviewer}\` |`,
    `| adversary | \`${adversary}\` |`,
    `| compliance | \`${roles.compliance?.model}\` |`,
    `| security | \`${roles.security?.model}\` |`,
    `| executor/sniper low | \`${roles.executor?.tiers?.low?.model}\` |`,
    `| executor/sniper medium | \`${roles.executor?.tiers?.medium?.model}\` |`,
    `| executor/sniper high | \`${roles.executor?.tiers?.high?.model}\` |`,
    `| test-author | \`${roles["test-author"]?.model}\` |`,
    `| harvester / shipper | \`${roles.harvester?.model}\` |`,
    "",
    `**Single evaluator** on plan-reviewer and adversary. ${secondEyeLine}`,
    "Default hands use the OpenAI Luna → Terra ladder. Reconfigure via skill `oc-configuring-model-routing`.",
  ].join("\n");

  const re =
    /## 8\. Model routing \(operator default\)\n[\s\S]*?(?=\n---\n|\n## 9\. Hands vs eyes)/;
  if (!re.test(agentsMd)) {
    return { ok: false, reason: "AGENTS.md §8 Model routing section not found" };
  }
  const next = agentsMd.replace(re, `${table}\n\n`);
  return { ok: true, body: next, changed: next !== agentsMd };
}

/**
 * @description Resolve OC root: directory that contains harness.routing.json and agents/.
 * @param {string} targetRoot project root or core/opencode path
 * @returns {{ ok: true, ocRoot: string, mode: "source" | "vendored" } | { ok: false, reason: string }}
 */
export function resolveOcRoot(targetRoot) {
  if (typeof targetRoot !== "string" || !targetRoot) {
    return { ok: false, reason: "targetRoot required" };
  }
  const abs = path.resolve(targetRoot);
  const direct = path.join(abs, "harness.routing.json");
  if (fs.existsSync(direct) && fs.existsSync(path.join(abs, "agents"))) {
    return { ok: true, ocRoot: abs, mode: path.basename(abs) === "opencode" ? "source" : "vendored" };
  }
  const vendored = path.join(abs, ".opencode", "harness.routing.json");
  if (fs.existsSync(vendored) && fs.existsSync(path.join(abs, ".opencode", "agents"))) {
    return { ok: true, ocRoot: path.join(abs, ".opencode"), mode: "vendored" };
  }
  return { ok: false, reason: "harness.routing.json + agents/ not found under targetRoot" };
}

/** @description Eye providers treated as strong (security/compliance floors). */
export function isStrongEyeModel(model) {
  const p = providerOf(model);
  return p === "openai" || p === "xai";
}

/** @description True when slug looks like xAI/Grok (CI-banned on committed core). */
export function isXaiOrGrokModel(model) {
  return typeof model === "string" && /(?:^xai\/|grok)/i.test(model);
}

/**
 * @description Opencode.json paths allowed for rewrite — never walk above targetRoot.
 * @param {string} targetRootAbs
 * @param {string} ocRoot
 * @param {string | undefined} explicit
 * @returns {string[]}
 */
export function collectOpencodeJsonCandidates(targetRootAbs, ocRoot, explicit) {
  const root = path.resolve(targetRootAbs);
  const oc = path.resolve(ocRoot);
  /** @type {string[]} */
  const raw = [];
  if (typeof explicit === "string" && explicit.length > 0) raw.push(path.resolve(explicit));
  raw.push(path.join(oc, "opencode.json.example"));
  raw.push(path.join(oc, "opencode.json"));
  // Project root when ocRoot is project/.opencode
  if (path.basename(oc) === ".opencode") {
    raw.push(path.join(path.dirname(oc), "opencode.json"));
  }
  // When targetRoot itself is the project (vendored resolve uses project as targetRoot)
  raw.push(path.join(root, "opencode.json"));

  const out = [];
  for (const p of raw) {
    const abs = path.resolve(p);
    const underRoot = abs === root || abs.startsWith(root + path.sep);
    const underOc = abs === oc || abs.startsWith(oc + path.sep);
    if (!underRoot && !underOc) continue;
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/**
 * @description Write file via temp + rename. Returns previous content (null if new).
 * @param {string} filePath
 * @param {string} content
 * @returns {string | null}
 */
function writeFileStaged(filePath, content) {
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
  return prev;
}

/**
 * @description Restore snapshot map path → previous content|null (null = delete if we created).
 * @param {Map<string, string | null>} snapshot
 */
function restoreSnapshot(snapshot) {
  for (const [filePath, prev] of snapshot.entries()) {
    try {
      if (prev === null) {
        fs.rmSync(filePath, { force: true });
      } else {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, prev, "utf8");
      }
    } catch {
      /* best-effort restore */
    }
  }
}

/**
 * @description Apply routing to disk. Validates first; stages all contents then writes with rollback on error.
 * @param {{
 *   targetRoot: string,
 *   routing: object,
 *   updateOpencodeJson?: boolean,
 *   opencodeJsonPath?: string,
 *   forceCoreGrok?: boolean,
 *   confirmWeakEyes?: boolean,
 *   confirmWeakJudgmentEyes?: boolean,
 * }} args
 * @returns {{ ok: true, changed: string[], warnings: string[] } | { ok: false, reason: string }}
 */
export function applyRoutingToDisk(args) {
  /** @type {Map<string, string | null>} */
  const writtenSnapshot = new Map();
  try {
    const routingIn = args?.routing;
    const v = validateRouting(routingIn);
    if (!v.ok) return { ok: false, reason: `validateRouting: ${v.reason}` };

    const resolved = resolveOcRoot(args.targetRoot);
    if (!resolved.ok) return resolved;
    const { ocRoot, mode } = resolved;
    const targetRootAbs = path.resolve(args.targetRoot);

    let routing = withCapabilitiesForModels(routingIn, {
      supportsReasoningEffort: false,
      perProvider: { openai: true, xai: true },
    });

    // Preserve $schema and unknown top-level keys from existing routing file
    const routingPath = path.join(ocRoot, "harness.routing.json");
    if (fs.existsSync(routingPath)) {
      try {
        const prevObj = JSON.parse(fs.readFileSync(routingPath, "utf8"));
        if (prevObj && typeof prevObj === "object" && !Array.isArray(prevObj) && prevObj.$schema) {
          routing = { $schema: prevObj.$schema, ...routing };
        }
      } catch {
        /* ignore malformed previous */
      }
    }

    const v2 = validateRouting(routing);
    if (!v2.ok) return { ok: false, reason: `validateRouting after caps: ${v2.reason}` };

    // Optional secondEyeModel is exempt — CI bans xAI/Grok only in required slots.
    const requiredSlotRouting = withSecondEyeModel(routing, "");
    const models = collectRoutingModels(requiredSlotRouting).filter(Boolean);
    if (mode === "source" && models.some(isXaiOrGrokModel) && args.forceCoreGrok !== true) {
      return {
        ok: false,
        reason:
          "xAI/Grok models blocked on harness source outside the optional secondEyeModel (CI model-routing.test). " +
          "Apply to project .opencode/ or pass forceCoreGrok:true.",
      };
    }

    const supportModels = [
      routing.roles?.compliance?.model,
      routing.roles?.security?.model,
      routing.roles?.harvester?.model,
      routing.roles?.shipper?.model,
    ].filter((m) => typeof m === "string");
    const weakSupport = supportModels.filter((m) => !isStrongEyeModel(m));
    if (weakSupport.length > 0 && args.confirmWeakEyes !== true) {
      return {
        ok: false,
        reason:
          `support eyes fracos (${weakSupport.join(", ")}) em compliance/security/harvester/shipper — confirme com confirmWeakEyes:true (enfraquece o safety net).`,
      };
    }

    // Judgment eyes (plan-reviewer + adversary) are the harness safety net
    // (strong-eyes-cheap-hands). A cheap model here silently downgrades the
    // gate to a rubber stamp — floor them behind a dedicated confirm, never confirmWeakEyes.
    const judgmentModels = [
      routing.roles?.["plan-reviewer"]?.model ?? routing.roles?.["plan-reviewer"]?.families?.["family-1"]?.model,
      routing.roles?.adversary?.model ?? routing.roles?.adversary?.families?.["family-1"]?.model,
    ].filter((m) => typeof m === "string");
    const weakJudgment = judgmentModels.filter((m) => !isStrongEyeModel(m));
    if (weakJudgment.length > 0 && args.confirmWeakJudgmentEyes !== true) {
      return {
        ok: false,
        reason:
          `judgment eyes fracos (plan-reviewer/adversary: ${weakJudgment.join(", ")}) — rebaixa o safety net do harness a carimbo; confirme com confirmWeakJudgmentEyes:true.`,
      };
    }

    /** @type {string[]} */
    const warnings = [];
    if (models.some(isXaiOrGrokModel) && mode === "vendored") {
      warnings.push("routing uses xAI/Grok on vendored project — ok for local; do not promote to core source without forceCoreGrok + CI update.");
    }
    if (weakSupport.length > 0) {
      warnings.push(`weak support eyes confirmed: ${weakSupport.join(", ")}`);
    }
    if (weakJudgment.length > 0) {
      warnings.push(`weak JUDGMENT eyes confirmed (safety net degraded): ${weakJudgment.join(", ")}`);
    }

    // Stage all intended writes in memory first
    /** @type {Array<{ path: string, content: string }>} */
    const planned = [];

    const nextRouting = `${JSON.stringify(routing, null, 2)}\n`;
    const prevRouting = fs.existsSync(routingPath) ? fs.readFileSync(routingPath, "utf8") : null;
    if (prevRouting !== nextRouting) {
      planned.push({ path: routingPath, content: nextRouting });
    }

    const agentsDir = path.join(ocRoot, "agents");
    for (const [basename, resolveRoute] of Object.entries(AGENT_ROUTE_RESOLVERS)) {
      const file = path.join(agentsDir, `${basename}.md`);
      if (!fs.existsSync(file)) continue;
      const route = resolveRoute(routing.roles);
      if (!route || typeof route.model !== "string" || !route.model.includes("/")) {
        // Optional second-eye stubs: leave frontmatter untouched when secondEyeModel is absent.
        if (/-family-2$|-openai$/.test(basename)) continue;
        return { ok: false, reason: `no model resolved for agent ${basename}.md` };
      }
      const body = fs.readFileSync(file, "utf8");
      const replaced = replaceFrontmatterRoute(body, route);
      if (!replaced.ok) {
        return { ok: false, reason: `${basename}.md: ${replaced.reason}` };
      }
      if (replaced.changed) {
        planned.push({ path: file, content: replaced.body });
      }
    }

    const agentsMdPath = path.join(ocRoot, "AGENTS.md");
    if (fs.existsSync(agentsMdPath)) {
      const md = fs.readFileSync(agentsMdPath, "utf8");
      const rewritten = rewriteAgentsModelTable(md, routing);
      if (!rewritten.ok) {
        return { ok: false, reason: rewritten.reason };
      }
      if (rewritten.changed) {
        planned.push({ path: agentsMdPath, content: rewritten.body });
      }
    } else {
      warnings.push("AGENTS.md not found under ocRoot");
    }

    if (args.updateOpencodeJson !== false) {
      const candidates = collectOpencodeJsonCandidates(targetRootAbs, ocRoot, args.opencodeJsonPath);
      const primary = routing.roles.build?.model;
      const small = routing.roles.compliance?.model ?? routing.roles.security?.model;
      for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        let json;
        try {
          json = JSON.parse(fs.readFileSync(p, "utf8"));
        } catch {
          return { ok: false, reason: `could not parse ${p}` };
        }
        let dirty = false;
        if (typeof primary === "string" && json.model !== primary) {
          json.model = primary;
          dirty = true;
        }
        if (typeof small === "string" && json.small_model !== small) {
          json.small_model = small;
          dirty = true;
        }
        if (dirty) {
          planned.push({ path: p, content: `${JSON.stringify(json, null, 2)}\n` });
        }
      }
    }

    // Commit planned writes with rollback
    /** @type {string[]} */
    const changed = [];
    for (const item of planned) {
      try {
        const prev = writeFileStaged(item.path, item.content);
        writtenSnapshot.set(item.path, prev);
        changed.push(item.path);
      } catch (err) {
        restoreSnapshot(writtenSnapshot);
        return {
          ok: false,
          reason: `write failed on ${item.path}: ${err instanceof Error ? err.message : String(err)}; rolled back`,
        };
      }
    }

    return { ok: true, changed, warnings };
  } catch (err) {
    if (writtenSnapshot.size > 0) restoreSnapshot(writtenSnapshot);
    return { ok: false, reason: err instanceof Error ? err.message : "applyRoutingToDisk failed" };
  }
}

export default {
  listRoutingTouchpoints,
  AGENT_MODEL_RESOLVERS,
  AGENT_ROUTE_RESOLVERS,
  parseRouteValue,
  buildRoutingFromSlots,
  listPresets,
  routingFromPreset,
  applyRoutingToDisk,
  replaceFrontmatterRoute,
  validateRouting,
};
