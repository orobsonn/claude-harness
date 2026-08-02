/** @description Fail-open hand observation and terminal completion production. */
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @description Build observation hooks with no dispatch scope authority. */
async function createObsHandHooks(dir?: string): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after">> {
  const { isHandRole, extractTaskIds, resolveHookArgs, eventForTaskExecuting, eventForHandRan, obsAppend, dedupeByType, taskIndexFromPlan, planDirForRun } = await import("../lib/obs-emit.mjs");
  const { isExecutorRole, isSniperRole, isTestAuthorRole } = await import("../lib/roles.mjs");
  const { isTaskTool } = await import("../lib/task-dispatch-identity.mjs");
  const { recordTaskCompletion } = await import("./lib/host-hand-capture.mjs");
  const cwd = typeof dir === "string" && dir ? dir : process.cwd();
  const writingHand = (role: unknown) => isExecutorRole(role) || isSniperRole(role) || isTestAuthorRole(role);

  function featureId(sessionId: string, ids: ReturnType<typeof extractTaskIds>) {
    if (ids.featureId) return ids.featureId;
    try {
      const state = JSON.parse(readFileSync(join(cwd, ".opencode", "plans", ".state", sessionId, "gate-state.json"), "utf8"));
      return typeof state?.feature_id === "string" ? state.feature_id : "";
    } catch { return ""; }
  }

  function emitExecuting(sessionId: string, fid: string, taskId: string) {
    try {
      const planPath = join(planDirForRun(cwd, sessionId, fid) || "", "execution-plan.json");
      if (!planPath || !existsSync(planPath)) return;
      const indexed = taskIndexFromPlan(planPath, taskId);
      const event = indexed ? eventForTaskExecuting(indexed) : null;
      if (event) obsAppend(event, { dedupe: dedupeByType });
    } catch { /* observation stays fail-open */ }
  }

  return {
    "tool.execute.before": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const ids = extractTaskIds(resolveHookArgs(input, output));
        const sessionId = typeof input?.sessionID === "string" ? input.sessionID : "";
        if (!isHandRole(ids.role) || !sessionId || !ids.taskId) return;
        emitExecuting(sessionId, featureId(sessionId, ids), ids.taskId);
      } catch { /* observation stays fail-open */ }
    },
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const args = resolveHookArgs(input, output);
        const ids = extractTaskIds(args);
        const sessionId = typeof input?.sessionID === "string" ? input.sessionID : "";
        const producerCallId = typeof input?.callID === "string" ? input.callID : "";
        if (!isHandRole(ids.role) || !writingHand(ids.role) || !sessionId || !producerCallId || !ids.taskId) return;
        const outputText = String(output?.output ?? output?.content ?? output?.result ?? "");
        const fid = featureId(sessionId, ids);
        if (!fid) return;
        const completion = recordTaskCompletion({ projectRoot: cwd, sessionId, featureId: fid, taskId: ids.taskId, role: ids.role, producerCallId, outputText, background: output?.metadata?.background === true });
        if (completion.terminal === false) return;
        const event = eventForHandRan({ task: ids.taskId, model: ids.model || ids.role });
        if (event) obsAppend(event, { dedupe: dedupeByType });
      } catch { /* completion observation never authorizes or denies */ }
    },
  };
}

export const obsHand: Plugin = async ({ directory }: any) => createObsHandHooks(typeof directory === "string" ? directory : undefined);
Object.defineProperty(obsHand, "testApi", { value: Object.freeze({ createObsHandHooks }) });
export default obsHand;
