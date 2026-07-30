/** @description Optional second-eye policy-B coordinator. The primary verdict remains authoritative. */

import crypto from "node:crypto";
import {
  PLAN_REVIEW_DEDUP_FIELDS,
  classifyFindings,
  dedupKey,
  finalizeFindings,
} from "../../../shared/lib/merge-findings.mjs";
import { mergeVerdicts } from "../../../shared/lib/merge-verdicts.mjs";
import { parseReviewReportText, validateReviewReport } from "../../../shared/lib/review-report-schema.mjs";
import { reviewDispatchFor } from "../../agents/review-catalog.mjs";

/** One batched primary refute-pass per useful second-eye report; never retry it. */
export const REFUTE_PASS_BUDGET = 1;
export const REFUTE_PASS_COUNTER = "refute_pass_attempt_count";
export const REFUTE_PASS_MARKER = "[HARNESS_REFUTE_PASS]";
export const REFUTE_PASS_MARKER_CLOSE = "[/HARNESS_REFUTE_PASS]";

function findingsOf(report, role) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return [];
  const key = role === "plan-reviewer" ? "findings" : "issues";
  return Array.isArray(report[key]) ? report[key] : [];
}

function fieldsFor(role) {
  return role === "plan-reviewer" ? PLAN_REVIEW_DEDUP_FIELDS : undefined;
}

function internalFinding(finding, fields) {
  const identity = dedupKey(finding, fields);
  const id = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return { ...finding, id: `second-eye:${id}` };
}

function canonicalFinding(finding) {
  const { id: _id, family: _family, ...canonical } = finding;
  return canonical;
}

function primaryOnly(primaryResult, reason, extra = {}) {
  return {
    ok: true,
    action: "primary-only",
    result: primaryResult,
    findings: findingsOf(primaryResult, extra.role),
    refute_dispatch: null,
    [REFUTE_PASS_COUNTER]: 0,
    reason,
    ...extra,
  };
}

/**
 * @description Classify two useful eye reports and, when needed, return one batched primary
 * refute-pass descriptor. With no configured second eye this returns the primary object unchanged.
 */
export function prepareSecondEyeAdjudication({ role, routing, primaryResult, secondaryResult, adjudicationContext = {} } = {}) {
  const dispatch = reviewDispatchFor(role, routing);
  if (!dispatch.secondary) {
    return primaryOnly(primaryResult, "second-eye-not-configured", { role, second_eye_configured: false });
  }

  const primary = validateReviewReport(role, primaryResult);
  if (!primary.ok) {
    return { ok: false, action: "primary-failure", result: primaryResult, reason: primary.reason, role };
  }
  const secondary = validateReviewReport(role, secondaryResult);
  if (!secondary.ok) {
    return primaryOnly(primaryResult, "second-eye-failed-open", {
      role,
      second_eye_configured: true,
      secondary_failure: secondary.reason,
    });
  }

  const fields = fieldsFor(role);
  const primaryFindings = uniqueInternalFindings(primary.findings, fields);
  const secondaryFindings = uniqueInternalFindings(secondary.findings, fields);
  const classified = classifyFindings(
    primaryFindings,
    secondaryFindings,
    { a: "primary", b: "secondary" },
    fields,
  );
  const advisoryVerdict = mergeVerdicts(primary.report, secondary.report, {
    primaryFamily: "primary",
    secondaryFamily: "secondary",
  });

  if (classified.onlyB.length === 0) {
    return finalizePrepared({
      role,
      primaryResult,
      primaryReport: primary.report,
      classified,
      advisoryVerdict,
      refutations: [],
      refutePassAttemptCount: 0,
      reason: "no-secondary-only-findings",
    });
  }

  const refutePassId = crypto.createHash("sha256").update(JSON.stringify({
    role,
    finding_ids: classified.onlyB.map((finding) => finding.id).sort(),
    feature_id: adjudicationContext.featureId ?? "",
    epoch: adjudicationContext.epoch ?? 0,
    primary_report_hash: adjudicationContext.primaryReportHash ?? "",
  })).digest("hex");

  return {
    ok: true,
    action: "dispatch-refute",
    role,
    result: primaryResult,
    primary_report: primary.report,
    classified,
    advisory_verdict: advisoryVerdict,
    second_eye_configured: true,
    refute_pass_id: refutePassId,
    adjudication_context: {
      feature_id: adjudicationContext.featureId ?? "",
      epoch: adjudicationContext.epoch ?? 0,
      primary_report_hash: adjudicationContext.primaryReportHash ?? "",
    },
    [REFUTE_PASS_COUNTER]: 0,
    refute_dispatch: {
      subagent_type: dispatch.primary,
      description: `Primary ${role} refutation of second-eye findings`,
      prompt: refutePrompt(role, refutePassId, classified.onlyB),
    },
  };
}

