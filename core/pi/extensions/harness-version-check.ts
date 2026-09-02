import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isChildSession } from "../lib/pi-adapter-map.mjs";
import { checkHarnessVersionStale, resolveProjectRoot } from "../lib/version-check.mjs";

/** Dependências injetáveis da lógica pura — usadas só pelos testes; em produção ficam vazias. */
type VersionCheckDeps = {
  readLocalVersion?: (projectRoot: string) => string | null;
  fetchRemoteTag?: () => string | null;
  readCache?: (projectRoot: string) => unknown;
  writeCache?: (projectRoot: string, value: { tag: string; cachedAt: number }) => void;
  nowMs?: () => number;
  warn?: (message: string) => void;
};

/**
 * @description Entrega a advertência por UM canal só — espelhando o `deliverAdvisory` da lane OC
 * (`deps.warn` OU `console.warn`, nunca os dois). No Pi o canal nativo é `ctx.ui.notify`, que só
 * existe quando `ctx.hasUI` (TUI/RPC); em print/json mode cai para `console.warn`. Escrever no
 * stdout com o TUI ativo corromperia o render, por isso os canais são exclusivos — mas se o
 * `notify` falhar, o `console.warn` ainda entrega a advertência (a mensagem nunca some).
 */
function deliverAdvisory(
  message: string,
  ctx: { hasUI?: boolean; ui?: { notify?: (message: string, level: string) => void } },
  deps: Pick<VersionCheckDeps, "warn">,
): void {
  const fallback = () => {
    try {
      if (deps.warn) deps.warn(message);
      else console.warn(message);
    } catch {
      // fail-open
    }
  };
  if (deps.warn) {
    fallback();
    return;
  }
  try {
    if (ctx.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(message, "warning");
      return;
    }
  } catch {
    // fail-open — cai para o canal de console abaixo
  }
  fallback();
}

/**
 * @description Adaptador fino Pi para a advertência de harness stale (peça version-check). Roda
 * uma única vez por sessão, só na sessão pai (nunca em subagentes filhos criados por
 * pi-subagents via `newSession({ parentSession })`, que fazem bind das mesmas extensões).
 * Nunca bloqueia: `session_start` não aceita retorno de bloqueio nesta API e a peça é advisória
 * por construção. Qualquer falha — rede, `gh` ausente, carimbo ausente ou JSON inválido — é
 * fail-open e silenciosa. `deps` existe só para os testes (mesma forma da lane OC).
 */
export default function harnessVersionCheck(pi: ExtensionAPI, deps: VersionCheckDeps = {}) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (isChildSession(ctx)) return;

      const projectRoot = resolveProjectRoot(ctx.cwd);
      const staleMessage = checkHarnessVersionStale(projectRoot, deps);
      if (!staleMessage) return;

      deliverAdvisory(staleMessage, ctx as never, deps);
    } catch {
      // fail-open — um erro na peça version-check nunca bloqueia o bootstrap
    }
  });
}
