/**
 * @description Host-path dual-eye merge finalize (issue #384).
 * Reuses driveDualEye / merge policy from dual-runtime — never invents a second policy.
 * Writes deterministic merge artifact under ceremony state. Never throws.
 */
import fs from "node:fs";
import path from "node:path";
import {
  driveDualEye,
  mergeDualVerdicts,
  mergeDualFindings,
  extractFindings,
  DUAL_STATUS,
} from "../../skills/orchestrating-delivery/dual-runtime.mjs";
import { gateStateDir } from "../../../shared/lib/path-helpers.mjs";
import {
  dualStatusPhaseFromRole,
  normalizeDualStatusMap,
} from "../../../shared/lib/gate-state-shape.mjs";

export {
  driveDualEye,
  mergeDualVerdicts,
  mergeDualFindings,
  extractFindings,
  DUAL_STATUS,
};

/**
 * @description Map dual phase axis → dual-runtime post key.
 * @param {"plan_review" | "adversary" | string} phase
 * @returns {"plan-reviewer" | "adversary" | null}
 */
export function postForDualPhase(phase) {
  if (phase === "plan_review") return "plan-reviewer";
  if (phase === "adversary") return "adversary";
  return null;
}

/**
 * @description Pure host merge: both reports already useful; secondary injected via driveDualEye.
 * Never invents secondary findings. Never throws.
 * @param {{
 *   phase: "plan_review" | "adversary" | string,
 *   primaryReport: unknown,
 *   secondaryReport: unknown,
 *   primaryFamily?: string,
 *   secondaryFamily?: string,
 * }} opts
 * @returns {{ ok: boolean, dual_status?: string, verdict?: string|null, findings?: object[], reason?: string, drive?: object }}
 */
export function mergeHostDualEyes(opts = {}) {
  try {
    const phase = opts.phase;
    const post = postForDualPhase(phase);
    if (!post) {
      return { ok: false, reason: `unknown dual phase: ${String(phase)}` };
    }
    if (!opts.primaryReport || typeof opts.primaryReport !== "object" || Array.isArray(opts.primaryReport)) {
      return { ok: false, reason: "malformed primary report" };
    }
    if (!opts.secondaryReport || typeof opts.secondaryReport !== "object" || Array.isArray(opts.secondaryReport)) {
      return { ok: false, reason: "malformed secondary report" };
    }
    const drive = driveDualEye({
      post,
      primaryResult: opts.primaryReport,
      primaryFamily: opts.primaryFamily || "family-1",
      secondaryFamily: opts.secondaryFamily || "family-2",
      runSecondary: () => ({ ok: true, result: opts.secondaryReport }),
    });
    if (!drive || drive.dual_status !== DUAL_STATUS.BOTH) {
      return {
        ok: false,
        reason: drive?.reason || "driveDualEye did not produce both",
        dual_status: drive?.dual_status,
        drive,
      };
    }
    const verdictRaw =
      drive.verdict && typeof drive.verdict === "object"
        ? /** @type {{ verdict?: unknown }} */ (drive.verdict).verdict
        : null;
    const verdict =
      typeof verdictRaw === "string" && verdictRaw.toUpperCase() === "APPROVE"
        ? "APPROVE"
        : typeof verdictRaw === "string" && verdictRaw.toUpperCase() === "REVISE"
          ? "REVISE"
          : phase === "plan_review"
            ? "REVISE"
            : null;
    return {
      ok: true,
      dual_status: DUAL_STATUS.BOTH,
      verdict,
      findings: Array.isArray(drive.findings) ? drive.findings : [],
      drive,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "mergeHostDualEyes failed",
    };
  }
}

