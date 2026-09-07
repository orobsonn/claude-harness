/**
 * @description plan-write-gate da lane Pi — anti-forja (oráculos de caminho `.pi/harness/`)
 * + rail de escopo de escrita.
 *
 * Divisão deliberada em duas metades, espelhando core/opencode/plugin/lib/plan-write-decide.mjs:
 *
 *  1. ANTI-FORJA (própria daqui, fail-closed): os oráculos do OC hardcodam
 *     `.opencode/plans/.state` e `.opencode/plans/<feat>/execution-plan.json`; a lane Pi guarda
 *     `.pi/harness/state/` e `.pi/harness/plans/<feat>/execution-plan.json`. As MENSAGENS são
 *     idênticas às do OC — muda só o prefixo do diretório de estado na frase do rail de state.
 *
 *  2. RAIL DE ESCOPO (reusado por import, sem cópia): scopeContains/normalizeScopePath/
 *     frozen-oracle/armed-hand vivem em `decide()` do OC e são agnósticos de prefixo. Um caminho
 *     Pi não casa nenhum oráculo `.opencode`, então chamar o `decide()` do OC com ele exercita
 *     APENAS o rail de escopo (mais os rails de basename/marker/frozen do OC, que também são
 *     agnósticos de prefixo e valem igual aqui).
 *
 * Autoria de plano canônico: no OC a autoridade é a identidade oficial de planner via SDK. No Pi
 * a prova equivalente é uma sessão FILHA cujo dispatch-record ativo tem papel `harness-planner`
 * (resolvido pelo adaptador com readPiDispatchRecord/bindPiChildSession). Sem essa prova, TODA
 * escrita em plano canônico é negada.
 *
 * Puro: nunca toca disco, nunca lança, nunca depende do runtime do Pi.
 */

import path from "node:path";

import { decide as ocDecide } from "../vendor/opencode/plugin/lib/plan-write-decide.mjs";
import { isPlannerRole, toOcRole } from "./pi-adapter-map.mjs";

const PREFIX = "[plan-write-gate]";

/** Basenames que só os marcadores do harness escrevem — idêntico ao OC (agnóstico de prefixo). */
const FORBIDDEN_STATE_BASENAMES = new Set(["gate-state.json", "triage.json"]);

/** Scripts marcadores (mark/classify) — nunca sobrescritos por Write/Edit. Idêntico ao OC. */
const FORBIDDEN_MARKER_BASENAMES = new Set(["mark.mjs", "classify.mjs"]);

/**
 * Tooling congelado da lane Pi (relativo exato). O conjunto do OC é uma const privada lá; aqui
 * ficam só as entradas Pi — as entradas OC continuam cobertas pelo `decide()` importado.
 */
const FROZEN_TOOLING_RELATIVE = new Set([
  ".pi/harness/extensions/harness-marker.ts",
  ".pi/harness/lib/marker-authority.mjs",
  "core/pi/extensions/harness-marker.ts",
]);

/**
 * @description Quebra um caminho em segmentos posix minúsculos (normalizado, sem vazios).
 * Cópia do helper privado do OC — a barreira de leitura de caminho não é exportada lá.
 * @param {unknown} filePath
 * @returns {string[]}
 */
function pathSegments(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return [];
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  return norm
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
}

/**
 * @description Carve-out de fixture — igual ao OC: nunca casa `.test.` no meio do caminho
 * (sessionIds podem ter ponto) e NUNCA carva os basenames reais do oráculo.
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isCarvedOut(filePath) {
  if (typeof filePath !== "string") return false;
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (norm.includes("..")) return false;
  const segs = norm
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
  if (segs.length === 0) return false;
  const base = segs[segs.length - 1];
  if (FORBIDDEN_STATE_BASENAMES.has(base)) return false;
  if (segs.includes("__fixtures__")) return true;
  if (base.includes(".test.")) return true;
  return false;
}

/**
 * @description Basename que só os marcadores escrevem (gate-state.json / triage.json).
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isForbiddenStateBasename(filePath) {
  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  return FORBIDDEN_STATE_BASENAMES.has(segs[segs.length - 1]);
}

/**
 * @description Oráculo de estado da lane Pi: JSON sob `.pi/harness/state/` — relativo ou absoluto.
 * Varre TODAS as posições (um `.pi` anterior pode ser decoy, ex.: /tmp/.pi/work/proj/.pi/harness/state/…).
 * @param {unknown} filePath
 * @returns {boolean}
 */
