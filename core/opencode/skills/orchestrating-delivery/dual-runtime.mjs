/**
 * @description Cross-family dual-eye runtime wiring for OC plan-reviewer + adversary.
 * dual_status enum (never bare boolean); secondary failure reason is separate;
 * policy B merge via shared merge-findings / merge-verdicts. Never throws.
 */
import {
  classifyFindings,
  finalizeFindings,
  isRefuteVehicle,
  PLAN_REVIEW_DEDUP_FIELDS,
} from "../../../shared/lib/merge-findings.mjs";
import { mergeVerdicts } from "../../../shared/lib/merge-verdicts.mjs";
import { reviewDispatchFor } from "../../agents/review-catalog.mjs";
import { validateReviewReport } from "../../../shared/lib/review-report-schema.mjs";

/** Locked dual_status enum (07-cross-family). Never store dual_completed: true. */
export const DUAL_STATUS = Object.freeze({
  BOTH: "both",
  PRIMARY_ONLY: "primary_only",
  PRIMARY_ONLY_FAILOPEN: "primary_only_failopen",
  PENDING: "pending",
  PRIMARY_ONLY_ERROR: "primary_only_error",
});

/** Closed set of dual_status values (matches gate-state-shape DUAL_STATUS_VALUES). */
export const DUAL_STATUS_VALUES = Object.freeze(
  new Set([
    DUAL_STATUS.BOTH,
    DUAL_STATUS.PRIMARY_ONLY,
    DUAL_STATUS.PRIMARY_ONLY_FAILOPEN,
    DUAL_STATUS.PENDING,
    DUAL_STATUS.PRIMARY_ONLY_ERROR,
  ]),
);

/** Always-dual posts (ADR-003). */
export const DUAL_POSTS = Object.freeze({
  "plan-reviewer": Object.freeze({
    ...reviewDispatchFor("plan-reviewer"),
    shape: "verdict",
  }),
  adversary: Object.freeze({
    ...reviewDispatchFor("adversary"),
    shape: "findings",
  }),
});

/** primary_only_error retries secondary once (K=1). Auth/unavailable never retries. */
export const PRIMARY_ONLY_ERROR_RETRY_COUNT = 1;

/** Error classes that map to primary_only_failopen (no retry storm). */
export const AUTH_UNAVAILABLE_ERROR_CLASSES = Object.freeze(
  new Set(["auth", "unavailable", "unauthenticated", "not_authenticated", "provider_missing"]),
);

/**
 * @description Whether dual_status counts as full cross-family coverage for metrics.
 * Only `both` is full dual; primary_only_failopen / primary_only_error / pending are not.
 * @param {unknown} dualStatus
 * @returns {boolean}
 */
export function isFullDualCoverage(dualStatus) {
  return dualStatus === DUAL_STATUS.BOTH;
}

/**
 * @description True when value is a valid dual_status enum member (not bare boolean).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDualStatusEnum(value) {
  return typeof value === "string" && DUAL_STATUS_VALUES.has(value);
}

function activeDualStatus(value, secondaryPresent = false) {
  if (value === DUAL_STATUS.BOTH) return DUAL_STATUS.BOTH;
  if (value === DUAL_STATUS.PENDING) return DUAL_STATUS.PENDING;
  return secondaryPresent ? DUAL_STATUS.BOTH : DUAL_STATUS.PRIMARY_ONLY;
}

/**
 * @description Classify secondary failure: auth/unavailable → failopen; else → error (retryable once).
 * Never throws.
 * @param {unknown} errorClass
 * @param {unknown} [reason]
 * @returns {"auth_unavailable" | "infra_error"}
 */
export function classifySecondaryFailure(errorClass, reason) {
  try {
    const cls = String(errorClass ?? "")
      .toLowerCase()
      .trim();
    if (AUTH_UNAVAILABLE_ERROR_CLASSES.has(cls)) return "auth_unavailable";
    const r = String(reason ?? "").toLowerCase();
    if (
      /unauth|not authenticated|login required|provider.*missing|no.*openai|unavailable|not configured/.test(
        r,
      )
    ) {
      return "auth_unavailable";
    }
    return "infra_error";
  } catch {
    return "infra_error";
  }
}

