/**
 * @description Host inspection of a Claude Code task lane and its receipts (port of Pi's
 * task-receipts.mjs). The lane never reports itself ready: `inspectTaskRun` DERIVES the result from
 * the native stream-json of every launch, the hook ledger, the lane gate-state and Git, and emits a
 * `host-task-inspection` receipt only when the whole pipeline is proven:
 *
 *   launches terminal, the last one exit 0 · claim + live binding · one session, cwd = worktree ·
 *   clean worktree · diff inside the task scope · (with locked tests) test-author → compliance
 *   fidelity pass → test-only freeze commit (HEAD moved in the ledger) → fidelity_pass@freeze →
 *   a successful executor/sniper after the freeze · a capture-verified at the final HEAD with a
 *   clean tree after the last writer · FULL: current positive reviews (compliance, adversary when
 *   enabled, security when sensitive) dispatched after the last writer at the final HEAD, and every
 *   dispatched eye positive at that HEAD · every regate_pending absolved at HEAD.
 *
 * `readIntegratedTaskEvidence` re-validates an integration receipt against Git and the registry on
 * every read; hashes alone never prove ancestry.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { isSafeFeatureId, isSafeSessionId, isSafeTaskId } from "../../../shared/lib/feature-id.mjs";
import { matchesAbsolution } from "../../../shared/lib/absolution.mjs";
import { hashTaskReceipt } from "../../../shared/lib/task-contract.mjs";
import { buildTaskContextReturn, validateTaskContextReturn } from "../../../shared/lib/task-context.mjs";
import { readTaskProcess } from "../../../shared/lib/task-process.mjs";
import { readArtifact, readParentAuthority, readTaskRunBinding } from "./task-admission.mjs";
import { attachLedger, readLaneEvents, readLaneLedger } from "./task-events.mjs";
import {
  EYE_ROLES,
  PRODUCER_ROLES,
  laneDispatchRoutes,
  laneFrozenPaths,
  laneTaskScope,
  parseEyeVerdict,
  parseHandStatus,
  parseMarkCommand,
  pathInScope,
} from "./task-lane-contract.mjs";
import { taskReconciliationDigest, taskScopeBase } from "./task-reconciliation.mjs";
import {
  SHARED_CONTEXT_MAX_BYTES,
  gateStateFile,
  isVolatileHarnessPath,
  laneLedgerFile,
  sharedContextFile,
  taskRegistryPath,
} from "./task-paths.mjs";

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DIAGNOSTIC_LIMIT = 6000;

function failure(reason, details) {
  return { ok: false, reason: `[task-inspection] ${reason}`, ...(details && Object.keys(details).length ? { details } : {}) };
}
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clip = (text) => ({ text: String(text ?? "").slice(0, DIAGNOSTIC_LIMIT), truncated: String(text ?? "").length > DIAGNOSTIC_LIMIT });

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}
const gitText = (root, ...args) => String(git(root, args)).trim();
function ancestor(root, before, after) {
  try {
    git(root, ["merge-base", "--is-ancestor", before, after]);
    return true;
  } catch {
    return false;
  }
}
const splitZero = (value) => String(value).split("\0").filter(Boolean);

function readJsonIn(file, root) {
  return JSON.parse(readArtifact(file, root));
}

function validateLaunches(entry, readTaskProcessFn) {
  if (!Array.isArray(entry.launches) || entry.launches.length === 0) return failure("task run has no launches");
  const lifecycles = [];
  for (const [index, launch] of entry.launches.entries()) {
    const historical = index < entry.launches.length - 1;
    if (!object(launch) || typeof launch.run_id !== "string" || !launch.run_id) return failure(`launch ${index} identity is invalid`);
    const observed = readTaskProcessFn(launch);
    if (observed?.running || !observed?.terminal) return failure(`launch ${index} is not terminal: ${observed?.reason ?? "worker still active"}`);
    if (!observed.ok && historical) {
      lifecycles.push({ exitCode: null, signal: "UNKNOWN", timedOut: false, ended_at: null, interrupted: true, reason: observed.reason });
      continue;
    }
    if (!observed.ok) return failure(`latest launch completion is unavailable: ${observed.reason}`);
    lifecycles.push(observed.result);
  }
  const last = lifecycles.at(-1);
  if (last.exitCode !== 0 || last.timedOut || last.signal !== null) {
    return failure("latest task launch did not exit successfully", {
      launch_failure: { run_id: entry.launches.at(-1).run_id, exit_code: last.exitCode, signal: last.signal, timed_out: last.timedOut === true, ended_at: last.ended_at },
    });
  }
  return { ok: true, lifecycles };
}

function validateDependencies(grant, task, entry) {
  const expected = Array.isArray(task?.depends_on) ? task.depends_on : [];
  const recorded = Array.isArray(grant?.dependencies) ? grant.dependencies : [];
  if (recorded.length !== expected.length) return failure("grant dependency evidence does not match the canonical task");
  for (const taskId of expected) {
    const dependency = recorded.find((item) => item?.task_id === taskId);
    const receipt = object(dependency?.receipt);
    if (!dependency || !SHA256.test(dependency.receipt_sha256 ?? "") || !receipt || hashTaskReceipt(receipt) !== dependency.receipt_sha256 ||
        receipt.version !== 1 || receipt.written_by !== "host-task-integration" || receipt.parent_session_id !== entry.parent_session_id ||
        receipt.feature_id !== entry.feature_id || receipt.task_id !== taskId || receipt.parent_root !== entry.parent_root ||
        receipt.plan_sha256 !== entry.plan_sha256 || receipt.spec_sha256 !== entry.spec_sha256 ||
        dependency.child_head !== receipt.child_head || dependency.integrated_head !== receipt.integrated_head ||
        !ancestor(entry.parent_root, receipt.child_head, receipt.integrated_head) ||
        !ancestor(entry.parent_root, receipt.integrated_head, entry.base_sha)) {
      return failure(`dependency ${taskId} receipt is invalid for the task base`);
    }
  }
  return { ok: true };
}

/** Diary at exactly `head` (bounded), as a validated context return, or null when absent. */
function readContextReturn(worktree, featureId, sessionId, taskId, head) {
  const file = sharedContextFile(worktree, featureId);
  if (!fs.existsSync(file)) return null;
  const content = readArtifact(file, worktree);
  if (Buffer.byteLength(content, "utf8") > SHARED_CONTEXT_MAX_BYTES) throw new Error(`task diary exceeds ${SHARED_CONTEXT_MAX_BYTES} bytes`);
  if (gitText(worktree, "rev-parse", "HEAD") !== head) throw new Error("task HEAD changed while reading the diary");
  return buildTaskContextReturn({ sessionId, taskId, headSha: head, content, maxBytes: SHARED_CONTEXT_MAX_BYTES });
}

