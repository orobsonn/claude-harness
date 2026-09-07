import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildPiSessionRecovery } from "../lib/session-state.mjs";
import { resolveProjectRoot } from "../lib/version-check.mjs";

/**
 * @description Adaptador fino Pi da peça reinject-state — reinsere no contexto, depois da
 * compactação, os fatos validados DESTA sessão (mode, feature_id, caminho canônico do plano,
 * plano disponível, total de tarefas). Toda a decisão vive em `core/pi/lib/session-state.mjs`.
 *
 * Diferença de host em relação à lane OC: em `experimental.session.compacting` o OpenCode deixa
 * o plugin ANEXAR contexto (`output.context.push`). O `session_before_compact` do Pi só permite
 * cancelar ou SUBSTITUIR o resumo inteiro — devolver `compaction` aqui deixaria de fora o resumo
 * do próprio modelo. Por isso o hook `session_before_compact` apenas marca um pendente (e nunca
 * cancela); a reinjeção acontece em `session_compact` via `pi.sendMessage(..., 'nextTurn')`, com
 * fallback (uma única vez) para a injeção de mensagem em `before_agent_start` caso o envio falhe.
 *
 * O pendente é descartado em `session_compact_failed`: na OC o contexto só entra junto com um
 * resumo de compactação BEM-SUCEDIDA — compactação cancelada ou falha não reinjeta nada.
 *
 * Só a sessão pai reinjeta: subagentes criados por pi-subagents (`newSession({ parentSession })`)
 * fazem bind das mesmas extensões e têm a própria janela de contexto. Numa sessão filha os quatro
 * hooks são NO-OP — em particular nunca consomem nem limpam o pendente do pai (o closure pode ser
 * compartilhado pelo bind). Fail-open em toda falha — a recuperação de contexto nunca pode
 * derrubar ou bloquear uma compactação.
 */
export default function harnessReinjectState(pi: ExtensionAPI) {
  /** Payload já codificado, aguardando reinjeção pós-compactação. */
  let pendingContext: string | null = null;

  /**
   * @description Verdadeiro numa sessão filha (subagente) — que nunca reinjeta. Na dúvida
   * (sessionManager ausente/quebrado) trata como filha: não tocar no pendente é o lado seguro.
   */
  const isChildSession = (ctx: ExtensionContext): boolean => {
    try {
      return Boolean(ctx.sessionManager.getHeader()?.parentSession);
    } catch {
      return true;
    }
  };

  pi.on("session_before_compact", async (_event, ctx) => {
    // Nunca devolve `cancel` nem `compaction`: substituir o resumo perderia o do modelo.
    try {
      if (isChildSession(ctx)) return;
      const recovered = buildPiSessionRecovery(resolveProjectRoot(ctx.cwd), ctx.sessionManager.getSessionId());
      pendingContext = recovered.ok ? recovered.context : null;
    } catch {
      pendingContext = null; // fail-open — nada é reinjetado
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!pendingContext || isChildSession(ctx)) return;
    try {
      // `await` é load-bearing: sendMessage devolve Promise, e sem ele uma rejeição escaparia
      // do catch e viraria unhandled rejection em vez de cair no fallback.
      await pi.sendMessage(
        { customType: "harness-recovery", content: pendingContext, display: true },
        { deliverAs: "nextTurn" },
      );
      pendingContext = null;
    } catch {
      // Envio falhou — o fallback de before_agent_start reinjeta o MESMO texto uma única vez.
    }
  });

  pi.on("session_compact_failed", async (_event, ctx) => {
    // Compactação cancelada ou falha: não houve resumo, então não há o que recuperar.
    if (isChildSession(ctx)) return;
    pendingContext = null;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!pendingContext || isChildSession(ctx)) return;
    const content = pendingContext;
    pendingContext = null; // uma única vez, mesmo se a injeção falhar adiante
    return { message: { customType: "harness-recovery", content, display: true } };
  });
}