/**
 * @description Build a virgin secondary brief: same contract as primary, never includes peer verdict.
 * Strips primary/peer result fields so the second family cannot anchor on the first.
 * Never throws.
 * @param {unknown} originalBrief
 * @returns {Record<string, unknown>}
 */
export function virginSecondaryBrief(originalBrief) {
  try {
    if (originalBrief == null || typeof originalBrief !== "object" || Array.isArray(originalBrief)) {
      return {};
    }
    const src = /** @type {Record<string, unknown>} */ (originalBrief);
    const out = { ...src };
    // Strip any leaked primary / peer fields (virgin rule).
    delete out.primaryResult;
    delete out.primaryVerdict;
    delete out.primaryFindings;
    delete out.peerResult;
    delete out.peerVerdict;
    delete out.peerFindings;
    delete out.otherFamilyResult;
    delete out.otherFamilyVerdict;
    delete out.otherFamilyFindings;
    delete out.shared_context;
    delete out.complianceOutput;
    delete out.compliance_output;
    return out;
  } catch {
    return {};
  }
}

/**
 * @description Operator-facing fail-open warning (pt-br, product language).
 * @param {string} status
 * @param {string} [reason]
 * @returns {string}
 */
export function dualFailOpenWarning(status, reason = "") {
  const detail = reason ? ` (${reason})` : "";
  if (status === DUAL_STATUS.PRIMARY_ONLY || status === DUAL_STATUS.PRIMARY_ONLY_FAILOPEN) {
    return `Revisão com segundo modelo indisponível${detail}. Seguimos só com a revisão principal — cobertura cruzada não rodou.`;
  }
  return `Segundo modelo falhou após 1 nova tentativa${detail}. Seguimos com a revisão principal — não inventamos achados do segundo modelo.`;
}

/**
 * @description FNV-1a 32-bit hex for stable synthetic finding ids (no crypto import).
 * @param {string} s
 * @returns {string}
 */
function stableHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * @description Normalize a raw eye issue into Finding shape: required `id` + `title`.
 * Missing id → stable hash of content discriminators. Missing title → description.
 * Never invents findings; only shapes existing objects.
 * @param {object} raw
 * @returns {object}
 */
function normalizeToFinding(raw) {
  const f = /** @type {Record<string, unknown>} */ (raw);
  const title =
    typeof f.title === "string" && f.title.trim().length > 0
      ? f.title
      : typeof f.description === "string"
        ? f.description
        : "";
  const severity =
    typeof f.severity === "string" && f.severity.trim().length > 0
      ? f.severity
      : "medium";
  let id = typeof f.id === "string" && f.id.trim().length > 0 ? f.id.trim() : "";
  if (!id) {
    const material = [
      title,
      severity,
      f.scope ?? "",
      f.category ?? "",
      f.evidence ?? "",
      f.description ?? "",
    ]
      .map((x) => String(x).toLowerCase().replace(/\s+/g, " ").trim())
      .join("|");
    id = `h:${stableHash(material)}`;
  }
  return { ...f, id, title, severity };
}

/**
 * @description Extract findings/issues array from an eye result. Never invents items.
 * Each item is normalized to Finding shape (id + title) so merge dedup never collapses
 * distinct description-only highs onto severity alone.
 * @param {unknown} result
 * @returns {object[]}
 */
export function extractFindings(result) {
  try {
    if (!result || typeof result !== "object" || Array.isArray(result)) return [];
    const r = /** @type {Record<string, unknown>} */ (result);
    /** @type {object[]} */
    let raw = [];
    if (Array.isArray(r.findings)) {
      raw = r.findings.filter((f) => f && typeof f === "object" && !Array.isArray(f));
    } else if (Array.isArray(r.issues)) {
      raw = r.issues.filter((f) => f && typeof f === "object" && !Array.isArray(f));
    } else {
      return [];
    }
    return raw.map(normalizeToFinding);
  } catch {
    return [];
  }
}

/**
 * @description Pending dual state before any secondary attempt.
 * @param {unknown} primaryResult
 * @param {{ primaryFamily?: string, post?: string }} [meta]
 * @returns {DualRuntimeResult}
 */