/**
 * @description Build canonical merge artifact payload (audit trail; plan_verdict remains gate authority).
 * @param {{
 *   phase: "plan_review" | "adversary",
 *   scope_hash: string,
 *   primary_report_hash: string,
 *   secondary_report_hash: string,
 *   primaryReport: unknown,
 *   secondaryReport: unknown,
 *   merged_at?: string,
 * }} input
 * @returns {{ ok: true, artifact: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function buildDualMergeArtifact(input = {}) {
  try {
    const phase = input.phase;
    if (phase !== "plan_review" && phase !== "adversary") {
      return { ok: false, reason: `invalid phase: ${String(phase)}` };
    }
    const scope_hash = typeof input.scope_hash === "string" ? input.scope_hash : "";
    const primary_report_hash =
      typeof input.primary_report_hash === "string" ? input.primary_report_hash : "";
    const secondary_report_hash =
      typeof input.secondary_report_hash === "string" ? input.secondary_report_hash : "";
    if (!scope_hash || !primary_report_hash || !secondary_report_hash) {
      return { ok: false, reason: "scope_hash and both report hashes required" };
    }
    const merged = mergeHostDualEyes({
      phase,
      primaryReport: input.primaryReport,
      secondaryReport: input.secondaryReport,
    });
    if (!merged.ok) {
      return { ok: false, reason: merged.reason || "merge failed" };
    }
    /** @type {Record<string, unknown>} */
    const artifact = {
      phase,
      scope_hash,
      dual_status: DUAL_STATUS.BOTH,
      primary_report_hash,
      secondary_report_hash,
      merged_at:
        typeof input.merged_at === "string" && input.merged_at
          ? input.merged_at
          : new Date().toISOString(),
    };
    if (merged.verdict === "APPROVE" || merged.verdict === "REVISE") {
      artifact.verdict = merged.verdict;
    }
    if (Array.isArray(merged.findings) && merged.findings.length > 0) {
      artifact.findings_count = merged.findings.length;
    }
    return { ok: true, artifact };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "buildDualMergeArtifact failed",
    };
  }
}

/**
 * @description Deterministic path: `.opencode/plans/.state/<sessionId>/dual-merge/<phase>-<scopeHash>.json`
 * @param {string} projectRoot
 * @param {string} sessionId
 * @param {string} phase
 * @param {string} scopeHash
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function dualMergeArtifactPath(projectRoot, sessionId, phase, scopeHash) {
  try {
    if (typeof projectRoot !== "string" || !projectRoot) {
      return { ok: false, reason: "invalid projectRoot" };
    }
    if (typeof phase !== "string" || !phase || /[^a-z0-9_]/i.test(phase)) {
      return { ok: false, reason: "invalid phase" };
    }
    if (typeof scopeHash !== "string" || !scopeHash || /[^a-f0-9]/i.test(scopeHash)) {
      return { ok: false, reason: "invalid scopeHash" };
    }
    const dir = gateStateDir({ projectRoot, runtime: "opencode", sessionId });
    if (!dir.ok) return dir;
    return {
      ok: true,
      path: path.join(dir.path, "dual-merge", `${phase}-${scopeHash}.json`),
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "dualMergeArtifactPath failed",
    };
  }
}

/**
 * @description Write merge artifact to ceremony state path. Idempotent overwrite. Never throws.
 * @param {string} projectRoot
 * @param {string} sessionId
 * @param {Record<string, unknown>} artifact
 * @returns {{ ok: boolean, path?: string, reason?: string }}
 */