export function isPiStateFilePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  if (!segs[segs.length - 1].endsWith(".json")) return false;
  for (let i = 0; i <= segs.length - 3; i++) {
    if (segs[i] === ".pi" && segs[i + 1] === "harness" && segs[i + 2] === "state") return true;
  }
  return false;
}

/**
 * @description Plano canônico da lane Pi: `.pi/harness/plans/<feature>/execution-plan.json`.
 * Nunca sob `state` (defensivo, espelhando o carve `.state` do OC). É um fato de caminho —
 * não é parser de shell nem prova de isolamento de processo.
 * @param {unknown} filePath
 * @returns {boolean}
 */
export function isPiCanonicalPlanPath(filePath) {
  const segs = pathSegments(filePath);
  if (segs.length < 5 || segs.at(-1) !== "execution-plan.json") return false;
  for (let i = 0; i <= segs.length - 5; i++) {
    if (segs[i] === ".pi" && segs[i + 1] === "harness" && segs[i + 2] === "plans") {
      if (segs[i + 3] === "state") continue;
      return true;
    }
  }
  return false;
}

/**
 * @description Fricção literal (best-effort) contra mutação do plano canônico Pi via Bash.
 * Leituras seguem livres; variáveis, substituições e caminhos partidos estão fora deste rail
 * lexical. Espelho exato do isLiteralCanonicalPlanMutation do OC, só com o prefixo trocado.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isPiLiteralCanonicalPlanMutation(command) {
  if (typeof command !== "string") return false;
  // Lexical de propósito, não parser de shell: quebrar nos operadores impede que um `tee`
  // inofensivo num segmento mude o sentido de outro segmento.
  return command.split(/(?:;|\r?\n|&&|\|\||\|)/).some((segment) => {
    const paths =
      segment.match(
        /(?:\/?[^\s'"`]*\/)?\.pi\/harness\/plans\/(?!state(?:\/|$))[^\s'"`]+\/execution-plan\.json/gi,
      ) ?? [];
    return paths.some((literal) => {
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const targetEnd = `(?:[\\s'\"\`]*$)`;
      const tee = segment.search(/\btee\b/i);
      const literalAt = segment.indexOf(literal);
      const teeTargetsLiteral =
        tee >= 0 && tee < literalAt && segment.slice(tee, literalAt).indexOf("<") === -1;
      return (
        new RegExp(`(?:>|>>)\\s*["']?${escaped}(?=$|[\\s'\"])`, "i").test(segment) ||
        teeTargetsLiteral ||
        new RegExp(`\\b(?:cp|rsync)\\b[^\\n]*\\s["']?${escaped}${targetEnd}`, "i").test(segment) ||
        new RegExp(`\\bmv\\b[^\\n]*["']?${escaped}(?=$|[\\s'\"])`, "i").test(segment) ||
        new RegExp(`\\b(?:rm|truncate)\\b[^\\n]*\\s["']?${escaped}(?=$|[\\s'\"])`, "i").test(segment) ||
        new RegExp(`\\bsed\\s+-i\\b[^\\n]*\\s["']?${escaped}${targetEnd}`, "i").test(segment)
      );
    });
  });
}

/**
 * @description Bloqueio determinístico (best-effort) de mutação literal do estado do harness Pi
 * (`.pi/harness/state/`) via Bash. Comandos de leitura/cópia-fonte seguem disponíveis; caminhos
 * ofuscados continuam fora deste rail lexical — isso exige isolamento de processo, não mais
 * cerimônia de estado. Espelho exato do isLiteralStateMutation do OC, só com o prefixo trocado.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isPiLiteralStateMutation(command) {
  if (typeof command !== "string") return false;
  let normalized = command.replace(/\\/g, "/");
  const cdHarness = /\bcd\s+["']?(?:\.\/)?\.pi\/harness["']?\s*(?:&&|;|\r?\n)/i.test(normalized);
  if (cdHarness) {
    normalized = normalized.replace(/(^|[\s'"`(])state\//g, "$1.pi/harness/state/");
  }
  const cdState = normalized.match(
    /\bcd\s+["']?(?:\.\/)?\.pi\/harness\/state(?:\/[^\s;&|"']*)?["']?\s*(?:&&|;|\r?\n)([\s\S]*)/i,
  );
  if (
    cdState &&
    /(?:\b(?:node|python(?:3(?:\.\d+)?)?|tee|rm|truncate|mv)\b|\bsed\s+-i\b|(?:>|>>))/i.test(cdState[1])
  ) {
    return true;
  }
  const mentionsState = /\.pi\/harness\/state\//i.test(normalized);
  if (mentionsState && /\b(?:node|python(?:3(?:\.\d+)?)?)\b/i.test(normalized)) return true;
  return normalized.split(/(?:;|\r?\n|&&|\|\||\|)/).some((segment) => {
    const statePaths = segment.match(/(?:\/?[^\s'"`]*\/)?\.pi\/harness\/state\/[^\s'"`]+/gi) ?? [];
    return statePaths.some((literal) => {
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const literalAt = segment.indexOf(literal);
      const teeAt = segment.search(/\btee\b/i);
      const teeTargetsLiteral =
        teeAt >= 0 && teeAt < literalAt && segment.slice(teeAt, literalAt).indexOf("<") === -1;
      return (
        new RegExp(`(?:>|>>)\\s*["']?${escaped}(?=$|[\\s'"])`, "i").test(segment) ||
        teeTargetsLiteral ||
        new RegExp(`\\b(?:cp|rsync)\\b[^\\n]*\\s["']?${escaped}(?:[\\s'"\`]*$)`, "i").test(segment) ||
        new RegExp(`\\bmv\\b[^\\n]*["']?${escaped}(?=$|[\\s'"])`, "i").test(segment) ||
        new RegExp(`\\b(?:rm|truncate)\\b[^\\n]*\\s["']?${escaped}(?=$|[\\s'"])`, "i").test(segment) ||
        new RegExp(`\\bsed\\s+-i\\b[^\\n]*\\s["']?${escaped}(?:[\\s'"\`]*$)`, "i").test(segment)
      );
    });
  });
}

/**
 * @description Write/Edit contra os scripts marcadores do harness (alvos da allowlist de forja).
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isMarkerScriptPath(filePath) {
  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  if (!FORBIDDEN_MARKER_BASENAMES.has(segs[segs.length - 1])) return false;
  return segs.includes("hooks");
}

/**
 * @description Caminho de tooling congelado da lane Pi (relativo exato ou sufixo absoluto).
 * @param {unknown} filePath
 * @returns {boolean}
 */