export function pendingDualState(primaryResult, meta = {}) {
  const findings = extractFindings(primaryResult);
  return {
    ok: true,
    dual_status: DUAL_STATUS.PENDING,
    findings,
    dropped: [],
    verdict: primaryResult && typeof primaryResult === "object" ? primaryResult : null,
    secondaryAttempts: 0,
    isFullDualCoverage: false,
    primaryFamily: meta.primaryFamily || "primary",
    secondaryFamily: null,
    post: meta.post || null,
    warning: null,
    reason: "dual required but not yet attempted",
  };
}

/**
 * @description Policy B merge of two families' findings via shared classify + finalize.
 * Unrefuted single-family findings are kept. Never invents findings. Never throws.
 * @param {object[]} primaryFindings
 * @param {object[]} secondaryFindings
 * @param {{ a?: string, b?: string }} [labels]
 * @param {string[]} [fields] - dedup-key field override forwarded to classifyFindings (e.g.
 *   PLAN_REVIEW_DEDUP_FIELDS for the plan-reviewer/verdict shape).
 * @returns {{ findings: object[], dropped: object[], policy: 'B', ok: boolean, reason?: string }}
 */
export function mergeDualFindings(primaryFindings, secondaryFindings, labels = { a: "primary", b: "secondary" }, fields) {
  try {
    const a = Array.isArray(primaryFindings) ? primaryFindings : [];
    const b = Array.isArray(secondaryFindings) ? secondaryFindings : [];
    const classified = classifyFindings(a, b, labels, fields);
    const finalized = finalizeFindings(classified);
    return {
      findings: finalized.findings ?? [],
      dropped: finalized.dropped ?? [],
      policy: "B",
      ok: finalized.ok !== false,
      reason: finalized.reason,
    };
  } catch (err) {
    return {
      findings: Array.isArray(primaryFindings) ? primaryFindings : [],
      dropped: [],
      policy: "B",
      ok: false,
      reason: err instanceof Error ? err.message : "mergeDualFindings failed",
    };
  }
}

/**
 * @description Merge dual verdicts via shared mergeVerdicts; attach dual_status.
 * Never throws.
 * @param {unknown} primary
 * @param {unknown} secondary
 * @param {{ primaryFamily?: string, secondaryFamily?: string, dual_status?: string }} [meta]
 * @returns {Record<string, unknown>}
 */
export function mergeDualVerdicts(primary, secondary, meta = {}) {
  try {
    const merged = mergeVerdicts(primary, secondary, {
      primaryFamily: meta.primaryFamily || "primary",
      secondaryFamily: meta.secondaryFamily || "secondary",
    });
    if (!merged || merged.ok === false) {
      return {
        ok: false,
        reason: merged?.reason || "mergeVerdicts failed",
        dual_status: secondary
          ? DUAL_STATUS.BOTH
          : DUAL_STATUS.PRIMARY_ONLY,
        issues: [],
        isFullDualCoverage: false,
      };
    }
    const dual_status = activeDualStatus(
      meta.dual_status && isDualStatusEnum(meta.dual_status)
        ? meta.dual_status
        : secondary
          ? DUAL_STATUS.BOTH
          : DUAL_STATUS.PRIMARY_ONLY,
      Boolean(secondary),
    );
    return {
      ...merged,
      dual_status,
      isFullDualCoverage: isFullDualCoverage(dual_status),
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "mergeDualVerdicts failed",
      dual_status: DUAL_STATUS.PRIMARY_ONLY,
      issues: [],
      isFullDualCoverage: false,
    };
  }
}

/**
 * @typedef {object} SecondaryAttemptResult
 * @property {boolean} ok - true when secondary returned a usable result
 * @property {object} [result] - structured eye output (findings/issues/verdict)
 * @property {string} [errorClass] - auth | unavailable | rate_limit | crash | 5xx | ...
 * @property {string} [reason] - human-readable failure reason
 */

