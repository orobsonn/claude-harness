import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MODEL_PROFILE_ENV = "PI_HARNESS_MODEL_PROFILE";
export const MODEL_PROFILE_HASH_ENV = "PI_HARNESS_MODEL_PROFILE_SHA256";
export const MODEL_PROFILE_VERSION = 4;
export const OLLAMA_CONTEXT_WINDOW = 262_144;
export const LEGACY_OLLAMA_CONTEXT_WINDOW = 1_000_000;
export const OLLAMA_PROVIDER = "ollama-cloud";
export const OLLAMA_ENDPOINT = "https://ollama.com/v1";
export const DEEPSEEK_MODEL = "deepseek-v4.1-flash";
export const GLM_MODEL = "glm-5.3";
export const DEFAULT_MODEL_PROFILE = "trial-orchestration-deepseek";

const COMPLEXITIES = Object.freeze(["low", "medium", "high", "max"]);
const SUPPORTED_MODEL_PROFILE_VERSIONS = new Set([1, 2, 3, MODEL_PROFILE_VERSION]);
const PARENT_TARGETS = new Set(["baseline", "deepseek"]);

const BASELINE_FIXED = Object.freeze({
  "harness-support": Object.freeze({ model: "openai-codex/gpt-5.6-terra", thinking: "high" }),
  "harness-planner": Object.freeze({ model: "openai-codex/gpt-5.6-sol", thinking: "high" }),
  "harness-plan-reviewer": Object.freeze({ model: "openai-codex/gpt-6-astra", thinking: "high" }),
  "harness-test-reviewer": Object.freeze({ model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" }),
  "harness-adversary": Object.freeze({ model: "openai-codex/gpt-5.6-sol", thinking: "medium" }),
  "harness-security": Object.freeze({ model: "openai-codex/gpt-5.6-sol" }),
  "harness-compliance": Object.freeze({ model: "openai-codex/gpt-5.6-terra", thinking: "high" }),
  "harness-harvester": Object.freeze({ model: "openai-codex/gpt-5.6-luna", thinking: "high" }),
  "harness-shipper": Object.freeze({ model: "openai-codex/gpt-5.6-luna", thinking: "high" }),
  "harness-discussion-adversary": Object.freeze({ model: "openai-codex/gpt-5.6-sol", thinking: "medium" }),
});

const BASELINE_HANDS = Object.freeze({
  low: Object.freeze({ model: "openai-codex/gpt-5.6-luna", thinking: "high" }),
  medium: Object.freeze({ model: "openai-codex/gpt-5.6-terra", thinking: "medium" }),
  high: Object.freeze({ model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" }),
  max: Object.freeze({ model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" }),
});

// Keep v1-v3 routes byte-for-byte canonical: an admitted session must never
// silently switch models when the vendored launcher is updated.
const CURRENT_FIXED = Object.freeze(Object.fromEntries(Object.entries(BASELINE_FIXED).map(([role, route]) => [
  role, Object.freeze({ ...route, model: route.model.replace("gpt-5.6-terra", "gpt-6-sol")
    .replace("gpt-5.6-sol", "gpt-6-sol").replace("gpt-5.6-luna", "gpt-6-luna") }),
])));
const CURRENT_HANDS = Object.freeze(Object.fromEntries(Object.entries(BASELINE_HANDS).map(([tier, route]) => [
  tier, Object.freeze({ ...route, model: route.model.replace("gpt-5.6-terra", "gpt-6-sol")
    .replace("gpt-5.6-luna", "gpt-6-luna") }),
])));

const PROFILE_DEFAULTS = Object.freeze({
  baseline: Object.freeze({ handModel: null, globalParent: "baseline", localParent: "baseline" }),
  "trial-hands-deepseek": Object.freeze({ handModel: DEEPSEEK_MODEL, globalParent: "baseline", localParent: "baseline" }),
  "trial-hands-glm": Object.freeze({ handModel: GLM_MODEL, globalParent: "baseline", localParent: "baseline" }),
  "trial-orchestration-deepseek": Object.freeze({ handModel: DEEPSEEK_MODEL, globalParent: "deepseek", localParent: "deepseek" }),
});

const LEGACY_PROFILE_DEFAULTS = Object.freeze({
  ...PROFILE_DEFAULTS,
  "trial-hands-deepseek": Object.freeze({ handModel: "tiered-open", globalParent: "baseline", localParent: "baseline" }),
  "trial-orchestration-deepseek": Object.freeze({ handModel: "tiered-open", globalParent: "deepseek", localParent: "deepseek" }),
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function stableProfileJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

export function hashModelProfile(value) {
  return createHash("sha256").update(stableProfileJson(value)).digest("hex");
}

function ollamaRoute(model) {
  return { model: `${OLLAMA_PROVIDER}/${model}`, thinking: "high" };
}

function parentRoute(target) {
  return target === "deepseek"
    ? { provider: OLLAMA_PROVIDER, model: DEEPSEEK_MODEL, thinking_requested: "high", thinking_effective: "high" }
    : null;
}

export function resolveModelProfile({ profile = DEFAULT_MODEL_PROFILE, globalParent, localParent, budgetUsd = null,
  version = MODEL_PROFILE_VERSION } = {}) {
  if (!SUPPORTED_MODEL_PROFILE_VERSIONS.has(version)) throw new Error(`unsupported harness model profile version: ${String(version)}`);
  const defaults = (version === 1 ? LEGACY_PROFILE_DEFAULTS : PROFILE_DEFAULTS)[profile];
  if (!defaults) throw new Error(`unknown harness model profile: ${String(profile)}`);
  const selectedGlobal = globalParent ?? defaults.globalParent;
  const selectedLocal = localParent ?? defaults.localParent;
  if (!PARENT_TARGETS.has(selectedGlobal)) throw new Error(`invalid global parent target: ${String(selectedGlobal)}`);
  if (!PARENT_TARGETS.has(selectedLocal)) throw new Error(`invalid local parent target: ${String(selectedLocal)}`);
  if (budgetUsd !== null && (!Number.isFinite(Number(budgetUsd)) || Number(budgetUsd) <= 0)) {
    throw new Error("harness Ollama budget must be a positive USD amount");
  }
  const handRoute = defaults.handModel && defaults.handModel !== "tiered-open" ? ollamaRoute(defaults.handModel) : null;
  const fixedRoutes = version < 4 ? BASELINE_FIXED : CURRENT_FIXED;
  const handRoutes = version < 4 ? BASELINE_HANDS : CURRENT_HANDS;
  const handTiers = Object.fromEntries(COMPLEXITIES.map((complexity) => [
    complexity,
    defaults.handModel === "tiered-open"
      ? ollamaRoute(["high", "max"].includes(complexity) ? GLM_MODEL : DEEPSEEK_MODEL)
      : handRoute ? { ...handRoute } : { ...handRoutes[complexity] },
  ]));
  const testAuthorTiers = defaults.handModel
    ? Object.fromEntries(COMPLEXITIES.map((complexity) => [complexity, { ...handTiers[complexity] }]))
    : {
      low: { model: version < 4 ? "openai-codex/gpt-5.6-terra" : "openai-codex/gpt-6-sol", thinking: "high" },
      medium: { model: version < 4 ? "openai-codex/gpt-5.6-terra" : "openai-codex/gpt-6-sol", thinking: "high" },
      high: { model: version < 4 ? "openai-codex/gpt-5.6-sol" : "openai-codex/gpt-6-sol", thinking: "high" },
      max: { model: version < 4 ? "openai-codex/gpt-5.6-sol" : "openai-codex/gpt-6-sol", thinking: "high" },
    };
  const contextWindow = version <= 2 ? LEGACY_OLLAMA_CONTEXT_WINDOW : OLLAMA_CONTEXT_WINDOW;
  const snapshot = {
    version,
    profile,
    budget_usd: budgetUsd === null ? null : Number(budgetUsd),
    provider: {
      id: OLLAMA_PROVIDER,
      endpoint: OLLAMA_ENDPOINT,
      api: "openai-completions",
      credential_env: "OLLAMA_API_KEY",
      max_local_concurrency: 2,
    },
    models: {
      deepseek: { id: DEEPSEEK_MODEL, context_window: contextWindow, max_output_tokens: 32768 },
      glm: { id: GLM_MODEL, context_window: contextWindow, max_output_tokens: 32768 },
    },
    parents: {
      global: { target: selectedGlobal, route: parentRoute(selectedGlobal) },
      local: { target: selectedLocal, route: parentRoute(selectedLocal) },
    },
    routes: {
      fixed: Object.fromEntries(Object.entries(fixedRoutes).map(([role, route]) => [role, { ...route }])),
      hands: handTiers,
      test_author: testAuthorTiers,
    },
    capabilities: {
      streaming: true,
      structured_tools: true,
      reasoning_effort: true,
      stateful_responses: false,
      custom_tool_replay: false,
    },
  };
  return Object.freeze({ ...snapshot, sha256: hashModelProfile(snapshot) });
}

export function routeFromModelProfile(snapshot, role, complexity) {
  if (!snapshot || !SUPPORTED_MODEL_PROFILE_VERSIONS.has(snapshot.version)) return { ok: false, reason: "profile-snapshot" };
  if (role === "harness-test-author") {
    const route = snapshot.routes?.test_author?.[complexity];
    return route ? { ok: true, ...route } : { ok: false, reason: "hand-complexity" };
  }
  const fixed = snapshot.routes?.fixed?.[role];
  if (fixed) return { ok: true, ...fixed };
  if (role === "harness-executor" || role === "harness-sniper") {
    const route = snapshot.routes?.hands?.[complexity];
    return route ? { ok: true, ...route } : { ok: false, reason: "hand-complexity" };
  }
  return { ok: false, reason: "unknown-role" };
}

export function modelStrategyFromProfile(snapshot) {
  const model = (role) => routeFromModelProfile(snapshot, role).model;
  return {
    hand_tiers: {
      low: routeFromModelProfile(snapshot, "harness-executor", "low").model,
      medium: routeFromModelProfile(snapshot, "harness-executor", "medium").model,
      high: routeFromModelProfile(snapshot, "harness-executor", "high").model,
    },
    planner: model("harness-planner"),
    "plan-reviewer": model("harness-plan-reviewer"),
    compliance: model("harness-compliance"),
    adversary: model("harness-adversary"),
    security: model("harness-security"),
    shipper: model("harness-shipper"),
    harvester: model("harness-harvester"),
  };
}

export function profilePrompt(snapshot, { parentKind = null } = {}) {
  const profile = `<HARNESS_MODEL_PROFILE>\n${JSON.stringify({
    version: snapshot.version,
    profile: snapshot.profile,
    sha256: snapshot.sha256,
    parents: snapshot.parents,
    model_strategy: modelStrategyFromProfile(snapshot),
  })}\n</HARNESS_MODEL_PROFILE>`;
  if (!parentKind || snapshot.parents?.[parentKind]?.target === "baseline") return profile;
  return `${profile}\n\n<HARNESS_OPEN_PARENT_BOOTSTRAP>\n` +
    "Start every top-level request by applying harness-triage and calling classify. " +
    "Then follow the mode-specific ceremony. For LIGHT/FULL, complete the required spec and plan reviews, " +
    "admit work through harness_tasks, and let authorized writing hands implement product changes. " +
    "A local task parent must follow the admitted task runtime and delegate implementation to its writing hands. " +
    "Do not bypass the pipeline by implementing planned task changes directly.\n" +
    "</HARNESS_OPEN_PARENT_BOOTSTRAP>";
}

export function profileSnapshotPath(projectRoot, sessionId) {
  return path.join(projectRoot, ".pi", "harness", "state", "model-profiles", `${sessionId}.json`);
}

export function writeModelProfileSnapshot(projectRoot, sessionId, snapshot) {
  const file = profileSnapshotPath(projectRoot, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = stableProfileJson(snapshot);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== text) throw new Error("active session model profile is immutable");
  } else {
    fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
  }
  return { path: file, sha256: createHash("sha256").update(text).digest("hex") };
}

export function readModelProfileSnapshot(projectRoot, sessionId) {
  const file = profileSnapshotPath(projectRoot, sessionId);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    return error?.code === "ENOENT" ? { ok: false, absent: true, reason: "model profile snapshot missing" }
      : { ok: false, reason: "model profile snapshot unreadable" };
  }
  try {
    const value = JSON.parse(text);
    const expected = resolveModelProfile({
      version: value.version,
      profile: value.profile,
      globalParent: value.parents?.global?.target,
      localParent: value.parents?.local?.target,
      budgetUsd: value.budget_usd,
    });
    if (stableProfileJson(value) !== stableProfileJson(expected)) return { ok: false, reason: "model profile snapshot invalid" };
    return { ok: true, snapshot: value, path: file, fileSha256: createHash("sha256").update(text).digest("hex") };
  } catch {
    return { ok: false, reason: "model profile snapshot invalid" };
  }
}

export function loadModelProfileFromEnv(env = process.env) {
  const file = env[MODEL_PROFILE_ENV];
  const expectedHash = env[MODEL_PROFILE_HASH_ENV];
  // Extensions from sessions created before profile snapshots remain baseline.
  if (!file && !expectedHash) return resolveModelProfile({ profile: "baseline" });
  if (!file || !expectedHash || !path.isAbsolute(file)) throw new Error("incomplete admitted model profile environment");
  const text = fs.readFileSync(file, "utf8");
  const actualHash = createHash("sha256").update(text).digest("hex");
  if (actualHash !== expectedHash) throw new Error("admitted model profile hash mismatch");
  const value = JSON.parse(text);
  const expected = resolveModelProfile({
    version: value.version,
    profile: value.profile,
    globalParent: value.parents?.global?.target,
    localParent: value.parents?.local?.target,
    budgetUsd: value.budget_usd,
  });
  if (stableProfileJson(value) !== stableProfileJson(expected)) throw new Error("admitted model profile is not canonical");
  return value;
}

export function parseModelProfileArgs(argv) {
  const values = {};
  const remaining = [];
  const flags = new Map([
    ["--harness-profile", "profile"],
    ["--harness-global-parent", "globalParent"],
    ["--harness-local-parent", "localParent"],
    ["--harness-budget-usd", "budgetUsd"],
  ]);
  let inspect = false;
  const marker = argv.indexOf("--");
  const end = marker < 0 ? argv.length : marker;
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (index >= end) { remaining.push(entry); continue; }
    if (entry === "--harness-profile-inspect") {
      if (inspect) throw new Error("duplicate --harness-profile-inspect");
      inspect = true;
      continue;
    }
    const key = flags.get(entry);
    if (!key) { remaining.push(entry); continue; }
    if (values[key] !== undefined || index + 1 >= end || String(argv[index + 1]).startsWith("-")) {
      throw new Error(`${entry} requires one value`);
    }
    values[key] = String(argv[++index]);
  }
  return { argv: remaining, inspect, selection: values, explicit: Object.keys(values).length > 0 };
}

export { BASELINE_FIXED, BASELINE_HANDS, CURRENT_FIXED, CURRENT_HANDS, PROFILE_DEFAULTS };
