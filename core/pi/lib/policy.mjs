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
import { isSafeFeatureId } from '../../shared/lib/feature-id.mjs'
import {
  isPiBashTool,
  isPiDispatchTool,
  isPiReadTool,
  isPiWriteTool
} from './pi-adapter-map.mjs'
import { piStateRoot } from './pi-paths.mjs'
import { isPiCanonicalPlanPath } from './plan-write-decide.mjs'

/** Mesma frase de policy.mjs (denyForCommand) — não inventar prefixo novo. */
const SECRET_REASON = 'Secret-bearing paths are blocked from shell access by the delivery harness.'
/** Mesma frase de policy.mjs (mutatesProtectedPath). */
const PROTECTED_REASON = 'Harness-owned paths are protected from direct tool mutation.'

/** `.pi` como segmento de caminho; espelha o formato do regex de protectablePath. */
const PI_PROTECTED = /(?:^|[/\s"\x27`])\.pi(?:[/\s"\x27`]|$)/
/** Mesmos verbos de mutação usados por mutatesProtectedPath em policy.mjs. */
const MUTATION_VERB = /\b(?:rm|mv|cp|install|touch|mkdir|chmod|chown|truncate|tee|sed|perl)\b|(?:^|[^<])>{1,2}/

const ALLOW = { block: false }
const PARENT_ORCHESTRATOR_REASON =
  "Parent orchestrator uses the Claude Code Bash allowlist for verification and selective commits during an active LIGHT/FULL ceremony; delegate product file mutations to a designated writing hand."

// Espelho literal de core/claude-code/settings.json → permissions.allow → Bash(...).
// Não mantemos uma segunda interpretação menor no Pi: se Claude Code aceita uma chamada,
// o pai Pi também a aceita nesta fronteira. Os denies e gates de entrega seguem aplicados
// depois, como no Claude Code.
export const CLAUDE_CODE_BASH_ALLOWLIST = Object.freeze([
  "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)",
  "Bash(git add:*)", "Bash(git commit:*)", "Bash(git push)",
  "Bash(git push --force-with-lease:*)", "Bash(git push * --force-with-lease:*)",
  "Bash(git branch:*)", "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git fetch:*)",
  "Bash(git pull)", "Bash(git stash:*)", "Bash(git restore:*)", "Bash(gh:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)",
  "Bash(find:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(which:*)", "Bash(pwd)",
  "Bash(echo:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(sed:*)", "Bash(awk:*)",
  "Bash(diff:*)", "Bash(stat:*)", "Bash(file:*)", "Bash(jq:*)", "Bash(mkdir:*)",
  "Bash(touch:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(npm test:*)", "Bash(npm run:*)",
  "Bash(npm ci:*)", "Bash(npm list:*)", "Bash(npm info:*)", "Bash(pnpm test:*)",
  "Bash(pnpm run:*)", "Bash(yarn test:*)", "Bash(bun test:*)", "Bash(bun run:*)",
  "Bash(vitest:*)", "Bash(vitest run:*)", "Bash(jest:*)", "Bash(tsc --noEmit:*)",
  "Bash(eslint:*)", "Bash(prettier:*)", "Bash(node:*)",
])

function claudeBashPatternMatches(pattern, command) {
  const inner = pattern.slice("Bash(".length, -1)
  const normalized = inner.endsWith(":*") ? `${inner.slice(0, -2)} *` : inner
  const boundary = normalized.endsWith(" *")
  const body = boundary ? normalized.slice(0, -2) : normalized
  const escaped = body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}${boundary ? "(?: .*)?" : ""}$`).test(command)
}

/**
 * @description Uma cerimônia ativa muda a autoridade do pai: LIGHT/FULL é executado por
 * mãos despachadas, nunca pela sessão que orquestra. QUICK permanece intencionalmente fora
 * desse rail para não transformar uma correção pequena em ceremony artificial.
 */