/**
 * @typedef {object} DualRuntimeResult
 * @property {boolean} ok
 * @property {string} dual_status - enum member only
 * @property {object[]} findings
 * @property {object[]} dropped
 * @property {unknown} verdict
 * @property {number} secondaryAttempts
 * @property {boolean} isFullDualCoverage
 * @property {string|null} warning - pt-br operator warning when fail-open
 * @property {string} [reason]
 * @property {string} [primaryFamily]
 * @property {string|null} [secondaryFamily]
 * @property {string|null} [post]
 * @property {string} [errorClass]
 */

/**
 * @description Drive dual-eye for a requireDualOn post after primary has returned.
 * Injectable runSecondary for unit tests (no live provider). Never throws.
 * Never invents secondary findings. Auth/unavailable → primary_only_failopen (no retry).
 * Infra error → primary_only_error, retry secondary once (K=1), then fail-open with primary only.
 *
 * @param {{
 *   post: 'plan-reviewer' | 'adversary' | string,
 *   primaryResult: unknown,
 *   runSecondary: (ctx: { attempt: number, brief: Record<string, unknown> }) => SecondaryAttemptResult,
 *   originalBrief?: unknown,
 *   primaryFamily?: string,
 *   secondaryFamily?: string,
 *   maxRetries?: number,
 * }} opts
 * @returns {DualRuntimeResult}
 */
export function driveDualEye(opts) {
  try {
    const {
      post,
      primaryResult,
      runSecondary,
      originalBrief = {},
      primaryFamily = "primary",
      secondaryFamily = "secondary",
      maxRetries = PRIMARY_ONLY_ERROR_RETRY_COUNT,
    } = opts ?? {};

    const postCfg = DUAL_POSTS[post] || null;
    const primaryValidation = validateReviewReport(post, primaryResult);
    if (!postCfg || !primaryValidation.ok) {
      return {
        ok: false,
        dual_status: DUAL_STATUS.PENDING,
        findings: [],
        dropped: [],
        verdict: null,
        secondaryAttempts: 0,
        isFullDualCoverage: false,
        warning: null,
        reason: primaryValidation.reason || "unknown dual post",
        primary_status: "failed",
        primary_failure_class: "malformed",
        primaryFamily,
        secondaryFamily: null,
        post: post ?? null,
      };
    }

    if (typeof runSecondary !== "function") {
      return {
        ok: false,
        dual_status: DUAL_STATUS.PRIMARY_ONLY,
        findings: extractFindings(primaryResult),
        dropped: [],
        verdict: primaryResult && typeof primaryResult === "object" ? primaryResult : null,
        secondaryAttempts: 0,
        isFullDualCoverage: false,
        warning: dualFailOpenWarning(DUAL_STATUS.PRIMARY_ONLY, "runSecondary missing"),
        secondary_status: "missing",
        secondary_failure_class: "configuration",
        reason: "runSecondary is required",
        primaryFamily,
        secondaryFamily: null,
        post: post ?? null,
      };
    }

    const shape = postCfg?.shape || "findings";
    const brief = virginSecondaryBrief(originalBrief);
    const primaryFindings = extractFindings(primaryResult);

    /** @type {SecondaryAttemptResult | null} */
    let last = null;
    let attempts = 0;
    const maxAttempts = 1 + Math.max(0, Number(maxRetries) || 0);

    while (attempts < maxAttempts) {
      attempts += 1;
      let attemptResult;
      try {
        attemptResult = runSecondary({ attempt: attempts, brief });
      } catch (err) {
        attemptResult = {
          ok: false,
          errorClass: "crash",
          reason: err instanceof Error ? err.message : "secondary threw",
        };
      }

      last = attemptResult && typeof attemptResult === "object" ? attemptResult : {
        ok: false,
        errorClass: "crash",
        reason: "secondary returned non-object",
      };

      if (last.ok === true && last.result != null && typeof last.result === "object") {
        const secondaryValidation = validateReviewReport(post, last.result);
        if (!secondaryValidation.ok) {
          return primaryOnlyResult({
            dual_status: DUAL_STATUS.PRIMARY_ONLY,
            primaryResult,
            primaryFindings,
            primaryFamily,
            secondaryAttempts: attempts,
            post: post ?? null,
            errorClass: "malformed",
            reason: secondaryValidation.reason,
          });
        }
        // Success path → both + merge
        return finalizeBoth({
          shape,
          primaryResult,
          secondaryResult: last.result,
          primaryFindings,
          primaryFamily,
          secondaryFamily,
          secondaryAttempts: attempts,
          post: post ?? null,
        });
      }

      const failureKind = classifySecondaryFailure(last.errorClass, last.reason);

      // Auth / unavailable: fail-open immediately, no retry storm
      if (failureKind === "auth_unavailable") {
        return primaryOnlyResult({
          dual_status: DUAL_STATUS.PRIMARY_ONLY,
          primaryResult,
          primaryFindings,
          primaryFamily,
          secondaryAttempts: attempts,
          post: post ?? null,
          errorClass: last.errorClass,
          reason: last.reason || "secondary auth/unavailable",
        });
      }

      // Infra error: allow one retry (K=1); if more attempts remain, loop
      if (attempts < maxAttempts) {
        continue;
      }

      // Exhausted retries → primary_only_error, keep primary only, never invent
      return primaryOnlyResult({
        dual_status: DUAL_STATUS.PRIMARY_ONLY,
        primaryResult,
        primaryFindings,
        primaryFamily,
        secondaryAttempts: attempts,
        post: post ?? null,
        errorClass: last.errorClass,
        reason: last.reason || "secondary infra error after retry",
      });
    }

    // Defensive fallback (should not reach)
    return primaryOnlyResult({
      dual_status: DUAL_STATUS.PRIMARY_ONLY,
      primaryResult,
      primaryFindings,
      primaryFamily,
      secondaryAttempts: attempts,
      post: post ?? null,
      errorClass: last?.errorClass,
      reason: last?.reason || "secondary failed",
    });
  } catch (err) {
    return {
      ok: false,
      dual_status: DUAL_STATUS.PRIMARY_ONLY,
      findings: extractFindings(opts?.primaryResult),
      dropped: [],
      verdict: null,
      secondaryAttempts: 0,
      isFullDualCoverage: false,
      warning: dualFailOpenWarning(
        DUAL_STATUS.PRIMARY_ONLY,
        err instanceof Error ? err.message : "driveDualEye failed",
      ),
      reason: err instanceof Error ? err.message : "driveDualEye failed",
      primaryFamily: opts?.primaryFamily || "primary",
      secondaryFamily: null,
      post: opts?.post ?? null,
    };
  }
}

