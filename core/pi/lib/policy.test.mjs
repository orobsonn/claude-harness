import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CLAUDE_CODE_BASH_ALLOWLIST,
  decidePiPolicy,
  isSecretReadPath,
  piAuditDir,
  piProtectablePath,
  recordPiPolicyAudit,
  shouldAuditPiTool
} from './policy.mjs'

const bash = (command) => decidePiPolicy({ toolName: 'bash', input: { command } })
const HOME = '/home/tester'
const readPath = (path) => decidePiPolicy({ toolName: 'read', input: { path } }, { home: HOME, cwd: '/repo' })

test('a allowlist Bash do Pi é cópia exata da configuração do Claude Code', () => {
  const settings = JSON.parse(readFileSync(new URL('../../claude-code/settings.json', import.meta.url), 'utf8'))
  assert.deepEqual(CLAUDE_CODE_BASH_ALLOWLIST, settings.permissions.allow.filter((rule) => rule.startsWith('Bash(')))
})

test('bloqueia force push antes do bash rodar, com a mensagem da lane OC', () => {
  const out = bash('git push --force origin main')
  assert.equal(out.block, true)
  assert.match(out.reason, /force push/i)
})

test('permite force-with-lease em vez de proibir toda recuperação', () => {
  assert.deepEqual(bash('git push --force-with-lease origin feature'), { block: false })
})

test('bloqueia a bateria de comandos destrutivos e de deploy da lane OC', () => {
  for (const command of [
    'git reset --hard HEAD',
    'git clean -f',
    'git push origin main --force',
    'git -C repo push origin main -f',
    'cd repo && git reset --hard',
    'wrangler deploy',
    'env wrangler deploy',
    'command wrangler deploy',
    '/usr/bin/env wrangler deploy',
    'npx wrangler versions list',
    'npx --yes wrangler deploy',
    'npx -y wrangler secret put TOKEN',
    'pnpm exec wrangler secret put TOKEN',
    'pnpm dlx wrangler versions upload',
    'pnpm --silent dlx wrangler versions upload',
    'yarn dlx wrangler r2 bucket create data',
    'bunx wrangler d1 execute db --remote',
    'bun x wrangler r2 bucket create data',
    'npm exec -- wrangler d1 execute db --remote',
    './node_modules/.bin/wrangler deploy',
    'npm run deploy',
    'yarn deploy'
  ]) {
    assert.equal(bash(command).block, true, command)
  }
})

test('bloqueia leitura de shell em caminhos com segredo', () => {
  for (const command of [
    'cat .env',
    'rg token .dev.vars',
    'cat ~/.ssh/id_ed25519',
    'find ~/.aws -type f',
    "cat .env$(printf '')",
    'cat $(printf .env)',
    'cat .e??',
    'cat .{en}v',
    'cat .e[n]v',
    'cat ${SECRET_ENV_PATH}'
  ]) {
    assert.equal(bash(command).block, true, command)
  }
  assert.deepEqual(bash('cat package.json'), { block: false })
})

test('git add seletivo continua negando arquivos .env e .dev.vars', () => {
  for (const command of [
    'git add -- .env',
    'git add -- .env.local',
    'git add -- apps/api/.env.production',
    'git add -- .dev.vars',
    'git add -- packages/api/.dev.vars',
  ]) {
    const out = bash(command)
    assert.equal(out.block, true, command)
    assert.equal(out.reason, 'Secret-bearing paths are blocked from shell access by the delivery harness.')
  }
})

test('bloqueia os dois subcomandos inseguros do lavish sem barrar o resto', () => {
  for (const command of [
    'npx lavish-axi share mockup',
    'lavish-axi@1.2.3 setup hooks',
    'echo ok && lavish-axi share landing'
  ]) {
    assert.equal(bash(command).block, true, command)
  }
  assert.deepEqual(bash('npx lavish-axi preview mockup'), { block: false })
})

test('powershell é julgado pelo mesmo motor que o bash', () => {
  assert.equal(decidePiPolicy({ toolName: 'powershell', input: { command: 'git reset --hard' } }).block, true)
})

test('write e edit não mutam caminhos do harness (.codex, .agents, .pi)', () => {
  for (const [toolName, path] of [
    ['write', '.codex/hooks.json'],
    ['edit', '.agents/rules.md'],
    ['write', '.pi/harness/lib/x.mjs'],
    ['edit', '/repo/.pi/harness/state/gate-state.json']
  ]) {
    const out = decidePiPolicy({ toolName, input: { path } })
    assert.equal(out.block, true, path)
    assert.equal(out.reason, 'Harness-owned paths are protected from direct tool mutation.')
  }
  assert.deepEqual(decidePiPolicy({ toolName: 'write', input: { path: 'src/app.ts' } }), { block: false })
})

