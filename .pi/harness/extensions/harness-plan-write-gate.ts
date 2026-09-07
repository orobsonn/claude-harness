import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isChildSession,
  isPiBashTool,
  isPiWriteTool,
  piCommandOf,
  piPathsOf,
  piSessionId,
} from "../lib/pi-adapter-map.mjs";
import { readPiChildIdentity } from "../lib/pi-child-identity.mjs";
import { decidePiPlanWrite, resolvePiPlannerIdentity } from "../lib/plan-write-decide.mjs";
import { normalizeProjectPath, readPiBoundDispatchForChild } from "../lib/pi-state-records.mjs";

/**
 * @description Adaptador fino do plan-write-gate na lane Pi. Toda a decisão vive em
 * core/pi/lib/plan-write-decide.mjs (que por sua vez reusa o rail de escopo do OC por import);
 * aqui só se traduz o evento do Pi.
 *
 * Contrato de eventos (Pi 0.84.4, docs/extensions.md): `tool_call` roda depois de
 * tool_execution_start e ANTES da tool executar, e bloqueia devolvendo `{block:true, reason}`.
 * Nunca usamos `terminate` — negar uma escrita não deve encerrar a sessão. Todo import é
 * ESTÁTICO: "tool_call errors block the tool (fail-safe)", então uma falha de resolução de
 * módulo dentro do handler bloquearia TODA escrita e TODO bash da sessão.
 *
 * O Pi não tem `apply_patch` nem `multiedit`: as únicas tools de escrita são `write` e `edit`,
 * ambas com um `input.path` único. Por isso o adaptador extrai `[input.path]` e roda a anti-forja
 * por caminho. `bash`/`powershell` rodam SÓ a fricção literal e retornam — resolver identidade de
 * mão num comando rejeitaria verificação somente-leitura de sessões de olho.
 *
 * Sequência espelhada de core/opencode/plugin/plan-write-gate.ts:
 *  1. anti-forja sobre o caminho CRU (sem record) — fail-closed;
 *  2. só com um dispatch-record ligado, `normalizeProjectPath` canoniza o caminho sob a raiz real
 *     (é o passo que faz um caminho absoluto do Pi casar `scope_paths` relativo) e rejeita
 *     traversal/escape de symlink com a mesma frase do OC;
 *  3. rail de escopo sobre o caminho canônico.
 *
 * Identidade: sessão filha é detectada por `ctx.sessionManager.getHeader()?.parentSession`
 * (pi-subagents cria filhos in-process com newSession({parentSession}) e faz bind das mesmas
 * extensões — este é o único sinal confiável de pai vs filho). QUAL papel a filha está rodando
 * vem do registro durável de `core/pi/lib/pi-child-identity.mjs`, gravado pelo adaptador do
 * entry-gate no evento `subagents:child:session-created` do pi-subagents. É esse registro que
 * torna a autoridade de autoria do plano canônico satisfazível nesta lane — o dispatch-record
 * sozinho nunca serviria, porque só existe para mão que escreve e seu escopo vem do plano que o
 * planner ainda vai criar.
 */

/** Autoridade da sessão filha: papel provado + dispatch-record de escopo, quando houver. */
type ChildAuthority = {
  /** Papel canônico do Pi que ESTA sessão filha roda ('' quando não há prova). */
  role: string;
  /** Dispatch-record ligado (só mão que escreve); null quando ausente. */
  record: unknown;
  /** Motivo da ausência de prova — vira o texto entre parênteses do deny. */
  reason: string;
  /** True quando a prova é ambígua/corrompida: fail-closed, o chamador nega. */
  conflict?: boolean;
};

/**
 * @description Resolve a autoridade desta sessão filha: papel (registro de identidade) e
 * dispatch-record ativo (escopo de escrita). Ausência de qualquer um é fail-open — o rail
 * correspondente fica desarmado, exatamente como na lane OC sem binding. CONFLITO é fail-closed.
 * Nunca lança.
 * @param {string} projectRoot
 * @param {string} childSessionId
 */
