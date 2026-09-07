import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isChildSession, piSessionId } from "../lib/pi-adapter-map.mjs";
import {
  executeTaskAction,
  decideTaskCoordinatorEdit,
} from "../lib/task-coordinator.mjs";

/** Native global-parent surface; each worker runs the existing task pipeline. */
export default function harnessTasks(pi: ExtensionAPI) {
  pi.on(
    "tool_call",
    (event, ctx) =>
      decideTaskCoordinatorEdit(event, {
        projectRoot: ctx.cwd,
        sessionId: piSessionId(ctx),
        isChild: isChildSession(ctx),
      }) ?? undefined,
  );
  pi.registerTool({
    name: "harness_tasks",
    label: "Task runs",
    description:
      "Dispatch approved tasks in isolated worktrees, observe durable handles, integrate an exact verified task HEAD, or resume the same local task session with bounded feedback. Independent tasks may run in parallel. Status never starts or repeats work.",
    parameters: Type.Object(
      {
        action: Type.Union(
          ["dispatch", "status", "integrate", "resume"].map((value) =>
            Type.Literal(value),
          ),
        ),
        task_ids: Type.Optional(
          Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
        ),
        task_id: Type.Optional(Type.String()),
        task_contexts: Type.Optional(Type.Array(Type.Object({
          task_id: Type.String(),
          content: Type.String({ description: "Optional curated reference brief for this task only, up to 2 KiB UTF-8. No approvals, credentials or full shared_context diary." }),
        }, { additionalProperties: false }), { maxItems: 3 })),
        wait_seconds: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: 30,
            description:
              "For status: wait up to this many seconds if work is running. Default 20; zero returns immediately.",
          }),
        ),
        attempt_id: Type.Optional(Type.String()),
        expected_head: Type.Optional(Type.String()),
        instruction: Type.Optional(Type.String({ maxLength: 16000 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { wait_seconds: requestedWait, ...action } = params;
      if (
        requestedWait !== undefined &&
        (action.action !== "status" ||
          !Number.isInteger(requestedWait) ||
          requestedWait < 0 ||
          requestedWait > 30)
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "wait_seconds is only valid for status, from 0 to 30.",
            },
          ],
          details: { ok: false },
          isError: true,
        };
      }
      const context = {
        projectRoot: ctx.cwd,
        sessionId: piSessionId(ctx),
        isChild: isChildSession(ctx),
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel?.(),
        ...(process.env.ORCA_WORKTREE_ID ? { orca: { worktreeId: process.env.ORCA_WORKTREE_ID } } : {}),
      };
      let result = await executeTaskAction(action, context);
      const wait = requestedWait ?? 20;
      if (
        action.action === "status" &&
        result.ok &&
        result.tasks?.some((task) => task.status === "running") &&
        wait > 0 &&
        !signal?.aborted
      ) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, wait * 1000);
          signal?.addEventListener("abort", finish, { once: true });
        });
        result = await executeTaskAction(action, context);
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
        ...(result.ok ? {} : { isError: true }),
      };
    },
  });
}
