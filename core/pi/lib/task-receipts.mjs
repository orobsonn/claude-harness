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
import { validateOcCaptureEligibleHandRecord } from "../../opencode/lib/hand-records.mjs";
import { hashTaskReceipt, unsupportedTaskScopePattern } from "./task-contract.mjs";
import { readTaskContextReturn, validateTaskContextReturn } from "./task-context.mjs";
import { capturePiReviewInput, currentPiReviewIssues, findPiReviewReceipt, hasAcceptedPiReviewEvidence, readPiReviewPlan } from "./pi-review-evidence.mjs";
import { piGateStatePath, piHandRecordPath } from "./pi-paths.mjs";
import { readTaskProcess } from "./task-process.mjs";
import { capturePlanReviewInput, readTaskRunBinding } from "./task-run.mjs";
import { readPiSpecApproval } from "./spec-approval.mjs";
import { taskScopeBase, taskReconciliationDigest } from "./task-reconciliation.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_TASK_REVIEW_ROLES = Object.freeze(["harness-adversary"]);
const OPTIONAL_TASK_REVIEW_ROLES = Object.freeze(["harness-compliance", "harness-security"]);
const TASK_REVIEW_ROLES = Object.freeze([...REQUIRED_TASK_REVIEW_ROLES, ...OPTIONAL_TASK_REVIEW_ROLES]);
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
  launches.forEach((launch, launchIndex) => {
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
      if (native?.type === "tool_execution_start" && typeof native.toolCallId === "string") {
        const event = { launchIndex, line, callId: native.toolCallId, tool: native.toolName, args: object(native.args) ?? {}, end: null };
        calls.set(`${launchIndex}:${native.toolCallId}`, event);
        events.push(event);
      } else if (native?.type === "tool_execution_end" && typeof native.toolCallId === "string") {
        const start = calls.get(`${launchIndex}:${native.toolCallId}`);
        if (start) { start.end = native; start.endLine = line; }
      }
    }
  });
  return { events, sessionIds };
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

function observedImplementationReviewRoles(events, taskId) {
  return new Set(events.filter((event) => event.tool === "subagent" &&
    OPTIONAL_TASK_REVIEW_ROLES.includes(event.args?.subagent_type) &&
    typeof event.args?.prompt === "string" && event.args.prompt.startsWith("[HARNESS_TASK_REVIEW]") &&
    taskFromPrompt(event.args.prompt) === taskId).map((event) => event.args.subagent_type));
}

