/** @description Host-owned Task completion facts. Capture verification is intentionally a later action. */

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { gateStatePath, handRecordPath } from "../../shared/lib/path-helpers.mjs";
import { formatFeatureTaskEntry } from "../../shared/lib/absolution.mjs";
import { withGateStateLock } from "../../lib/gate-state.mjs";
import { readDispatchRecord, removeDispatchRecord } from "../../lib/dispatch-scope.mjs";
import { isCapacityExhaustedOutput, parseHandStatusFromOutput, writeHandRecord } from "../../lib/hand-records.mjs";
import { listGitTouchedPaths, pathsChangedSinceBaseline } from "../../lib/worktree-baseline.mjs";
import { checkFrozen } from "../../shared/lib/capture-oracle.mjs";

function isCaptureEligibleOutcome(outcome) {
  return outcome === "DONE" || outcome === "DONE_WITH_CONCERNS";
}

function readHandRecord(projectRoot, sessionId, featureId, taskId) {
  const resolved = handRecordPath({ projectRoot, runtime: "opencode", sessionId, featureId }, taskId);
  if (!resolved.ok) return null;
  try {
    const value = JSON.parse(fs.readFileSync(resolved.path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function removeTaskEntry(entries, bare) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry !== bare);
}

function scopeViolations(touchedPaths, record) {
  const allowed = [...(Array.isArray(record.scope_paths) ? record.scope_paths : []), ...(Array.isArray(record.allowed_writes) ? record.allowed_writes : [])];
  return (Array.isArray(touchedPaths) ? touchedPaths : []).filter((item) => typeof item === "string" && !allowed.some((entry) => item === entry || (typeof entry === "string" && (entry.endsWith("/") || !entry.includes(".")) && item.startsWith(`${entry.replace(/\/$/, "")}/`))));
}

/**
 * @description Persist a terminal host record and stamp a capture-eligible completion fact.
 * @param {{ projectRoot: string, sessionId: string, featureId: string, taskId: string, role: string, producerCallId: string, outcome: string, touchedPaths: string[], freezeCommitSha: string | null }} input
 * @returns {{ ok: boolean, recorded: boolean, reason?: string }}
 */
export function recordHandFinished(input) {
  try {
    const { projectRoot, sessionId, featureId, taskId, role, producerCallId, outcome, touchedPaths, freezeCommitSha } = input ?? {};
    if (![projectRoot, sessionId, featureId, taskId, role, producerCallId, outcome].every((value) => typeof value === "string" && value)) return { ok: false, recorded: false, reason: "completion identity missing" };
    const initial = readDispatchRecord(projectRoot, { parentSessionId: sessionId, callId: producerCallId });
    if (!initial.ok || initial.record.feature_id !== featureId || initial.record.task_id !== taskId || initial.record.role !== role) return { ok: false, recorded: false, reason: "exact producer dispatch record required" };
    const state = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
    if (!state.ok) return { ok: false, recorded: false, reason: state.reason };
    let outcomeResult = { ok: false, recorded: false, reason: "completion record failed" };
    let supersededProducerCallId = "";
    const locked = withGateStateLock(state.path, (gateState) => {
      const producer = readDispatchRecord(projectRoot, { parentSessionId: sessionId, callId: producerCallId });
      if (!producer.ok || producer.record.feature_id !== featureId || producer.record.task_id !== taskId || producer.record.role !== role) {
        outcomeResult = { ok: false, recorded: false, reason: "exact producer dispatch record required" };
        return gateState;
      }
      const existing = readHandRecord(projectRoot, sessionId, featureId, taskId);
      const bare = formatFeatureTaskEntry(featureId, taskId);
      if (existing?.producerCallId === producerCallId) {
        const handFinished = removeTaskEntry(gateState.hand_finished, bare);
        if (isCaptureEligibleOutcome(existing.outcome)) handFinished.push(bare);
        outcomeResult = { ok: true, recorded: false, reason: "completion producer already recorded" };
        return { ...gateState, hand_finished: handFinished };
      }
      const priorClaimedAt = typeof existing?.producerClaimedAt === "string" ? Date.parse(existing.producerClaimedAt) : Number.NEGATIVE_INFINITY;
      const claimedAt = Date.parse(producer.record.claimed_at);
      if (!Number.isFinite(claimedAt)) {
        outcomeResult = { ok: false, recorded: false, reason: "producer claim timestamp invalid" };
        return gateState;
      }
      if (existing?.producerCallId !== producerCallId && Number.isFinite(priorClaimedAt) && priorClaimedAt >= claimedAt) {
        outcomeResult = { ok: true, recorded: false, reason: "newer completion producer already recorded" };
        return gateState;
      }
      const now = new Date().toISOString();
      const scope = scopeViolations(touchedPaths, producer.record);
      const frozen = checkFrozen(touchedPaths, Array.isArray(producer.record.frozen_paths) ? producer.record.frozen_paths : []);
      const effectiveOutcome = scope.length > 0 || frozen.length > 0 ? "BLOCKED" : outcome;
      const record = {
        featureId, taskId, sessionId, producerCallId, producerClaimedAt: producer.record.claimed_at,
        freezeCommitSha: typeof freezeCommitSha === "string" && freezeCommitSha ? freezeCommitSha : null,
        outcome: effectiveOutcome, touchedPaths: Array.isArray(touchedPaths) ? touchedPaths.filter((item) => typeof item === "string") : [],
        scopeViolations: scope, frozenViolations: frozen, agent: role,
        startedAt: existing?.startedAt ?? now, finishedAt: now, writtenBy: "host-hand-finished",
      };
      const written = writeHandRecord({ roots: { projectRoot, runtime: "opencode", sessionId, featureId }, taskId, record });
      if (!written.ok) {
        outcomeResult = { ok: false, recorded: false, reason: written.reason };
        return gateState;
      }
      if (typeof existing?.producerCallId === "string" && existing.producerCallId !== producerCallId) {
        supersededProducerCallId = existing.producerCallId;
      }
      const handFinished = removeTaskEntry(gateState.hand_finished, bare);
      if (isCaptureEligibleOutcome(effectiveOutcome)) handFinished.push(bare);
      outcomeResult = { ok: true, recorded: true };
      return { ...gateState, hand_finished: handFinished };
    });
    if (!locked.ok) return { ok: false, recorded: false, reason: locked.reason };
    if (supersededProducerCallId) {
      removeDispatchRecord(projectRoot, { sessionId, callId: supersededProducerCallId });
    }
    return outcomeResult;
  } catch (error) {
    return { ok: false, recorded: false, reason: error instanceof Error ? error.message : "recordHandFinished failed" };
  }
}

/** @description Resolve HEAD from an explicit project root; faults and empty output are non-fatal. */
export function resolveHeadSha(projectRoot, execFileSyncFn = execFileSync) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return null;
  try {
    const sha = String(execFileSyncFn("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }) ?? "").trim();
    return sha || null;
  } catch { return null; }
}

/** @description Resolve whether one SHA is an ancestor of HEAD; git faults are undetermined. */
export function isAncestorSha(projectRoot, sha, execFileSyncFn = execFileSync) {
  if (![projectRoot, sha].every((value) => typeof value === "string" && value.length > 0)) return null;
  try {
    execFileSyncFn("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch (error) {
    return error && typeof error === "object" && "status" in error && error.status === 1 ? false : null;
  }
}

/** @description Best-effort staged, unstaged, and untracked paths in the current Task worktree. */
export function gitTouchedPaths(cwd) {
  return listGitTouchedPaths(cwd).paths;
}

/** @description Preserve only the Task's explicit terminal fact; git evidence never promotes it. */
export function resolveOcHandOutcome(parsedStatus, _touched, outputText = "") {
  if (parsedStatus === "DONE" || parsedStatus === "DONE_WITH_CONCERNS") return parsedStatus;
  if (parsedStatus === "NEEDS_CONTEXT") return "NEEDS_CONTEXT";
  if (parsedStatus === null && isCapacityExhaustedOutput(outputText)) return "CAPACITY_EXHAUSTED";
  return "BLOCKED";
}

/** @description Normalize one terminal Task result and persist it through exact producer authority. */
export function recordTaskCompletion(input) {
  const outputText = String(input?.outputText ?? "");
  if (input?.background === true && /<task\b[^>]*\bstate=["']running["']/i.test(outputText)) return { ok: true, terminal: false, recorded: false, reason: "background task still running" };
  const producer = readDispatchRecord(input?.projectRoot, { parentSessionId: input?.sessionId, callId: input?.producerCallId });
  const touched = pathsChangedSinceBaseline(input?.projectRoot, producer.ok ? producer.record.worktree_baseline : null);
  const outcome = resolveOcHandOutcome(parseHandStatusFromOutput(outputText), touched, outputText);
  const recorded = recordHandFinished({
    projectRoot: input?.projectRoot,
    sessionId: input?.sessionId,
    featureId: input?.featureId,
    taskId: input?.taskId,
    role: input?.role,
    producerCallId: input?.producerCallId,
    outcome,
    touchedPaths: touched,
    freezeCommitSha: resolveHeadSha(input?.projectRoot),
  });
  const persisted = readHandRecord(input?.projectRoot, input?.sessionId, input?.featureId, input?.taskId);
  const capturePending =
    recorded.ok === true &&
    isCaptureEligibleOutcome(persisted?.outcome) &&
    persisted?.producerCallId === input?.producerCallId;
  return { ...recorded, terminal: true, capturePending };
}

export default { gitTouchedPaths, isAncestorSha, recordHandFinished, recordTaskCompletion, resolveHeadSha, resolveOcHandOutcome };
