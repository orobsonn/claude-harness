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
 * @description Build after-hooks for plan/spec outbox events.
 */
export async function createObsPlanWriteHooks(): Promise<
  Pick<Hooks, "tool.execute.after">
> {
  const { eventForPlanPath, obsAppend, dedupeByType, resolveHookArgs } = await import(
    "./lib/obs-emit.mjs"
  );
  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isWriteTool(input?.tool)) return;
        const args = resolveHookArgs(input, output);
        const filePath = extractPath(args);
        const ev = eventForPlanPath(filePath);
        if (!ev) return;
        if (ev.type === "plan-created" && filePath) {
          try {
            const fs = await import("node:fs");
            // Prefer on-disk file after write; fall back to args content if present.
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

export const obsPlanWrite: Plugin = async () => createObsPlanWriteHooks();

/** @description OC load contract — default export required. */
export default obsPlanWrite;
