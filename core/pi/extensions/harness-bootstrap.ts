import { getAgentDir, resolveCliModel, SettingsManager, type ExtensionAPI, type ExtensionContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import { installNativeHarnessAgents } from "../lib/native-bootstrap.mjs";

const CODEX_PROVIDER = "openai-codex";
const ASTRA_MODEL = "gpt-6-astra";

/** Validate native effective preferences; never select a model or change project trust. */
export function validateParentModelPreferences(settings: any, registry: any) {
  const errors = settings.drainErrors();
  if (errors.length) throw new Error("Invalid Pi settings JSON; repair the model preferences before launching.");
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  const thinking = settings.getDefaultThinkingLevel();
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (provider !== undefined || model !== undefined) {
    if (typeof provider !== "string" || typeof model !== "string" || !registry.find(provider, model)) {
      throw new Error(`Unknown Pi model preference ${String(provider)}/${String(model)}; select an installed model in Pi settings or restore the harness default.`);
    }
  }
  if (thinking !== undefined && !levels.includes(thinking)) {
    throw new Error("Invalid defaultThinkingLevel in Pi settings; select a supported thinking level.");
  }
  for (const [key, level] of Object.entries(settings.getAllModelThinkingLevels())) {
    if (typeof level !== "string" || !levels.includes(level)) {
      throw new Error(`Invalid modelThinkingLevels entry for ${key}; select a supported thinking level in Pi settings.`);
    }
  }
}

/**
 * Pi's public CLI resolver accepts a custom id by cloning a known provider
 * model, while pi-subagents only accepts models already in its registry. Add
 * that exact compatibility clone to the static Codex provider before the
 * subagents extension snapshots the registry. This is deliberately not a
 * model declaration: the harness does not assert Astra pricing or limits.
 */
function registerAstraCompatibilityModel(pi: ExtensionAPI) {
  const provider = builtinProviders().find((entry) => entry.id === CODEX_PROVIDER);
  if (!provider) throw new Error(`[harness-bootstrap] Missing pinned Pi provider: ${CODEX_PROVIDER}`);

  const baseModels = [...provider.getModels()];
  if (baseModels.some((model) => model.id === ASTRA_MODEL)) return;

  // `resolveCliModel` only reads getModels() on this fixed custom-id path. The
  // adapter keeps the extension independent from Pi's private ModelRuntime and
  // does not consult auth, the operator's models-store, or the network.
  const resolved = resolveCliModel({
    cliProvider: CODEX_PROVIDER,
    cliModel: ASTRA_MODEL,
    modelRuntime: { getModels: () => baseModels } as unknown as ModelRuntime,
  });
  if (!resolved.model || resolved.error) {
    throw new Error(`[harness-bootstrap] Cannot register ${CODEX_PROVIDER}/${ASTRA_MODEL}: ${resolved.error ?? "Pi custom-id resolver returned no model"}`);
  }

  pi.registerProvider({
    ...provider,
    getModels: () => [...baseModels, resolved.model!],
  });
}

/**
 * The launcher materializes package defaults in PI_CODING_AGENT_DIR before Pi
 * starts. Do not redirect it here: Pi writes its normal local state there.
 */
function isChildSession(ctx: ExtensionContext): boolean {
  try {
    return Boolean(ctx.sessionManager.getHeader()?.parentSession);
  } catch {
    return true;
  }
}

export default function harnessBootstrap(pi: ExtensionAPI) {
  // This runs while extensions load, before @gotgenes/pi-subagents assembles
  // its manager/snapshots. It must precede the launcher early return as the
  // launcher's isolated runtime needs the same registry entry.
  registerAstraCompatibilityModel(pi);

  let preferenceError: string | null = null;
  pi.on("before_agent_start", (_event, ctx) => {
    if (isChildSession(ctx)) return;
    try {
      const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
      validateParentModelPreferences(settings, ctx.modelRegistry);
      preferenceError = null;
    } catch (error) {
      preferenceError = `[harness-bootstrap] ${error instanceof Error ? error.message : String(error)}`;
      return { message: { customType: "harness-model-preferences-error", content: preferenceError, display: true } };
    }
  });
  pi.on("agent_start", (_event, ctx) => { if (preferenceError) ctx.abort(); });
  pi.on("tool_call", () => preferenceError ? { block: true, reason: preferenceError } : undefined);

  // O launcher já materializou sua árvore privada. Nesta condição não podemos tocar no estado
  // nativo/global, nem mesmo para "atualizar" arquivos que o launcher controla.
  if (process.env.PI_HARNESS_LAUNCHER === "1") return;

  const installed = installNativeHarnessAgents({ agentDir: getAgentDir() });
  if (!installed.ok) {
    const reason = `[harness-bootstrap] Blocked: native role bootstrap failed (${installed.reason}). Resolve the collision or asset error, then restart Pi.`;
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      console.error(reason);
    };
    pi.on("before_agent_start", (_event, ctx) => {
      report();
      // `before_agent_start` has no block result and no active Pi run yet. The companion
      // `agent_start` handler below aborts at the first lifecycle point where activeRun exists.
      return { message: { customType: "harness-bootstrap-error", content: reason, display: true } };
    });
    pi.on("agent_start", (_event, ctx) => {
      try {
        ctx.abort();
      } catch {
        // The tool-call block below still prevents any action if a malformed host context cannot abort.
      }
    });
    pi.on("tool_call", () => ({ block: true, terminate: true, reason }));
    return;
  }

  pi.on("before_agent_start", (event: any, ctx) => {
    if (isChildSession(ctx) || typeof event?.systemPrompt !== "string") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${installed.runtimePrompt}` };
  });
}
