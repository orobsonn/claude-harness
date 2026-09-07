/** @description Canonical executable schemas for provider-agnostic review-agent reports. */

export const PLAN_REVIEW_VERDICTS = Object.freeze(new Set(["APPROVE", "REVISE"]));
export const PLAN_REVIEW_AREAS = Object.freeze(new Set([
  "decomposition",
  "judgment",
  "locked-test",
  "scope",
  "model-routing",
  "introduced-risk",
]));
export const ADVERSARY_CATEGORIES = Object.freeze(new Set([
  "orphan-state",
  "idempotency",
  "race",
  "determinism",
  "locked-decision",
  "boundary",
  "auth",
  "injection",
  "secret-leak",
  "cost-scale",
  "other",
]));
export const REVIEW_SEVERITIES = Object.freeze(new Set(["low", "medium", "high"]));

const PLAN_FINDING_KEYS = Object.freeze(["area", "severity", "task_id", "problem", "planner_instruction"]);
const ADVERSARY_FINDING_KEYS = Object.freeze([
  "description",
  "category",
  "severity",
  "scope",
  "evidence",
  "fix_hint",
]);

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => keys[index] === [...expected].sort()[index]);
}

function nonEmptyStrings(value, keys) {
  return keys.every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

/** @description Extract the first complete JSON object from a strict report plus optional trailing narrative. */
export function parseReviewReportText(source) {
  if (typeof source !== "string" || !source.trim()) return null;
  const candidates = [];
  for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1]);
  candidates.push(source);
  for (const candidate of candidates) {
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") {
        if (depth === 0) start = index;
        depth += 1;
      } else if (char === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            const parsed = JSON.parse(candidate.slice(start, index + 1));
            if (plain(parsed)) return parsed;
          } catch {
            // Continue to another complete object.
          }
          start = -1;
        }
      }
    }
  }
  return null;
}

export function validatePlanReviewFinding(value) {
  const finding = plain(value);
  if (!finding || !exactKeys(finding, PLAN_FINDING_KEYS) || !nonEmptyStrings(finding, PLAN_FINDING_KEYS)) return false;
  if (!PLAN_REVIEW_AREAS.has(finding.area) || !REVIEW_SEVERITIES.has(finding.severity)) return false;
  return finding.task_id === "(plan-wide)" || /^task-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(finding.task_id);
}

/**
 * @description The sniper tier is DERIVED from severity, never trusted from the report.
 * It carries no information the report does not already state. The eye judges severity; routing
 * derives the tier. Legacy reports that still echo a tier are accepted and canonicalized below.
 */
export function normalizedSniperTier(severity) {
  return REVIEW_SEVERITIES.has(severity) ? `sniper-${severity}` : null;
}

/** @description Remove the former derived tier before validating the canonical report shape. */
function withoutLegacySuggestedSniperTier(finding) {
  if (!Object.hasOwn(finding, "suggested_sniper_tier")) return finding;
  const { suggested_sniper_tier: _legacy, ...rest } = finding;
  return rest;
}

function normalizeAdversaryFinding(value) {
  const finding = plain(value);
  const canonical = finding && withoutLegacySuggestedSniperTier(finding);
  if (!canonical || !exactKeys(canonical, ADVERSARY_FINDING_KEYS) || !nonEmptyStrings(canonical, ADVERSARY_FINDING_KEYS)) return null;
  if (!ADVERSARY_CATEGORIES.has(canonical.category) || !REVIEW_SEVERITIES.has(canonical.severity)) return null;
  return canonical;
}

export function validateAdversaryFinding(value) {
  return Boolean(normalizeAdversaryFinding(value));
}

/** @description Strip legacy dual-family marker before canonical key checks (ignored, never required). */
function withoutLegacyFamily(report) {
  if (!Object.hasOwn(report, "family")) return report;
  const { family: _legacy, ...rest } = report;
  return rest;
}

/** @description Validate one strict report against its logical role contract. */
export function validateReviewReport(logicalRole, value) {
  const report = plain(value);
  if (!report) return { ok: false, reason: "report must be an object" };
  const body = withoutLegacyFamily(report);
  if (logicalRole === "plan-reviewer") {
    if (!exactKeys(body, ["verdict", "findings"])) return { ok: false, reason: "plan-reviewer report keys are not canonical" };
    if (!PLAN_REVIEW_VERDICTS.has(body.verdict)) return { ok: false, reason: "plan-reviewer verdict is not canonical" };
    if (!Array.isArray(body.findings) || !body.findings.every(validatePlanReviewFinding)) {
      return { ok: false, reason: "plan-reviewer finding is not canonical" };
    }
    if (body.verdict === "REVISE" && body.findings.length === 0) return { ok: false, reason: "REVISE requires findings" };
    return { ok: true, report: body, findings: body.findings };
  }
  if (logicalRole === "adversary") {
    if (!exactKeys(body, ["issues"])) return { ok: false, reason: "adversary report keys are not canonical" };
    const issues = Array.isArray(body.issues) ? body.issues.map(normalizeAdversaryFinding) : null;
    if (!issues || issues.some((issue) => !issue)) {
      return { ok: false, reason: "adversary finding is not canonical" };
    }
    return {
      ok: true,
      report: { ...body, issues },
      findings: issues.map((issue) => ({ ...issue, suggested_sniper_tier: normalizedSniperTier(issue.severity) })),
    };
  }
  return { ok: false, reason: "unknown review role" };
}

export default { parseReviewReportText, validateReviewReport, validatePlanReviewFinding, validateAdversaryFinding, normalizedSniperTier };