test('em cerimônia LIGHT/FULL o pai aplica a mesma allowlist Bash do Claude Code; escrita nativa continua bloqueada', () => {
  const fullParent = { gateState: { classified: true, mode: 'FULL' }, isChild: false }
  const fullChild = { gateState: { classified: true, mode: 'FULL' }, isChild: true }

  for (const call of [
    { toolName: 'write', input: { path: 'src/app.ts' } },
    { toolName: 'edit', input: { path: 'tests/app.test.mjs' } },
    { toolName: 'bash', input: { command: 'printf x > src/app.ts' } },
  ]) {
    const out = decidePiPolicy(call, fullParent)
    assert.equal(out.block, true, JSON.stringify(call))
    assert.match(out.reason, /parent orchestrator/i)
  }

  for (const command of [
    'git status --short',
    'git diff --check',
    'gh issue view 17 --json number,title,body,labels,state,url',
    'gh pr list --state all --json number,title,state,url',
    'gh pr view 42 --json number,title,state,url',
    'gh pr status',
    'npm test',
    'npm run typecheck',
    'node --test test/unit.test.mjs',
  ]) {
    assert.deepEqual(decidePiPolicy({ toolName: 'bash', input: { command } }, fullParent), { block: false }, command)
  }

  for (const command of [
    'git add -- tests/app.test.mjs',
    'git add -- src/app.ts',
    'git commit -m "test(app): freeze locked test for task-1"',
    'git commit -m "feat(app): implement task-1"',
  ]) {
    assert.deepEqual(
      decidePiPolicy({ toolName: 'bash', input: { command } }, fullParent),
      { block: false },
      command,
    )
  }

  const nativeWrite = decidePiPolicy(
    { toolName: 'write', input: { path: 'src/app.ts' } },
    fullParent,
  )
  assert.equal(nativeWrite.block, true)
  assert.match(nativeWrite.reason, /Claude Code Bash allowlist.*selective commits/i)
  assert.doesNotMatch(nativeWrite.reason, /delegate product changes and commits/i)
  assert.deepEqual(
    decidePiPolicy({ toolName: 'bash', input: { command: 'node -e "require(\'node:fs\').writeFileSync(\'src/app.ts\', \'x\')"' } }, fullParent),
    { block: false },
  )

  assert.deepEqual(
    decidePiPolicy({ toolName: 'write', input: { path: 'src/app.ts' } }, fullChild),
    { block: false },
  )
  assert.deepEqual(
    decidePiPolicy({ toolName: 'write', input: { path: 'src/app.ts' } }, { gateState: { mode: 'QUICK' }, isChild: false }),
    { block: false },
  )
})

test('plano canônico é delegado ao plan-write-gate, não bloqueado pela policy genérica', () => {
  for (const toolName of ['write', 'edit']) {
    assert.deepEqual(
      decidePiPolicy({ toolName, input: { path: '.pi/harness/plans/pi-canary/execution-plan.json' } }),
      { block: false },
      toolName,
    )
  }
  // O mesmo carve-out não abre estado, tooling nem arquivo parecido.
  assert.equal(decidePiPolicy({ toolName: 'write', input: { path: '.pi/harness/plans/state/execution-plan.json' } }).block, true)
  assert.equal(decidePiPolicy({ toolName: 'write', input: { path: '.pi/harness/plans/pi-canary/notes.json' } }).block, true)
})

test('ler config do harness continua liberado enquanto mutações de shell são negadas', () => {
  assert.deepEqual(bash('cat .codex/hooks.json'), { block: false })
  assert.deepEqual(bash('cat .pi/harness/state/gate-state.json'), { block: false })
  assert.equal(bash("printf '{}' > .codex/hooks.json").block, true)
  const out = bash("printf '{}' > .pi/harness/hooks.json")
  assert.equal(out.block, true)
  assert.equal(out.reason, 'Harness-owned paths are protected from direct tool mutation.')
  assert.equal(bash('rm -rf .pi/harness/state').block, true)
})

test('payload malformado de bash, write ou edit é negado de forma conservadora', () => {
  for (const call of [
    { toolName: 'bash', input: {} },
    { toolName: 'write', input: {} },
    { toolName: 'edit', input: { path: 42 } }
  ]) {
    const out = decidePiPolicy(call)
    assert.equal(out.block, true)
    assert.equal(out.reason, 'Malformed tool input is denied before execution.')
  }
})

test('tool que a peça não julga é fail-open', () => {
  assert.deepEqual(decidePiPolicy({ toolName: 'subagent', input: { subagent_type: 'harness-planner' } }), { block: false })
  assert.deepEqual(decidePiPolicy(), { block: false })
})

