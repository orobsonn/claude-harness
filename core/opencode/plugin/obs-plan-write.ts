/**
 * @description Post-write observability for plan/spec files (OC port of CC obs-plan-write).
 * tool.execute.after: args from output.args (OC contract). Fail-open always.
 * Default export is the OC plugin load contract.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";

function isWriteTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return n === "write" || n === "edit" || n.endsWith(".write") || n.endsWith(".edit");
}

function extractPath(args: Record<string, unknown> | null): string {
  if (!args) return "";
  const p = args.filePath ?? args.path ?? args.file ?? args.target;
  return typeof p === "string" ? p : "";
}

/**
 * @description Build fail-open after-hooks for actual Write/Edit plan/spec observations.
 */
async function createObsPlanWriteHooks(
  _projectRoot?: string,
): Promise<Pick<Hooks, "tool.execute.after">> {
  const { eventForPlanPath, obsAppend, dedupeByType, resolveHookArgs } = await import(
    "../lib/obs-emit.mjs"
  );
  const { sessionFeatureFromPlanPath } = await import("./lib/plan-path-session.mjs");
  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const args = resolveHookArgs(input, output);
        let filePath = extractPath(args);
        if (!isWriteTool(input?.tool)) return;
        if (!filePath && isWriteTool(input?.tool)) return;
        const ev = filePath ? eventForPlanPath(filePath) : null;
        // Canonical execution-plan writes are owner-only (`planner-recovery`); this observer
        // must never consume the global plan-created dedupe key for a forbidden model write.
        if (!ev || ev.type === "plan-created") return;
        const sessionFeature = sessionFeatureFromPlanPath(filePath);
        if (sessionFeature) Object.assign(ev, { session_id: sessionFeature.sessionId, feature_id: sessionFeature.featureId });
        obsAppend(ev, { dedupe: dedupeByType });
      } catch {
        /* fail-open */
      }
    },
  };
}

export const obsPlanWrite: Plugin = async ({ directory, worktree }: any) => {
  return createObsPlanWriteHooks(typeof directory === "string" && directory ? directory : worktree);
};
Object.defineProperty(obsPlanWrite, "testApi", { value: Object.freeze({ createObsPlanWriteHooks }) });

/** @description OC load contract — default export required. */
export default obsPlanWrite;