/**
 * @param {{
 *   shape: string,
 *   primaryResult: unknown,
 *   secondaryResult: object,
 *   primaryFindings: object[],
 *   primaryFamily: string,
 *   secondaryFamily: string,
 *   secondaryAttempts: number,
 *   post: string|null,
 * }} args
 * @returns {DualRuntimeResult}
 */
function finalizeBoth(args) {
  const {
    shape,
    primaryResult,
    secondaryResult,
    primaryFindings,
    primaryFamily,
    secondaryFamily,
    secondaryAttempts,
    post,
  } = args;

  if (shape === "verdict") {
    const merged = mergeDualVerdicts(primaryResult, secondaryResult, {
      primaryFamily,
      secondaryFamily,
      dual_status: DUAL_STATUS.BOTH,
    });
    const findings = [
      ...extractFindings(primaryResult),
      ...extractFindings(secondaryResult),
    ];
    // Policy B on any issues carried in verdicts. plan-reviewer findings have no
    // id/title/description (closed schema), so the dedup key must use the plan-review
    // fields override — otherwise distinct findings of equal severity collapse together.
    const mergedFindings = mergeDualFindings(
      extractFindings(primaryResult),
      extractFindings(secondaryResult),
      { a: primaryFamily, b: secondaryFamily },
      PLAN_REVIEW_DEDUP_FIELDS,
    );
    const kept = mergedFindings.findings;
    // Either-REVISE-wins + non-refuted issues → top-level blocking REVISE for orchestrator
    const nonRefuted = kept.filter(
      (f) =>
        f &&
        typeof f === "object" &&
        /** @type {{refuted?: unknown, refutes?: unknown}} */ (f).refuted !== true &&
        !isRefuteVehicle(f),
    );
    const blocking =
      (primaryResult?.verdict === "REVISE" || secondaryResult?.verdict === "REVISE") || nonRefuted.length > 0 ? "REVISE" : "APPROVE";
    return {
      ok: merged.ok !== false,
      dual_status: DUAL_STATUS.BOTH,
      findings: kept,
      dropped: mergedFindings.dropped,
      verdict: { ...merged, verdict: blocking },
      secondaryAttempts,
      isFullDualCoverage: true,
      warning: null,
      reason: undefined,
      primaryFamily,
      secondaryFamily,
      post,
    };
  }

  const secondaryFindings = extractFindings(secondaryResult);
  const mergedFindings = mergeDualFindings(primaryFindings, secondaryFindings, {
    a: primaryFamily,
    b: secondaryFamily,
  });
  // Non-refuted findings after policy B → blocking REVISE so orchestrator cannot miss them
  const nonRefuted = (mergedFindings.findings ?? []).filter(
    (f) =>
      f &&
      typeof f === "object" &&
      /** @type {{refuted?: unknown, refutes?: unknown}} */ (f).refuted !== true &&
      !isRefuteVehicle(f),
  );
  const blockingVerdict =
    nonRefuted.length > 0 ? { verdict: "REVISE", issues: nonRefuted } : null;
  return {
    ok: mergedFindings.ok !== false,
    dual_status: DUAL_STATUS.BOTH,
    findings: mergedFindings.findings,
    dropped: mergedFindings.dropped,
    verdict: blockingVerdict,
    secondaryAttempts,
    isFullDualCoverage: true,
    warning: null,
    reason: undefined,
    primaryFamily,
    secondaryFamily,
    post,
  };
}

