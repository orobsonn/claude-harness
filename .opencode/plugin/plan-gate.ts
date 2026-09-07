/** @description Guard downstream Task dispatches with the feature-stable execution plan. */

import fs from "node:fs";
import type { Plugin, Hooks } from "@opencode-ai/plugin";

const PREFIX = "[plan-gate]";

function dispatchIds(args: unknown): { featureId: string; taskId: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { featureId: "", taskId: "" };
  const record = args as Record<string, unknown>;
  const nested = record.input && typeof record.input === "object" && !Array.isArray(record.input)
    ? record.input as Record<string, unknown>
    : {};
  const stringValue = (value: unknown) => typeof value === "string" ? value : "";
  return {
    featureId: stringValue(record.feature_id ?? record.featureId ?? nested.feature_id ?? nested.featureId),
    taskId: stringValue(record.taskId ?? record.task ?? nested.taskId ?? nested.task),
  };
}

function readJsonObject(filePath: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value }
      : { ok: false, reason: "invalid object" };
  } catch (error) {
    return { ok: false, reason: (error as { code?: string })?.code === "ENOENT" ? "missing" : "unreadable" };
  }
}

/** @description Build the stable-plan gate; validation is repeated for every guarded call. */
async function createPlanGateHooks(
  projectRoot: string,
  deps: { validatePlanFn?: (plan: unknown, options: unknown) => { ok: boolean; errors: string[] } } = {},
): Promise<Pick<Hooks, "tool.execute.before">> {
  const root = typeof projectRoot === "string" && projectRoot ? projectRoot : process.cwd();
  const { extractSubagentType, isTaskTool, parseTaskDispatchIdentity } = await import("../lib/task-dispatch-identity.mjs");
  const { extractHookTaskContext, resolveHookIdentity } = await import("./lib/hook-identity.mjs");
  const { decidePlanGate, throwIfPlanDenied } = await import("./lib/plan-decide.mjs");
  const { bareRole, isExecutorRole, isPlanReviewerRole, isSniperRole, isTestAuthorRole } = await import("../lib/roles.mjs");
  const { executionPlanPath, gateStatePath } = await import("../shared/lib/path-helpers.mjs");

  return {
    "tool.execute.before": async (input: any, output: any) => {
      const { toolName, toolArgs } = extractHookTaskContext(input, output);
      if (!isTaskTool(toolName)) return;
      const role = bareRole(extractSubagentType(toolArgs));
      const guarded = isPlanReviewerRole(role) || isTestAuthorRole(role) || isExecutorRole(role) || isSniperRole(role);
      if (!guarded) return;

      const prompt = toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
        ? (toolArgs as Record<string, unknown>).prompt
        : undefined;
      const marker = parseTaskDispatchIdentity(prompt);
      const identity = resolveHookIdentity({ input, toolArgs, promptTaskId: marker.ok ? marker.taskId : "" });
      if (!identity.ok) throw new Error(`${PREFIX} denied: ${identity.reason}`);
      const sessionId = identity.sessionIdSource === "runtime-envelope" ? identity.sessionId : "";
      if (!sessionId) throw new Error(`${PREFIX} denied: trusted session identity required`);

      const stateResolved = gateStatePath({ projectRoot: root, runtime: "opencode", sessionId });
      if (!stateResolved.ok) throw new Error(`${PREFIX} denied: ${stateResolved.reason}`);
      const stateRead = readJsonObject(stateResolved.path);
      if (!stateRead.ok) throw new Error(`${PREFIX} denied: gate-state ${stateRead.reason}`);
      const state = stateRead.value;
      if (state.session_id !== sessionId || state.classified !== true) {
        throw new Error(`${PREFIX} denied: classified session identity mismatch`);
      }
      const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
      const mode = typeof state.mode === "string" ? state.mode : "";
      if (!featureId || !["LIGHT", "FULL"].includes(mode)) {
        throw new Error(`${PREFIX} denied: classified LIGHT/FULL feature required`);
      }

      const planResolved = executionPlanPath({ projectRoot: root, runtime: "opencode", featureId });
      if (!planResolved.ok) throw new Error(`${PREFIX} denied: ${planResolved.reason}`);
      const planRead = readJsonObject(planResolved.path);
      if (!planRead.ok) throw new Error(`${PREFIX} denied: stable plan ${planRead.reason}`);
      const decision = decidePlanGate(
        { plan: planRead.value, expect: "full", expectedModelStrategy: planRead.value.model_strategy },
        { validatePlanFn: deps.validatePlanFn },
      );
      if (decision.decision === "warn") console.warn(`${PREFIX} ${decision.reason}`);
      throwIfPlanDenied(decision);

      if (planRead.value.feature_id !== featureId) {
        throw new Error(`${PREFIX} denied: stable plan feature mismatch`);
      }
      const expectedPlanMode = mode.toLowerCase();
      if (planRead.value.mode !== expectedPlanMode) {
        throw new Error(`${PREFIX} denied: stable plan mode mismatch (${String(planRead.value.mode)} != ${expectedPlanMode})`);
      }
      const ids = dispatchIds(toolArgs);
      if (identity.featureId && identity.featureId !== featureId) {
        throw new Error(`${PREFIX} denied: dispatch feature_id conflicts with stable plan feature`);
      }
      if (ids.featureId && ids.featureId !== featureId) {
        throw new Error(`${PREFIX} denied: optional dispatch feature_id conflicts with stable plan feature`);
      }
      const requiresTaskId = isTestAuthorRole(role) || isExecutorRole(role) || isSniperRole(role);
      if (requiresTaskId && !marker.ok && identity.taskIdSource !== "runtime-envelope") {
        throw new Error(`${PREFIX} denied: ${role} ${String(marker?.reason ?? "task prompt marker missing")}`);
      }
      const taskId = identity.taskId || ids.taskId;
      const tasks = Array.isArray(planRead.value.tasks) ? planRead.value.tasks : [];
      if (taskId && !tasks.some((task: any) => task?.id === taskId)) {
        throw new Error(`${PREFIX} denied: dispatch task_id does not exist in stable plan`);
      }
      // Deliberately do not mutate `toolArgs.prompt`: the brief is the model-owned transport.
    },
  };
}

function resolveProjectRoot(directory?: unknown, worktree?: unknown): string {
  if (typeof directory === "string" && directory.length > 0) return directory;
  if (typeof worktree === "string" && worktree.length > 0) return worktree;
  if (directory != null && typeof directory === "object" && !Array.isArray(directory)) {
    const nested = (directory as { directory?: unknown }).directory;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return process.cwd();
}

export const PlanGate: Plugin = async ({ directory, worktree }: any) => {
  return createPlanGateHooks(resolveProjectRoot(directory, worktree));
};
Object.defineProperty(PlanGate, "testApi", { value: Object.freeze({ createPlanGateHooks }) });

export default PlanGate;
