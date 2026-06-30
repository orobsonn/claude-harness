/**
 * @description PreToolUse(Agent|Bash) hook — deterministic entry gate for harness delivery roles.
 *
 * Fail-open contract: exits 0 on ANY infra error. DENY is emitted ONLY in the deliberate
 * gate-decision branch. A buggy gate must never brick delivery work.
 *
 * Bash gate (delivery-bash-gate + issue-form advisory):
 *   Delivery commands (git push, gh pr create, gh pr merge) are denied when gate-state has
 *   EITHER (a) any unmatched regate_pending (a regate_pending task_id with no matching
 *   regate_passed), OR (b) any unmatched hand_finished (a hand_finished task_id with no
 *   matching capture_verified — a finished cheap-hand whose output was not independently
 *   captured/verified). The two rails fire independently. Read-only commands (git status,
 *   git diff, git log, gh pr view/list) always pass. This closes the second delivery door:
 *   a direct Bash delivery command bypasses the PreToolUse(Agent) shipper gate.
 *   Additionally, a non-blocking issue-form advisory is emitted on bare `gh issue create`
 *   (allow + additionalContext, never deny) when the repo vendors the harness issue form
 *   (.github/ISSUE_TEMPLATE/harness-task.yml). A composite command containing both
 *   `gh issue create` and a delivery verb always hits the delivery deny rails — the advisory
 *   attaches ONLY at the non-delivery allow return, never on a delivery-command string.
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
 * @description Detects HEADLESS (cloud routine) mode. Cheap hands is a LOCAL-only capability; in
 * the cloud the hand roles (executor/sniper/test-author) run on Claude directly, so a main-loop
 * Agent of a hand role is the INTENDED dispatch there, not a fallback to police. Signal is
 * `$CLAUDE_CODE_REMOTE` — the same one the entry policy (core/CLAUDE.md) documents for mode
 * detection. Injectable via decide()'s deps for tests.
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
function defaultIsHeadless(env = process.env) {
  return Boolean(env?.CLAUDE_CODE_REMOTE);
}

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
// Descriptor reader — fidelity rail (production seam; injectable for tests)
// ---------------------------------------------------------------------------

/**
 * @description Reads and parses a spawn-hand.mjs descriptor JSON file from disk.
 * Returns the parsed object on success, or null on ANY error (missing/unparseable).
 * Fail-open — callers treat a null return as "unreadable → allow" (never brick a spawn).
 * @param {string} descriptorPath - Path to the descriptor JSON file (from --descriptor flag)
 * @returns {object|null}
 */