function frozenBytesAfterReconciliation(root, freezeSha, head, file, reconciliations = []) {
  let frozen = git(root, ["show", `${freezeSha}:${file}`], null);
  for (const proof of reconciliations) {
    if (ancestor(root, proof.merged_head, freezeSha)) continue;
    if (!ancestor(root, freezeSha, proof.pre_child_head)) throw new Error(`frozen file has no ancestral fidelity before reconciliation: ${file}`);
    const before = git(root, ["show", `${proof.pre_child_head}:${file}`], null);
    const merged = git(root, ["show", `${proof.merged_head}:${file}`], null);
    if (!Buffer.from(frozen).equals(Buffer.from(before))) throw new Error(`frozen file changed before host reconciliation: ${file}`);
    if (!Buffer.from(before).equals(Buffer.from(merged))) {
      const parent = git(root, ["show", `${proof.parent_head}:${file}`], null);
      if (proof.conflicts?.includes(file) || !Buffer.from(merged).equals(Buffer.from(parent))) throw new Error(`frozen file changed outside parent import: ${file}`);
    }
    frozen = merged;
  }
  const current = git(root, ["show", `${head}:${file}`], null);
  if (!Buffer.from(frozen).equals(Buffer.from(current))) throw new Error(`frozen file changed after fidelity: ${file}`);
  return current;
}

