/** @description Política de segurança da lane Pi: nega segredos, comandos destrutivos e mutação
 * de config do harness. Reusa por import o motor host-agnóstico de core/codex/hooks/policy.mjs
 * (evaluateHook / protectablePath) — nada é duplicado aqui. O que esta camada acrescenta é:
 *   1. o mapeamento dos nomes de tool do Pi (bash/powershell/write/edit/read/grep/find/ls) para o
 *      payload que evaluateHook espera ({hook_event_name, tool_name, tool_input:{command}});
 *   2. o equivalente aos 8 Read-denies de core/claude-code/settings.json, que policy.mjs não cobre;
 *   3. a extensão de protectablePath para também proteger `.pi` (além de `.codex`/`.agents`).
 * As mensagens de negação são IDÊNTICAS às da lane OC/Codex — sem prefixo novo. */

import { homedir } from 'node:os'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

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
import { isParallelReviewRole } from './roles.mjs'

export function isPiReadOnlyReviewerRole(role) {
  return role === 'harness-test-reviewer' || isParallelReviewRole(role)
}

/** Mesma frase de policy.mjs (denyForCommand) — não inventar prefixo novo. */
const SECRET_REASON = 'Secret-bearing paths are blocked from shell access by the delivery harness.'
/** Mesma frase de policy.mjs (mutatesProtectedPath). */
const PROTECTED_REASON = 'Harness-owned paths are protected from direct tool mutation.'

