/**
 * @description PreToolUse(Agent) hook — deterministic entry gate for harness delivery roles.
 *
 * Fail-open contract: exits 0 on ANY infra error. DENY is emitted ONLY in the deliberate
 * gate-decision branch (Gate 1 or Gate 2). A buggy gate must never brick delivery work.
 *
 * Gate order:
 *   1. agent_id present → ALLOW (subagent context, no state pollution)
 *   2. subagent_type not a delivery role → ALLOW (casual agents free)
 *   3. Gate 1: triage.json must exist with mode in {LIGHT, FULL} → DENY if not
 *   4. On allow path, subagent_type=adversary → record adversary_fired in gate-state.json
 *   5. Gate 2 (planner only, BOTH LIGHT and FULL): gate-state.json must have BOTH
 *      brainstormed AND adversary_fired → DENY if either missing
 *   6. Otherwise → ALLOW
 *
 * Deny output format (stdout, then exit 0):
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
 *
 * Allow output: no stdout, exit 0.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isDeliveryRole,
  bareRole,
  isSafeSessionId,
  stateDirFor,
  readGateState,
  mergeGateState,
} from "./lib/gate-lib.mjs";

// ---------------------------------------------------------------------------
// Default I/O implementations (used by CLI; tests inject alternatives)
// ---------------------------------------------------------------------------

/**
 * Reads and parses triage.json for a session.
 * Returns the parsed object on success, or null on any error (missing/unparseable).
 * @param {string} sessionId
 * @returns {object|null}
 */