function readChildAuthority(projectRoot: string, childSessionId: string): ChildAuthority {
  if (!projectRoot || !childSessionId) {
    return { role: "", record: null, reason: "session identity unavailable" };
  }
  let role = "";
  let reason = "no active dispatch record for this session";
  try {
    const identity: any = readPiChildIdentity(projectRoot, childSessionId);
    if (identity?.ok === true && typeof identity.record?.role === "string") {
      role = identity.record.role;
    } else if (identity?.conflict === true) {
      return { role: "", record: null, reason: String(identity.reason), conflict: true };
    } else if (typeof identity?.reason === "string") {
      reason = identity.reason;
    }
  } catch {
    return { role: "", record: null, reason: "pi child identity read failed", conflict: true };
  }
  try {
    const found: any = readPiBoundDispatchForChild(projectRoot, childSessionId);
    if (found?.ok === true && found.record) return { role: role || String(found.record.role ?? ""), record: found.record, reason: "" };
    if (found?.conflict === true) {
      return { role, record: null, reason: String(found.reason), conflict: true };
    }
    return { role, record: null, reason: String(found?.reason ?? reason) };
  } catch {
    return { role, record: null, reason: "pi dispatch record read failed", conflict: true };
  }
}

/** @description Hook fino do Pi que aplica anti-forja e rail de escopo em write/edit/bash. */
export default function harnessPlanWriteGate(pi: ExtensionAPI) {
  pi.on("tool_call", (event: any, ctx: any) => {
    if (isPiBashTool(event?.toolName)) {
      const decision = decidePiPlanWrite({ command: piCommandOf(event?.input) });
      if (decision.allow === false) return { block: true, reason: decision.reason };
      return;
    }

    if (!isPiWriteTool(event?.toolName)) return;

    const filePath = piPathsOf(event?.toolName, event?.input)[0] ?? "";
    if (!filePath) {
      return {
        block: true,
        reason: "[plan-write-gate] Blocked: official write/patch tool exposed no parseable target paths.",
      };
    }

    const isSubagent = isChildSession(ctx);
    const projectRoot = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    const authority: ChildAuthority = isSubagent
      ? readChildAuthority(projectRoot, piSessionId(ctx))
      : { role: "", record: null, reason: "write is not from a child session" };
    if (authority.conflict === true) {
      return {
        block: true,
        reason: `[plan-write-gate] Blocked: trusted writing-hand identity conflicts (${authority.reason}).`,
      };
    }

    const record = authority.record;
    const plannerIdentity = authority.role
      ? resolvePiPlannerIdentity({ isSubagent, dispatchRecord: { role: authority.role } })
      : { ok: false, reason: authority.reason };
    const actingRole = authority.role;

    // Shipper é olho de entrega: pode preparar evidência e staging por Bash, mas nunca corrigir
    // produto. A negativa explícita cobre runtimes antigos que ainda exponham edit/write.
    if (actingRole === "harness-shipper") {
      return { block: true, reason: "[plan-write-gate] Blocked: shipper must not write product files." };
    }

    // 1. Anti-forja + autoridade de plano canônico sobre o caminho cru (sem rail de escopo).
    const antiForge = decidePiPlanWrite({ filePath }, { actingRole, isSubagent, plannerIdentity });
    if (antiForge.allow === false) return { block: true, reason: antiForge.reason };
    if (!record) return;

    // 2. Canonização sob a raiz real — só quando há record, como no gate do OC.
    const normalized: any = normalizeProjectPath(projectRoot, filePath);
    if (normalized?.ok !== true) {
      return {
        block: true,
        reason: `[plan-write-gate] Blocked: '${filePath}' is not a safe project path (${String(normalized?.reason ?? "scope path missing or invalid")}).`,
      };
    }

    // 3. Rail de escopo sobre o caminho canônico.
    const decision = decidePiPlanWrite(
      { filePath: String(normalized.path) },
      { actingRole, isSubagent, dispatchRecord: record, plannerIdentity },
    );
    if (decision.allow === false) return { block: true, reason: decision.reason };
  });
}

/** @description Exposto apenas para teste do adaptador (evita reimplementar o leitor de record). */
export const testApi = Object.freeze({ readChildAuthority });
