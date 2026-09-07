/** @description Pure OpenCode NDJSON run-log oracle: classifies opencode run streams (tool_use deny/error, step_finish, noise). Never throws; process exit code is never success. */

/**
 * Closed outcome set for OC session logs (T12).
 * Exit code alone is never success (probe: deny-but-exit-0).
 * @type {Readonly<{
 *   OK: "ok",
 *   TOOL_DENY: "tool_deny",
 *   CEREMONY_FAILED: "ceremony_failed",
 *   INCOMPLETE: "incomplete",
 *   EMPTY: "empty",
 *   PARSE_ERROR: "parse_error",
 * }>}
 */
export const OC_RUN_OUTCOME = Object.freeze({
  OK: "ok",
  TOOL_DENY: "tool_deny",
  CEREMONY_FAILED: "ceremony_failed",
  INCOMPLETE: "incomplete",
  EMPTY: "empty",
  PARSE_ERROR: "parse_error",
});

/** @type {ReadonlySet<string>} */
export const OC_RUN_OUTCOME_VALUES = new Set(Object.values(OC_RUN_OUTCOME));

/** Gate deny prefixes from entry-gate / plan-gate / loop-guard plugin throws. */
const GATE_DENY_RE = /\[(entry-gate|plan-gate|loop-guard)\]/;

/**
 * @param {unknown} ev
 * @returns {string}
 */
function extractToolErrorMessage(ev) {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return "";
  const part =
    /** @type {{ state?: { status?: unknown, error?: unknown }, error?: unknown }} */ (
      /** @type {{ part?: unknown }} */ (ev).part
    ) && typeof /** @type {{ part?: unknown }} */ (ev).part === "object"
      ? /** @type {{ state?: { status?: unknown, error?: unknown }, error?: unknown }} */ (
          /** @type {{ part?: unknown }} */ (ev).part
        )
      : {};
  const st =
    part.state && typeof part.state === "object" && !Array.isArray(part.state)
      ? part.state
      : {};
  const msg = st.error ?? part.error ?? /** @type {{ message?: unknown, error?: unknown }} */ (ev).error ?? /** @type {{ message?: unknown }} */ (ev).message ?? "";
  return String(msg ?? "");
}

/**
 * @param {unknown} ev
 * @returns {boolean}
 */