export function writeDualMergeArtifact(projectRoot, sessionId, artifact) {
  try {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      return { ok: false, reason: "invalid artifact" };
    }
    if (artifact.dual_status !== DUAL_STATUS.BOTH) {
      return { ok: false, reason: "refuse write unless dual_status both" };
    }
    const phase = typeof artifact.phase === "string" ? artifact.phase : "";
    const scopeHash = typeof artifact.scope_hash === "string" ? artifact.scope_hash : "";
    const target = dualMergeArtifactPath(projectRoot, sessionId, phase, scopeHash);
    if (!target.ok) return target;
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    const tmp = `${target.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(artifact, null, 2), "utf8");
    fs.renameSync(tmp, target.path);
    return { ok: true, path: target.path };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "writeDualMergeArtifact failed",
    };
  }
}

/**
 * @description Host finalize: build + write when dual is both. No-op when not both / missing reports.
 * @param {{
 *   projectRoot: string,
 *   sessionId: string,
 *   phase: "plan_review" | "adversary",
 *   scope_hash: string,
 *   primary_report_hash: string,
 *   secondary_report_hash: string,
 *   primaryReport: unknown,
 *   secondaryReport: unknown,
 *   dual_status?: string,
 * }} opts
 * @returns {{ ok: boolean, written?: boolean, path?: string, reason?: string, artifact?: Record<string, unknown> }}
 */
export function finalizeHostDualMerge(opts = {}) {
  try {
    if (opts.dual_status != null && opts.dual_status !== DUAL_STATUS.BOTH) {
      return { ok: true, written: false, reason: "dual not both" };
    }
    if (!opts.primaryReport || !opts.secondaryReport) {
      return { ok: true, written: false, reason: "missing peer report" };
    }
    const built = buildDualMergeArtifact({
      phase: opts.phase,
      scope_hash: opts.scope_hash,
      primary_report_hash: opts.primary_report_hash,
      secondary_report_hash: opts.secondary_report_hash,
      primaryReport: opts.primaryReport,
      secondaryReport: opts.secondaryReport,
    });
    if (!built.ok) return { ok: false, written: false, reason: built.reason };
    const written = writeDualMergeArtifact(opts.projectRoot, opts.sessionId, built.artifact);
    if (!written.ok) return { ok: false, written: false, reason: written.reason };
    return { ok: true, written: true, path: written.path, artifact: built.artifact };
  } catch (err) {
    return {
      ok: false,
      written: false,
      reason: err instanceof Error ? err.message : "finalizeHostDualMerge failed",
    };
  }
}

/**
 * @description Extract dual-merge intent from applyReviewOutcome result + next state.
 * Only when dual_status for phase is both and both reports/hashes present.
 * @param {{
 *   state: Record<string, unknown>,
 *   accepted?: boolean,
 *   classified?: { kind?: string, report?: unknown, reportHash?: string },
 *   dualPhase?: string,
 *   scopeHash?: string,
 * }} outcome
 * @returns {null | {
 *   phase: "plan_review" | "adversary",
 *   scope_hash: string,
 *   primary_report_hash: string,
 *   secondary_report_hash: string,
 *   primaryReport: unknown,
 *   secondaryReport: unknown,
 *   dual_status: "both",
 * }}
 */
export function dualMergeIntentFromOutcome(outcome = {}) {
  try {
    if (outcome.accepted !== true) return null;
    if (outcome.classified?.kind !== "useful") return null;
    const state = outcome.state && typeof outcome.state === "object" ? outcome.state : {};
    const phase =
      outcome.dualPhase ||
      dualStatusPhaseFromRole(
        Array.isArray(state.review_outcomes) && state.review_outcomes.length > 0
          ? state.review_outcomes[state.review_outcomes.length - 1]?.logical_role
          : undefined,
      );
    if (phase !== "plan_review" && phase !== "adversary") return null;
    const map = normalizeDualStatusMap(state.dual_status);
    if (map[phase] !== DUAL_STATUS.BOTH) return null;
    const primaryReport = state.primary_review_last_report;
    const secondaryReport = state.secondary_review_last_report;
    const primaryHash =
      typeof state.primary_review_last_report_hash === "string"
        ? state.primary_review_last_report_hash
        : "";
    const secondaryHash =
      typeof state.secondary_review_last_report_hash === "string"
        ? state.secondary_review_last_report_hash
        : "";
    const scopeHash =
      typeof outcome.scopeHash === "string" && outcome.scopeHash
        ? outcome.scopeHash
        : typeof state.primary_review_last_scope_hash === "string"
          ? state.primary_review_last_scope_hash
          : "";
    if (
      !primaryReport ||
      !secondaryReport ||
      !primaryHash ||
      !secondaryHash ||
      !scopeHash ||
      state.primary_review_last_scope_hash !== scopeHash ||
      state.secondary_review_last_scope_hash !== scopeHash
    ) {
      return null;
    }
    return {
      phase,
      scope_hash: scopeHash,
      primary_report_hash: primaryHash,
      secondary_report_hash: secondaryHash,
      primaryReport,
      secondaryReport,
      dual_status: DUAL_STATUS.BOTH,
    };
  } catch {
    return null;
  }
}
