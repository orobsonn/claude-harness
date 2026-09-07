/** @description Cross-family merge for findings using policy B (keep unless explicit refute). Family-agnostic. Never throws. */
import { normalizeSeverity } from './severity.mjs'

/** @description Normalize free-text for dedup keys (collapse whitespace, lower-case). */
function norm(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Fields identifying a plan-review finding (schema: area, severity, task_id, problem,
 * planner_instruction — no id/title/description). Severity NEVER enters the key: two
 * distinct defects of equal severity are not the same defect.
 */
export const PLAN_REVIEW_DEDUP_FIELDS = Object.freeze(['task_id', 'problem', 'area'])

/**
 * Keys that never contribute identity: `severity` (two distinct defects of equal severity are
 * not the same defect) and `family` (injected by classifyFindings — including it would make a
 * primary finding never match its secondary twin).
 */
const NON_IDENTIFYING_KEYS = Object.freeze(['severity', 'family'])

/**
 * @description Key-ordered serialization so a nested value carries identity (a finding whose
 * only content is nested — e.g. a refutes vehicle — must not read as contentless). Cycles
 * collapse to a marker instead of recursing forever; the module never throws.
 * @param {unknown} value
 * @param {Set<object>} seen
 * @returns {string}
 */
function stableJson(value, seen) {
  if (value === null || typeof value !== 'object') return stablePrimitive(value)
  if (seen.has(value)) return '"[circular]"'
  seen.add(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v, seen)).join(',')}]`
  const body = Object.keys(value)
    .sort()
    .map((k) => `${stablePrimitive(k)}:${stableJson(readField(value, k), seen)}`)
    .join(',')
  return `{${body}}`
}

/**
 * @description Primitive serialization that keeps identity for the shapes JSON refuses
 * (BigInt, symbol, undefined) instead of throwing out of the module.
 * @param {unknown} value
 * @returns {string}
 */
function stablePrimitive(value) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * @description Identity of one field value. Primitives normalize as free text; objects and
 * arrays serialize key-ordered (never '[object Object]', which would make distinct findings
 * collide). Functions and symbols carry no identity.
 * @param {unknown} value
 * @returns {string}
 */
function fieldIdentity(value) {
  if (value === null || value === undefined) return ''
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return norm(value)
  if (t !== 'object') return ''
  return norm(stableJson(value, new Set()))
}

/**
 * @description Field read that upholds the module's never-throws contract: a throwing getter
 * costs that one field's identity, not the whole key.
 * @param {Record<string, unknown>} f
 * @param {string} name
 * @returns {unknown}
 */
function readField(f, name) {
  try {
    return f[name]
  } catch {
    return undefined
  }
}

/**
 * @description Stable identity built from the finding's own non-empty fields, severity and
 * family excluded.
 * @param {Record<string, unknown>} f
 * @returns {string}
 */
function structuralIdentity(f) {
  return Object.keys(f)
    .filter((k) => !NON_IDENTIFYING_KEYS.includes(k))
    .sort()
    .map((k) => [k, fieldIdentity(readField(f, k))])
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('|')
}

/**
 * Stable dedup key. When an explicit `fields` override is passed and yields a usable
 * identity, it wins over `id` — the caller knows its schema better than a generic
 * upstream-synthesized id (e.g. a hash derived from title/scope, which is empty for
 * plan-review findings and would otherwise collapse onto severity alone). Without a
 * usable `fields` override: prefer `id` when present; else
 * normalize(title||description) + '|' + severity + '|' + (scope||category||'').
 * Never keys on severity alone (two distinct highs must not collapse) — the tail falls back
 * to the finding's structural identity when the generic text/scope shape is empty too.
 * @param {unknown} finding
 * @param {string[]} [fields]
 * @returns {string}
 */
export function dedupKey(finding, fields) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return ''
  const f = /** @type {Record<string, unknown>} */ (finding)
  if (Array.isArray(fields) && fields.length > 0) {
    const parts = fields.map((name) => norm(readField(f, name)))
    const nonEmpty = parts.filter((p) => p.length > 0)
    // Guard: never return a severity-only key when multi-field list collapses to one part.
    if (nonEmpty.length >= 2 || (nonEmpty.length === 1 && fields.length === 1 && fields[0] !== 'severity')) {
      return parts.join('|')
    }
    // Degenerate override: `fields` named 2+ columns but runtime data left fewer than two
    // non-empty parts — too weak to key on (a stable `id`, when present, identifies better).
    // Falling through is only safe because every branch below refuses a severity-only key.
  }
  // Prefer stable id — distinct findings keep distinct keys even at same severity.
  const id = readField(f, 'id')
  if (typeof id === 'string' && id.trim().length > 0) {
    return `id:${id.trim()}`
  }
  const text = norm(readField(f, 'title') || readField(f, 'description') || '')
  const severity = norm(readField(f, 'severity') || '')
  const disc = norm(readField(f, 'scope') || readField(f, 'category') || '')
  if (text.length > 0 || disc.length > 0) {
    return `${text}|${severity}|${disc}`
  }
  // Nothing in the generic shape (plan-review findings carry none of title/description/
  // scope/category): `${text}|${severity}|${disc}` would emit `|<severity>|` and collapse every
  // distinct finding of that severity into one (#531). Key on the finding's own content, so
  // the guard holds without depending on an external validator rejecting degenerate input.
  return `struct:${structuralIdentity(f)}|${severity}`
}

/** @description Valid refutes vehicle: has refutes.{target_id,target_family,reason} — non-blocking even with title. */
export function isRefuteVehicle(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false
  const r = f.refutes
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  return typeof r.target_id === 'string' && r.target_id.length > 0 &&
         typeof r.target_family === 'string' && r.target_family.length > 0 &&
         typeof r.reason === 'string' && r.reason.trim().length >= 1
}

/**
 * @param {object[]} [familyAIssues]
 * @param {object[]} [familyBIssues]
 * @param {{a?: string, b?: string}} [labels]
 * @param {string[]} [fields] - explicit dedup-key field override (e.g. PLAN_REVIEW_DEDUP_FIELDS
 *   for plan-review findings, whose schema has no id/title/description). Forwarded to dedupKey.
 */
export function classifyFindings(familyAIssues = [], familyBIssues = [], labels = { a: 'primary', b: 'secondary' }, fields) {
  const aLabel =
    labels && typeof labels === 'object' && !Array.isArray(labels) && labels.a != null
      ? String(labels.a)
      : 'primary'
  const bLabel =
    labels && typeof labels === 'object' && !Array.isArray(labels) && labels.b != null
      ? String(labels.b)
      : 'secondary'
  const onlyA = Array.isArray(familyAIssues)
    ? familyAIssues
        .filter(f => f && typeof f === 'object')
        .map(f => ({ ...f, family: aLabel }))
    : []
  const onlyB = Array.isArray(familyBIssues)
    ? familyBIssues
        .filter(f => f && typeof f === 'object')
        .map(f => ({ ...f, family: bLabel }))
    : []
  const keyToA = new Map(onlyA.map(f => [dedupKey(f, fields), f]))
  const both = onlyB.filter(f => keyToA.has(dedupKey(f, fields))).map(f => ({ ...f, family: 'both' }))
  const onlyBfinal = onlyB.filter(f => !keyToA.has(dedupKey(f, fields)))
  const onlyAfinal = onlyA.filter(f => !both.some(b => dedupKey(b, fields) === dedupKey(f, fields)))
  return {
    onlyA: onlyAfinal,
    onlyB: onlyBfinal,
    both,
    refuted: []
  }
}

/**
 * Policy B: keep unless explicit refute.
 * Explicit refute only when finding.refutes has target_id + target_family matching an
 * existing finding and reason length ≥ 1. Free-text disagreement without refutes keeps the target.
 * Never throws.
 * @param {unknown} classified
 * @param {unknown} [verdicts]
 * @returns {{ findings: object[], dropped: object[], policy: 'B', ok?: boolean, reason?: string }}
 */
export function finalizeFindings(classified, verdicts = []) {
  if (!classified || typeof classified !== 'object' || Array.isArray(classified)) {
    return { findings: [], dropped: [], policy: 'B', ok: false, reason: 'malformed classified' }
  }

  const onlyA = Array.isArray(classified.onlyA) ? classified.onlyA : []
  const onlyB = Array.isArray(classified.onlyB) ? classified.onlyB : []
  const both = Array.isArray(classified.both) ? classified.both : []
  const agreed = Array.isArray(classified.agreed) ? classified.agreed : []

  /** @type {object[]} */
  const candidates = []
  for (const f of [...onlyA, ...onlyB, ...both, ...agreed]) {
    if (f && typeof f === 'object' && !Array.isArray(f)) candidates.push(f)
  }
  if (Array.isArray(classified.needsCrosscheck)) {
    for (const entry of classified.needsCrosscheck) {
      if (entry && typeof entry === 'object' && entry.issue && typeof entry.issue === 'object') {
        candidates.push(entry.issue)
      }
    }
  }

  // Index by family+id for explicit refute matching
  const byFamilyId = new Map()
  for (const f of candidates) {
    const id = typeof f.id === 'string' ? f.id : ''
    if (!id) continue
    const family = typeof f.family === 'string' ? f.family : ''
    byFamilyId.set(familyIdKey(family, id), f)
  }

  const refutedKeys = new Set()
  /** @type {object[]} */
  const dropped = []

  const markRefuted = (target, refuter, reason) => {
    const id = typeof target.id === 'string' ? target.id : ''
    if (!id) return
    const family = typeof target.family === 'string' ? target.family : ''
    const key = familyIdKey(family, id)
    if (refutedKeys.has(key)) return
    refutedKeys.add(key)
    dropped.push({
      ...target,
      refuted: true,
      refuted_by: refuter,
      refutation: reason
    })
  }

  // Process embedded refutes on findings (Policy B primary path)
  for (const f of candidates) {
    const r = f.refutes
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const targetId = r.target_id
    const targetFamily = r.target_family
    const reason = r.reason
    if (typeof targetId !== 'string' || targetId.length === 0) continue
    if (typeof targetFamily !== 'string' || targetFamily.length === 0) continue
    if (typeof reason !== 'string' || reason.trim().length < 1) continue
    const target = byFamilyId.get(familyIdKey(targetFamily, targetId))
    if (target) {
      markRefuted(target, typeof f.family === 'string' ? f.family : undefined, reason.trim())
    }
  }

  // Optional external verdicts: { target_id, target_family, refuted:true } or { key, refuted:true }
  const verdictList = Array.isArray(verdicts) ? verdicts : []
  for (const v of verdictList) {
    if (!v || typeof v !== 'object' || v.refuted !== true) continue
    if (typeof v.target_id === 'string' && typeof v.target_family === 'string') {
      const target = byFamilyId.get(familyIdKey(v.target_family, v.target_id))
      if (target) {
        markRefuted(target, v.refuter, v.argument || v.reason)
      }
      continue
    }
    if (typeof v.key === 'string') {
      for (const f of candidates) {
        const id = typeof f.id === 'string' ? f.id : ''
        const family = typeof f.family === 'string' ? f.family : ''
        const famKey = familyIdKey(family, id)
        if (v.key === famKey || v.key === dedupKey(f)) {
          markRefuted(f, v.refuter, v.argument || v.reason)
        }
      }
    }
  }

  const findings = candidates.filter(f => {
    const id = typeof f.id === 'string' ? f.id : ''
    if (!id) return true
    const family = typeof f.family === 'string' ? f.family : ''
    return !refutedKeys.has(familyIdKey(family, id))
  })

  return { findings, dropped, policy: 'B' }
}

function familyIdKey(family, id) {
  return `${family}\0${id}`
}

/**
 * @description SECURE|UNSAFE gate from issues. UNSAFE when any issue is critical|high|medium
 * (matches codex / security.md policy). Severity via shared normalizeSeverity. Never throws.
 * @param {unknown} [issues]
 * @returns {'SECURE'|'UNSAFE'}
 */
export function securityVerdict(issues = []) {
  if (issues == null || !Array.isArray(issues)) return 'UNSAFE'
  const blocking = issues.some((i) => {
    if (!i || typeof i !== 'object') return false
    const sev = normalizeSeverity(/** @type {{severity?: unknown}} */ (i).severity).severity
    return sev === 'critical' || sev === 'high' || sev === 'medium'
  })
  return blocking ? 'UNSAFE' : 'SECURE'
}
