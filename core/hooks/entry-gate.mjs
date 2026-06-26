/**
 * @description PreToolUse(Agent|Bash) hook — deterministic entry gate for harness delivery roles.
 *
 * Fail-open contract: exits 0 on ANY infra error. DENY is emitted ONLY in the deliberate
 * gate-decision branch. A buggy gate must never brick delivery work.
 *
 * Bash gate (delivery-bash-gate):
 *   Delivery commands (git push, gh pr create, gh pr merge) are denied when gate-state has
 *   EITHER (a) any unmatched regate_pending (a regate_pending task_id with no matching
 *   regate_passed), OR (b) any unmatched hand_finished (a hand_finished task_id with no
 *   matching capture_verified — a finished cheap-hand whose output was not independently
 *   captured/verified). The two rails fire independently. Read-only commands (git status,
 *   git diff, git log, gh pr view/list) always pass. This closes the second delivery door:
 *   a direct Bash delivery command bypasses the PreToolUse(Agent) shipper gate.
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
import { execFileSync } from "node:child_process";
import {
  isDeliveryRole,
  bareRole,
  isSafeSessionId,
  stateDirFor,
  readGateState,
  mergeGateState,
  readHandRecord,
} from "./lib/gate-lib.mjs";

/**
 * @description Outcome statuses (from dispatch-hand.mjs evaluateRun) that authorize a Claude hand
 * escape: a GENUINE run that did NOT reach DONE. FAILED = the hand produced work that's wrong
 * (scope/frozen/test violation); NOT_DONE = the hand ran but produced nothing (empty diff). Both
 * mean "the spawn happened and did not succeed" → a stronger hand should retry (K=1 escalation).
 * DONE is excluded — a successful run needs no Claude fallback. A pre-spawn config error writes NO
 * record, so it never matches → it routes to the critical-exception path instead.
 */
const AUTHORIZING_OUTCOMES = new Set(["FAILED", "NOT_DONE"]);

/**
 * @description Best-effort current-HEAD sha reader for the run-record freshness cross-check.
 * Returns null on ANY git/infra error so the freshness check fails OPEN (never bricks a legit
 * escalation) — it only ever DENIES on a POSITIVE staleness signal (known HEAD ≠ record's freeze).
 * @returns {string|null}
 */
function defaultHeadSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * HAND roles — executor, sniper, and test-author write code/tests and are normally
 * dispatched as cheap-hand spawns via spawn-hand.mjs (Ollama), NOT as main-loop Agents.
 * A main-loop Agent of one of these (no agent_id) is only the legitimate K=1
 * escalation/transcription fallback, gated below by the escalation_fallback ticket.
 * NOTE: gate-lib's isDeliveryRole is FALSE for 'test-author' (it is not in DELIVERY_ROLES),
 * so HAND_ROLES is checked independently to keep the early-allow from leaking a main-loop
 * test-author through.
 */
const HAND_ROLES = new Set(["executor", "sniper", "test-author"]);

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
// Git-state probe — branch/commit rail (production seam; injected at processInput)
// ---------------------------------------------------------------------------

/**
 * Probes the working-tree git state for the branch/commit delivery rail.
 * Returns { branch, commitsAhead } where branch is the current branch name (null when
 * detached/unknown) and commitsAhead is the count of commits HEAD is ahead of its resolved
 * base (upstream `@{u}`, else origin's default branch), or null when no base resolves. Returns
 * null on ANY git/infra error so the caller fails open (never bricks a delivery command).
 * @returns {{ branch: string|null, commitsAhead: number|null } | null}
 */