function isToolUseError(ev) {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
  if (/** @type {{ type?: unknown }} */ (ev).type !== "tool_use") return false;
  const part = /** @type {{ part?: unknown }} */ (ev).part;
  const st =
    part && typeof part === "object" && !Array.isArray(part)
      ? /** @type {{ state?: { status?: unknown } }} */ (part).state
      : undefined;
  if (st && typeof st === "object" && !Array.isArray(st) && st.status === "error") {
    return true;
  }
  // Fallback: explicit error field on event/part without status
  const msg = extractToolErrorMessage(ev);
  return msg.length > 0 && /error|denied|deny|fail/i.test(msg) && st?.status === "error";
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function isGateDenyMessage(message) {
  return typeof message === "string" && GATE_DENY_RE.test(message);
}

/**
 * @description Classify an OpenCode `--format json` NDJSON run log.
 * Never throws. Process exit code is never treated as success oracle.
 *
 * Classification (priority):
 * - gate-prefix tool_use error → tool_deny (even when processExitCode is 0)
 * - other tool_use error / type:error → ceremony_failed
 * - clean step_finish without tool error → ok
 * - events without terminal step_finish → incomplete
 * - no events, only malformed JSON-looking lines → parse_error
 * - no content / only non-JSON noise → empty
 *
 * @param {unknown} logText
 * @param {{ processExitCode?: number } | null | undefined} [opts]
 * @returns {{
 *   ok: boolean,
 *   outcome: string,
 *   processExitCode: number | null,
 *   toolErrors: Array<{ message: string, gateDeny: boolean }>,
 *   eventCounts: { tool_use: number, step_finish: number, error: number, other: number, malformed: number, noise: number },
 *   reasons: string[],
 * }}
 */
export function parseOcRunLog(logText, opts) {
  try {
    const processExitCode =
      opts && typeof opts === "object" && !Array.isArray(opts) && typeof opts.processExitCode === "number"
        ? opts.processExitCode
        : null;

    /** @type {{ tool_use: number, step_finish: number, error: number, other: number, malformed: number, noise: number }} */
    const eventCounts = {
      tool_use: 0,
      step_finish: 0,
      error: 0,
      other: 0,
      malformed: 0,
      noise: 0,
    };

    /** @type {Array<{ message: string, gateDeny: boolean }>} */
    const toolErrors = [];
    /** @type {string[]} */
    const reasons = [];

    const text = logText == null ? "" : String(logText);
    if (text.trim() === "") {
      return {
        ok: false,
        outcome: OC_RUN_OUTCOME.EMPTY,
        processExitCode,
        toolErrors,
        eventCounts,
        reasons: ["empty log"],
      };
    }

    const lines = text.split(/\r?\n/);
    /** @type {object[]} */
    const events = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      // Non-JSON noise (progress text, banners) — ignore, never throw
      if (!(line.startsWith("{") || line.startsWith("["))) {
        eventCounts.noise += 1;
        continue;
      }

      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        eventCounts.malformed += 1;
        continue;
      }

      if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
        eventCounts.malformed += 1;
        continue;
      }

      events.push(ev);
      const type = typeof ev.type === "string" ? ev.type : "";
      if (type === "tool_use") eventCounts.tool_use += 1;
      else if (type === "step_finish") eventCounts.step_finish += 1;
      else if (type === "error") eventCounts.error += 1;
      else eventCounts.other += 1;
    }

    if (events.length === 0) {
      if (eventCounts.malformed > 0) {
        return {
          ok: false,
          outcome: OC_RUN_OUTCOME.PARSE_ERROR,
          processExitCode,
          toolErrors,
          eventCounts,
          reasons: ["malformed JSON lines only; no valid NDJSON events"],
        };
      }
      // Only non-JSON noise (or blank-ish after trim of content lines)
      return {
        ok: false,
        outcome: OC_RUN_OUTCOME.EMPTY,
        processExitCode,
        toolErrors,
        eventCounts,
        reasons: eventCounts.noise > 0 ? ["non-JSON noise only; no events"] : ["no events"],
      };
    }

    let hasToolDeny = false;
    let hasToolError = false;
    let hasErrorEvent = false;
    let hasStepFinish = false;

    for (const ev of events) {
      const type = typeof ev.type === "string" ? ev.type : "";

      if (type === "step_finish") {
        hasStepFinish = true;
      }

      if (type === "error") {
        hasErrorEvent = true;
        const msg = extractToolErrorMessage(ev) || String(/** @type {{ message?: unknown }} */ (ev).message ?? "error event");
        reasons.push(`error event: ${msg.slice(0, 200)}`);
      }

      if (type === "tool_use") {
        const part = /** @type {{ part?: unknown }} */ (ev).part;
        const st =
          part && typeof part === "object" && !Array.isArray(part)
            ? /** @type {{ state?: { status?: unknown } }} */ (part).state
            : undefined;
        const statusError =
          st && typeof st === "object" && !Array.isArray(st) && st.status === "error";

        if (statusError || isToolUseError(ev)) {
          const message = extractToolErrorMessage(ev);
          const gateDeny = isGateDenyMessage(message);
          toolErrors.push({ message, gateDeny });
          if (gateDeny) {
            hasToolDeny = true;
            reasons.push(`gate deny: ${message.slice(0, 200)}`);
          } else {
            hasToolError = true;
            reasons.push(`tool_use error: ${message.slice(0, 200)}`);
          }
        }
      }
    }

    // Priority: tool_deny > ceremony_failed > ok (step_finish) > incomplete
    // Exit code is NEVER the success oracle — deny-but-exit-0 stays tool_deny.
    if (hasToolDeny) {
      if (processExitCode === 0) {
        reasons.push("processExitCode 0 ignored; tool_deny from NDJSON");
      }
      return {
        ok: false,
        outcome: OC_RUN_OUTCOME.TOOL_DENY,
        processExitCode,
        toolErrors,
        eventCounts,
        reasons,
      };
    }

    if (hasToolError || hasErrorEvent) {
      if (processExitCode === 0) {
        reasons.push("processExitCode 0 ignored; ceremony_failed from NDJSON");
      }
      return {
        ok: false,
        outcome: OC_RUN_OUTCOME.CEREMONY_FAILED,
        processExitCode,
        toolErrors,
        eventCounts,
        reasons,
      };
    }

    if (hasStepFinish) {
      return {
        ok: true,
        outcome: OC_RUN_OUTCOME.OK,
        processExitCode,
        toolErrors,
        eventCounts,
        reasons: reasons.length ? reasons : ["clean step_finish without tool error"],
      };
    }

    // Valid events but stream ended without step_finish (truncated / abandoned)
    return {
      ok: false,
      outcome: OC_RUN_OUTCOME.INCOMPLETE,
      processExitCode,
      toolErrors,
      eventCounts,
      reasons: reasons.length ? reasons : ["stream ended without step_finish"],
    };
  } catch (err) {
    return {
      ok: false,
      outcome: OC_RUN_OUTCOME.PARSE_ERROR,
      processExitCode:
        opts && typeof opts === "object" && !Array.isArray(opts) && typeof opts.processExitCode === "number"
          ? opts.processExitCode
          : null,
      toolErrors: [],
      eventCounts: {
        tool_use: 0,
        step_finish: 0,
        error: 0,
        other: 0,
        malformed: 0,
        noise: 0,
      },
      reasons: [err instanceof Error ? err.message : "parseOcRunLog failed"],
    };
  }
}
