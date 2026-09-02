/**
 * @description Autoridade da tool `mark` da lane Pi — porte 1:1 de
 * core/opencode/plugin/marker-authority.ts. A tool e o hook de pré-execução compartilham
 * uma única autoridade privada de identidade de argumentos.
 *
 * Fronteira de ameaça (idêntica à da lane OC): a identidade Map(toolCallId)+WeakMap(input)
 * e a ordem dos eventos protegem apenas a invocação nativa de `mark`, barrando execute
 * direto, clones, replay, reuso concorrente e divergência de binding em runtime ANTES da
 * mutação. Os booleanos persistidos são estado de workflow, não proveniência nem isolamento
 * de SO. Um processo do mesmo usuário pode importar e instanciar sua própria autoridade ou
 * escrever o estado direto; um host/extensão comprometido também. Isso está fora da fronteira.
 *
 * Diferenças deliberadas em relação à lane OC (e só elas):
 *  - caminho de estado sob `.pi/harness/state/` (via core/pi/lib/pi-paths.mjs);
 *  - `event.toolCallId` do Pi entra num Map determinístico (o host garante a chave), em vez
 *    de depender só da identidade do objeto de args;
 *  - a restrição "capture-verified é do agente build" vira "capture-verified é da sessão PAI"
 *    (o Pi não tem nome de agente no contexto da tool), preservando o texto da reason.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { withGateStateLock } from "../../opencode/lib/gate-state.mjs";
import { mergeGateStatePatch } from "../../shared/lib/gate-state-shape.mjs";
import { isCaptureEligibleHandRecord, recordViolations } from "../../shared/lib/real-file-capture-rail.mjs";
import { formatFeatureTaskEntry } from "../../shared/lib/absolution.mjs";
import { isSafeFeatureId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { validateOcCaptureEligibleHandRecord } from "../../opencode/lib/hand-records.mjs";
import { isAncestorSha as defaultIsAncestorSha, resolveHeadSha as defaultResolveHeadSha } from "../../opencode/plugin/lib/host-hand-capture.mjs";
import { piGateStatePath, piHandRecordPath } from "./pi-paths.mjs";

/** @description Conjunto exato de ações privilegiadas aceitas pela tool `mark`. Mesmo Set da lane OC. */
export const MARKER_ACTIONS = new Set([
  "brainstormed",
  "adversary_fired",
  "fidelity",
  "regate-pending",
  "regate-passed",
  "hand-finished",
  "capture-verified",
  "final-review",
  "demo-done",
]);

/** @description Nome da tool que esta autoridade governa. */
export const MARKER_TOOL_NAME = "mark";

const DENY_PREFIX = "[marker-authority]";

/**
 * @description Monta o resultado da tool `mark` no mesmo formato de corpo da lane OC
 * ({ok, reason?, ...metadata} serializado em `output`). O adaptador do Pi só embrulha
 * `output` em content[] e `metadata` em details.
 * @param {boolean} ok
 * @param {string} [reason]
 * @param {Record<string, unknown>} [metadata]
 * @returns {{ ok: boolean, title: string, output: string, metadata: Record<string, unknown> }}
 */
export function markerResponse(ok, reason = "", metadata = {}) {
  const body = { ok, ...(reason ? { reason } : {}), ...metadata };
  return {
    ok,
    title: ok ? "mark: persisted" : "mark: rejected",
    output: JSON.stringify(body, null, 2),
    metadata: body,
  };
}

/**
 * @description Escrita JSON atômica (temp + rename). Nunca lança; devolve boolean.
 * @param {string} file
 * @param {Record<string, unknown>} value
 * @returns {boolean}
 */
function atomicJsonWrite(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return false;
  }
  const temporary = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

