/**
 * Small, pure Codex adapters for three critical contracts: advisory complexity,
 * strict eye output, and conservative verdict merge. They do not retain state
 * or dispatch agents; callers must still explicitly apply the model route.
 */

export function scoreFile(sourceText, pathHint) {
  if (typeof sourceText !== "string") return { ok: false, reason: "sourceText must be string" };
  if (!sourceText.trim()) return { ok: true, score: 0, band: "low", signals: { lines: 0, empty: true } };
  const lines = sourceText.split(/\r?\n/);
  const codeLines = lines.filter((line) => line.trim() && !line.trim().startsWith("//") && !line.trim().startsWith("/*")).length;
  const imports = (sourceText.match(/^import /gm) || []).length;
  const awaits = (sourceText.match(/\bawait\b/g) || []).length;
  const branches = (sourceText.match(/\b(if|for|while|switch)\b/g) || []).length;
  const complexHits = ["reducer", "parser", "middleware", "validator", "state machine"]
    .filter((word) => new RegExp(word, "i").test(sourceText)).length;
  let score = Math.floor(codeLines / 50) + Math.min(imports, 6) + awaits + branches + Math.min(complexHits * 3, 9);
  if (/\/(lib|shared|hooks)\//.test(String(pathHint ?? ""))) score += 3;
  const band = codeLines > 400 || score > 60 ? "split" : score > 45 ? "max" : score > 30 ? "high" : score > 10 ? "medium" : "low";
  return { ok: true, score, band, signals: { code_lines: codeLines, imports, awaits, branches, complex_hits: complexHits, ...(pathHint ? { path_hint: pathHint } : {}) } };
}

const PLAN_AREAS = new Set(["decomposition", "judgment", "locked-test", "scope", "model-routing", "introduced-risk"]);
const ADVERSARY_CATEGORIES = new Set(["orphan-state", "idempotency", "race", "determinism", "locked-decision", "boundary", "auth", "injection", "secret-leak", "cost-scale", "other"]);
const SEVERITIES = new Set(["low", "medium", "high"]);
const plain = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const nonEmpty = (value, keys) => keys.every((key) => typeof value[key] === "string" && value[key].trim());
const exactKeys = (value, keys) => Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

/** Extract the first complete object from plain text or a fenced JSON response. */
export function parseReviewReportText(source) {
  if (typeof source !== "string" || !source.trim()) return null;
  const candidates = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  candidates.push(source);
  for (const candidate of candidates) {
    let start = -1; let depth = 0; let quoted = false; let escaped = false;
    for (let index = 0; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; continue; }
      if (character === '"') quoted = true;
      else if (character === "{") { if (depth === 0) start = index; depth += 1; }
      else if (character === "}" && depth > 0 && --depth === 0 && start >= 0) {
        try { const parsed = JSON.parse(candidate.slice(start, index + 1)); if (plain(parsed)) return parsed; } catch { /* try next object */ }
        start = -1;
      }
    }
  }
  return null;
}

function validatePlanFinding(value) {
  const keys = ["area", "severity", "task_id", "problem", "planner_instruction"];
  const finding = plain(value);
  return Boolean(finding && exactKeys(finding, keys) && nonEmpty(finding, keys) && PLAN_AREAS.has(finding.area) && SEVERITIES.has(finding.severity) && (finding.task_id === "(plan-wide)" || /^task-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(finding.task_id)));
}

function normalizeAdversaryFinding(value) {
  const original = plain(value);
  if (!original) return null;
  const { suggested_sniper_tier: _legacy, ...finding } = original;
  const keys = ["description", "category", "severity", "scope", "evidence", "fix_hint"];
  return exactKeys(finding, keys) && nonEmpty(finding, keys) && ADVERSARY_CATEGORIES.has(finding.category) && SEVERITIES.has(finding.severity) ? finding : null;
}

/** Validate only the two logical eye formats supported by the Codex delivery skill. */
export function validateReviewReport(role, value) {
  const original = plain(value);
  if (!original) return { ok: false, reason: "report must be an object" };
  const { family: _legacy, ...report } = original;
  if (role === "plan-reviewer") {
    if (!exactKeys(report, ["verdict", "findings"]) || !["APPROVE", "REVISE"].includes(report.verdict) || !Array.isArray(report.findings) || !report.findings.every(validatePlanFinding)) return { ok: false, reason: "plan-reviewer report is not canonical" };
    if (report.verdict === "REVISE" && report.findings.length === 0) return { ok: false, reason: "REVISE requires findings" };
    return { ok: true, report, findings: report.findings };
  }
  if (role === "adversary") {
    if (!exactKeys(report, ["issues"]) || !Array.isArray(report.issues)) return { ok: false, reason: "adversary report is not canonical" };
    const issues = report.issues.map(normalizeAdversaryFinding);
    if (issues.some((issue) => !issue)) return { ok: false, reason: "adversary finding is not canonical" };
    return { ok: true, report: { issues }, findings: issues.map((issue) => ({ ...issue, suggested_sniper_tier: `sniper-${issue.severity}` })) };
  }
  return { ok: false, reason: "unknown review role" };
}

/** Conservative merge: malformed input or any live issue yields REVISE. */
export function mergeVerdicts(primary, secondary, meta = {}) {
  try {
    if (!plain(primary) || (secondary !== null && secondary !== undefined && !plain(secondary))) return { ok: false, reason: "malformed review", issues: [], verdict: "REVISE" };
    const rawIssues = (side) => Array.isArray(side?.issues) ? side.issues : Array.isArray(side?.findings) ? side.findings : [];
    if ([primary, secondary].filter(Boolean).some((side) => rawIssues(side).some((item) => !plain(item)))) {
      return { ok: false, reason: "malformed finding", issues: [], verdict: "REVISE" };
    }
    const issues = (side) => rawIssues(side).filter((item) => item.refuted !== true);
    const primaryIssues = issues(primary); const secondaryIssues = secondary ? issues(secondary) : [];
    const norm = (verdict) => String(verdict ?? "").trim().toUpperCase() === "APPROVE" ? "APPROVE" : "REVISE";
    const verdict = norm(primary.verdict) === "REVISE" || (secondary && norm(secondary.verdict) === "REVISE") || primaryIssues.length || secondaryIssues.length ? "REVISE" : "APPROVE";
    return { ok: true, merged: true, verdict, issues: [...primaryIssues, ...secondaryIssues], primary: { ...primary, family: meta.primaryFamily || "primary" }, secondary: secondary ? { ...secondary, family: meta.secondaryFamily || "secondary" } : null, dual_status: secondary ? "both" : "primary_only" };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "merge failed", issues: [], verdict: "REVISE" }; }
}
