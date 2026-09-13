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
import { parseTaskDispatchIdentity } from "../../opencode/lib/task-dispatch-identity.mjs";
import { isDiscussionRole, isRuntimeRole } from "../lib/roles.mjs";
import { classifyPiReviewDispatch } from "../lib/pi-review-concurrency.mjs";
import {
  capturePiReviewInput,
  beginPiReviewReceipt,
  checkPiReviewPreparation,
  parsePiReviewCompletion,
  recordPiReviewReceipt,
  recordPiReviewFailure,
} from "../lib/pi-review-evidence.mjs";
import { capturePlanReviewInput, parsePlanReviewCompletion } from "../lib/task-run.mjs";
import { attachPiReviewEvidencePacket } from "../lib/pi-command-evidence.mjs";

const SUBAGENTS_SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");

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
  /** Snapshot observado pelo host antes de cada task/final review reconhecida. */
  const reviewInputs = new Map<string, { phase: "task" | "final"; taskId?: string; snapshot?: any }>();
  /** Hashes host-owned observados antes de cada plan-reviewer. */
  const planReviewInputs = new Map<string, any>();
  /** True quando ESTA instância roda numa sessão filha: só o pai liga filhas. */
  let ownSessionIsChild = false;
  /** Sessão exata capturada no session_start; o barramento é compartilhado entre pai e filhas. */
  let ownSessionId = "";

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
      ownSessionId = piSessionId(ctx) ?? "";
    } catch {
      ownSessionIsChild = true;
      ownSessionId = "";
    }
  });

  const bindExactChild = (data: any) => {
    const callId = typeof data?.toolCallId === "string" ? data.toolCallId : "";
    const parentSessionId = typeof data?.parentSessionId === "string" ? data.parentSessionId : "";
    const childSessionId = typeof data?.childSessionId === "string" ? data.childSessionId : "";
    const requestedRole = typeof data?.subagentType === "string" ? data.subagentType : "";
    const dispatched = callId ? pendingArgs.get(callId) : undefined;
    const role = piSubagentArgs(dispatched).subagent_type;

    if (!callId || !childSessionId || parentSessionId !== ownSessionId || !dispatched ||
        role !== requestedRole || !isRuntimeRole(role)) {
      data.result = { ok: false, reason: "exact pending dispatch call, role, parent, and child required" };
      return;
    }
    if (!isDiscussionRole(role)) {
      const decision = decidePiDispatchGate({
        projectRoot,
        sessionId: ownSessionId,
        subagentType: role,
        toolArgs: dispatched,
        toolCallId: callId,
      });
      if (decision.decision === "deny") {
        data.result = { ok: false, reason: decision.reason };
        return;
      }
    }
    const reviewInput = reviewInputs.get(callId);
    if (reviewInput) {
      const loaded: any = loadPiGateStateFromDisk(projectRoot, { sessionId: ownSessionId });
      const featureId = loaded?.ok === true && typeof loaded.state?.feature_id === "string" ? loaded.state.feature_id : "";
      const captured = capturePiReviewInput({
        projectRoot,
        sessionId: ownSessionId,
        featureId,
        phase: reviewInput.phase,
        ...(reviewInput.phase === "task" ? { taskId: reviewInput.taskId } : {}),
      });
      if (!reviewInput.snapshot || !captured.ok || captured.snapshot.input_digest !== reviewInput.snapshot.input_digest) {
        data.result = { ok: false, reason: "review input changed before child admission" };
        return;
      }
    }
    const planReviewInput = planReviewInputs.get(callId);
    if (planReviewInput) {
      const captured = capturePlanReviewInput({
        projectRoot,
        sessionId: ownSessionId,
        featureId: planReviewInput.feature_id,
      });
      if (!captured.ok || JSON.stringify(captured.snapshot) !== JSON.stringify(planReviewInput)) {
        data.result = { ok: false, reason: "plan/spec changed before plan-reviewer child admission" };
        return;
      }
    }
    const written = writePiChildIdentity(projectRoot, { parentSessionId, childSessionId, role, callId });
    if (written.ok !== true) {
      data.result = { ok: false, reason: written.reason };
      return;
    }
    if (isWritingHandRole(role)) {
      const hand = bindPiChildSession(projectRoot, { parentSessionId, childSessionId, role, callId });
      if (hand.ok !== true) {
        removePiChildIdentity(projectRoot, { parentSessionId, childSessionId });
        data.result = { ok: false, reason: hand.reason };
        return;
      }
    }
    boundChildren.set(callId, { parentSessionId, childSessionId });
    data.result = { ok: true };
  };

  pi.events?.on?.("harness:child-bind", (data: any) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    try {
      if (ownSessionIsChild) return;
      const callId = typeof data?.toolCallId === "string" ? data.toolCallId : "";
      const parentSessionId = typeof data?.parentSessionId === "string" ? data.parentSessionId : "";
      if (parentSessionId !== ownSessionId) {
        if (callId && pendingArgs.has(callId) && data.result === undefined) {
          data.result = { ok: false, reason: "exact parent session required" };
        }
        return;
      }
      bindExactChild(data);
    } catch (error) {
      data.result = { ok: false, reason: error instanceof Error ? error.message : "child binding failed" };
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
    const review = classifyPiReviewDispatch(args.subagent_type, args.prompt);
    if (review && (typeof event?.toolCallId !== "string" || !event.toolCallId)) {
      return { block: true, reason: "Implementation or final review requires an exact native tool call ID before dispatch." };
    }
    if (review && typeof event?.toolCallId === "string") {
      const loaded: any = loadPiGateStateFromDisk(projectRoot, { sessionId });
      const featureId = loaded?.ok === true && typeof loaded.state?.feature_id === "string" ? loaded.state.feature_id : "";
      const preparation = checkPiReviewPreparation({ projectRoot, featureId });
      if (!preparation.ok) return { block: true, reason: preparation.reason + (preparation.paths ? ` Pending paths: ${JSON.stringify(preparation.paths)}.` : "") };
      const captured = capturePiReviewInput({
        projectRoot,
        sessionId,
        featureId,
        phase: review.phase,
        ...(review.phase === "task" ? { taskId: review.taskId } : {}),
      });
      if (!captured.ok) return { block: true, reason: captured.reason };
      const started = beginPiReviewReceipt({ projectRoot, sessionId, featureId,
        phase: review.phase, taskId: review.taskId, role: args.subagent_type, dispatchCallId: event.toolCallId });
      if (!started.ok) return { block: true, reason: started.reason };
      reviewInputs.set(event.toolCallId, { ...review, snapshot: captured.snapshot });
    }
    if (args.subagent_type === "harness-plan-reviewer" && typeof event?.toolCallId === "string") {
      const loaded: any = loadPiGateStateFromDisk(projectRoot, { sessionId });
      const featureId = loaded?.ok === true && typeof loaded.state?.feature_id === "string" ? loaded.state.feature_id : "";
      const captured = capturePlanReviewInput({ projectRoot, sessionId, featureId });
      if (captured.ok) {
        planReviewInputs.set(event.toolCallId, captured.snapshot);
        const statePath = piGateStatePath({ projectRoot, sessionId });
        if (statePath.ok) mergeGateState(statePath.path, { plan_review_evidence: null });
      }
    }
    try { attachPiReviewEvidencePacket({ projectRoot, sessionId, event }); }
    catch { /* evidence transport is advisory and never changes dispatch admission */ }
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
      const reviewInput = callId ? reviewInputs.get(callId) : undefined;
      if (callId) reviewInputs.delete(callId);
      const planReviewInput = callId ? planReviewInputs.get(callId) : undefined;
      if (callId) planReviewInputs.delete(callId);
      const dispatched = callId ? pendingArgs.get(callId) : undefined;
      if (callId) pendingArgs.delete(callId);
      const bound = callId ? boundChildren.get(callId) : undefined;
      if (callId) boundChildren.delete(callId);
      if (!isPiDispatchTool(event?.toolName)) return;
      const args = piSubagentArgs(dispatched);
      const sessionId = piSessionId(ctx);
      if (bound && sessionId && callId) {
        const outcome = successfulForegroundOutcome(event?.result, event?.isError);
        const loaded: any = loadPiGateStateFromDisk(projectRoot, { sessionId });
        const featureId = loaded?.ok === true && typeof loaded.state?.feature_id === "string" ? loaded.state.feature_id : "";
        const statePath = piGateStatePath({ projectRoot, sessionId });
        if (planReviewInput && args.subagent_type === "harness-plan-reviewer") {
          const capturedEnd = capturePlanReviewInput({ projectRoot, sessionId, featureId });
          const service: any = (globalThis as any)[SUBAGENTS_SERVICE_KEY];
          const nativeRecord = outcome && typeof service?.getRecord === "function" ? service.getRecord(outcome.agentId) : undefined;
          const parsed = capturedEnd.ok ? parsePlanReviewCompletion({
            result: event?.result,
            isError: event?.isError,
            nativeRecord,
            snapshotStart: planReviewInput,
            snapshotEnd: capturedEnd.snapshot,
          }) : { ok: false };
          if (outcome && parsed.ok && statePath.ok) {
            mergeGateState(statePath.path, {
              plan_review_evidence: {
                written_by: "host-subagent-completion",
                parent_session_id: sessionId,
                feature_id: featureId,
                role: "harness-plan-reviewer",
                dispatch_call_id: callId,
                child_session_id: bound.childSessionId,
                agent_id: parsed.agentId,
                status: "completed",
                plan_sha256: planReviewInput.plan_sha256,
                spec_sha256: planReviewInput.spec_sha256,
                verdict: parsed.verdict,
              },
            });
          }
        } else if (reviewInput) {
          const capturedEnd = capturePiReviewInput({
            projectRoot,
            sessionId,
            featureId,
            phase: reviewInput.phase,
            ...(reviewInput.phase === "task" ? { taskId: reviewInput.taskId } : {}),
          });
          const service: any = (globalThis as any)[SUBAGENTS_SERVICE_KEY];
          const nativeRecord = outcome && typeof service?.getRecord === "function" ? service.getRecord(outcome.agentId) : undefined;
          const parsed = reviewInput.snapshot && capturedEnd.ok ? parsePiReviewCompletion({
            role: args.subagent_type,
            result: event?.result,
            isError: event?.isError,
            nativeRecord,
            snapshotStart: reviewInput.snapshot,
            snapshotEnd: capturedEnd.snapshot,
          }) : { ok: false, reason: capturedEnd.reason ?? "review input snapshot unavailable at completion" };
          if (parsed.ok) {
            recordPiReviewReceipt({
              projectRoot,
              sessionId,
              completion: parsed.completion,
              binding: { dispatchCallId: callId, childSessionId: bound.childSessionId, agentId: outcome?.agentId },
            });
          } else {
            recordPiReviewFailure({ projectRoot, sessionId, featureId, phase: reviewInput.phase,
              taskId: reviewInput.taskId, role: args.subagent_type, dispatchCallId: callId, reason: parsed.reason });
          }
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
            // Task/final reviews are classified before this fallback. No other adversary phase
            // may mint a task or final receipt from positive prose.
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
        String(loaded?.state?.mode).toUpperCase() !== "LIGHT" &&
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
