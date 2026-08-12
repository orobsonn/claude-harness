/**
 * @description Post-task observability for eye agents (OC port of CC obs-eye-append).
 * tool.execute.after: args from output.args. Full plan scoped to session+feature (not global scan).
 * Default export is the OC plugin load contract.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";

function extractResponse(input: any, output: any): string {
  try {
    const r =
      output?.output ??
      output?.content ??
      output?.result ??
      input?.tool_response ??
      input?.result ??
      "";
    return typeof r === "string" ? r : JSON.stringify(r ?? "");
  } catch {
    return "";
  }
}

/**
 * @description Build after-hooks for eye outbox events.
 */
async function createObsEyeHooks(
  dir?: string,
): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after">> {
  const { isTaskTool } = await import("../lib/task-dispatch-identity.mjs");
  const {
    eventForEyeRole,
    isEyeRole,
    isHandRole,
    obsAppend,
    dedupeByType,
    fullPlanExistsForRun,
    resolveHookArgs,
    extractTaskIds,
  } = await import("../lib/obs-emit.mjs");
  const { gateStatePath } = await import("../../shared/lib/path-helpers.mjs");
  const { reconcilePlannerStateFromDisk } = await import("../lib/planner-artifact.mjs");
  const { withGateStateLock } = await import("../lib/gate-state.mjs");
  const cwd = typeof dir === "string" && dir ? dir : process.cwd();
  const reviewCalls = new Map<string, { sessionId: string; featureId: string; binding: string }>();

  function bindingStamp(state: any, featureId: string): string | null {
    const binding = state?.planner_plan_binding;
    if (
      state?.planner_status !== "usable" ||
      state?.feature_id !== featureId ||
      !binding || typeof binding !== "object" || Array.isArray(binding) ||
      binding.session_id !== state?.session_id || binding.feature_id !== featureId ||
      typeof binding.snapshot_path !== "string" ||
      typeof binding.snapshot_file_hash !== "string" ||
      typeof binding.snapshot_hash !== "string" ||
      typeof binding.file_hash !== "string" ||
      typeof binding.semantic_hash !== "string"
    ) return null;
    return [
      state.session_id,
      featureId,
      binding.snapshot_path,
      binding.snapshot_file_hash,
      binding.snapshot_hash,
      binding.file_hash,
      binding.semantic_hash,
    ].join(":");
  }

  function strictPlanReviewVerdict(response: string): "APPROVE" | "REVISE" | null {
    const source = response.trimStart();
    if (!source.startsWith("{")) return null;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try {
          const verdict = JSON.parse(source.slice(0, index + 1))?.verdict;
          return verdict === "APPROVE" || verdict === "REVISE" ? verdict : null;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  return {
    "tool.execute.before": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const args = resolveHookArgs(input, output);
        const ids = extractTaskIds(args);
        if (!isEyeRole(ids.role) || isHandRole(ids.role)) return;
        const planned = eventForEyeRole(ids.role, "", { planExists: true });
        if (planned?.type !== "plan-reviewed" || typeof ids.featureId !== "string") return;
        const sessionId = typeof input?.sessionID === "string" ? input.sessionID : "";
        const callId = typeof input?.callID === "string" ? input.callID : "";
        if (!sessionId || !callId) return;
        const reconciled = reconcilePlannerStateFromDisk(cwd, sessionId);
        const binding = reconciled.ok && !reconciled.validatorFailed
          ? bindingStamp(reconciled.state, ids.featureId)
          : null;
        if (binding) reviewCalls.set(`${sessionId}:${callId}`, { sessionId, featureId: ids.featureId, binding });
      } catch {
        /* an unavailable receipt must never block a review */
      }
    },
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const args = resolveHookArgs(input, output);
        const ids = extractTaskIds(args);
        if (!isEyeRole(ids.role)) return;
        // hands handled by obs-hand
        if (isHandRole(ids.role)) return;
        const text = extractResponse(input, output);
        const eventSessionId =
          typeof input?.sessionID === "string" ? input.sessionID : null;
        const planExists = fullPlanExistsForRun({
          cwd,
          sessionId: eventSessionId,
          featureId: ids.featureId || null,
        });
        const ev = eventForEyeRole(ids.role, text, { planExists });
        if (ev) obsAppend(ev, { dedupe: dedupeByType });
        const sessionId = eventSessionId ?? "";
        const callId = typeof input?.callID === "string" ? input.callID : "";
        const review = sessionId && callId ? reviewCalls.get(`${sessionId}:${callId}`) : undefined;
        if (sessionId && callId) reviewCalls.delete(`${sessionId}:${callId}`);
        const verdict = review && ev?.type === "plan-reviewed" ? strictPlanReviewVerdict(text) : null;
        if (review && verdict) {
          const reconciled = reconcilePlannerStateFromDisk(cwd, review.sessionId);
          if (!reconciled.ok || reconciled.validatorFailed || bindingStamp(reconciled.state, review.featureId) !== review.binding) return;
          const statePath = gateStatePath({ projectRoot: cwd, runtime: "opencode", sessionId: review.sessionId });
          if (statePath.ok) {
            withGateStateLock(statePath.path, (state: Record<string, unknown>) => {
              if (bindingStamp(state, review.featureId) !== review.binding) return state;
              return { ...state, plan_review_verdict: verdict };
            });
          }
        }
      } catch {
        /* fail-open */
      }
    },
  };
}

export const obsEye: Plugin = async ({ directory }) =>
  createObsEyeHooks(typeof directory === "string" ? directory : undefined);
Object.defineProperty(obsEye, "testApi", { value: Object.freeze({ createObsEyeHooks }) });

/** @description OC load contract — default export required. */
export default obsEye;