/**
 * @description Cria a autoridade de marcadores da lane Pi. Retorna o par (hook, tool):
 * `authorize` roda no evento `tool_call` (pode bloquear) e `execute` roda dentro da tool
 * registrada. Nenhuma das duas lança.
 *
 * As funções de dispatch-record vêm por injeção porque a peça `state-records` da lane Pi
 * (equivalente a core/opencode/lib/dispatch-scope.mjs, com raiz `.pi/harness/state/`) é
 * entregue separadamente: ausentes, a mutação de capture/hand-finished falha fechada com
 * 'exact producer dispatch record required'.
 *
 * @param {{
 *   projectRoot: string,
 *   readDispatchRecord?: (projectRoot: string, ids: { parentSessionId: string, callId: string }) => any,
 *   removeDispatchRecord?: (projectRoot: string, ids: { sessionId: string, callId: string }) => any,
 *   resolveHeadSha?: (projectRoot: string) => string | null,
 *   isAncestorSha?: (projectRoot: string, sha: string) => boolean | null,
 *   now?: () => string,
 * }} options
 * @returns {{
 *   authorize: (event: { toolName?: unknown, input?: unknown, sessionId?: unknown, toolCallId?: unknown }) =>
 *     undefined | { ok: true } | { ok: false, block: true, reason: string },
 *   execute: (call: { toolCallId?: unknown, params?: unknown, sessionId?: unknown, isChild?: unknown }) =>
 *     { ok: boolean, title: string, output: string, metadata: Record<string, unknown> },
 *   pendingCount: () => number,
 * }}
 */
