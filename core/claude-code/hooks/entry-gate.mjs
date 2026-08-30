/**
 * @description PreToolUse(Agent|Bash) hook — deterministic entry gate for harness delivery roles.
 *
 * Fail-open contract: exits 0 on ANY infra error. DENY is emitted ONLY in the deliberate
 * gate-decision branch. A buggy gate must never brick delivery work.
 *
 * Deliberate-DENY exception — corrupt gate-state CONTENT (not an infra error): a READABLE
 * gate-state whose `regate_pending` is present but NOT a JSON array (null/string/number/object)
 * is a data bug, not an unreadable-file infra error, and is DENIED fail-closed with a
 * diagnosable reason (token "gate-state corrupted" + the truncated raw value + a repair/delete
 * instruction), via the shared classifyRegatePending / corruptRegatePendingDeny helpers at both
 * read sites. The infra-error path (readGateState → {}) leaves regate_pending ABSENT (undefined)
 * and stays fail-OPEN — only a present-but-non-array value fails closed. This is the explicit
 * exception to the "readable file → fail open" line above: silently coercing a corrupt non-array
 * to [] would re-open the regate-pending delivery door the gate exists to hold.
 *
 * Bash gate (delivery-bash-gate + issue-form advisory + #808 queue-contamination rail):
 *   Delivery commands (git push, gh pr create, gh pr merge) are denied when gate-state has
 *   any unmatched regate_pending (a regate_pending task_id with no matching regate_passed).
 *   Capture is guarded by the real-file rail (the on-disk run-record), NOT by an
 *   hand_finished-vs-capture_verified array-diff — that rail was removed; see the comment at
 *   its former site in decideBash for why. Read-only commands (git status,
 *   git diff, git log, gh pr view/list) always pass. This closes the second delivery door:
 *   a direct Bash delivery command bypasses the PreToolUse(Agent) shipper gate.
 *   Additionally, a non-blocking issue-form advisory is emitted on bare `gh issue create`
 *   (allow + additionalContext, never deny) when the repo vendors the harness issue form
 *   (.github/ISSUE_TEMPLATE/harness-task.yml). A composite command containing both
 *   `gh issue create` and a delivery verb always hits the delivery deny rails — the advisory
 *   attaches ONLY at the non-delivery allow return, never on a delivery-command string.
 *   #808 queue-contamination rail: `gh issue create|new|edit` (or `gh api …labels…`, or a
 *   `submit-issue.mjs` invocation) that would ATTACH a `harness:*` label is DENIED — fail-closed,
 *   never fail-open — when the caller is a SUBAGENT (payload.agent_id present, e.g. the
 *   harvester) OR a HARNESS ROUTINE session (isRoutineFn). `harness:ready` is exactly the label
 *   the autonomous selector (core/orca/select-and-dispatch.mjs) picks up, so a labelled harvest
 *   finding would queue the engine's own future work as its own next delivery. `--remove-label`
 *   is never matched (un-queuing is always safe). A plain interactive main-loop session
 *   (#ac-3.2) is untouched. See detectHarnessLabelWrite / HARNESS_LABEL_DENY_REASON.
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
  listHandRecordsForFeature,
  matchesAbsolution,
  absolutionPrefix,
} from "./lib/gate-lib.mjs";
import {
  classifyRegatePending,
  serializeRawRegatePending,
  corruptRegatePendingReason,
} from "../../shared/lib/regate-classify.mjs";
import { computeGitState } from "../../shared/lib/git-state.mjs";
import { readActiveHandFamily } from "../../shared/lib/hand-model-ladder.mjs";
import { checkRealFileCaptureRail as sharedCheckRealFileCaptureRail } from "../../shared/lib/real-file-capture-rail.mjs";
import { decideMergeChecks, isGhPrMergeCommand, mergeTargetFromCommand } from "../../shared/lib/merge-check-gate.mjs";

export { classifyRegatePending, computeGitState };

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
 * @description Builds the deliberate-DENY verdict for a CORRUPT regate_pending and logs the raw
 * value to stderr (stdout stays reserved for the decision JSON). Reason text comes from shared
 * corruptRegatePendingReason (1:1 with OC). classifyRegatePending is re-exported from
 * core/shared/lib/regate-classify.mjs.
 * @param {unknown} raw
 * @returns {{ allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
function corruptRegatePendingDeny(raw) {
  const truncated = serializeRawRegatePending(raw);
  console.error(
    `[entry-gate] gate-state corrupted: regate_pending is not a JSON array (raw=${truncated}). ` +
      "Repair or delete gate-state.json (regate_pending must be a JSON array), then re-stamp the pending re-gate.",
  );
  return {
    allow: false,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: corruptRegatePendingReason(raw),
    },
  };
}

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
 * @description Detects a HARNESS ROUTINE (headless-local / cloud cron) session — the sessions
 * in which a ScheduleWakeup would silently die (it does NOT re-invoke the assistant under
 * `claude -p`). The VPS cron dispatch deliberately does NOT set $CLAUDE_CODE_REMOTE (that would
 * disable cheap hands), but it DOES set $HARNESS_NOTIFY_PROJECT and usually
 * $HARNESS_OBSERVABILITY_RUN_PATH in the session env — so the routine signal is ANY of the three
 * markers. Fail-open (returns false → allow) when env is unavailable. Injectable via decide()'s
 * deps for tests (mirrors defaultIsHeadless's env seam).
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function isRoutineSession(env = process.env) {
  if (!env) return false;
  return Boolean(
    env.CLAUDE_CODE_REMOTE || env.HARNESS_NOTIFY_PROJECT || env.HARNESS_OBSERVABILITY_RUN_PATH,
  );
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
 * @description Best-effort ancestor probe for scoping the real-file capture check to the
 * current branch's lineage. Returns true when `sha` is an ancestor of (or equal to) HEAD,
 * false when git POSITIVELY determines it is not (exit 1 — the definitive, safe-to-deny
 * signal), or null on any other error (bad sha, git failure) so the caller fails OPEN
 * (skips that record rather than denying on an undetermined answer).
 * @param {string} sha
 * @returns {boolean|null}
 */
