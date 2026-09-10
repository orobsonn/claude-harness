import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

import {
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  getAgentDir,
  truncateHead,
  truncateLine
} from '@earendil-works/pi-coding-agent'

import { REVIEWER_GREP_GUARD } from './policy.mjs'

const REVIEWER_GREP = Symbol('harness-reviewer-grep')
const DEFAULT_LIMIT = 100

export function markReviewerGrepInput(input, scope) {
  if (!input || typeof input !== 'object') return
  Object.defineProperty(input, REVIEWER_GREP, {
    value: Object.freeze({ projectRoot: scope?.projectRoot, target: scope?.target })
  })
}

function managedRgPath() {
  return join(getAgentDir(), 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
}

let rgPathPromise

async function resolveRgPath(cwd) {
  const managed = managedRgPath()
  if (existsSync(managed)) return managed
  if (!spawnSync('rg', ['--version'], { stdio: 'ignore' }).error) return 'rg'
  if (!rgPathPromise) {
    rgPathPromise = (async () => {
      const probeDir = mkdtempSync(join(tmpdir(), 'pi-reviewer-grep-probe-'))
      try {
        await createGrepToolDefinition(cwd).execute(
          'harness-reviewer-grep-probe',
          { pattern: 'harness-reviewer-grep-probe', path: probeDir, literal: true },
          undefined,
          undefined,
          {},
        )
      } finally {
        rmSync(probeDir, { recursive: true, force: true })
      }
      return existsSync(managed) ? managed : 'rg'
    })()
  }
  return rgPathPromise
}

function pathIsInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function reviewerExecutionScope(cwd, requested, approved) {
  if (typeof approved?.projectRoot !== 'string' || typeof approved?.target !== 'string') {
    throw new Error('Reviewer grep approval is unavailable')
  }
  let root, sessionRoot, target
  try {
    root = realpathSync(approved.projectRoot)
    sessionRoot = realpathSync(cwd)
    target = realpathSync(resolve(root, typeof requested === 'string' && requested.length > 0 ? requested : '.'))
  } catch {
    throw new Error('Reviewer grep target changed after policy approval')
  }
  if (root !== approved.projectRoot || sessionRoot !== root || target !== approved.target || !pathIsInside(root, target)) {
    throw new Error('Reviewer grep target changed after policy approval')
  }
  if (!statSync(target).isDirectory()) throw new Error('Not a directory: ' + target)
  const targetFromRoot = relative(root, target).split(sep).join('/') || '.'
  return { root, targetFromRoot }
}

function scopeModelGlob(glob, targetFromRoot) {
  if (targetFromRoot === '.' || !glob.includes('/')) return glob
  const excluded = glob.startsWith('!')
  const body = excluded ? glob.slice(1) : glob
  const literalRoot = targetFromRoot.replace(/([*?[\]{}!\\])/g, '\\$1')
  return (excluded ? '!' : '') + literalRoot + '/' + body.replace(/^\/+/, '')
}

async function executeGuardedReviewerGrep(cwd, input, signal, approved) {
  if (signal?.aborted) throw new Error('Operation aborted')
  const rgPath = await resolveRgPath(cwd)
  if (signal?.aborted) throw new Error('Operation aborted')
  const scope = reviewerExecutionScope(cwd, input.path, approved)
  const limit = Math.max(1, Number.isFinite(input.limit) ? Math.floor(input.limit) : DEFAULT_LIMIT)
  const context = Number.isFinite(input.context) && input.context > 0 ? Math.floor(input.context) : 0
  const args = ['--json', '--line-number', '--color=never', '--hidden']
  if (input.ignoreCase) args.push('--ignore-case')
  if (input.literal) args.push('--fixed-strings')
  if (context > 0) args.push('--context', String(context))
  args.push('--glob', scopeModelGlob(input.glob, scope.targetFromRoot))
  args.push('--glob', REVIEWER_GREP_GUARD, '--', input.pattern, scope.targetFromRoot)

  return runGuardedGrep(rgPath, args, scope.root, scope.targetFromRoot, limit, signal)
}

function parseRgEvent(rawLine, targetFromRoot) {
  let event
  try { event = JSON.parse(rawLine) } catch { return null }
  if (event?.type !== 'match' && event?.type !== 'context') return null
  const path = event.data?.path?.text
  const line = event.data?.line_number
  const content = event.data?.lines?.text
  if (typeof path !== 'string' || typeof line !== 'number' || typeof content !== 'string') return null
  let label = path.startsWith('./') ? path.slice(2) : path
  if (targetFromRoot !== '.') {
    const prefix = targetFromRoot.endsWith('/') ? targetFromRoot : targetFromRoot + '/'
    if (label.startsWith(prefix)) label = label.slice(prefix.length)
  }
  const separator = event.type === 'match' ? ':' : '-'
  return {
    match: event.type === 'match',
    text: label + separator + line + separator + ' ' + content.replace(/\r?\n$/, '')
  }
}

function runGuardedGrep(rgPath, args, searchRoot, targetFromRoot, limit, signal) {
  if (signal?.aborted) return Promise.reject(new Error('Operation aborted'))
  return new Promise((resolveResult, reject) => {
    const child = spawn(rgPath, args, { cwd: searchRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    let currentGroup = []
    let currentHasMatch = false
    let matchCount = 0
    let matchLimitReached = false
    let linesTruncated = false
    let killedForLimit = false
    let aborted = false
    const output = []

    const flushGroup = () => {
      if (!currentHasMatch) {
        currentGroup = []
        return
      }
      if (output.length > 0) output.push('--')
      output.push(...currentGroup)
      currentGroup = []
      currentHasMatch = false
    }
    const stop = () => {
      if (!child.killed) child.kill()
    }
    const onAbort = () => {
      aborted = true
      stop()
    }
    const cleanup = () => {
      lines.close()
      signal?.removeEventListener('abort', onAbort)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    lines.on('line', rawLine => {
      const parsed = parseRgEvent(rawLine, targetFromRoot)
      if (!parsed) return
      if (parsed.match && matchCount >= limit) {
        matchLimitReached = true
        killedForLimit = true
        flushGroup()
        stop()
        return
      }
      if (parsed.match) {
        matchCount += 1
        currentHasMatch = true
      }
      const truncated = truncateLine(parsed.text)
      if (truncated.wasTruncated) linesTruncated = true
      currentGroup.push(truncated.text)
    })
    child.on('error', error => {
      cleanup()
      reject(new Error('Failed to run ripgrep: ' + error.message))
    })
    child.on('close', code => {
      cleanup()
      if (aborted) return reject(new Error('Operation aborted'))
      if (!killedForLimit && code !== 0 && code !== 1) {
        return reject(new Error(stderr.trim() || 'ripgrep exited with code ' + code))
      }
      flushGroup()
      if (matchCount === 0) {
        return resolveResult({ content: [{ type: 'text', text: 'No matches found' }], details: undefined })
      }
      const rawOutput = output.join('\n')
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })
      let text = truncation.content
      const details = {}
      const notices = []
      if (matchLimitReached) {
        details.matchLimitReached = limit
        notices.push(limit + ' matches limit reached. Use a higher limit or refine pattern')
      }
      if (truncation.truncated) {
        details.truncation = truncation
        notices.push(DEFAULT_MAX_BYTES / 1024 + 'KB limit reached')
      }
      if (linesTruncated) {
        details.linesTruncated = true
        notices.push('Some lines truncated; use read to inspect a specific safe file')
      }
      if (notices.length > 0) text += '\n\n[' + notices.join('. ') + ']'
      resolveResult({
        content: [{ type: 'text', text }],
        details: Object.keys(details).length > 0 ? details : undefined
      })
    })
  })
}

export function registerReviewerGrepTool(pi) {
  if (typeof pi?.registerTool !== 'function') return
  const template = createGrepToolDefinition(process.cwd())
  pi.registerTool({
    ...template,
    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const cwd = typeof ctx?.cwd === 'string' && ctx.cwd.length > 0 ? ctx.cwd : process.cwd()
      const approved = input?.[REVIEWER_GREP]
      if (approved) {
        return executeGuardedReviewerGrep(cwd, input, signal, approved)
      }
      return createGrepToolDefinition(cwd).execute(toolCallId, input, signal, onUpdate, ctx)
    }
  })
}