function defaultReadDescriptor(descriptorPath) {
  try {
    const raw = fs.readFileSync(descriptorPath, "utf8");
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
// Git-state probe — branch/commit rail (production seam; injected at processInput)
// ---------------------------------------------------------------------------

/**
 * @description Computes git state (branch name and commits-ahead count) using an injected
 * git runner. The merge base is always resolved from origin's default branch — never from
 * the feature branch's own upstream (`@{u}`), which equals HEAD after `git push` and would
 * incorrectly report 0 commits ahead, blocking a legitimate delivery.
 *
 * Base resolution order (first that succeeds wins):
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` → strip `refs/remotes/` prefix (e.g. `origin/main`)
 *   2. `git rev-parse --verify --quiet origin/main` (common default)
 *   3. `git rev-parse --verify --quiet origin/master` (legacy default)
 *   4. base = null → commitsAhead = null, defaultBranch = null (fail-open; consumer skips the ahead check)
 *
 * Limitation: `defaultBranch` is reliable only when `origin/HEAD` is set locally (only `git clone` sets it).
 * When unset, fallbacks match by mere ref existence — in a repo whose real default is not `main`/`master`
 * but stale copies exist, `defaultBranch` mis-derives and the protected-branch floor may under-deny
 * delivery from the true default. Fixing via `git ls-remote --symref origin HEAD` adds a network call — deferred.
 *
 * @param {(args: string[]) => string} git - Runner: takes args array, returns trimmed stdout, throws on git failure
 * @returns {{ branch: string|null, commitsAhead: number|null, defaultBranch: string|null }}
 *   branch - current HEAD branch name, or null when detached
 *   commitsAhead - number of commits HEAD is ahead of origin default, or null when base is unresolvable
 *   defaultBranch - bare name of origin's default branch (e.g. "main", "develop"), or null when base is unresolvable
 */
export function computeGitState(git) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

  let base = null;
  try {
    const headRef = git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    base = headRef.replace(/^refs\/remotes\//, "");
  } catch {
    // origin/HEAD not set (common — only `git clone` sets it); try known defaults in order
    for (const fallback of ["origin/main", "origin/master"]) {
      try {
        git(["rev-parse", "--verify", "--quiet", fallback]);
        base = fallback;
        break;
      } catch {
        // continue to next fallback
      }
    }
  }

  // Derive the bare default-branch name by stripping the remote prefix (e.g. "origin/develop" → "develop").
  // Handles any remote name, not just "origin". Null when base is unresolvable.
  const defaultBranch = base ? base.replace(/^[^/]+\//, "") : null;

  let commitsAhead = null;
  if (base !== null) {
    try {
      const count = Number.parseInt(git(["rev-list", "--count", `${base}..HEAD`]), 10);
      commitsAhead = Number.isNaN(count) ? null : count;
    } catch {
      commitsAhead = null;
    }
  }

  return { branch: branch || null, commitsAhead, defaultBranch };
}

/**
 * Probes the working-tree git state for the branch/commit delivery rail.
 * Returns { branch, commitsAhead, defaultBranch } where branch is the current branch name
 * (null when detached/unknown), commitsAhead is the count of commits HEAD is ahead of the
 * origin default branch (resolved via origin/HEAD, then origin/main, then origin/master;
 * never the feature branch's own upstream @{u}, which would be 0 after git push), and
 * defaultBranch is the bare name of origin's default branch (e.g. "main", "develop"; null
 * when the base is unresolvable). Returns null on ANY git/infra error so the caller fails
 * open (never bricks a delivery command).
 * @returns {{ branch: string|null, commitsAhead: number|null, defaultBranch: string|null } | null}
 */
function defaultGitState() {
  const git = (args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return computeGitState(git);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Issue-form advisory — adviseIssueForm (pure, exported for tests)
// ---------------------------------------------------------------------------

const ISSUE_FORM_ADVISORY =
  "This repo vendors the Claude Harness issue form (.github/ISSUE_TEMPLATE/harness-task.yml). " +
  "Prefer creating issues through it so they enter the autonomous routine. " +
  "The `gh issue create` CLI bypasses issue forms silently — if you proceed, replicate the form: " +
  "title `[harness] <slug>`, label `harness:ready`, and a body with #uj-N journeys, " +
  "#ac-N.M acceptance criteria, scope, sensitive domain, priority, and size " +
  "(these become the spec, locked_tests and scope_paths).";

/**
 * @description Returns true when .github/ISSUE_TEMPLATE/harness-task.yml exists in cwd.
 * Fail-open on any FS error (returns false → no nudge).
 * @param {string} cwd
 * @returns {boolean}
 */
function defaultIssueFormExists(cwd) {
  try {
    return fs.existsSync(path.join(cwd, ".github/ISSUE_TEMPLATE/harness-task.yml"));
  } catch {
    return false;
  }
}

/** @description Best-effort advisory: nudge toward the harness issue form when an agent runs
 * `gh issue create` in a repo that vendors the form. Returns the advisory string, or null when
 * no nudge applies. Regex detection is best-effort (may match the phrase inside quoted text) —
 * acceptable because the result is a NON-blocking hint, never a deny. */
export function adviseIssueForm(command, cwd, existsFn = defaultIssueFormExists) {
  if (typeof command !== "string") return null;
  if (!/\bgh\s+issue\s+create\b/.test(command)) return null;
  if (/harness:ready/.test(command)) return null; // already following convention → no nag/re-nudge
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null; // relative/absent cwd → fail-open, no nudge
  if (!existsFn(cwd)) return null; // portable: no form vendored → no nudge
  return ISSUE_FORM_ADVISORY;
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
 * Additionally, spawn-hand.mjs dispatches are gated by the fidelity rail: the task's
 * fidelity-pass must be stamped in gate-state before the cheap-hand executor can run.
 * Fail-open on unreadable descriptor — never brick a legit spawn.
 *
 * @param {object} payload - The parsed Bash hook payload
 * @param {object} deps - Injectable seams
 * @param {function} deps.readGateStateFn - (sessionId: string) => object
 * @param {function} deps.readDescriptorFn - (descriptorPath: string) => object|null
 * @param {function} deps.adviseIssueFormFn - (command: string, cwd: string) => string|null
 * @returns {{ allow: true }
 *         | { allow: true, hookSpecificOutput: { hookEventName: string, additionalContext: string } }
 *         | { allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
function decideBash(payload, { readGateStateFn, gitStateFn, readDescriptorFn, adviseIssueFormFn }) {
  const command = payload?.tool_input?.command;
  // Non-string command → infra error → fail-open
  if (typeof command !== "string") {
    return { allow: true };
  }

  // Fidelity rail — spawn-hand.mjs dispatch is gated until the task's fidelity-pass is stamped.
  // MUST come before the isDeliveryCommand check because spawn-hand.mjs is NOT a delivery
  // command and would otherwise be allowed freely.
  //
  // Deliberate fail-policy split (defense-in-depth; backed by spawn-hand.mjs's own locked_test
  // fail-close):
  //   • No --descriptor flag  → fail-OPEN (allow). A read-only command such as `cat spawn-hand.mjs`
  //     or `grep spawn-hand.mjs` carries no --descriptor and must never be denied.
  //   • --descriptor present but unreadable / not valid JSON / not an object / non-string ids
  //     → fail-CLOSED (DENY). A legitimate executor dispatch ALWAYS supplies a readable descriptor
  //     with string ids; an unreadable one is either a bug or a bypass attempt. This default matches
  //     the headless executor deny default — "evidence required but absent" → deny.
  //   • --descriptor present and yields valid <feature_id>/<task_id> → check fidelity_pass; deny
  //     if absent, allow if present (existing behavior, unchanged).
  if (command.includes("spawn-hand.mjs")) {
    const descriptorMatch = command.match(/--descriptor\s+(\S+)/);
    if (!descriptorMatch) {
      // No --descriptor arg → fail-open (read-only commands like cat/grep must pass freely)
      return { allow: true };
    }
    const descriptorPath = descriptorMatch[1];
    let descriptor = null;
    try {
      descriptor = typeof readDescriptorFn === "function" ? readDescriptorFn(descriptorPath) : null;
    } catch {
      descriptor = null;
    }
    // --descriptor present but unreadable / invalid → fail-CLOSED (deny).
    // A legitimate spawn-hand executor dispatch always has a readable descriptor with string ids;
    // an unreadable/missing descriptor cannot satisfy the fidelity check — matches the headless
    // executor deny default for the same "evidence required but absent" condition.
    if (
      descriptor === null ||
      typeof descriptor.feature_id !== "string" ||
      typeof descriptor.task_id !== "string"
    ) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "[entry-gate] Blocked: spawn-hand.mjs dispatch denied — --descriptor flag was present " +
            `but the descriptor at '${descriptorPath}' could not be resolved to a qualified ` +
            "feature_id/task_id (missing file, invalid JSON, or non-string ids). " +
            "The fidelity check requires a readable descriptor with string feature_id and task_id. " +
            "Ensure the descriptor JSON exists and is well-formed before dispatching.",
        },
      };
    }
    const qualifiedId = `${descriptor.feature_id}/${descriptor.task_id}`;
    const spawnSessionId = payload.session_id;
    let spawnGateState = {};
    if (
      typeof spawnSessionId === "string" &&
      spawnSessionId.length > 0 &&
      isSafeSessionId(spawnSessionId)
    ) {
      try {
        spawnGateState = readGateStateFn(spawnSessionId);
      } catch {
        spawnGateState = {};
      }
    }
    const fidelityPass = Array.isArray(spawnGateState.fidelity_pass) ? spawnGateState.fidelity_pass : [];
    if (!fidelityPass.includes(qualifiedId)) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `[entry-gate] Blocked: spawn-hand.mjs dispatch denied — fidelity-pass for task ` +
            `${qualifiedId} has not been stamped. Dispatch the test-author first to produce ` +
            `a failing locked test, then stamp fidelity-pass ` +
            `(mark.mjs fidelity-pass --feature-id ${descriptor.feature_id} --task-id ${descriptor.task_id}) ` +
            `before dispatching the executor cheap-hand.`,
        },
      };
    }
    return { allow: true };
  }

  // Not a delivery command → allow freely (inspection, builds, tests, etc.).
  // Attach a non-blocking advisory when the command looks like `gh issue create` in a repo
  // that vendors the harness issue form — nudge toward the form without ever denying.
  // NOTE: advisory MUST attach ONLY here, at the non-delivery allow return. A composite command
  // like `gh issue create && git push` IS a delivery command (isDeliveryCommand matches `git push`
  // anywhere), so it keeps flowing into the delivery deny rails below and never receives the advisory.
  if (!isDeliveryCommand(command)) {
    const advisory = typeof adviseIssueFormFn === "function"
      ? adviseIssueFormFn(command, payload.cwd)
      : null;
    if (advisory) {
      return {
        allow: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: advisory },
      };
    }
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
    const isDefaultBranch =
      gitState.branch === "main" ||
      gitState.branch === "master" ||
      (typeof gitState.defaultBranch === "string" && gitState.branch === gitState.defaultBranch);
    if (isDefaultBranch) {
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
    isHeadlessFn = defaultIsHeadless,
    // No-op by default so unit callers of decide() are inert to the branch/commit rail; the real
    // git probe (defaultGitState) is injected at the processInput layer (production CLI path).
    gitStateFn = () => null,
    // Reads the spawn-hand.mjs descriptor JSON from disk; injectable for tests.
    readDescriptorFn = defaultReadDescriptor,
    // No-op by default (mirrors gitStateFn's inert default for unit callers). The real FS probe
    // (defaultIssueFormExists) is injected at the processInput layer (production CLI path).
    issueFormExistsFn = () => false,
  } = deps;

  // Non-object payload → infra error → fail-open
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { allow: true };
  }

  // Bash tool: delivery-bash-gate + fidelity rail + issue-form advisory.
  // The delivery-bash-gate closes the second delivery door (a direct git push / gh pr create /
  // gh pr merge bypasses the Agent shipper gate). The fidelity rail gates spawn-hand.mjs
  // dispatches until the task's fidelity-pass is stamped (test-author must produce a red locked
  // test first). The advisory nudges toward the harness issue form on bare `gh issue create`.
  const adviseIssueFormFn = (cmd, cwd) => adviseIssueForm(cmd, cwd, issueFormExistsFn);
  if (payload.tool_name === "Bash") {
    return decideBash(payload, { readGateStateFn, gitStateFn, readDescriptorFn, adviseIssueFormFn });
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
    // test-author is dispatched as a main-loop Claude Agent in BOTH local and headless. It is the
    // PRODUCER of the fidelity-pass (it authors the red locked test, validated by the compliance eye in
    // step 1b), so it must never be blocked by the fidelity rail it serves — and it has NO spawn-hand
    // path: runLiveDispatch requires a frozen test that does not yet exist at author time. Its safety
    // controls are the compliance eye (step 1b) + the freeze content-hash (step 1c), not the executor's
    // run-record rail. Gate 1 (triage) already ran above, so this only bypasses the hand-routing rail —
    // for the one role that rail must not gate.
    if (role === "test-author") {
      return { allow: true };
    }

    // HEADLESS: cheap hands is a LOCAL-only capability. In the cloud there is no Ollama hand, so the
    // hand roles run on the standard Claude model — a main-loop Agent(executor|sniper|test-author) is
    // the INTENDED dispatch, not a silent fallback to deny.
    if (isHeadlessFn()) {
      // test-author (the fidelity-pass producer) and sniper (the post-gate fixer) are unconditionally
      // allowed in headless — they must never be blocked by the fidelity rail they serve. Only the
      // executor consumer is gated: it must not run before the test-author has produced a red test.
      if (role !== "executor") {
        return { allow: true };
      }
      // Headless executor: additionally requires at least one fidelity_pass entry for the current
      // triage's feature_id. This ensures the test-author has produced a failing locked test before
      // the executor writes implementation code in the cloud. Qualified-id match (not just non-empty):
      // fidelity_pass entries for OTHER features never unlock this session's executor.
      let headlessGateState = {};
      try {
        headlessGateState = readGateStateFn(sessionId);
      } catch {
        headlessGateState = {};
      }
      const fidelityPassArr = Array.isArray(headlessGateState.fidelity_pass)
        ? headlessGateState.fidelity_pass
        : [];
      const featureIdFromTriage = typeof triage?.feature_id === "string" ? triage.feature_id : null;
      // A fidelity_pass entry belongs to this feature when its qualified id starts with `<feature_id>/`.
      const hasFidelityMatch =
        featureIdFromTriage !== null &&
        fidelityPassArr.some((id) => id.startsWith(`${featureIdFromTriage}/`));
      if (!hasFidelityMatch) {
        return {
          allow: false,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              `[entry-gate] Blocked: headless executor denied — no fidelity-pass found for feature ` +
              `'${featureIdFromTriage ?? "<unknown>"}'. The test-author must run first to author ` +
              `a failing locked test and stamp fidelity-pass ` +
              `(mark.mjs fidelity-pass --feature-id <feature-id> --task-id <task-id>) before the ` +
              `executor is dispatched. The fidelity rail ensures the executor always inherits a ` +
              `pre-authored red test — never writes implementation code with nothing to be green against.`,
          },
        };
      }
      return { allow: true };
    }
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
          "the fix (missing token → `export OLLAMA_HAND_TOKEN=…` in the shell rc — env survives the " +
          "command-sandbox; a token in .dev.vars does NOT, because the sandbox denies reading it). " +
          "Never a silent Claude fallback. A genuine run that FAILED its locked test (CLI exit 1 + " +
          "on-disk record) is the ONLY thing that authorizes this Claude hand.",
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
    // Production path: inject the real git probe and real FS probe so the branch/commit rail
    // and issue-form advisory are live in the CLI, while decide()'s own defaults stay no-ops
    // for unit callers. Explicit deps (tests) override both.
    verdict = decide(payload, {
      gitStateFn: defaultGitState,
      issueFormExistsFn: defaultIssueFormExists,
      ...deps,
    });
  } catch {
    // Unexpected error in decide — fail-open
    return { exitCode: 0, output: null };
  }

  // Emit hookSpecificOutput whenever present — covers BOTH deny (permissionDecision:deny) and
  // allow+advisory (additionalContext, no permissionDecision). A plain allow has no hookSpecificOutput.
  if (verdict.hookSpecificOutput) {
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