function defaultIsAncestor(sha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (err) {
    if (err?.status === 1) return false;
    return null;
  }
}

/**
 * @description CC adapter over shared checkRealFileCaptureRail (option A dual-shape + freeze-deny).
 * Maps shared { decision:"deny", reason } → CC hookSpecificOutput deny shape. Null when clear.
 * @param {string} featureId
 * @param {{ listHandRecordsForFeatureFn: function, isAncestorFn: function }} deps
 * @returns {null | { allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
function checkRealFileCaptureRail(featureId, { listHandRecordsForFeatureFn, isAncestorFn }) {
  const shared = sharedCheckRealFileCaptureRail(featureId, {
    listHandRecordsForFeatureFn,
    isAncestorFn,
  });
  if (shared === null) return null;
  return {
    allow: false,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: shared.reason,
    },
  };
}

/**
 * HAND roles — executor, sniper, and test-author write code/tests. On the OLLAMA hand family they
 * are dispatched as cheap-hand spawns via spawn-hand.mjs, NOT as main-loop Agents.
 * A main-loop Agent of one of these (no agent_id) is only the legitimate K=1
 * escalation/transcription fallback, gated below by the escalation_fallback ticket.
 * NOTE: gate-lib's isDeliveryRole is FALSE for 'test-author' (it is not in DELIVERY_ROLES),
 * so HAND_ROLES is checked independently to keep the early-allow from leaking a main-loop
 * test-author through.
 */
const HAND_ROLES = new Set([
  "executor",
  "sniper",
  "test-author",
  // The `-high` variants are the same roles at `effort: xhigh` (the Agent tool takes a model
  // override but no effort, so the rung's effort lives in the agent definition's frontmatter).
  // They must be gated identically — a rail that only knew `executor` would let `executor-high`
  // walk straight past it.
  "executor-high",
  "sniper-high",
]);

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
 * Probes the working-tree git state for the branch/commit delivery rail.
 * computeGitState is re-exported from core/shared/lib/git-state.mjs.
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

