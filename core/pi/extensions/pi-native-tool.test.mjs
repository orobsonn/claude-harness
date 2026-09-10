import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runAgentLoop } from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js";

function mergeToolResult(event, patch) {
  if (!patch) return event;
  return {
    ...event,
    ...(patch.content === undefined ? {} : { content: patch.content }),
    ...(patch.details === undefined ? {} : { details: patch.details }),
    ...(patch.isError === undefined ? {} : { isError: patch.isError }),
    ...(patch.usage === undefined ? {} : { usage: patch.usage }),
  };
}

/** Exercise the declared Pi SDK's real agent loop with a synthetic in-memory stream. */
export async function runNativeToolCall({ tool, input, hooks = new Map(), ctx = {} }) {
  const callId = "native-tool-call";
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(tool.name, input, { id: callId }), { stopReason: "toolUse" }),
    fauxAssistantMessage("synthetic run complete"),
  ]);
  const events = [];
  const invoke = async (name, event) => {
    const handlers = hooks.get(name) ?? [];
    let current = event;
    for (const handler of Array.isArray(handlers) ? handlers : [handlers]) {
      const patch = await handler(current, ctx);
      if (name === "tool_result") current = mergeToolResult(current, patch);
    }
    return current;
  };
  const nativeTool = {
    ...tool,
    execute: (toolCallId, args, signal, onUpdate) => tool.execute(toolCallId, args, signal, onUpdate, ctx),
  };
  const messages = await runAgentLoop(
    [{ role: "user", content: [{ type: "text", text: "invoke the synthetic tool" }], timestamp: 1 }],
    { systemPrompt: "", messages: [], tools: [nativeTool] },
    {
      model: faux.getModel(),
      convertToLlm,
      toolExecution: "sequential",
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        const final = await invoke("tool_result", {
          type: "tool_result",
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          input: args,
          content: result.content,
          details: result.details,
          isError,
          usage: result.usage,
        });
        return {
          content: final.content,
          details: final.details,
          isError: final.isError,
          usage: final.usage,
        };
      },
      shouldStopAfterTurn: ({ toolResults }) => toolResults.length === 0,
    },
    async (event) => {
      events.push(event);
      if (event.type === "tool_execution_start") await invoke("tool_execution_start", event);
      if (event.type === "tool_execution_end") await invoke("tool_execution_end", event);
    },
    undefined,
    faux.stream,
  );
  const result = messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
  if (!result) throw new Error("Synthetic Pi run did not emit the expected toolResult message");
  return { result, events, messages };
}
