/** @description Pure complexity scorer for OC port (T5b). Dependency-free heuristic scoring of source text for task complexity band routing. Returns {ok, score, band, signals} or {ok:false, reason}. Never throws. Bands per 03 contract: low 0-10, medium 11-30, high 31-45, max 46-60, split 61+. */
export function scoreFile(sourceText, pathHint) {
  if (typeof sourceText !== "string") {
    return { ok: false, reason: "sourceText must be string" }
  }
  if (!sourceText.trim()) {
    return { ok: true, score: 0, band: "low", signals: { lines: 0, empty: true } }
  }

  const lines = sourceText.split(/\r?\n/)
  const codeLines = lines.filter(l => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).length

  // simple heuristics (adapted, pure, no fs)
  let score = Math.floor(codeLines / 50) // LINES_PER_POINT ~50

  const importCount = (sourceText.match(/^import /gm) || []).length
  score += Math.min(importCount, 6)

  const awaitCount = (sourceText.match(/\bawait\b/g) || []).length
  score += awaitCount

  const branchCount = (sourceText.match(/\b(if|for|while|switch)\b/g) || []).length
  score += branchCount

  // complex patterns
  const complexPatterns = ["reducer", "parser", "middleware", "validator", "state machine"]
  let complexHits = 0
  for (const p of complexPatterns) {
    if (new RegExp(p, "i").test(sourceText)) complexHits++
  }
  score += Math.min(complexHits * 3, 9)

  // location signals
  const signals = {
    code_lines: codeLines,
    imports: importCount,
    awaits: awaitCount,
    branches: branchCount,
    complex_hits: complexHits,
  }
  if (pathHint) {
    signals.path_hint = pathHint
    if (/\/(lib|shared|hooks)\//.test(pathHint)) score += 3
  }

  let band
  if (score <= 10) band = "low"
  else if (score <= 30) band = "medium"
  else if (score <= 45) band = "high"
  else if (score <= 60) band = "max"
  else band = "split"

  if (codeLines > 400) band = "split"

  return { ok: true, score, band, signals }
}
