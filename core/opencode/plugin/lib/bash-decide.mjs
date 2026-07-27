/**
 * @description Pure OC bash gates: delivery ceremony + rails + a non-blocking advisory
 * channel (allow + prose hint, never deny).
 * Never throws; returns Decision. D1 single fall-through — no early allow after delivery detect.
 */

import fs from "node:fs";
import path from "node:path";
import { isDeliveryCommand } from "./is-delivery-command.mjs";
import { isSafeSessionIdSegment } from "./dual-enforcement.mjs";
import { matchesAbsolution } from "../../../shared/lib/absolution.mjs";
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
 * @param {unknown} mode
 * @returns {"QUICK"|"LIGHT"|"FULL"|"NO-CEREMONY"|""}
 */
/**
 * @description True when gate-state shows the session already entered LIGHT/FULL ceremony
 * or planner/review work — used to block QUICK ship laundering after a stuck LIGHT run.
 * @param {Record<string, unknown>} gs
 * @returns {boolean}
 */
export function hasElevatedCeremonyResidue(gs = {}) {
  if (!gs || typeof gs !== "object" || Array.isArray(gs)) return false;
  const peak = normalizeMode(gs.peak_mode);
  if (peak === "LIGHT" || peak === "FULL") return true;
  if (gs.brainstormed === true || gs.adversary_fired === true) return true;
  const plannerStatus = typeof gs.planner_status === "string" ? gs.planner_status : "";
  if (plannerStatus && plannerStatus !== "not_started") return true;
  const attempts = Number(gs.planner_primary_attempts);
  if (Number.isFinite(attempts) && attempts > 0) return true;
  if (
    gs.review_status === "primary_failure_cap_reached" ||
    gs.review_status === "review_cap_reached"
  ) {
    return true;
  }
  const dual = gs.dual_status;
  if (dual && typeof dual === "object" && !Array.isArray(dual)) {
    if (dual.plan_review || dual.adversary) return true;
  }
  if (Array.isArray(gs.review_outcomes) && gs.review_outcomes.length > 0) return true;
  return false;
}

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
 * @description True when a dual_status value (scalar enum or plan_review axis of a map)
 * is a recorded attempt. Legacy scalar and map forms both accepted.
 * @param {unknown} dualStatus
 * @returns {boolean}
 */
export function isRecordedDual(dualStatus) {
  const status =
    typeof dualStatus === "string"
      ? dualStatus
      : dualStatus != null && typeof dualStatus === "object" && !Array.isArray(dualStatus)
        ? /** @type {Record<string, unknown>} */ (dualStatus).plan_review
        : undefined;
  return (
    status === "both" ||
    status === "primary_only" ||
    status === "primary_only_failopen" ||
    status === "primary_only_error"
  );
}

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
 * @description Headless delivery context: explicit input/gate flag, or cloud env signals.
 * Interactive (default) requires demo for FULL; headless auto-validates demo off-gate.
 * @param {{ headless?: unknown }} input
 * @param {Record<string, unknown>} gs
 * @returns {boolean}
 */
