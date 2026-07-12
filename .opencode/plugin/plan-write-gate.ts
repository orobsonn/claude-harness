/**
 * @description Thin TS shell for plan-write-gate (OC PreToolUse equivalent via tool.execute.before).
 * Delegates to pure decide in lib/plan-write-decide.mjs. Wires write/edit tools.
 */
import { decide } from "./lib/plan-write-decide.mjs";

export function registerPlanWriteGate(registerToolHook: any) {
  const tools = ["write", "edit", "Write", "Edit"];
  for (const t of tools) {
    registerToolHook(t, (payload: any) => {
      const res = decide(payload);
      if (!res.allow) {
        return res.hookSpecificOutput;
      }
      return undefined;
    });
  }
}
