/**
 * @description Lógica pura da tool nativa `classify` na lane Pi — espelho 1:1 de
 * core/opencode/tools/classify.ts (executeClassify). Toda a decisão é REUSADA por import:
 * decideClassifyTransition (escalate-only) de core/shared/lib/classify-stub.mjs,
 * decideClassifyAuthority de core/shared/lib/classify-authority.mjs e
 * persistClassifyState/FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE de
 * core/opencode/tools/lib/classify-persist.mjs (host-agnóstico, statePath explícito).
 *
 * A ÚNICA diferença para a lane OC é o prefixo de diretório: os caminhos vêm de
 * core/pi/lib/pi-paths.mjs (`.pi/harness/plans/` e `.pi/harness/state/`), nunca de
 * core/shared/lib/path-helpers.mjs (que só conhece `.claude`/`.opencode`).
 *
 * Autoridade no Pi: não existe nome de agente 'build' no principal, então a autoridade é a
 * AUSÊNCIA de parentSession — o chamador passa isChild (derivado de
 * ctx.sessionManager.getHeader()?.parentSession) e a mensagem de deny é a mesma do OC.
 *
 * classify NUNCA cria nem altera plano — só carimba gate-state.
 */

import fs from "node:fs";

import { decideClassifyTransition } from "../../shared/lib/classify-stub.mjs";
import { decideClassifyAuthority } from "../../shared/lib/classify-authority.mjs";
import { isSafeSessionId } from "../../shared/lib/feature-id.mjs";
import {
  FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE,
  persistClassifyState as defaultPersistClassifyState,
} from "../../opencode/tools/lib/classify-persist.mjs";
import {
  eventForPipelineType,
  obsAppend as defaultObsAppend,
} from "../../opencode/lib/obs-emit.mjs";
import { piExecutionPlanPath, piGateStatePath } from "./pi-paths.mjs";

/** Marcador de sessão filha usado como parentSessionId sintético (o Pi não expõe o id do pai
 * no header do filho de forma canônica; para a autoridade basta "existe pai"). */
const CHILD_PARENT_MARKER = "<child>";

/**
 * @description Monta o resultado de erro da tool no MESMO formato da lane OC
 * ({error, hint, received} serializado). Erro é RESULTADO, nunca exceção — o modelo lê o
 * texto e corrige a chamada. Nunca lança.
 * @param {string} error
 * @param {string} hint
 * @param {string} received
 * @returns {{content: Array<{type: 'text', text: string}>, details: Record<string, unknown>}}
 */
export function piClassifyErrorResult(error, hint, received) {
  const payload = { error, hint, received };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

/**
 * @description Texto de negação de classify em sessão filha (subagente). Derivado da própria
 * decideClassifyAuthority para garantir que seja BYTE-IDÊNTICO ao da lane OC — nunca uma
 * cópia do literal. Usado pelo rail (belt) no tool_call da extensão. Nunca lança.
 * @returns {string}
 */
export function piClassifyChildDenyReason() {
  const auth = decideClassifyAuthority({
    agent: "",
    parentSessionId: CHILD_PARENT_MARKER,
    sessionId: "",
  });
  return auth.ok ? "" : auth.reason;
}

/**
 * @description Lê o gate-state anterior de disco com a MESMA semântica da lane OC: qualquer
 * falha de leitura/parse vira estado vazio (fail-open — classify recomeça do zero em vez de
 * travar a sessão). Nunca lança.
 * @param {string} statePath
 * @returns {Record<string, unknown>}
 */
function readPriorState(statePath) {
  try {
    if (!fs.existsSync(statePath)) return {};
    const loaded = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      return /** @type {Record<string, unknown>} */ (loaded);
    }
  } catch {
    /* fail-open: estado ilegível = ainda não classificado */
  }
  return {};
}

/**
 * @description Executa a classify da lane Pi: valida identidade e autoridade, decide a
 * transição (escalate-only), persiste apenas fatos de triagem no gate-state e devolve o
 * caminho estável do plano. NUNCA cria nem altera plano. Nunca lança.
 * @param {{mode?: unknown, feature_id?: unknown}} args
 * @param {{projectRoot?: unknown, sessionId?: unknown, isChild?: unknown}} context
 * @param {{persistClassifyState?: Function, obsAppend?: Function}} [deps] injeção só para teste
 * @returns {{content: Array<{type: 'text', text: string}>, details: Record<string, unknown>}}
 */
