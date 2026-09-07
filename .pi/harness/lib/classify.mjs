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

import { decideClassifyTransition } from "../vendor/shared/lib/classify-stub.mjs";
import { decideClassifyAuthority } from "../vendor/shared/lib/classify-authority.mjs";
import { isSafeSessionId } from "../vendor/shared/lib/feature-id.mjs";
import {
  FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE,
  persistClassifyState as defaultPersistClassifyState,
} from "../vendor/opencode/tools/lib/classify-persist.mjs";
import {
  eventForPipelineType,
  obsAppend as defaultObsAppend,
} from "../vendor/opencode/lib/obs-emit.mjs";
import { piExecutionPlanPath, piGateStatePath } from "./pi-paths.mjs";
import { TASK_PIPELINE_VERSION } from "./task-contract.mjs";

/** Marcador de sessão filha usado como parentSessionId sintético (o Pi não expõe o id do pai
 * no header do filho de forma canônica; para a autoridade basta "existe pai"). */
const CHILD_PARENT_MARKER = "<child>";
const PRISTINE_CLASSIFY_KEYS = new Set([
  "session_id",
  "feature_id",
  "mode",
  "peak_mode",
  "classified",
  "triaged",
  "task_pipeline_version",
]);

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
 * @description A parent can correct a typo in its initial feature id only before
 * any ceremony evidence exists. `classify` itself writes exactly the six fields
 * below and never creates a plan; every later gate appends evidence to this state
 * or creates the stable plan. This deliberately small recovery window prevents a
 * harmless spelling mistake from requiring a new TUI while preserving the
 * anti-laundering feature binding once work has started.
 * @param {Record<string, unknown>} prior
 * @param {string} projectRoot
 * @returns {boolean}
 */
function canCorrectInitialFeatureId(prior, projectRoot) {
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) return false;
  if (Object.keys(prior).some((key) => !PRISTINE_CLASSIFY_KEYS.has(key))) return false;
  if (prior.classified !== true || prior.triaged !== true) return false;
  if (typeof prior.feature_id !== "string" || typeof prior.mode !== "string") return false;
  const priorPlan = piExecutionPlanPath({ projectRoot, featureId: prior.feature_id });
  return priorPlan.ok && !fs.existsSync(priorPlan.path);
}

/**
 * @description Executa a classify da lane Pi: valida identidade e autoridade, decide a
 * transição (escalate-only), persiste apenas fatos de triagem no gate-state e devolve o
 * caminho estável do plano. NUNCA cria nem altera plano. Nunca lança.
 * @param {{mode?: unknown, feature_id?: unknown}} args
 * @param {{projectRoot?: unknown, sessionId?: unknown, isChild?: unknown, isHeadless?: boolean}} context
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
  if (context.isHeadless === true && mode !== "LIGHT" && mode !== "FULL") {
    return piClassifyErrorResult(
      "headless requires LIGHT or FULL ceremony",
      "Inline work is available only to an interactive local parent; classify the autonomous delivery before dispatch.",
      mode,
    );
  }
  if (!gsPath.ok) {
    return piClassifyErrorResult("invalid gate-state path", gsPath.reason, sessionId);
  }

  const prior = readPriorState(gsPath.path);

  // A typo in the first classify call is recoverable while there is provably no
  // plan or gate evidence. Once any evidence lands, use the shared strict
  // transition unchanged: a feature may not be swapped mid-ceremony.
  const correctingInitialFeatureId =
    prior.classified === true &&
    typeof prior.feature_id === "string" &&
    prior.feature_id !== featureId &&
    canCorrectInitialFeatureId(prior, projectRoot);
  const transition = decideClassifyTransition({
    requestedMode: mode,
    requestedFeatureId: featureId,
    currentMode: correctingInitialFeatureId ? undefined : prior.mode,
    currentFeatureId: correctingInitialFeatureId ? undefined : prior.feature_id,
    peakMode: correctingInitialFeatureId ? undefined : prior.peak_mode,
    classified: correctingInitialFeatureId ? false : prior.classified === true || prior.triaged === true,
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
    ...(["LIGHT", "FULL"].includes(finalMode) ? { task_pipeline_version: TASK_PIPELINE_VERSION } : {}),
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