/**
 * @param {{
 *   dual_status: string,
 *   primaryResult: unknown,
 *   primaryFindings: object[],
 *   primaryFamily: string,
 *   secondaryAttempts: number,
 *   post: string|null,
 *   errorClass?: string,
 *   reason?: string,
 * }} args
 * @returns {DualRuntimeResult}
 */
function primaryOnlyResult(args) {
  const {
    dual_status,
    primaryResult,
    primaryFindings,
    primaryFamily,
    secondaryAttempts,
    post,
    errorClass,
    reason,
  } = args;

  // Tag primary findings with family; never invent secondary
  const findings = primaryFindings.map((f) =>
    f && typeof f === "object" ? { ...f, family: f.family || primaryFamily } : f,
  );

  return {
    ok: true,
    dual_status,
    findings,
    dropped: [],
    verdict: primaryResult && typeof primaryResult === "object" ? primaryResult : null,
    secondaryAttempts,
    isFullDualCoverage: false,
    warning: dualFailOpenWarning(
      dual_status,
      reason,
    ),
    reason,
    primaryFamily,
    secondaryFamily: null,
    secondary_status: classifySecondaryFailure(errorClass, reason) === "auth_unavailable" ? "unavailable" : "failed",
    secondary_failure_class: errorClass || "unknown",
    post,
    errorClass,
  };
}

/**
 * @description Gate-state patch fragment for dual_status (enum only). Never bare boolean.
 * @param {string} dualStatus
 * @param {{ errorClass?: string, secondaryAttempts?: number }} [extra]
 * @returns {{ dual_status: string, dual_error_class?: string, dual_secondary_attempts?: number } | { ok: false, reason: string }}
 */
export function dualStatusGatePatch(dualStatus, extra = {}) {
  try {
    if (!isDualStatusEnum(dualStatus)) {
      return { ok: false, reason: `invalid dual_status: ${String(dualStatus)}` };
    }
    /** @type {{ dual_status: string, dual_error_class?: string, dual_secondary_attempts?: number }} */
    const patch = { dual_status: dualStatus };
    if (extra.errorClass != null) patch.dual_error_class = String(extra.errorClass);
    if (extra.secondaryAttempts != null) {
      patch.dual_secondary_attempts = Number(extra.secondaryAttempts) || 0;
    }
    return patch;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "dualStatusGatePatch failed",
    };
  }
}
