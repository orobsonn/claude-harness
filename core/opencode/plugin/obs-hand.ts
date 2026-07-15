/**
 * @description Structural mid-run obs for hand roles (executor/sniper/test-author).
 * before: task-executing (n/total from plan when possible)
 * after: hand-ran
 * Fail-open. Default export = OC load contract.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

function isTaskTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return n === "task" || n === "agent" || n.endsWith(".task") || n.endsWith(".agent");
}

/**
 * @description Build before+after hooks for hand observability.
 */
export async function createObsHandHooks(
  dir?: string,
): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after">> {
  const {
    isHandRole,
    extractTaskIds,
    resolveHookArgs,
    eventForTaskExecuting,
    eventForHandRan,
    obsAppend,
    dedupeByType,
    taskIndexFromPlan,
    planDirForRun,
  } = await import("./lib/obs-emit.mjs");
  const cwd = typeof dir === "string" && dir ? dir : process.cwd();

  function emitTaskExecuting(sessionId: string | null, ids: ReturnType<typeof extractTaskIds>) {
    try {
      if (!ids.taskId) return;
      let featureId = ids.featureId;
      if (!featureId && sessionId) {
        try {
          const state = JSON.parse(readFileSync(join(cwd, ".opencode", "plans", ".state", sessionId, "gate-state.json"), "utf8"));
          featureId = typeof state?.feature_id === "string" ? state.feature_id : "";
        } catch {
          /* fail-open observability */
        }
      }
      let nTotal: { n: number; total: number } | null = null;
      if (sessionId && featureId) {
        const planPath = join(
          planDirForRun(cwd, sessionId, featureId) || "",
          "execution-plan.json",
        );
        if (planPath && existsSync(planPath)) {
          nTotal = taskIndexFromPlan(planPath, ids.taskId);
        }
      }
      // Fallback: still emit n=1 total=1 only if we have task id? Prefer skip without plan index.
      if (!nTotal) return;
      const ev = eventForTaskExecuting(nTotal);
      if (ev) obsAppend(ev, { dedupe: dedupeByType });
    } catch {
      /* fail-open */
    }
  }

  return {
    "tool.execute.before": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const args = resolveHookArgs(input, output);
        const ids = extractTaskIds(args);
        if (!isHandRole(ids.role)) return;
        const sessionId =
          typeof input?.sessionID === "string" ? input.sessionID : null;
        emitTaskExecuting(sessionId, ids);
      } catch {
        /* fail-open */
      }
    },
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const args = resolveHookArgs(input, output);
        const ids = extractTaskIds(args);
        if (!isHandRole(ids.role)) return;
        // No structured task_id → skip (avoid hand-ran task:"unknown" spam).
        // Trustworthy hand-ran comes from the host-bound native mark tool with real ids.
        if (!ids.taskId) return;
        const ev = eventForHandRan({
          task: ids.taskId,
          model: ids.model || ids.role,
        });
        if (ev) obsAppend(ev, { dedupe: dedupeByType });
      } catch {
        /* fail-open */
      }
    },
  };
}

export const obsHand: Plugin = async ({ directory }) =>
  createObsHandHooks(typeof directory === "string" ? directory : undefined);

/** @description OC load contract. */
export default obsHand;