/** @description One direct GitHub read; the shared policy denies absent evidence. */
function defaultMergeCheckRollup(target, cwd) {
  try {
    const output = execFileSync(
      "gh",
      ["pr", "view", ...(target === null ? [] : [target]), "--json", "statusCheckRollup"],
      { cwd: typeof cwd === "string" ? cwd : process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 },
    );
    return JSON.parse(output)?.statusCheckRollup;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Issue-form advisory — adviseIssueForm (pure, exported for tests)
// ---------------------------------------------------------------------------

const ISSUE_FORM_ADVISORY =
  "This repo vendors the Claude Harness issue form (.github/ISSUE_TEMPLATE/harness-task.yml). " +
  "Prefer creating issues through it so they enter the autonomous routine — or run the " +
  "`creating-issues` skill, which authors them to standard for you. " +
  "The `gh issue create` CLI bypasses issue forms silently — if you proceed, replicate the form: " +
  "title `[harness] <slug>`, label `harness:ready`, and a body with #uj-N journeys, " +
  "#ac-N.M acceptance criteria, scope, sensitive domain, priority, and size " +
  "(these become the spec, locked_tests and scope_paths). " +
  "Size each issue as ONE independently-shippable, independently-revertible outcome (≤ ~400 changed " +
  "lines): if you can name two things that could merge separately, they are two issues — retry, " +
  "partial delivery and merge blast radius are all per-issue, so prefer small over one big issue that is cohesive only by theme. " +
  "For a CHAINED ROADMAP, create EVERY issue with `harness:ready` (never `harness:queued` by hand) " +
  "and, in each dependent issue's body, declare its prerequisites in a fenced ```harness-deps block " +
  "(one `#N` per line). The engine gates order and serialization on its own — a dependent is held " +
  "until every prerequisite's PR merges, and only one issue is built at a time. After creating the " +
  "roadmap, run `node core/vps/chain-validate.mjs --config <project.json>` to catch dependency " +
  "cycles and non-existent references before the engine runs.";

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

// #808: a HARNESS ROUTINE / subagent session (harvester and friends) reads a DIFFERENT advisory
// than the interactive operator. The interactive text stays byte-identical to before (zero
// regression on the operator's sanctioned `harness:ready` + chained-roadmap path, #ac-3.2) — this
// is a SEPARATE constant, not a reword, because a single text cannot honestly serve both
// audiences: the routine path must never be told "create EVERY issue with `harness:ready`" (the
// exact prompt-level instruction that produced the incident, oraculo-app #401), while the
// interactive path still needs that instruction for its legitimate chained-roadmap use.
const ROUTINE_ISSUE_ADVISORY =
  "You are in a harness ROUTINE session (headless-local / cloud cron), so the issue you are about " +
  "to open is a RUN FINDING, not operator-authored work: it takes NO `harness:*` label at all. " +
  "The selector only picks `harness:ready`, so a labelled issue becomes the engine's next " +
  "autonomous delivery — work no human decided should exist. The entry-gate DENIES a `--label` / " +
  "`--add-label` carrying `harness:*` here, so do not try. Before creating anything, search for an " +
  "existing open issue and let that search show up in the transcript: `gh issue list --state open " +
  "--limit 50 --search \"<file basename>\" --json number,title,url,labels`. Match on FILE + " +
  "SYMPTOM, never on line number — the same defect moves between lines. On a hit, add the new " +
  "evidence as a comment on that issue (`gh issue comment <N> --body-file <path>`); never close " +
  "it and never rewrite its body. On a miss, create it label-free: `gh issue create --title " +
  "\"[harness] <slug>\" --body-file <path>`, replicating the form's body (#uj-N, #ac-N.M, scope, " +
  "sensitive domain, priority, size). Report in your summary that it was opened without a label, " +
  "so the operator knows it is waiting for his decision.";

/** @description Best-effort advisory: nudge toward the harness issue form when an agent runs
 * `gh issue create` in a repo that vendors the form. Returns the advisory string, or null when
 * no nudge applies. Regex detection is best-effort (may match the phrase inside quoted text) —
 * acceptable because the result is a NON-blocking hint, never a deny.
 * @param {string} command
 * @param {string} cwd
 * @param {function} [existsFn]
 * @param {boolean} [isRoutine] - #808: selects ROUTINE_ISSUE_ADVISORY over ISSUE_FORM_ADVISORY.
 *   Defaults to false so every pre-existing 3-arg call site keeps its current (interactive)
 *   expectation unchanged. NOTE: the `harness:ready` early-return below is only a NON-nudge on the
 *   routine path when a bare mention appears with no label flag (e.g. inside `--body` prose) — the
 *   mechanical deny rail in decideBash fires first whenever an actual `--label`/`--add-label`
 *   flag is present, so this early-return is not unreachable, just secondary to the deny. */
export function adviseIssueForm(command, cwd, existsFn = defaultIssueFormExists, isRoutine = false) {
  if (typeof command !== "string") return null;
  if (!/\bgh\s+issue\s+create\b/.test(command)) return null;
  if (/harness:ready/.test(command)) return null; // already following convention → no nag/re-nudge
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null; // relative/absent cwd → fail-open, no nudge
  if (!existsFn(cwd)) return null; // portable: no form vendored → no nudge
  return isRoutine ? ROUTINE_ISSUE_ADVISORY : ISSUE_FORM_ADVISORY;
}

// ---------------------------------------------------------------------------
// #808 queue-contamination rail — detectHarnessLabelWrite (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * @description Matches an ADD-shaped label flag and captures its raw value. Deliberately global
 * (`g`) — a command may repeat `--label`, and only ONE occurrence needs to carry a harness label.
 * Covers every real gh/cobra shape: `--label v`, `--label=v`, `-l v`, `-l=v`, `-lv`,
 * `--add-label v` (issue edit), quoted values, and comma-joined lists. `--remove-label` is NOT
 * matched (un-queuing is always safe) — the alternation requires a `--label` / `--add-label` / `-l`
 * token preceded by start-of-string or a shell separator, and inside `--remove-label` neither
 * `--label` nor `-l` sits on such a boundary.
 */
const HARNESS_LABEL_FLAG_RE =
  /(?:^|[\s;|&(])(?:--label|--add-label|-l)(?:=\s*|\s+)?("[^"]*"|'[^']*'|[^\s;|&)]+)/gi;

/** @description gh verbs that can attach a label at write time. `new` is not a real gh verb but
 * is a common operator alias for `create`; matching it costs nothing and closes that shape. */
const ISSUE_WRITE_VERB_RE = /\bgh\s+issue\s+(?:create|new|edit)\b/i;

/** @description `gh api` can attach a label off the beaten `gh issue` path entirely
 * (`gh api repos/o/r/issues/N/labels -f "labels[]=harness:ready"`). There is zero legitimate
 * in-session traffic on this shape (`grep -rn "add-label\|--label\|remove-label" core/claude-code
 * core/opencode --include=*.md` has no hits at all), so any `gh api` call that mentions `label(s)`
 * anywhere in the command is treated as an unconditional harness-label write — see the
 * REQUIRED-CORRECTIONS fail-closed note on `detectHarnessLabelWrite` below. */
const GH_API_LABEL_RE = /\bgh\s+api\b[\s\S]*\blabels?\b/i;

/** @description `submit-issue.mjs` (the OpenCode lane's ONLY sanctioned issue-submission path,
 * `core/opencode/rules/creating-issues.md`) hardcodes `harness:ready` internally
 * (`submit-issue.mjs:18`) and shells nothing — its Bash command string carries no `--label` flag
 * at all, so the flag-based detector below is blind to it. Matched by name (mirrored into the OC
 * lane's own copy of this function for parity) so a harvest that shells out to the submitter is
 * still caught. Kept here too, even though the CC lane has no such submitter today
 * (`core/claude-code/skills/creating-issues/references/` does not exist), so the two lanes'
 * detectors do not diverge on this shape by accident. */
const SUBMITTER_RE = /\bsubmit-issue\.mjs\b/i;

/**
 * @description Returns the first `harness:*` label a `gh issue create|new|edit` command (or an
 * off-path `gh api …labels…` / `submit-issue.mjs` invocation) would ATTACH, or null. Pure and
 * exported for tests. Never throws.
 *
 * Fail-CLOSED on an unresolvable value (`$VAR`, `` `cmd` ``, `$(cmd)`): this file's own
 * descriptor rail already establishes "evidence required but absent → deny", and a value we
 * cannot statically read is exactly that — silently allowing it would let
 * `L=harness:ready; gh issue create --label $L` walk straight through. The sentinel is passed as
 * the "label" through to the deny reason so the caller sees why (§1.5's accepted-gap list: this
 * closes the cheap, common indirection shapes, not full shell evaluation).
 * @param {unknown} command
 * @returns {string|null}
 */
export function detectHarnessLabelWrite(command) {
  if (typeof command !== "string") return null;
  // Off-path shapes first: neither carries a `--label` flag the regex below could see.
  if (SUBMITTER_RE.test(command)) return "harness:ready";
  if (GH_API_LABEL_RE.test(command)) return "<unresolvable label value>";
  if (!ISSUE_WRITE_VERB_RE.test(command)) return null;
  HARNESS_LABEL_FLAG_RE.lastIndex = 0; // a `g` regex carries state between calls
  let m;
  while ((m = HARNESS_LABEL_FLAG_RE.exec(command)) !== null) {
    const raw = m[1].replace(/^["']|["']$/g, "");
    for (const part of raw.split(",")) {
      const label = part.trim();
      if (/[$`]/.test(label)) return "<unresolvable label value>"; // fail-closed: can't statically read it
      if (/^harness:[A-Za-z0-9._-]+$/i.test(label)) return label;
    }
  }
  return null;
}

/** @description Deny-reason builder for the #808 queue-contamination rail. Tells the caller
 * WHAT to do instead (search → comment-on-hit / create-label-free-on-miss), matching this file's
 * convention that every deny names the escape route, not just the block. */
const HARNESS_LABEL_DENY_REASON = (label) =>
  `[entry-gate] Blocked: attaching \`${label}\` to a GitHub issue from a subagent or a harness ` +
  "routine (headless-local / cloud cron) session. `harness:ready` is exactly the label the " +
  "autonomous queue selector picks up, so an issue labelled by the run puts the engine's own " +
  "future work into the engine's own queue — the next tick delivers a backlog item no human " +
  "decided should exist. `harness:queued`, `harness:in-progress`, `harness:blocked` and " +
  "`harness:done` are the engine's own vocabulary and are never written by hand either. RECORD " +
  "THE FINDING ANYWAY — the record has value, the queue entry does not. (1) SEARCH first, so the " +
  "dedup is auditable in the transcript: `gh issue list --state open --limit 50 --search \"<file " +
  "basename>\" --json number,title,url,labels`. (2) On a HIT (same file + same symptom — never " +
  "compare line numbers, they drift), post the new evidence as a COMMENT on the existing issue " +
  "(`gh issue comment <N> --body-file <path>`) and create nothing; never close it, never rewrite " +
  "its body. (3) On a MISS, create it with NO label at all: " +
  "`gh issue create --title \"[harness] <slug>\" --body-file <path>` — no `--label` flag. " +
  "The issue is inert without the label (the selector only picks `harness:ready`) and waits for " +
  "the operator, who applies the label by hand when he decides it should be delivered. Say in " +
  "your summary that you opened it label-free, so it is not an inert issue nobody knows about. " +
  "This rail does not apply to a plain interactive main-loop session.";

// ---------------------------------------------------------------------------
// Bash gate — decideBash (internal)
// ---------------------------------------------------------------------------

/**
 * Decides whether to allow or deny a Bash tool dispatch.
 * Only delivery commands (git push, gh pr create, gh pr merge) are gated; all other
 * Bash commands pass freely. A delivery command passes ONLY when BOTH rails are clear:
 * no unmatched regate (regate_pending without regate_passed) AND the real-file capture rail
 * (on-disk run-records) finds nothing wrong. Fail-open on any infra error (never brick
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
 * @param {function} deps.isRoutineFn - () => boolean — #808 queue-contamination rail's routine
 *   detector (shared with the ScheduleWakeup death rail); combined with subagent-context
 *   detection (payload.agent_id presence) so the rail fires on BOTH signals, not routine alone.
 * @returns {{ allow: true }
 *         | { allow: true, hookSpecificOutput: { hookEventName: string, additionalContext: string } }
 *         | { allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
function decideBash(payload, { readGateStateFn, gitStateFn, readDescriptorFn, adviseIssueFormFn, isAncestorFn, listHandRecordsForFeatureFn, readMergeCheckRollupFn, isRoutineFn }) {
  const command = payload?.tool_input?.command;
  // Non-string command → infra error → fail-open
  if (typeof command !== "string") {
    return { allow: true };
  }

  // #ac-1.2 death rail (UNCONDITIONAL — any mode; backgrounding a hand is NEVER correct):
  // a spawn-hand.mjs / cross-family.mjs dispatch with run_in_background:true silently KILLS the
  // session under a headless `claude -p`. A backgrounded Bash job does NOT re-invoke the assistant,
  // so the orchestrator yielding its turn to "wait for the background hand" TERMINATES the process
  // mid-run — the hand is killed, nothing is captured/committed, the run dies. These dispatches
  // MUST run synchronously in the foreground. Only an explicit run_in_background === true triggers
  // this (absent/undefined/false → allow). Scoped to the hand dispatch only — NOT a broad ban on
  // background Bash (legit background use elsewhere is untouched).
  const isHandDispatch =
    command.includes("spawn-hand.mjs") || command.includes("cross-family.mjs");
  if (isHandDispatch && payload?.tool_input?.run_in_background === true) {
    console.error(
      "[entry-gate] denied backgrounded hand dispatch (spawn-hand.mjs/cross-family.mjs) — " +
        "run_in_background:true kills the session under `claude -p`.",
    );
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[entry-gate] Blocked: hand dispatch (spawn-hand.mjs / cross-family.mjs) with " +
          "run_in_background:true. Under a headless `claude -p` session a backgrounded Bash job " +
          "does NOT re-invoke the assistant — yielding the turn to wait for it TERMINATES the " +
          "process mid-run and the hand is killed with nothing captured/committed. Run the dispatch " +
          "SYNCHRONOUSLY in the FOREGROUND (no run_in_background, no sleep-poll): spawn-hand.mjs is " +
          "spawnSync-based and blocks until the hand finishes (minutes is normal). Set an explicit " +
          "Bash timeout of 600000 (the tool max) instead of backgrounding.",
      },
    };
  }

  // #808 queue-contamination rail: neither a SUBAGENT (the harvester always is one) nor a HARNESS
  // ROUTINE (headless-local / cloud cron) session may ATTACH a `harness:*` label to an issue.
  // `harness:ready` is exactly what the autonomous selector picks up
  // (core/orca/select-and-dispatch.mjs) — a run that labels its own harvest finding puts the
  // engine's own future work into the engine's own queue, and the next tick delivers a backlog
  // item no human decided should exist (the real incident: oraculo-app #401).
  //
  // REQUIRED CORRECTION over the original spec: `isRoutineFn` alone is FALSE on the production
  // Orca dispatch path that produced the incident — `isRoutineSession` reads env markers
  // (CLAUDE_CODE_REMOTE / HARNESS_NOTIFY_PROJECT / HARNESS_OBSERVABILITY_RUN_PATH) that are only
  // ever written by the RETIRED core/vps/ dispatcher (see core/vps/DEPRECATED.md); the live
  // `orca worktree create` spawn sets no env at all — its autonomy signal lives in the PROMPT
  // string, not the environment. The signal that DOES survive Orca dispatch is subagent context:
  // the harvester is always a subagent, and `payload.agent_id` presence is the same signal
  // plan-write-gate.mjs (:73-ish) already keys on for its own PreToolUse(Write|Edit) rail. So this
  // fires on isSubagentCall (presence, not truthiness — never throws) OR routine (env markers;
  // fail-open only on this half, mirroring the ScheduleWakeup rail's try/catch — a session with no
  // markers and no agent_id, i.e. the interactive main-loop operator, is #ac-3.2 and stays untouched).
  // REMOVING a label (`--remove-label`) is never matched by detectHarnessLabelWrite — un-queuing is
  // always safe. Placed ABOVE the `isDeliveryCommand` branch below: `gh issue create` is not a
  // delivery command (a rail placed after that branch would never run), and a composite
  // `gh issue create --label harness:ready && git push` IS a delivery command and must not be able
  // to route around this rail by riding along with a delivery verb.
  const attachedHarnessLabel = detectHarnessLabelWrite(command);
  if (attachedHarnessLabel !== null) {
    const isSubagentCall = Object.prototype.hasOwnProperty.call(payload, "agent_id");
    let routine = false;
    try {
      routine = Boolean(isRoutineFn?.());
    } catch {
      routine = false;
    }
    if (isSubagentCall || routine) {
      console.error(
        `[entry-gate] denied harness-label write from a subagent/routine session — ` +
          `${attachedHarnessLabel} on a gh issue create/edit.`,
      );
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: HARNESS_LABEL_DENY_REASON(attachedHarnessLabel),
        },
      };
    }
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
    // fidelity_pass entries are sha-qualified (`<feature>/<task>@<sha>`); the fidelity precondition
    // matches by task-PREFIX only (a red test was authored for this task), never by sha freshness —
    // strip the @sha before comparing. An unqualified legacy/test entry has prefix === whole string.
    const fidelityPrefixes = (Array.isArray(spawnGateState.fidelity_pass) ? spawnGateState.fidelity_pass : []).map(absolutionPrefix);
    if (!fidelityPrefixes.includes(qualifiedId)) {
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
    // Best-effort early trigger (spec AC-4): a freeze-commit for the NEXT task is a natural,
    // low-frequency checkpoint to catch an unresolved capture ONE task sooner than the mandatory
    // delivery gate below. String-matched on the commit-message convention from
    // orchestrating-delivery/SKILL.md step 1c-commit ("test(<scope>): freeze locked tests for
    // <task-id>") — advisory only. The delivery-command branch below (git push / gh pr create /
    // gh pr merge) remains the single MANDATORY enforcement point regardless of whether this
    // trigger fires; a commit message that doesn't match this convention simply skips it.
    if (/\bgit\s+commit\b/.test(command) && /freeze locked tests for/i.test(command)) {
      const freezeSessionId = payload.session_id;
      if (typeof freezeSessionId === "string" && freezeSessionId.length > 0 && isSafeSessionId(freezeSessionId)) {
        let freezeGateState = {};
        try {
          freezeGateState = readGateStateFn(freezeSessionId);
        } catch {
          freezeGateState = {};
        }
        const freezeFeatureId = typeof freezeGateState.feature_id === "string" ? freezeGateState.feature_id : null;
        if (freezeFeatureId !== null) {
          const earlyDeny = checkRealFileCaptureRail(freezeFeatureId, { listHandRecordsForFeatureFn, isAncestorFn });
          if (earlyDeny !== null) {
            return earlyDeny;
          }
        }
      }
    }
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

  if (isGhPrMergeCommand(command)) {
    const target = mergeTargetFromCommand(command);
    const checkDecision = target === undefined
      ? { ok: false, reason: "PR target is ambiguous; merge is denied." }
      : decideMergeChecks(readMergeCheckRollupFn(target));
    if (!checkDecision.ok) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `[entry-gate] Blocked: ${checkDecision.reason}`,
        },
      };
    }
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
  // CORRUPT regate_pending (present but not a JSON array) → deliberate fail-CLOSED deny. This is
  // the explicit exception to the readable-file-fail-open contract (see header docstring): a
  // readable-but-malformed gate-state is a data bug, not an infra error, so it denies with a
  // diagnosable reason instead of being silently coerced to [] (the old fail-open).
  const regate = classifyRegatePending(gateState);
  if (regate.corrupt) {
    return corruptRegatePendingDeny(regate.raw);
  }
  const pending = regate.pending;
  const passed = Array.isArray(gateState.regate_passed) ? gateState.regate_passed : [];
  // A regate_passed clears a pending obligation only when its sha-qualified entry is an ancestor of
  // (or equal to) HEAD — an unqualified/legacy or divergent-sha absolution is treated as absent.
  const unmatched = pending.filter((t) => !matchesAbsolution(t, passed, isAncestorFn));
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
  // NO hand_finished-vs-capture_verified array-diff rail here (removed deliberately — do NOT
  // reintroduce it when reconciling with the OC lane's bash-decide.mjs, which still carries it).
  // Both stamps ride on `mark.mjs` stdout, which the orchestrator routinely destroys: `>/dev/null`
  // silences it, and chaining both markers into one Bash command loses the second (decide() routes
  // by command substring and early-returns on the first match — and `hand-finished` is evaluated
  // BEFORE `capture-verified`). So the loss is asymmetric and always lands on the blocking side:
  // the obligation gets stamped, its discharge does not. Measured across six real sessions, every
  // delivery this rail ever denied was a false positive whose run-records were green on disk.
  // A rail that only fires when its own input half-fails is a false-positive generator, not a
  // defense. The real-file rail below reads what spawn-hand's code writes and is the guarantee.
  // The OC lane keeps its copy on purpose: there the marker is a typed native tool (immune to
  // redirection and chaining) and the arrays have a real consumer (session-state.mjs's
  // terminal-delivery predicate). See docs/OC-CC-PARITY-REPORT.md.
  // Real-file capture rail — independent of hand_finished/capture_verified (a session-scoped,
  // manually-stamped pair that a prior incident showed can be skipped for EVERY dispatch in a
  // run, leaving the array-diff above with nothing to compare). This reads the run-record
  // spawn-hand.mjs writes unconditionally on every dispatch, scoped to the current feature and
  // to records whose freeze commit is still part of this branch's history (never a stale
  // abandoned/already-shipped feature's leftovers).
  const featureId = typeof gateState.feature_id === "string" ? gateState.feature_id : null;
  if (featureId !== null) {
    const realFileDeny = checkRealFileCaptureRail(featureId, { listHandRecordsForFeatureFn, isAncestorFn });
    if (realFileDeny !== null) {
      return {
        allow: false,
        hookSpecificOutput: {
          ...realFileDeny.hookSpecificOutput,
          permissionDecisionReason:
            `${realFileDeny.hookSpecificOutput.permissionDecisionReason} ` +
            "(git push / gh pr create / gh pr merge).",
        },
      };
    }
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
    // The operator's hand-family toggle (which dispatch path the hand roles take). Injectable so a
    // test states the family it is asserting under instead of inheriting the process cwd's config.
    readActiveHandFamilyFn = readActiveHandFamily,
    // Routine (headless-local / cloud cron) detector for the ScheduleWakeup death rail (#ac-1.3).
    // Default reads process.env; tests inject to exercise the marker set deterministically.
    isRoutineFn = isRoutineSession,
    // No-op by default so unit callers of decide() are inert to the branch/commit rail; the real
    // git probe (defaultGitState) is injected at the processInput layer (production CLI path).
    gitStateFn = () => null,
    // Reads the spawn-hand.mjs descriptor JSON from disk; injectable for tests.
    readDescriptorFn = defaultReadDescriptor,
    // No-op by default (mirrors gitStateFn's inert default for unit callers). The real FS probe
    // (defaultIssueFormExists) is injected at the processInput layer (production CLI path).
    issueFormExistsFn = () => false,
    // Inert by default (mirrors gitStateFn) — the real git probe (defaultIsAncestor) and the
    // real hand-records reader (listHandRecordsForFeature) are injected at the processInput
    // layer (production CLI path), so unit callers of decide() never touch git/fs unless they
    // explicitly opt in via deps.
    isAncestorFn = () => null,
    listHandRecordsForFeatureFn = () => [],
    // Inert for direct unit callers. processInput injects the one real GH read below.
    readMergeCheckRollupFn = () => null,
  } = deps;

  // Non-object payload → infra error → fail-open
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { allow: true };
  }

  // ScheduleWakeup tool (#ac-1.3 death rail): denied in a harness routine (headless-local / cloud)
  // session. ScheduleWakeup does NOT re-invoke the assistant under `claude -p` — the run would
  // silently die waiting for a wakeup that never delivers a turn (unlike Agent subagents, which DO
  // re-invoke). In a plain interactive session (none of the routine env markers set) it is allowed.
  // Fail-open when routine detection is unavailable/throws.
  if (payload.tool_name === "ScheduleWakeup") {
    let routine = false;
    try {
      routine = Boolean(isRoutineFn());
    } catch {
      routine = false;
    }
    if (!routine) {
      return { allow: true };
    }
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[entry-gate] Blocked: ScheduleWakeup in a harness routine (headless-local / cloud) " +
          "session. ScheduleWakeup does NOT re-invoke the assistant under `claude -p` — the run " +
          "would silently die waiting for a wakeup that never delivers a turn. Do NOT schedule a " +
          "wakeup or sleep-poll; drive the work synchronously in the foreground. If something must " +
          "resume with fresh context, dispatch an Agent subagent (those DO re-invoke), never a " +
          "wakeup. This rail does not apply to a plain interactive session.",
      },
    };
  }

  // Bash tool: delivery-bash-gate + fidelity rail + issue-form advisory + #808 label rail.
  // The delivery-bash-gate closes the second delivery door (a direct git push / gh pr create /
  // gh pr merge bypasses the Agent shipper gate). The fidelity rail gates spawn-hand.mjs
  // dispatches until the task's fidelity-pass is stamped (test-author must produce a red locked
  // test first). The advisory nudges toward the harness issue form on bare `gh issue create`,
  // routed to the routine text (ROUTINE_ISSUE_ADVISORY) instead of the interactive one
  // (ISSUE_FORM_ADVISORY) under the SAME subagent-or-routine predicate the #808 label rail
  // itself deny-decides on, so an allowed (no-label) `gh issue create` from that same caller
  // gets told the dedup-and-label-free procedure rather than "label it `harness:ready`".
  let routineForAdvisory = false;
  try {
    routineForAdvisory = Boolean(isRoutineFn?.());
  } catch {
    routineForAdvisory = false;
  }
  const isSubagentCallForAdvisory = Object.prototype.hasOwnProperty.call(payload, "agent_id");
  const adviseIssueFormFn = (cmd, cwd) =>
    adviseIssueForm(cmd, cwd, issueFormExistsFn, isSubagentCallForAdvisory || routineForAdvisory);
  if (payload.tool_name === "Bash") {
    return decideBash(payload, { readGateStateFn, gitStateFn, readDescriptorFn, adviseIssueFormFn, isAncestorFn, listHandRecordsForFeatureFn, readMergeCheckRollupFn, isRoutineFn });
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

  // Plan-review round rail (Fix C): count every plan-reviewer dispatch. This RAISES THE BAR —
  // reclassifying a round as "focused verification" in prose can no longer dodge the count (the
  // gate keys on subagent_type, not the orchestrator's label). The count includes the initial gate
  // dispatch (1) + each revision loop; the documented cap is "2 revision loops" = 3 dispatches.
  //   • count > 3 (a 3rd+ revision) → ALLOW + a visible additionalContext warning (never block —
  //     cross-family discovery past round 2 found real bugs in the evidence).
  //   • count > 10 (runaway ceiling, well above the proven-legit 6+) → DENY, but INTERACTIVE ONLY.
  //     HEADLESS has no operator to escalate to, so a hard-deny would deadlock a cloud run with an
  //     unapproved plan → headless stays warn-only forever.
  // Fail-open on any read/write error (never brick a review).
  if (role === "plan-reviewer") {
    const featureId = (triage && typeof triage.feature_id === "string" && triage.feature_id)
      ? triage.feature_id
      : "<id>";
    let prev = 0;
    try {
      const gs = readGateStateFn(sessionId);
      if (gs && Number.isInteger(gs.plan_review_count)) prev = gs.plan_review_count;
    } catch {
      prev = 0;
    }
    const count = prev + 1;
    try {
      mergeGateStateFn(sessionId, { plan_review_count: count });
    } catch {
      // fail-open: a write failure never blocks the review
    }

    const PLAN_REVIEW_CAP = 3; // initial dispatch + 2 revision loops (documented cap of 2)
    const PLAN_REVIEW_CEILING = 10; // runaway backstop, above the proven-legit 6+
    let headless = false;
    try {
      headless = Boolean(isHeadlessFn());
    } catch {
      headless = false;
    }

    if (count > PLAN_REVIEW_CEILING && !headless) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `[entry-gate] Blocked: plan-review round ${count} for "${featureId}" exceeds the runaway ` +
            `ceiling of ${PLAN_REVIEW_CEILING}. The plan has churned far past the documented cap of 2 ` +
            "revision loops. STOP re-reviewing: escalate the blocking finding to the operator in product " +
            "language (or, if the finding is unresolvable, open an issue). Re-dispatching the plan-reviewer " +
            "is denied to prevent an invisible Opus+Codex cost spiral.",
        },
      };
    }
    if (count > PLAN_REVIEW_CAP) {
      return {
        allow: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[entry-gate] plan-review round ${count} for "${featureId}" exceeds the documented cap of 2 ` +
            "revision loops. Each round costs Opus+Codex. Confirm this round is genuine NEW-bug discovery " +
            "(a real finding the prior rounds missed), not churn or a reclassified 'focused verification'. " +
            "If findings are converging, approve the plan or escalate the blocking finding to the operator " +
            `instead of re-reviewing. Name this round's verdict file plan-review-<family>-r${count}.json.` +
            (headless ? "" : ` A hard stop applies at round ${PLAN_REVIEW_CEILING}.`),
        },
      };
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
    // CORRUPT regate_pending (present but not a JSON array) → deliberate fail-CLOSED deny, the
    // explicit exception to the readable-file-fail-open contract (see header docstring).
    const regate = classifyRegatePending(gateState);
    if (regate.corrupt) {
      return corruptRegatePendingDeny(regate.raw);
    }
    const pending = regate.pending;
    const passed = Array.isArray(gateState.regate_passed) ? gateState.regate_passed : [];
    // A regate_passed clears the pending obligation only when its sha-qualified entry is an ancestor
    // of HEAD (unqualified/legacy or divergent-sha absolution → absent). Same rail as decideBash.
    const unmatched = pending.filter((t) => !matchesAbsolution(t, passed, isAncestorFn));
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
  // task(s); the durable belt is the on-disk run-record (written by runLiveDispatch's
  // INDEPENDENT capture): the Claude hand escape is authorized ONLY when a ticketed task's record
  // shows outcome === FAILED — a genuine spawn that ran and failed its locked test/exit. A
  // PRE-SPAWN CONFIG ERROR (no token, dirty baseline, gate not armed) writes NO such record, so the
  // escape is DENIED → the orchestrator must route to the critical-exception path, never a silent
  // Claude fallback. This removes the old "any non-empty escalation_fallback array unlocks"
  // looseness (an echo-forgeable ticket could fake it). This proves a real producer path only
  // against accidental omission; same-user Bash can still forge files, so it is not OS provenance.
  // Runs AFTER Gate 1 so a hand WITHOUT triage
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

    // HANDS OFF / HEADLESS: the spawn-hand rail exists for the OLLAMA hand family, which is a
    // LOCAL-only capability. Two situations have no Ollama hand at all, and in BOTH a main-loop
    // Agent(executor|sniper|test-author) is the INTENDED dispatch, not a silent fallback to deny:
    //   • the operator's toggle selects the `claude` family (the default) — those rungs ARE
    //     ordinary subagents, dispatched with the Agent tool on the session's own auth;
    //   • the session is a cloud routine (no Ollama endpoint reachable there).
    // A config read that throws (a corrupt hands.json) must not brick the gate: the family is
    // unknowable, so fall back to the strict spawn-hand rail below rather than opening it.
    let handsOnAgentPath = false;
    try {
      handsOnAgentPath = readActiveHandFamilyFn().family === "claude";
    } catch {
      handsOnAgentPath = false;
    }
    if (handsOnAgentPath || isHeadlessFn()) {
      // test-author (the fidelity-pass producer) and sniper (the post-gate fixer) are unconditionally
      // allowed here — they must never be blocked by the fidelity rail they serve. Only the
      // executor consumer is gated: it must not run before the test-author has produced a red test.
      if (bareRole(role) !== "executor" && bareRole(role) !== "executor-high") {
        return { allow: true };
      }
      // The executor on the Agent path: additionally requires at least one fidelity_pass entry for the current
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
        // The K=1 ticket is role-specific: a sniper failure must never authorize an
        // executor fallback for the same task (and vice versa).
        record = readHandRecordFn(qualifiedId, role);
      } catch {
        record = null;
      }
      if (!record) return false;
      // A GENUINE run that did not reach DONE (FAILED or NOT_DONE) is what authorizes the K=1
      // Claude escalation; a config error wrote no record and never lands here. SNIPER-ONLY widen:
      // a record whose provider rate-limited the spawn before it could reach a locked-test verdict
      // (rateLimited === true) ALSO authorizes — but only for the sniper's post-gate fix escalation,
      // never the executor's escape hatch (which stays gated on AUTHORIZING_OUTCOMES alone).
      const rateLimitedAuthorizes = role === "sniper" && record?.rateLimited === true;
      if (!AUTHORIZING_OUTCOMES.has(record?.outcome?.status) && !rateLimitedAuthorizes) return false;
      // Freshness: a record is anchored to the freeze it ran against. If we can read HEAD and the
      // record is anchored, REJECT a record whose freeze differs from the current HEAD — a stale
      // FAILED from a prior run/freeze must never authorize a later, unfailed escalation. Only a
      // POSITIVE mismatch denies; an unreadable HEAD or an unanchored record fails open (the
      // ticket + genuine-failure outcome still gate it). Same freshness check for the rate-limited path.
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
          "exists; what is almost always missing is the hand token, not the script. To learn the " +
          "EXACT cause, RUN the dispatch: `node .claude/skills/orchestrating-delivery/references/" +
          "spawn-hand.mjs --descriptor <descriptor.json>` and read its exit-2 JSON `reason` (e.g. " +
          "'no OLLAMA_HAND_TOKEN resolved', 'dirty baseline', 'gate not armed'). Then route that " +
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
      isAncestorFn: defaultIsAncestor,
      listHandRecordsForFeatureFn: listHandRecordsForFeature,
      readMergeCheckRollupFn: (target) => defaultMergeCheckRollup(target, payload?.cwd),
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
