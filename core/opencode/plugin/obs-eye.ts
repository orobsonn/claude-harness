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
): Promise<Pick<Hooks, "tool.execute.after">> {
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
  const cwd = typeof dir === "string" && dir ? dir : process.cwd();
  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const args = resolveHookArgs(input, output);
        const ids = extractTaskIds(args);
        if (!isEyeRole(ids.role)) return;
        // hands handled by obs-hand
        if (isHandRole(ids.role)) return;
        const text = extractResponse(input, output);
        const sessionId =
          typeof input?.sessionID === "string" ? input.sessionID : null;
        const planExists = fullPlanExistsForRun({
          cwd,
          sessionId,
          featureId: ids.featureId || null,
        });
        const ev = eventForEyeRole(ids.role, text, { planExists });
        if (ev) obsAppend(ev, { dedupe: dedupeByType });
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
