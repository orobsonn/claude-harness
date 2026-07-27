/**
 * @description Pure OC bash gates: delivery rails (branch/zero-commits, regate, capture,
 * real-file) + spawn-hand.mjs fidelity rail + freeze-commit early capture trigger + a
 * non-blocking advisory channel (allow + prose hint, never deny).
 * Never throws; returns Decision.
 *
 * Parity contract with Claude Code (core/claude-code/hooks/entry-gate.mjs decideBash,
 * lines 451-521 spawn-hand + 529-696 delivery-command handling): the bash gate does NOT
 * enforce ceremony (mode/classified/brainstormed/adversary_fired/planner_status/dual_status/
 * final_review/demo) — that lives on the Agent/Task dispatch gate. The bash gate only
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
import { isSafeSessionIdSegment } from "./dual-enforcement.mjs";
import { matchesAbsolution, absolutionPrefix } from "../../../shared/lib/absolution.mjs";
import { fidelityPassEntry } from "./mark-gate.mjs";
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
  "until every prerequisite's PR merges, and only one issue is built at a time. After creating the " +
  "roadmap, run `node core/vps/chain-validate.mjs --config <project.json>` to catch dependency " +
  "cycles and non-existent references before the engine runs.";

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

/**
 * @description Best-effort advisory: nudge toward the harness issue form when `gh issue create`
 * runs in a repo that vendors the form. Returns the advisory string, or null when no nudge
 * applies. Never denies -- the result is a non-blocking hint only.
 * @param {unknown} command
 * @param {unknown} cwd
 * @param {(cwd: string) => boolean} [existsFn]
 * @returns {string | null}
 */
export function adviseIssueForm(command, cwd, existsFn = defaultIssueFormExists) {
  if (typeof command !== "string") return null;
  if (!/\bgh\s+issue\s+create\b/.test(command)) return null;
  // Scoped to the --label/-l value (not a bare substring anywhere in the command) so
  // "harness:ready" mentioned in --body/--title prose does not silently suppress the nudge.
  if (/(?:^|\s)(?:--label|-l)(?:=|\s+)["']?[\w,:-]*harness:ready\b/i.test(command)) return null;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  if (!existsFn(cwd)) return null;
  return ISSUE_FORM_ADVISORY;
}

/**
 * @description Non-blocking bash advisories -- always allow. First (and currently only)
 * consumer: adviseIssueForm. A failure to compute an advisory omits the field (fail-open);
 * this function never denies and never throws.
 * @param {{ command?: unknown, cwd?: unknown }} input
 * @returns {Decision}
 */
export function decideBashAdvisory(input = {}) {
  try {
    const advisory = adviseIssueForm(input.command, input.cwd);
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
 * to the model -- `output.metadata` -- mirroring revise_nudge / adversary_nudge /
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
  const qualifiedId = fidelityPassEntry(descriptor.feature_id, descriptor.task_id, null);
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
