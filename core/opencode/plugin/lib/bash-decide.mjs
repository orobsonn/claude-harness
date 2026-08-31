/**
 * @description Pure OC bash gates: delivery rails (branch/zero-commits, regate, capture,
 * real-file) + spawn-hand.mjs fidelity rail + freeze-commit early capture trigger + a
 * non-blocking advisory channel (allow + prose hint, never deny).
 * Never throws; returns Decision.
 *
 * Parity contract with Claude Code (core/claude-code/hooks/entry-gate.mjs decideBash,
 * lines 451-521 spawn-hand + 529-696 delivery-command handling): the bash gate does NOT
 * enforce ceremony — that lives on the Agent/Task dispatch gate. The bash gate only
 * enforces: branch/zero-commits, regate (regate_pending vs regate_passed), capture
 * (hand_finished vs capture_verified), and real-file (checkRealFileCaptureRail via
 * feature_id). Fail-open on infra error (unreadable gate-state, missing/unsafe sessionId) —
 * the sole deliberate exception is a CORRUPT regate_pending (present but not a JSON array),
 * which denies fail-closed; hand_finished/capture_verified/regate_passed are NOT the exception
 * — a non-array value there silently coerces to [] (coerceArray), mirroring Claude Code exactly
 * (entry-gate.mjs never denies on those, only on regate_pending). This exception is reachable
 * ONLY with a safe sessionId (mirrors Claude Code's own ordering — the sessionId fail-open runs
 * before the corrupt-marker check in both runtimes): a missing/unsafe sessionId allows before
 * gate-state content is ever inspected, so a corrupt regate_pending under an unsafe/missing
 * sessionId is not itself observable — that scenario is already fail-open on the sessionId
 * infra error, which is consistent with the rest of the contract, not a bypass of it.
 * Marker-seal validation does not exist anywhere in this harness (#484) — see
 * docs/OC-CC-PARITY-REPORT.md item #32 (the per-process-instance seal secret + incident #423:
 * validating it bricked delivery for any session resumed after an OpenCode restart).
 */

import fs from "node:fs";
import path from "node:path";
import { isDeliveryCommand } from "./is-delivery-command.mjs";
import { isSafeSessionIdSegment } from "../../lib/gate-state.mjs";
import {
  matchesAbsolution,
  absolutionPrefix,
  formatFeatureTaskEntry,
} from "../../../shared/lib/absolution.mjs";
import {
  classifyRegatePending,
  corruptRegatePendingReason,
} from "../../../shared/lib/regate-classify.mjs";
import { checkRealFileCaptureRail } from "../../../shared/lib/real-file-capture-rail.mjs";

/**
 * @typedef {{ ok: boolean, decision: "allow"|"deny", reason: string, details?: unknown, advisory?: string }} Decision
 */

/**
 * @description Text nudged when `gh issue create` runs in a repo that vendors the harness
 * issue form -- non-blocking, ported 1:1 from the Claude Code advisory (entry-gate.mjs).
 */
const ISSUE_FORM_ADVISORY =
  "This repo vendors the Claude Harness issue form (.github/ISSUE_TEMPLATE/harness-task.yml). " +
  "Prefer creating issues through it so they enter the autonomous routine -- or run the " +
  "`creating-issues` skill, which authors them to standard for you. " +
  "The `gh issue create` CLI bypasses issue forms silently -- if you proceed, replicate the form: " +
  "title `[harness] <slug>`, label `harness:ready`, and a body with #uj-N journeys, " +
  "#ac-N.M acceptance criteria, scope, sensitive domain, priority, and size " +
  "(these become the spec, locked_tests and scope_paths). " +
  "Size each issue as ONE independently-shippable, independently-revertible outcome (<= ~400 changed " +
  "lines): if you can name two things that could merge separately, they are two issues -- retry, " +
  "partial delivery and merge blast radius are all per-issue, so prefer small over one big issue that is cohesive only by theme. " +
  "For a CHAINED ROADMAP, create EVERY issue with `harness:ready` (never `harness:queued` by hand) " +
  "and, in each dependent issue's body, declare its prerequisites in a fenced ```harness-deps block " +
  "(one `#N` per line). The engine gates order and serialization on its own -- a dependent is held " +
  "until every prerequisite's PR merges, and only one issue is built at a time. There is NO " +
  "automated graph lint: before the engine runs, check by hand that no dependency cycle exists " +
  "and that every referenced #N is a real issue -- a cycle leaves both issues queued forever with " +
  "no dead node to notify.";

