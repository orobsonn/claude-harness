/**
 * @description Tradutor único entre o vocabulário de tools/papéis do Pi e o que a
 * lógica OC (core/opencode/lib/roles.mjs) espera. Pura, nunca lança. Nenhuma função
 * aqui toca disco ou rede — apenas normaliza nomes de tool, args de dispatch e papéis
 * vindos do runtime do Pi (ctx.sessionManager) para o vocabulário canônico da lane OC.
 */

import {
  bareRole,
  isDeliveryRole as ocIsDeliveryRole,
  isExecutorRole as ocIsExecutorRole,
  isSniperRole as ocIsSniperRole,
  isTestAuthorRole as ocIsTestAuthorRole,
  isPlannerRole as ocIsPlannerRole,
  isAdversaryRole as ocIsAdversaryRole,
  isPlanReviewerRole as ocIsPlanReviewerRole,
} from "../../opencode/lib/roles.mjs";

// Tools built-in do Pi (dist/core/tools/index.d.ts): read|bash|powershell|edit|write|grep|find|ls
const BASH_TOOL_NAMES = new Set(["bash", "powershell"]);
const WRITE_TOOL_NAMES = new Set(["write", "edit"]);
const READ_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
// Dispatch de subagente (pi-subagents): subagent | get_subagent_result | steer_subagent.
// Apenas `subagent` DISPARA um novo subagente; os outros dois consultam/orientam um
// subagente já em execução e não carregam schema de dispatch.
const DISPATCH_TOOL_NAMES = new Set(["subagent"]);

/** UI capability and existing automation signals define workflow mode, not identity.
 * A remote interactive TUI is local for this purpose; SSH/VPS alone is not headless.
 * RPC exposes UI methods to its client, but remains an automated entrypoint.
 * @param {{hasUI?: boolean, mode?: string} | undefined} ctx
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isPiHeadlessContext(ctx, env = process.env) {
  return ctx?.mode === "rpc" || ctx?.hasUI !== true || [
    "CLAUDE_CODE_REMOTE", "HARNESS_NOTIFY_PROJECT", "HARNESS_OBSERVABILITY_RUN_PATH",
  ].some((key) => typeof env[key] === "string" && env[key].length > 0);
}

/**
 * @description Normaliza o nome de tool para minúsculas; qualquer valor não-string vira "".
 * @param {unknown} name
 * @returns {string}
 */
function normalizeToolName(name) {
  return typeof name === "string" ? name.toLowerCase() : "";
}

/**
 * @description Tool de execução de comando shell do Pi (bash|powershell).
 * @param {unknown} name
 * @returns {boolean}
 */
export function isPiBashTool(name) {
  return BASH_TOOL_NAMES.has(normalizeToolName(name));
}

/**
 * @description Tool que escreve/edita arquivo do Pi (write|edit).
 * @param {unknown} name
 * @returns {boolean}
 */
export function isPiWriteTool(name) {
  return WRITE_TOOL_NAMES.has(normalizeToolName(name));
}

/**
 * @description Tool somente-leitura do Pi (read|grep|find|ls).
 * @param {unknown} name
 * @returns {boolean}
 */
export function isPiReadTool(name) {
  return READ_TOOL_NAMES.has(normalizeToolName(name));
}

/**
 * @description Tool que dispara subagente (dispatch) no Pi (subagent).
 * get_subagent_result/steer_subagent NÃO contam — não criam sessão filha nova.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isPiDispatchTool(name) {
  return DISPATCH_TOOL_NAMES.has(normalizeToolName(name));
}

/**
 * @description Extrai o comando shell de um input de tool bash do Pi ({command,timeout?}).
 * Nunca lança; input malformado vira "".
 * @param {unknown} input
 * @returns {string}
 */
export function piCommandOf(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return "";
  const command = /** @type {Record<string, unknown>} */ (input).command;
  return typeof command === "string" ? command : "";
}

/**
 * @description Extrai os caminhos de arquivo tocados por uma tool do Pi, dado seu nome
 * e input. write/edit/read usam `input.path`; bash/powershell não tocam arquivo por si
 * só (retorna []); grep/find/ls não têm um único path-alvo estruturado (retorna []).
 * @param {unknown} toolName
 * @param {unknown} input
 * @returns {string[]}
 */
export function piPathsOf(toolName, input) {
  const n = normalizeToolName(toolName);
  if (input == null || typeof input !== "object" || Array.isArray(input)) return [];
  const data = /** @type {Record<string, unknown>} */ (input);
  if (n === "write" || n === "edit" || n === "read") {
    return typeof data.path === "string" && data.path.length > 0 ? [data.path] : [];
  }
  return [];
}

