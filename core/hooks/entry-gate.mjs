/**
 * @description PreToolUse(Agent|Bash) hook — deterministic entry gate for harness delivery roles.
 *
 * Fail-open contract: exits 0 on ANY infra error. DENY is emitted ONLY in the deliberate
 * gate-decision branch. A buggy gate must never brick delivery work.
 *
 * Bash gate (delivery-bash-gate):
 *   Delivery commands (git push, gh pr create, gh pr merge) are denied when gate-state has
 *   any unmatched regate_pending (a regate_pending task_id with no matching regate_passed).
 *   Read-only commands (git status, git diff, git log, gh pr view/list) always pass.
 *   This closes the second delivery door: a direct Bash delivery command bypasses the
 *   PreToolUse(Agent) shipper gate, so this gate closes both doors.
 *
 * Agent gate order:
 *   1. agent_id present → ALLOW (subagent context, no state pollution)
 *   2. subagent_type not a delivery role → ALLOW (casual agents free)
 *   3. Gate 1: triage.json must exist with mode in {LIGHT, FULL} → DENY if not
 *   4. On allow path, subagent_type=adversary → record adversary_fired in gate-state.json
 *   5. Gate 2 (planner only, BOTH LIGHT and FULL): gate-state.json must have BOTH
 *      brainstormed AND adversary_fired → DENY if either missing
 *   6. Gate 3 (shipper): deny while any regate_pending is unmatched by regate_passed
 *   7. Otherwise → ALLOW
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
// Delivery-command detection — delivery-bash-gate
// ---------------------------------------------------------------------------

/**
 * Checks if a bash command string is a delivery action that should be gated when
 * an unmatched regate_pending exists in gate-state.
 *
 * Matches (deny-eligible):
 *   - git push (all variants: flags, remote, branch, upstream tracking, etc.)
 *   - gh pr create (with any trailing flags/args)
 *   - gh pr merge (with any trailing flags/args)
 *
 * Does NOT match read-only inspection:
 *   - git status, git diff, git log, git show, git fetch, git pull, git branch
 *   - gh pr view, gh pr list
 *
 * @param {string} command - The command string to inspect
 * @returns {boolean} true if the command is a delivery action, false otherwise
 */
export function isDeliveryCommand(command) {
  // git push — tolerate intermediate git GLOBAL flags between `git` and `push`
  // (-C <path>, -c k=v, --git-dir=, --work-tree=) so `git -C /repo push` is still gated.
  // The flags must come BEFORE push and the first non-flag token must be `push`, so
  // read-only subcommands (git -C /x status/diff/log) never match. The trailing word
  // boundary still rejects 'git pushing' / 'git push-mirror'.
  if (/\bgit\s+(?:(?:-C\s+\S+|-c\s+\S+|--git-dir=\S+|--work-tree=\S+)\s+)*push\b/.test(command)) {
    return true;
  }
  // gh pr create
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    return true;
  }
  // gh pr merge
  if (/\bgh\s+pr\s+merge\b/.test(command)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Bash gate — decideBash (internal)
// ---------------------------------------------------------------------------

/**
 * Decides whether to allow or deny a Bash tool dispatch.
 * Only delivery commands (git push, gh pr create, gh pr merge) are gated; all other
 * Bash commands pass freely. Fail-open on any infra error (never brick read-only work).
 *
 * @param {object} payload - The parsed Bash hook payload
 * @param {object} deps - Injectable seams
 * @param {function} deps.readGateStateFn - (sessionId: string) => object
 * @returns {{ allow: true }
 *         | { allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
function decideBash(payload, { readGateStateFn }) {
  const command = payload?.tool_input?.command;
  // Non-string command → infra error → fail-open
  if (typeof command !== "string") {
    return { allow: true };
  }
  // Not a delivery command → allow freely (inspection, builds, tests, etc.)
  if (!isDeliveryCommand(command)) {
    return { allow: true };
  }
  // Delivery command detected. Run the same unmatched-regate check as Gate 3 (shipper).
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0 || !isSafeSessionId(sessionId)) {
    // Cannot load state without a safe session_id → fail-open (never brick)
    return { allow: true };
  }
  let gateState = {};
  try {
    gateState = readGateStateFn(sessionId);
  } catch {
    gateState = {};
  }
  const pending = Array.isArray(gateState.regate_pending) ? gateState.regate_pending : [];
  const passed = Array.isArray(gateState.regate_passed) ? gateState.regate_passed : [];
  const unmatched = pending.filter((t) => !passed.includes(t));
  if (unmatched.length > 0) {
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[entry-gate] Blocked: delivery command denied — HIGH sniper fix(es) for task(s) " +
          `${unmatched.join(", ")} still await the mandatory strong-eye re-gate ` +
          "(regate-pending without regate-passed). Dispatch the fresh-virgin adversary and " +
          "stamp regate-passed before running any delivery command " +
          "(git push / gh pr create / gh pr merge).",
      },
    };
  }
  return { allow: true };
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

  // Bash tool: delivery-bash-gate — gates delivery commands regardless of who runs them
  // (orchestrator or shipper). This closes the second delivery door: a direct git push /
  // gh pr create / gh pr merge bypasses the PreToolUse(Agent) shipper gate.
  if (payload.tool_name === "Bash") {
    return decideBash(payload, { readGateStateFn });
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

  // Gate 3: shipper is the deterministic CONSUMER of the re-gate rail. A HIGH sniper fix
  // stamps regate_pending; the mandatory strong-eye re-gate stamps regate_passed. An
  // unmatched regate_pending (pending without a matching passed) is a delivery-blocking
  // precondition — deny the shipper until every grave cheap-hand fix has been re-gated.
  if (role === "shipper") {
    let gateState = {};
    try {
      gateState = readGateStateFn(sessionId);
    } catch {
      gateState = {};
    }
    const pending = Array.isArray(gateState.regate_pending) ? gateState.regate_pending : [];
    const passed = Array.isArray(gateState.regate_passed) ? gateState.regate_passed : [];
    const unmatched = pending.filter((t) => !passed.includes(t));
    if (unmatched.length > 0) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `[entry-gate] Blocked: HIGH sniper fix(es) for task(s) ${unmatched.join(", ")} still ` +
            "await the mandatory strong-eye re-gate (regate-pending without regate-passed). " +
            "Dispatch the fresh-virgin adversary and stamp regate-passed before delivery.",
        },
      };
    }
  }

  // All other delivery roles (executor, compliance, sniper, security, harvester,
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