function uniqueInternalFindings(findings, fields) {
  const unique = new Map();
  for (const finding of findings) {
    const internal = internalFinding(finding, fields);
    if (!unique.has(internal.id)) unique.set(internal.id, internal);
  }
  return [...unique.values()];
}

/**
 * @description Fold one primary refute-pass into a prepared policy-B merge. A missing, malformed,
 * or over-budget pass supplies no explicit refutation, so every second-eye-only finding is adopted.
 */
export function finalizeSecondEyeAdjudication(prepared, { refuteResult, refutePassAttemptCount = 1 } = {}) {
  if (!prepared || prepared.action !== "dispatch-refute") return prepared;
  const exhausted = !Number.isInteger(refutePassAttemptCount) || refutePassAttemptCount > REFUTE_PASS_BUDGET;
  const expectedTargetIds = Array.isArray(prepared.classified?.onlyB)
    ? prepared.classified.onlyB.map((finding) => finding?.id).filter(Boolean)
    : [];
  const parsed = exhausted
    ? { ok: false, reason: "refute-pass-budget-exhausted", verdicts: [] }
    : parseRefutations(refuteResult, expectedTargetIds);
  return finalizePrepared({
    role: prepared.role,
    primaryResult: prepared.result,
    primaryReport: prepared.primary_report,
    classified: prepared.classified,
    advisoryVerdict: prepared.advisory_verdict,
    refutations: parsed.ok ? parsed.verdicts : [],
    refutePassAttemptCount: Math.max(0, Number.isInteger(refutePassAttemptCount) ? refutePassAttemptCount : REFUTE_PASS_BUDGET + 1),
    reason: parsed.ok ? "refute-pass-complete" : parsed.reason,
    failSafeAdopted: !parsed.ok,
    budgetExhausted: exhausted,
  });
}

function finalizePrepared({
  role,
  primaryResult,
  primaryReport,
  classified,
  advisoryVerdict,
  refutations,
  refutePassAttemptCount,
  reason,
  failSafeAdopted = false,
  budgetExhausted = false,
}) {
  const merged = finalizeFindings(classified, refutations);
  return {
    ok: merged.ok !== false,
    action: "route-findings",
    role,
    result: primaryResult,
    verdict: role === "plan-reviewer" ? primaryReport.verdict : undefined,
    findings: merged.findings.map(canonicalFinding),
    dropped: merged.dropped.map(canonicalFinding),
    remediation: role === "plan-reviewer" ? "planner" : "sniper",
    advisory_verdict: advisoryVerdict,
    second_eye_configured: true,
    refute_dispatch: null,
    [REFUTE_PASS_COUNTER]: refutePassAttemptCount,
    refute_budget: REFUTE_PASS_BUDGET,
    refute_budget_exhausted: budgetExhausted,
    fail_safe_adopted: failSafeAdopted,
    reason,
  };
}