function defaultGitState() {
  const git = (args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    let base = null;
    try {
      base = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    } catch {
      try {
        base = git(["symbolic-ref", "refs/remotes/origin/HEAD"]).replace(/^refs\/remotes\//, "");
      } catch {
        base = null;
      }
    }
    let commitsAhead = null;
    if (base) {
      try {
        const count = Number.parseInt(git(["rev-list", "--count", `${base}..HEAD`]), 10);
        commitsAhead = Number.isNaN(count) ? null : count;
      } catch {
        commitsAhead = null;
      }
    }
    return { branch: branch || null, commitsAhead };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bash gate — decideBash (internal)
// ---------------------------------------------------------------------------

/**
 * Decides whether to allow or deny a Bash tool dispatch.
 * Only delivery commands (git push, gh pr create, gh pr merge) are gated; all other
 * Bash commands pass freely. A delivery command passes ONLY when BOTH rails are clear:
 * no unmatched regate (regate_pending without regate_passed) AND no unmatched capture
 * (hand_finished without capture_verified). Fail-open on any infra error (never brick
 * read-only work).
 *
 * @param {object} payload - The parsed Bash hook payload
 * @param {object} deps - Injectable seams
 * @param {function} deps.readGateStateFn - (sessionId: string) => object
 * @returns {{ allow: true }
 *         | { allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
function decideBash(payload, { readGateStateFn, gitStateFn }) {
  const command = payload?.tool_input?.command;
  // Non-string command → infra error → fail-open
  if (typeof command !== "string") {
    return { allow: true };
  }
  // Not a delivery command → allow freely (inspection, builds, tests, etc.)
  if (!isDeliveryCommand(command)) {
    return { allow: true };
  }

  // Branch/commit rail — a delivery command must run from a feature branch with committed work,
  // never from protected main/master and never with zero commits ahead of base. The gitStateFn
  // seam's decide()-level default is a no-op (() => null), so unit callers are unaffected; the
  // real git probe is injected at processInput (production). Fail-open: any probe error or
  // unresolvable base → skip (never brick a delivery command).
  let gitState = null;
  try {
    gitState = typeof gitStateFn === "function" ? gitStateFn() : null;
  } catch {
    gitState = null;
  }
  if (gitState && typeof gitState.branch === "string") {
    if (gitState.branch === "main" || gitState.branch === "master") {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `[entry-gate] Blocked: delivery command on protected branch '${gitState.branch}'. ` +
            "The per-task freeze/impl commit series must live on a feature branch — run " +
            "`git switch -c <type>/<feature-id>` (feat/fix/refactor/chore/docs) and commit the " +
            "work before any delivery command (git push / gh pr create / gh pr merge).",
        },
      };
    }
    if (gitState.commitsAhead === 0) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "[entry-gate] Blocked: delivery command with zero commits ahead of base. Commit the " +
            "task's work (the freeze/impl series) before delivering — a push/PR with no commits " +
            "ships nothing and signals the orchestrator skipped the per-task commit step.",
        },
      };
    }
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
  // Capture rail — independent of the re-gate rail. A finished cheap-hand (hand_finished)
  // whose output has not been independently captured/verified (no matching capture_verified)
  // blocks delivery. Same qualified ${feature_id}/${task_id} shape and array-diff style.
  const handFinished = Array.isArray(gateState.hand_finished) ? gateState.hand_finished : [];
  const captureVerified = Array.isArray(gateState.capture_verified) ? gateState.capture_verified : [];
  const unmatchedCapture = handFinished.filter((t) => !captureVerified.includes(t));
  if (unmatchedCapture.length > 0) {
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[entry-gate] Blocked: delivery command denied — finished cheap-hand task(s) " +
          `${unmatchedCapture.join(", ")} still await independent capture/verification ` +
          "(hand-finished without capture-verified). Independently capture the hand output and " +
          "stamp capture-verified before running any delivery command " +
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
    readHandRecordFn = readHandRecord,
    headShaFn = defaultHeadSha,
    // No-op by default so unit callers of decide() are inert to the branch/commit rail; the real
    // git probe (defaultGitState) is injected at the processInput layer (production CLI path).
    gitStateFn = () => null,
  } = deps;

  // Non-object payload → infra error → fail-open
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { allow: true };
  }

  // Bash tool: delivery-bash-gate — gates delivery commands regardless of who runs them
  // (orchestrator or shipper). This closes the second delivery door: a direct git push /
  // gh pr create / gh pr merge bypasses the PreToolUse(Agent) shipper gate.
  if (payload.tool_name === "Bash") {
    return decideBash(payload, { readGateStateFn, gitStateFn });
  }

  // Step 1: agent_id present → subagent context, always allow (no state pollution)
  if (Object.prototype.hasOwnProperty.call(payload, "agent_id")) {
    return { allow: true };
  }

  // Step 2: resolve subagent_type; non-delivery roles pass freely.
  // EXCEPTION: a HAND role (executor/sniper/test-author) is NOT early-allowed even though
  // 'test-author' is not in gate-lib's delivery-role set — the hand-routing gate below must
  // intercept all three, or a main-loop test-author would slip through this early-allow.
  const subagentType = payload?.tool_input?.subagent_type;
  if (!isDeliveryRole(subagentType) && !HAND_ROLES.has(bareRole(subagentType))) {
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

  // Hand-routing gate: executor, sniper, and test-author are HAND roles dispatched via
  // spawn-hand.mjs (Ollama cheap hands). A MAIN-LOOP Agent of one (no agent_id, hence here)
  // is only the legit K=1 escalation/transcription fallback. Per-task binding from the Agent
  // prompt prose is infeasible (untrustworthy string-match), so the binding is session-level —
  // BUT the unlock belt is NOT the ticket alone. The escalation_fallback ticket NAMES the in-flight
  // task(s); the real, NON-FORGEABLE belt is the on-disk run-record (written by runLiveDispatch's
  // INDEPENDENT capture): the Claude hand escape is authorized ONLY when a ticketed task's record
  // shows outcome === FAILED — a genuine spawn that ran and failed its locked test/exit. A
  // PRE-SPAWN CONFIG ERROR (no token, dirty baseline, gate not armed) writes NO such record, so the
  // escape is DENIED → the orchestrator must route to the critical-exception path, never a silent
  // Claude fallback. This removes the old "any non-empty escalation_fallback array unlocks"
  // looseness (an echo-forgeable ticket could fake it). Runs AFTER Gate 1 so a hand WITHOUT triage
  // still hits the triage deny first.
  if (HAND_ROLES.has(role)) {
    let gateState = {};
    try {
      gateState = readGateStateFn(sessionId);
    } catch {
      gateState = {};
    }
    const tickets = Array.isArray(gateState.escalation_fallback)
      ? gateState.escalation_fallback
      : [];
    // Read the current HEAD ONCE (best-effort) for the freshness cross-check below.
    let head = null;
    try {
      head = headShaFn();
    } catch {
      head = null;
    }
    const authorized = tickets.some((qualifiedId) => {
      let record = null;
      try {
        record = readHandRecordFn(qualifiedId);
      } catch {
        record = null;
      }
      if (!record) return false;
      // A GENUINE run that did not reach DONE (FAILED or NOT_DONE) is what authorizes the K=1
      // Claude escalation; a config error wrote no record and never lands here.
      if (!AUTHORIZING_OUTCOMES.has(record?.outcome?.status)) return false;
      // Freshness: a record is anchored to the freeze it ran against. If we can read HEAD and the
      // record is anchored, REJECT a record whose freeze differs from the current HEAD — a stale
      // FAILED from a prior run/freeze must never authorize a later, unfailed escalation. Only a
      // POSITIVE mismatch denies; an unreadable HEAD or an unanchored record fails open (the
      // ticket + genuine-failure outcome still gate it).
      if (head && record.freezeCommitSha && record.freezeCommitSha !== head) return false;
      return true;
    });
    if (authorized) {
      return { allow: true };
    }
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[entry-gate] Blocked: executor, sniper, and test-author are HAND roles dispatched via " +
          "spawn-hand.mjs (Ollama cheap hands), not main-loop Agents. A main-loop Agent of a hand " +
          "role is the K=1 escalation/transcription fallback — allowed ONLY when a stamped " +
          "escalation_fallback ticket maps to an on-disk run-record whose outcome is FAILED (a " +
          "genuine cheap-hand run that failed its locked test). No such failure evidence here. " +
          "Do NOT improvise a cause — in particular NEVER conclude 'spawn-hand.mjs is missing': it is " +
          "vendored at .claude/skills/orchestrating-delivery/references/spawn-hand.mjs and the file " +
          "exists; what is almost always missing is the Ollama token, not the script. To learn the " +
          "EXACT cause, RUN the dispatch: `node .claude/skills/orchestrating-delivery/references/" +
          "spawn-hand.mjs --descriptor <descriptor.json>` and read its exit-2 JSON `reason` (e.g. " +
          "'no ANTHROPIC_AUTH_TOKEN resolved', 'dirty baseline', 'gate not armed'). Then route that " +
          "verbatim reason to the critical-exception path: stamp `mark.mjs hand-config-error " +
          "--reason \"<reason, translated to product-language>\"` and surface it to the operator with " +
          "the fix (missing token → set ANTHROPIC_AUTH_TOKEN in ~/.claude/.dev.vars). Never a silent " +
          "Claude fallback. A genuine run that FAILED its locked test (CLI exit 1 + on-disk record) is " +
          "the ONLY thing that authorizes this Claude hand.",
      },
    };
  }

  // All other delivery roles (compliance, security, harvester, plan-reviewer) with a valid
  // Gate 1 triage → allow.
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
    // Production path: inject the real git probe so the branch/commit rail is live in the CLI,
    // while decide()'s own default stays a no-op for unit callers. An explicit deps.gitStateFn
    // (tests) overrides.
    verdict = decide(payload, { gitStateFn: defaultGitState, ...deps });
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
