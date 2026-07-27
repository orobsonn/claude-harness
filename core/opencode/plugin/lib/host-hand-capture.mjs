/** @description OC-native host capture for in-session Task hands (not CC spawn-hand). Never throws. */

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { gateStatePath } from "../../../shared/lib/path-helpers.mjs";
import { isDoneHandRecord } from "../../../shared/lib/real-file-capture-rail.mjs";
import { withGateStateLock } from "./gate-state.mjs";
import { fidelityPassEntry, defaultHeadSha } from "./mark-gate.mjs";
import { writeHandRecord } from "./hand-records.mjs";

/**
 * @description Git paths changed since merge-base or last N commits (best-effort).
 * @param {string} cwd
 * @returns {string[]}
 */
export function gitTouchedPaths(cwd) {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "HEAD~5", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return String(out)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    try {
      const out = execFileSync("git", ["status", "--porcelain"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
      return String(out)
        .split(/\r?\n/)
        .map((l) => l.trim().slice(3).trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/**
 * @description If Status line missing/BLOCKED but git shows work, promote to DONE for OC Task path.
 * @param {string | null} parsedStatus
 * @param {string[]} touched
 * @returns {string}
 */
export function resolveOcHandOutcome(parsedStatus, touched) {
  if (parsedStatus === "DONE" || parsedStatus === "DONE_WITH_CONCERNS") return parsedStatus;
  if (parsedStatus === "NEEDS_CONTEXT") return "NEEDS_CONTEXT";
  if (Array.isArray(touched) && touched.length > 0) return "DONE";
  return parsedStatus || "BLOCKED";
}

/**
 * @description Persist DONE hand-record + host-stamp hand_finished + capture_verified (sealed).
 * @param {{
 *   projectRoot: string,
 *   sessionId: string,
 *   featureId: string,
 *   taskId: string,
 *   role?: string,
 *   outcome: string,
 *   touchedPaths?: string[],
 *   freezeCommitSha?: string | null,
 * }} input
 * @returns {{ ok: boolean, reason?: string, outcome?: string }}
 */
export function hostStampOcHandCapture(input) {
  try {
    const {
      projectRoot,
      sessionId,
      featureId,
      taskId,
      role,
      outcome,
      touchedPaths = [],
      freezeCommitSha = null,
    } = input;
    if (!projectRoot || !sessionId || !featureId || !taskId) {
      return { ok: false, reason: "missing identity" };
    }
    const sha = freezeCommitSha || defaultHeadSha(projectRoot) || "";
    const finalOutcome = outcome;
    const now = new Date().toISOString();
    const record = {
      featureId,
      taskId,
      sessionId,
      freezeCommitSha: sha || null,
      outcome: finalOutcome,
      touchedPaths: Array.isArray(touchedPaths) ? touchedPaths : [],
      scopeViolations: [],
      frozenViolations: [],
      agent: role,
      startedAt: now,
      finishedAt: now,
      writtenBy: "obs-hand-task",
    };

    if (isDoneHandRecord(record) && sha) {
      record.capturedVerifiedAt = now;
    }

    const written = writeHandRecord({
      roots: { projectRoot, runtime: "opencode", sessionId, featureId },
      taskId,
      record,
    });
    if (!written.ok) return { ok: false, reason: written.reason, outcome: finalOutcome };

    if (!isDoneHandRecord(record) || !sha) {
      return { ok: true, outcome: finalOutcome, reason: "record-only" };
    }

    const gs = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
    if (!gs.ok) return { ok: true, outcome: finalOutcome, reason: "gate-path-skip" };

    const bare = fidelityPassEntry(featureId, taskId, null);
    const capEntry = fidelityPassEntry(featureId, taskId, sha);

    // This run supersedes every prior SHA for this task: prune the task's prior array
    // entries (any SHA) before appending — otherwise an old-SHA entry survives alongside
    // the new one for the same task.
    const belongsToTask = (payload) => {
      const s = String(payload ?? "");
      return s === bare || s.startsWith(`${bare}@`);
    };
    const locked = withGateStateLock(gs.path, (prev) => {
      const hand_finished = (Array.isArray(prev.hand_finished) ? prev.hand_finished : []).filter(
        (e) => !belongsToTask(e),
      );
      hand_finished.push(bare);
      const capture_verified = (Array.isArray(prev.capture_verified) ? prev.capture_verified : []).filter(
        (e) => !belongsToTask(e),
      );
      capture_verified.push(capEntry);
      return {
        ...prev,
        hand_finished,
        capture_verified,
      };
    });
    if (!locked.ok) return { ok: true, outcome: finalOutcome, reason: "gate-lock-skip" };
    return { ok: true, outcome: finalOutcome };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "hostStampOcHandCapture failed",
    };
  }
}

export default {
  gitTouchedPaths,
  hostStampOcHandCapture,
  resolveOcHandOutcome,
};
