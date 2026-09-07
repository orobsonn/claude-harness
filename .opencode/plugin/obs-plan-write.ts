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
  const { featureFromPlanPath } = await import("./lib/plan-path-feature.mjs");
  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const args = resolveHookArgs(input, output);
        const filePath = extractPath(args);
        if (!isWriteTool(input?.tool)) return;
        if (!filePath && isWriteTool(input?.tool)) return;
        const ev = filePath ? eventForPlanPath(filePath) : null;
        if (!ev) return;
        const feature = featureFromPlanPath(filePath);
        const sessionId = typeof input?.sessionID === "string" ? input.sessionID : "";
        if (feature) Object.assign(ev, { ...(sessionId ? { session_id: sessionId } : {}), feature_id: feature.featureId });
        if (ev.type === "plan-created") {
          try {
            const parsed = JSON.parse(typeof args?.content === "string" ? args.content : "null");
            if (Array.isArray(parsed?.tasks)) Object.assign(ev, { tasks: parsed.tasks.length });
          } catch { /* event remains factual at path level */ }
        }
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
