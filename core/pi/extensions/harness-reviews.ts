import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSafeFeatureId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { parseTaskDispatchIdentity } from "../../opencode/lib/task-dispatch-identity.mjs";
import { isChildSession, piSessionId } from "../lib/pi-adapter-map.mjs";
import { loadPiGateStateFromDisk } from "../lib/pi-gate-state.mjs";
import { capturePiReviewInput, checkPiReviewPreparation, findPiReviewReceipt, isSatisfiedPiTaskReviewReceipt, missingPiReviewRoles, readPiReviewPlan } from "../lib/pi-review-evidence.mjs";
import { classifyPiReviewDispatch } from "../lib/pi-review-concurrency.mjs";
import { PARALLEL_REVIEW_ROLES, requiredPiFinalReviewRoles, requiredPiTaskReviewRoles } from "../lib/roles.mjs";

/** Project only structured native dispatches from the append-only session; never scan prose or thinking. */
function observedTaskReviewRoles(sessionManager: any, taskId: string) {
  let entries;
  try { entries = sessionManager?.getEntries?.(); } catch { return null; }
  if (!Array.isArray(entries)) return null;
  const observed = new Map<string, { callId: string; afterImplementation: boolean }>();
  const implementationCalls = new Set<string>();
  let implementationCompleted = false;
  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role === "toolResult" && implementationCalls.has(message.toolCallId) &&
        message.isError !== true && message.details?.status === "completed") implementationCompleted = true;
    if (message?.role !== "assistant" || !Array.isArray(message.content) ||
        message.stopReason === "aborted" || message.stopReason === "error") continue;
    for (const block of message.content) {
      if (block?.type !== "toolCall" || block.name !== "subagent" ||
          !block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) continue;
      const review = classifyPiReviewDispatch(block.arguments.subagent_type, block.arguments.prompt);
      if (["harness-executor", "harness-sniper"].includes(block.arguments.subagent_type) &&
          parseTaskDispatchIdentity(block.arguments.prompt).taskId === taskId) implementationCalls.add(block.id);
      if (review?.phase === "task" && review.taskId === taskId) observed.set(block.arguments.subagent_type,
        { callId: block.id, afterImplementation: implementationCompleted });
    }
  }
  return observed;
}

/** Read durable, current receipts; the parent decides which applicable reviewers to dispatch. */
export default function harnessReviews(pi: ExtensionAPI) {
  pi.on("tool_result", (event: any) => {
    if (event.toolName === "harness_reviews" && typeof event.details?.reason === "string") return { isError: true };
  });
  pi.registerTool({
    name: "harness_reviews",
    label: "Review status",
    description: "List accepted and missing task or final reviewers for the current parent session and feature. Resolve any preparation error before dispatching applicable missing roles; this tool never starts work or changes evidence.",
    parameters: Type.Object({
      phase: Type.Union([Type.Literal("task"), Type.Literal("final")]),
      task_id: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx: any) {
      const denied = (reason: string) => {
        const identified = `[harness-reviews:${String(params?.phase ?? "unknown")}] ${reason}`;
        return { content: [{ type: "text" as const, text: identified }], details: { reason: identified }, isError: true };
      };
      if (isChildSession(ctx)) return denied("Review status is restricted to the parent orchestrator.");
      if (!params || Object.keys(params).some((key) => key !== "phase" && key !== "task_id") ||
          (params.phase !== "task" && params.phase !== "final") ||
          (params.phase === "task" ? !isSafeTaskId(params.task_id) : params.task_id !== undefined)) {
        return denied("Expected phase=task with a safe task_id, or phase=final without task_id.");
      }
      const sessionId = piSessionId(ctx);
      const loaded = loadPiGateStateFromDisk(ctx.cwd, { sessionId });
      if (!loaded.ok || loaded.state?.session_id !== sessionId || !isSafeFeatureId(loaded.state?.feature_id)) {
        return denied("Review status requires the current classified parent session and feature.");
      }
      const input = { projectRoot: ctx.cwd, sessionId, featureId: loaded.state.feature_id, phase: params.phase, taskId: params.task_id };
      const captured = capturePiReviewInput(input);
      if (!captured.ok) return denied(captured.reason);
      const plan = readPiReviewPlan({ ...input, expectedSha256: captured.snapshot.canonical_plan.sha256 });
      if (!plan.ok) return denied(plan.reason);
      const roles = params.phase === "final" ? requiredPiFinalReviewRoles(plan.plan) : [...PARALLEL_REVIEW_ROLES];
      const observed = params.phase === "task" ? observedTaskReviewRoles(ctx.sessionManager, params.task_id) : new Map<string, { callId: string; afterImplementation: boolean }>();
      if (observed === null) return denied("Task review status requires durable parent session entries.");
      const unavailable = params.phase === "final" ? missingPiReviewRoles({ ...input, roles }) : roles.filter((role) =>
        !isSatisfiedPiTaskReviewReceipt(findPiReviewReceipt(loaded.state, { ...input, role }), {
          ...input, role, snapshot: captured.snapshot, dispatchCallId: observed.get(role)?.callId,
          reviewAfterImplementation: observed.get(role)?.afterImplementation,
        }));
      const accepted = roles.filter((role) => !unavailable.includes(role));
      const baseline = requiredPiTaskReviewRoles({ ...plan.plan, mode: plan.plan.mode ?? loaded.state.mode },
        plan.plan.tasks.find((task: any) => task.id === params.task_id));
      const taskRequired = params.phase === "task"
        ? roles.filter((role) => baseline.includes(role) || unavailable.includes(role) && (observed.has(role) ||
            findPiReviewReceipt(loaded.state, { featureId: loaded.state.feature_id, taskId: params.task_id, role, phase: "task" }) !== null))
        : [];
      const result = params.phase === "final"
        ? { accepted, missing: unavailable }
        : {
            required: taskRequired,
            available: roles,
            accepted,
            missing: taskRequired.filter((role) => unavailable.includes(role)),
          };
      const preparation = checkPiReviewPreparation(input);
      const status = preparation.ok ? result : { ...result, preparation };
      return { content: [{ type: "text" as const, text: JSON.stringify(status) }], details: status };
    },
  });
}
