/** @description Política de segurança da lane Pi: nega segredos, comandos destrutivos e mutação
 * de config do harness. Reusa por import o motor host-agnóstico de core/codex/hooks/policy.mjs
 * (evaluateHook / protectablePath) — nada é duplicado aqui. O que esta camada acrescenta é:
 *   1. o mapeamento dos nomes de tool do Pi (bash/powershell/write/edit/read/grep/find/ls) para o
 *      payload que evaluateHook espera ({hook_event_name, tool_name, tool_input:{command}});
 *   2. o equivalente aos 8 Read-denies de core/claude-code/settings.json, que policy.mjs não cobre;
 *   3. a extensão de protectablePath para também proteger `.pi` (além de `.codex`/`.agents`).
 * As mensagens de negação são IDÊNTICAS às da lane OC/Codex — sem prefixo novo. */

import { homedir } from 'node:os'
import { basename, isAbsolute, resolve, sep } from 'node:path'

import { evaluateHook, protectablePath } from '../../codex/hooks/policy.mjs'
import {
  isPiBashTool,
  isPiDispatchTool,
  isPiReadTool,
  isPiWriteTool
} from './pi-adapter-map.mjs'
import { piStateRoot } from './pi-paths.mjs'

/** Mesma frase de policy.mjs (denyForCommand) — não inventar prefixo novo. */
const SECRET_REASON = 'Secret-bearing paths are blocked from shell access by the delivery harness.'
/** Mesma frase de policy.mjs (mutatesProtectedPath). */
const PROTECTED_REASON = 'Harness-owned paths are protected from direct tool mutation.'

/** `.pi` como segmento de caminho; espelha o formato do regex de protectablePath. */
const PI_PROTECTED = /(?:^|[/\s"\x27`])\.pi(?:[/\s"\x27`]|$)/
/** Mesmos verbos de mutação usados por mutatesProtectedPath em policy.mjs. */
const MUTATION_VERB = /\b(?:rm|mv|cp|install|touch|mkdir|chmod|chown|truncate|tee|sed|perl)\b|(?:^|[^<])>{1,2}/

const ALLOW = { block: false }

/** @description Caminho é protegido do harness na lane Pi: `.pi`, `.codex` ou `.agents`. */
export function piProtectablePath(path) {
  const value = String(path ?? '')
  return protectablePath(value) || PI_PROTECTED.test(value)
}

/** @description Caminho carrega segredo segundo os Read-denies de core/claude-code/settings.json:
 * `.env`, `.env.*`, `**​/.env`, `**​/.env.*`, `.dev.vars`, `**​/.dev.vars`, `~/.ssh/**`, `~/.aws/**`.
 * Expande `~` e resolve para absoluto antes de casar. */
export function isSecretReadPath(path, options = {}) {
  if (typeof path !== 'string' || path.length === 0) return false
  const home = typeof options.home === 'string' && options.home.length > 0 ? options.home : homedir()
  const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : process.cwd()
  const expanded = path === '~' ? home : path.startsWith(`~${sep}`) || path.startsWith('~/') ? resolve(home, path.slice(2)) : path
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  const name = basename(absolute)
  if (name === '.env' || name.startsWith('.env.')) return true
  if (name === '.dev.vars') return true
  for (const dir of ['.ssh', '.aws']) {
    const root = resolve(home, dir)
    if (absolute === root || absolute.startsWith(root + sep)) return true
  }
  return false
}

/** @description Traduz a decisão do motor Codex ({hookSpecificOutput}) para {block, reason}. */
function fromCodexDecision(output) {
  const reason = output?.hookSpecificOutput?.permissionDecisionReason
  return typeof reason === 'string' && reason.length > 0 ? { block: true, reason } : ALLOW
}

/** @description Monta o payload PreToolUse que evaluateHook espera a partir de uma tool do Pi.
 * bash|powershell → tool_name 'Bash' com tool_input.command = input.command;
 * write|edit → tool_name 'apply_patch' com tool_input.command = input.path (aciona mutatesProtectedPath).
 * Devolve null para tools que o motor Codex não julga. */
export function toCodexPreToolPayload({ toolName, input } = {}) {
  const data = input && typeof input === 'object' ? input : {}
  if (isPiBashTool(toolName)) {
    return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: data.command } }
  }
  if (isPiWriteTool(toolName)) {
    return { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: data.path } }
  }
  return null
}

/** @description Decisão de política para uma chamada de tool do Pi.
 * Devolve {block:false} quando permitido e {block:true, reason} quando negado, com a mensagem
 * EXATAMENTE igual à permissionDecisionReason da lane OC/Codex. Nunca lança: entrada malformada
 * de bash/write/edit cai no fail-closed do motor ('Malformed tool input is denied before execution.'),
 * e tool desconhecida é fail-open (permitida — esta peça só nega o que sabe julgar). */
export function decidePiPolicy(call = {}, options = {}) {
  const toolName = call?.toolName
  const input = call?.input && typeof call.input === 'object' ? call.input : {}

  if (isPiReadTool(toolName)) {
    return isSecretReadPath(input.path, options) ? { block: true, reason: SECRET_REASON } : ALLOW
  }

  const payload = toCodexPreToolPayload({ toolName, input })
  if (!payload) return ALLOW

  const codex = fromCodexDecision(evaluateHook(payload))
  if (codex.block) return codex

  const target = payload.tool_input.command
  if (typeof target !== 'string' || !PI_PROTECTED.test(target)) return ALLOW
  if (isPiWriteTool(toolName)) return { block: true, reason: PROTECTED_REASON }
  return MUTATION_VERB.test(target) ? { block: true, reason: PROTECTED_REASON } : ALLOW
}

/** @description Tool cujo término gera recibo de auditoria. Espelha o matcher da lane Codex
 * (core/codex/hooks.json → PostToolUse "Bash|apply_patch|Agent"): bash/powershell = Bash,
 * write/edit = apply_patch, subagent = Agent. Leitura (read/grep/find/ls) NÃO é auditada lá,
 * e não pode ser auditada aqui — auditar toda tool encheria .pi/harness/state/audit e
 * divergiria da superfície de auditoria da lane fonte. */
export function shouldAuditPiTool(toolName) {
  return isPiBashTool(toolName) || isPiWriteTool(toolName) || isPiDispatchTool(toolName)
}

/** @description Diretório de auditoria da peça policy: <projectRoot>/.pi/harness/state/audit.
 * Mesmo contrato PathResult de core/pi/lib/pi-paths.mjs. */
export function piAuditDir(projectRoot) {
  const root = piStateRoot(projectRoot)
  if (!root.ok) return root
  return { ok: true, path: `${root.path}/audit` }
}

/** @description Grava o recibo imutável (flag 'wx') do PostToolUse pelo mesmo caminho da lane
 * Codex — um arquivo <sessionId>-<toolCallId>.json sem conteúdo do comando. Falha de escrita é
 * silenciosa (fail-open) e nunca vira contexto do modelo: devolve sempre {} como evaluateHook. */
export function recordPiPolicyAudit({ sessionId, toolCallId, toolName, auditDir } = {}) {
  return evaluateHook({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    session_id: sessionId,
    tool_use_id: toolCallId
  }, { auditDir })
}

export { PROTECTED_REASON, SECRET_REASON }
