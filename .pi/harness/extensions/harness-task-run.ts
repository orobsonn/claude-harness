import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { TASK_RUN_ENV, readTaskRunBinding, decideTaskRunTool } from "../lib/task-run.mjs";
import { piSessionId } from "../lib/pi-adapter-map.mjs";
import { readPiChildIdentity } from "../lib/pi-child-identity.mjs";

/** Limit a delegated task parent and its native children without replacing native gates. */
export default function harnessTaskRun(pi: ExtensionAPI) {
  const encoded = process.env[TASK_RUN_ENV];
  if (!encoded) return;
  let owner: { cwd: string; sessionId: string } | null = null;
  try {
    const parsed = JSON.parse(encoded);
    if (parsed && typeof parsed.cwd === "string" && typeof parsed.sessionId === "string") owner = parsed;
  } catch {
    // All tool calls below fail closed for a malformed inherited task environment.
  }

  pi.on("tool_call", (event, ctx) => {
    if (!owner || ctx.cwd !== owner.cwd) return { block: true, reason: "[task-run] task runtime owner/cwd mismatch" };
    const sessionId = piSessionId(ctx);
    if (sessionId !== owner.sessionId) {
      const identity = readPiChildIdentity(ctx.cwd, sessionId);
      if (!identity.ok || identity.record.parent_session_id !== owner.sessionId) {
        return { block: true, reason: "[task-run] exact native child identity required" };
      }
    }
    const decision = decideTaskRunTool(readTaskRunBinding(owner.cwd, owner.sessionId), event);
    return decision.block ? decision : undefined;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!owner || piSessionId(ctx) !== owner.sessionId) return;
    const binding = readTaskRunBinding(owner.cwd, owner.sessionId);
    return {
      message: {
        customType: "harness-task-run",
        display: false,
        content: binding.ok
          ? `Delegated TASK mode remains active for ${binding.grant.task_id}. Continue this attempt's native TDD/review loop and return evidence to parent ${binding.grant.parent_session_id}. Do not run global ceremony, sibling tasks, harvest or shipping.`
          : "Delegated task authority is invalid. Stop and report the failed binding without reclassifying or creating another run.",
      },
    };
  });
}