export function isHeadlessDeliveryContext(input = {}, gs = {}) {
  if (input.headless === true) return true;
  if (gs && gs.headless === true) return true;
  try {
    if (typeof process !== "undefined" && process.env) {
      const remote = process.env.CLAUDE_CODE_REMOTE;
      if (remote === "true" || remote === "1") return true;
      const oc = process.env.OPENCODE_HEADLESS;
      if (oc === "true" || oc === "1") return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * @description Writing-task ids from a bound execution-plan: a task counts as a
 * writing task when it declares a non-empty `scope_paths` (an executor produces a
 * capture for it). Returns null when the plan is not enumerable — the A5 push rail
 * is fail-open (never block delivery on a plan we cannot read).
 * @param {unknown} plan
 * @returns {string[] | null}
 */
export function writingTaskIdsFromPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const tasks = /** @type {Record<string, unknown>} */ (plan).tasks;
  if (!Array.isArray(tasks)) return null;
  const ids = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) continue;
    const t = /** @type {Record<string, unknown>} */ (task);
    const id = t.id;
    const scope = t.scope_paths;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!Array.isArray(scope) || scope.length === 0) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * @param {{
 *   command?: unknown,
 *   gateState?: unknown,
 *   sessionId?: unknown,
 *   gateStateLoadOk?: boolean,
 *   headless?: boolean,
 *   gitState?: { branch?: string|null, commitsAhead?: number|null, defaultBranch?: string|null }|null,
 *   isAncestorFn?: (sha: string) => boolean|null,
 *   listHandRecordsForFeatureFn?: (featureId: string) => unknown[],
 *   boundPlan?: { tasks?: unknown[] }|null,
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

    // 4a. review failure/useful caps block ALL delivery (including QUICK launder)
    if (
      gs.review_status === "primary_failure_cap_reached" ||
      gs.review_status === "review_cap_reached"
    ) {
      return {
        ok: false,
        decision: "deny",
        reason:
          `[entry-gate] Blocked: delivery denied while review_status=${String(gs.review_status)}. ` +
          "Recover via canonical ceremony restart (new generation + bound plan) — never reclassify down to QUICK.",
        details: { denied_class: "review-cap-active", review_status: gs.review_status },
      };
    }

    if (mode === "QUICK" && classified) {
      // Anti-launder: QUICK ship is only for genuine QUICK runs — not after LIGHT/FULL residue.
      if (hasElevatedCeremonyResidue(gs)) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: QUICK delivery denied after elevated ceremony residue " +
            "(prior LIGHT/FULL, planner attempt, or dual/review leftovers). " +
            "Finish the LIGHT/FULL path or open a new session — do not reclassify down.",
          details: { denied_class: "quick-launder" },
        };
      }
      // genuine QUICK — fall through to rails 5–9
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
      // LIGHT|FULL require a usable bound planner plan — coordinator must not ship after
      // planner_unavailable / plan_invalid / delivery-blocked (smoke #72 PR without hands).
      if (gs.delivery_status === "delivery-blocked") {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: delivery_status=delivery-blocked — fix planner/review recovery before git push / gh pr.",
          details: {
            denied_class: "delivery-blocked",
            planner_status: gs.planner_status ?? null,
          },
        };
      }
      if (gs.planner_status !== "usable") {
        return {
          ok: false,
          decision: "deny",
          reason:
            `[entry-gate] Blocked: LIGHT/FULL delivery requires planner_status=usable ` +
            `(got ${String(gs.planner_status ?? "missing")}). Dispatch planner or planner-fallback; do not implement inline.`,
          details: {
            denied_class: "planner-not-usable",
            planner_status: gs.planner_status ?? null,
            planner_retry_outcome: gs.planner_retry_outcome ?? null,
          },
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

    // 8b. multitask capture coverage (A5): every writing task in the BOUND plan must
    // show delivery EVIDENCE — a capture-verified stamp OR a hand record for that task.
    // This catches the real gap: a LIGHT/FULL feature shipping with a planned writing
    // task that was never dispatched (no record, no capture = a silent half-build).
    // A task WITH a hand record (any terminal outcome, incl. the shippable
    // DONE_WITH_CONCERNS which the system deliberately does NOT capture-stamp) is left
    // to the existing capture / real-file rails — 8b must not demand a capture the
    // system never produces. Fail-open: only enforced when the bound plan is enumerable.
    if ((mode === "LIGHT" || mode === "FULL") && featureId !== null) {
      const writingTaskIds = writingTaskIdsFromPlan(input.boundPlan);
      if (Array.isArray(writingTaskIds) && writingTaskIds.length > 0) {
        const captured = coerceArray(gs.capture_verified);
        const recordedTaskIds = new Set();
        if (typeof input.listHandRecordsForFeatureFn === "function") {
          try {
            for (const rec of input.listHandRecordsForFeatureFn(featureId) ?? []) {
              const tid = rec && typeof rec === "object" && !Array.isArray(rec) ? rec.taskId : null;
              if (typeof tid === "string" && tid.length > 0) recordedTaskIds.add(tid);
            }
          } catch {
            /* fail-open: unreadable records → treat as none, rely on capture match */
          }
        }
        const missing = writingTaskIds.filter(
          (taskId) =>
            !recordedTaskIds.has(taskId) &&
            !matchesAbsolution(
              fidelityPassEntry(featureId, taskId, null),
              captured,
              isAncestorFn,
            ),
        );
        if (missing.length > 0) {
          return {
            ok: false,
            decision: "deny",
            reason:
              "[entry-gate] Blocked: delivery command denied — writing task(s) " +
              `${missing.join(", ")} in the bound execution-plan have no delivery evidence ` +
              "(no hand record and no capture-verified stamp) — a planned task was never " +
              "dispatched (half-built delivery). Dispatch the hand for each remaining writing " +
              "task before running any delivery command (git push / gh pr create / gh pr merge).",
          };
        }
      }
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

    // 9b. FULL ship preconditions: final review (+ demo when interactive)
    if (mode === "FULL") {
      if (gs.final_review_done !== true) {
        return {
          ok: false,
          decision: "deny",
          details: { denied_class: "final-review-missing" },
          reason:
            "[entry-gate] Blocked: denied_class=final-review-missing; FULL delivery requires " +
            "final dual review recorded (native mark action final-review) before git push / gh pr.",
        };
      }
      if (!isHeadlessDeliveryContext(input, gs) && gs.demo_done !== true) {
        return {
          ok: false,
          decision: "deny",
          details: { denied_class: "demo-missing" },
          reason:
            "[entry-gate] Blocked: denied_class=demo-missing; interactive FULL delivery requires " +
            "demo marker (native mark action demo-done) after operator validates the demo before " +
            "git push / gh pr. Headless sessions skip this rail (auto-validated against ACs).",
        };
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
