/** @description Severity normalization, ranking and max for family-agnostic findings. Never throws. */
export function normalizeSeverity(s) {
  if (typeof s !== 'string') return { severity: 'medium', invalid: true }
  const v = s.toLowerCase().trim()
  if (['low', 'medium', 'high', 'critical'].includes(v)) return { severity: v }
  return { severity: 'medium', invalid: true }
}

export function severityRank(s) {
  const norm = normalizeSeverity(s)
  const ranks = { low: 1, medium: 2, high: 3, critical: 4 }
  return ranks[norm.severity] || 2
}

export function maxSeverity(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  return list.reduce((max, cur) => severityRank(cur) > severityRank(max) ? cur : max, list[0])
}