function isActiveDeliveryCeremony(gateState) {
  if (!gateState || typeof gateState !== "object" || Array.isArray(gateState)) return false
  if (gateState.classified !== true) return false
  if (gateState.ceremony_status === "suspended-inline") return false
  const mode = typeof gateState.mode === "string" ? gateState.mode.toLowerCase() : ""
  return mode === "light" || mode === "full"
}

/**
 * @description Mesma allowlist Bash do Claude Code, mais o hash estrito dos dois artefatos
 * canônicos da feature ativa. O Pi não tem prompt de permissão nativo compatível, por isso
 * aplica essas permissões explicitamente apenas nesta fronteira do pai.
 */
function isCanonicalPlanDigestCommand(command, gateState) {
  if (!isActiveDeliveryCeremony(gateState) || !isSafeFeatureId(gateState?.feature_id)) return false
  const root = `.pi/harness/plans/${gateState.feature_id}`
  const spec = `${root}/spec.md`
  const plan = `${root}/execution-plan.json`
  return command === `sha256sum ${spec}` ||
    command === `sha256sum ${plan}` ||
    command === `sha256sum ${spec} ${plan}`
}

function isParentVerificationCommand(command, gateState) {
  return typeof command === "string" && (
    isCanonicalPlanDigestCommand(command, gateState) ||
    CLAUDE_CODE_BASH_ALLOWLIST.some((pattern) => claudeBashPatternMatches(pattern, command))
  )
}

/**
 * @description Decisão de autoridade do pai durante cerimônia. Exportada para que os testes
 * provem a fronteira sem depender do adaptador de eventos do Pi.
 */
export function decidePiParentOrchestratorPolicy(call = {}, options = {}) {
  const status = options?.gateState?.ceremony_status
  if (options?.isChild !== true && ["suspended-inline", "reconciling"].includes(status)) {
    const tool = call?.toolName
    const input = call?.input ?? {}
    const blocked = { block: true, reason: `Ceremony is ${status}; use classify resume-ceremony to reconcile before delivery.` }
    if (tool === "classify" && !["suspend-inline", "resume-ceremony"].includes(input.action)) return blocked
    if (tool === "mark" || tool === "harness_spec_write" || tool === "seal_spec_review") return blocked
    if (tool === "harness_plan" && input.action !== "show") return blocked
    if (tool === "subagent" && (status === "suspended-inline" || !["harness-planner", "harness-plan-reviewer"].includes(input.subagent_type))) return blocked
  }
  if (options?.isChild === true || (options?.isHeadless !== true && !isActiveDeliveryCeremony(options?.gateState))) return ALLOW
  const toolName = call?.toolName
  if (isPiWriteTool(toolName)) return { block: true, reason: PARENT_ORCHESTRATOR_REASON }
  if (isPiBashTool(toolName) && !isParentVerificationCommand(call?.input?.command, options?.gateState)) {
    return { block: true, reason: PARENT_ORCHESTRATOR_REASON }
  }
  return ALLOW
}

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

  const parentAuthority = decidePiParentOrchestratorPolicy({ toolName, input }, options)
  if (parentAuthority.block) return parentAuthority

  if (isPiReadTool(toolName)) {
    return isSecretReadPath(input.path, options) ? { block: true, reason: SECRET_REASON } : ALLOW
  }

  const payload = toCodexPreToolPayload({ toolName, input })
  if (!payload) return ALLOW

  // O plano canônico é um único carve-out: a policy de superfície não sabe quem escreve;
  // o plan-write-gate, carregado depois, prova sessão-filho + papel planner e nega todo o resto.
  // Sem este deferimento, a policy bloquearia a própria trilha FULL antes daquele gate rodar.
  if (isPiWriteTool(toolName) && isPiCanonicalPlanPath(input.path)) return ALLOW

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

export { PARENT_ORCHESTRATOR_REASON, PROTECTED_REASON, SECRET_REASON }
