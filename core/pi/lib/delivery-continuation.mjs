/** Resume an unfinished authorized workflow, never manufacture completion evidence. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isSafeSessionId, isSafeFeatureId } from "../../shared/lib/feature-id.mjs";
import { isCaptureEligibleHandRecord, recordViolations } from "../../shared/lib/real-file-capture-rail.mjs";
import { validateOcCaptureEligibleHandRecord } from "../../opencode/lib/hand-records.mjs";
import { isChildSession, piSessionId } from "./pi-adapter-map.mjs";
import { piHandRecordPath } from "./pi-paths.mjs";
import { checkPiFinalCommands } from "./pi-command-evidence.mjs";
import { piTaskRegateStatus, missingPiReviewRoles, capturePiReviewInput, isSatisfiedPiTaskReviewReceipt, observedPiTaskReviewRoles } from "./pi-review-evidence.mjs";
import { requiredPiFinalReviewRoles } from "./roles.mjs";
import { readTaskRunBinding } from "./task-run.mjs";
import { checkScope } from "../../shared/lib/capture-oracle.mjs";
import { readPendingReconciliation } from "./memory-cycle.mjs";

const ENTRY = "harness-delivery-continuation";
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = (root, file) => {
  const absolute = path.join(root, file);
  try {
    if (fs.realpathSync(absolute) !== absolute || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size > 4 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch { return null; }
};

// A RED/fixture can advance before freeze commits it. Hash only the admitted
// task's pending bytes: staging, timestamps and runtime files are not progress.
// This is a continuation hint, never capture, fidelity or write authority.
function pendingTaskContent(root, task = {}) {
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  const scopes = [...(task.scope_paths ?? []), ...(task.allowed_writes ?? []),
    ...(task.locked_tests ?? []).flatMap(t => [t.path, ...(t.fixture_paths ?? [])])];
  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z"];
  const files = [...new Set([
    ...git([...diff, "--cached", "HEAD", "--"]).split("\0"),
    ...git([...diff, "--"]).split("\0"),
    ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ])].filter(file => file && checkScope([file], scopes).length === 0 &&
    !/^(?:\.git|\.pi|\.claude|\.codex|\.opencode)(?:\/|$)/.test(file)).sort();
  return files.map(file => {
    const absolute = path.join(root, file);
    try {
      if (fs.realpathSync(path.dirname(absolute)) !== path.dirname(absolute)) return [file, "indirect-path"];
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return [file, "symlink", hash(fs.readlinkSync(absolute))];
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return [file, "unreadable"];
      return [file, stat.mode & 0o111, createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")];
    } catch (error) {
      return [file, error.code === "ENOENT" ? "deleted" : "unreadable"];
    }
  });
}

// Capture authority is intentionally anchored at the implementation producer's
// freezeCommitSha. Later corrective/review commits may advance HEAD without
// requiring a no-op writer; the real task gate accepts that ancestral lineage.
// Keep this advisory continuation detector aligned with the same contract.
function hasCurrentTaskCapture(root, { state, sessionId, featureId, taskId, key, head, pendingContent }) {
  if (pendingContent.length !== 0 || !(state.hand_finished ?? []).includes(key)) return false;
  if ((state.capture_verified ?? []).includes(`${key}@${head}`)) return true;
  const resolved = piHandRecordPath({ projectRoot: root, sessionId, featureId }, taskId);
  if (!resolved.ok) return false;
  const relative = path.relative(root, resolved.path);
  const hand = relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? read(root, relative)
    : null;
  const violations = recordViolations(hand);
  if (!isCaptureEligibleHandRecord(hand) ||
      !validateOcCaptureEligibleHandRecord(hand, { featureId, taskId, sessionId }).ok ||
      violations.scope.length || violations.frozen.length ||
      typeof hand.capturedVerifiedAt !== "string" || !hand.capturedVerifiedAt ||
      !COMMIT_SHA.test(hand.freezeCommitSha ?? "") ||
      !(state.capture_verified ?? []).includes(`${key}@${hand.freezeCommitSha}`)) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", hand.freezeCommitSha, head], {
      cwd: root, stdio: ["ignore", "ignore", "ignore"], timeout: 10000,
    });
    return true;
  } catch { return false; }
}

/** Read-only hints. Existing tools remain the sole approval and scheduling authority. */
export function readDeliveryContinuation(ctx, { readBinding = readTaskRunBinding,
  hasCurrentFinalReviews = input => missingPiReviewRoles(input).length === 0 } = {}) {
  const sessionId = piSessionId(ctx);
  if (isChildSession(ctx) || !isSafeSessionId(sessionId)) return null;
  const root = fs.realpathSync(ctx.cwd);
  if (root !== ctx.cwd) return null;
  const directory = `.pi/harness/state/${sessionId}`;
  const state = read(root, `${directory}/gate-state.json`);
  if (state?.session_id !== sessionId || !isSafeFeatureId(state.feature_id) ||
      !["FULL", "LIGHT"].includes(String(state.mode).toUpperCase())) return null;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const feature = state.feature_id;
  let stage, progress, liveTasks = false, finalPreparation = null;
  let verificationCommands = [];
  if (state.task_run) {
    const binding = readBinding(root, sessionId);
    if (!binding.ok) return null;
    verificationCommands = (binding.task?.locked_tests ?? []).map(test => test.command).filter(Boolean);
    const taskId = binding.grant.task_id;
    const key = `${feature}/${taskId}`;
    const pendingContent = pendingTaskContent(root, binding.task);
    const captured = hasCurrentTaskCapture(root, {
      state, sessionId, featureId: feature, taskId, key, head, pendingContent,
    });
    const reviews = { ...(state.task_review_evidence?.[key] ?? {}), adversary: state.task_adversary_evidence?.[key] };
    const reviewRequired = state.mode.toUpperCase() === "FULL" || Object.values(reviews).some(Boolean);
    const regate = piTaskRegateStatus({ projectRoot: root, state, featureId: feature, taskId, headSha: head });
    const receipts = Object.entries(reviews).filter(([, r]) => r);
    const observed = observedPiTaskReviewRoles(ctx.sessionManager, taskId,
      new Map(receipts.map(([role, r]) => [`harness-${role}`, r.active_dispatch_call_id ?? r.dispatch_call_id])));
    const reviewInput = receipts.length ? capturePiReviewInput({ projectRoot: root, sessionId, featureId: feature, phase: "task", taskId }) : null;
    const regated = regate.satisfied && receipts.every(([role, receipt]) =>
      reviewInput?.ok && isSatisfiedPiTaskReviewReceipt(receipt, { projectRoot: root, sessionId, featureId: feature,
        taskId, role: `harness-${role}`, snapshot: reviewInput.snapshot,
        dispatchCallId: observed?.get(`harness-${role}`)?.callId,
        reviewAfterImplementation: observed?.get(`harness-${role}`)?.afterImplementation }));
    if (captured && (!reviewRequired || regated)) return null;
    stage = captured ? "task-reviews" : "task-implementation";
    progress = { taskId, head, captured, pendingContent, fidelity: state.fidelity_pass?.at(-1),
      reviews: Object.fromEntries(Object.entries(reviews).map(([role, r]) => [role, r ? [r.status, r.accepted, r.report_digest, r.reviewed_head_sha] : null])) };
  } else {
    const registry = read(root, `${directory}/task-runs/index.json`);
    if (registry?.parent_session_id !== sessionId || registry.feature_id !== feature || !registry.tasks) return null;
    const plan = read(root, `.pi/harness/plans/${feature}/execution-plan.json`);
    verificationCommands = plan?.final_review?.verification_commands ?? [];
    const reconciliation = readPendingReconciliation(root, sessionId, head);
    const shipment = read(root, `${directory}/memory-shipment.json`);
    const finalized = read(root, `${directory}/memory-finalized.json`);
    if (!reconciliation && shipment?.written_by === "host-subagent-completion" && shipment.session_id === sessionId &&
        shipment.feature_id === feature && shipment.status === "completed" && shipment.head === head) return null;
    if (!reconciliation && finalized?.written_by === "host-memory-finalize" && finalized.session_id === sessionId && finalized.feature_id === feature && finalized.head === head) return null;
    const tasks = Object.values(registry.tasks).map(e => ({ task: e.task_id, status: e.status,
      head: e.integration?.integrated_head ?? e.result?.child_head, reason: e.reason,
      run: e.launches?.at(-1)?.run_id }));
    liveTasks = tasks.some(t => t.status === "running");
    if (!tasks.length) return null;
    const finalCurrent = state.final_review_done === true && hasCurrentFinalReviews({
      projectRoot: root, sessionId, featureId: feature, phase: "final", roles: requiredPiFinalReviewRoles(plan ?? {}),
    });
    stage = tasks.some(t => t.status !== "integrated") ? "tasks" : finalCurrent ? "shipping" : "final-review";
    if (stage !== "tasks" && reconciliation) stage = "reconciliation";
    const harvest = read(root, `${directory}/memory-harvest.json`);
    if (stage === "final-review" && verificationCommands.length)
      finalPreparation = checkPiFinalCommands({ projectRoot: root, sessionId, commands: verificationCommands, includeAttempts: true });
    progress = { head, tasks, final: state.final_review_done, harvest: harvest?.apply_status,
      ...(reconciliation ? { reconciliation } : {}),
      reviews: Object.fromEntries(Object.entries(state.final_review_evidence ?? {}).map(([role, r]) => [role, [r.status, r.accepted, r.report_digest, r.reviewed_head_sha]])) };
  }
  const instructions = {
    "task-implementation": "Continue this same task through the remaining implementation, verification, capture and applicable reviews. Inspect existing pending work first. If the author already produced the required RED or fixture repair, review its fidelity and freeze/commit the authorized tests, then continue the required implementation; do not redispatch authorship just to repeat that work. Repair an incorrect frozen fixture with the existing test-author/reviewer recovery. Preserve valid product work. If an external dependency or authority is genuinely missing, report that exact blocker; do not repeat an unchanged failed action.",
    "task-reviews": "The task has a capture but its local review closure remains pending. Use harness_reviews phase=task, satisfy only affected missing obligations, then record regate-passed only if its regate status remains unsatisfied. An already satisfied ancestral marker does not need rebinding to HEAD. Do not repeat implementation or valid reviews merely to close the task.",
    tasks: "The delivery still has unsettled tasks. Use harness_tasks status to reconcile actual processes and read diagnostics, wait for live tasks, integrate ready results, and recover actionable blockers in the same attempts. Do not end with only a running label.",
    "final-review": "Task integration is not delivery completion. Verify the current aggregate, finish applicable final reviews and final-review marking, then harvest and ship within the existing authorization. Do not reopen integrated tasks without a concrete finding.",
    shipping: "Finish the existing harvest/apply/shipping obligations, reusing valid receipts. A draft PR is a valid headless delivery boundary; never infer merge, release or deployment authorization from this reminder.",
    reconciliation: "The native base reconciliation still has saved work to finish. Use harness_memory reconcile_mode=preview with the same exact HEAD/base, resolve and stage the next pending hunk, and repeat until ready_to_apply; then use reconcile_mode=apply for the local merge. A partial-progress report is not completion. Do not rebuild the whole JSON or restart completed hunks. If the next hunk is difficult, read all its preview pages and surrounding code; use harness-support for one complete hunk with its exact path, HEAD/base/tree and both sides when necessary, then stage the resolution yourself. Do not replace this work with another task-status report or a statement of the next step. Preserve every valid behavior and test assertion; never shorten a resolution by dropping coverage. Verify the merged product and obtain current reviews afterward. This grants no remote merge/deploy authority; preserve the operator's delivery boundary.",
  };
  // Re-running an identical command does not buy another continuation. A first
  // successful verification on this HEAD does count as progress toward closure.
  let commands = [];
  try {
    commands = fs.readdirSync(path.join(root, directory, "evidence")).filter(f => f.endsWith(".json")).slice(-2000)
      .map(f => read(root, `${directory}/evidence/${f}`))
      .filter(e => e?.head_sha === head && e.worktree_dirty === false && e.original_status?.exit_code === 0)
      .map(e => e.command).filter(c => typeof c === "string" && verificationCommands.includes(c));
  } catch { /* Evidence is advisory; absence never waives a gate. */ }
  const nextCommand = finalPreparation?.ok === false && finalPreparation.attempted_commands?.length === 0
    ? finalPreparation.unattempted_commands?.[0] : undefined;
  const nextAction = nextCommand ? { command: nextCommand, head,
    key: hash({ sessionId, feature, head, command: nextCommand }) } : undefined;
  const content = instructions[stage] + (finalPreparation ? finalPreparation.ok
    ? " Native final verification preparation is already satisfied for current application inputs. Reuse that evidence; do not rerun the full suite for an empty/peripheral reconciliation commit. Continue with the missing final reviews."
    : ` Native preparation requires only these commands: ${JSON.stringify(finalPreparation.commands ?? [])}. A failure requires diagnosis against the SAME application inputs and a concrete correction or justified operational recovery before retrying. A failure on an older implementation does not block testing the corrected HEAD. Use harness_reviews phase=final for current preparation diagnostics.`
    : "");
  return { sessionId, stage, liveTasks, ...(nextAction ? { nextAction } : {}),
    key: hash({ sessionId, feature, stage, progress, commands: [...new Set(commands)].sort() }),
    content: content + (nextAction ? ` The next authorized action is the native bash tool with command=${JSON.stringify(nextCommand)} on HEAD ${head}. It has NOT been attempted on these application inputs. Execute it now; missing verification is work to perform, not an external blocker or a prerequisite for running that very verification. Do not substitute another task-status call or a summary of the next step. Preserve normal policy and evidence hooks; no gate or review is waived.` : "") };
}

