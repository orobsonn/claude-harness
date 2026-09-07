/** @description Family-agnostic verdict merge. Active coverage is both, primary_only, or pending. */
const DUAL_STATUS_ENUM = new Set([
  'both',
  'primary_only',
  'primary_only_failopen',
  'pending',
  'primary_only_error',
])

/**
 * @description Normalize to APPROVE | REVISE (unknown/missing → REVISE, conservative).
 * @param {unknown} v
 * @returns {'APPROVE' | 'REVISE'}
 */
function normVerdict(v) {
  const s = String(v ?? '').trim().toUpperCase()
  return s === 'APPROVE' ? 'APPROVE' : 'REVISE'
}

/**
 * @description Non-refuted issues/findings on a side (refuted:true dropped).
 * @param {unknown} side
 * @returns {object[]}
 */
function nonRefutedIssues(side) {
  if (!side || typeof side !== 'object' || Array.isArray(side)) return []
  const r = /** @type {Record<string, unknown>} */ (side)
  const raw = Array.isArray(r.issues)
    ? r.issues
    : Array.isArray(r.findings)
      ? r.findings
      : []
  return raw.filter(
    (i) => i && typeof i === 'object' && !Array.isArray(i) && /** @type {{refuted?: unknown}} */ (i).refuted !== true,
  )
}

/**
 * @param {unknown} primary
 * @param {unknown} secondary
 * @param {{ primaryFamily?: string, secondaryFamily?: string, dual_status?: string }} [meta]
 * @returns {{ ok: boolean, reason?: string, verdict?: 'APPROVE'|'REVISE', issues?: unknown[], merged?: boolean, primary?: object, secondary?: object|null, dual_status?: string }}
 */
export function mergeVerdicts(primary, secondary, meta = {}) {
  try {
    if (!primary || typeof primary !== 'object' || Array.isArray(primary)) {
      return { ok: false, reason: 'malformed primary', issues: [], verdict: 'REVISE' }
    }
    if (secondary != null && (typeof secondary !== 'object' || Array.isArray(secondary))) {
      return { ok: false, reason: 'malformed secondary', issues: [], verdict: 'REVISE' }
    }
    // family-agnostic: use labels from meta or generic
    const familyA = meta.primaryFamily || 'primary'
    const familyB = meta.secondaryFamily || 'secondary'
    let dual_status =
      typeof meta.dual_status === 'string' && DUAL_STATUS_ENUM.has(meta.dual_status)
        ? meta.dual_status
        : secondary
          ? 'both'
          : 'primary_only'
    // Never accept bare boolean dual flags from callers
    if (typeof dual_status !== 'string' || !DUAL_STATUS_ENUM.has(dual_status)) {
      dual_status = secondary ? 'both' : 'primary_only'
    }
    if (dual_status === 'primary_only_failopen' || dual_status === 'primary_only_error') dual_status = 'primary_only'

    // Either-REVISE-wins: if either family says REVISE, merged is REVISE.
    // Fail-open (secondary null): primary only — never a spurious REVISE from a missing second opinion.
    const primaryV = normVerdict(/** @type {{verdict?: unknown}} */ (primary).verdict)
    const secondaryV = secondary
      ? normVerdict(/** @type {{verdict?: unknown}} */ (secondary).verdict)
      : null
    const primaryIssues = nonRefutedIssues(primary)
    const secondaryIssues = secondary ? nonRefutedIssues(secondary) : []
    const issues = [...primaryIssues, ...secondaryIssues]

    let verdict = /** @type {'APPROVE' | 'REVISE'} */ ('APPROVE')
    if (secondary == null) {
      // primary-only fail-open path
      verdict =
        primaryV === 'REVISE' || primaryIssues.length > 0 ? 'REVISE' : 'APPROVE'
    } else if (
      primaryV === 'REVISE' ||
      secondaryV === 'REVISE' ||
      issues.length > 0
    ) {
      verdict = 'REVISE'
    }

    return {
      ok: true,
      merged: true,
      verdict,
      issues,
      primary: { ...primary, family: familyA },
      secondary: secondary ? { ...secondary, family: familyB } : null,
      dual_status,
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'mergeVerdicts failed',
      issues: [],
      verdict: 'REVISE',
      dual_status: 'primary_only',
    }
  }
}