/** `.pi` como segmento de caminho; espelha o formato do regex de protectablePath. */
const PI_PROTECTED = /(?:^|[/\s"\x27`])\.pi(?:[/\s"\x27`]|$)/
/** Mesmos verbos de mutação usados por mutatesProtectedPath em policy.mjs. */
const MUTATION_VERB = /\b(?:rm|mv|cp|install|touch|mkdir|chmod|chown|truncate|tee|sed|perl)\b|(?:^|[^<])>{1,2}/
/** Redirecionar apenas um descritor para o sink literal não muta o caminho protegido citado
 * pelo comando. O delimitador evita aceitar sufixos, expansões ou outros destinos. */
const DEV_NULL_REDIRECT = /(?:\d*)>{1,2}[ \t]*\/dev\/null(?=$|[ \t\r\n|;&)])/g

function mutationCommand(command) {
  return command.replace(DEV_NULL_REDIRECT, '')
}

const ALLOW = { block: false }
const MODEL_PREFERENCES = new Set(['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'modelThinkingLevels'])
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const SETTINGS_REASON = 'Project model preferences: use native write with complete valid JSON in .pi/settings.json, preserving all non-model settings. Only the interactive parent may change these preferences; harness runtime files remain protected.'

// Operator preferences are not harness implementation. Check only this narrow native
// write delta, not shell programs or edit transformations. Other settings can execute code.
function decideModelPreferences(toolName, input, options) {
  if (!isPiWriteTool(toolName) || typeof input.path !== 'string') return null
  const cwd = options.cwd ?? process.cwd()
  const root = resolve(options.projectRoot ?? cwd)
  const target = resolve(cwd, input.path)
  if (target !== resolve(root, '.pi/settings.json')) return null
  const deny = { block: true, reason: SETTINGS_REASON }
  if (toolName !== 'write' || options.isChild === true || options.isHeadless === true) return deny
  try {
    if (/^@|^~|[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(input.path)) return deny
    const canonicalRoot = realpathSync(root)
    if (realpathSync(resolve(root, '.pi')) !== resolve(canonicalRoot, '.pi')) return deny
    let previous = {}
    try {
      const stat = lstatSync(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return deny
      previous = JSON.parse(readFileSync(target, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') return deny
    }
    const next = JSON.parse(input.content)
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    if (!object(previous) || !object(next)) return deny
    const otherSettings = value => Object.fromEntries(Object.entries(value).filter(([key]) => !MODEL_PREFERENCES.has(key)))
    if (!isDeepStrictEqual(otherSettings(previous), otherSettings(next))) return deny
    for (const key of ['defaultProvider', 'defaultModel']) {
      if (key in next && (typeof next[key] !== 'string' || !next[key].trim())) return deny
    }
    if ('defaultThinkingLevel' in next && !THINKING_LEVELS.has(next.defaultThinkingLevel)) return deny
    if ('modelThinkingLevels' in next && (!object(next.modelThinkingLevels) ||
      Object.values(next.modelThinkingLevels).some(level => !THINKING_LEVELS.has(level)))) return deny
    return ALLOW
  } catch { return deny }
}
const PARENT_ORCHESTRATOR_REASON =
  "Parent orchestrator uses the Claude Code Bash allowlist for verification and selective commits during an active LIGHT/FULL ceremony; delegate product file mutations to a designated writing hand."
const REVIEWER_READ_REASON = 'Read-only reviewers are confined to the canonical project root.'
export const REVIEWER_GREP_GUARD = '!{.[eE][nN][vV],.[eE][nN][vV].*,**/.[eE][nN][vV],**/.[eE][nN][vV].*,.[dD][eE][vV].[vV][aA][rR][sS],.[dD][eE][vV].[vV][aA][rR][sS].*,**/.[dD][eE][vV].[vV][aA][rR][sS],**/.[dD][eE][vV].[vV][aA][rR][sS].*,.[pP][iI]/[aA][gG][eE][nN][tT]/[aA][uU][tT][hH].[jJ][sS][oO][nN],**/.[pP][iI]/[aA][gG][eE][nN][tT]/[aA][uU][tT][hH].[jJ][sS][oO][nN],.[sS][sS][hH]/**,**/.[sS][sS][hH]/**,.[aA][wW][sS]/**,**/.[aA][wW][sS]/**,.[nN][pP][mM][rR][cC],**/.[nN][pP][mM][rR][cC],.[nN][eE][tT][rR][cC],**/.[nN][eE][tT][rR][cC],.[pP][yY][pP][iI][rR][cC],**/.[pP][yY][pP][iI][rR][cC],.[gG][iI][tT]-[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS],**/.[gG][iI][tT]-[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS],.[cC][oO][dD][eE][xX]/[aA][uU][tT][hH].[jJ][sS][oO][nN],**/.[cC][oO][dD][eE][xX]/[aA][uU][tT][hH].[jJ][sS][oO][nN],[aA][uU][tT][hH].[jJ][sS][oO][nN],**/[aA][uU][tT][hH].[jJ][sS][oO][nN],[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS],**/[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS],[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS].[jJ][sS][oO][nN],**/[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS].[jJ][sS][oO][nN],.[gG][iI][tT]/[cC][oO][nN][fF][iI][gG],**/.[gG][iI][tT]/[cC][oO][nN][fF][iI][gG]}'

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
    if (tool === "harness_tasks" && !["status", "wait"].includes(input.action)) return blocked
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

function pathIsInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function isPiReviewSecretPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  const segments = resolve(path).split(sep).filter(Boolean).map((segment) => segment.toLowerCase())
  // Keep reviewer reads aligned with generic sensitive files and directory ancestry omitted from review snapshots.
  if (segments.some((segment) => ['auth.json', 'credentials', 'credentials.json'].includes(segment))) return true
  if (segments.some((segment) =>
    segment === '.env' || segment.startsWith('.env.') ||
    segment === '.dev.vars' || segment.startsWith('.dev.vars.') ||
    segment === '.ssh' || segment === '.aws' ||
    segment === '.npmrc' || segment === '.netrc' || segment === '.pypirc' ||
    segment === '.git-credentials'
  )) {
    return true
  }
  return segments.some((segment, index) => (
    segment === '.pi' && segments[index + 1] === 'agent' && segments[index + 2] === 'auth.json'
  ) || (
    segment === '.codex' && segments[index + 1] === 'auth.json'
  ) || (
    segment === '.git' && segments[index + 1] === 'config'
  ))
}

/** @description Restringe revisores de implementação e fidelidade a leituras canônicas do projeto.
 * Para grep recursivo sem glob, devolve o patch fixo que o adaptador injeta antes da execução
 * da tool nativa. Um glob do modelo não pode ser composto com essa exclusão única e é negado. */
function decideReviewerReadPolicy(toolName, input, options) {
  if (!isPiReadOnlyReviewerRole(options?.reviewerRole)) return ALLOW

  let root
  try { root = realpathSync(options?.projectRoot ?? options?.cwd) } catch { return { block: true, reason: REVIEWER_READ_REASON } }
  const requested = typeof input.path === 'string' && input.path.length > 0 ? input.path : '.'
  // Pi rewrites these spellings before opening a file. Accept ordinary paths only so the
  // checked file is also the file the native tool opens, without copying Pi's path parser.
  if (/^@|^~(?:[/\\]|$)|^file:\/\/|[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(requested) ||
    (process.platform === 'win32' && /^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/|$)/i.test(requested))) {
    return { block: true, reason: REVIEWER_READ_REASON }
  }
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)
  let target
  try { target = realpathSync(candidate) } catch { return { block: true, reason: REVIEWER_READ_REASON } }
  if (!pathIsInside(root, target)) return { block: true, reason: REVIEWER_READ_REASON }
  if (isPiReviewSecretPath(candidate) || isPiReviewSecretPath(target)) {
    return { block: true, reason: SECRET_REASON }
  }

  if (String(toolName).toLowerCase() !== 'grep') return ALLOW
  let recursive
  try { recursive = statSync(target).isDirectory() } catch { return { block: true, reason: REVIEWER_READ_REASON } }
  if (!recursive) return ALLOW
  if (typeof input.glob === 'string') return { block: true, reason: REVIEWER_READ_REASON }
  return { block: false, inputPatch: { glob: REVIEWER_GREP_GUARD } }
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

  if (isPiReadOnlyReviewerRole(options.reviewerRole) && !isPiReadTool(toolName)) {
    return { block: true, reason: 'Read-only reviewers may use only read, grep, find and ls.' }
  }

  const modelPreferences = decideModelPreferences(toolName, input, options)
  if (modelPreferences) return modelPreferences

  const parentAuthority = decidePiParentOrchestratorPolicy({ toolName, input }, options)
  if (parentAuthority.block) return parentAuthority

  if (isPiReadTool(toolName)) {
    const reviewerRead = decideReviewerReadPolicy(toolName, input, options)
    if (reviewerRead.block || reviewerRead.inputPatch) return reviewerRead
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
  // /dev/null só é o sink esperado na lane Bash, não no PowerShell de outros hosts.
  const mutationTarget = typeof toolName === 'string' && toolName.toLowerCase() === 'bash'
    ? mutationCommand(target)
    : target
  return MUTATION_VERB.test(mutationTarget) ? { block: true, reason: PROTECTED_REASON } : ALLOW
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