/**
 * @description Extrai os campos do schema de dispatch de subagente do Pi
 * ({prompt,description,subagent_type,model?,thinking?,max_turns?,run_in_background?,
 * resume?,inherit_context?}). Campos obrigatórios sempre presentes (default ""); campos
 * opcionais só aparecem no retorno quando presentes e do tipo esperado no input.
 * Nunca lança.
 * @param {unknown} input
 * @returns {{prompt: string, description: string, subagent_type: string, model?: string,
 *   thinking?: unknown, max_turns?: number, run_in_background?: boolean, resume?: unknown,
 *   inherit_context?: unknown}}
 */
export function piSubagentArgs(input) {
  const data =
    input != null && typeof input === "object" && !Array.isArray(input)
      ? /** @type {Record<string, unknown>} */ (input)
      : {};
  const out = {
    prompt: typeof data.prompt === "string" ? data.prompt : "",
    description: typeof data.description === "string" ? data.description : "",
    subagent_type: typeof data.subagent_type === "string" ? data.subagent_type : "",
  };
  if (typeof data.model === "string") out.model = data.model;
  if (data.thinking !== undefined) out.thinking = data.thinking;
  if (typeof data.max_turns === "number") out.max_turns = data.max_turns;
  if (typeof data.run_in_background === "boolean") out.run_in_background = data.run_in_background;
  if (data.resume !== undefined) out.resume = data.resume;
  if (data.inherit_context !== undefined) out.inherit_context = data.inherit_context;
  return out;
}

/**
 * @description Traduz o nome de papel/asset do Pi ('harness-executor', 'harness-planner'...)
 * para o vocabulário bare da lane OC ('executor', 'planner'...). bareRole() do OC NÃO
 * remove o prefixo 'harness-' sozinho (isDeliveryRole('harness-executor') seria false sem
 * este passo) — por isso toda chamada a isDeliveryRole/isExecutorRole/isSniperRole/
 * isTestAuthorRole/isPlannerRole/isAdversaryRole/isPlanReviewerRole na lane Pi DEVE passar
 * primeiro por toOcRole. Nunca lança.
 *
 * ORDEM É LOAD-BEARING: normaliza com bareRole() PRIMEIRO, só então remove o prefixo. O
 * bareRole do OC é justamente quem tolera as decorações que um nome de papel pode carregar
 * (espaço em volta, '@' inicial, namespace 'ns/role' ou 'ns:role', sufixo '.md', maiúsculas).
 * Removendo o prefixo antes, um ' harness-executor' ou '@harness-executor' escaparia da
 * remoção e viraria o papel desconhecido 'harness-executor' — isDeliveryRole/isExecutorRole
 * dariam false e o dispatch da mão passaria pelo gate (fail-open de papel). Depois de
 * bareRole a string já está trimada e minúscula, então o prefixo é sempre literal.
 * @param {unknown} name
 * @returns {string}
 */
export function toOcRole(name) {
  const bare = bareRole(name);
  // Pi separates the serial test-fidelity eye from implementation/final compliance.
  // Shared OC ceremony ordering still treats that new eye as the fidelity compliance role.
  if (bare === "harness-test-reviewer") return "compliance";
  return bare.startsWith("harness-") ? bare.slice("harness-".length) : bare;
}

/**
 * @description Identidade de sessão do Pi: UUID gerado pelo runtime, compatível com
 * SAFE_SESSION_ID (core/shared/lib/feature-id.mjs). Nunca lança; ctx malformado vira "".
 * @param {{sessionManager?: {getSessionId?: () => unknown}}} ctx
 * @returns {string}
 */
export function piSessionId(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

/**
 * @description Detecta sessão filha (subagente) do Pi. pi-subagents cria filhos
 * in-process com newSession({parentSession}) e faz bind das mesmas extensões — este é
 * o único sinal confiável de pai vs filho no Pi (equivalente ao session.parentID do OC).
 * Nunca lança; ctx sem header/parentSession vira false.
 * @param {{sessionManager?: {getHeader?: () => {parentSession?: unknown} | null | undefined}}} ctx
 * @returns {boolean}
 */
export function isChildSession(ctx) {
  try {
    return Boolean(ctx?.sessionManager?.getHeader?.()?.parentSession);
  } catch {
    return false;
  }
}

export {
  ocIsDeliveryRole as isDeliveryRole,
  ocIsExecutorRole as isExecutorRole,
  ocIsSniperRole as isSniperRole,
  ocIsTestAuthorRole as isTestAuthorRole,
  ocIsPlannerRole as isPlannerRole,
  ocIsAdversaryRole as isAdversaryRole,
  ocIsPlanReviewerRole as isPlanReviewerRole,
};

export default {
  isPiBashTool,
  isPiWriteTool,
  isPiReadTool,
  isPiDispatchTool,
  piCommandOf,
  piPathsOf,
  piSubagentArgs,
  toOcRole,
  piSessionId,
  isChildSession,
};
