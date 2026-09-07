import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  decidePiBashGate,
  decidePiDispatchGate,
  extractPiFeatureTaskIds,
  isWritingHandRole,
  recordPiTaskCompletion,
} from "../lib/entry-gate.mjs";
import { piResultText } from "../lib/obs.mjs";
import {
  isChildSession,
  isPiBashTool,
  isPiDispatchTool,
  piSessionId,
  piSubagentArgs,
} from "../lib/pi-adapter-map.mjs";
import { loadPiGateStateFromDisk } from "../lib/pi-gate-state.mjs";
import { mergeGateState } from "../lib/pi-gate-state.mjs";
import { piGateStatePath } from "../lib/pi-paths.mjs";
import { readPiSpecDraft } from "../lib/spec-approval.mjs";
import { removePiChildIdentity, writePiChildIdentity } from "../lib/pi-child-identity.mjs";
import { bindPiChildSession, removePiDispatchRecord } from "../lib/pi-state-records.mjs";
import { parseTaskDispatchIdentity } from "../vendor/opencode/lib/task-dispatch-identity.mjs";
import { isDiscussionRole } from "../lib/roles.mjs";

/** Marcador de escopo do olho que revisa o diff agregado imediatamente antes do shipper. */
function isFinalReviewDispatch(prompt: unknown) {
  return typeof prompt === "string" && prompt.startsWith("[HARNESS_FINAL_REVIEW]");
}

/**
 * @description Adaptador fino do entry-gate na lane Pi. Só traduz eventos do Pi para a lógica de
 * core/pi/lib/entry-gate.mjs (que por sua vez reusa bash-decide.mjs e entry-decide.mjs da lane OC
 * sem cópia):
 *   - `session_start`: memoriza o projectRoot da sessão (ctx.cwd);
 *   - `tool_execution_start`: memoriza os args do dispatch por toolCallId — `tool_execution_end`
 *     do Pi NÃO carrega args (ToolExecutionEndEvent = {toolCallId,toolName,result,isError}, ver
 *     dist/core/extensions/types.d.ts), então sem esse memo o fato terminal da mão seria
 *     inalcançável (mesma técnica da peça irmã core/pi/extensions/harness-obs.ts);
 *   - `tool_call` em bash/powershell: rails de bash → { block: true, reason } com o texto EXATO
 *     do Decision.reason (prefixo [entry-gate] preservado);
 *   - `tool_call` em subagent: rails de ceremony/fidelity/re-gate + reivindicação do
 *     dispatch-record exato para mão que escreve;
 *   - `tool_result` em bash/powershell: injeta o advisory (nunca bloqueante) em
 *     `details.bash_advisory` — espelho exato do canal `output.metadata.bash_advisory` da lane OC
 *     (ctx.sessionManager é ReadonlySessionManager e NÃO expõe appendCustomMessageEntry, então
 *     `tool_result` é o único canal de prosa de volta ao modelo nesta lane);
 *   - `tool_execution_end` em subagent de mão que escreve: grava o fato terminal e remove o
 *     dispatch-record quando terminal e sem captura pendente.
 *
 * Ligação pai↔filha: o `SessionHeader` do Pi não carrega o nome do agente, mas o pi-subagents
 * publica `subagents:child:session-created` ({sessionId, parentSessionId}) no barramento do Pi,
 * síncrono e ANTES de ligar as extensões da filha. Como este adaptador já sabe qual papel está
 * em voo (os args memorizados da tool `subagent`), é aqui que a filha recebe identidade durável:
 * `writePiChildIdentity` para TODO papel canônico (é a autoridade que o plan-write-gate lê) e
 * `bindPiChildSession` para mão que escreve (é o que arma o rail de escopo dentro da filha).
 * Quando há mais de um dispatch em voo a ligação seria ambígua: nada é gravado (fail-open, o
 * mesmo estado de antes desta ligação existir), nunca um palpite.
 */