function validateCurrentReviews({ state, events, projectRoot, sessionId, featureId, taskId, head, captureReviewInputFn }) {
  const captured = captureReviewInputFn({ projectRoot, sessionId, featureId, phase: "task", taskId });
  if (!captured?.ok || captured.snapshot?.head_sha !== head) return failure("current canonical task review snapshot required");
  const receipts = {};
  const observed = observedImplementationReviewRoles(events, taskId);
  const roles = TASK_REVIEW_ROLES.filter((role) => REQUIRED_TASK_REVIEW_ROLES.includes(role) || observed.has(role) ||
    findPiReviewReceipt(state, { featureId, taskId, role, phase: "task" }) !== null);
  const findings = roles.flatMap((role) => {
    const receipt = findPiReviewReceipt(state, { featureId, taskId, role, phase: "task" });
    const issues = currentPiReviewIssues(receipt, { sessionId, featureId, taskId, role, phase: "task", snapshot: captured.snapshot });
    return issues.length ? [{ role, issues }] : [];
  });
  for (const role of roles) {
    const receipt = findPiReviewReceipt(state, { featureId, taskId, role, phase: "task" });
    if (!hasAcceptedPiReviewEvidence(receipt, captured.snapshot) || receipt.written_by !== "host-subagent-completion" ||
        receipt.parent_session_id !== sessionId || receipt.feature_id !== featureId || receipt.task_id !== taskId ||
        receipt.role !== role || receipt.status !== "completed" || receipt.reviewed_head_sha !== head ||
        typeof receipt.dispatch_call_id !== "string" || !receipt.dispatch_call_id ||
        typeof receipt.child_session_id !== "string" || !receipt.child_session_id ||
        typeof receipt.agent_id !== "string" || !receipt.agent_id) {
      return failure("current accepted " + role.replace("harness-", "") + " task review required", { review_findings: findings });
    }
    receipts[role.replace("harness-", "")] = {
      agent_id: receipt.agent_id,
      dispatch_call_id: receipt.dispatch_call_id,
      child_session_id: receipt.child_session_id,
      input_digest: receipt.input_digest,
      report_digest: receipt.report_digest,
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

function validateLaunches(entry, jobRoot, readTaskProcessFn = readTaskProcess) {
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
      if (!validRuntime(entry.runtime) || !validRuntime(launch.runtime) || launch.runtime.sha256 !== entry.runtime.sha256 ||
          launch.runtime.launcher_path !== entry.runtime.launcher_path) return failure(`launch ${index} runtime identity is invalid`);
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
  if (last.exitCode !== 0 || last.timedOut || last.signal !== null) return failure("latest task launch did not exit successfully");
  return { ok: true, lifecycles, interruptedIndexes };
}

function validateFidelity({ events, task, taskId, worktree, head, reviewRole }) {
  const paths = frozenPaths(task);
  if (paths.length === 0) return { ok: true, freezeSha: null, frozenBlobs: {}, markerIndex: -1 };
  const fidelityMarkers = events.filter((event) => event.tool === "mark" && event.args?.action === "fidelity" && event.args?.task_id === taskId && markerSucceeded(event));
  const marker = fidelityMarkers.at(-1);
  if (!marker) return failure("latest successful native fidelity marker required");
  const markerIndex = events.indexOf(marker);
  if (events.some((event, index) => index > markerIndex && event.tool === "subagent" && event.args?.subagent_type === "harness-test-author" && eventSucceeded(event))) {
    return failure("latest test-author work has no subsequent fidelity marker");
  }
  const before = events.filter((event) => event.launchIndex < marker.launchIndex || event.launchIndex === marker.launchIndex && event.line < marker.line);
  const commitEvent = before.findLast((event) => commitFromEvent(event, worktree));
  const commitSha = commitFromEvent(commitEvent, worktree);
  if (!commitSha || !ancestor(worktree, commitSha, head)) return failure("fidelity freeze commit is missing or not ancestral to task HEAD");
  const commitIndex = events.indexOf(commitEvent);
  const authorIndex = events.findLastIndex((event, index) => index < commitIndex && event.tool === "subagent" && event.args?.subagent_type === "harness-test-author" && eventSucceeded(event));
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
    const tracked = String(git(worktree, ["status", "--porcelain", "--untracked-files=no"])).trim();
    const untracked = tracked ? "" : String(git(worktree, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).pi/harness/runtime/", ":(exclude).pi/harness/state/", ":(exclude).pi/harness/sessions/", ":(exclude)node_modules/"])).trim();
    if (tracked || untracked) return failure("task worktree must be clean before inspection");
    const changed = splitZero(git(worktree, ["diff", "--name-only", "-z", entry.base_sha, head]));
    const scopes = [
      ...(Array.isArray(binding.task?.scope_paths) ? binding.task.scope_paths : []),
      ...frozenPaths(binding.task),
    ];
    const unsupportedScope = scopes.find(unsupportedTaskScopePattern);
    if (unsupportedScope !== undefined) {
      return failure(`task scope ${JSON.stringify(unsupportedScope)} uses unsupported glob syntax`);
    }
    const scopeBase = taskScopeBase(entry, worktree, head, scopes);
    const scopedChanges = splitZero(git(worktree, ["diff", "--name-only", "-z", scopeBase, head]));
    if (scopedChanges.some((item) => !covered(item, scopes))) return failure("task changed paths outside canonical scope", { changed: scopedChanges });
    const native = readEvents(entry.launches, jobRoot, launches.interruptedIndexes);
    if (native.sessionIds.size !== 1 || !native.sessionIds.has(claim.session_id)) return failure("native event session does not match the claimed child session");
    const implementationObserved = native.events.some((event) => event.tool === "subagent" && ["harness-executor", "harness-sniper"].includes(event.args?.subagent_type) && eventSucceeded(event));
    if (!implementationObserved) return failure("successful native implementation call was not observed");
    const statePath = piGateStatePath({ projectRoot: worktree, sessionId: claim.session_id });
    const handPath = piHandRecordPath({ projectRoot: worktree, sessionId: claim.session_id, featureId: entry.feature_id }, entry.task_id);
    const state = readJson(statePath.path, worktree);
    const hand = readJson(handPath.path, worktree);
    if (!isCaptureEligibleHandRecord(hand)) return failure("current child hand record is not capture-eligible");
    const identity = validateOcCaptureEligibleHandRecord(hand, { featureId: entry.feature_id, taskId: entry.task_id, sessionId: claim.session_id });
    const violations = recordViolations(hand);
    if (!identity.ok || violations.scope.length || violations.frozen.length || typeof hand.capturedVerifiedAt !== "string" || !hand.capturedVerifiedAt ||
        !COMMIT_SHA.test(hand.freezeCommitSha ?? "") || !ancestor(worktree, hand.freezeCommitSha, head)) return failure("current child hand capture is invalid");
    const reconciliation = entry.reconciliations?.at(-1);
    if (reconciliation && !ancestor(worktree, reconciliation.merged_head, hand.freezeCommitSha))
      return failure("current hand requires a new capture after dependency reconciliation");
    const isImplementationForTask = (event) => event.tool === "subagent" &&
      ["harness-executor", "harness-sniper"].includes(event.args?.subagent_type) &&
      taskFromPrompt(event.args?.prompt) === entry.task_id && eventSucceeded(event);
    const recovery = hand.agent === "harness-test-author";
    const producerIndex = native.events.findIndex((event) => event.callId === hand.producerCallId &&
      event.args?.subagent_type === hand.agent && taskFromPrompt(event.args?.prompt) === entry.task_id &&
      eventSucceeded(event) && (recovery || isImplementationForTask(event)));
    if (producerIndex < 0) return failure("current hand producer is not bound to a successful native call by an implementation agent");
    if (reconciliation && native.events[producerIndex].launchIndex < reconciliation.launch_count)
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
      const isWriter = (event) => event.tool === "subagent" &&
        ["harness-executor", "harness-sniper", "harness-test-author"].includes(event.args?.subagent_type);
      const implementationIndex = native.events.findLastIndex((event, index) => index < producerIndex && isImplementationForTask(event));
      const firstAuthorIndex = native.events.findIndex((event, index) => index > implementationIndex && isWriter(event) &&
        event.args.subagent_type === "harness-test-author");
      if (implementationIndex < 0 || reconciliation && native.events[implementationIndex].launchIndex < reconciliation.launch_count ||
          native.events.some((event, index) => index > implementationIndex && index < producerIndex &&
            isWriter(event) && event.args.subagent_type !== "harness-test-author"))
        return failure("test-only recovery requires a prior captured implementation after dependency reconciliation");
      for (const event of native.events.slice(implementationIndex + 1, firstAuthorIndex)) {
        if (event.tool !== "mark" || event.args?.action !== "capture-verified" || event.args?.task_id !== entry.task_id || !markerSucceeded(event)) continue;
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
      if (!recoveryOrigin) return failure("test-only recovery requires a clean captured implementation before the first test-author; commit then capture before correcting tests");
      if (producerIndex !== fidelity.authorIndex || native.events.some((event, index) => index > producerIndex && isWriter(event)))
        return failure("test-only recovery requires the latest fidelity author without a later writing hand");
      if (!fidelity.freezeSha || !ancestor(worktree, hand.freezeCommitSha, fidelity.freezeSha) ||
          !ancestor(worktree, recoveryOrigin.head_sha, hand.freezeCommitSha) ||
          !onlyFrozenChanges(worktree, recoveryOrigin.head_sha, head, frozenPaths(binding.task)))
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
    if (!Array.isArray(state.hand_finished) || !state.hand_finished.includes(bare) || !Array.isArray(state.capture_verified) || !state.capture_verified.includes(capturePayload)) return failure("current child capture markers are incomplete");
    const regatePending = (Array.isArray(state.regate_pending) ? state.regate_pending : []).filter((pending) =>
      typeof pending === "string" && (pending === bare || pending.startsWith(`${bare}@`)));
    const contextReturnFn = dependencies.readTaskContextReturnFn ?? readTaskContextReturn;
    const contextReturn = contextReturnFn({ projectRoot: worktree, sessionId: claim.session_id, taskId: entry.task_id, headSha: head });
    if (contextReturn !== null) {
      const checkedContext = validateTaskContextReturn(contextReturn, { sessionId: claim.session_id, taskId: entry.task_id, headSha: head });
      if (!checkedContext.ok) return failure("task context return is invalid: " + checkedContext.reason);
    }
    const reviews = validateCurrentReviews({ state, events: native.events, projectRoot: worktree, sessionId: claim.session_id, featureId: entry.feature_id, taskId: entry.task_id, head, captureReviewInputFn: dependencies.captureReviewInputFn ?? capturePiReviewInput });
    const diagnostics = { ...(contextReturn === null ? {} : { context_return: contextReturn }), review_findings: reviews.details?.review_findings ?? [] };
    if (regatePending.some((pending) => !matchesAbsolution(pending, state.regate_passed, (sha) => ancestor(worktree, sha, head)))) return failure("task re-gate is still pending", diagnostics);
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
  const reviewReceiptsValid = object(result.review_receipts) && reviewReceiptKeys.includes("adversary") &&
    reviewReceiptKeys.every((key) => TASK_REVIEW_ROLES.some((role) => role === `harness-${key}`)) &&
    reviewReceiptKeys.every((key) => {
    const role = `harness-${key}`;
    const receipt = result.review_receipts[role.replace("harness-", "")];
    return object(receipt) && typeof receipt.agent_id === "string" && receipt.agent_id &&
      typeof receipt.dispatch_call_id === "string" && receipt.dispatch_call_id &&
      typeof receipt.child_session_id === "string" && receipt.child_session_id &&
      receipt.input_digest === result.review_input_digest && SHA256.test(receipt.report_digest ?? "");
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
      (!entry.runtime || launch.run_runtime_sha256 === entry.runtime.sha256) &&
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
    (entry.runtime === undefined || validRuntime(entry.runtime) && validRuntime(result.runtime) && result.runtime.sha256 === entry.runtime.sha256 &&
      result.runtime.launcher_path === entry.runtime.launcher_path);
  if (!resultValid) return failure("task inspection receipt is incomplete or does not match the registry entry");
  if (recovery) {
    const canonical = readPiReviewPlan({ projectRoot, featureId, expectedSha256: result.plan_sha256 });
    const task = canonical.ok && canonical.plan.tasks.find((item) => item.id === taskId);
    if (!task || JSON.stringify(frozenPaths(task).sort()) !== JSON.stringify(Object.keys(result.frozen_blobs).sort()))
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
  if (reconciliation && (!ancestor(projectRoot, reconciliation.merged_head, result.hand_capture.freeze_sha) ||
      !Number.isInteger(result.hand_capture.producer_launch_index) ||
      result.hand_capture.producer_launch_index < reconciliation.launch_count ||
      result.hand_capture.producer_launch_index >= entry.launches.length ||
      recovery && recoveryOrigin.producer_launch_index < reconciliation.launch_count))
    return failure("integrated hand capture must follow dependency reconciliation");
  if (!COMMIT_SHA.test(headSha ?? "") || !ancestor(projectRoot, result.base_sha, result.child_head) ||
      !ancestor(projectRoot, result.child_head, integration.integrated_head) || !ancestor(projectRoot, integration.integrated_head, headSha)) {
    return failure("task integration is not ancestral to the requested HEAD");
  }
  if (!ancestor(projectRoot, result.hand_capture.freeze_sha, result.child_head) ||
      (recovery ? !result.freeze_sha || !ancestor(projectRoot, result.hand_capture.freeze_sha, result.freeze_sha) ||
        !ancestor(projectRoot, recoveryOrigin.head_sha, result.hand_capture.freeze_sha) ||
        !onlyFrozenChanges(projectRoot, recoveryOrigin.head_sha, result.child_head, Object.keys(result.frozen_blobs)) :
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
  if (!captured.ok || captured.snapshot.plan_sha256 !== registry.plan_sha256 ||
      captured.snapshot.spec_sha256 !== registry.spec_sha256) {
    return failure("integrated task plan/spec hashes do not match the current canonical artifacts");
  }
  const approvedSpec = readPiSpecApproval({ projectRoot, sessionId, featureId });
  if (!approvedSpec.ok || approvedSpec.sha256 !== registry.spec_sha256) {
    return failure("integrated task spec is not the current approved canonical spec");
  }
  const grant = object(entry.grant);
  const origin = object(grant?.origin);
  const approval = object(approvedSpec.state?.plan_review_evidence);
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

/** Read one integration receipt from the global parent registry without rewriting child identity. */
export function readIntegratedTaskEvidence({ projectRoot, sessionId, featureId, taskId, headSha } = {}) {
  try {
    if (typeof projectRoot !== "string" || !projectRoot || !isSafeSessionId(sessionId) || !isSafeFeatureId(featureId) || !isSafeTaskId(taskId)) return failure("safe integrated task identity required");
    const root = fs.realpathSync(projectRoot);
    if (root !== path.resolve(projectRoot)) return failure("integrated task project root must be canonical");
    const registryPath = path.join(root, ".pi", "harness", "state", sessionId, "task-runs", "index.json");
    const registry = readJson(registryPath, root);
    const entry = registry?.tasks?.[taskId];
    if (registry?.version !== 1 || registry.parent_session_id !== sessionId || registry.feature_id !== featureId || !object(entry) ||
        registry.correction_barrier != null ||
        entry.status !== "integrated" || entry.parent_session_id !== sessionId || entry.feature_id !== featureId || entry.task_id !== taskId ||
        entry.plan_sha256 !== registry.plan_sha256 || entry.spec_sha256 !== registry.spec_sha256) return failure("current integrated task registry entry required");
    const authority = validateCurrentIntegrationAuthority(entry, registry, { projectRoot: root, sessionId, featureId });
    if (!authority.ok) return authority;
    const validated = validateIntegration(entry, entry.integration, { projectRoot: root, sessionId, featureId, taskId, headSha });
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

export default { inspectTaskRun, readIntegratedTaskEvidence, readAllIntegratedTaskEvidence };
