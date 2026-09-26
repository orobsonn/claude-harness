/** @description Host-owned inspection and integration receipts for delegated Pi tasks. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { formatFeatureTaskEntry, matchesAbsolution } from "../../shared/lib/absolution.mjs";
import { checkScope } from "../../shared/lib/capture-oracle.mjs";
import { isCaptureEligibleHandRecord, recordViolations } from "../../shared/lib/real-file-capture-rail.mjs";
import { isSafeFeatureId, isSafeSessionId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { parseTestReviewVerdict } from "../../shared/lib/test-review-verdict.mjs";
import { parseHandStatusFromOutput, validateOcCaptureEligibleHandRecord } from "../../opencode/lib/hand-records.mjs";
import { hashTaskReceipt, unsupportedTaskScopePattern } from "./task-contract.mjs";
import { readTaskContextReturn, validateTaskContextReturn } from "./task-context.mjs";
import { readTaskPlanAuthority, recoveredTaskContractHash } from "./task-plan-recovery.mjs";
import { capturePiReviewInput, currentPiReviewIssues, findPiReviewReceipt, isSatisfiedPiTaskReviewReceipt, readPiReviewPlan } from "./pi-review-evidence.mjs";
import { PARALLEL_REVIEW_ROLES, requiredPiTaskReviewRoles } from "./roles.mjs";
import { classifyPiReviewDispatch } from "./pi-review-concurrency.mjs";
import { piGateStatePath, piHandRecordPath } from "./pi-paths.mjs";
import { readTaskProcess } from "./task-process.mjs";
import { capturePlanReviewInput, readTaskRunBinding } from "./task-run.mjs";
import { readPiSpecApproval } from "./spec-approval.mjs";
import { taskScopeBase, taskReconciliationDigest } from "./task-reconciliation.mjs";
import { DURABLE_MEMORY_FILES } from "./memory-cycle.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TASK_REVIEW_ROLES = PARALLEL_REVIEW_ROLES;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS_BYTES = 128 * 1024 * 1024;

function failure(reason, details) {
  return { ok: false, reason, ...(details === undefined ? {} : { details }) };
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function validRuntime(runtime) {
  return object(runtime) && typeof runtime.launcher_path === "string" && path.isAbsolute(runtime.launcher_path) &&
    path.resolve(runtime.launcher_path) === runtime.launcher_path && SHA256.test(runtime.sha256 ?? "");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function regularFile(file, root, limit = MAX_JSON_BYTES) {
  const absolute = path.resolve(file);
  if (!inside(root, absolute)) throw new Error("evidence path escapes its declared root");
  const info = fs.lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("evidence must be a bounded regular file");
  return absolute;
}

function readJson(file, root, limit) {
  return JSON.parse(fs.readFileSync(regularFile(file, root, limit), "utf8"));
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
}

function ancestor(root, before, after) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", before, after], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function splitZero(value) {
  return String(value).split("\0").filter(Boolean);
}

function covered(relativePath, scopes) {
  return checkScope([relativePath], scopes).length === 0;
}

function frozenPaths(task) {
  return [...new Set((Array.isArray(task?.locked_tests) ? task.locked_tests : []).flatMap((item) =>
    object(item) ? [item.path, ...(Array.isArray(item.fixture_paths) ? item.fixture_paths : [])] : [],
  ).filter((item) => typeof item === "string" && item))];
}

function fidelityReviewRole(runtime) {
  const launcher = typeof runtime?.launcher_path === "string" ? runtime.launcher_path : "";
  if (!path.isAbsolute(launcher)) return "harness-compliance";
  const piRoot = path.dirname(path.dirname(launcher));
  const candidates = [
    path.join(piRoot, "runtime", "agents", "harness-test-reviewer.md"),
    path.join(piRoot, "runtime-defaults", "agents", "harness-test-reviewer.md"),
  ];
  const present = candidates.some((file) => {
    try {
      const info = fs.lstatSync(file);
      return info.isFile() && !info.isSymbolicLink();
    } catch { return false; }
  });
  return present ? "harness-test-reviewer" : "harness-compliance";
}

function eventText(result) {
  return Array.isArray(result?.content)
    ? result.content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n")
    : "";
}

function eventSucceeded(event) {
  return event?.end && event.end.isError !== true && event.end.result?.details?.status === "completed";
}

function captureEligibleWriterCompletion(event) {
  if (!eventSucceeded(event)) return false;
  return ["DONE", "DONE_WITH_CONCERNS"].includes(parseHandStatusFromOutput(eventText(event.end.result)));
}

function fidelityReviewApproved(event, reviewRole) {
  if (!eventSucceeded(event)) return false;
  // Legacy pinned runtimes used compliance completion as the fidelity signal. The
  // dedicated reviewer has an explicit terminal verdict, so completion alone must
  // never turn REVISE or BLOCKED into approval.
  if (reviewRole === "harness-compliance") return true;
  return parseTestReviewVerdict(eventText(event.end.result))?.verdict === "APPROVE";
}

function markerSucceeded(event) {
  if (!event?.end || event.end.isError === true) return false;
  if (event.end.result?.details?.ok === true) return true;
  try { return JSON.parse(eventText(event.end.result)).ok === true; } catch { return false; }
}

function taskFromPrompt(prompt) {
  if (typeof prompt !== "string") return "";
  const packet = prompt.match(/\[HARNESS_TASK_CONTEXT\]([\s\S]*?)\[\/HARNESS_TASK_CONTEXT\]/)?.[1];
  if (!packet) return "";
  for (const candidate of [packet, packet.replaceAll('\\"', '"')]) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed?.task_id === "string") return parsed.task_id;
    } catch { /* try the escaped form */ }
  }
  return "";
}

function readEvents(launches, jobRoot, interruptedIndexes = new Set()) {
  const events = [];
  const calls = new Map();
  const sessionIds = new Set();
  let report = null;
  launches.forEach((launch, launchIndex) => {
    report = null; // Never replay a report from an earlier launch after resume.
    let file;
    try { file = regularFile(launch.events_path, jobRoot, MAX_EVENTS_BYTES); }
    catch (error) {
      if (interruptedIndexes.has(launchIndex)) return;
      throw error;
    }
    const source = fs.readFileSync(file, "utf8");
    let line = 0;
    for (const raw of source.split("\n")) {
      line += 1;
      if (!raw) continue;
      let native;
      try { native = JSON.parse(raw); } catch { continue; }
      if (native?.type === "session" && typeof native.id === "string") sessionIds.add(native.id);
      if (native?.type === "message_end" && native.message?.role === "assistant") {
        report = native.message.stopReason === "stop"
          ? { launchIndex, line, text: eventText(native.message) } : null;
      }
      if (native?.type === "tool_execution_start" && typeof native.toolCallId === "string") {
        report = null; // An intermediate answer is not the task's final report.
        const event = { launchIndex, line, callId: native.toolCallId, tool: native.toolName, args: object(native.args) ?? {}, end: null };
        calls.set(`${launchIndex}:${native.toolCallId}`, event);
        events.push(event);
      } else if (native?.type === "tool_execution_end" && typeof native.toolCallId === "string") {
        const start = calls.get(`${launchIndex}:${native.toolCallId}`);
        if (start) { start.end = native; start.endLine = line; }
      }
    }
  });
  return { events, sessionIds, report };
}

// Capture replay observes the reconciled HEAD without rewriting the producer's
// original freeze. Inspection and final integration reads must use the same proof.
function hasReconciledCapture(entry, native, { projectRoot, sessionId, producerCallId, headSha }) {
  const reconciliation = entry.reconciliations?.at(-1);
  if (!reconciliation || native.sessionIds.size !== 1 || !native.sessionIds.has(sessionId)) return false;
  return native.events.some((event) => {
    if (event.launchIndex < reconciliation.launch_count || event.tool !== "mark" ||
        event.args?.action !== "capture-verified" || event.args?.task_id !== entry.task_id || !markerSucceeded(event)) return false;
    let metadata = event.end.result?.details;
    if (!metadata?.capture_origin) { try { metadata = JSON.parse(eventText(event.end.result)); } catch { return false; } }
    const origin = metadata?.capture_origin;
    return origin?.task_id === entry.task_id && origin.producer_call_id === producerCallId &&
      origin.worktree_clean === true && origin.head_sha === headSha && ancestor(projectRoot, reconciliation.merged_head, headSha);
  });
}

