import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { applyPlanAction, formatPlanProgress, formatPlanResult, restorePlanSnapshot } from "../lib/plan-tracker.mjs";

const PlanParams = Type.Object({
  action: StringEnum(["record", "update", "validate", "show"] as const, { description: "Record a plan, update implementation, update validation, or show the current plan." }),
  title: Type.Optional(Type.String({ description: "Short plan title; required for record." })),
  tasks: Type.Optional(Type.Array(Type.Union([
    Type.String({ description: "One ordered task title." }),
    Type.Object({
      title: Type.String({ description: "One ordered task title." }),
      validation: Type.Optional(Type.Boolean({ description: "True when this task has its own validation lane." })),
    }),
  ]), { description: "Ordered tasks; an object may enable its validation lane; required for record." })),
  replace: Type.Optional(Type.Boolean({ description: "Required only when explicitly replacing the active plan." })),
  planId: Type.Optional(Type.String({ description: "Plan id returned by the tracker; required for update or validate." })),
  revision: Type.Optional(Type.Number({ description: "Exact current revision returned by the tracker; required for update or validate." })),
  taskId: Type.Optional(Type.String({ description: "Immutable task id returned by the tracker; required for update or validate." })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "blocked"] as const, { description: "New task status; required for update." })),
  validationStatus: Type.Optional(StringEnum(["pending", "running", "passed", "failed"] as const, { description: "Validation status; required for validate." })),
  note: Type.Optional(Type.String({ description: "Short blocking or validation-failure reason; required when blocked or failed." })),
});

/** @description Displays informational task progress for the parent Pi harness session. */
export default function harnessPlanTracker(pi: ExtensionAPI) {
  // Child sessions must not create competing plans. This is workflow scope, not a security boundary.
  if (process.env.PI_SUBAGENT_CHILD_AGENT) return;

  let snapshot: any;

  const publish = (ctx: ExtensionContext) => {
    const progress = formatPlanProgress(snapshot);
    ctx.ui.setStatus("harness-plan", snapshot ? progress[0] : undefined);
    ctx.ui.setWidget("harness-plan", snapshot ? progress : undefined, { placement: "aboveEditor" });
  };

  const restore = (ctx: ExtensionContext) => {
    snapshot = restorePlanSnapshot(ctx.sessionManager.getBranch());
    publish(ctx);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerTool({
    name: "harness_plan",
    label: "Harness plan",
    description: "Informational plan tracker for a FULL harness run. Record the plan only after explicit user approval, then update implementation and, when declared, validation for each task. This is not a scheduler, permission gate, or proof that repository work is complete.",
    promptSnippet: "Track the active FULL plan with harness_plan after explicit user approval; update implementation and applicable validation lanes as the pipeline advances.",
    promptGuidelines: [
      "Call action=record only after the user explicitly approves the plan; the tracker records agent-reported progress and does not itself prove approval.",
      "For every update, use the exact planId and revision returned by the previous tracker result.",
      "Declare validation: true for a task that needs its own validation lane. After implementation is completed, call action=validate when that validation starts, passes, or fails.",
      "Only the parent session tracks the plan; do not ask subagents to call this tool.",
    ],
    parameters: PlanParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "show") {
        restore(ctx);
        return { content: [{ type: "text", text: formatPlanResult(snapshot) }], details: { snapshot } };
      }

      const result = applyPlanAction(snapshot, params);
      if (result.ok) snapshot = result.snapshot;
      publish(ctx);
      return {
        content: [{ type: "text", text: result.ok ? formatPlanResult(snapshot) : `Plan tracker rejected: ${result.error}` }],
        details: { snapshot, error: result.ok ? undefined : result.error },
      };
    },
  });
}