export function isPiFrozenToolingPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  let norm = filePath.replace(/\\/g, "/").trim();
  while (norm.startsWith("./")) norm = norm.slice(2);
  for (const rel of FROZEN_TOOLING_RELATIVE) {
    if (norm === rel || norm.endsWith(`/${rel}`)) return true;
  }
  return false;
}

/**
 * @typedef {{ allow: boolean, reason?: string }} Decision
 */

/**
 * @description Normaliza o alvo aceito pelas decisões: string (caminho), {filePath} ou {command}.
 * Nunca lança; valor inesperado vira { filePath: "", command: "" }.
 * @param {unknown} target
 * @returns {{ filePath: string, command: string }}
 */
function normalizeTarget(target) {
  if (typeof target === "string") return { filePath: target, command: "" };
  if (target == null || typeof target !== "object" || Array.isArray(target)) {
    return { filePath: "", command: "" };
  }
  const data = /** @type {Record<string, unknown>} */ (target);
  return {
    filePath: typeof data.filePath === "string" ? data.filePath : "",
    command: typeof data.command === "string" ? data.command : "",
  };
}

/**
 * @description Metade anti-forja da lane Pi (fail-closed). Recebe `{filePath}` OU `{command}`
 * (string solta é tratada como caminho) e devolve Decision. Mensagens idênticas às da lane OC —
 * só o prefixo de diretório de estado muda (`.pi/harness/state/`).
 *
 * Para comando: roda apenas a fricção literal (estado e plano canônico) e retorna. Não resolve
 * identidade de mão de propósito — isso rejeitaria comandos de verificação somente-leitura.
 * Para caminho: caminho ausente é NEGADO (não se pode validar o oráculo).
 * @param {unknown} target
 * @param {{ actingRole?: unknown }} [opts]
 * @returns {Decision}
 */