function parseRefutations(value, expectedTargetIds) {
  if (typeof value === "string") value = parseReviewReportText(value);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["refutations"]) ||
    !Array.isArray(value.refutations)
  ) {
    return { ok: false, reason: "refute-pass-malformed", verdicts: [] };
  }
  const verdicts = [];
  const seen = new Set();
  for (const item of value.refutations) {
    if (
      !item || typeof item !== "object" || Array.isArray(item) ||
      JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["reason", "refuted", "target_id"]) ||
      typeof item.target_id !== "string" || !item.target_id ||
      typeof item.refuted !== "boolean" ||
      typeof item.reason !== "string" || !item.reason.trim() ||
      seen.has(item.target_id)
    ) return { ok: false, reason: "refute-pass-malformed", verdicts: [] };
    seen.add(item.target_id);
    verdicts.push({
      target_id: item.target_id,
      target_family: "secondary",
      refuted: item.refuted,
      reason: item.reason.trim(),
      refuter: "primary",
    });
  }
  if (Array.isArray(expectedTargetIds)) {
    const expected = new Set(expectedTargetIds);
    if (expected.size !== expectedTargetIds.length || seen.size !== expected.size || [...seen].some((id) => !expected.has(id))) {
      return { ok: false, reason: "refute-pass-targets-mismatch", verdicts: [] };
    }
  }
  return { ok: true, verdicts };
}

/** @description Strictly parse the marker that gives a primary dispatch refute-pass accounting. */
export function parseRefutePassIdentity(prompt) {
  if (typeof prompt !== "string") return { ok: false, reason: "refute-pass marker missing" };
  if (
    prompt.split(REFUTE_PASS_MARKER).length - 1 !== 1 ||
    prompt.split(REFUTE_PASS_MARKER_CLOSE).length - 1 !== 1
  ) return { ok: false, reason: "refute-pass marker must appear exactly once" };
  if (!prompt.endsWith(REFUTE_PASS_MARKER_CLOSE)) return { ok: false, reason: "refute-pass marker must terminate the prompt" };
  const end = prompt.length - REFUTE_PASS_MARKER_CLOSE.length;
  const markerStart = prompt.lastIndexOf(REFUTE_PASS_MARKER, end);
  if (markerStart < 0) return { ok: false, reason: "refute-pass marker is incomplete" };
  const start = markerStart + REFUTE_PASS_MARKER.length;
  try {
    const payload = JSON.parse(prompt.slice(start, end));
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1) {
      return { ok: false, reason: "refute-pass marker payload is not canonical" };
    }
    if (typeof payload.refute_id !== "string" || !/^[a-f0-9]{64}$/.test(payload.refute_id)) {
      return { ok: false, reason: "refute-pass id is invalid" };
    }
    return { ok: true, refutePassId: payload.refute_id };
  } catch {
    return { ok: false, reason: "refute-pass marker JSON is malformed" };
  }
}

/** @description Validate the dedicated refute envelope for accounting and finalization. */
export function validateRefutePassResult(value) {
  return parseRefutations(value);
}

function refutePrompt(role, refutePassId, findings) {
  const safeFindings = JSON.stringify(findings)
    .replaceAll(REFUTE_PASS_MARKER, "\\u005bHARNESS_REFUTE_PASS]")
    .replaceAll(REFUTE_PASS_MARKER_CLOSE, "\\u005b/HARNESS_REFUTE_PASS]");
  return [
    `This is the single budgeted refute-pass for a useful optional ${role} second-eye report.`,
    "Inspect the cited repository evidence yourself. Refute a finding only when you can state a concrete contradiction; silence or uncertainty adopts it under policy B.",
    `Second-eye-only findings: ${safeFindings}.`,
    'Return exactly {"refutations":[{"target_id":"second-eye:...","refuted":true|false,"reason":"concrete evidence"}]}, with one entry per supplied finding and no narrative.',
    `${REFUTE_PASS_MARKER}${JSON.stringify({ refute_id: refutePassId })}${REFUTE_PASS_MARKER_CLOSE}`,
  ].join(" ");
}

export default { prepareSecondEyeAdjudication, finalizeSecondEyeAdjudication };
