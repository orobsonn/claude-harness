/**
 * @description OC plan-write-gate — anti-forge for gate-state / .state via Write|Edit.
 * tool.execute.before: deny throws [plan-write-gate]. Does NOT block execution-plan.json
 * (orchestrator may author plans). Dynamic import of pure mjs (OC load contract).
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";

/**
 * @description Whether tool is write/edit (including namespaced variants).
 */
function isWriteTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return (
    n === "write" ||
    n === "edit" ||
    n.endsWith(".write") ||
    n.endsWith(".edit") ||
    n.endsWith("_write") ||
    n.endsWith("_edit")
  );
}

/**
 * @description Builds plan-write-gate hooks (async load of pure decide + resolveHookArgs).
 */
export async function createPlanWriteGateHooks(): Promise<
  Pick<Hooks, "tool.execute.before">
> {
  const { decide, throwIfDenied, extractWritePath } = await import(
    "./lib/plan-write-decide.mjs"
  );
  const { resolveHookArgs } = await import("./lib/obs-emit.mjs");

  return {
    "tool.execute.before": async (input: any, output: any) => {
      if (!isWriteTool(input?.tool)) return;
      const args = resolveHookArgs(input, output);
      const filePath =
        extractWritePath({ args: args ?? {} }) ||
        extractWritePath({
          tool_input: {
            file_path:
              typeof input?.tool_input?.file_path === "string"
                ? input.tool_input.file_path
                : undefined,
          },
        });
      throwIfDenied(decide({ args: { filePath }, tool_input: { file_path: filePath } }));
    },
  };
}

/**
 * @description OpenCode plugin factory — named const + default (OC load contract).
 */
export const PlanWriteGate: Plugin = async () => createPlanWriteGateHooks();

/** @description OC load contract — default export required. */
export default PlanWriteGate;
