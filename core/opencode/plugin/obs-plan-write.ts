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

function isBashTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return n === "bash" || n === "shell" || n.endsWith(".bash") || n.endsWith("_bash");
}

/**
 * @description After execution-plan.json lands on disk, bind planner immediately (auto-bind).
 * Removes race: plan-reviewer before usable.
 */
async function maybeAutoBindPlan(projectRoot: string, filePath: string) {
  try {
    const { sessionFeatureFromPlanPath } = await import("./lib/plan-path-session.mjs");
    const ids = sessionFeatureFromPlanPath(filePath);
    if (!ids) return;
    if (!/execution-plan\.json$/i.test(filePath.replace(/\\/g, "/"))) return;
    const { reconcilePlannerStateFromDisk } = await import("./lib/planner-artifact.mjs");
    reconcilePlannerStateFromDisk(projectRoot, ids.sessionId);
  } catch {
    /* fail-open */
  }
}

/**
 * @description Build after-hooks for plan/spec outbox events + planner auto-bind.
 */
export async function createObsPlanWriteHooks(
  projectRoot?: string,
): Promise<Pick<Hooks, "tool.execute.after">> {
  const { eventForPlanPath, obsAppend, dedupeByType, resolveHookArgs } = await import(
    "./lib/obs-emit.mjs"
  );
  const root =
    typeof projectRoot === "string" && projectRoot.length > 0 ? projectRoot : process.cwd();
  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const args = resolveHookArgs(input, output);
        let filePath = extractPath(args);
        // bash tee/printf path: scrape command for execution-plan.json
        if (!filePath && isBashTool(input?.tool)) {
          const cmd = typeof args?.command === "string" ? args.command : "";
          const m = cmd.match(/(\S*execution-plan\.json)/);
          if (m) filePath = m[1];
        }
        if (filePath) {
          await maybeAutoBindPlan(root, filePath);
        }
        if (!isWriteTool(input?.tool) && !isBashTool(input?.tool)) return;
        if (!filePath && isWriteTool(input?.tool)) return;
        const ev = filePath ? eventForPlanPath(filePath) : null;
        if (!ev) return;
        if (ev.type === "plan-created" && filePath) {
          try {
            const fs = await import("node:fs");
            let raw = "";
            if (typeof args?.content === "string") raw = args.content;
            else if (fs.existsSync(filePath)) raw = fs.readFileSync(filePath, "utf8");
            if (raw) {
              const j = JSON.parse(raw);
              if (Array.isArray(j?.tasks)) (ev as { tasks?: number }).tasks = j.tasks.length;
            }
          } catch {
            /* optional enrichment */
          }
        }
        obsAppend(ev, { dedupe: dedupeByType });
      } catch {
        /* fail-open */
      }
    },
  };
}

export const obsPlanWrite: Plugin = async ({ directory, worktree }: any) => {
  const root =
    typeof directory === "string" && directory
      ? directory
      : typeof worktree === "string" && worktree
        ? worktree
        : process.cwd();
  return createObsPlanWriteHooks(root);
};

/** @description OC load contract — default export required. */
export default obsPlanWrite;
