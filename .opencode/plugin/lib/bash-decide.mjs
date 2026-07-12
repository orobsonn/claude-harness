/**
 * @description Pure OC bash gates: delivery ceremony + rails + gate-state anti-forgery.
 * Never throws; returns Decision. D1 single fall-through — no early allow after delivery detect.
 */

import { isDeliveryCommand } from "./is-delivery-command.mjs";
import { isSafeSessionIdSegment } from "./dual-enforcement.mjs";
import { matchesAbsolution } from "../../shared/lib/absolution.mjs";
import {
  classifyRegatePending,
  corruptRegatePendingReason,
} from "../../shared/lib/regate-classify.mjs";
import { checkRealFileCaptureRail } from "../../shared/lib/real-file-capture-rail.mjs";

/**
 * @typedef {{ ok: boolean, decision: "allow"|"deny", reason: string, details?: unknown }} Decision
 */

/** Bash forge allowlist: basename of first argv / node script only. */
const FORGE_ALLOWLIST = new Set(["classify", "mark", "mark-gate"]);

const ORACLE_PATH_RE =
  /\.opencode\/plans\/\.state\b|gate-state\.json\b|triage\.json\b|execution-plan\.json\b/;

/**
 * @param {unknown} mode
 * @returns {"QUICK"|"LIGHT"|"FULL"|"NO-CEREMONY"|""}
 */
export function normalizeMode(mode) {
  if (typeof mode !== "string") return "";
  const m = mode.trim().toLowerCase();
  if (m === "quick") return "QUICK";
  if (m === "light") return "LIGHT";
  if (m === "full") return "FULL";
  if (m === "no-ceremony") return "NO-CEREMONY";
  return "";
}

/**
 * @param {unknown} dualStatus
 * @returns {boolean}
 */
export function isRecordedDual(dualStatus) {
  return (
    dualStatus === "both" ||
    dualStatus === "primary_only_failopen" ||
    dualStatus === "primary_only_error"
  );
}

/**
 * @description Extract basename of first meaningful argv (node script or binary).
 * @param {string} command
 * @returns {string}
 */
export function firstArgvBasename(command) {
  if (typeof command !== "string") return "";
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0) return "";
  let i = 0;
  if (tokens[0] === "node" || tokens[0].endsWith("/node")) {
    i = 1;
    while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
  }
  const raw = tokens[i] ?? tokens[0] ?? "";
  const base = raw.split(/[/\\]/).pop() ?? "";
  return base.replace(/\.mjs$/i, "").replace(/\.ts$/i, "").replace(/\.js$/i, "");
}

/**
 * @description Shell chain / substitution metacharacters that turn an allowlisted
 * basename into a multi-command forge (e.g. mark-gate ; cat > .state/...).
 * @param {string} command
 * @returns {boolean}
 */
export function hasShellChainMetacharacters(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  return (
    command.includes(";") ||
    command.includes("&&") ||
    command.includes("||") ||
    command.includes("|") ||
    command.includes("\n") ||
    command.includes("$(") ||
    command.includes("`")
  );
}

/**
 * @description Shell redirects that can forge oracle paths even with an
 * allowlisted basename (e.g. mark-gate ... > .opencode/plans/.state/...).
 * Covers `>`, `>>`, and `<` (symmetry).
 * @param {string} command
 * @returns {boolean}
 */
export function hasShellRedirectOperators(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  return command.includes(">") || command.includes("<");
}

/**
 * @description Fail-closed anti-forgery: any command mentioning oracle paths
 * (plans/.state, gate-state.json, triage.json, execution-plan.json) is forge
 * unless the first argv basename is classify|mark|mark-gate AND the command has
 * no shell chain metacharacters (; && || | newline $( backtick) and no redirect
 * operators (> >> <). No write-op heuristic — covers cp/mv/dd/rsync/node -e/python.
 * Side effect: even `ls .opencode/plans/.state` denies (acceptable ship wall).
 * @param {unknown} command
 * @returns {boolean}
 */
export function isStateForgeCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  if (!ORACLE_PATH_RE.test(command)) return false;
  const base = firstArgvBasename(command);
  if (
    FORGE_ALLOWLIST.has(base) &&
    !hasShellChainMetacharacters(command) &&
    !hasShellRedirectOperators(command)
  ) {
    return false;
  }
  return true;
}

/**
 * @param {{ command?: unknown }} input
 * @returns {Decision}
 */
export function decideBashForge(input = {}) {
  try {
    if (!isStateForgeCommand(input.command)) {
      return { ok: true, decision: "allow", reason: "not-state-forge" };
    }
    return {
      ok: false,
      decision: "deny",
      reason:
        "[entry-gate] Blocked: bash must not write gate-state / plans/.state / execution-plan.json — use classify/mark/mark-gate only (anti-forgery).",
    };
  } catch {
    return {
      ok: false,
      decision: "deny",
      reason: "[entry-gate] Blocked: state-forge decision failed",
    };
  }
}