export default function harnessEntryGate(pi: ExtensionAPI) {
  let projectRoot = process.cwd();
  /** args do dispatch memorizados no início da tool, por toolCallId (só a tool `subagent`). */
  const pendingArgs = new Map<string, unknown>();
  /** advisory não-bloqueante pendente de injeção no tool_result, por toolCallId. */
  const pendingAdvisory = new Map<string, string>();
  /** sessão filha ligada a cada dispatch em voo, por toolCallId (para limpar no fim). */
  const boundChildren = new Map<string, { parentSessionId: string; childSessionId: string }>();
  /** SHA observado pelo host antes de cada olho que precisa provar o diff que revisou. */
  const reviewHeads = new Map<string, string>();
  /** True quando ESTA instância roda numa sessão filha: só o pai liga filhas. */
  let ownSessionIsChild = false;

  /** Só o resultado estruturado da tool nativa, não a prosa da filha, prova término saudável. */
  const successfulForegroundOutcome = (result: any, isError: unknown) => {
    const details = result && typeof result === "object" && !Array.isArray(result) ? result.details : null;
    if (isError === true || !details || typeof details !== "object" || Array.isArray(details)) return null;
    const status = (details as any).status;
    const agentId = (details as any).agentId;
    return status === "completed" && typeof agentId === "string" && agentId.length > 0 ? { status, agentId } : null;
  };

  pi.on("session_start", (_event, ctx: any) => {
    if (typeof ctx?.cwd === "string" && ctx.cwd.length > 0) projectRoot = ctx.cwd;
    try {
      ownSessionIsChild = isChildSession(ctx);
    } catch {
      ownSessionIsChild = true;
    }
  });

  // O barramento é do processo: a instância da FILHA também escuta. Ela nunca tem dispatch em
  // voo (pendingArgs vazio), e o guard de sessão filha torna isso explícito.
  pi.events?.on?.("subagents:child:session-created", (data: any) => {
    try {
      if (ownSessionIsChild) return;
      const childSessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
      const parentSessionId = typeof data?.parentSessionId === "string" ? data.parentSessionId : "";
      if (!childSessionId || !parentSessionId || pendingArgs.size !== 1) return;
      const [callId, dispatched] = [...pendingArgs.entries()][0];
      const role = piSubagentArgs(dispatched).subagent_type;
      if (typeof role !== "string" || !role) return;
      if (isDiscussionRole(role)) return;
      const written = writePiChildIdentity(projectRoot, { parentSessionId, childSessionId, role, callId });
      if (written.ok !== true) return;
      boundChildren.set(callId, { parentSessionId, childSessionId });
      if (isWritingHandRole(role)) {
        bindPiChildSession(projectRoot, { parentSessionId, childSessionId, role, callId });
      }
    } catch {
      /* ligar a filha é best-effort: falhar só desarma o rail, nunca interrompe a sessão */
    }
  });

  pi.on("tool_execution_start", (event: any) => {
    try {
      if (!isPiDispatchTool(event?.toolName)) return;
      if (typeof event?.toolCallId === "string") pendingArgs.set(event.toolCallId, event?.args);
    } catch {
      /* memorizar args nunca bloqueia */
    }
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (typeof ctx?.cwd === "string" && ctx.cwd.length > 0) projectRoot = ctx.cwd;
    const sessionId = piSessionId(ctx);

    if (isPiBashTool(event?.toolName)) {
      const decision = await decidePiBashGate({
        command: event?.input?.command,
        projectRoot,
        sessionId,
        isSubagent: isChildSession(ctx),
      });
      if (decision.decision === "deny") return { block: true, reason: decision.reason };
      if (
        typeof decision.advisory === "string" &&
        decision.advisory &&
        typeof event?.toolCallId === "string"
      ) {
        pendingAdvisory.set(event.toolCallId, decision.advisory);
      }
      return;
    }

    if (!isPiDispatchTool(event?.toolName)) return;
    const args = piSubagentArgs(event?.input);
    // Discussão não inicia cerimônia e não ganha dispatch-record, identidade ou recibo de delivery.
    if (isDiscussionRole(args.subagent_type)) return;
    const decision = decidePiDispatchGate({
      projectRoot,
      sessionId,
      subagentType: args.subagent_type,
      toolArgs: event?.input,
      toolCallId: event?.toolCallId,
    });
    if (decision.decision === "deny") return { block: true, reason: decision.reason };
    const reviewsCurrentHead =
      (args.subagent_type === "harness-adversary" && parseTaskDispatchIdentity(args.prompt).ok) ||
      ((args.subagent_type === "harness-adversary" || args.subagent_type === "harness-compliance") && isFinalReviewDispatch(args.prompt));
    if (reviewsCurrentHead && typeof event?.toolCallId === "string") {
      try { reviewHeads.set(event.toolCallId, execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim()); } catch { /* receipt stays absent */ }
    }
  });

  pi.on("tool_result", (event: any) => {
    try {
      const advisory =
        typeof event?.toolCallId === "string" ? pendingAdvisory.get(event.toolCallId) : undefined;
      if (typeof event?.toolCallId === "string") pendingAdvisory.delete(event.toolCallId);
      if (!advisory) return;
      const details =
        event?.details != null && typeof event.details === "object" && !Array.isArray(event.details)
          ? event.details
          : {};
      return { details: { ...details, bash_advisory: advisory } };
    } catch {
      /* canal de prosa é best-effort: nunca bloqueia, nunca lança */
    }
  });

  pi.on("tool_execution_end", (event: any, ctx: any) => {
    try {
      const callId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
      if (callId) pendingAdvisory.delete(callId);
      const reviewedHead = callId ? reviewHeads.get(callId) : undefined;
      if (callId) reviewHeads.delete(callId);
      const dispatched = callId ? pendingArgs.get(callId) : undefined;
      if (callId) pendingArgs.delete(callId);
      const bound = callId ? boundChildren.get(callId) : undefined;
      if (callId) boundChildren.delete(callId);
      if (!isPiDispatchTool(event?.toolName)) return;
      const args = piSubagentArgs(dispatched);
      const sessionId = piSessionId(ctx);
      if ((args.subagent_type === "harness-adversary" || args.subagent_type === "harness-compliance") && bound && sessionId && callId) {
        const outcome = successfulForegroundOutcome(event?.result, event?.isError);
        const loaded: any = loadPiGateStateFromDisk(projectRoot, { sessionId });
        const featureId = loaded?.ok === true && typeof loaded.state?.feature_id === "string" ? loaded.state.feature_id : "";
        const statePath = piGateStatePath({ projectRoot, sessionId });
        if (outcome && featureId && statePath.ok && isFinalReviewDispatch(args.prompt) && reviewedHead) {
          const key = args.subagent_type === "harness-adversary" ? "adversary" : "compliance";
          const prior = loaded?.state?.final_review_evidence;
          mergeGateState(statePath.path, {
            final_review_evidence: {
              ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}),
              [key]: {
                written_by: "host-subagent-completion", parent_session_id: sessionId, feature_id: featureId,
                role: args.subagent_type, dispatch_call_id: callId, child_session_id: bound.childSessionId,
                agent_id: outcome.agentId, status: outcome.status, reviewed_head_sha: reviewedHead,
              },
            },
          });
        } else if (outcome && featureId && statePath.ok && args.subagent_type === "harness-adversary") {
          const draft: any = readPiSpecDraft({ projectRoot, sessionId, featureId });
          if (draft?.ok && typeof draft.sha256 === "string") {
            mergeGateState(statePath.path, {
              adversary_completion_evidence: {
                written_by: "host-subagent-completion", parent_session_id: sessionId, feature_id: featureId,
                role: "harness-adversary", dispatch_call_id: callId, child_session_id: bound.childSessionId,
                agent_id: outcome.agentId, status: outcome.status, spec_sha256: draft.sha256,
              },
            });
          } else {
            const task = parseTaskDispatchIdentity(args.prompt);
            if (task.ok && reviewedHead) {
              const key = `${featureId}/${task.taskId}`;
              const prior = loaded?.state?.task_adversary_evidence;
              mergeGateState(statePath.path, {
                task_adversary_evidence: {
                  ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}),
                  [key]: {
                    written_by: "host-subagent-completion", parent_session_id: sessionId, feature_id: featureId,
                    task_id: task.taskId, role: "harness-adversary", dispatch_call_id: callId,
                    child_session_id: bound.childSessionId, agent_id: outcome.agentId, status: outcome.status,
                    reviewed_head_sha: reviewedHead,
                  },
                },
              });
            }
          }
        }
      }
      if (bound) removePiChildIdentity(projectRoot, bound);
      // Dispatch que terminou em ERRO não deixa dispatch-record órfão — espelho do handler
      // `event` da lane OC (message.part.updated com state.status === "error" → removeDispatchRecord).
      if (event?.isError === true) {
        if (sessionId && callId) removePiDispatchRecord(projectRoot, { sessionId, callId });
        return;
      }
      if (!isWritingHandRole(args.subagent_type)) return;
      if (!sessionId || !callId) return;
      const marker = parseTaskDispatchIdentity(args.prompt);
      const optionalIds = extractPiFeatureTaskIds(dispatched);
      const taskId = (marker.ok ? marker.taskId : "") || optionalIds.taskId || "";
      // Mesma precedência da lane OC (entry-gate.ts tool.execute.after): o feature_id do
      // gate-state vence os args do dispatch, que só entram quando o gate-state não tem um.
      const loaded: any = loadPiGateStateFromDisk(projectRoot, { sessionId });
      const featureId =
        loaded?.ok && typeof loaded.state?.feature_id === "string"
          ? loaded.state.feature_id
          : optionalIds.featureId || "";
      if (!taskId || !featureId) return;
      const completion = recordPiTaskCompletion({
        projectRoot,
        sessionId,
        featureId,
        taskId,
        role: args.subagent_type,
        producerCallId: callId,
        // `event.result` do Pi é estruturado (string | blocos de texto | objeto); piResultText é
        // o extrator canônico da lane — String(result) viraria "[object Object]" e o status
        // terminal da mão (DONE/BLOCKED) nunca seria lido.
        outputText: piResultText(event?.result),
        background: args.run_in_background === true,
      });
      if (
        completion.ok === true && completion.capturePending === true &&
        /^(?:harness-)?(?:executor|sniper)(?:-(?:low|medium|high))?$/.test(String(args.subagent_type))
      ) {
        const statePath = piGateStatePath({ projectRoot, sessionId });
        if (statePath.ok) mergeGateState(statePath.path, { regate_pending: [`${featureId}/${taskId}`] });
      }
      if (completion.ok === true && completion.terminal === true && completion.capturePending !== true) {
        removePiDispatchRecord(projectRoot, { sessionId, callId });
      }
    } catch {
      /* observação do fato terminal é best-effort — nunca interrompe a sessão */
    }
  });
}
