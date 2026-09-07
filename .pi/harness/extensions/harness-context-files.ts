import { existsSync, lstatSync, readFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { collectProjectContext } from "../lib/context-files.mjs";
import { isChildSession } from "../lib/pi-adapter-map.mjs";

/**
 * @description Adaptador fino Pi para a peça context-files (AGENTS.md/CLAUDE.md do projeto sob
 * controle). Toda a lógica de descoberta fechada vive em `collectProjectContext`
 * (core/pi/lib/context-files.mjs, pura); este arquivo só traduz `before_agent_start` do Pi,
 * injeta os wrappers de `node:fs` e encadeia o resultado sobre `event.systemPrompt` — nunca o
 * substitui, nunca toca `event.systemPromptOptions`, nunca injeta `message` (contexto de projeto é
 * prompt de sistema, não turno de conversa). Só a sessão PAI injeta: subagentes filhos do
 * pi-subagents recebem seu próprio briefing pela role e são detectados por `isChildSession`, o
 * mesmo header usado pelas outras peças da lane Pi. Fail-open total: qualquer erro deixa o
 * systemPrompt intacto.
 *
 * O disco é lido UMA vez por sessão (cache abaixo, invalidado em `session_start`), mas a injeção
 * acontece em TODO `before_agent_start`: o Pi reconstrói o prompt a cada turno a partir do
 * `_baseSystemPrompt` e, quando nenhuma extensão devolve `systemPrompt`, volta explicitamente à
 * base (dist/core/agent-session.js). Injetar só no primeiro turno faria o contexto do projeto
 * sumir do segundo turno em diante — o oposto do que o Pi nativo faz com os context files.
 */
export default function harnessContextFiles(pi: ExtensionAPI) {
  /** `undefined` = ainda não lido nesta sessão; `null` = lido e sem contexto a injetar. */
  let cached: { text: string; files: string[] } | null | undefined;

  // Sessão nova (/new ou /resume) relê os arquivos de contexto do projeto.
  pi.on("session_start", () => {
    cached = undefined;
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      if (isChildSession(ctx)) return;

      if (cached === undefined) {
        const result = collectProjectContext(ctx.cwd, {
          readFile: (path: string) => readFileSync(path, "utf8"),
          exists: (path: string) => existsSync(path),
          lstat: (path: string) => lstatSync(path),
        });
        cached = result.ok ? { text: result.text, files: result.files } : null;
      }
      if (!cached) return;

      const filesAttr = cached.files.join(",");
      return {
        systemPrompt: `${event.systemPrompt}\n\n<project-context files="${filesAttr}">\n${cached.text}\n</project-context>`,
      };
    } catch {
      // fail-open total — um erro na peça context-files nunca pode alterar o systemPrompt
      return;
    }
  });
}
