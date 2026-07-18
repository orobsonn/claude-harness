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
  planner: (r) => r.planner?.model,
  "planner-fallback": (r) => r.planner?.fallback?.model,
  compliance: (r) => r.compliance?.model,
  security: (r) => r.security?.model,
  harvester: (r) => r.harvester?.model,
  shipper: (r) => r.shipper?.model,
  "test-author": (r) => r["test-author"]?.model,
  "test-author-spawn": (r) => r["test-author"]?.model,
  "plan-reviewer": (r) => r["plan-reviewer"]?.families?.["family-1"]?.model,
  "plan-reviewer-family-1": (r) => r["plan-reviewer"]?.families?.["family-1"]?.model,
  "plan-reviewer-family-2": (r) => r["plan-reviewer"]?.families?.["family-2"]?.model,
  "plan-reviewer-openai": (r) => r["plan-reviewer"]?.families?.["family-2"]?.model,
  adversary: (r) => r.adversary?.families?.["family-1"]?.model,
  "adversary-family-1": (r) => r.adversary?.families?.["family-1"]?.model,
  "adversary-family-2": (r) => r.adversary?.families?.["family-2"]?.model,
  "adversary-openai": (r) => r.adversary?.families?.["family-2"]?.model,
  "executor-low": (r) => r.executor?.tiers?.low?.model,
  "executor-low-spawn": (r) => r.executor?.tiers?.low?.model,
  "executor-medium": (r) => r.executor?.tiers?.medium?.model,
  "executor-medium-spawn": (r) => r.executor?.tiers?.medium?.model,
  "executor-high": (r) => r.executor?.tiers?.high?.model,
  "executor-high-spawn": (r) => r.executor?.tiers?.high?.model,
  "sniper-low": (r) => r.sniper?.tiers?.low?.model,
  "sniper-low-spawn": (r) => r.sniper?.tiers?.low?.model,
  "sniper-medium": (r) => r.sniper?.tiers?.medium?.model,
  "sniper-medium-spawn": (r) => r.sniper?.tiers?.medium?.model,
  "sniper-high": (r) => r.sniper?.tiers?.high?.model,
  "sniper-high-spawn": (r) => r.sniper?.tiers?.high?.model,
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
export function buildRoutingFromSlots(slots) {
  try {
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
    const fallback =
      slots?.plannerFallback === null
        ? undefined
        : typeof slots?.plannerFallback === "string" && slots.plannerFallback.includes("/")
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

/** @description Shipped dual-safe presets (all pass validateRouting). */
export function listPresets() {
  return Object.freeze([
    {
      id: "openai-ollama-default",
      label_pt: "Padrão dual (olhos OpenAI + hands Ollama)",
      slots: {
        primaryEye: "openai/gpt-5.6-sol",
        secondaryEye: "ollama-cloud/kimi-k2.7-code",
        supportEye: "openai/gpt-5.5",
        hands: {
          low: "ollama-cloud/gemma4:31b",
          medium: "ollama-cloud/glm-5.2",
          high: "ollama-cloud/kimi-k2.7-code",
        },
        testAuthor: "ollama-cloud/glm-5.2",
      },
    },
    {
      id: "xai-ollama-dual",
      label_pt: "Olhos Grok (xAI) + family-2/hands Ollama (dual válido)",
      slots: {
        primaryEye: "xai/grok-4.5",
        secondaryEye: "ollama-cloud/kimi-k2.7-code",
        supportEye: "xai/grok-4.5",
        hands: {
          low: "ollama-cloud/gemma4:31b",
          medium: "ollama-cloud/glm-5.2",
          high: "ollama-cloud/kimi-k2.7-code",
        },
        testAuthor: "ollama-cloud/glm-5.2",
        supportsReasoningEffort: { xai: true },
      },
    },
  ]);
}

/**
 * @description Resolve a preset id to validated routing.
 * @param {string} presetId
 * @returns {{ ok: true, routing: object, preset: object } | { ok: false, reason: string }}
 */
export function routingFromPreset(presetId) {
  const preset = listPresets().find((p) => p.id === presetId);
  if (!preset) return { ok: false, reason: `unknown preset: ${presetId}` };
  const built = buildRoutingFromSlots(preset.slots);
  if (!built.ok) return built;
  return { ok: true, routing: built.routing, preset };
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
    "Default hands use the Ollama Cloud ladder. Reconfigure via skill `configuring-model-routing`.",
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

/**
 * @description Apply routing to disk. Validate first; on failure write nothing.
 * @param {{
 *   targetRoot: string,
 *   routing: object,
 *   updateOpencodeJson?: boolean,
 *   opencodeJsonPath?: string,
 * }} args
 * @returns {{ ok: true, changed: string[], warnings: string[] } | { ok: false, reason: string }}
 */
export function applyRoutingToDisk(args) {
  try {
    const routingIn = args?.routing;
    const v = validateRouting(routingIn);
    if (!v.ok) return { ok: false, reason: `validateRouting: ${v.reason}` };

    const resolved = resolveOcRoot(args.targetRoot);
    if (!resolved.ok) return resolved;
    const { ocRoot } = resolved;
    const routing = withCapabilitiesForModels(routingIn, {
      supportsReasoningEffort: false,
      perProvider: { openai: true },
    });
    const v2 = validateRouting(routing);
    if (!v2.ok) return { ok: false, reason: `validateRouting after caps: ${v2.reason}` };

    /** @type {string[]} */
    const changed = [];
    /** @type {string[]} */
    const warnings = [];

    const routingPath = path.join(ocRoot, "harness.routing.json");
    const prevRouting = fs.existsSync(routingPath) ? fs.readFileSync(routingPath, "utf8") : "";
    const nextRouting = `${JSON.stringify(routing, null, 2)}\n`;
    if (prevRouting !== nextRouting) {
      fs.writeFileSync(routingPath, nextRouting, "utf8");
      changed.push(routingPath);
    }

    const agentsDir = path.join(ocRoot, "agents");
    for (const [basename, resolveModel] of Object.entries(AGENT_MODEL_RESOLVERS)) {
      const file = path.join(agentsDir, `${basename}.md`);
      if (!fs.existsSync(file)) continue;
      const model = resolveModel(routing.roles);
      if (typeof model !== "string" || !model.includes("/")) {
        if (basename === "planner-fallback" && !routing.roles.planner?.fallback) continue;
        warnings.push(`skip ${basename}.md: no model resolved`);
        continue;
      }
      const body = fs.readFileSync(file, "utf8");
      const replaced = replaceFrontmatterModel(body, model);
      if (!replaced.ok) {
        warnings.push(`${basename}.md: ${replaced.reason}`);
        continue;
      }
      if (replaced.changed) {
        fs.writeFileSync(file, replaced.body, "utf8");
        changed.push(file);
      }
    }

    const agentsMdPath = path.join(ocRoot, "AGENTS.md");
    if (fs.existsSync(agentsMdPath)) {
      const md = fs.readFileSync(agentsMdPath, "utf8");
      const rewritten = rewriteAgentsModelTable(md, routing);
      if (!rewritten.ok) {
        warnings.push(rewritten.reason);
      } else if (rewritten.changed) {
        fs.writeFileSync(agentsMdPath, rewritten.body, "utf8");
        changed.push(agentsMdPath);
      }
    } else {
      warnings.push("AGENTS.md not found under ocRoot");
    }

    if (args.updateOpencodeJson !== false) {
      const candidates = [
        args.opencodeJsonPath,
        path.join(ocRoot, "opencode.json.example"),
        path.join(ocRoot, "opencode.json"),
        path.join(path.dirname(ocRoot), "opencode.json"),
        path.join(path.dirname(ocRoot), "..", "opencode.json"),
      ].filter((p) => typeof p === "string" && p.length > 0);
      const primary = routing.roles.build?.model;
      const small = routing.roles.compliance?.model ?? routing.roles.security?.model;
      for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        try {
          const raw = fs.readFileSync(p, "utf8");
          const json = JSON.parse(raw);
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
            fs.writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`, "utf8");
            changed.push(p);
          }
        } catch {
          warnings.push(`could not update ${p}`);
        }
      }
    }

    const models = collectRoutingModels(routing);
    if (models.some((m) => /(?:^xai\/|grok)/i.test(m))) {
      warnings.push(
        "routing uses xAI/Grok models — committed harness CI (model-routing.test) bans these on core surfaces; prefer project .opencode/ only, or update that test if intentional for source.",
      );
    }

    return { ok: true, changed, warnings };
  } catch (err) {
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
