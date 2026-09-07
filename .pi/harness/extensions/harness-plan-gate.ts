import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { decidePiPlanGate } from "../lib/plan-gate.mjs";
import { piSessionId } from "../lib/pi-adapter-map.mjs";

/**
 * @description Adaptador fino do plan-gate da lane Pi: traduz o evento `tool_call` do Pi para a
 * decisão pura de core/pi/lib/plan-gate.mjs e devolve `{block,reason}` quando o dispatch downstream
 * (plan-reviewer/test-author/executor/sniper) não tem um plano estável válido por trás. Toda a
 * lógica — leitura de gate-state, validação do plano, mensagens `[plan-gate] denied: …` — vive no
 * .mjs; aqui só se extrai `projectRoot` (ctx.cwd, com o mesmo fallback para process.cwd() do
 * plugin OC e dos adaptadores irmãos) e a identidade de sessão confiável do runtime
 * (ctx.sessionManager.getSessionId()). Nunca muta `event.input`: o brief é o transporte do modelo.
 */
export default function harnessPlanGate(pi: ExtensionAPI) {
  pi.on("tool_call", (event: any, ctx: any) => {
    const decision = decidePiPlanGate({
      projectRoot: typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd(),
      sessionId: piSessionId(ctx),
      toolName: event?.toolName,
      input: event?.input,
    });
    if (decision.warn) console.warn(decision.warn);
    if (decision.block) return { block: true, reason: decision.reason };
  });
}
