/**
 * @description Deterministic apply of harness.routing.json → agents frontmatter + AGENTS.md table.
 * Skill elicits; this module writes. Never throws for validation failure — returns { ok, reason }.
 */
import fs from "node:fs";
import path from "node:path";
import { validateRouting } from "../../../../shared/lib/routing-validate.mjs";

export { validateRouting };

/** @description Agent basename (no .md) → resolver of model string from routing roles. */
export const AGENT_MODEL_RESOLVERS = Object.freeze({
  build: (r) => r.build?.model,
  plan: (r) => r.build?.model,
  "harness-config": (r) => r.build?.model,
  planner: (r) => r.planner?.model,
  "planner-fallback": (r) => r.planner?.fallback?.model,
  compliance: (r) => r.compliance?.model,
  security: (r) => r.security?.model,
  harvester: (r) => r.harvester?.model,
  shipper: (r) => r.shipper?.model,
  "test-author": (r) => r["test-author"]?.model,
  "plan-reviewer": (r) => r["plan-reviewer"]?.families?.["family-1"]?.model,
  "plan-reviewer-family-1": (r) => r["plan-reviewer"]?.families?.["family-1"]?.model,
  "plan-reviewer-family-2": (r) => r["plan-reviewer"]?.families?.["family-2"]?.model,
  "plan-reviewer-openai": (r) => r["plan-reviewer"]?.families?.["family-2"]?.model,
  adversary: (r) => r.adversary?.families?.["family-1"]?.model,
  "adversary-family-1": (r) => r.adversary?.families?.["family-1"]?.model,
  "adversary-family-2": (r) => r.adversary?.families?.["family-2"]?.model,
  "adversary-openai": (r) => r.adversary?.families?.["family-2"]?.model,
  "executor-low": (r) => r.executor?.tiers?.low?.model,
  "executor-medium": (r) => r.executor?.tiers?.medium?.model,
  "executor-high": (r) => r.executor?.tiers?.high?.model,
  "sniper-low": (r) => r.sniper?.tiers?.low?.model,
  "sniper-medium": (r) => r.sniper?.tiers?.medium?.model,
  "sniper-high": (r) => r.sniper?.tiers?.high?.model,
});

/**
 * @description Touchpoints the skill must update (documentation + apply surface).
 * @returns {readonly string[]}
 */
