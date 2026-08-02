/**
 * @description Thin OC plugin carrier for main-loop idle nudge on Task/agent dispatches.
 * Mirrors obs-eye.ts pattern: create*Hooks + Plugin + default export.
 * tool.execute.after is fail-open; builds payload for decide using distinct fields
 * for tool_response/tool_output; copies agent_* keys from input only via hasOwn.
 * Sets output.metadata.agent_idle_nudge when decide returns inject.
 * Never imports or calls applyDualNudge.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";

async function createAgentIdleNudgeHooks(
  dir?: string,
): Promise<Pick<Hooks, "tool.execute.after">> {
  const { decide } = await import("./lib/agent-idle-nudge.mjs");
  const { isTaskTool } = await import("../lib/task-dispatch-identity.mjs");
  const { resolveHookArgs } = await import("../lib/obs-emit.mjs");
  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const toolInput = resolveHookArgs(input, output) ?? input?.tool_input ?? {};
        if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) return;

        // presence check only — hasOwn on input
        if (
          Object.prototype.hasOwnProperty.call(input, "agent_id") ||
          Object.prototype.hasOwnProperty.call(input, "agentId") ||
          Object.prototype.hasOwnProperty.call(input, "agentID")
        ) {
          return;
        }

        const payload: Record<string, unknown> = {
          tool_name: input.tool,
          tool_input: toolInput,
        };

        // Distinct fields only — never ?? collapse so '' cannot mask a sibling report field.
        if (output != null && typeof output === "object" && !Array.isArray(output)) {
          if (Object.prototype.hasOwnProperty.call(output, "output")) {
            payload.tool_response = output.output;
          }
          if (Object.prototype.hasOwnProperty.call(output, "tool_output")) {
            payload.tool_output = output.tool_output;
          } else if (Object.prototype.hasOwnProperty.call(output, "content")) {
            // content is a report channel (obs-eye) — map to tool_output only when tool_output absent
            payload.tool_output = output.content;
          } else if (Object.prototype.hasOwnProperty.call(output, "result")) {
            payload.tool_output = output.result;
          }
        }

        const res = decide(payload);
        if (res && res.action === "inject" && typeof res.context === "string") {
          if (!output.metadata || typeof output.metadata !== "object") {
            output.metadata = {};
          }
          output.metadata.agent_idle_nudge = res.context;
        }
      } catch {
        /* fail-open */
      }
    },
  };
}

export const agentIdleNudge: Plugin = async ({ directory }) =>
  createAgentIdleNudgeHooks(typeof directory === "string" ? directory : undefined);
Object.defineProperty(agentIdleNudge, "testApi", { value: Object.freeze({ createAgentIdleNudgeHooks }) });

/** @description OC load contract — default export required. */
export default agentIdleNudge;