/** Progress-sensitive continuation, then diagnosis; neither repeats for unchanged input. */
export function installDeliveryContinuation(pi, { readPending = readDeliveryContinuation, local = false, waitForLiveTasks } = {}) {
  let active = local;
  let paused = false;
  let waiting;
  const seen = new Set();
  const diagnosed = new Set();
  const executionReminded = new Set();
  const owned = ctx => !isChildSession(ctx) && isSafeSessionId(piSessionId(ctx));
  const restore = ctx => {
    for (const e of ctx.sessionManager?.getBranch?.() ?? []) {
      if (e.type === "custom" && e.customType === ENTRY && e.data?.sessionId === piSessionId(ctx)) {
        if (e.data.active === true || e.data.key || e.data.diagnosticKey) active = true;
        if (e.data.key) seen.add(e.data.key);
        if (e.data.diagnosticKey) diagnosed.add(e.data.diagnosticKey);
        if (e.data.executionKey) executionReminded.add(e.data.executionKey);
        if (e.data.paused !== undefined) paused = e.data.paused;
      }
    }
  };
  const reset = (_event, ctx) => {
    if (!owned(ctx)) return;
    waiting?.abort();
    active = local; paused = false; seen.clear(); diagnosed.clear(); executionReminded.clear(); restore(ctx);
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("input", (event, ctx) => {
    if (!owned(ctx) || !["interactive", "rpc"].includes(event.source)) return;
    // Explicit stop requests remain stops even if the model answers normally.
    if (/^\s*(?:\/abort|\/quit|stop|pause|cancel|pare|pausa|cancele|cancelar|n[aã]o continue|do not continue)\b/i.test(event.text ?? "")) {
      paused = true;
      waiting?.abort();
      active = false;
      pi.appendEntry(ENTRY, { sessionId: piSessionId(ctx), paused: true });
    } else if (paused) {
      paused = false;
      active = local;
      pi.appendEntry(ENTRY, { sessionId: piSessionId(ctx), paused: false });
    }
  });
  pi.on("session_shutdown", () => waiting?.abort());
  pi.on("tool_result", (event, ctx) => {
    if (!owned(ctx) || event.isError || paused) return;
    // A fresh workflow action renews existing authorization after a pause.
    const taskProgress = event.toolName === "harness_tasks" && event.details?.ok &&
        event.details.tasks?.some(t => ["running", "ready", "integrated"].includes(t.status));
    const reconciliationProgress = event.toolName === "harness_memory" && event.input?.action === "reconcile" &&
        event.details?.ok && ["preview", "stage"].includes(event.details.reconcile_mode);
    if (taskProgress || reconciliationProgress) {
      if (!active) pi.appendEntry(ENTRY, { sessionId: piSessionId(ctx), active: true });
      active = true;
    }
  });
  return async (event, ctx) => {
    if (!owned(ctx) || !active || paused) return false;
    const last = event.messages?.filter(m => m.role === "assistant").at(-1);
    if (["aborted", "error"].includes(last?.stopReason)) return false;
    try {
      restore(ctx);
      if (paused) return false;
      let pending = readPending(ctx);
      if (!pending) return false;
      // An unchanged RUNNING label is not a failed action. Observe the owning
      // processes in the host, without model polling or spending retry budget.
      if (pending.liveTasks && waitForLiveTasks) {
        const controller = new AbortController();
        waiting = controller;
        let observation;
        try {
          observation = await waitForLiveTasks(ctx, controller.signal);
        } finally {
          if (waiting === controller) waiting = undefined;
        }
        if (controller.signal.aborted || paused) return false;
        if (!observation?.ok || !["changed", "settled"].includes(observation.wait?.outcome))
          throw new Error(observation?.reason ?? "native task observation did not settle");
        pending = readPending(ctx);
        if (!pending) return false;
        // The native wait has reconciled receipts. Wake once to handle its
        // result even when an earlier launch had the same blocked diagnosis.
        await pi.sendMessage({ customType: ENTRY, content: pending.content, display: true },
          { deliverAs: "followUp", triggerTurn: true });
        return true;
      }
      const diagnostic = seen.has(pending.key);
      if (diagnostic && diagnosed.has(pending.key)) {
        // One concrete execution reminder after generic diagnosis was exhausted.
        // It is tied to an unattempted current-input command, not a retry of a
        // failed test. Persist its identity so reloads cannot create a loop.
        if (pending.nextAction && !executionReminded.has(pending.nextAction.key)) {
          await pi.sendMessage({ customType: ENTRY, content:
            "The previous response only described pending verification. No attempt of this command was observed on the current application inputs. Execute the next authorized native bash call now, before another status report. This is verification of the repaired aggregate, not repetition of a failed old implementation.\n" + pending.content,
            display: true }, { deliverAs: "followUp", triggerTurn: true });
          executionReminded.add(pending.nextAction.key);
          pi.appendEntry(ENTRY, { sessionId: pending.sessionId, executionKey: pending.nextAction.key, stage: pending.stage });
          return true;
        }
        ctx.ui?.notify?.("Harness: obrigação pendente após solicitação de diagnóstico, sem progresso observado. A causa não foi classificada pelo runtime; consulte a evidência da sessão. A mesma ação não será repetida automaticamente.", "warning");
        return false;
      }
      const content = diagnostic && pending.nextAction
        ? "The next verification command is still unattempted on the current application inputs. Execute the native bash action below now; do not diagnose an old failure as if the corrected HEAD had already failed. Do not end by describing the command instead of calling it.\n" + pending.content
        : diagnostic
        ? "The authorized delivery obligation remains pending, but no new progress was observed. Diagnose instead of repeating the same failed action. Read the current native status, exact failure and existing hand/reviewer evidence. A task status of blocked is not by itself an external blocker. If a safe existing recovery is available, execute it in the owning task and preserve valid work and reviews. Retain every unresolved material concern in the next brief, or explain its inapplicability against the approved contract. If the cause is unclear, use focused read-only investigation rather than another writer. Ask the operator only for a concrete missing decision, authority or resource; explain what was checked and why autonomous recovery cannot proceed. Do not manufacture a receipt, relax a test or repeat an unchanged command to create progress. This diagnosis grants no new authority.\nPending obligation: " + pending.content
        : pending.content;
      await pi.sendMessage({ customType: ENTRY, content, display: true }, { deliverAs: "followUp", triggerTurn: true });
      if (diagnostic) diagnosed.add(pending.key);
      else seen.add(pending.key);
      pi.appendEntry(ENTRY, { sessionId: pending.sessionId, ...(diagnostic ? { diagnosticKey: pending.key } : { key: pending.key }), stage: pending.stage });
      return true;
    } catch (error) {
      ctx.ui?.notify?.(`Harness: não foi possível continuar automaticamente: ${error.message}`, "warning");
      return false;
    }
  };
}