/**
 * @param {unknown} v
 * @returns {unknown[]}
 */
function coerceArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * @description Fail-closed: key present and not array → corrupt (same family as regate_pending).
 * Absent (undefined) → empty array. Array → as-is.
 * @param {Record<string, unknown>} gs
 * @param {string} key
 * @returns {{ corrupt: false, value: unknown[] } | { corrupt: true, raw: unknown, key: string }}
 */
function classifyArrayMarker(gs, key) {
  const raw = gs[key];
  if (raw === undefined) return { corrupt: false, value: [] };
  if (Array.isArray(raw)) return { corrupt: false, value: raw };
  return { corrupt: true, raw, key };
}

/**
 * @param {string} key
 * @param {unknown} raw
 * @returns {string}
 */
function corruptArrayMarkerReason(key, raw) {
  let text;
  try {
    text = JSON.stringify(raw);
  } catch {
    try {
      text = String(raw);
    } catch {
      text = `<unserializable ${key}>`;
    }
  }
  if (text.length > 200) text = text.slice(0, 200);
  return (
    `[entry-gate] Blocked: gate-state corrupted — ${key} is not a JSON array ` +
    `(raw value: ${text}). Repair or delete gate-state.json (${key} must be a ` +
    "JSON array), then re-stamp before proceeding."
  );
}

/**
 * @param {{
 *   command?: unknown,
 *   gateState?: unknown,
 *   sessionId?: unknown,
 *   gateStateLoadOk?: boolean,
 *   gitState?: { branch?: string|null, commitsAhead?: number|null, defaultBranch?: string|null }|null,
 *   isAncestorFn?: (sha: string) => boolean|null,
 *   listHandRecordsForFeatureFn?: (featureId: string) => unknown[],
 * }} input
 * @returns {Decision}
 */
