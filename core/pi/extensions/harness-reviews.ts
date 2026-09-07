import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSafeFeatureId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { isChildSession, piSessionId } from "../lib/pi-adapter-map.mjs";
import { loadPiGateStateFromDisk } from "../lib/pi-gate-state.mjs";
import { capturePiReviewInput, missingPiReviewRoles, readPiReviewPlan } from "../lib/pi-review-evidence.mjs";
import { PARALLEL_REVIEW_ROLES, requiredPiFinalReviewRoles } from "../lib/roles.mjs";

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
      const missing = missingPiReviewRoles({ ...input, roles });
      const result = { accepted: roles.filter((role) => !missing.includes(role)), missing };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
}