export function listRoutingTouchpoints() {
  return Object.freeze([
    "harness.routing.json (roles + modelCapabilities + constraints)",
    "agents/*.md frontmatter model: (all agents with model field — see AGENT_MODEL_RESOLVERS)",
    "AGENTS.md §8 Model routing table",
    "opencode.json / opencode.json.example model + small_model (when present next to root)",
    "planner-fallback.md only when roles.planner.fallback is set",
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
  if (typeof roles.planner?.fallback?.model === "string") out.push(roles.planner.fallback.model);
  for (const tier of ["low", "medium", "high"]) {
    if (typeof roles.executor?.tiers?.[tier]?.model === "string") out.push(roles.executor.tiers[tier].model);
    if (typeof roles.sniper?.tiers?.[tier]?.model === "string") out.push(roles.sniper.tiers[tier].model);
  }
  for (const review of ["plan-reviewer", "adversary"]) {
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
 * @description Build a valid dual-safe routing config from product slots.
 * family-1 and family-2 MUST be different providers (validator requirement).
 * @param {{
 *   primaryEye: string,
 *   secondaryEye: string,
 *   supportEye?: string,
 *   hands?: { low: string, medium: string, high: string },
 *   testAuthor?: string,
 *   plannerFallback?: string | null,
 *   supportsReasoningEffort?: Record<string, boolean>,
 * }} slots
 * @returns {{ ok: true, routing: object } | { ok: false, reason: string }}
 */
const ALLOWED_SLOT_KEYS = Object.freeze([
  "primaryEye",
  "secondaryEye",
  "supportEye",
  "hands",
  "testAuthor",
  "plannerFallback",
  "supportsReasoningEffort",
]);
const ALLOWED_HAND_TIERS = Object.freeze(["low", "medium", "high"]);

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
    if (slots.hands && typeof slots.hands === "object" && !Array.isArray(slots.hands)) {
      const unknownTiers = Object.keys(slots.hands).filter((t) => !ALLOWED_HAND_TIERS.includes(t));
      if (unknownTiers.length > 0) {
        return {
          ok: false,
          reason: `unknown hands tier(s): ${unknownTiers.join(", ")} — valid tiers: ${ALLOWED_HAND_TIERS.join(", ")}`,
        };
      }
    }
    const primaryEye = String(slots?.primaryEye ?? "").trim();
    const secondaryEye = String(slots?.secondaryEye ?? "").trim();
    const supportEye = String(slots?.supportEye ?? primaryEye).trim();
    if (!primaryEye.includes("/") || !secondaryEye.includes("/")) {
      return { ok: false, reason: "primaryEye and secondaryEye must be provider/model slugs" };
    }
    if (providerOf(primaryEye) === providerOf(secondaryEye)) {
      return {
        ok: false,
        reason: "dual exige providers diferentes (family-1 ≠ family-2). Escolha um secondaryEye de outro provider.",
      };
    }
    const hands = slots?.hands ?? {
      low: "ollama-cloud/gemma4:31b",
      medium: "ollama-cloud/glm-5.2",
      high: "ollama-cloud/kimi-k2.7-code",
    };
    for (const t of ["low", "medium", "high"]) {
      if (typeof hands[t] !== "string" || !hands[t].includes("/")) {
        return { ok: false, reason: `hands.${t} must be provider/model slug` };
      }
    }
    const testAuthor = String(slots?.testAuthor ?? hands.medium).trim();
    // Planner is primary-only by default (no model ladder). Opt-in via plannerFallback slug.
    const fallback =
      typeof slots?.plannerFallback === "string" && slots.plannerFallback.includes("/")
        ? { model: slots.plannerFallback }
        : undefined;

    /** @type {object} */
    const routing = {
      version: 2,
      roles: {
        build: { model: primaryEye },
        planner: fallback ? { model: primaryEye, fallback } : { model: primaryEye },
        "plan-reviewer": {
          families: {
            "family-1": {
              model: primaryEye,
              primary: true,
              optional: false,
              countsLoop: true,
            },
            "family-2": {
              model: secondaryEye,
              primary: false,
              optional: true,
              countsLoop: false,
            },
          },
        },
        adversary: {
          families: {
            "family-1": {
              model: primaryEye,
              primary: true,
              optional: false,
              countsLoop: true,
            },
            "family-2": {
              model: secondaryEye,
              primary: false,
              optional: true,
              countsLoop: false,
            },
          },
        },
        compliance: { model: supportEye },
        security: { model: supportEye },
        executor: {
          tiers: {
            low: { model: hands.low },
            medium: { model: hands.medium },
            high: { model: hands.high },
          },
        },
        sniper: {
          tiers: {
            low: { model: hands.low },
            medium: { model: hands.medium },
            high: { model: hands.high },
          },
        },
        "test-author": { model: testAuthor },
        harvester: { model: supportEye },
        shipper: { model: supportEye },
      },
      constraints: {
        crossFamilyRoles: ["plan-reviewer", "adversary"],
        requireDualOn: ["plan-reviewer", "adversary"],
      },
      modelCapabilities: {},
    };

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
 * OpenAI-eyes architecture: terra produces, sol verifies, luna supports; Ollama hands).
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
    "plan-reviewer": {
      families: {
        "family-1": { model: "openai/gpt-5.6-sol", primary: true, optional: false, countsLoop: true },
        "family-2": { model: "xai/grok-4.5", primary: false, optional: true, countsLoop: false },
      },
    },
    adversary: {
      families: {
        "family-1": { model: "openai/gpt-5.6-sol", primary: true, optional: false, countsLoop: true },
        "family-2": { model: "xai/grok-4.5", primary: false, optional: true, countsLoop: false },
      },
    },
    compliance: { model: "openai/gpt-5.6-terra" },
    security: { model: "openai/gpt-5.6-sol" },
    executor: {
      tiers: {
        low: { model: "ollama-cloud/gemma4:31b" },
        medium: { model: "ollama-cloud/glm-5.2" },
        high: { model: "ollama-cloud/kimi-k2.7-code" },
      },
    },
    sniper: {
      tiers: {
        low: { model: "ollama-cloud/gemma4:31b" },
        medium: { model: "ollama-cloud/glm-5.2" },
        high: { model: "ollama-cloud/kimi-k2.7-code" },
      },
    },
    "test-author": { model: "ollama-cloud/glm-5.2" },
    harvester: { model: "openai/gpt-5.6-luna" },
    shipper: { model: "openai/gpt-5.6-luna" },
  },
  constraints: {
    crossFamilyRoles: ["plan-reviewer", "adversary"],
    requireDualOn: ["plan-reviewer", "adversary"],
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
 * @description Deep-clone a routing object, replacing the family-2 eye of every cross-family role.
 * Used to keep a derived preset dual-valid when its family-1 remap would otherwise collide with
 * the canonical family-2 provider.
 * @param {object} routing
 * @param {string} model  provider/model slug for the secondary eye
 * @returns {object}
 */
function withSecondaryEye(routing, model) {
  const clone = structuredClone(routing);
  for (const role of Object.values(clone.roles ?? {})) {
    const secondary = role?.families?.["family-2"];
    if (secondary && typeof secondary === "object") secondary.model = model;
  }
  return clone;
}

/** @description Shipped dual-safe presets (all pass validateRouting), derived from the canonical layout. */
export function listPresets() {
  const openai = withCapabilitiesForModels(structuredClone(CANONICAL_DEFAULT_ROUTING), {
    perProvider: { openai: true },
  });
  // The canonical family-2 eye is xAI, so remapping the family-1 eyes to xAI would collapse both
  // families onto one provider (validator: "same provider across families"). Push family-2 back to
  // the Ollama ladder — which is exactly what this preset's label promises.
  const xai = withCapabilitiesForModels(
    withSecondaryEye(remapOpenAIEyesTo(CANONICAL_DEFAULT_ROUTING, "xai/grok-4.5"), "ollama-cloud/kimi-k2.7-code"),
    { perProvider: { xai: true } },
  );
  return Object.freeze([
    {
      id: "openai-ollama-default",
      label_pt: "Padrão dual — olhos OpenAI (terra produz · sol verifica · luna suporta) + hands Ollama",
      routing: openai,
    },
    {
      id: "xai-ollama-dual",
      label_pt: "Olhos Grok (xAI, camadas colapsadas em grok-4.5) + family-2/hands Ollama (dual válido)",
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
 * @description Replace frontmatter `model:` line in agent markdown.
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
 * @description Rewrite AGENTS.md §8 model table from routing.
 * @param {string} agentsMd
 * @param {object} routing
 * @returns {{ ok: true, body: string, changed: boolean } | { ok: false, reason: string }}
 */
export function rewriteAgentsModelTable(agentsMd, routing) {
  if (typeof agentsMd !== "string") return { ok: false, reason: "AGENTS.md missing" };
  const roles = routing?.roles;
  if (!roles) return { ok: false, reason: "routing.roles missing" };
  const f1 = roles["plan-reviewer"]?.families?.["family-1"]?.model;
  const f2 = roles["plan-reviewer"]?.families?.["family-2"]?.model;
  const a1 = roles.adversary?.families?.["family-1"]?.model;
  const a2 = roles.adversary?.families?.["family-2"]?.model;
  const table = [
    "## 8. Model routing (operator default)",
    "",
    "| Role | Model |",
    "|---|---|",
    `| build | \`${roles.build?.model}\` |`,
    `| planner | \`${roles.planner?.model}\` |`,
    `| plan-reviewer | required family 1 \`${f1}\` + optional family 2 \`${f2}\` |`,
    `| adversary | required family 1 \`${a1}\` + optional family 2 \`${a2}\` |`,
    `| compliance | \`${roles.compliance?.model}\` |`,
    `| security | \`${roles.security?.model}\` |`,
    `| executor/sniper low | \`${roles.executor?.tiers?.low?.model}\` |`,
    `| executor/sniper medium | \`${roles.executor?.tiers?.medium?.model}\` |`,
    `| executor/sniper high | \`${roles.executor?.tiers?.high?.model}\` |`,
    `| test-author | \`${roles["test-author"]?.model}\` |`,
    `| harvester / shipper | \`${roles.harvester?.model}\` |`,
    "",
    "**Family 1 is mandatory; family 2 is optional and fail-open** on plan-reviewer and adversary (two `task` dispatches + shared merge when available).",
    "Default hands use the Ollama Cloud ladder. Reconfigure via skill `oc-configuring-model-routing`.",
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

    // The optional family-2 eye is exempt — it is the shipped default there, and CI
    // (model-routing.test) bans xAI/Grok only in the slots the harness requires.
    const requiredSlotRouting = withSecondaryEye(routing, "");
    const models = collectRoutingModels(requiredSlotRouting).filter(Boolean);
    if (mode === "source" && models.some(isXaiOrGrokModel) && args.forceCoreGrok !== true) {
      return {
        ok: false,
        reason:
          "xAI/Grok models blocked on harness source outside the optional family-2 eye (CI model-routing.test). " +
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

    // Judgment eyes (required family-1 of plan-reviewer + adversary) are the harness
    // safety net (strong-eyes-cheap-hands). A cheap model here silently downgrades the
    // gate to a rubber stamp — floor them behind a dedicated confirm, never confirmWeakEyes.
    const judgmentModels = [
      routing.roles?.["plan-reviewer"]?.families?.["family-1"]?.model,
      routing.roles?.adversary?.families?.["family-1"]?.model,
    ].filter((m) => typeof m === "string");
    const weakJudgment = judgmentModels.filter((m) => !isStrongEyeModel(m));
    if (weakJudgment.length > 0 && args.confirmWeakJudgmentEyes !== true) {
      return {
        ok: false,
        reason:
          `judgment eyes fracos (family-1 de plan-reviewer/adversary: ${weakJudgment.join(", ")}) — rebaixa o safety net do harness a carimbo; confirme com confirmWeakJudgmentEyes:true.`,
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
    for (const [basename, resolveModel] of Object.entries(AGENT_MODEL_RESOLVERS)) {
      const file = path.join(agentsDir, `${basename}.md`);
      if (!fs.existsSync(file)) continue;
      const model = resolveModel(routing.roles);
      if (typeof model !== "string" || !model.includes("/")) {
        if (basename === "planner-fallback" && !routing.roles.planner?.fallback) continue;
        return { ok: false, reason: `no model resolved for agent ${basename}.md` };
      }
      const body = fs.readFileSync(file, "utf8");
      const replaced = replaceFrontmatterModel(body, model);
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
  buildRoutingFromSlots,
  listPresets,
  routingFromPreset,
  applyRoutingToDisk,
  validateRouting,
};