const isWriter = (call) => call.tool === "Agent" && call.ok && (call.role === "test-author" || PRODUCER_ROLES.includes(call.role));
const isProducer = (call) => call.tool === "Agent" && call.ok && PRODUCER_ROLES.includes(call.role) &&
  call.agentStatus === "completed" && ["DONE", "DONE_WITH_CONCERNS"].includes(parseHandStatus(call.text));
const isMark = (call, action, identity) => {
  if (call.tool !== "Bash" || !call.ok || call.post?.status !== "ok") return false;
  const mark = parseMarkCommand(call.command);
  return mark?.action === action && mark.flags["feature-id"] === identity.featureId && mark.flags["task-id"] === identity.taskId;
};
const committedBy = (call) => call.tool === "Bash" && call.ok && call.post?.status === "ok" && SHA.test(call.pre?.head ?? "") &&
  SHA.test(call.post?.head ?? "") && call.pre.head !== call.post.head ? call.post.head : null;

/** Prove test-author → fidelity pass → test-only freeze; returns the freeze and frozen blobs. */
function validateFidelity({ calls, frozen, worktree, head, reconciliations, state, identity }) {
  if (frozen.length === 0) return { ok: true, freezeSha: null, frozenBlobs: {}, freezeSeq: -1 };
  const authors = calls.filter((call) => call.tool === "Agent" && call.ok && call.role === "test-author" && call.agentStatus === "completed");
  const author = authors.at(-1);
  if (!author) return failure("fidelity requires a completed test-author for this task");
  const review = calls.findLast((call) => call.seq > author.seq && call.tool === "Agent" && call.ok && call.role === "compliance" &&
    call.marker?.fidelity === true && call.agentStatus === "completed");
  if (!review || calls.some((call) => call.seq > author.seq && call.seq < review.seq && isWriter(call))) {
    return failure("the latest test-author work has no subsequent compliance fidelity review");
  }
  if (parseEyeVerdict("compliance", review.text)?.positive !== true) return failure("the latest compliance fidelity review did not pass", { review_findings: [{ role: "compliance-fidelity", ...clip(review.text) }] });
  const freezeCall = calls.find((call) => call.seq > review.seq && committedBy(call));
  if (!freezeCall) return failure("a test-only freeze commit is required after the fidelity pass");
  if (calls.some((call) => call.seq > review.seq && call.seq < freezeCall.seq && isWriter(call))) return failure("a writer ran between the fidelity pass and the freeze commit");
  const freezeSha = freezeCall.post.head;
  const parents = gitText(worktree, "rev-list", "--parents", "-n", "1", freezeSha).split(" ").slice(1);
  if (parents.length !== 1 || parents[0] !== freezeCall.pre.head) return failure("the freeze must be exactly one linear commit");
  if (!ancestor(worktree, freezeSha, head)) return failure("the freeze commit is not ancestral to task HEAD");
  // Besides the locked tests, the freeze may only ADD new in-scope files: the throwing scaffold stub
  // orchestrating-delivery requires so a test of a not-yet-existing module collects and stays RED.
  // Modifying or deleting existing product inside the freeze is never allowed.
  const statuses = String(git(worktree, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", freezeSha])).split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index + 1 < statuses.length; index += 2) entries.push({ status: statuses[index], file: statuses[index + 1] });
  const frozenChanged = entries.filter((item) => pathInScope(item.file, frozen));
  const scaffold = entries.filter((item) => !pathInScope(item.file, frozen));
  if (frozenChanged.length === 0) return failure("the freeze commit must contain the locked tests");
  if (scaffold.some((item) => item.status !== "A" || !pathInScope(item.file, identity.scopes))) {
    return failure("the freeze commit may only add the locked tests and new in-scope scaffold files; it changed existing product or paths outside the task scope");
  }
  const bare = `${identity.featureId}/${identity.taskId}`;
  if (!Array.isArray(state.fidelity_pass) || !state.fidelity_pass.includes(`${bare}@${freezeSha}`)) {
    return failure("the event-proven freeze lacks its fidelity-pass marker (stamp it with HEAD at the freeze)");
  }
  const frozenBlobs = {};
  for (const file of frozen) {
    try {
      if (!/^100[0-7]{3} blob /.test(gitText(worktree, "ls-tree", freezeSha, "--", file))) return failure(`locked file is not a regular blob at the freeze: ${file}`);
      frozenBlobs[file] = sha256(frozenBytesAfterReconciliation(worktree, freezeSha, head, file, reconciliations));
    } catch (error) {
      return failure(String(error.message).startsWith("frozen file ") ? error.message : `locked file is absent from the fidelity chain: ${file}`);
    }
  }
  return { ok: true, freezeSha, frozenBlobs, freezeSeq: freezeCall.seq, reviewSeq: review.seq };
}

/** Product (non-frozen) paths changed between two commits. */
function productChanges(worktree, from, to, frozen) {
  return splitZero(git(worktree, ["diff", "--no-renames", "--name-only", "-z", from, to, "--"])).filter((file) => !pathInScope(file, frozen));
}

/**
 * Inspect one registry entry. Dependencies (tests): readTaskProcessFn, readTaskRunBindingFn.
 * @returns {{ ok: true, result: object } | { ok: false, reason: string, details?: object }}
 */
export function inspectTaskRun(entry, dependencies = {}) {
  try {
    if (!object(entry)) return failure("task run entry must be an object");
    for (const field of ["task_id", "attempt_id", "parent_session_id", "parent_root", "feature_id", "plan_sha256", "spec_sha256", "base_sha", "worktree", "grant_path", "job_dir"]) {
      if (typeof entry[field] !== "string" || !entry[field]) return failure(`task run ${field} is required`);
    }
    if (!isSafeTaskId(entry.task_id) || !isSafeFeatureId(entry.feature_id) || !isSafeSessionId(entry.parent_session_id) ||
        !SHA256.test(entry.plan_sha256) || !SHA256.test(entry.spec_sha256) || !SHA.test(entry.base_sha)) return failure("task run identity is invalid");
    const parentRoot = fs.realpathSync(entry.parent_root);
    const worktree = fs.realpathSync(entry.worktree);
    if (parentRoot !== path.resolve(entry.parent_root) || worktree !== path.resolve(entry.worktree)) return failure("task run roots must be canonical");
    const launches = validateLaunches(entry, dependencies.readTaskProcessFn ?? readTaskProcess);
    if (!launches.ok) return launches;
    const claim = readJsonIn(`${entry.grant_path}.claim`, worktree);
    if (!object(claim) || !isSafeSessionId(claim.session_id)) return failure("task grant claim lacks the lane session");
    const sessionId = claim.session_id;
    const binding = (dependencies.readTaskRunBindingFn ?? readTaskRunBinding)(worktree, sessionId);
    if (!binding?.ok) return failure(`task binding is invalid: ${binding?.reason ?? "unknown"}`);
    const { grant, task, plan } = binding;
    if (grant.task_id !== entry.task_id || grant.attempt_id !== entry.attempt_id || grant.parent_session_id !== entry.parent_session_id ||
        grant.parent_root !== parentRoot || grant.feature_id !== entry.feature_id || grant.plan_sha256 !== entry.plan_sha256 ||
        grant.spec_sha256 !== entry.spec_sha256 || grant.base_sha !== entry.base_sha || grant.cwd !== worktree ||
        path.resolve(entry.grant_path) !== binding.grantPath) return failure("task binding does not match the registry entry");
    const dependencyCheck = validateDependencies(grant, task, { ...entry, parent_root: parentRoot });
    if (!dependencyCheck.ok) return dependencyCheck;
    const head = gitText(worktree, "rev-parse", "HEAD");
    if (!SHA.test(head) || !ancestor(worktree, entry.base_sha, head)) return failure("task HEAD is not descended from its granted base");

    const native = readLaneEvents(entry.launches);
    if (native.sessionIds.size !== 1 || !native.sessionIds.has(sessionId)) return failure("native event session does not match the claimed lane session");
    for (const index of entry.launches.keys()) {
      const init = native.inits.filter((item) => item.launchIndex === index);
      if (!init.length && launches.lifecycles[index]?.interrupted) continue;
      if (!init.length || init.some((item) => item.cwd !== worktree)) return failure(`launch ${index} did not run in the task worktree`);
    }
    const lastResult = native.results.at(-1);
    if (!lastResult || lastResult.subtype !== "success" || lastResult.is_error) return failure("the latest lane session did not finish successfully");
    const calls = attachLedger(native.calls, readLaneLedger(laneLedgerFile(worktree, sessionId)));
    if (calls.some((call) => call.tool === "Agent" && call.ok && call.isAsync)) return failure("an asynchronous agent ran in the lane; lane agents must complete in the foreground");

    const contextReturn = readContextReturn(worktree, entry.feature_id, sessionId, entry.task_id, head);
    const diagnostics = {
      ...(contextReturn ? { context_return: contextReturn } : {}),
      ...(native.finalText.trim() ? { task_report: { session_id: sessionId, run_id: entry.launches.at(-1).run_id, head_sha: head, ...clip(native.finalText) } } : {}),
    };
    const dirty = [
      ...splitZero(git(worktree, ["diff", "--name-only", "-z", "HEAD", "--"])),
      ...splitZero(git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])),
    ].filter((file) => !isVolatileHarnessPath(file));
    if (dirty.length) return failure("task worktree must be clean before inspection", { ...diagnostics, worktree_changes: { task_id: entry.task_id, worktree, ...clip(dirty.join("\n")) } });

    const scopes = laneTaskScope(task);
    const frozen = laneFrozenPaths(task);
    const scopeBase = taskScopeBase(entry, worktree, head, scopes);
    const changedPaths = splitZero(git(worktree, ["diff", "--name-only", "-z", entry.base_sha, head]));
    const outside = splitZero(git(worktree, ["diff", "--name-only", "-z", scopeBase, head])).filter((file) => !pathInScope(file, scopes));
    if (outside.length) return failure("task changed paths outside its canonical scope", { ...diagnostics, worktree_changes: { task_id: entry.task_id, worktree, ...clip(outside.join("\n")) } });

    const state = (() => { try { return readJsonIn(gateStateFile(worktree, sessionId), worktree); } catch { return {}; } })();
    const identity = { featureId: entry.feature_id, taskId: entry.task_id, scopes };
    const producers = calls.filter(isProducer);
    const lastProducer = producers.at(-1);
    const handReport = lastProducer ? { hand_report: { producer_call_id: lastProducer.id, agent: lastProducer.role, ...clip(lastProducer.text) } } : {};
    if (!lastProducer) return failure("no successful executor or sniper completion was observed for this task", { ...diagnostics, ...handReport });
    const fidelity = validateFidelity({ calls, frozen, worktree, head, reconciliations: entry.reconciliations, state, identity });
    if (!fidelity.ok) return { ...fidelity, details: { ...diagnostics, ...handReport, ...fidelity.details } };

    const lastWriter = calls.filter(isWriter).at(-1);
    let recoveryOrigin = null;
    if (fidelity.freezeSha !== null && lastProducer.seq < fidelity.freezeSeq) {
      // Test-only recovery: the latest freeze follows the latest producer. Accept only when a clean
      // capture of that producer exists before the next test-author and product is unchanged since.
      const nextAuthor = calls.find((call) => call.seq > lastProducer.seq && call.tool === "Agent" && call.ok && call.role === "test-author");
      const priorCapture = calls.findLast((call) => call.seq > lastProducer.seq && (!nextAuthor || call.seq < nextAuthor.seq) &&
        isMark(call, "capture-verified", identity) && Array.isArray(call.pre?.dirty) && call.pre.dirty.length === 0 && SHA.test(call.pre?.head ?? ""));
      if (!priorCapture || !ancestor(worktree, priorCapture.pre.head, head) || productChanges(worktree, priorCapture.pre.head, head, frozen).length) {
        return failure("the executor or sniper must run after the latest fidelity freeze (a test-only repair needs a clean capture of the product before the test-author and no product change since)", { ...diagnostics, ...handReport });
      }
      recoveryOrigin = { head_sha: priorCapture.pre.head, producer_call_id: lastProducer.id, capture_call_id: priorCapture.id };
    }
    if (!recoveryOrigin && productChanges(worktree, fidelity.freezeSha ?? scopeBase, head, frozen).length === 0) {
      return failure("the implementation produced no committed product change since the freeze; a hand's DONE report is not evidence", { ...diagnostics, ...handReport });
    }
    const capture = calls.findLast((call) => isMark(call, "capture-verified", identity));
    if (!capture || capture.seq < lastWriter.seq || capture.pre?.head !== head || !Array.isArray(capture.pre?.dirty) || capture.pre.dirty.length !== 0) {
      return failure("capture-verified must be stamped with a clean tree at the final HEAD after the last writing hand", { ...diagnostics, ...handReport });
    }
    if (calls.some((call) => call.seq > capture.seq && committedBy(call))) return failure("a commit followed the last capture-verified; capture the final HEAD again", diagnostics);

    let routes;
    try { routes = laneDispatchRoutes(plan, task); } catch (error) { return failure(error.message); }
    const full = grant.mode === "FULL";
    const eyeCalls = calls.filter((call) => call.tool === "Agent" && call.ok && EYE_ROLES.includes(call.role) &&
      call.agentStatus === "completed" && call.marker?.fidelity !== true);
    const required = new Set([
      ...(full ? ["compliance"] : []),
      ...(full && routes.adversary.required ? ["adversary"] : []),
      ...(full && routes.security.required ? ["security"] : []),
      ...eyeCalls.map((call) => call.role),
    ]);
    const receipts = {};
    const reviewFindings = [];
    for (const role of [...required].sort()) {
      const last = eyeCalls.filter((call) => call.role === role).at(-1);
      const verdict = last ? parseEyeVerdict(role, last.text) : null;
      if (last && verdict && verdict.positive !== true) reviewFindings.push({ role, dispatch_call_id: last.id, ...clip(last.text) });
      if (!last || last.seq < lastWriter.seq || last.pre?.head !== head || !Array.isArray(last.pre?.dirty) || last.pre.dirty.length !== 0) {
        return failure(`a current ${role} review is required: dispatch it after the last writing hand, on the committed final HEAD`, { ...diagnostics, ...handReport, review_findings: reviewFindings });
      }
      if (!verdict) return failure(`the ${role} report has no canonical verdict block`, { ...diagnostics, review_findings: [{ role, dispatch_call_id: last.id, ...clip(last.text) }] });
      if (!verdict.positive) return failure(`the current ${role} review is negative: fix the findings with the sniper and re-run it`, { ...diagnostics, ...handReport, review_findings: reviewFindings });
      receipts[role] = { dispatch_call_id: last.id, agent_id: last.agentId, model: last.model, reviewed_head_sha: head, verdict: verdict.verdict, report_sha256: sha256(last.text) };
    }
    const bare = `${entry.feature_id}/${entry.task_id}`;
    const pending = (Array.isArray(state.regate_pending) ? state.regate_pending : []).filter((item) => item === bare);
    const passed = Array.isArray(state.regate_passed) ? state.regate_passed : [];
    if (pending.length && !matchesAbsolution(bare, passed, (sha) => SHA.test(sha ?? "") && ancestor(worktree, sha, head))) {
      return failure("the task re-gate is still pending: after the re-gate passes, stamp mark.mjs regate-passed for this task", { ...diagnostics, review_findings: reviewFindings });
    }
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
        session_id: sessionId,
        mode: grant.mode,
        plan_sha256: entry.plan_sha256,
        spec_sha256: entry.spec_sha256,
        base_sha: entry.base_sha,
        scope_base_sha: scopeBase,
        reconciliation_sha256: taskReconciliationDigest(entry),
        child_head: head,
        changed_paths: changedPaths,
        freeze_sha: fidelity.freezeSha,
        frozen_blobs: fidelity.frozenBlobs,
        hand_capture: {
          agent: lastProducer.role,
          producer_call_id: lastProducer.id,
          producer_launch_index: lastProducer.launchIndex,
          capture_call_id: capture.id,
          capture_head: head,
          ...(recoveryOrigin ? { recovery_origin: recoveryOrigin } : {}),
        },
        review_receipts: receipts,
        context_return: contextReturn,
        regate: { pending, passed: passed.filter((item) => String(item).startsWith(`${bare}@`)) },
        latest_run_id: entry.launches.at(-1).run_id,
        ...(entry.runtime ? { runtime: entry.runtime } : {}),
        launches: entry.launches.map((launch, index) => ({
          run_id: launch.run_id,
          exit_code: launches.lifecycles[index].exitCode,
          signal: launches.lifecycles[index].signal,
          timed_out: launches.lifecycles[index].timedOut === true,
          ended_at: launches.lifecycles[index].ended_at,
          ...(launches.lifecycles[index].interrupted ? { interrupted: true } : {}),
        })),
      },
    };
  } catch (error) {
    return failure(`task inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validResult(entry, result, { projectRoot, sessionId, featureId, taskId }) {
  const changedPathsValid = Array.isArray(result.changed_paths) && result.changed_paths.every((item) =>
    typeof item === "string" && item && !path.isAbsolute(item) && !item.split(/[\\/]/).includes(".."));
  const frozenValid = object(result.frozen_blobs) && Object.entries(result.frozen_blobs).every(([file, digest]) =>
    file && !path.isAbsolute(file) && !file.split(/[\\/]/).includes("..") && SHA256.test(digest)) &&
    (result.freeze_sha === null ? Object.keys(result.frozen_blobs).length === 0 : SHA.test(result.freeze_sha ?? ""));
  const contextValid = result.context_return === null || validateTaskContextReturn(result.context_return,
    { sessionId: result.session_id, taskId, headSha: result.child_head, maxBytes: SHARED_CONTEXT_MAX_BYTES }).ok;
  const launchesValid = Array.isArray(result.launches) && result.launches.length > 0 && result.launches.length <= (entry.launches?.length ?? 0) &&
    result.launches.every((launch, index) => launch?.run_id === entry.launches[index]?.run_id) &&
    result.launches.at(-1).exit_code === 0 && result.launches.at(-1).timed_out === false && result.launches.at(-1).signal === null;
  return result.version === 1 && result.written_by === "host-task-inspection" && result.parent_session_id === sessionId &&
    result.feature_id === featureId && result.task_id === taskId && result.attempt_id === entry.attempt_id &&
    result.parent_root === projectRoot && result.worktree === entry.worktree && isSafeSessionId(result.session_id) &&
    result.plan_sha256 === entry.plan_sha256 && result.spec_sha256 === entry.spec_sha256 && result.base_sha === entry.base_sha &&
    SHA.test(result.child_head ?? "") && changedPathsValid && frozenValid && contextValid && launchesValid &&
    object(result.hand_capture) && PRODUCER_ROLES.includes(result.hand_capture.agent) && result.hand_capture.capture_head === result.child_head &&
    object(result.review_receipts) && object(result.regate);
}

/**
 * Re-validate one integrated task against Git, the registry and the current plan approval.
 * @returns {{ ok: true, result: object, entry: object } | { ok: false, reason: string }}
 */
export function readIntegratedTaskEvidence({ projectRoot, sessionId, featureId, taskId, headSha, reconciliationFor } = {}) {
  try {
    if (typeof projectRoot !== "string" || !isSafeSessionId(sessionId) || !isSafeFeatureId(featureId) || !isSafeTaskId(taskId)) return failure("safe integrated task identity required");
    const root = fs.realpathSync(projectRoot);
    if (root !== path.resolve(projectRoot)) return failure("integrated task project root must be canonical");
    const registry = readJsonIn(taskRegistryPath(root, sessionId), root);
    const entry = registry?.tasks?.[taskId];
    if (registry?.version !== 1 || registry.parent_session_id !== sessionId || registry.feature_id !== featureId || !object(entry) ||
        entry.parent_session_id !== sessionId || entry.feature_id !== featureId || entry.task_id !== taskId ||
        entry.plan_sha256 !== registry.plan_sha256 || entry.spec_sha256 !== registry.spec_sha256 || entry.parent_root !== root) {
      return failure("current integrated task registry entry required");
    }
    const barrier = registry.correction_barrier;
    const reconciliationRead = object(reconciliationFor) && barrier?.task_id === reconciliationFor.task_id &&
      barrier.attempt_id === reconciliationFor.attempt_id && barrier.task_id !== taskId;
    if (barrier && !reconciliationRead) return failure(`correction barrier active for task ${barrier.task_id}; integrate that exact attempt first`);
    if (entry.status !== "integrated") return failure("current integrated task registry entry required");
    const parent = readParentAuthority({ root, sessionId });
    if (parent.featureId !== featureId || parent.approval.plan_sha256 !== registry.plan_sha256 || parent.approval.spec_sha256 !== registry.spec_sha256) {
      return failure("integrated task is not bound to the current host-owned plan approval");
    }
    const result = object(entry.result);
    const integration = object(entry.integration);
    if (!result || !integration || !validResult(entry, result, { projectRoot: root, sessionId, featureId, taskId })) {
      return failure("task inspection receipt is incomplete or does not match the registry entry");
    }
    if (integration.version !== 1 || integration.written_by !== "host-task-integration" || integration.parent_session_id !== sessionId ||
        integration.feature_id !== featureId || integration.task_id !== taskId || integration.attempt_id !== entry.attempt_id ||
        integration.parent_root !== root || integration.worktree !== entry.worktree || integration.session_id !== result.session_id ||
        integration.plan_sha256 !== entry.plan_sha256 || integration.spec_sha256 !== entry.spec_sha256 ||
        integration.base_sha !== entry.base_sha || integration.child_head !== result.child_head ||
        !SHA.test(integration.integrated_head ?? "") || integration.result_sha256 !== hashTaskReceipt(result)) {
      return failure("task integration receipt does not match the registry entry");
    }
    if ((result.scope_base_sha ?? result.base_sha) !== taskScopeBase(entry, root, result.child_head) ||
        (result.reconciliation_sha256 ?? null) !== taskReconciliationDigest(entry)) {
      return failure("task integration reconciliation proof differs from its inspection receipt");
    }
    if (!SHA.test(headSha ?? "") || !ancestor(root, result.base_sha, result.child_head) ||
        !ancestor(root, result.child_head, integration.integrated_head) || !ancestor(root, integration.integrated_head, headSha)) {
      return failure("task integration is not ancestral to the requested HEAD");
    }
    const parents = gitText(root, "rev-list", "--parents", "-n", "1", integration.integrated_head).split(" ").slice(1);
    const frozenParent = integration.frozen_parent;
    if (integration.already_ancestral === true) {
      if (!ancestor(root, result.child_head, integration.integrated_head)) return failure("ancestral integration does not contain the task HEAD");
    } else if (parents.length !== 2 || parents[1] !== result.child_head) {
      return failure("task integration is not a two-parent merge of the task HEAD");
    }
    const actualChanged = splitZero(git(root, ["diff", "--name-only", "-z", result.base_sha, result.child_head]));
    if (JSON.stringify(actualChanged) !== JSON.stringify(result.changed_paths)) return failure("task inspection changed-path receipt no longer matches Git");
    for (const [file, expected] of Object.entries(result.frozen_blobs)) {
      const parentDigest = frozenParent?.blobs?.[file];
      let current;
      try {
        current = sha256(git(root, ["show", `${headSha}:${file}`], null));
      } catch {
        return failure(`integrated frozen file is unavailable: ${file}`);
      }
      if (current !== (parentDigest ?? expected)) return failure(`integrated frozen file changed: ${file}`);
    }
    return { ok: true, result: integration, entry };
  } catch (error) {
    return failure(`integrated task evidence unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Every canonical plan task integrated with current evidence at `headSha`. */
export function readAllIntegratedTaskEvidence({ projectRoot, sessionId, featureId, headSha, tasks } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return failure("canonical task list required");
  const results = [];
  for (const task of tasks) {
    const evidence = readIntegratedTaskEvidence({ projectRoot, sessionId, featureId, taskId: typeof task === "string" ? task : task?.id, headSha });
    if (!evidence.ok) return failure(`integrated evidence missing for ${featureId}/${typeof task === "string" ? task : task?.id}: ${evidence.reason}`);
    results.push(evidence.result);
  }
  return { ok: true, results };
}
