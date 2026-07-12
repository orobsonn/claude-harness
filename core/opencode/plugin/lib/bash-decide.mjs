/**
 * @description Pure OC bash gates: delivery ceremony + gate-state anti-forgery.
 * Never throws; returns Decision.
 */

import { isDeliveryCommand } from "./is-delivery-command.mjs";
import { isSafeSessionIdSegment } from "./dual-enforcement.mjs";

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
 * @description Fail-closed anti-forgery: any command mentioning oracle paths
 * (plans/.state, gate-state.json, triage.json, execution-plan.json) is forge
 * unless the first argv basename is classify|mark|mark-gate. No write-op
 * heuristic — covers cp/mv/dd/rsync/node -e/python without requiring >.
 * Side effect: even `ls .opencode/plans/.state` denies (acceptable ship wall).
 * @param {unknown} command
 * @returns {boolean}
 */
export function isStateForgeCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  if (!ORACLE_PATH_RE.test(command)) return false;
  const base = firstArgvBasename(command);
  if (FORGE_ALLOWLIST.has(base)) return false;
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
 * @param {{
 *   command?: unknown,
 *   gateState?: unknown,
 *   sessionId?: unknown,
 *   gateStateLoadOk?: boolean,
 * }} input
 * @returns {Decision}
 */
export function decideBashDelivery(input = {}) {
  try {
    const command = input.command;
    if (!isDeliveryCommand(command)) {
      return { ok: true, decision: "allow", reason: "not-delivery-command" };
    }

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

    if (mode === "NO-CEREMONY") {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: no-ceremony mode cannot public-ship (git push / gh pr).",
      };
    }

    if (mode === "QUICK" && classified) {
      return { ok: true, decision: "allow", reason: "quick-delivery-ok" };
    }

    if (!classified && !mode) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery (git push / gh pr) requires ceremony — run triaging + classify before shipping.",
      };
    }

    if (mode === "LIGHT" || mode === "FULL" || (!mode && classified)) {
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
      return { ok: true, decision: "allow", reason: "ceremony-delivery-ok" };
    }

    return {
      ok: false,
      decision: "deny",
      reason:
        "[entry-gate] Blocked: delivery requires valid mode stamp (QUICK|LIGHT|FULL).",
    };
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