export function piAntiForgeDecision(target, opts = {}) {
  const { filePath, command } = normalizeTarget(target);

  if (command) {
    if (isPiLiteralStateMutation(command)) {
      return {
        allow: false,
        reason: `${PREFIX} Blocked: literal Bash mutation of harness state is denied (anti-forge rail).`,
      };
    }
    if (isPiLiteralCanonicalPlanMutation(command)) {
      return {
        allow: false,
        reason: `${PREFIX} Blocked: literal Bash mutation of canonical plan is denied (best-effort friction).`,
      };
    }
    return { allow: true };
  }

  if (!filePath) {
    return {
      allow: false,
      reason: `${PREFIX} Blocked: write/edit path missing — cannot validate anti-forge oracle.`,
    };
  }

  const carved = isCarvedOut(filePath);
  if (!carved && isForbiddenStateBasename(filePath)) {
    return {
      allow: false,
      reason: `${PREFIX} Blocked: gate-state/triage written ONLY by harness markers, never Write/Edit.`,
    };
  }
  if (isPiCanonicalPlanPath(filePath)) {
    if (isPlannerRole(toOcRole(opts.actingRole))) return { allow: true };
    return {
      allow: false,
      reason: `${PREFIX} Blocked: canonical plan authorship is planner-only.`,
    };
  }
  if (!carved && isPiStateFilePath(filePath)) {
    return {
      allow: false,
      reason: `${PREFIX} Blocked: .pi/harness/state/ JSONs written ONLY by harness markers.`,
    };
  }
  if (!carved && isMarkerScriptPath(filePath)) {
    return {
      allow: false,
      reason: `${PREFIX} Blocked: harness marker scripts (mark/classify) are read-only via Write/Edit.`,
    };
  }
  if (!carved && isPiFrozenToolingPath(filePath)) {
    return {
      allow: false,
      reason: `${PREFIX} Blocked: allowlisted tooling scripts are read-only via Write/Edit (anti-forgery).`,
    };
  }
  return { allow: true };
}

/**
 * @description Cópia rasa do dispatch-record com o papel traduzido para o vocabulário do OC
 * ('harness-executor' → 'executor'), porque o rail de escopo importado usa isExecutorRole/
 * isSniperRole/isTestAuthorRole direto sobre `record.role`. Valor não-objeto passa intacto.
 * @param {unknown} record
 * @returns {unknown}
 */
function toOcDispatchRecord(record) {
  if (record == null || typeof record !== "object" || Array.isArray(record)) return record;
  const data = /** @type {Record<string, unknown>} */ (record);
  if (typeof data.role !== "string") return record;
  return { ...data, role: toOcRole(data.role) };
}

/**
 * @description Resolve a autoridade de autoria de plano canônico na lane Pi. O equivalente da
 * identidade oficial de planner do OC (SDK) aqui é: sessão FILHA cujo dispatch-record ativo tem
 * papel resolvido `planner` (`harness-planner`). Puro — quem lê o record de disco é o adaptador.
 * Na ausência de prova devolve SEMPRE ok:false com um motivo, nunca fail-open.
 * @param {{ isSubagent?: unknown, dispatchRecord?: unknown }} [opts]
 * @returns {{ ok: true, role: "planner" } | { ok: false, reason: string }}
 */
export function resolvePiPlannerIdentity(opts = {}) {
  if (opts.isSubagent !== true) {
    return { ok: false, reason: "canonical plan write is not from a planner child session" };
  }
  const record = opts.dispatchRecord;
  if (record == null || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: "no active dispatch record binds this child session" };
  }
  const role = /** @type {Record<string, unknown>} */ (record).role;
  if (!isPlannerRole(toOcRole(role))) {
    return { ok: false, reason: "active dispatch role is not planner" };
  }
  return { ok: true, role: "planner" };
}