function defaultReadTriage(sessionId) {
  try {
    const triagePath = path.join(stateDirFor(sessionId), "triage.json");
    const raw = fs.readFileSync(triagePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure decision layer — testable without spawning
// ---------------------------------------------------------------------------

/**
 * Decides whether to allow or deny an Agent tool dispatch.
 *
 * Side effect: on the allow path for adversary dispatches (Gate 1 passed), records
 * adversary_fired into gate-state.json via mergeGateStateFn. A write failure here
 * never blocks — fail-open; the Gate 2 deny will re-instruct if needed.
 *
 * @param {unknown} payload - The parsed hook payload
 * @param {object} [deps] - Injectable seams for test isolation
 * @param {function} [deps.readTriage] - (sessionId: string) => object|null
 * @param {function} [deps.readGateStateFn] - (sessionId: string) => object
 * @param {function} [deps.mergeGateStateFn] - (sessionId: string, patch: object) => boolean
 * @returns {{ allow: true }
 *         | { allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
export function decide(payload, deps = {}) {
  const {
    readTriage: readTriageFn = defaultReadTriage,
    readGateStateFn = readGateState,
    mergeGateStateFn = mergeGateState,
  } = deps;

  // Non-object payload → infra error → fail-open
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { allow: true };
  }

  // Step 1: agent_id present → subagent context, always allow (no state pollution)
  if (Object.prototype.hasOwnProperty.call(payload, "agent_id")) {
    return { allow: true };
  }

  // Step 2: resolve subagent_type; non-delivery roles pass freely
  const subagentType = payload?.tool_input?.subagent_type;
  if (!isDeliveryRole(subagentType)) {
    return { allow: true };
  }
  // Normalize namespace prefix once (e.g. 'harness:planner' → 'planner') so gate branches
  // below match plugin-distributed roles, not just bare ones.
  const role = bareRole(subagentType);

  // Delivery role confirmed. session_id is required for gate operations.
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    // Missing session_id = infra error → fail-open (never deny without an identity)
    return { allow: true };
  }
  if (!isSafeSessionId(sessionId)) {
    // Unsafe session_id (e.g. path traversal) → stamp-triage cannot write triage.json → fail-open instead of brick
    return { allow: true };
  }

  // Gate 1: triage.json must exist with mode in {LIGHT, FULL}
  let triage = null;
  try {
    triage = readTriageFn(sessionId);
  } catch {
    // readTriageFn must not throw, but defensive catch → fail-open
    return { allow: true };
  }

  const triageMode = triage?.mode;
  if (triage === null || (triageMode !== "LIGHT" && triageMode !== "FULL")) {
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[entry-gate] Blocked: run triaging-requests and classify (choosing mode LIGHT or FULL) " +
          "BEFORE dispatching any delivery agent. " +
          "Invoke the triaging-requests skill, call classify.mjs with the chosen mode and " +
          "feature_id, then retry the dispatch.",
      },
    };
  }

  // Gate 1 passed. On the allow path, record adversary dispatches into gate-state.json.
  // This must happen BEFORE Gate 2 so a same-session adversary→planner sequence works.
  if (role === "adversary") {
    try {
      mergeGateStateFn(sessionId, { adversary_fired: true });
    } catch {
      // Write failure never blocks — fail-open; Gate 2 will re-instruct if adversary_fired is
      // missing when planner is eventually dispatched.
    }
    return { allow: true };
  }

  // Gate 2: planner requires BOTH brainstormed AND adversary_fired in BOTH LIGHT and FULL.
  if (role === "planner") {
    const featureId = (triage && typeof triage.feature_id === "string" && triage.feature_id)
      ? triage.feature_id
      : "<id>";

    let gateState = {};
    try {
      gateState = readGateStateFn(sessionId);
    } catch {
      gateState = {};
    }

    const hasBrainstormed = gateState.brainstormed === true;
    const hasAdversaryFired = gateState.adversary_fired === true;
    // Bind the ceremony flags to the feature being planned: a gate-state stamped for a
    // DIFFERENT feature carries stale brainstormed/adversary_fired from a prior feature in
    // the same session. Treat that as ceremony-not-done and re-instruct for this feature.
    const featureMismatch =
      typeof gateState.feature_id === "string" && gateState.feature_id !== featureId;

    if (featureMismatch || (!hasBrainstormed && !hasAdversaryFired)) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "[entry-gate] Blocked: the planner requires BOTH Phase 0 brainstorming AND " +
            "the spec-adversary to complete first. " +
            `Run brainstorming (mark.mjs brainstorm-done --feature-id ${featureId}) and dispatch ` +
            "the spec-adversary (subagent_type='adversary') before the planner.",
        },
      };
    }

    if (!hasBrainstormed) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "[entry-gate] Blocked: the planner requires Phase 0 brainstorming to complete first. " +
            "Run brainstorming and mark it done " +
            `(mark.mjs brainstorm-done --feature-id ${featureId}) before dispatching the planner.`,
        },
      };
    }

    if (!hasAdversaryFired) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "[entry-gate] Blocked: the planner requires the spec-adversary to run first. " +
            "Dispatch the spec-adversary (subagent_type='adversary') on the finished spec " +
            "before dispatching the planner.",
        },
      };
    }

    return { allow: true };
  }

  // All other delivery roles (executor, compliance, sniper, security, harvester, shipper,
  // plan-reviewer) with a valid Gate 1 triage → allow.
  return { allow: true };
}

// ---------------------------------------------------------------------------
// Input processing — translates raw stdin to { exitCode, output }
// Exposed for test use so the CLI behavior is verifiable without spawning.
// ---------------------------------------------------------------------------

/**
 * Processes a raw stdin string through the full gate logic.
 * Parse failure → fail-open (exitCode 0, output null).
 * Deny verdict → output is the JSON string to write to stdout.
 * Allow verdict → output is null.
 *
 * @param {string} rawStr - Raw string from stdin
 * @param {object} [deps] - Injectable seams (forwarded to decide)
 * @returns {{ exitCode: 0, output: string|null }}
 */
export function processInput(rawStr, deps = {}) {
  let payload;
  try {
    payload = JSON.parse(rawStr);
  } catch {
    // Malformed or empty payload — fail-open, no deny
    return { exitCode: 0, output: null };
  }

  let verdict;
  try {
    verdict = decide(payload, deps);
  } catch {
    // Unexpected error in decide — fail-open
    return { exitCode: 0, output: null };
  }

  if (!verdict.allow) {
    return {
      exitCode: 0,
      output: JSON.stringify({ hookSpecificOutput: verdict.hookSpecificOutput }),
    };
  }

  return { exitCode: 0, output: null };
}

// ---------------------------------------------------------------------------
// CLI entry point — guarded so imports from tests do not trigger side effects
// ---------------------------------------------------------------------------

function isDirectCli() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === modulePath;
  } catch {
    return process.argv[1] === modulePath;
  }
}

if (isDirectCli()) {
  // Read stdin exactly once into a variable — never re-read
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    // Cannot read stdin → fail-open
    process.exit(0);
  }

  // Wrap the whole body: any uncaught error → fail-open (exit 0, no deny)
  try {
    const result = processInput(raw);
    if (result.output !== null) {
      process.stdout.write(result.output + "\n");
    }
  } catch {
    // Unexpected error — fail-open
  }

  process.exit(0);
}