/**
 * @description True when .github/ISSUE_TEMPLATE/harness-task.yml exists under cwd.
 * Fail-open on any FS error (returns false -> no nudge).
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

// ---------------------------------------------------------------------------
// #808 queue-contamination rail -- a routine/subagent session may not ATTACH a harness:* label
// Ported 1:1 from core/claude-code/hooks/entry-gate.mjs (detectHarnessLabelWrite /
// HARNESS_LABEL_DENY_REASON / ROUTINE_ISSUE_ADVISORY / isRoutineSession). Keep the two in sync.
// ---------------------------------------------------------------------------

/**
 * @description Detects a HARNESS ROUTINE (headless-local / cloud cron) session. Parity port of
 * core/claude-code/hooks/entry-gate.mjs isRoutineSession -- SAME three markers, SAME fail-open.
 * The retired VPS cron dispatch deliberately did NOT set $CLAUDE_CODE_REMOTE (that would
 * disable cheap hands) but DOES set $HARNESS_NOTIFY_PROJECT and usually
 * $HARNESS_OBSERVABILITY_RUN_PATH, so the routine signal is ANY of the three. Fail-open
 * (returns false -> allow) when env is unavailable. NOTE: the LIVE Orca dispatch
 * (core/orca/select-and-dispatch.mjs) sets NONE of these -- its autonomy signal lives in the
 * PROMPT string -- which is exactly why the rail below fires on subagent context TOO, never on
 * this predicate alone.
 * @param {Record<string, string | undefined> | null | undefined} [env]
 * @returns {boolean}
 */
export function isRoutineSession(env = process.env) {
  if (!env) return false;
  return Boolean(
    env.CLAUDE_CODE_REMOTE || env.HARNESS_NOTIFY_PROJECT || env.HARNESS_OBSERVABILITY_RUN_PATH,
  );
}

/**
 * @description `build` is the sole OpenCode primary agent. A bash call whose acting agent is
 * `build` is the OPERATOR's own top-level lane, NOT a subagent -- misreading it as a subagent
 * would deny the operator's hand-applied `harness:ready` and break #ac-3.2. Every other agent
 * in core/opencode/agents is `mode: subagent` or `mode: all` (harvester.md is `mode: subagent`).
 */
const OC_PRIMARY_AGENTS = new Set(["build"]);

/**
 * @description True when an acting-agent name denotes a SUBAGENT lane. Null/empty -> false
 * (the host does not surface an agent on every path; absence is not evidence of a subagent, and
 * the caller falls back to the session-parent probe). Normalizes the way
 * core/shared/lib/classify-authority.mjs does (trim, lowercase, strip a trailing `.md`).
 * @param {unknown} agent
 * @returns {boolean}
 */
export function isSubagentActingAgent(agent) {
  if (typeof agent !== "string") return false;
  const name = agent.trim().toLowerCase().replace(/\.md$/, "");
  if (!name) return false;
  return !OC_PRIMARY_AGENTS.has(name);
}

/**
 * @description Matches an ADD-shaped label flag and captures its raw value. Deliberately global
 * (`g`) -- a command may repeat `--label`, and only ONE occurrence needs to carry a harness
 * label. Covers every real gh/cobra shape: `--label v`, `--label=v`, `-l v`, `-l=v`, `-lv`,
 * `--add-label v` (issue edit), quoted values, and comma-joined lists. `--remove-label` is NOT
 * matched (un-queuing is always safe) -- the alternation requires a `--label` / `--add-label` /
 * `-l` token preceded by start-of-string or a shell separator, and inside `--remove-label`
 * neither `--label` nor `-l` sits on such a boundary.
 */
