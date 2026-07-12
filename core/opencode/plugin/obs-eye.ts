/**
 * @description Post-task observability for eye agents (OC port of CC obs-eye-append).
 * tool.execute.after: args from output.args (OC contract). Full plan = non-empty tasks.
 * Default export is the OC plugin load contract.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";

function isTaskTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return n === "task" || n === "agent" || n.endsWith(".task") || n.endsWith(".agent");
}

function extractRole(args: Record<string, unknown> | null): string {
  if (!args) return "";
  const nested =
    args.input != null && typeof args.input === "object" && !Array.isArray(args.input)
      ? (args.input as Record<string, unknown>)
      : null;
  const raw =
    args.subagent_type ??
    args.subagentType ??
    args.agent ??
    args.role ??
    nested?.subagent_type ??
    nested?.agent;
  return typeof raw === "string" ? raw : "";
}

/**
 * @description True when a FULL execution plan exists (tasks.length > 0). Classify stub = false.
 */
function fullPlanExists(cwd: string, isFull: (p: string) => boolean): boolean {
  try {
    const plans = path.join(cwd, ".opencode", "plans");
    const entries = fs.readdirSync(plans, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const planPath = path.join(plans, e.name, "execution-plan.json");
      try {
        if (fs.statSync(planPath).isFile() && isFull(planPath)) return true;
      } catch {
        /* continue */
      }
    }
  } catch {
    return false;
  }
  return false;
}

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
export async function createObsEyeHooks(
  dir?: string,
): Promise<Pick<Hooks, "tool.execute.after">> {
  const { eventForEyeRole, isEyeRole, obsAppend, isFullExecutionPlan, resolveHookArgs } =
    await import("./lib/obs-emit.mjs");
  const cwd = typeof dir === "string" && dir ? dir : process.cwd();
  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const args = resolveHookArgs(input, output);
        const role = extractRole(args);
        if (!isEyeRole(role)) return;
        const text = extractResponse(input, output);
        const planExists = fullPlanExists(cwd, isFullExecutionPlan);
        const ev = eventForEyeRole(role, text, { planExists });
        if (ev) obsAppend(ev);
      } catch {
        /* fail-open */
      }
    },
  };
}

export const obsEye: Plugin = async ({ directory }) =>
  createObsEyeHooks(typeof directory === "string" ? directory : undefined);

/** @description OC load contract — default export required. */
export default obsEye;