export function createPiMarkerAuthority(options = {}) {
  const projectRoot = typeof options?.projectRoot === "string" ? options.projectRoot : "";
  const readDispatchRecord = typeof options?.readDispatchRecord === "function" ? options.readDispatchRecord : null;
  const removeDispatchRecord = typeof options?.removeDispatchRecord === "function" ? options.removeDispatchRecord : null;
  const resolveHeadSha = typeof options?.resolveHeadSha === "function" ? options.resolveHeadSha : defaultResolveHeadSha;
  const isAncestorSha = typeof options?.isAncestorSha === "function" ? options.isAncestorSha : defaultIsAncestorSha;
  const now = typeof options?.now === "function" ? options.now : () => new Date().toISOString();

  /** Chave determinística garantida pelo host (event.toolCallId). */
  const authorizedByCallId = new Map();
  /** Cinto duplo: identidade real do objeto de args autorizado. */
  const authorizedByInput = new WeakMap();

  /**
   * @description Valida a identidade factual do record contra o dispatch-record exato do produtor.
   * @param {Record<string, unknown>} record
   * @param {{ sessionId: string, featureId: string, action: string }} authorization
   * @param {string} taskId
   * @param {string} [sha]
   */
  function validateExactProducer(record, authorization, taskId, sha) {
    const identity = validateOcCaptureEligibleHandRecord(record, {
      featureId: authorization.featureId,
      taskId,
      sessionId: authorization.sessionId,
      ...(typeof sha === "string" ? { sha } : {}),
    });
    if (!identity.ok) return identity;
    if (!readDispatchRecord) return { ok: false, reason: "exact producer dispatch record required" };
    const producerCallId = typeof record.producerCallId === "string" ? record.producerCallId : "";
    let producer;
    try {
      producer = readDispatchRecord(projectRoot, {
        parentSessionId: authorization.sessionId,
        callId: producerCallId,
      });
    } catch {
      producer = { ok: false };
    }
    if (!producer?.ok) return { ok: false, reason: "exact producer dispatch record required" };
    if (
      producer.record.feature_id !== authorization.featureId ||
      producer.record.task_id !== taskId ||
      producer.record.role !== record.agent
    ) return { ok: false, reason: "producer dispatch identity mismatch" };
    return validateOcCaptureEligibleHandRecord(record, {
      featureId: authorization.featureId,
      taskId,
      sessionId: authorization.sessionId,
      producerCallId: producer.record.dispatch_call_id,
      ...(typeof sha === "string" ? { sha } : {}),
    });
  }

  /**
   * @description Aplica a mutação do marcador sob withGateStateLock no gate-state da lane Pi.
   * @param {{ action?: unknown, task_id?: unknown, sha?: unknown }} args
   * @param {{ sessionId: string, featureId: string, action: string }} authorization
   */
  function mutate(args, authorization) {
    const statePath = piGateStatePath({ projectRoot, sessionId: authorization.sessionId });
    if (!statePath.ok) return { ok: false, reason: statePath.reason };
    let capturedProducerCallId = "";
    const locked = withGateStateLock(statePath.path, (previous) => {
      if (previous.session_id !== authorization.sessionId || previous.feature_id !== authorization.featureId) {
        return { ok: false, reason: "gate-state identity changed before marker mutation" };
      }
      const action = authorization.action;
      let patch;
      let payload;
      if (action === "brainstormed") {
        patch = { brainstormed: true };
      } else if (action === "adversary_fired") {
        if (previous.brainstormed !== true) {
          return { ok: false, reason: "adversary_fired requires brainstormed first" };
        }
        patch = { adversary_fired: true };
      } else if (action === "final-review" || action === "demo-done") {
        // Pré-condições de ship com escopo de feature (#385) — sem task_id; boolean no gate-state.
        const field = action === "final-review" ? "final_review_done" : "demo_done";
        patch = { [field]: true };
      } else {
        if (!isSafeTaskId(args.task_id)) {
          return { ok: false, reason: `${action} requires a safe task_id` };
        }
        const taskId = args.task_id;
        const bare = formatFeatureTaskEntry(authorization.featureId, taskId);
        if (action === "fidelity") {
          const sha = typeof args.sha === "string" && args.sha ? args.sha : resolveHeadSha(projectRoot);
          payload = formatFeatureTaskEntry(authorization.featureId, taskId, sha);
          patch = { fidelity_pass: [payload] };
        } else if (action === "regate-pending") {
          patch = { regate_pending: [bare] };
        } else if (action === "hand-finished") {
          // Exige um record capture-eligible escrito pelo host — prosa sozinha não destrava ship.
          const hfPath = piHandRecordPath(
            { projectRoot, sessionId: authorization.sessionId, featureId: authorization.featureId },
            taskId,
          );
          if (!hfPath.ok) return { ok: false, reason: hfPath.reason };
          let hfRecord;
          try {
            hfRecord = JSON.parse(fs.readFileSync(hfPath.path, "utf8"));
          } catch {
            return { ok: false, reason: "hand-record missing or unreadable" };
          }
          if (!isCaptureEligibleHandRecord(hfRecord)) return { ok: false, reason: "hand-record is not capture-eligible" };
          const hfIdentity = validateExactProducer(hfRecord, authorization, taskId);
          if (!hfIdentity.ok) return hfIdentity;
          patch = { hand_finished: [bare] };
        } else if (action === "regate-passed") {
          const sha = typeof args.sha === "string" && args.sha ? args.sha : resolveHeadSha(projectRoot);
          if (!sha) return { ok: false, reason: "regate-passed requires a resolved commit SHA" };
          if (!Array.isArray(previous.regate_pending) || !previous.regate_pending.includes(bare)) {
            return { ok: false, reason: "regate_pending does not contain feature/task" };
          }
          payload = formatFeatureTaskEntry(authorization.featureId, taskId, sha);
          patch = { regate_passed: [payload] };
        } else if (action === "capture-verified") {
          if (!Array.isArray(previous.hand_finished) || !previous.hand_finished.includes(bare)) {
            return { ok: false, reason: "hand_finished does not contain feature/task" };
          }
          const recordPath = piHandRecordPath(
            { projectRoot, sessionId: authorization.sessionId, featureId: authorization.featureId },
            taskId,
          );
          if (!recordPath.ok) return { ok: false, reason: recordPath.reason };
          let record;
          try { record = JSON.parse(fs.readFileSync(recordPath.path, "utf8")); } catch {
            return { ok: false, reason: "hand-record missing or unreadable" };
          }
          if (!isCaptureEligibleHandRecord(record)) return { ok: false, reason: "hand-record is not capture-eligible" };
          const violations = recordViolations(record);
          if (violations.scope.length > 0 || violations.frozen.length > 0) {
            return { ok: false, reason: "hand-record contains scope or frozen violations" };
          }
          // O record escrito pelo host — não o HEAD do instante do carimbo — é a autoridade de SHA.
          // Ancorar no HEAD tornava o carimbo uma corrida: qualquer commit entre o fim da mão e o
          // disparo do marcador invalidava o record para sempre (HEAD nunca volta), e a única saída
          // era re-despachar uma mão no-op só para cunhar um record com o HEAD mais novo. O que o
          // trilho de absolvição precisa é de LINHAGEM, e isAncestorSha abaixo é quem a afirma.
          // `args.sha` é ignorado de propósito: o modelo não escolhe mais qual commit uma captura certifica.
          const sha = typeof record.freezeCommitSha === "string" ? record.freezeCommitSha : "";
          if (!sha) return { ok: false, reason: "capture-verified requires a resolved commit SHA" };
          payload = formatFeatureTaskEntry(authorization.featureId, taskId, sha);
          // Replay é propriedade do RECORD (já carimbado), nunca da string de payload. Uma mão
          // posterior na mesma task reescreve o record do zero e derruba `capturedVerifiedAt`,
          // mantendo o mesmo freeze SHA — um teste chaveado por payload jogaria esse produtor
          // novinho no ramo de replay, que nunca o valida.
          const alreadyStamped =
            typeof record.capturedVerifiedAt === "string" && record.capturedVerifiedAt.length > 0;
          if (
            alreadyStamped &&
            Array.isArray(previous.capture_verified) &&
            previous.capture_verified.includes(payload)
          ) {
            const replayIdentity = validateOcCaptureEligibleHandRecord(record, {
              featureId: authorization.featureId,
              taskId,
              sessionId: authorization.sessionId,
              sha,
            });
            if (!replayIdentity.ok) return replayIdentity;
            if (isAncestorSha(projectRoot, sha) !== true) {
              return { ok: false, reason: "capture-verified requires the matching record SHA to be ancestral to HEAD" };
            }
            capturedProducerCallId = String(record.producerCallId);
            return previous;
          }
          const identity = validateExactProducer(record, authorization, taskId, sha);
          if (!identity.ok) return identity;
          if (isAncestorSha(projectRoot, sha) !== true) {
            return { ok: false, reason: "capture-verified requires the matching record SHA to be ancestral to HEAD" };
          }
          if (!atomicJsonWrite(recordPath.path, { ...record, capturedVerifiedAt: now() })) {
            return { ok: false, reason: "hand-record persistence failed" };
          }
          capturedProducerCallId = String(record.producerCallId);
          patch = { capture_verified: [payload] };
        } else return { ok: false, reason: "unknown privileged marker action" };
      }
      const applied = mergeGateStatePatch(previous, patch);
      if (!applied.ok) return applied;
      return applied.state;
    });
    if (!locked.ok || !capturedProducerCallId) return locked;
    if (!removeDispatchRecord) return { ok: false, reason: "exact producer dispatch record required" };
    let removed;
    try {
      removed = removeDispatchRecord(projectRoot, {
        sessionId: authorization.sessionId,
        callId: capturedProducerCallId,
      });
    } catch {
      removed = { ok: false, reason: "dispatch record removal failed" };
    }
    if (!removed?.ok) return { ok: false, reason: removed?.reason ?? "dispatch record removal failed" };
    return locked;
  }

  return {
    /**
     * @description Hook `tool_call`: autoriza (ou nega) uma chamada de `mark` antes da execução.
     * Devolve undefined para qualquer outra tool. Toda negação já vem prefixada com
     * '[marker-authority] ' para o adaptador repassar em {block:true,reason}.
     */
    authorize(event) {
      if (event?.toolName !== MARKER_TOOL_NAME) return undefined;
      const deny = (reason) => ({ ok: false, block: true, reason: `${DENY_PREFIX} ${reason}` });
      const args = event?.input;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return deny("exact object args required");
      }
      if (authorizedByInput.has(args)) return deny("args object already authorized");
      const action = typeof args.action === "string" ? args.action : "";
      if (!MARKER_ACTIONS.has(action)) return deny("unknown privileged marker action");
      const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!sessionId || !toolCallId) return deny("runtime sessionID and callID required");
      if (authorizedByCallId.has(toolCallId)) return deny("args object already authorized");
      const statePath = piGateStatePath({ projectRoot, sessionId });
      if (!statePath.ok) return deny(statePath.reason);
      let state;
      try { state = JSON.parse(fs.readFileSync(statePath.path, "utf8")); } catch {
        return deny("gate-state missing or unreadable");
      }
      // JSON válido mas não-objeto (null, array, string, número): na lane OC a leitura de
      // `state.feature_id` devolve undefined e a negação é 'classified runtime identity
      // required'. O Pi precisa do guard explícito porque `null.feature_id` lançaria — e um
      // throw aqui não bloqueia a tool no Pi —, mas a reason é a mesma do OC.
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        return deny("classified runtime identity required");
      }
      const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
      if (!featureId || state.session_id !== sessionId) {
        return deny("classified runtime identity required");
      }
      if (!isSafeFeatureId(featureId)) {
        return deny("safe feature_id required");
      }
      const authorization = { sessionId, toolCallId, featureId, action };
      authorizedByCallId.set(toolCallId, { authorization, input: args });
      authorizedByInput.set(args, authorization);
      return { ok: true };
    },

    /**
     * @description Corpo da tool `mark`: consome a autorização (uma única vez), confere
     * toolCallId/sessionId/action, aplica a restrição de sessão PAI ao capture-verified e
     * então muta o gate-state. Sem autorização válida nada é lido nem escrito.
     */
    execute(call) {
      const toolCallId = typeof call?.toolCallId === "string" ? call.toolCallId : "";
      const params = call?.params;
      const sessionId = typeof call?.sessionId === "string" ? call.sessionId : "";
      const entry = toolCallId ? authorizedByCallId.get(toolCallId) : undefined;
      // Consome a autorização ANTES de qualquer validação: um params malformado nunca deixa
      // a autorização de pé para uma segunda tentativa (fail-closed).
      if (toolCallId) authorizedByCallId.delete(toolCallId);
      if (entry?.input) authorizedByInput.delete(entry.input);
      const authorization = entry?.authorization;
      // Mesma reason da lane OC para args que nem sequer são um objeto.
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return markerResponse(false, "exact before-hook args identity required");
      }
      const boundToParams = authorizedByInput.get(params);
      if (
        !authorization ||
        authorization.toolCallId !== toolCallId ||
        authorization.sessionId !== sessionId ||
        authorization.action !== params.action ||
        (boundToParams !== undefined && boundToParams !== authorization)
      ) return markerResponse(false, "marker authorization missing, cloned, replayed, or binding-mismatched");
      if (authorization.action === "capture-verified" && call?.isChild === true) {
        return markerResponse(false, "capture-verified is restricted to the parent build agent");
      }
      const result = mutate(params, authorization);
      if (!result.ok) return markerResponse(false, String(result.reason ?? "marker failed"));
      return markerResponse(true, "", {
        action: authorization.action,
        session_id: authorization.sessionId,
        feature_id: authorization.featureId,
      });
    },

    /** @description Quantidade de autorizações pendentes (chamadas pré-validadas ainda não executadas). */
    pendingCount() {
      return authorizedByCallId.size;
    },
  };
}

export default { MARKER_ACTIONS, MARKER_TOOL_NAME, createPiMarkerAuthority, markerResponse };
