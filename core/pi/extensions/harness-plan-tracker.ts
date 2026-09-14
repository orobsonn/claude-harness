import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { applyPlanAction, formatPlanProgress, formatPlanResult, restorePlanSnapshot } from "../lib/plan-tracker.mjs";
import { readCanonicalTaskProgress, reconcileTaskProgress } from "../lib/task-progress.mjs";
import { isChildSession } from "../lib/pi-adapter-map.mjs";

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
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "blocked"] as const, { description: "New informational task status; required for update. Multiple tasks may be in_progress." })),
  validationStatus: Type.Optional(StringEnum(["pending", "running", "passed", "failed"] as const, { description: "Validation status; required for validate." })),
  note: Type.Optional(Type.String({ description: "Short blocking or validation-failure reason; required when blocked or failed." })),
});

/** @description Displays informational task progress for the parent Pi harness session. */
export default function harnessPlanTracker(pi: ExtensionAPI, { readProgress = readCanonicalTaskProgress, intervalMs = 2000 } = {}) {
  // Child sessions must not create competing plans. This is workflow scope, not a security boundary.
  if (process.env.PI_SUBAGENT_CHILD_AGENT) return;

  let snapshot: any;
  let timer: ReturnType<typeof setInterval> | undefined;

  const sync = (ctx: ExtensionContext) => {
    if (isChildSession(ctx)) return false;
    const progress = readProgress(ctx.cwd, ctx.sessionManager.getSessionId());
    if (!progress) return false;
    const next = reconcileTaskProgress(snapshot, progress);
    if (next !== snapshot) {
      snapshot = next;
      pi.appendEntry("harness-plan-snapshot", { snapshot });
      return true;
    }
    return false;
  };

  const publish = (ctx: ExtensionContext) => {
    const progress = formatPlanProgress(snapshot);
    ctx.ui.setStatus("harness-plan", snapshot ? progress[0] : undefined);
    ctx.ui.setWidget("harness-plan", snapshot ? progress : undefined, { placement: "aboveEditor" });
  };

  const restore = (ctx: ExtensionContext) => {
    snapshot = restorePlanSnapshot(ctx.sessionManager.getBranch());
    sync(ctx);
    publish(ctx);
  };

  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  const start = (_event: unknown, ctx: ExtensionContext) => {
    if (isChildSession(ctx)) return;
    stop(); restore(ctx);
    timer = setInterval(() => {
      try { if (sync(ctx)) publish(ctx); } catch { /* A display refresh must never abort the run. */ }
    }, intervalMs);
    timer.unref?.();
  };
  pi.on("session_start", start);
  pi.on("session_tree", start);
  pi.on("session_shutdown", stop);
  pi.on("tool_result", (event, ctx) => { if (!isChildSession(ctx) && event.toolName === "harness_tasks") { sync(ctx); publish(ctx); } });

  pi.registerTool({
    name: "harness_plan",
    label: "Harness plan",
    description: "Informational plan tracker for a LIGHT or FULL harness run. Record the approved plan, then reflect implementation and validation progress for each task, including parallel task runs and resumed completed tasks. harness_tasks remains the scheduler and source of task-run evidence.",
    promptSnippet: "Read the approved LIGHT or FULL plan with harness_plan. Canonical task progress is synchronized from native receipts and processes; legacy plans still accept manual updates.",
    promptGuidelines: [
      "Call action=record only after plan-reviewer approval for the exact current plan and within the operator's delivery authorization; the tracker records agent-reported progress and does not itself prove approval.",
      "For every update, use the exact planId and revision returned by the previous tracker result.",
      "Do not serialize the display: independent tasks dispatched together may all remain in_progress. Updating one task must not reset a sibling.",
      "For canonical task pipelines, use action=show: the host synchronizes exact task IDs, resumes, validation and integrations. Manual updates cannot override native progress.",
      "For legacy plans only, reopen a resumed task to in_progress; declare validation: true and use action=validate after implementation.",
      "Only the global parent tracks the plan. This tool is display state, not dispatch, dependency, integration, approval, or completion evidence.",
    ],
    parameters: PlanParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      sync(ctx);
      if (snapshot?.tasks.some((task: any) => task.canonicalTaskId)) {
        publish(ctx);
        return { content: [{ type: "text", text: `${formatPlanResult(snapshot)}\nProgresso sincronizado com as tarefas canônicas; alterações manuais não substituem recibos.` }], details: { snapshot } };
      }
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