export function executePiClassify(args = {}, context = {}, deps = {}) {
  const persist = deps.persistClassifyState ?? defaultPersistClassifyState;
  const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const featureId = typeof input.feature_id === "string" ? input.feature_id.trim() : "";
  const mode = typeof input.mode === "string" ? input.mode.trim() : "";
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : "";
  const projectRoot = typeof context.projectRoot === "string" ? context.projectRoot : "";

  if (!isSafeSessionId(sessionId)) {
    return piClassifyErrorResult(
      "invalid sessionID",
      "sessionID must pass isSafeSessionId",
      sessionId,
    );
  }

  // Belt: só a sessão de topo classifica (o rail primário é o entry-gate / tool_call).
  const parentSessionId = context.isChild === true ? CHILD_PARENT_MARKER : null;
  const auth = decideClassifyAuthority({ agent: "", parentSessionId, sessionId });
  if (!auth.ok) {
    return piClassifyErrorResult(
      auth.reason,
      "only top-level build may classify; hands/eyes execute their brief only",
      JSON.stringify({ agent: "", parentSessionId, sessionID: sessionId }),
    );
  }

  const gsPath = piGateStatePath({ projectRoot, sessionId });
  if (!gsPath.ok) {
    return piClassifyErrorResult("invalid gate-state path", gsPath.reason, sessionId);
  }

  const prior = readPriorState(gsPath.path);

  const transition = decideClassifyTransition({
    requestedMode: mode,
    requestedFeatureId: featureId,
    currentMode: prior.mode,
    currentFeatureId: prior.feature_id,
    peakMode: prior.peak_mode,
    classified: prior.classified === true || prior.triaged === true,
  });
  if (!transition.ok) {
    return piClassifyErrorResult(
      transition.reason,
      "classify is escalate-only for an active session+feature; never downgrade or switch feature mid-run",
      JSON.stringify({ mode, feature_id: featureId }),
    );
  }

  const finalMode = transition.mode;
  const finalFeatureId = transition.featureId;
  const peakMode = transition.peakMode;

  const pp = piExecutionPlanPath({ projectRoot, featureId: finalFeatureId });
  if (!pp.ok) {
    return piClassifyErrorResult("invalid plan path", pp.reason, finalFeatureId);
  }
  const planPath = pp.path;

  if (transition.action === "noop") {
    return classifyOkResult({
      plan_path: planPath,
      mode: finalMode,
      feature_id: finalFeatureId,
      action: "noop",
      peak_mode: peakMode,
    });
  }

  const statePatch = {
    session_id: sessionId,
    feature_id: finalFeatureId,
    mode: finalMode,
    peak_mode: peakMode,
    classified: true,
    triaged: true,
  };

  const persisted = persist({
    statePath: gsPath.path,
    statePatch,
    ...(transition.action === "fresh"
      ? { removeStateKeys: FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE }
      : {}),
  });
  if (!persisted?.ok) {
    return piClassifyErrorResult(
      "persistence failed",
      String(persisted?.reason ?? "unknown").slice(0, 200),
      planPath,
    );
  }

  // Observabilidade mid-run (#284, paridade com core/opencode/tools/classify.ts): evento
  // pipeline-type só na transição real (nunca no noop). Fail-open — obs jamais quebra classify.
  try {
    const append = deps.obsAppend ?? defaultObsAppend;
    const ev = eventForPipelineType(finalMode);
    if (ev) append(ev);
  } catch {
    /* fail-open */
  }

  return classifyOkResult({
    plan_path: planPath,
    mode: finalMode,
    feature_id: finalFeatureId,
    action: transition.action,
    peak_mode: peakMode,
  });
}

/**
 * @description Empacota o payload de sucesso no formato de resultado de tool do Pi
 * (content[0].text com o JSON + details com o mesmo objeto). Nunca lança.
 * @param {Record<string, unknown>} payload
 * @returns {{content: Array<{type: 'text', text: string}>, details: Record<string, unknown>}}
 */
function classifyOkResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export default {
  executePiClassify,
  piClassifyErrorResult,
  piClassifyChildDenyReason,
};
