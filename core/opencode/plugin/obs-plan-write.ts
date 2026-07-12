/**
 * @description Post-write observability for plan/spec files (OC port of CC obs-plan-write).
 * On tool.execute.after for write/edit: if path is execution-plan.json or a spec under plans,
 * append plan-created / spec-created to HARNESS_OBSERVABILITY_RUN_PATH. Fail-open always.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";

function extractPath(toolArgs: unknown): string {
  if (toolArgs == null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) return "";
  const a = toolArgs as Record<string, unknown>;
  const p = a.filePath ?? a.path ?? a.file ?? a.target;
  return typeof p === "string" ? p : "";
}

function isWriteTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return n === "write" || n === "edit" || n.endsWith(".write") || n.endsWith(".edit");
}

/**
 * @description Build after-hooks for plan/spec outbox events.
 */
export async function createObsPlanWriteHooks(): Promise<
  Pick<Hooks, "tool.execute.after">
> {
  const { eventForPlanPath, obsAppend } = await import("./lib/obs-emit.mjs");
  return {
    "tool.execute.after": async (input: any) => {
      try {
        if (!isWriteTool(input?.tool)) return;
        const filePath = extractPath(input?.args ?? input?.toolArgs);
        const ev = eventForPlanPath(filePath);
        if (ev) obsAppend(ev);
      } catch {
        /* fail-open */
      }
    },
  };
}

export const obsPlanWrite: Plugin = async () => createObsPlanWriteHooks();
