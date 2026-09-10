import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isChildSession, piSessionId } from "../lib/pi-adapter-map.mjs";
import {
  executeTaskAction,
  decideTaskCoordinatorEdit,
} from "../lib/task-coordinator.mjs";
import { waitForOrcaTaskTerminalExit } from "../lib/task-orca.mjs";

const ORCA_WAIT_WINDOW_MS = 300_000;
const LOCAL_OBSERVATION_MS = 5_000;

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function waitForFirstOrcaExit(
  handles: string[],
  projectRoot: string,
  signal: AbortSignal | undefined,
  waitOrca: typeof waitForOrcaTaskTerminalExit,
  localWake?: (signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const attempts: Promise<any>[] = handles.map(async (handle) => {
    try {
      const wait = await waitOrca({
        projectRoot,
        terminalHandle: handle,
        timeoutMs: ORCA_WAIT_WINDOW_MS,
        signal: controller.signal,
      });
      return { handle, wait };
    } catch (error) {
      if (controller.signal.aborted) return { handle, wait: { satisfied: false }, aborted: true };
      // A stale runtime handle or an Orca restart cannot decide task lifecycle.
      // Retire this wake source and fall back to host status observation.
      return { handle, wait: { satisfied: false }, unavailable: true, error };
    }
  });
  if (localWake) attempts.push(localWake(controller.signal).then(() => ({ wait: { satisfied: false }, local: true })));
  try {
    return await Promise.race(attempts);
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", abort);
    await Promise.allSettled(attempts);
  }
}

/** Wait outside the coordinator lock. Terminal/process completion only wakes a fresh
 * status read; the task receipt remains the sole completion authority. */
export async function waitForTaskChange(
  { taskId, context, signal }: { taskId?: string; context: any; signal?: AbortSignal },
  injected: {
    executeAction?: typeof executeTaskAction;
    waitOrca?: typeof waitForOrcaTaskTerminalExit;
    delay?: typeof delay;
  } = {},
) {
  const executeAction = injected.executeAction ?? executeTaskAction;
  const waitOrca = injected.waitOrca ?? waitForOrcaTaskTerminalExit;
  const waitLocal = injected.delay ?? delay;
  const statusParams = { action: "status", ...(taskId ? { task_id: taskId } : {}) };
  let result = await executeAction(statusParams, context);
  if (!result.ok) return result;
  const initiallyRunning = new Set(
    result.tasks.filter((task: any) => task.status === "running").map((task: any) => task.task_id),
  );
  if (initiallyRunning.size === 0)
    return { ...result, wait: { outcome: "settled" } };

  const retiredHandles = new Set<string>();
  while (true) {
    if (signal?.aborted)
      return { ...result, wait: { outcome: "aborted" } };
    const running = result.tasks.filter(
      (task: any) => initiallyRunning.has(task.task_id) && task.status === "running",
    );
    if (running.length < initiallyRunning.size)
      return { ...result, wait: { outcome: "changed" } };
    const beforeRuns = new Map(
      running.map((task: any) => [task.task_id, task.launches.at(-1)?.run_id]),
    );
    const taskHandles = running.map((task: any) => task.launches.at(-1)?.orca?.terminal_handle);
    const handles = [...new Set(taskHandles
      .filter((handle: unknown): handle is string => typeof handle === "string" && !retiredHandles.has(handle)))];
    if (handles.length > 0) {
      const needsLocalWake = taskHandles.some(
        (handle: unknown) => typeof handle !== "string" || retiredHandles.has(handle),
      );
      const wake = await waitForFirstOrcaExit(
        handles,
        context.projectRoot,
        signal,
        waitOrca,
        needsLocalWake ? (waitSignal) => waitLocal(LOCAL_OBSERVATION_MS, waitSignal) : undefined,
      );
      if (wake.handle && (wake.wait.satisfied || wake.unavailable)) retiredHandles.add(wake.handle);
    } else {
      await waitLocal(LOCAL_OBSERVATION_MS, signal);
    }
    if (signal?.aborted)
      return { ...result, wait: { outcome: "aborted" } };
    const next = await executeAction(statusParams, context);
    if (!next.ok) return next;
    const changed = next.tasks.some((task: any) =>
      initiallyRunning.has(task.task_id) &&
      (task.status !== "running" || task.launches.at(-1)?.run_id !== beforeRuns.get(task.task_id)),
    );
    result = next;
    if (changed) return { ...result, wait: { outcome: "changed" } };
  }
}

/** Native global-parent surface; each worker runs the existing task pipeline. */
export default function harnessTasks(pi: ExtensionAPI, injected: Parameters<typeof waitForTaskChange>[1] = {}) {
  pi.on(
    "tool_call",
    (event, ctx) =>
      decideTaskCoordinatorEdit(event, {
        projectRoot: ctx.cwd,
        sessionId: piSessionId(ctx),
        isChild: isChildSession(ctx),
      }) ?? undefined,
  );
  pi.on("tool_result", (event: any) => {
    if (event.toolName === "harness_tasks" && event.details?.ok === false) return { isError: true };
  });
  pi.registerTool({
    name: "harness_tasks",
    label: "Task runs",
    description:
      "Dispatch approved tasks in isolated worktrees, observe or wait on durable handles, integrate an exact verified task HEAD, or resume the same local task session with bounded feedback. Independent tasks may run in parallel. To fix an upstream defect blocking a dependent, resume and integrate the owning task once affected processes terminate, then resume the dependent to merge the correction and obtain current reviews. Status and wait never start or repeat work.",
    parameters: Type.Object(
      {
        action: Type.Union(
          ["dispatch", "status", "wait", "integrate", "resume"].map((value) =>
            Type.Literal(value),
          ),
        ),
        task_ids: Type.Optional(
          Type.Array(Type.String(), {
            minItems: 1,
            maxItems: 3,
            description: "Plural task identifiers for dispatch only.",
          }),
        ),
        task_id: Type.Optional(Type.String({
          description: "Singular task identifier for status, wait, integrate, or resume; not dispatch.",
        })),
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
        const result = { ok: false, reason: `[harness-tasks:${String(action.action ?? "unknown")}] wait_seconds is only valid for status, from 0 to 30.` };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: true };
      }
      if (action.action !== "dispatch" && action.task_ids !== undefined) {
        const result = {
          ok: false,
          reason: `[harness-tasks:${String(action.action ?? "unknown")}] task_ids is only valid for dispatch; use task_id for ${String(action.action ?? "this action")}.`,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: true };
      }
      if (action.action === "dispatch" && action.task_id !== undefined) {
        const result = {
          ok: false,
          reason: "[harness-tasks:dispatch] task_id is not valid for dispatch; use task_ids.",
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: true };
      }
      const context = {
        projectRoot: ctx.cwd,
        sessionId: piSessionId(ctx),
        isChild: isChildSession(ctx),
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel?.(),
        ...(process.env.ORCA_WORKTREE_ID ? { orca: { worktreeId: process.env.ORCA_WORKTREE_ID } } : {}),
      };
      let result;
      try {
        if (action.action === "wait") {
          if (Object.keys(action).some((key) => !["action", "task_id"].includes(key)))
            throw new Error("wait accepts only an optional task_id");
          result = await waitForTaskChange({ taskId: action.task_id, context, signal }, injected);
        } else {
          result = await (injected.executeAction ?? executeTaskAction)(action, context);
        }
      } catch (error) {
        result = { ok: false, reason: `task observation unavailable: ${error instanceof Error ? error.message : String(error)}` };
      }
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
        result = await (injected.executeAction ?? executeTaskAction)(action, context);
      }
      if (!result.ok) result = { ...result, reason: `[harness-tasks:${String(action.action ?? "unknown")}] ${result.reason ?? "Task action failed"}` };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
        ...(result.ok ? {} : { isError: true }),
      };
    },
  });
}