export function decideBashDelivery(input = {}) {
  try {
    const command = input.command;
    // 1. non-delivery → allow
    if (!isDeliveryCommand(command)) {
      return { ok: true, decision: "allow", reason: "not-delivery-command" };
    }

    // 2. gitState rails (null / unresolvable → skip fail-open)
    const gitState = input.gitState;
    if (gitState && typeof gitState === "object" && typeof gitState.branch === "string") {
      const isProtected =
        gitState.branch === "main" ||
        gitState.branch === "master" ||
        (typeof gitState.defaultBranch === "string" &&
          gitState.branch === gitState.defaultBranch);
      if (isProtected) {
        return {
          ok: false,
          decision: "deny",
          reason:
            `[entry-gate] Blocked: delivery command on protected branch '${gitState.branch}'. ` +
            "The per-task freeze/impl commit series must live on a feature branch — run " +
            "`git switch -c <type>/<feature-id>` (feat/fix/refactor/chore/docs) and commit the " +
            "work before any delivery command (git push / gh pr create / gh pr merge).",
        };
      }
      if (gitState.commitsAhead === 0) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: delivery command with zero commits ahead of base. Commit the " +
            "task's work (the freeze/impl series) before delivering — a push/PR with no commits " +
            "ships nothing and signals the orchestrator skipped the per-task commit step.",
        };
      }
    }

    // 3. sessionId safe + gateStateLoadOk — OC fail-closed deny
    if (input.gateStateLoadOk === false) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery requires readable gate-state (fail-closed).",
      };
    }

    if (!isSafeSessionIdSegment(input.sessionId)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery requires a safe sessionId bound to gate-state.",
      };
    }

    const gs =
      input.gateState &&
      typeof input.gateState === "object" &&
      !Array.isArray(input.gateState)
        ? /** @type {Record<string, unknown>} */ (input.gateState)
        : {};

    const mode = normalizeMode(gs.mode);
    const classified = gs.classified === true || gs.triaged === true;

    // 4. ceremony checks — deny if fail, NEVER return allow
    if (mode === "NO-CEREMONY") {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: no-ceremony mode cannot public-ship (git push / gh pr).",
      };
    }

    if (!classified && !mode) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery (git push / gh pr) requires ceremony — run triaging + classify before shipping.",
      };
    }

    if (mode === "QUICK" && classified) {
      // ceremony OK for QUICK — fall through to rails 5–9 (no early quick-delivery-ok)
    } else if (mode === "LIGHT" || mode === "FULL" || (!mode && classified)) {
      if (gs.brainstormed !== true) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: delivery requires brainstormed before git push / gh pr.",
        };
      }
      if (gs.adversary_fired !== true) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: delivery requires adversary_fired before git push / gh pr.",
        };
      }
      if (mode === "FULL" && !isRecordedDual(gs.dual_status)) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: FULL delivery requires recorded dual_status before git push / gh pr.",
          details: { dual_status: gs.dual_status ?? null },
        };
      }
      // ceremony OK — fall through (no ceremony-delivery-ok early allow)
    } else {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery requires valid mode stamp (QUICK|LIGHT|FULL).",
      };
    }

    const isAncestorFn =
      typeof input.isAncestorFn === "function"
        ? input.isAncestorFn
        : () => null;

    // 5. corrupt regate_pending → deny (never "stamp regate-passed")
    const regate = classifyRegatePending(gs);
    if (regate.corrupt) {
      return {
        ok: false,
        decision: "deny",
        reason: corruptRegatePendingReason(regate.raw),
      };
    }

    // 5b. corrupt hand_finished / capture_verified / regate_passed (present + non-array) → deny
    for (const key of ["hand_finished", "capture_verified", "regate_passed"]) {
      const marker = classifyArrayMarker(gs, key);
      if (marker.corrupt) {
        return {
          ok: false,
          decision: "deny",
          reason: corruptArrayMarkerReason(marker.key, marker.raw),
        };
      }
    }

    // 6. unmatched regate via matchesAbsolution
    const pending = regate.pending;
    const passed = coerceArray(gs.regate_passed);
    const unmatched = pending.filter(
      (t) => !matchesAbsolution(/** @type {string} */ (t), passed, isAncestorFn),
    );
    if (unmatched.length > 0) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery command denied — HIGH sniper fix(es) for task(s) " +
          `${unmatched.join(", ")} still await the mandatory strong-eye re-gate ` +
          "(regate-pending without regate-passed). Dispatch the fresh-virgin adversary and " +
          "stamp regate-passed before running any delivery command " +
          "(git push / gh pr create / gh pr merge).",
      };
    }

    // 7. unmatched hand_finished vs capture_verified (arrays validated above)
    const handFinished = coerceArray(gs.hand_finished);
    const captureVerified = coerceArray(gs.capture_verified);
    const unmatchedCapture = handFinished.filter(
      (t) =>
        !matchesAbsolution(
          /** @type {string} */ (t),
          captureVerified,
          isAncestorFn,
        ),
    );
    if (unmatchedCapture.length > 0) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery command denied — finished cheap-hand task(s) " +
          `${unmatchedCapture.join(", ")} still await independent capture/verification ` +
          "(hand-finished without capture-verified). Independently capture the hand output and " +
          "stamp capture-verified before running any delivery command " +
          "(git push / gh pr create / gh pr merge).",
      };
    }

    // 8. LIGHT/FULL require string feature_id
    const featureId =
      typeof gs.feature_id === "string" ? gs.feature_id : null;
    if ((mode === "LIGHT" || mode === "FULL") && featureId === null) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: LIGHT/FULL delivery requires string feature_id in gate-state.",
      };
    }

    // 9. real-file rail when LIGHT|FULL or feature_id present
    // LIGHT|FULL: empty list is vacuous ship → deny (requireCaptureEvidence).
    // QUICK with feature_id: still runs rail on present records; empty list ok.
    const listFn = input.listHandRecordsForFeatureFn;
    const isLightOrFull = mode === "LIGHT" || mode === "FULL";
    const needsRealFile = isLightOrFull || featureId !== null;
    if (needsRealFile) {
      if (typeof listFn !== "function") {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: real-file-list-unavailable — listHandRecordsForFeatureFn required for delivery.",
        };
      }
      const realFileDeny = checkRealFileCaptureRail(
        /** @type {string} */ (featureId),
        {
          listHandRecordsForFeatureFn: listFn,
          isAncestorFn:
            typeof input.isAncestorFn === "function"
              ? input.isAncestorFn
              : undefined,
          requireCaptureEvidence: isLightOrFull,
          // LIGHT|FULL positive evidence must bind to the current delivery session
          requiredSessionId: isLightOrFull
            ? /** @type {string} */ (input.sessionId)
            : undefined,
        },
      );
      if (realFileDeny !== null) {
        return realFileDeny;
      }
    }

    // 10. single terminal allow only
    return { ok: true, decision: "allow", reason: "delivery-ok" };
  } catch {
    return {
      ok: false,
      decision: "deny",
      reason: "[entry-gate] Blocked: delivery decision failed",
    };
  }
}

/**
 * @param {Decision} decision
 * @returns {void}
 */
export function throwIfDenied(decision) {
  if (decision && decision.decision === "deny") {
    throw new Error(decision.reason || "[entry-gate] denied");
  }
}

export { isDeliveryCommand };
