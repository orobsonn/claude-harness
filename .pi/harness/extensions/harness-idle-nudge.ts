import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { decide } from "../vendor/opencode/plugin/lib/agent-idle-nudge.mjs";
import { isChildSession, isPiDispatchTool, toOcRole } from "../lib/pi-adapter-map.mjs";

/**
 * @description Pi harness-idle-nudge — adaptador fino sobre a decisão pura reusada da lane OC
 * (decide() em core/opencode/plugin/lib/agent-idle-nudge.mjs, reusada integralmente por
 * import). Observa `tool_result` (único hook do Pi que pode ANEXAR contexto ao resultado;
 * `tool_execution_end` é apenas notificação) para dispatches de subagente (`subagent`), monta o
 * payload no formato canônico que decide() reconhece (tool_name:'task' — o Pi chama a tool de
 * 'subagent', mas o predicado isTaskFamily do decide só reconhece 'task'/'agent') e, quando
 * decide devolve {action:'inject'}, anexa o texto em details.agent_idle_nudge — nunca altera
 * content/isError, nunca bloqueia. Só roda na sessão PAI (equivalente ao guard hasOwn(agent_id)
 * da lane OC, aqui via isChildSession).
 *
 * O papel do dispatch é traduzido por toOcRole antes de entrar no payload: decide() lê
 * `tool_input.subagent_type` no vocabulário OC (`executor-high`) e o Pi despacha com prefixo
 * (`harness-executor-high`) — sem a tradução o ramo de capacidade (CAPACITY_CONTEXT, que casa
 * `^(?:executor|sniper)-(?:low|medium|high)$`) nunca dispararia nesta lane.
 */

/**
 * @description Extrai o texto plano de um resultado de tool_result do Pi. `event.content` pode
 * ser uma string direta ou um array de blocos `{type:'text', text}` — junta apenas os blocos de
 * texto. Nunca lança; qualquer forma inesperada vira "".
 */
function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block != null && typeof block === "object" && (block as { type?: unknown }).type === "text")
      .map((block) => (typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/** @description Thin Pi hook that injects agent-idle-nudge context onto subagent tool_result. */
export default function harnessIdleNudge(pi: ExtensionAPI) {
  pi.on("tool_result", (event: any, ctx: any) => {
    try {
      if (!isPiDispatchTool(event?.toolName)) return;
      if (isChildSession(ctx)) return;

      // Mesmo guard da lane OC: args ausentes viram {}, mas args presentes e não-objeto
      // (array/string) abortam sem injetar — nunca viram um {} que dispararia o nudge.
      const rawInput = event?.input;
      if (rawInput != null && (typeof rawInput !== "object" || Array.isArray(rawInput))) return;
      const inputObject: Record<string, unknown> = rawInput ?? {};
      const toolInput =
        typeof inputObject.subagent_type === "string"
          ? { ...inputObject, subagent_type: toOcRole(inputObject.subagent_type) }
          : inputObject;

      const text = extractResultText(event?.content);
      const payload: Record<string, unknown> = {
        tool_name: "task",
        tool_input: toolInput,
        tool_response: text,
        tool_output: text,
      };

      const res = decide(payload);
      if (res && res.action === "inject" && typeof res.context === "string") {
        const details =
          event?.details != null && typeof event.details === "object" && !Array.isArray(event.details)
            ? event.details
            : {};
        return { details: { ...details, agent_idle_nudge: res.context } };
      }
    } catch {
      /* fail-open */
    }
  });
}

/** @description Exposto apenas para o teste (evita reimplementar os fakes de tool_result). */
export const testApi = Object.freeze({ extractResultText });
