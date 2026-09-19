import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSafeFeatureId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { isChildSession, piSessionId } from "../lib/pi-adapter-map.mjs";
import { loadPiGateStateFromDisk } from "../lib/pi-gate-state.mjs";
import { capturePiReviewInput, checkPiReviewPreparation, findPiReviewReceipt, isSatisfiedPiTaskReviewReceipt, missingPiReviewRoles, observedPiTaskReviewRoles, readPiReviewPlan } from "../lib/pi-review-evidence.mjs";
import { PARALLEL_REVIEW_ROLES, requiredPiFinalReviewRoles, requiredPiTaskReviewRoles } from "../lib/roles.mjs";

/** Read durable, current receipts; the parent decides which applicable reviewers to dispatch. */
export default function harnessReviews(pi: ExtensionAPI) {
  pi.on("tool_result", (event: any) => {
    if (event.toolName === "harness_reviews" && typeof event.details?.reason === "string") return { isError: true };
  });
  pi.registerTool({
    name: "harness_reviews",
    label: "Review status",
    description: "List accepted and missing task or final reviewers for the current parent session and feature. For task re-gates, an accepted role may be marked affected only when its explicit obligation or trigger materially changed. Resolve any preparation error before dispatching applicable missing roles; this tool never starts work or changes evidence.",
    parameters: Type.Object({
      phase: Type.Union([Type.Literal("task"), Type.Literal("final")]),
      task_id: Type.Optional(Type.String()),
      affected_roles: Type.Optional(Type.Array(Type.Union(PARALLEL_REVIEW_ROLES.map((role) => Type.Literal(role))), { minItems: 1, maxItems: PARALLEL_REVIEW_ROLES.length })),
      affected_reason: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx: any) {
      const denied = (reason: string) => {
        const identified = `[harness-reviews:${String(params?.phase ?? "unknown")}] ${reason}`;
        return { content: [{ type: "text" as const, text: identified }], details: { reason: identified }, isError: true };
      };
      if (isChildSession(ctx)) return denied("Review status is restricted to the parent orchestrator.");
      if (!params || Object.keys(params).some((key) => !["phase", "task_id", "affected_roles", "affected_reason"].includes(key)) ||
          (params.phase !== "task" && params.phase !== "final") ||
          (params.phase === "task" ? !isSafeTaskId(params.task_id) : params.task_id !== undefined) ||
          (params.affected_roles !== undefined && (!Array.isArray(params.affected_roles) || params.affected_roles.length < 1 ||
            params.affected_roles.length > PARALLEL_REVIEW_ROLES.length || new Set(params.affected_roles).size !== params.affected_roles.length ||
            params.affected_roles.some((role: unknown) => !PARALLEL_REVIEW_ROLES.includes(role as any)))) ||
          (params.affected_reason !== undefined && (typeof params.affected_reason !== "string" || !params.affected_reason.trim())) ||
          ((params.affected_roles === undefined) !== (params.affected_reason === undefined)) ||
          (params.phase === "final" && params.affected_roles !== undefined)) {
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
      const receipts = new Map(roles.map((role) => {
        const receipt: any = findPiReviewReceipt(loaded.state, { ...input, role });
        return [role, receipt];
      }));
      const observed = params.phase === "task" ? observedPiTaskReviewRoles(ctx.sessionManager, params.task_id,
        new Map(roles.map((role) => {
          const receipt: any = receipts.get(role);
          return [role, receipt?.active_dispatch_call_id ?? receipt?.dispatch_call_id];
        }))) : new Map<string, { callId: string; afterImplementation: boolean }>();
      if (observed === null) return denied("Task review status requires durable parent session entries.");
      const unavailable = params.phase === "final" ? missingPiReviewRoles({ ...input, roles }) : roles.filter((role) =>
        !isSatisfiedPiTaskReviewReceipt(receipts.get(role), {
          ...input, role, snapshot: captured.snapshot, dispatchCallId: observed.get(role)?.callId,
          reviewAfterImplementation: observed.get(role)?.afterImplementation,
        }));
      const affected = params.affected_roles ?? [];
      const acceptedBeforeAffected = roles.filter((role) => !unavailable.includes(role));
      if (affected.some((role: string) => !acceptedBeforeAffected.includes(role))) {
        return denied("affected_roles must contain only roles currently accepted for this task input.");
      }
      const effectiveUnavailable = roles.filter((role) => unavailable.includes(role) || affected.includes(role));
      const accepted = roles.filter((role) => !effectiveUnavailable.includes(role));
      const baseline = requiredPiTaskReviewRoles({ ...plan.plan, mode: plan.plan.mode ?? loaded.state.mode },
        plan.plan.tasks.find((task: any) => task.id === params.task_id));
      const taskRequired = params.phase === "task"
        ? roles.filter((role) => baseline.includes(role) || effectiveUnavailable.includes(role) && (observed.has(role) ||
            receipts.get(role) !== null))
        : [];
      const result = params.phase === "final"
        ? { accepted, missing: unavailable }
        : {
            required: taskRequired,
            available: roles,
            accepted,
            missing: taskRequired.filter((role) => effectiveUnavailable.includes(role)),
            ...(affected.length ? { affected, affected_reason: params.affected_reason.trim() } : {}),
          };
      const preparation = checkPiReviewPreparation(input);
      const diagnostics = unavailable.flatMap((role) => {
        const receipt: any = receipts.get(role);
        return receipt?.status === "invalid" && typeof receipt.reason === "string"
          ? [{ role, reason: receipt.reason, dispatch_call_id: receipt.active_dispatch_call_id }] : [];
      });
      const status = { ...result, ...(preparation.ok ? {} : { preparation }), ...(diagnostics.length ? { diagnostics } : {}) };
      const details = affected.length ? { ...status, review_input_digest: captured.snapshot.input_digest } : status;
      return { content: [{ type: "text" as const, text: JSON.stringify(status) }], details };
    },
  });
}