function legacyCommitCommand(command) {
  if (typeof command !== "string" || !command.trim() || /[;|\n\r`()<>\\#]/.test(command) ||
      command.includes("$") || command.includes("!") || command.replaceAll("&&", "").includes("&")) return false;
  const segments = command.split("&&").map((item) => item.trim());
  if (segments.some((item) => !item)) return false;
  const commit = /^git\s+commit\s+-m\s+(?:"[^"]+"|'[^']+')$/;
  if (segments.length === 1) return commit.test(segments[0]);
  return segments.length === 4 &&
    /^git\s+add\s+(?:--\s+)?[A-Za-z0-9_./-]+(?:\s+[A-Za-z0-9_./-]+)*$/.test(segments[0]) &&
    commit.test(segments[1]) && segments[2] === "git status --short" &&
    segments[3] === "git log -1 --format='%H%n%s'";
}

function commitFromEvent(event, worktree) {
  if (event?.tool !== "bash" || !/\bgit\s+commit\b/.test(event.args?.command ?? "") || !event.end || event.end.isError === true) return null;
  const text = eventText(event.end.result);
  const abbreviated = text.match(/^\[[^\]\n]+\s+([0-9a-f]{7,40})\]/m)?.[1]
    ?? text.match(/\bcommit\s+([0-9a-f]{7,40})\b/i)?.[1];
  if (!abbreviated) return null;
  try {
    const sha = String(git(worktree, ["rev-parse", `${abbreviated}^{commit}`])).trim();
    return COMMIT_SHA.test(sha) ? sha : null;
  } catch { return null; }
}

function legacyCommitFromEvent(event, worktree) {
  if (!legacyCommitCommand(event?.args?.command)) return null;
  const text = eventText(event?.end?.result);
  // Require the native `git commit` summary itself. A later `git log`, `show`
  // or echo may mention any SHA and is not proof that this command created it.
  const abbreviated = event?.tool === "bash" && event.end && event.end.isError !== true
    ? text.match(/^\[[^\]\n]+\s+([0-9a-f]{7,40})\]/m)?.[1]
    : null;
  if (!abbreviated) return null;
  try {
    const sha = String(git(worktree, ["rev-parse", `${abbreviated}^{commit}`])).trim();
    return COMMIT_SHA.test(sha) ? sha : null;
  } catch { return null; }
}

function observedImplementationReviewRoles(events, taskId) {
  const firstImplementation = events.find((event) => event.tool === "subagent" &&
    ["harness-executor", "harness-sniper"].includes(event.args?.subagent_type) &&
    taskFromPrompt(event.args?.prompt) === taskId && eventSucceeded(event));
  return new Map(events.filter((event) => {
    const review = event.tool === "subagent" && classifyPiReviewDispatch(event.args?.subagent_type, event.args?.prompt);
    // A tool-call refused by the entry gate has a start/end pair but never
    // reached a child. It is audit evidence of an attempted call, not a review
    // dispatch, and must not supersede the call id of an accepted receipt.
    const refusedByGate = event.end?.isError === true &&
      eventText(event.end.result).trimStart().startsWith("[review-dispatch] Blocked:");
    return review?.phase === "task" && review.taskId === taskId && !refusedByGate;
  }).map((event) => [event.args.subagent_type, { callId: event.callId,
    afterImplementation: Boolean(firstImplementation && (event.launchIndex > firstImplementation.launchIndex ||
      event.launchIndex === firstImplementation.launchIndex && event.line > firstImplementation.endLine)),
  }]));
}

function validateCurrentReviews({ state, events, plan, task, projectRoot, sessionId, featureId, taskId, head, captureReviewInputFn }) {
  const captured = captureReviewInputFn({ projectRoot, sessionId, featureId, phase: "task", taskId });
  if (!captured?.ok || captured.snapshot?.head_sha !== head) return failure("current canonical task review snapshot required");
  const receipts = {};
  const observed = observedImplementationReviewRoles(events, taskId);
  const baseline = requiredPiTaskReviewRoles(plan, task);
  const roles = TASK_REVIEW_ROLES.filter((role) => baseline.includes(role) || observed.has(role) ||
    findPiReviewReceipt(state, { featureId, taskId, role, phase: "task" }) !== null);
  const findings = roles.flatMap((role) => {
    const receipt = findPiReviewReceipt(state, { featureId, taskId, role, phase: "task" });
    const issues = currentPiReviewIssues(receipt, { sessionId, featureId, taskId, role, phase: "task", snapshot: captured.snapshot });
    return issues.length ? [{ role, issues }] : [];
  });
  for (const role of roles) {
    const receipt = findPiReviewReceipt(state, { featureId, taskId, role, phase: "task" });
    if (!isSatisfiedPiTaskReviewReceipt(receipt, { projectRoot, sessionId, featureId, taskId, role,
      snapshot: captured.snapshot, dispatchCallId: observed.get(role)?.callId,
      reviewAfterImplementation: observed.get(role)?.afterImplementation })) {
      return failure("current accepted " + role.replace("harness-", "") + " task review required", { review_findings: findings });
    }
    receipts[role.replace("harness-", "")] = {
      agent_id: receipt.agent_id,
      dispatch_call_id: receipt.dispatch_call_id,
      child_session_id: receipt.child_session_id,
      input_digest: receipt.input_digest,
      report_digest: receipt.report_digest,
      reviewed_head_sha: receipt.reviewed_head_sha,
    };
  }
  return { ok: true, inputDigest: captured.snapshot.input_digest, receipts };
}

function validateDependencies(grant, task, entry) {
  const expected = Array.isArray(task?.depends_on) ? task.depends_on : [];
  const recorded = Array.isArray(grant?.dependencies) ? grant.dependencies : [];
  if (recorded.length !== expected.length) return failure("grant dependency evidence does not match the canonical task");
  for (const taskId of expected) {
    const dependency = recorded.find((item) => item?.task_id === taskId);
    if (!dependency || !SHA256.test(dependency.receipt_sha256 ?? "")) return failure(`dependency ${taskId} lacks an integration receipt hash`);
    const receipt = object(dependency.receipt);
    if (!receipt || hashTaskReceipt(receipt) !== dependency.receipt_sha256 || receipt.version !== 1 ||
        receipt.written_by !== "host-task-integration" || receipt.parent_session_id !== entry.parent_session_id ||
        receipt.feature_id !== entry.feature_id || receipt.task_id !== taskId || receipt.parent_root !== entry.parent_root ||
        receipt.plan_sha256 !== entry.plan_sha256 || receipt.spec_sha256 !== entry.spec_sha256 ||
        dependency.child_head !== receipt.child_head || dependency.integrated_head !== receipt.integrated_head ||
        !COMMIT_SHA.test(receipt.child_head ?? "") || !COMMIT_SHA.test(receipt.integrated_head ?? "") ||
        !ancestor(entry.parent_root, receipt.child_head, receipt.integrated_head) ||
        !ancestor(entry.parent_root, receipt.integrated_head, entry.base_sha)) return failure(`dependency ${taskId} receipt is invalid for the task base`);
  }
  return { ok: true };
}

function validateLaunches(entry, jobRoot, readTaskProcessFn = readTaskProcess, allowFailedLatest = false) {
  if (!Array.isArray(entry.launches) || entry.launches.length === 0) return failure("task run has no launches");
  const lifecycles = [];
  const interruptedIndexes = new Set();
  for (const [index, launch] of entry.launches.entries()) {
    const historical = index < entry.launches.length - 1;
    if (!object(launch) || typeof launch.run_id !== "string" || !launch.run_id ||
        !(Number.isInteger(launch.pid) && launch.pid > 1 || launch.pid === null && (historical || launch.terminal_mode === true))) {
      return failure(`launch ${index} identity is invalid`);
    }
    if (entry.runtime !== undefined) {
      if (!validRuntime(entry.runtime) || !validRuntime(launch.runtime) || !historical &&
          (launch.runtime.sha256 !== entry.runtime.sha256 || launch.runtime.launcher_path !== entry.runtime.launcher_path))
        return failure(`launch ${index} runtime identity is invalid`);
    }
    const observed = readTaskProcessFn(launch);
    if (observed?.running || !observed?.terminal) return failure(`launch ${index} is not terminal: ${observed?.reason ?? "worker process group remains active"}`);
    if (!observed.ok && index < entry.launches.length - 1) {
      interruptedIndexes.add(index);
      lifecycles.push({ exitCode: null, signal: "UNKNOWN", timedOut: false, ended_at: null, interrupted: true, reason: observed.reason });
      continue;
    }
    if (!observed.ok) return failure(`latest launch completion is unavailable: ${observed.reason}`);
    const lifecycle = observed.result;
    if (!object(lifecycle) || typeof lifecycle.ended_at !== "string" || !lifecycle.ended_at ||
        !(lifecycle.signal === null || typeof lifecycle.signal === "string")) {
      return failure(`launch ${index} lifecycle is not terminal`);
    }
    lifecycles.push(lifecycle);
  }
  const last = lifecycles.at(-1);
  if (!allowFailedLatest && (last.exitCode !== 0 || last.timedOut || last.signal !== null)) return failure("latest task launch did not exit successfully", {
    launch_failure: { run_id: entry.launches.at(-1).run_id, exit_code: last.exitCode,
      signal: last.signal, timed_out: last.timedOut === true, ended_at: last.ended_at },
  });
  return { ok: true, lifecycles, interruptedIndexes };
}

function validateFidelity({ events, task, taskId, worktree, head, reviewRole }) {
  const paths = frozenPaths(task);
  if (paths.length === 0) return { ok: true, freezeSha: null, frozenBlobs: {}, markerIndex: -1 };
  const fidelityMarkers = events.filter((event) => event.tool === "mark" && event.args?.action === "fidelity" && event.args?.task_id === taskId && markerSucceeded(event));
  const marker = fidelityMarkers.at(-1);
  if (!marker) return failure("latest successful native fidelity marker required");
  const latestMarkerIndex = events.indexOf(marker);
  if (events.some((event, index) => index > latestMarkerIndex && event.tool === "subagent" && event.args?.subagent_type === "harness-test-author" && eventSucceeded(event))) {
    return failure("latest test-author work has no subsequent fidelity marker");
  }
  const authorIndex = events.findLastIndex((event, index) => index < latestMarkerIndex && event.tool === "subagent" && event.args?.subagent_type === "harness-test-author" && eventSucceeded(event));
  const commitEvent = events.find((event, index) => index > authorIndex && index < latestMarkerIndex && commitFromEvent(event, worktree));
  const commitSha = commitFromEvent(commitEvent, worktree);
  if (!commitSha || !ancestor(worktree, commitSha, head)) return failure("fidelity freeze commit is missing or not ancestral to task HEAD");
  const commitIndex = events.indexOf(commitEvent);
  const markerIndex = events.findIndex((event, index) => index > commitIndex && fidelityMarkers.includes(event));
  const reviewIndex = events.findLastIndex((event, index) => index > authorIndex && index < commitIndex && event.tool === "subagent" &&
    event.args?.subagent_type === reviewRole && (reviewRole === "harness-compliance" ? eventSucceeded(event) : true));
  if (authorIndex < 0 || reviewIndex < 0 || !fidelityReviewApproved(events[reviewIndex], reviewRole))
    return failure(`fidelity requires native test-author then ${reviewRole} APPROVE before the freeze commit`);
  const changed = String(git(worktree, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha])).trim().split("\n").filter(Boolean);
  if (changed.length === 0 || changed.some((item) => !paths.includes(item))) return failure("fidelity freeze commit must change only canonical frozen files");
  const blobs = {};
  for (const file of paths) {
    try {
      const frozen = git(worktree, ["show", `${commitSha}:${file}`], null);
      const current = git(worktree, ["show", `${head}:${file}`], null);
      if (!Buffer.from(frozen).equals(Buffer.from(current))) return failure(`frozen file changed after fidelity: ${file}`);
      blobs[file] = crypto.createHash("sha256").update(current).digest("hex");
    } catch { return failure(`canonical frozen file is absent from the fidelity chain: ${file}`); }
  }
  return { ok: true, freezeSha: commitSha, frozenBlobs: blobs, markerIndex, authorIndex };
}

function onlyFrozenChanges(root, baseline, head, paths) {
  return ancestor(root, baseline, head) && splitZero(git(root, ["diff", "--no-renames", "--name-only", "-z", baseline, head, "--"]))
    .every((file) => paths.includes(file));
}

function onlyRecoveryChanges(entry, root, baseline, head, task, plan) {
  const paths = frozenPaths(task);
  // taskScopeBase has already verified these exact host merges. Only their
  // imported frozen tests/durable notes may cross a historical implementation
  // capture; the child's own deltas remain restricted to its frozen paths.
  const importedPaths = [...plan.tasks.flatMap(frozenPaths), ...DURABLE_MEMORY_FILES];
  let cursor = baseline;
  for (const proof of entry.reconciliations ?? []) {
    if (ancestor(root, proof.merged_head, baseline)) continue;
    if (!onlyFrozenChanges(root, cursor, proof.pre_child_head, paths) ||
        !onlyFrozenChanges(root, proof.pre_child_head, proof.merged_head, importedPaths)) return false;
    cursor = proof.merged_head;
  }
  return onlyFrozenChanges(root, cursor, head, paths);
}

function integratedRecoveryOrigin(entry, { sessionId, task, events, implementationIndex, producerIndex }) {
  // A failed immediate pair must not revive an older integration or event capture.
  const integration = entry.integration_history.at(-1);
  const result = object(integration) && SHA256.test(integration.result_sha256 ?? "") &&
    object(entry.result_history)?.[integration.result_sha256];
  if (!object(result) || hashTaskReceipt(result) !== integration.result_sha256 ||
      result.session_id !== sessionId || !Array.isArray(result.launches) || !result.launches.length ||
      result.launches.length > entry.launches.length)
    return failure("test-only recovery requires the immediately previous matching host integration and inspection");
  const historicalEntry = { ...entry, result, launches: entry.launches.slice(0, result.launches.length),
    reconciliations: entry.reconciliations?.filter((proof) => proof.launch_count < result.launches.length) };
  const validated = validateIntegration(historicalEntry, integration, {
    projectRoot: entry.parent_root, sessionId: entry.parent_session_id,
    featureId: entry.feature_id, taskId: entry.task_id, headSha: integration.integrated_head,
  });
  if (!validated.ok) return failure("test-only recovery historical receipt is invalid: " + validated.reason);
  if (JSON.stringify(frozenPaths(task).sort()) !== JSON.stringify(Object.keys(result.frozen_blobs).sort()))
    return failure("test-only recovery historical frozen paths must match the canonical task");
  // A resumed task can implement new behavior and then repair its tests. That
  // implementation needs its own clean capture; the old integration cannot
  // supply or replace it merely because this task has integration history.
  if (events[implementationIndex].launchIndex >= result.launches.length)
    return { ok: true, origin: null };
  const hand = result.hand_capture;
  const historicalProducerIndex = events.findIndex((event) => event.callId === hand.producer_call_id &&
    event.launchIndex === hand.producer_launch_index && event.tool === "subagent" &&
    event.args?.subagent_type === hand.agent && taskFromPrompt(event.args?.prompt) === entry.task_id && eventSucceeded(event));
  const implementation = events[implementationIndex];
  const origin = hand.agent === "harness-test-author" ? hand.recovery_origin : {
    producer_call_id: hand.producer_call_id, producer_launch_index: hand.producer_launch_index,
  };
  if (historicalProducerIndex < implementationIndex || historicalProducerIndex >= producerIndex ||
      hand.producer_launch_index >= result.launches.length || origin.producer_call_id !== implementation.callId ||
      origin.producer_launch_index !== implementation.launchIndex)
    return failure("test-only recovery historical producer is not bound to the native implementation lineage");
  return { ok: true, origin: { head_sha: result.child_head, producer_call_id: origin.producer_call_id,
    producer_launch_index: origin.producer_launch_index } };
}

/** Only the host's sealed abandonment proof can exclude a writer from lineage.
 * Review events, raw launches and their cost remain in the ordinary inspection.
 */
function abandonedWriterLaunches(entry, jobRoot) {
  const indexes = new Set();
  if (entry.abandoned_resumes === undefined) return indexes;
  if (!Array.isArray(entry.abandoned_resumes)) throw new Error("invalid resume abandonment history");
  for (const record of entry.abandoned_resumes) {
    const proof = record?.proof;
    const integration = entry.integration_history?.find((receipt) => hashTaskReceipt(receipt) === proof?.integration_sha256);
    const result = entry.result_history?.[proof?.result_sha256];
    if (record?.written_by !== "host-task-resume-abandonment" || record.no_product_obligation !== true ||
        typeof record.reason !== "string" || !record.reason.trim() || !integration || !result ||
        proof.result_sha256 !== integration.result_sha256 || hashTaskReceipt(result) !== proof.result_sha256 ||
        proof.child_head !== result.child_head || proof.review_input_digest !== result.review_input_digest ||
        !COMMIT_SHA.test(proof.parent_head ?? "") ||
        !ancestor(entry.parent_root, integration.integrated_head, proof.parent_head) ||
        !ancestor(entry.parent_root, proof.parent_head, "HEAD") ||
        proof.inspected_launch_count !== result.launches?.length ||
        !Number.isInteger(proof.launch_count) || proof.launch_count <= proof.inspected_launch_count ||
        proof.launch_count > entry.launches.length ||
        hashTaskReceipt(entry.launches.slice(0, proof.launch_count)) !== proof.launches_sha256 ||
        !Array.isArray(proof.events_sha256) || proof.events_sha256.length !== proof.launch_count ||
        !object(proof.hand_record) || hashTaskReceipt(proof.hand_record) !== proof.hand_sha256)
      throw new Error("resume abandonment history is not bound to its host receipt and launch interval");
    const historical = validateIntegration({ ...entry, result, launches: entry.launches.slice(0, result.launches.length),
      reconciliations: entry.reconciliations?.filter((item) => item.launch_count < result.launches.length) }, integration, {
      projectRoot: entry.parent_root, sessionId: entry.parent_session_id,
      featureId: entry.feature_id, taskId: entry.task_id, headSha: integration.integrated_head,
    });
    if (!historical.ok) throw new Error(historical.reason);
    for (let index = 0; index < proof.launch_count; index++) {
      const bytes = fs.readFileSync(regularFile(entry.launches[index].events_path, jobRoot, MAX_EVENTS_BYTES));
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== proof.events_sha256[index])
        throw new Error("resume abandonment native events changed");
      if (index >= proof.inspected_launch_count) indexes.add(index);
    }
  }
  return indexes;
}

/**
 * Inspect a ready delegated task from host-owned files and native event streams.
 * Historic failed/timed-out launches may be repaired by a later successful launch, but every
 * worker process group must have ended before this function can issue a receipt.
 */
export function inspectTaskRun(entry, dependencies = {}) {
  try {
    if (!object(entry)) return failure("task run entry must be an object");
    for (const field of ["task_id", "attempt_id", "parent_session_id", "parent_root", "feature_id", "plan_sha256", "spec_sha256", "base_sha", "worktree", "grant_path", "job_dir"]) {
      if (typeof entry[field] !== "string" || !entry[field]) return failure(`task run ${field} is required`);
    }
    if (!isSafeTaskId(entry.task_id) || !isSafeFeatureId(entry.feature_id) || !isSafeSessionId(entry.parent_session_id) ||
        !SHA256.test(entry.plan_sha256) || !SHA256.test(entry.spec_sha256) || !COMMIT_SHA.test(entry.base_sha)) return failure("task run identity is invalid");
    const parentRoot = fs.realpathSync(entry.parent_root);
    const worktree = fs.realpathSync(entry.worktree);
    const jobRoot = fs.realpathSync(entry.job_dir);
    if (parentRoot !== path.resolve(entry.parent_root) || worktree !== path.resolve(entry.worktree) || jobRoot !== path.resolve(entry.job_dir)) return failure("task run roots must be canonical");
    const launches = validateLaunches(entry, jobRoot, dependencies.readTaskProcessFn ?? readTaskProcess);
    if (!launches.ok) return launches;
    const claim = readJson(`${entry.grant_path}.claim`, worktree);
    if (!object(claim) || !isSafeSessionId(claim.session_id)) return failure("task grant claim lacks the actual child session");
    const bindingFn = dependencies.readTaskRunBindingFn ?? readTaskRunBinding;
    const binding = bindingFn(worktree, claim.session_id);
    if (!binding?.ok) return failure(`task binding is invalid: ${binding?.reason ?? "unknown"}`);
    const grant = binding.grant;
    if (grant.task_id !== entry.task_id || grant.attempt_id !== entry.attempt_id || grant.parent_session_id !== entry.parent_session_id ||
        grant.parent_root !== parentRoot || grant.feature_id !== entry.feature_id || grant.plan_sha256 !== entry.plan_sha256 ||
        grant.spec_sha256 !== entry.spec_sha256 || grant.base_sha !== entry.base_sha || path.resolve(grant.cwd ?? "") !== worktree ||
        path.resolve(entry.grant_path) !== path.resolve(binding.grantPath ?? entry.grant_path)) return failure("task binding does not match the registry entry");
    // readTaskRunBinding is the authority for current-vs-historical dependency registry lineage.
    // Here we only bind the immutable dependency payload to this grant and its task base.
    const dependencyCheck = validateDependencies(grant, binding.task, { ...entry, parent_root: parentRoot });
    if (!dependencyCheck.ok) return dependencyCheck;
    const head = String(git(worktree, ["rev-parse", "HEAD"])).trim();
    if (!COMMIT_SHA.test(head) || !ancestor(worktree, entry.base_sha, head)) return failure("task HEAD is not descended from its granted base");
    const native = readEvents(entry.launches, jobRoot, launches.interruptedIndexes);
    const abandonedWriters = abandonedWriterLaunches(entry, jobRoot);
    if (native.sessionIds.size !== 1 || !native.sessionIds.has(claim.session_id)) return failure("native event session does not match the claimed child session");
    // A blocked hand can explain its failure without being eligible to approve it.
    // Bind diagnostics before capture checks, using the same identity/hash contract
    // as successful returns; never turn this context into an implementation receipt.
    const contextReturnFn = dependencies.readTaskContextReturnFn ?? readTaskContextReturn;
    const contextReturn = contextReturnFn({ projectRoot: worktree, sessionId: claim.session_id, taskId: entry.task_id, headSha: head });
    if (contextReturn !== null) {
      const checkedContext = validateTaskContextReturn(contextReturn, { sessionId: claim.session_id, taskId: entry.task_id, headSha: head });
      if (!checkedContext.ok) return failure("task context return is invalid: " + checkedContext.reason);
    }
    const contextDiagnostics = contextReturn === null ? {} : { context_return: contextReturn };
    const observedReport = native.report?.text;
    if (observedReport?.trim()) contextDiagnostics.task_report = {
      session_id: claim.session_id, run_id: entry.launches.at(-1).run_id,
      head_sha: head, text: observedReport.slice(0, 6000), truncated: observedReport.length > 6000,
    };
    const tracked = String(git(worktree, ["status", "--porcelain", "--untracked-files=no"])).trim();
    const untracked = tracked ? "" : String(git(worktree, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).pi/harness/runtime/", ":(exclude).pi/harness/state/", ":(exclude).pi/harness/sessions/", ":(exclude)node_modules/"])).trim();
    if (tracked || untracked) return failure("task worktree must be clean before inspection", {
      ...contextDiagnostics,
      worktree_changes: { task_id: entry.task_id, worktree,
        status: (tracked || untracked).slice(0, 6000), truncated: (tracked || untracked).length > 6000 },
    });
    const changed = splitZero(git(worktree, ["diff", "--name-only", "-z", entry.base_sha, head]));
    const scopes = [
      ...(Array.isArray(binding.task?.scope_paths) ? binding.task.scope_paths : []),
      ...(Array.isArray(binding.task?.allowed_writes) ? binding.task.allowed_writes : []),
      ...frozenPaths(binding.task),
    ];
    const unsupportedScope = scopes.find(unsupportedTaskScopePattern);
    if (unsupportedScope !== undefined) {
      return failure(`task scope ${JSON.stringify(unsupportedScope)} uses unsupported glob syntax`);
    }
    const scopeBase = taskScopeBase(entry, worktree, head, scopes);
    const scopedChanges = splitZero(git(worktree, ["diff", "--name-only", "-z", scopeBase, head]));
    if (scopedChanges.some((item) => !covered(item, scopes))) return failure("task changed paths outside canonical scope", { changed: scopedChanges });
    const implementationObserved = native.events.some((event) => event.tool === "subagent" && ["harness-executor", "harness-sniper"].includes(event.args?.subagent_type) && eventSucceeded(event));
    if (!implementationObserved) return failure("successful native implementation call was not observed", contextDiagnostics);
    const statePath = piGateStatePath({ projectRoot: worktree, sessionId: claim.session_id });
    const handPath = piHandRecordPath({ projectRoot: worktree, sessionId: claim.session_id, featureId: entry.feature_id }, entry.task_id);
    const state = readJson(statePath.path, worktree);
    const hand = readJson(handPath.path, worktree);
    const blockedDiagnostics = (currentReviews) => {
      const details = { ...contextDiagnostics };
      const producer = native.events.findLast((event) => event.callId === hand?.producerCallId &&
        event.tool === "subagent" && event.args?.subagent_type === hand.agent &&
        taskFromPrompt(event.args?.prompt) === entry.task_id && eventSucceeded(event));
      if (hand?.sessionId === claim.session_id && hand.featureId === entry.feature_id &&
          hand.taskId === entry.task_id && producer?.launchIndex === entry.launches.length - 1) {
        const text = eventText(producer.end.result);
        if (text.trim()) details.hand_report = { producer_call_id: producer.callId,
          agent: hand.agent, text: text.slice(0, 6000), truncated: text.length > 6000 };
      }
      // These are explanations only. Capture/fidelity/review failures below retain
      // their authority; a DONE sentence must never produce a ready receipt.
      try {
        const reviews = currentReviews ?? validateCurrentReviews({ state, events: native.events, plan: binding.plan,
          task: binding.task, projectRoot: worktree, sessionId: claim.session_id,
          featureId: entry.feature_id, taskId: entry.task_id, head,
          captureReviewInputFn: dependencies.captureReviewInputFn ?? capturePiReviewInput });
        details.review_findings = reviews.details?.review_findings ?? [];
      } catch { /* Unavailable review evidence cannot hide the original capture failure. */ }
      return details;
    };
    if (!isCaptureEligibleHandRecord(hand)) return failure("current child hand record is not capture-eligible", blockedDiagnostics());
    const identity = validateOcCaptureEligibleHandRecord(hand, { featureId: entry.feature_id, taskId: entry.task_id, sessionId: claim.session_id });
    const violations = recordViolations(hand);
    if (!identity.ok || violations.scope.length || violations.frozen.length || typeof hand.capturedVerifiedAt !== "string" || !hand.capturedVerifiedAt ||
        !COMMIT_SHA.test(hand.freezeCommitSha ?? "") || !ancestor(worktree, hand.freezeCommitSha, head)) return failure("current child hand capture is invalid", blockedDiagnostics());
    const reconciliation = entry.reconciliations?.at(-1);
    // A native replay captures the current clean HEAD without rewriting the
    // original producer's SHA. Host reconciliation alone needs no no-op writer.
    const reconciledCapture = hasReconciledCapture(entry, native, { projectRoot: worktree,
      sessionId: claim.session_id, producerCallId: hand.producerCallId, headSha: head });
    if (reconciliation && !reconciledCapture && !ancestor(worktree, reconciliation.merged_head, hand.freezeCommitSha))
      return failure("current hand requires a new capture after dependency reconciliation");
    const isImplementationForTask = (event) => event.tool === "subagent" &&
      !abandonedWriters.has(event.launchIndex) &&
      ["harness-executor", "harness-sniper"].includes(event.args?.subagent_type) &&
      taskFromPrompt(event.args?.prompt) === entry.task_id && eventSucceeded(event);
    const recovery = hand.agent === "harness-test-author";
    const producerIndex = native.events.findIndex((event) => event.callId === hand.producerCallId &&
      event.args?.subagent_type === hand.agent && taskFromPrompt(event.args?.prompt) === entry.task_id &&
      eventSucceeded(event) && (recovery || isImplementationForTask(event)));
    if (producerIndex < 0) return failure("current hand producer is not bound to a successful native call by an implementation agent");
    if (reconciliation && !reconciledCapture && native.events[producerIndex].launchIndex < reconciliation.launch_count)
      return failure("current hand requires an implementation producer after dependency reconciliation");
    const fidelity = validateFidelity({
      events: native.events,
      task: binding.task,
      taskId: entry.task_id,
      worktree,
      head,
      reviewRole: fidelityReviewRole(entry.runtime),
    });
    if (!fidelity.ok) return fidelity;
    let recoveryOrigin = null;
    if (recovery) {
      // A refused dispatch has no writing hand. Keep in-flight calls countable
      // so the ordering checks remain conservative while a launch is running.
      const isCountingWriter = (event) => event.tool === "subagent" &&
        !abandonedWriters.has(event.launchIndex) &&
        event.end?.isError !== true &&
        ["harness-executor", "harness-sniper", "harness-test-author"].includes(event.args?.subagent_type);
      const implementationIndex = native.events.findLastIndex((event, index) => index < producerIndex && isImplementationForTask(event));
      const firstAuthorIndex = native.events.findIndex((event, index) => index > implementationIndex && isCountingWriter(event) &&
        event.args.subagent_type === "harness-test-author");
      if (implementationIndex < 0 ||
          native.events.some((event, index) => index > implementationIndex && index < producerIndex &&
            isCountingWriter(event) && event.args.subagent_type !== "harness-test-author"))
        return failure("test-only recovery requires a prior captured implementation after dependency reconciliation");
      if (entry.integration || entry.integration_history !== undefined && !Array.isArray(entry.integration_history))
        return failure("test-only recovery requires a resumed task with valid integration history");
      if (entry.integration_history?.length) {
        const previous = integratedRecoveryOrigin(entry, { sessionId: claim.session_id, task: binding.task,
          events: native.events, implementationIndex, producerIndex });
        if (!previous.ok) return previous;
        recoveryOrigin = previous.origin;
      }
      let captureAttemptedBeforeAuthor = false;
      if (!recoveryOrigin) for (const event of native.events.slice(implementationIndex + 1, firstAuthorIndex)) {
        if (event.tool !== "mark" || event.args?.action !== "capture-verified" || event.args?.task_id !== entry.task_id) continue;
        captureAttemptedBeforeAuthor = true;
        if (!markerSucceeded(event)) continue;
        const firstAuthor = native.events[firstAuthorIndex];
        if (event.launchIndex === firstAuthor.launchIndex && event.endLine >= firstAuthor.line) continue;
        let metadata = event.end.result?.details;
        if (!metadata?.capture_origin) { try { metadata = JSON.parse(eventText(event.end.result)); } catch { continue; } }
        const origin = metadata?.capture_origin;
        if (origin?.task_id !== entry.task_id || origin.producer_call_id !== native.events[implementationIndex].callId ||
            origin.worktree_clean !== true || !COMMIT_SHA.test(origin.head_sha ?? "")) continue;
        recoveryOrigin = { head_sha: origin.head_sha, producer_call_id: origin.producer_call_id,
          producer_launch_index: native.events[implementationIndex].launchIndex };
        break;
      }
      // Bounded legacy recovery for the concrete v3.1.4 ordering defect. Native
      // evidence must show a capture-eligible implementation, then a successful
      // product commit before the first author. The author's terminal HEAD must
      // still equal that commit and be a strict ancestor of the final test-only
      // commit. This deliberately rejects HEAD→HEAD inference and BLOCKED hands.
      const implementation = native.events[implementationIndex];
      const firstAuthor = native.events[firstAuthorIndex];
      const preAuthorCommits = native.events.slice(implementationIndex + 1, firstAuthorIndex)
        .filter((event) => Number.isInteger(implementation.endLine) && Number.isInteger(event.endLine) &&
          (event.launchIndex > implementation.launchIndex ||
            event.launchIndex === implementation.launchIndex && event.line > implementation.endLine) &&
          (event.launchIndex < firstAuthor.launchIndex ||
            event.launchIndex === firstAuthor.launchIndex && event.endLine < firstAuthor.line))
        .map((event) => legacyCommitFromEvent(event, worktree)).filter(Boolean);
      const preAuthorCommit = preAuthorCommits.at(-1) ?? null;
      if (!recoveryOrigin && !captureAttemptedBeforeAuthor && producerIndex === firstAuthorIndex &&
          captureEligibleWriterCompletion(implementation) && preAuthorCommit === hand.freezeCommitSha &&
          COMMIT_SHA.test(hand.freezeCommitSha ?? "") && hand.freezeCommitSha !== head &&
          ancestor(worktree, hand.freezeCommitSha, head)) {
        recoveryOrigin = {
          head_sha: hand.freezeCommitSha,
          producer_call_id: native.events[implementationIndex].callId,
          producer_launch_index: native.events[implementationIndex].launchIndex,
          derived_from: "pre-author-product-commit",
        };
      }
      if (!recoveryOrigin) return failure("test-only recovery requires a clean captured implementation before the first test-author; commit then capture before correcting tests", contextDiagnostics);
      if (producerIndex !== fidelity.authorIndex || native.events.some((event, index) => index > producerIndex && isCountingWriter(event)))
        return failure("test-only recovery requires the latest fidelity author without a later writing hand");
      if (!fidelity.freezeSha || !ancestor(worktree, hand.freezeCommitSha, fidelity.freezeSha) ||
          !ancestor(worktree, recoveryOrigin.head_sha, hand.freezeCommitSha) ||
          !onlyRecoveryChanges(entry, worktree, recoveryOrigin.head_sha, head, binding.task, binding.plan))
        return failure("test-only recovery cannot change product after the captured implementation");
    } else if (fidelity.freezeSha !== null) {
      if (!ancestor(worktree, fidelity.freezeSha, hand.freezeCommitSha)) {
        return failure("current hand capture is not descended from the event-proven latest freeze");
      }
      const latestProducerIndex = native.events.findLastIndex((event, index) =>
        index > fidelity.markerIndex && isImplementationForTask(event));
      if (producerIndex <= fidelity.markerIndex || producerIndex !== latestProducerIndex) {
        return failure("current hand producer is not the latest successful implementation call after fidelity");
      }
    }
    const bare = formatFeatureTaskEntry(entry.feature_id, entry.task_id);
    if (fidelity.freezeSha !== null && (!Array.isArray(state.fidelity_pass) || !state.fidelity_pass.includes(`${bare}@${fidelity.freezeSha}`))) {
      return failure("event-proven latest freeze lacks its persisted fidelity marker");
    }
    const capturePayload = formatFeatureTaskEntry(entry.feature_id, entry.task_id, hand.freezeCommitSha);
    if (!Array.isArray(state.hand_finished) || !state.hand_finished.includes(bare) || !Array.isArray(state.capture_verified) || !state.capture_verified.includes(capturePayload)) return failure("current child capture markers are incomplete", blockedDiagnostics());
    const regatePending = (Array.isArray(state.regate_pending) ? state.regate_pending : []).filter((pending) =>
      typeof pending === "string" && (pending === bare || pending.startsWith(`${bare}@`)));
    const reviews = validateCurrentReviews({ state, events: native.events, plan: binding.plan, task: binding.task, projectRoot: worktree, sessionId: claim.session_id, featureId: entry.feature_id, taskId: entry.task_id, head, captureReviewInputFn: dependencies.captureReviewInputFn ?? capturePiReviewInput });
    const diagnostics = { ...blockedDiagnostics(reviews), review_findings: reviews.details?.review_findings ?? [] };
    // Older LIGHT runtimes armed this marker after every executor although they have
    // no implementation-review obligation. Keep the historical marker untouched;
    // actual required/dispatched receipts (including negatives) still govern above.
    const hasReviewObligation = !reviews.ok || Object.keys(reviews.receipts).length > 0;
    if (hasReviewObligation && regatePending.some((pending) => !matchesAbsolution(pending, state.regate_passed, (sha) => ancestor(worktree, sha, head)))) {
      const next = reviews.ok
        ? "reviews are accepted; in the task session consult harness_reviews and mark regate-passed if still satisfied. Do not repeat writers or accepted reviews just to close this marker"
        : "in the task session consult harness_reviews, resolve only missing or negative reviews and their applicable findings, then mark regate-passed";
      return failure(`task re-gate is still pending: ${next}`, diagnostics);
    }
    const regatePassed = (Array.isArray(state.regate_passed) ? state.regate_passed : []).filter((passed) =>
      typeof passed === "string" && passed.startsWith(`${bare}@`) && ancestor(worktree, passed.slice(`${bare}@`.length), head));
    if (!reviews.ok) return failure(reviews.reason, diagnostics);
    return {
      ok: true,
      result: {
        version: 1,
        written_by: "host-task-inspection",
        parent_session_id: entry.parent_session_id,
        feature_id: entry.feature_id,
        task_id: entry.task_id,
        attempt_id: entry.attempt_id,
        parent_root: parentRoot,
        worktree,
        session_id: claim.session_id,
        plan_sha256: entry.plan_sha256,
        ...(binding.recovered_task_contract_sha256 ? { recovered_task_contract_sha256: binding.recovered_task_contract_sha256 } : {}),
        spec_sha256: entry.spec_sha256,
        base_sha: entry.base_sha,
        scope_base_sha: scopeBase,
        reconciliation_sha256: taskReconciliationDigest(entry),
        child_head: head,
        changed_paths: changed,
        freeze_sha: fidelity.freezeSha,
        frozen_blobs: fidelity.frozenBlobs,
        hand_capture: {
          agent: hand.agent,
          producer_call_id: hand.producerCallId,
          producer_launch_index: native.events[producerIndex].launchIndex,
          freeze_sha: hand.freezeCommitSha,
          captured_verified_at: hand.capturedVerifiedAt,
          capture_marker: capturePayload,
          ...(recoveryOrigin ? { recovery_origin: recoveryOrigin } : {}),
        },
        review_input_digest: reviews.inputDigest,
        review_receipts: reviews.receipts,
        context_return: contextReturn,
        regate: { pending: regatePending, passed: regatePassed },
        latest_run_id: entry.launches.at(-1).run_id,
        ...(entry.runtime !== undefined ? { runtime: entry.runtime } : {}),
        launches: entry.launches.map((launch, index) => ({
          run_id: launch.run_id,
          pid: launch.pid,
          exit_code: launches.lifecycles[index].exitCode,
          signal: launches.lifecycles[index].signal,
          timed_out: launches.lifecycles[index].timedOut,
          ended_at: launches.lifecycles[index].ended_at,
          ...(launch.runtime?.sha256 ? { run_runtime_sha256: launch.runtime.sha256 } : {}),
          ...(launches.lifecycles[index].interrupted ? {
            interrupted: true,
            interruption_reason: launches.lifecycles[index].reason,
          } : {}),
        })),
      },
    };
  } catch (error) {
    return failure(error instanceof Error ? `task inspection failed: ${error.message}` : "task inspection failed");
  }
}

function validateIntegration(entry, integration, { projectRoot, sessionId, featureId, taskId, headSha }) {
  if (entry?.parent_root !== projectRoot) return failure("task registry parent root differs from the integration authority");
  if (!object(entry?.result) || !object(integration)) return failure("integrated task is missing its receipt");
  const result = entry.result;
  const changedPathsValid = Array.isArray(result.changed_paths) && result.changed_paths.every((item) =>
    typeof item === "string" && item.length > 0 && !path.isAbsolute(item) && !item.split(/[\\/]/).includes(".."));
  const frozenBlobsValid = object(result.frozen_blobs) && Object.entries(result.frozen_blobs).every(([file, digest]) =>
    file.length > 0 && !path.isAbsolute(file) && !file.split(/[\\/]/).includes("..") && SHA256.test(digest));
  const frozenReceiptValid = frozenBlobsValid && (result.freeze_sha === null
    ? Object.keys(result.frozen_blobs).length === 0
    : COMMIT_SHA.test(result.freeze_sha ?? "") && Object.keys(result.frozen_blobs).length > 0);
  const recovery = result.hand_capture?.agent === "harness-test-author";
  const recoveryOrigin = result.hand_capture?.recovery_origin;
  const recoveryOriginValid = !recovery || object(recoveryOrigin) && COMMIT_SHA.test(recoveryOrigin.head_sha ?? "") &&
    typeof recoveryOrigin.producer_call_id === "string" && recoveryOrigin.producer_call_id &&
    Number.isInteger(recoveryOrigin.producer_launch_index) && recoveryOrigin.producer_launch_index >= 0 &&
    recoveryOrigin.producer_launch_index < entry.launches.length;
  const handCaptureValid = object(result.hand_capture) && ["harness-executor", "harness-sniper", "harness-test-author"].includes(result.hand_capture.agent) &&
    typeof result.hand_capture.producer_call_id === "string" && result.hand_capture.producer_call_id &&
    COMMIT_SHA.test(result.hand_capture.freeze_sha ?? "") && typeof result.hand_capture.captured_verified_at === "string" &&
    result.hand_capture.captured_verified_at && result.hand_capture.capture_marker === `${featureId}/${taskId}@${result.hand_capture.freeze_sha}`;
  const reviewReceiptKeys = Object.keys(object(result.review_receipts) ?? {});
  const reviewReceiptsValid = object(result.review_receipts) &&
    reviewReceiptKeys.every((key) => TASK_REVIEW_ROLES.some((role) => role === `harness-${key}`)) &&
    reviewReceiptKeys.every((key) => {
    const role = `harness-${key}`;
    const receipt = result.review_receipts[role.replace("harness-", "")];
    return object(receipt) && typeof receipt.agent_id === "string" && receipt.agent_id &&
      typeof receipt.dispatch_call_id === "string" && receipt.dispatch_call_id &&
      typeof receipt.child_session_id === "string" && receipt.child_session_id &&
      SHA256.test(receipt.input_digest ?? "") && SHA256.test(receipt.report_digest ?? "") &&
      (receipt.reviewed_head_sha === undefined ? receipt.input_digest === result.review_input_digest :
        COMMIT_SHA.test(receipt.reviewed_head_sha) && ancestor(projectRoot, receipt.reviewed_head_sha, result.child_head));
  });
  const regateValid = object(result.regate) && Array.isArray(result.regate.pending) && Array.isArray(result.regate.passed);
  const contextReturnValid = result.context_return === null ||
    validateTaskContextReturn(result.context_return, {
      sessionId: result.session_id,
      taskId,
      headSha: result.child_head,
    }).ok;
  const launchesValid = Array.isArray(result.launches) && result.launches.length === entry.launches?.length &&
    result.launches.every((launch, index) => launch?.run_id === entry.launches[index]?.run_id && launch.pid === entry.launches[index]?.pid &&
      (!entry.runtime || validRuntime(entry.launches[index].runtime) && launch.run_runtime_sha256 === entry.launches[index].runtime.sha256) &&
      (Number.isInteger(launch.exit_code) || index < result.launches.length - 1 && launch.exit_code === null) &&
      typeof launch.timed_out === "boolean" && (typeof launch.ended_at === "string" && launch.ended_at ||
        index < result.launches.length - 1 && launch.interrupted === true && launch.ended_at === null) &&
      (launch.signal === null || typeof launch.signal === "string")) &&
    result.launches.at(-1).exit_code === 0 && result.launches.at(-1).timed_out === false && result.launches.at(-1).signal === null;
  const resultValid = result.version === 1 && result.written_by === "host-task-inspection" &&
    result.parent_session_id === sessionId && result.feature_id === featureId && result.task_id === taskId &&
    result.attempt_id === entry.attempt_id && result.parent_root === projectRoot && result.worktree === entry.worktree &&
    isSafeSessionId(result.session_id) && result.plan_sha256 === entry.plan_sha256 && result.spec_sha256 === entry.spec_sha256 &&
    result.base_sha === entry.base_sha && COMMIT_SHA.test(result.child_head ?? "") && typeof result.latest_run_id === "string" &&
    result.latest_run_id.length > 0 && entry.launches?.at?.(-1)?.run_id === result.latest_run_id && changedPathsValid && frozenReceiptValid &&
    handCaptureValid && recoveryOriginValid && SHA256.test(result.review_input_digest ?? "") && reviewReceiptsValid && regateValid && contextReturnValid && launchesValid &&
    (entry.runtime === undefined || validRuntime(result.runtime) && result.runtime.sha256 === entry.launches.at(-1)?.runtime?.sha256 &&
      result.runtime.launcher_path === entry.launches.at(-1)?.runtime?.launcher_path);
  if (!resultValid) return failure("task inspection receipt is incomplete or does not match the registry entry");
  let canonical = readPiReviewPlan({ projectRoot, featureId, expectedSha256: result.plan_sha256 });
  if (!canonical.ok) {
    const recovered = readTaskPlanAuthority({ projectRoot, sessionId, featureId,
      planSha256: entry.plan_sha256, specSha256: entry.spec_sha256, originCallId: entry.grant?.origin?.plan_review_call_id });
    canonical = { ok: true, plan: recovered.plan };
  }
  const canonicalTask = canonical.ok && canonical.plan.tasks.find((item) => item.id === taskId);
  if (!canonicalTask || requiredPiTaskReviewRoles(canonical.plan, canonicalTask).some((role) =>
    !reviewReceiptKeys.includes(role.replace("harness-", "")))) return failure("task receipt lacks a canonical required task review");
  if (recovery) {
    if (JSON.stringify(frozenPaths(canonicalTask).sort()) !== JSON.stringify(Object.keys(result.frozen_blobs).sort()))
      return failure("test-only recovery frozen paths must match the canonical task");
  }
  const exact = integration.version === 1 && integration.written_by === "host-task-integration" &&
    integration.parent_session_id === sessionId && integration.feature_id === featureId && integration.task_id === taskId &&
    integration.attempt_id === entry.attempt_id && integration.parent_root === projectRoot && integration.worktree === entry.worktree &&
    integration.session_id === entry.result.session_id && integration.plan_sha256 === entry.plan_sha256 &&
    integration.spec_sha256 === entry.spec_sha256 && integration.base_sha === entry.base_sha &&
    integration.child_head === entry.result.child_head && COMMIT_SHA.test(integration.integrated_head ?? "") &&
    integration.result_sha256 === hashTaskReceipt(entry.result);
  if (!exact) return failure("task integration receipt does not match the registry entry");
  const scopeBase = taskScopeBase(entry, projectRoot, result.child_head);
  if ((result.scope_base_sha ?? result.base_sha) !== scopeBase ||
      (result.reconciliation_sha256 ?? null) !== taskReconciliationDigest(entry))
    return failure("task integration reconciliation proof differs from its inspection receipt");
  const reconciliation = entry.reconciliations?.at(-1);
  if (reconciliation) {
    const producerIndex = result.hand_capture.producer_launch_index;
    if (!Number.isInteger(producerIndex) || producerIndex < 0 || producerIndex >= entry.launches.length)
      return failure("integrated hand capture producer launch is invalid");
    if (!ancestor(projectRoot, reconciliation.merged_head, result.hand_capture.freeze_sha) || producerIndex < reconciliation.launch_count) {
      // Re-read the original host-owned event stream, including for v3.0.1 receipts.
      // Never rewrite an already hashed inspection/integration to retrofit approval.
      const jobRoot = fs.realpathSync(entry.job_dir);
      const interruptedIndexes = new Set(result.launches.flatMap((launch, index) =>
        launch.interrupted === true && launch.run_id === entry.launches[index]?.run_id ? [index] : []));
      if (jobRoot !== path.resolve(entry.job_dir) || !hasReconciledCapture(entry, readEvents(entry.launches, jobRoot, interruptedIndexes), {
        projectRoot, sessionId: result.session_id, producerCallId: result.hand_capture.producer_call_id, headSha: result.child_head,
      })) return failure("integrated hand capture must follow dependency reconciliation");
    }
  }
  if (!COMMIT_SHA.test(headSha ?? "") || !ancestor(projectRoot, result.base_sha, result.child_head) ||
      !ancestor(projectRoot, result.child_head, integration.integrated_head) || !ancestor(projectRoot, integration.integrated_head, headSha)) {
    return failure("task integration is not ancestral to the requested HEAD");
  }
  if (!ancestor(projectRoot, result.hand_capture.freeze_sha, result.child_head) ||
      (recovery ? !result.freeze_sha || !ancestor(projectRoot, result.hand_capture.freeze_sha, result.freeze_sha) ||
        !ancestor(projectRoot, recoveryOrigin.head_sha, result.hand_capture.freeze_sha) ||
        !onlyRecoveryChanges(entry, projectRoot, recoveryOrigin.head_sha, result.child_head, canonicalTask, canonical.plan) :
        result.freeze_sha !== null && !ancestor(projectRoot, result.freeze_sha, result.hand_capture.freeze_sha))) {
    return failure("task receipt freeze and hand capture are not ancestral to the child HEAD");
  }
  const actualChanged = splitZero(git(projectRoot, ["diff", "--name-only", "-z", result.base_sha, result.child_head]));
  if (JSON.stringify(actualChanged) !== JSON.stringify(result.changed_paths)) return failure("task inspection changed-path receipt no longer matches Git");
  for (const [file, expected] of Object.entries(result.frozen_blobs)) {
    try {
      const bytes = git(projectRoot, ["show", `${headSha}:${file}`], null);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected) return failure(`integrated frozen file changed: ${file}`);
    } catch { return failure(`integrated frozen file is unavailable: ${file}`); }
  }
  return { ok: true };
}

function validateCurrentIntegrationAuthority(entry, registry, { projectRoot, sessionId, featureId }) {
  const captured = capturePlanReviewInput({ projectRoot, sessionId, featureId });
  if (!captured.ok || captured.snapshot.spec_sha256 !== registry.spec_sha256) {
    return failure("integrated task plan/spec hashes do not match the current canonical artifacts");
  }
  let recovered;
  if (captured.snapshot.plan_sha256 !== registry.plan_sha256) {
    try {
      recovered = readTaskPlanAuthority({ projectRoot, sessionId, featureId, planSha256: registry.plan_sha256,
        specSha256: registry.spec_sha256, originCallId: entry.grant?.origin?.plan_review_call_id });
    } catch (error) { return failure(`integrated task plan/spec hashes do not match the current canonical artifacts: ${error.message}`); }
    if (recoveredTaskContractHash(recovered, entry.task_id) !== (entry.result?.recovered_task_contract_sha256 ?? null))
      return failure("task requires correction and revalidation against its reviewed scope; resume the same task");
  }
  const approvedSpec = readPiSpecApproval({ projectRoot, sessionId, featureId });
  if (!approvedSpec.ok || approvedSpec.sha256 !== registry.spec_sha256) {
    return failure("integrated task spec is not the current approved canonical spec");
  }
  const grant = object(entry.grant);
  const origin = object(grant?.origin);
  const approval = object(recovered ? registry.plan_snapshot.approval : approvedSpec.state?.plan_review_evidence);
  if (!grant || grant.version !== 1 || grant.kind !== "task-run" ||
      grant.parent_session_id !== sessionId || grant.feature_id !== featureId || grant.task_id !== entry.task_id ||
      grant.plan_sha256 !== registry.plan_sha256 || grant.spec_sha256 !== registry.spec_sha256 ||
      origin?.kind !== "parent-approved-plan" || typeof origin.plan_review_call_id !== "string" || !origin.plan_review_call_id ||
      !approval || approval.written_by !== "host-subagent-completion" || approval.parent_session_id !== sessionId ||
      approval.feature_id !== featureId || approval.role !== "harness-plan-reviewer" || approval.status !== "completed" ||
      approval.verdict !== "APPROVE" || approval.dispatch_call_id !== origin.plan_review_call_id ||
      typeof approval.child_session_id !== "string" || !approval.child_session_id ||
      typeof approval.agent_id !== "string" || !approval.agent_id ||
      approval.plan_sha256 !== registry.plan_sha256 || approval.spec_sha256 !== registry.spec_sha256) {
    return failure("integrated task is not bound to the current host-owned plan approval");
  }
  return { ok: true };
}

// Internal reconciliation may read an already integrated upstream while the
// dependent itself owns the barrier. Ordinary admission/final reads stay closed.
function isReconciliationDependencyRead(registry, upstream, reconciliationFor) {
  if (!object(reconciliationFor)) return false;
  const barrier = registry.correction_barrier;
  const dependent = registry.tasks[reconciliationFor.task_id];
  const prior = dependent?.reconciliation_required?.upstreams?.[upstream.task_id];
  return barrier.task_id !== upstream.task_id && barrier.task_id === reconciliationFor.task_id &&
    barrier.attempt_id === reconciliationFor.attempt_id &&
    dependent?.task_id === barrier.task_id && dependent.attempt_id === barrier.attempt_id && dependent.status === "blocked" &&
    dependent.parent_session_id === registry.parent_session_id && dependent.feature_id === registry.feature_id &&
    dependent.plan_sha256 === registry.plan_sha256 && dependent.spec_sha256 === registry.spec_sha256 &&
    prior?.task_id === upstream.task_id && prior.attempt_id === upstream.attempt_id;
}

/** Read one integration receipt without rewriting child identity or clearing a correction barrier. */
export function readIntegratedTaskEvidence({ projectRoot, sessionId, featureId, taskId, headSha, reconciliationFor } = {}, dependencies = {}) {
  try {
    if (typeof projectRoot !== "string" || !projectRoot || !isSafeSessionId(sessionId) || !isSafeFeatureId(featureId) || !isSafeTaskId(taskId)) return failure("safe integrated task identity required");
    const root = fs.realpathSync(projectRoot);
    if (root !== path.resolve(projectRoot)) return failure("integrated task project root must be canonical");
    const registryPath = path.join(root, ".pi", "harness", "state", sessionId, "task-runs", "index.json");
    const registry = readJson(registryPath, root);
    const entry = registry?.tasks?.[taskId];
    if (registry?.version !== 1 || registry.parent_session_id !== sessionId || registry.feature_id !== featureId || !object(entry) ||
        entry.parent_session_id !== sessionId || entry.feature_id !== featureId || entry.task_id !== taskId ||
        entry.plan_sha256 !== registry.plan_sha256 || entry.spec_sha256 !== registry.spec_sha256) return failure("current integrated task registry entry required");
    if (registry.correction_barrier != null && !isReconciliationDependencyRead(registry, entry, reconciliationFor)) {
      const owner = registry.correction_barrier.task_id;
      return failure(isSafeTaskId(owner) && owner.length <= 128
        ? `correction barrier active for task ${owner}; resolve its exact attempt through host-validated recovery before aggregate review`
        : "correction barrier active; inspect the task registry before aggregate review");
    }
    if (entry.status !== "integrated") return failure("current integrated task registry entry required");
    const authority = validateCurrentIntegrationAuthority(entry, registry, { projectRoot: root, sessionId, featureId });
    if (!authority.ok) return authority;
    let inspectionEntry = entry;
    if (entry.result?.launches?.length !== entry.launches?.length) {
      const abandoned = entry.abandoned_resumes?.at(-1);
      if (abandoned?.written_by !== "host-task-resume-abandonment" || abandoned.no_product_obligation !== true ||
          typeof abandoned.reason !== "string" || !abandoned.reason.trim()) return failure("explicit host resume abandonment required");
      const sealedHead = abandoned.proof?.parent_head;
      if (!COMMIT_SHA.test(sealedHead ?? "") || !COMMIT_SHA.test(headSha ?? "") ||
          !ancestor(root, sealedHead, headSha)) return failure("resume abandonment parent HEAD is not ancestral to the requested HEAD");
      // The unchanged-path obligation belongs to the abandonment instant, not
      // every future owner of those production paths. Current frozen blobs and
      // integration ancestry are still checked below against the requested HEAD.
      const checked = inspectTaskResumeAbandonment(entry, { headSha: sealedHead }, dependencies);
      if (!checked.ok) return checked;
      if (hashTaskReceipt(checked.proof) !== hashTaskReceipt(abandoned.proof) ||
          hashTaskReceipt(entry.integration) !== hashTaskReceipt(checked.integration) ||
          hashTaskReceipt(entry.result) !== hashTaskReceipt(checked.result)) return failure("resume abandonment evidence changed");
      inspectionEntry = checked.inspectionEntry;
    }
    const validated = validateIntegration(inspectionEntry, entry.integration, { projectRoot: root, sessionId, featureId, taskId, headSha });
    if (!validated.ok) return validated;
    return { ok: true, result: entry.integration, entry };
  } catch (error) {
    return failure(error instanceof Error ? `integrated task evidence unavailable: ${error.message}` : "integrated task evidence unavailable");
  }
}

/** Require every canonical plan task to have a current integration receipt. */
export function readAllIntegratedTaskEvidence({ projectRoot, sessionId, featureId, headSha, tasks } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return failure("canonical task list required");
  const results = [];
  for (const task of tasks) {
    const taskId = typeof task === "string" ? task : task?.id;
    if (!isSafeTaskId(taskId)) return failure("canonical task list contains an invalid task id");
    const evidence = readIntegratedTaskEvidence({ projectRoot, sessionId, featureId, taskId, headSha });
    if (!evidence.ok) return failure(`integrated evidence missing for ${featureId}/${taskId}: ${evidence.reason}`);
    results.push(evidence.result);
  }
  return { ok: true, results };
}

/** Revalidate a prior integration after an explicitly abandoned, unchanged resume.
 * The current hand is evidence of the abandoned work, never a replacement approval.
 * Keep every launch on the registry; only validate the original receipt against its
 * original launch prefix, with a separate proof binding the entire retained history.
 */
export function inspectTaskResumeAbandonment(entry, { headSha } = {}, dependencies = {}) {
  try {
    const integration = Array.isArray(entry?.integration_history) && entry.integration_history.at(-1);
    const result = object(entry?.result_history)?.[integration?.result_sha256];
    if (!object(result) || hashTaskReceipt(result) !== integration.result_sha256 ||
        !Array.isArray(result.launches) || !result.launches.length ||
        !Array.isArray(entry.launches) || result.launches.length >= entry.launches.length)
      return failure("resume abandonment requires the immediately previous integration and exact inspection");
    if (entry.reconciliation_required || entry.reconciliation_intent)
      return failure("dependency reconciliation cannot be abandoned as an unchanged resume");
    if (entry.reconciliations?.some((proof) => proof.launch_count >= result.launches.length))
      return failure("resume abandonment cannot discard a host reconciliation; integrate the current ready receipt instead");
    const inspectionEntry = { ...entry, result, launches: entry.launches.slice(0, result.launches.length) };
    const historical = validateIntegration(inspectionEntry, integration, {
      projectRoot: entry.parent_root, sessionId: entry.parent_session_id,
      featureId: entry.feature_id, taskId: entry.task_id, headSha,
    });
    if (!historical.ok) return historical;
    const worktree = fs.realpathSync(entry.worktree);
    const jobRoot = fs.realpathSync(entry.job_dir);
    if (worktree !== entry.worktree || jobRoot !== entry.job_dir)
      return failure("resume abandonment requires canonical task roots");
    const launches = validateLaunches(entry, jobRoot, dependencies.readTaskProcessFn ?? readTaskProcess, true);
    if (!launches.ok) return launches;
    if (launches.interruptedIndexes.size) return failure("resume abandonment requires known terminal process evidence for every launch");
    if (String(git(worktree, ["rev-parse", "HEAD"])).trim() !== result.child_head ||
        String(git(worktree, ["status", "--porcelain", "--untracked-files=all", "--", ".",
          ":(exclude).pi/harness/", ":(exclude)node_modules/"])).trim())
      return failure("resume abandonment requires the original clean child HEAD");
    if (result.changed_paths.length && String(git(entry.parent_root,
      ["diff", "--name-only", result.child_head, headSha, "--", ...result.changed_paths])).trim())
      return failure("original integrated task paths changed on the parent");
    const binding = (dependencies.readTaskRunBindingFn ?? readTaskRunBinding)(worktree, result.session_id);
    if (!binding?.ok || binding.grant.task_id !== entry.task_id || binding.grant.attempt_id !== entry.attempt_id ||
        binding.grant.parent_session_id !== entry.parent_session_id || binding.grant.parent_root !== entry.parent_root ||
        binding.grant.feature_id !== entry.feature_id || binding.grant.plan_sha256 !== entry.plan_sha256 ||
        binding.grant.spec_sha256 !== entry.spec_sha256 || binding.grant.base_sha !== entry.base_sha)
      return failure("resume abandonment task binding changed");
    const claim = readJson(`${entry.grant_path}.claim`, worktree);
    if (claim.session_id !== result.session_id) return failure("resume abandonment child session changed");
    const events = readEvents(entry.launches, jobRoot);
    if (events.sessionIds.size !== 1 || !events.sessionIds.has(result.session_id))
      return failure("resume abandonment native session changed");
    const hand = readJson(piHandRecordPath({ projectRoot: worktree, sessionId: result.session_id,
      featureId: entry.feature_id }, entry.task_id).path, worktree);
    const violations = recordViolations(hand);
    if (hand.featureId !== entry.feature_id || hand.taskId !== entry.task_id || hand.sessionId !== result.session_id ||
        hand.writtenBy !== "host-hand-finished" || violations.scope.length || violations.frozen.length)
      return failure("resume abandonment hand identity or violations require ordinary recovery");
    const originalHand = hand.producerCallId === result.hand_capture.producer_call_id;
    if (originalHand ? (!isCaptureEligibleHandRecord(hand) || hand.agent !== result.hand_capture.agent ||
        hand.freezeCommitSha !== result.hand_capture.freeze_sha || hand.capturedVerifiedAt !== result.hand_capture.captured_verified_at)
      : (hand.outcome !== "BLOCKED" || hand.freezeCommitSha !== result.child_head ||
        !Array.isArray(hand.touchedPaths) || hand.touchedPaths.length || !events.events.some((event) =>
          event.launchIndex >= result.launches.length && event.callId === hand.producerCallId && event.tool === "subagent" &&
          event.args.subagent_type === hand.agent && ["harness-executor", "harness-sniper"].includes(hand.agent) &&
          taskFromPrompt(event.args.prompt) === entry.task_id && eventSucceeded(event))))
      return failure("resume abandonment requires the original capture or a native blocked hand without changes");
    // Fidelity changes need their ordinary recovery path. Task eyes below include
    // every later dispatch, so an optional, negative or incomplete eye cannot hide.
    if (events.events.some((event) => event.launchIndex >= result.launches.length &&
        event.tool === "subagent" && ["harness-test-author", "harness-test-reviewer"].includes(event.args.subagent_type)))
      return failure("new fidelity work requires ordinary task recovery");
    const state = readJson(piGateStatePath({ projectRoot: worktree, sessionId: result.session_id }).path, worktree);
    const reviews = validateCurrentReviews({ state, events: events.events, plan: binding.plan, task: binding.task,
      projectRoot: worktree, sessionId: result.session_id, featureId: entry.feature_id, taskId: entry.task_id,
      head: result.child_head, captureReviewInputFn: dependencies.captureReviewInputFn ?? capturePiReviewInput });
    if (!reviews.ok) return reviews;
    if (reviews.inputDigest !== result.review_input_digest || hashTaskReceipt(reviews.receipts) !== hashTaskReceipt(result.review_receipts))
      return failure("resume abandonment requires unchanged review input and original accepted eyes");
    const eventDigests = entry.launches.map((launch) => {
      const bytes = fs.readFileSync(regularFile(launch.events_path, jobRoot, MAX_EVENTS_BYTES));
      for (const line of bytes.toString("utf8").split("\n")) if (line.trim()) JSON.parse(line);
      return crypto.createHash("sha256").update(bytes).digest("hex");
    });
    return { ok: true, result, integration, inspectionEntry, proof: {
      integration_sha256: hashTaskReceipt(integration), result_sha256: integration.result_sha256,
      parent_head: headSha, child_head: result.child_head, review_input_digest: reviews.inputDigest,
      inspected_launch_count: result.launches.length, launch_count: entry.launches.length,
      launches_sha256: hashTaskReceipt(entry.launches), events_sha256: eventDigests,
      hand_sha256: hashTaskReceipt(hand), hand_record: hand,
    } };
  } catch (error) {
    return failure(`resume abandonment evidence unavailable: ${error.message}`);
  }
}

export default { inspectTaskRun, readIntegratedTaskEvidence, readAllIntegratedTaskEvidence };
