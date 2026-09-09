import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSafeFeatureId, isSafeTaskId } from "../vendor/shared/lib/feature-id.mjs";
import { isChildSession, piSessionId } from "../lib/pi-adapter-map.mjs";
import { loadPiGateStateFromDisk } from "../lib/pi-gate-state.mjs";
import { capturePiReviewInput, findPiReviewReceipt, missingPiReviewRoles, readPiReviewPlan } from "../lib/pi-review-evidence.mjs";
import { classifyPiReviewDispatch } from "../lib/pi-review-concurrency.mjs";
import { PARALLEL_REVIEW_ROLES, requiredPiFinalReviewRoles } from "../lib/roles.mjs";

/** Project only structured native dispatches from the append-only session; never scan prose or thinking. */
function observedTaskReviewRoles(sessionManager: any, taskId: string) {
  let entries;
  try { entries = sessionManager?.getEntries?.(); } catch { return null; }
  if (!Array.isArray(entries)) return null;
  const observed = new Set<string>();
  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role !== "assistant" || !Array.isArray(message.content) ||
        message.stopReason === "aborted" || message.stopReason === "error") continue;
    for (const block of message.content) {
      if (block?.type !== "toolCall" || block.name !== "subagent" ||
          !block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) continue;
      const review = classifyPiReviewDispatch(block.arguments.subagent_type, block.arguments.prompt);
      if (review?.phase === "task" && review.taskId === taskId) observed.add(block.arguments.subagent_type);
    }
  }
  return observed;
}

/** Read durable, current receipts; the parent decides which applicable reviewers to dispatch. */
export default function harnessReviews(pi: ExtensionAPI) {
  pi.registerTool({
    name: "harness_reviews",
    label: "Review status",
    description: "List accepted and missing task or final reviewers for the current parent session and feature. Dispatch only applicable missing roles; this tool never starts work or changes evidence.",
    parameters: Type.Object({
      phase: Type.Union([Type.Literal("task"), Type.Literal("final")]),
      task_id: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx: any) {
      const denied = (reason: string) => ({ content: [{ type: "text" as const, text: reason }], details: { reason }, isError: true });
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
      const unavailable = missingPiReviewRoles({ ...input, roles });
      const accepted = roles.filter((role) => !unavailable.includes(role));
      const observed = params.phase === "task" ? observedTaskReviewRoles(ctx.sessionManager, params.task_id) : new Set<string>();
      if (observed === null) return denied("Task review status requires durable parent session entries.");
      const taskRequired = params.phase === "task"
        ? roles.filter((role) => role === "harness-adversary" ||
            observed.has(role) ||
            findPiReviewReceipt(loaded.state, { featureId: loaded.state.feature_id, taskId: params.task_id, role, phase: "task" }) !== null)
        : [];
      const result = params.phase === "final"
        ? { accepted, missing: unavailable }
        : {
            required: taskRequired,
            available: roles,
            accepted,
            missing: taskRequired.filter((role) => unavailable.includes(role)),
          };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
}
