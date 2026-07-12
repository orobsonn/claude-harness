/**
 * @description Post-task observability for eye agents (OC port of CC obs-eye-append).
 * On tool.execute.after for task: if subagent is plan-reviewer/adversary/security/compliance,
 * append plan-reviewed / spec-adversary / eye. Fail-open always.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";

function isTaskTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return n === "task" || n === "agent" || n.endsWith(".task") || n.endsWith(".agent");
}

/**
 * @description Extract subagent_type / agent from task tool args.
 */
function extractRole(toolArgs: unknown): string {
  if (toolArgs == null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) return "";
  const a = toolArgs as Record<string, unknown>;
  const nested =
    a.input != null && typeof a.input === "object" && !Array.isArray(a.input)
      ? (a.input as Record<string, unknown>)
      : null;
  const raw =
    a.subagent_type ??
    a.subagentType ??
    a.agent ??
    a.role ??
    nested?.subagent_type ??
    nested?.agent;
  return typeof raw === "string" ? raw : "";
}

/**
 * @description Best-effort: does any execution-plan.json exist under .opencode/plans?
 */
function planExists(cwd: string): boolean {
  try {
    const plans = path.join(cwd, ".opencode", "plans");
    const entries = fs.readdirSync(plans, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      try {
        if (fs.statSync(path.join(plans, e.name, "execution-plan.json")).isFile()) {
          // stub vs full: treat presence as plan exists (post-classify stub counts as "plan phase started")
          // For spec-adversary we want pre-plan: only count non-stub (has tasks)?
          // CC checks any execution-plan.json. Keep same.
          return true;
        }
      } catch {
        /* continue */
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * @description Extract response text from after-hook payload.
 */
function extractResponse(input: any, output: any): string {
  try {
    const r =
      output?.output ??
      output?.content ??
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
  const { eventForEyeRole, isEyeRole, obsAppend } = await import("./lib/obs-emit.mjs");
  const cwd = typeof dir === "string" && dir ? dir : process.cwd();
  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const role = extractRole(input?.args ?? input?.toolArgs);
        if (!isEyeRole(role)) return;
        const text = extractResponse(input, output);
        const ev = eventForEyeRole(role, text, { planExists: planExists(cwd) });
        if (ev) obsAppend(ev);
      } catch {
        /* fail-open */
      }
    },
  };
}

export const obsEye: Plugin = async ({ directory }) =>
  createObsEyeHooks(typeof directory === "string" ? directory : undefined);