const HARNESS_LABEL_FLAG_RE =
  /(?:^|[\s;|&(])(?:--label|--add-label|-l)(?:=\s*|\s+)?("[^"]*"|'[^']*'|[^\s;|&)]+)/gi;

/** @description gh verbs that can attach a label at write time. `new` is not a real gh verb but
 * is a common operator alias for `create`; matching it costs nothing and closes that shape. */
const ISSUE_WRITE_VERB_RE = /\bgh\s+issue\s+(?:create|new|edit)\b/i;

/** @description `gh api` can attach a label off the `gh issue` path entirely
 * (`gh api repos/o/r/issues/N/labels -f "labels[]=harness:ready"`). There is zero legitimate
 * in-session traffic on this shape, so any `gh api` call mentioning `label(s)` is treated as a
 * harness-label write. */
const GH_API_LABEL_RE = /\bgh\s+api\b[\s\S]*\blabels?\b/i;

/** @description `submit-issue.mjs` is the OpenCode lane's ONLY sanctioned issue-submission path
 * (core/opencode/rules/creating-issues.md) and it HARDCODES `harness:ready`
 * (skills/creating-issues/references/submit-issue.mjs) with no opt-out, using execFileSync argv
 * arrays -- so its Bash command string carries no `--label` flag at all and the flag regex above
 * is blind to it. Without this shape the rail would be dead code on the exact path an OC harvest
 * would actually take. The script itself is NOT modified. */
const SUBMITTER_RE = /\bsubmit-issue\.mjs\b/i;

/**
 * @description Returns the first `harness:*` label a `gh issue create|new|edit` command (or an
 * off-path `gh api ...labels...` / `submit-issue.mjs` invocation) would ATTACH, or null. Pure.
 * Never throws.
 *
 * Fail-CLOSED on an unresolvable value (`$VAR`, backtick, `$(cmd)`): this file's own
 * corrupt-regate rail already establishes "evidence required but absent -> deny", and a value we
 * cannot statically read is exactly that -- allowing it would let
 * `L=harness:ready; gh issue create --label $L` walk straight through. The sentinel is passed to
 * the deny reason so the caller is told WHY. This closes the cheap indirection shapes, not full
 * shell evaluation (see the accepted-gap note on decideBashHarnessLabel).
 * @param {unknown} command
 * @returns {string | null}
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
      if (/[$`]/.test(label)) return "<unresolvable label value>"; // cannot statically read it
      if (/^harness:[A-Za-z0-9._-]+$/i.test(label)) return label;
    }
  }
  return null;
}

/**
 * @description Deny reason for the #808 rail. Names the escape route (search -> comment on hit /
 * create label-free on miss), matching this lane's convention that a deny always says what to do
 * instead. ASCII-only, per this file's convention.
 * @param {string} label
 * @returns {string}
 */
const HARNESS_LABEL_DENY_REASON = (label) =>
  `[entry-gate] Blocked: attaching \`${label}\` to a GitHub issue from a subagent or a harness ` +
  "routine (headless-local / cloud cron) session. `harness:ready` is exactly the label the " +
  "autonomous queue selector picks up, so an issue labelled by the run puts the engine's own " +
  "future work into the engine's own queue -- the next tick delivers a backlog item no human " +
  "decided should exist. `harness:queued`, `harness:in-progress`, `harness:blocked` and " +
  "`harness:done` are the engine's own vocabulary and are never written by hand either. RECORD " +
  "THE FINDING ANYWAY -- the record has value, the queue entry does not. (1) SEARCH first, so " +
  "the dedup is auditable in the transcript: `gh issue list --state open --limit 50 --search " +
  '"<file basename>" --json number,title,url,labels`. (2) On a HIT (same file + same symptom -- ' +
  "never compare line numbers, they drift), post the new evidence as a COMMENT on the existing " +
  "issue (`gh issue comment <N> --body-file <path>`) and create nothing; never close it, never " +
  "rewrite its body. (3) On a MISS, create it with NO label at all: " +
  '`gh issue create --title "[harness] <slug>" --body-file <path>` -- no `--label` flag, and NOT ' +
  "through `submit-issue.mjs` (it stamps `harness:ready` unconditionally). The issue is inert " +
  "without the label (the selector only picks `harness:ready`) and waits for the operator, who " +
  "applies the label by hand when he decides it should be delivered. Say in your summary that " +
  "you opened it label-free, so it is not an inert issue nobody knows about. This rail does not " +
  "apply to a plain interactive main-loop session.";

/**
 * @description The #808 queue-contamination rail. DENIES a `harness:*` label ATTACH when the
 * caller is a SUBAGENT (the harvester always is) OR a HARNESS ROUTINE session. Both signals are
 * required because neither alone covers production: the live Orca dispatch sets no env markers
 * (so isRoutine is false there), while the retiring cron path may run in a main loop (so
 * isSubagent is false there). A plain interactive main-loop operator session satisfies neither
 * and is untouched (#ac-3.2). Never throws; returns a Decision.
 *
 * Accepted, stated gaps (NOT claimed closed): a label value fully dereferenced by an earlier
 * shell statement; a label written by some other argv-array `gh` child process the session
 * spawns; and a label applied later from outside the session entirely (the GitHub UI, the
 * engine's own crons -- those are execFileSync child processes of cron-started Node scripts and
 * never transit this hook, which is why the engine's own `--add-label harness:in-progress` is
 * not affected).
 * @param {{ command?: unknown, isRoutine?: unknown, isSubagent?: unknown }} input
 * @returns {Decision}
 */
export function decideBashHarnessLabel(input = {}) {
  try {
    const label = detectHarnessLabelWrite(input.command);
    if (label === null) return { ok: true, decision: "allow", reason: "no-harness-label" };
    if (!input.isRoutine && !input.isSubagent) {
      return { ok: true, decision: "allow", reason: "interactive-main-loop" };
    }
    return {
      ok: false,
      decision: "deny",
      reason: HARNESS_LABEL_DENY_REASON(label),
      details: { label },
    };
  } catch {
    // Fail-open on an unexpected internal error -- consistent with this file's infra-error
    // contract. The detector itself never throws, so this is belt only.
    return { ok: true, decision: "allow", reason: "harness-label-check-failed" };
  }
}

/**
 * @description #808: the advisory a ROUTINE/subagent session reads instead of
 * ISSUE_FORM_ADVISORY. The interactive text stays byte-identical (zero regression on the
 * operator's sanctioned path) -- this is a SEPARATE constant, not a reword, because the routine
 * path must never be told to label the issue `harness:ready`, which is the exact prompt-level
 * instruction that produced the incident (oraculo-app #401). ASCII-only, per this file.
 * NOTE: this advisory only fires in a repo that vendors the issue form -- the harvester agent
 * prompt (core/opencode/agents/harvester.md) is the primary carrier of the dedup procedure; the
 * DENY above fires regardless of whether a form is vendored.
 */
const ROUTINE_ISSUE_ADVISORY =
  "You are in a harness ROUTINE session (headless-local / cloud cron) or a subagent lane, so the " +
  "issue you are about to open is a RUN FINDING, not operator-authored work: it takes NO " +
  "`harness:*` label at all, and does NOT go through `submit-issue.mjs` (that submitter stamps " +
  "`harness:ready` unconditionally). The selector only picks `harness:ready`, so a labelled " +
  "issue becomes the engine's next autonomous delivery -- work no human decided should exist. " +
  "The entry-gate DENIES a `--label` / `--add-label` carrying `harness:*` here, so do not try. " +
  "Before creating anything, search for an existing open issue and let that search show up in " +
  "the transcript: `gh issue list --state open --limit 50 --search \"<file basename>\" --json " +
  "number,title,url,labels`. Match on FILE + SYMPTOM, never on line number -- the same defect " +
  "moves between lines. On a hit, add the new evidence as a comment on that issue " +
  "(`gh issue comment <N> --body-file <path>`); never close it and never rewrite its body. On a " +
  "miss, create it label-free: `gh issue create --title \"[harness] <slug>\" --body-file <path>`, " +
  "replicating the form's body (#uj-N, #ac-N.M, scope, sensitive domain, priority, size). Report " +
  "in your summary that it was opened without a label, so the operator knows it is waiting for " +
  "his decision.";

/**
 * @description Best-effort advisory: nudge toward the harness issue form when `gh issue create`
 * runs in a repo that vendors the form. Returns the advisory string, or null when no nudge
 * applies. Never denies -- the result is a non-blocking hint only.
 * @param {unknown} command
 * @param {unknown} cwd
 * @param {(cwd: string) => boolean} [existsFn]
 * @returns {string | null}
 */
export function adviseIssueForm(command, cwd, existsFn = defaultIssueFormExists, isRoutine = false) {
  if (typeof command !== "string") return null;
  if (!/\bgh\s+issue\s+create\b/.test(command)) return null;
  // Scoped to the --label/-l value (not a bare substring anywhere in the command) so
  // "harness:ready" mentioned in --body/--title prose does not silently suppress the nudge.
  if (/(?:^|\s)(?:--label|-l)(?:=|\s+)["']?[\w,:-]*harness:ready\b/i.test(command)) return null;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  if (!existsFn(cwd)) return null;
  return isRoutine ? ROUTINE_ISSUE_ADVISORY : ISSUE_FORM_ADVISORY;
}

/**
 * @description Non-blocking bash advisories -- always allow. First (and currently only)
 * consumer: adviseIssueForm. A failure to compute an advisory omits the field (fail-open);
 * this function never denies and never throws.
 * @param {{ command?: unknown, cwd?: unknown, isRoutine?: unknown }} input -- isRoutine (#808)
 *   selects the ROUTINE advisory text over the interactive one; defaults to false.
 * @returns {Decision}
 */
export function decideBashAdvisory(input = {}) {
  try {
    const advisory = adviseIssueForm(
      input.command,
      input.cwd,
      undefined,
      Boolean(input.isRoutine),
    );
    if (advisory) {
      return { ok: true, decision: "allow", reason: "advisory", advisory };
    }
    return { ok: true, decision: "allow", reason: "no-advisory" };
  } catch {
    return { ok: true, decision: "allow", reason: "advisory-failed" };
  }
}

/**
 * @description Writes a Decision's advisory (if any) to the plugin's only prose channel back
 * to the model -- `output.metadata` -- without becoming runtime authority.
 * agent_idle_nudge. Fail-open: any error while writing is swallowed, never a new block.
 * @param {Decision} decision
 * @param {{ metadata?: Record<string, unknown> } | null | undefined} output
 * @returns {void}
 */
export function applyAdvisory(decision, output) {
  try {
    if (!decision || typeof decision.advisory !== "string" || !decision.advisory) return;
    if (output == null || typeof output !== "object") return;
    if (!output.metadata || typeof output.metadata !== "object") output.metadata = {};
    output.metadata.bash_advisory = decision.advisory;
  } catch {
    /* fail-open -- the advisory channel must never throw or block */
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
 * @description Normalize a possibly-non-object gate-state into a plain object. Never throws.
 * @param {unknown} gateState
 * @returns {Record<string, unknown>}
 */
function normalizeGateState(gateState) {
  return gateState != null && typeof gateState === "object" && !Array.isArray(gateState)
    ? /** @type {Record<string, unknown>} */ (gateState)
    : {};
}

/**
 * @description Real fs-based descriptor reader for the spawn-hand.mjs fidelity rail — reads
 * and parses a spawn-hand.mjs descriptor JSON file from disk. Returns the parsed object on
 * success, or null on ANY error (missing/unparseable). This reader itself never throws; the
 * caller (decideSpawnHandFidelity) treats a null return as fail-CLOSED (deny) — a legitimate
 * spawn-hand.mjs dispatch always supplies a readable descriptor, so an unreadable one is a bug
 * or a bypass attempt, not an infra error to fail open on (mirrors Claude Code's
 * defaultReadDescriptor / the same fail-closed default).
 * @param {string} descriptorPath
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

/**
 * @description Narrow trail for spawn-hand.mjs dispatches — evaluated BEFORE delivery-command
 * classification (spawn-hand.mjs is not itself git push / gh pr). Ported 1:1 from Claude Code
 * entry-gate.mjs lines 451-521 (#ac-2.1).
 *   • No --descriptor flag → fail-OPEN (allow). A read-only command such as `cat spawn-hand.mjs`
 *     carries no --descriptor and must never be denied.
 *   • --descriptor present but unreadable / not valid JSON / not an object / non-string ids
 *     → fail-CLOSED (deny). A legitimate executor dispatch always supplies a readable descriptor.
 *   • --descriptor present and yields a valid <feature_id>/<task_id> → check fidelity_pass on
 *     the already-loaded gate-state; deny if absent, allow if present.
 * @param {string} command
 * @param {{ gateState?: unknown, readDescriptorFn?: (path: string) => object|null }} input
 * @returns {Decision}
 */
function decideSpawnHandFidelity(command, input) {
  const descriptorMatch = command.match(/--descriptor\s+(\S+)/);
  if (!descriptorMatch) {
    return { ok: true, decision: "allow", reason: "spawn-hand-no-descriptor" };
  }
  const descriptorPath = descriptorMatch[1];
  const readDescriptorFn =
    typeof input.readDescriptorFn === "function" ? input.readDescriptorFn : defaultReadDescriptor;
  let descriptor = null;
  try {
    descriptor = readDescriptorFn(descriptorPath);
  } catch {
    descriptor = null;
  }
  if (
    descriptor === null ||
    typeof descriptor.feature_id !== "string" ||
    typeof descriptor.task_id !== "string"
  ) {
    return {
      ok: false,
      decision: "deny",
      reason:
        "[entry-gate] Blocked: spawn-hand.mjs dispatch denied — --descriptor flag was present " +
        `but the descriptor at '${descriptorPath}' could not be resolved to a qualified ` +
        "feature_id/task_id (missing file, invalid JSON, or non-string ids). " +
        "The fidelity check requires a readable descriptor with string feature_id and task_id. " +
        "Ensure the descriptor JSON exists and is well-formed before dispatching.",
    };
  }
  const qualifiedId = formatFeatureTaskEntry(descriptor.feature_id, descriptor.task_id);
  const gs = normalizeGateState(input.gateState);
  const fidelityPrefixes = coerceArray(gs.fidelity_pass).map(absolutionPrefix);
  if (!fidelityPrefixes.includes(qualifiedId)) {
    return {
      ok: false,
      decision: "deny",
      reason:
        `[entry-gate] Blocked: spawn-hand.mjs dispatch denied — fidelity-pass for task ` +
        `${qualifiedId} has not been stamped. Dispatch the test-author first to produce ` +
        "a failing locked test, then stamp fidelity-pass " +
        `(mark.mjs fidelity-pass --feature-id ${descriptor.feature_id} --task-id ${descriptor.task_id}) ` +
        "before dispatching the executor cheap-hand.",
    };
  }
  return { ok: true, decision: "allow", reason: "spawn-hand-fidelity-ok" };
}

/**
 * @description Best-effort early trigger (ac-2.2): a freeze-commit for the NEXT task is a
 * natural, low-frequency checkpoint to catch an unresolved capture ONE task sooner than the
 * mandatory delivery gate. Ported 1:1 from Claude Code entry-gate.mjs lines 530-554. Advisory
 * in the sense that it only ever evaluates within the narrow freeze-commit-message scope and
 * never denies an ordinary (non-freeze, non-delivery) command — but WITHIN that scope it can
 * return the same real-file-capture-rail deny the mandatory delivery gate would eventually
 * produce, catching it earlier. Fail-open when featureId or listFn is unavailable.
 * @param {{ gateState?: unknown, listHandRecordsForFeatureFn?: (featureId: string) => unknown[], isAncestorFn?: (sha: string) => boolean|null }} input
 * @returns {Decision | null}
 */
function checkFreezeCommitEarlyCapture(input) {
  const gs = normalizeGateState(input.gateState);
  const featureId = typeof gs.feature_id === "string" ? gs.feature_id : null;
  if (featureId === null) return null;
  const listFn = input.listHandRecordsForFeatureFn;
  if (typeof listFn !== "function") return null;
  const isAncestorFn = typeof input.isAncestorFn === "function" ? input.isAncestorFn : () => null;
  return checkRealFileCaptureRail(featureId, { listHandRecordsForFeatureFn: listFn, isAncestorFn });
}

/**
 * @param {{
 *   command?: unknown,
 *   gateState?: unknown,
 *   sessionId?: unknown,
 *   gitState?: { branch?: string|null, commitsAhead?: number|null, defaultBranch?: string|null }|null,
 *   isAncestorFn?: (sha: string) => boolean|null,
 *   listHandRecordsForFeatureFn?: (featureId: string) => unknown[],
 *   readDescriptorFn?: (path: string) => object|null,
 * }} input
 * @returns {Decision}
 */
export function decideBashDelivery(input = {}) {
  try {
    const command = input.command;

    // 0. spawn-hand.mjs fidelity rail — narrow trail, evaluated before delivery-command
    // classification (spawn-hand.mjs is not itself git push / gh pr). #ac-2.1.
    // NOT unconditionally terminal: a composite/incidental command that BOTH mentions
    // spawn-hand.mjs (e.g. a `gh pr create --body '...dispatched via spawn-hand.mjs...'`,
    // or literally `... && git push`) AND is itself a delivery command must still cross the
    // branch/regate/capture/real-file rails below — a fidelity allow is not a delivery
    // free-pass. Only a fidelity DENY short-circuits unconditionally.
    if (typeof command === "string" && command.includes("spawn-hand.mjs")) {
      const fidelity = decideSpawnHandFidelity(command, input);
      if (fidelity.decision === "deny" || !isDeliveryCommand(command)) {
        return fidelity;
      }
      // fidelity allowed AND this is also a delivery command → fall through to the
      // delivery rails below instead of returning early.
    }

    // 1. non-delivery → allow (with the freeze-commit early capture-rail trigger). #ac-2.2.
    if (!isDeliveryCommand(command)) {
      if (
        typeof command === "string" &&
        /\bgit\s+commit\b/.test(command) &&
        /freeze locked tests for/i.test(command)
      ) {
        const early = checkFreezeCommitEarlyCapture(input);
        if (early !== null) return early;
      }
      return { ok: true, decision: "allow", reason: "not-delivery-command" };
    }

    // 2. gitState rails (branch/zero-commits) — kept 1:1 with Claude Code. #ac-1.2, #ac-1.3.
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

    // 3. sessionId missing/unsafe → allow (infra error, fail-open — CC parity). #ac-1.5.
    // Without a safe sessionId there is no session-scoped gate-state to evaluate the
    // regate/capture/real-file rails against; Claude Code's decideBash short-circuits the
    // same way (allow, never attempting to read gate-state for an unsafe/missing session).
    if (!isSafeSessionIdSegment(input.sessionId)) {
      return { ok: true, decision: "allow", reason: "sessionId-missing-or-unsafe" };
    }

    const gs = normalizeGateState(input.gateState);
    const isAncestorFn = typeof input.isAncestorFn === "function" ? input.isAncestorFn : () => null;

    // 4. corrupt regate_pending → deny (never "stamp regate-passed") — the sole deliberate
    // fail-closed exception (readable-but-malformed content, not an infra error).
    const regate = classifyRegatePending(gs);
    if (regate.corrupt) {
      return {
        ok: false,
        decision: "deny",
        reason: corruptRegatePendingReason(regate.raw),
      };
    }

    // hand_finished / capture_verified / regate_passed are NOT the deliberate fail-closed
    // exception — only regate_pending is (#ac-1.5: "a única exceção deliberada"). A non-array
    // value here coerces to [] via coerceArray below, mirroring Claude Code exactly
    // (entry-gate.mjs:633,655-656 do the same silent coercion, never a corrupt-content deny).

    // 5. unmatched regate via matchesAbsolution — kept 1:1. #ac-1.4.
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

    // 6. unmatched hand_finished vs capture_verified (arrays validated above) — kept 1:1.
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

    // 7. real-file rail whenever feature_id is present — kept 1:1 (no ceremony/mode
    // dependency; checkRealFileCaptureRail itself denies real-file-list-unavailable when
    // listFn is missing/throws).
    const featureId = typeof gs.feature_id === "string" ? gs.feature_id : null;
    if (featureId !== null) {
      const realFileDeny = checkRealFileCaptureRail(featureId, {
        listHandRecordsForFeatureFn: input.listHandRecordsForFeatureFn,
        isAncestorFn,
      });
      if (realFileDeny !== null) return realFileDeny;
    }

    // 8. single terminal allow only.
    return { ok: true, decision: "allow", reason: "delivery-ok" };
  } catch (err) {
    // fail_open (resolved decision, docs/OC-CC-PARITY-REPORT.md item #60): an internal bug in
    // this decision layer must never opaquely brick delivery — log for diagnosis, allow.
    try {
      console.error(
        `[entry-gate] decideBashDelivery threw — failing open (allow): ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch {
      /* logging must never itself throw */
    }
    return { ok: true, decision: "allow", reason: "delivery-decision-failed-open" };
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