test('read, grep, find e ls negam os 8 caminhos com segredo do settings.json', () => {
  for (const path of [
    '.env',
    '.env.local',
    'apps/web/.env',
    'apps/web/.env.production',
    '.dev.vars',
    'packages/api/.dev.vars',
    '~/.ssh/id_ed25519',
    '~/.aws/credentials',
    '/home/tester/.ssh/config',
    '/home/tester/.aws/config'
  ]) {
    const out = readPath(path)
    assert.equal(out.block, true, path)
    assert.equal(out.reason, 'Secret-bearing paths are blocked from shell access by the delivery harness.')
  }
  for (const toolName of ['read', 'grep', 'find', 'ls']) {
    assert.equal(decidePiPolicy({ toolName, input: { path: '.env' } }, { home: HOME, cwd: '/repo' }).block, true, toolName)
  }
})

test('read de arquivo comum continua liberado', () => {
  for (const path of ['package.json', 'src/.environment.ts', '~/.sshfoo/key', 'docs/.envoy.md']) {
    assert.deepEqual(readPath(path), { block: false }, path)
  }
  assert.equal(isSecretReadPath('', { home: HOME, cwd: '/repo' }), false)
  assert.equal(isSecretReadPath(undefined, { home: HOME, cwd: '/repo' }), false)
})

test('piProtectablePath cobre .pi além de .codex e .agents', () => {
  assert.equal(piProtectablePath('.codex/hooks.json'), true)
  assert.equal(piProtectablePath('.agents/x.md'), true)
  assert.equal(piProtectablePath('.pi/harness/lib/x.mjs'), true)
  assert.equal(piProtectablePath('.pilot/config.json'), false)
  assert.equal(piProtectablePath('src/app.ts'), false)
})

test('diretório de auditoria fica sob .pi/harness/state', () => {
  assert.deepEqual(piAuditDir('/repo'), { ok: true, path: '/repo/.pi/harness/state/audit' })
  assert.deepEqual(piAuditDir(''), { ok: false, reason: 'invalid projectRoot' })
})

test('auditoria grava um recibo único e imutável, sem conteúdo do comando', (t) => {
  const auditDir = mkdtempSync(join(tmpdir(), 'pi-policy-audit-'))
  t.after(() => rmSync(auditDir, { recursive: true, force: true }))
  const first = recordPiPolicyAudit({ sessionId: 'ses-123', toolCallId: 'call456', toolName: 'bash', auditDir })
  assert.deepEqual(first, {})
  const second = recordPiPolicyAudit({ sessionId: 'ses-123', toolCallId: 'call456', toolName: 'bash', auditDir })
  assert.deepEqual(second, {})

  const files = readdirSync(auditDir)
  assert.deepEqual(files, ['ses-123-call456.json'])
  assert.deepEqual(JSON.parse(readFileSync(join(auditDir, files[0]), 'utf8')), {
    event: 'PostToolUse',
    tool: 'bash',
    session_id: 'ses-123',
    tool_use_id: 'call456'
  })
})

test('a superfície auditada espelha o matcher da lane Codex (Bash|apply_patch|Agent)', () => {
  for (const toolName of ['bash', 'powershell', 'write', 'edit', 'subagent']) {
    assert.equal(shouldAuditPiTool(toolName), true, toolName)
  }
  // Leitura não é auditada na lane Codex (hooks.json não casa Read) — não pode ser aqui.
  for (const toolName of ['read', 'grep', 'find', 'ls', 'get_subagent_result', undefined]) {
    assert.equal(shouldAuditPiTool(toolName), false, String(toolName))
  }
})

test('nome de tool é julgado sem depender de caixa', () => {
  assert.equal(decidePiPolicy({ toolName: 'BASH', input: { command: 'git reset --hard' } }).block, true)
  assert.equal(decidePiPolicy({ toolName: 'Write', input: { path: '.pi/harness/x.mjs' } }).block, true)
  assert.equal(decidePiPolicy({ toolName: 'Read', input: { path: '.env' } }, { home: HOME, cwd: '/repo' }).block, true)
  assert.equal(shouldAuditPiTool('Bash'), true)
})

test('cwd da opção resolve caminho relativo que sobe para a home', () => {
  const call = { toolName: 'read', input: { path: '../../.ssh/id_ed25519' } }
  assert.equal(decidePiPolicy(call, { home: HOME, cwd: '/home/tester/repo/pkg' }).block, true)
  assert.deepEqual(decidePiPolicy(call, { home: HOME, cwd: '/srv/repo/pkg' }), { block: false })
})

test('falha de auditoria é silenciosa e nunca vira contexto do modelo', (t) => {
  assert.deepEqual(recordPiPolicyAudit({ sessionId: 'ses-1', toolCallId: 'c1', toolName: 'bash', auditDir: null }), {})
  const auditDir = mkdtempSync(join(tmpdir(), 'pi-policy-audit-'))
  t.after(() => rmSync(auditDir, { recursive: true, force: true }))
  assert.deepEqual(recordPiPolicyAudit({ sessionId: '../escape', toolCallId: 'c1', toolName: 'bash', auditDir }), {})
  assert.deepEqual(readdirSync(auditDir), [])
})