/**
 * @description Decisão completa da lane Pi para uma escrita/comando: anti-forja Pi (fail-closed)
 * → autoridade de planner no plano canônico (fail-closed) → rail de escopo do OC (fail-open),
 * reusado por import. Nunca lança.
 *
 * Identidade de planner PROVADA autoriza SOMENTE o plano canônico (mesma regra do gate do OC:
 * "planner may author only canonical execution plans.").
 *
 * O `decide()` do OC recebe o caminho Pi, que não casa nenhum oráculo `.opencode`; ele contribui
 * portanto (a) os rails agnósticos de prefixo (basename gate-state/triage, marker scripts, tooling
 * congelado do OC) e (b) o rail de escopo call-keyed (scope_paths ∪ allowed_writes, frozen_paths,
 * e a negação de subagente sem identidade de mão verificável sob dispatch armado).
 * @param {unknown} target `{filePath}` ou `{command}` (string solta = caminho)
 * @param {{
 *   actingRole?: unknown,
 *   isSubagent?: unknown,
 *   dispatchRecord?: unknown,
 *   gateState?: unknown,
 *   plannerIdentity?: unknown,
 * }} [opts]
 * @returns {Decision}
 */
export function decidePiPlanWrite(target, opts = {}) {
  const { filePath, command } = normalizeTarget(target);

  if (command) {
    const piFriction = piAntiForgeDecision({ command });
    if (piFriction.allow === false) return piFriction;
    // Backstop: a fricção literal do OC (`.opencode/plans/…`) segue valendo numa sessão Pi —
    // nenhuma mão do harness deve mutar o estado da outra lane.
    return ocDecide({ args: { command } });
  }

  const identity =
    opts.plannerIdentity !== undefined
      ? opts.plannerIdentity
      : resolvePiPlannerIdentity({ isSubagent: opts.isSubagent, dispatchRecord: opts.dispatchRecord });
  const identityRec =
    identity != null && typeof identity === "object" && !Array.isArray(identity)
      ? /** @type {Record<string, unknown>} */ (identity)
      : null;
  const plannerProven =
    identityRec != null && identityRec.ok === true && isPlannerRole(toOcRole(identityRec.role));

  // --- Plano canônico: autoridade de planner, fail-closed ---
  if (isPiCanonicalPlanPath(filePath)) {
    if (!plannerProven) {
      const reason = typeof identityRec?.reason === "string" ? identityRec.reason : "missing";
      return {
        allow: false,
        reason: `${PREFIX} Blocked: official planner identity required (${reason}).`,
      };
    }
    return piAntiForgeDecision({ filePath }, { actingRole: "planner" });
  }

  // Paridade com o gate do OC (plan-write-gate.ts): uma identidade de planner PROVADA autoriza
  // apenas o plano canônico — qualquer outro alvo dessa identidade é negado.
  if (plannerProven) {
    return {
      allow: false,
      reason: `${PREFIX} Blocked: planner may author only canonical execution plans.`,
    };
  }

  const antiForge = piAntiForgeDecision({ filePath }, { actingRole: opts.actingRole });
  if (antiForge.allow === false) return antiForge;

  // --- Rail de escopo (importado do OC): fail-open em contexto incompleto ou erro ---
  // O vocabulário de papéis do Pi ('harness-executor') precisa virar o do OC ANTES de entrar no
  // rail: isExecutorRole/isSniperRole do OC não removem o prefixo 'harness-' sozinhos.
  return ocDecide(
    { args: { filePath }, tool_input: { file_path: filePath } },
    {
      gateState: opts.gateState,
      actingRole: toOcRole(opts.actingRole) || undefined,
      isSubagent: opts.isSubagent,
      dispatchRecord: toOcDispatchRecord(opts.dispatchRecord),
    },
  );
}

export default {
  decidePiPlanWrite,
  isPiCanonicalPlanPath,
  isPiFrozenToolingPath,
  isPiLiteralCanonicalPlanMutation,
  isPiLiteralStateMutation,
  isPiStateFilePath,
  piAntiForgeDecision,
  resolvePiPlannerIdentity,
};
