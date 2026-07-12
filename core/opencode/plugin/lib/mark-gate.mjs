/**
 * @description OC gate markers — stamp ceremony + fidelity + array rails via mergeGateState.
 * stampBrainstormed / stampAdversaryFired / stampDualStatus / stampFidelityPass /
 * stampRegatePending / stampRegatePassed / stampHandFinished / stampCaptureVerified.
 * dual_status only via dualStatusGatePatch (enum). CLI: node mark-gate.mjs <action> ...
 * Never throws.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mergeGateState, readGateState } from "./gate-state.mjs";
import {
  gateStatePath,
  handRecordPath,
} from "../../../shared/lib/path-helpers.mjs";
import { dualStatusGatePatch } from "./dual-enforcement.mjs";
import { isDoneHandRecord } from "../../../shared/lib/real-file-capture-rail.mjs";

/**
 * @description Build fidelity_pass entry: feature/task or feature/task@sha.
 * @param {string} featureId
 * @param {string} taskId
 * @param {string|null|undefined} sha
 * @returns {string}
 */
export function fidelityPassEntry(featureId, taskId, sha) {
  const base = `${featureId}/${taskId}`;
  if (typeof sha === "string" && sha.length > 0) return `${base}@${sha}`;
  return base;
}

/**
 * @description Best-effort HEAD sha for sha-qualified stamps. Never throws.
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function defaultHeadSha(cwd = process.cwd()) {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    if (r.status !== 0) return null;
    const sha = String(r.stdout ?? "").trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * @description Append fidelity_pass marker for feature/task via mergeGateState (union, idempotent).
 * Prefer sha-qualified entry when HEAD (or explicit sha) is available; consumers match by prefix.
 *
 * @param {{
 *   projectRoot: string,
 *   sessionId: string,
 *   featureId: string,
 *   taskId: string,
 *   sha?: string|null,
 *   merge?: typeof mergeGateState,
 *   resolvePath?: typeof gateStatePath,
 *   headSha?: (cwd: string) => string|null,
 * }} args
 * @returns {{ ok: true, entry: string, state: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function stampFidelityPass({
  projectRoot,
  sessionId,
  featureId,
  taskId,
  sha,
  merge = mergeGateState,
  resolvePath = gateStatePath,
  headSha = defaultHeadSha,
} = {}) {
  try {
    if (
      typeof projectRoot !== "string" ||
      !projectRoot ||
      typeof sessionId !== "string" ||
      !sessionId ||
      typeof featureId !== "string" ||
      !featureId ||
      typeof taskId !== "string" ||
      !taskId
    ) {
      return {
        ok: false,
        reason: "projectRoot, sessionId, featureId, and taskId are required",
      };
    }

    let resolvedSha = null;
    if (sha === undefined) {
      resolvedSha = headSha(projectRoot);
    } else if (typeof sha === "string" && sha.length > 0) {
      resolvedSha = sha;
    } else {
      resolvedSha = null;
    }

    const entry = fidelityPassEntry(featureId, taskId, resolvedSha);
    const gp = resolvePath({
      projectRoot,
      runtime: "opencode",
      sessionId,
    });
    if (!gp.ok) {
      return { ok: false, reason: gp.reason ?? "gateStatePath failed" };
    }

    const merged = merge(gp.path, { fidelity_pass: [entry] });
    if (!merged.ok) {
      return {
        ok: false,
        reason: merged.reason ?? "mergeGateState failed",
      };
    }

    const fp = Array.isArray(merged.state?.fidelity_pass)
      ? merged.state.fidelity_pass
      : [];
    const present =
      fp.includes(entry) ||
      fp.some((e) => {
        if (typeof e !== "string") return false;
        const at = e.lastIndexOf("@");
        const base = at > 0 ? e.slice(0, at) : e;
        return base === `${featureId}/${taskId}`;
      });
    if (!present) {
      return { ok: false, reason: "fidelity_pass read-back failed" };
    }

    return { ok: true, entry, state: merged.state };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "stampFidelityPass failed",
    };
  }
}

/**
 * @description Stamp a boolean ceremony marker via mergeGateState.
 * @param {{ projectRoot: string, sessionId: string, key: "brainstormed"|"adversary_fired", merge?: typeof mergeGateState, resolvePath?: typeof gateStatePath }} args
 * @returns {{ ok: true, state: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function stampCeremonyMarker({
  projectRoot,
  sessionId,
  key,
  merge = mergeGateState,
  resolvePath = gateStatePath,
} = {}) {
  try {
    if (key !== "brainstormed" && key !== "adversary_fired") {
      return { ok: false, reason: "key must be brainstormed or adversary_fired" };
    }
    if (
      typeof projectRoot !== "string" ||
      !projectRoot ||
      typeof sessionId !== "string" ||
      !sessionId
    ) {
      return { ok: false, reason: "projectRoot and sessionId required" };
    }
    const gp = resolvePath({
      projectRoot,
      runtime: "opencode",
      sessionId,
    });
    if (!gp.ok) {
      return { ok: false, reason: gp.reason ?? "gateStatePath failed" };
    }
    const merged = merge(gp.path, { [key]: true });
    if (!merged.ok) {
      return { ok: false, reason: merged.reason ?? "mergeGateState failed" };
    }
    if (merged.state?.[key] !== true) {
      return { ok: false, reason: `${key} read-back failed` };
    }
    return { ok: true, state: merged.state };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "stampCeremonyMarker failed",
    };
  }
}

/**
 * @description Stamp brainstormed=true.
 * @param {object} args
 * @returns {ReturnType<typeof stampCeremonyMarker>}
 */
export function stampBrainstormed(args) {
  return stampCeremonyMarker({ ...args, key: "brainstormed" });
}

/**
 * @description Stamp adversary_fired=true.
 * @param {object} args
 * @returns {ReturnType<typeof stampCeremonyMarker>}
 */
export function stampAdversaryFired(args) {
  return stampCeremonyMarker({ ...args, key: "adversary_fired" });
}

/**
 * @description Stamp dual_status via dualStatusGatePatch only (enum).
 * @param {{ projectRoot: string, sessionId: string, dualStatus: string, merge?: typeof mergeGateState, resolvePath?: typeof gateStatePath }} args
 * @returns {{ ok: true, state: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function stampDualStatus({
  projectRoot,
  sessionId,
  dualStatus,
  merge = mergeGateState,
  resolvePath = gateStatePath,
} = {}) {
  try {
    if (
      typeof projectRoot !== "string" ||
      !projectRoot ||
      typeof sessionId !== "string" ||
      !sessionId
    ) {
      return { ok: false, reason: "projectRoot and sessionId required" };
    }

    // dualStatusGatePatch: {ok:false,reason} OR plain patch with dual_status (enum only)
    const patch = dualStatusGatePatch(dualStatus);
    if (!patch || typeof patch !== "object") {
      return { ok: false, reason: "invalid dual_status (enum only)" };
    }
    if (patch.ok === false) {
      return {
        ok: false,
        reason:
          typeof patch.reason === "string" && patch.reason
            ? patch.reason
            : "invalid dual_status (enum only)",
      };
    }
    if (
      typeof patch.dual_status !== "string" ||
      !("dual_status" in patch)
    ) {
      return { ok: false, reason: "invalid dual_status (enum only)" };
    }

    const gp = resolvePath({
      projectRoot,
      runtime: "opencode",
      sessionId,
    });
    if (!gp.ok) {
      return { ok: false, reason: gp.reason ?? "gateStatePath failed" };
    }

    /** @type {Record<string, unknown>} */
    const toMerge = { dual_status: patch.dual_status };
    if (patch.dual_error_class != null) {
      toMerge.dual_error_class = patch.dual_error_class;
    }
    if (patch.dual_secondary_attempts != null) {
      toMerge.dual_secondary_attempts = patch.dual_secondary_attempts;
    }

    const merged = merge(gp.path, toMerge);
    if (!merged.ok) {
      return { ok: false, reason: merged.reason ?? "mergeGateState failed" };
    }
    return { ok: true, state: merged.state };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "stampDualStatus failed",
    };
  }
}

/**
 * @description Validate common stamp args (projectRoot, sessionId, featureId, taskId).
 * @param {{ projectRoot?: unknown, sessionId?: unknown, featureId?: unknown, taskId?: unknown }} args
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function requireTaskStampArgs({ projectRoot, sessionId, featureId, taskId }) {
  if (
    typeof projectRoot !== "string" ||
    !projectRoot ||
    typeof sessionId !== "string" ||
    !sessionId ||
    typeof featureId !== "string" ||
    !featureId ||
    typeof taskId !== "string" ||
    !taskId
  ) {
    return {
      ok: false,
      reason: "projectRoot, sessionId, featureId, and taskId are required",
    };
  }
  return { ok: true };
}

/**
 * @description Resolve sha for absolute stamps. undefined → headSha; non-empty string → use; else null.
 * @param {string|null|undefined} sha
 * @param {(cwd: string) => string|null} headSha
 * @param {string} projectRoot
 * @returns {string|null}
 */
function resolveSha(sha, headSha, projectRoot) {
  if (sha === undefined) return headSha(projectRoot);
  if (typeof sha === "string" && sha.length > 0) return sha;
  return null;
}

/**
 * @description Append unqualified array marker feature/task (union, idempotent).
 * @param {{
 *   projectRoot: string,
 *   sessionId: string,
 *   featureId: string,
 *   taskId: string,
 *   key: "regate_pending"|"hand_finished",
 *   merge?: typeof mergeGateState,
 *   resolvePath?: typeof gateStatePath,
 * }} args
 * @returns {{ ok: true, entry: string, state: Record<string, unknown> } | { ok: false, reason: string }}
 */
function stampUnqualifiedArrayMarker({
  projectRoot,
  sessionId,
  featureId,
  taskId,
  key,
  merge = mergeGateState,
  resolvePath = gateStatePath,
}) {
  try {
    const req = requireTaskStampArgs({
      projectRoot,
      sessionId,
      featureId,
      taskId,
    });
    if (!req.ok) return req;

    const entry = fidelityPassEntry(featureId, taskId, null);
    const gp = resolvePath({
      projectRoot,
      runtime: "opencode",
      sessionId,
    });
    if (!gp.ok) {
      return { ok: false, reason: gp.reason ?? "gateStatePath failed" };
    }

    const merged = merge(gp.path, { [key]: [entry] });
    if (!merged.ok) {
      return {
        ok: false,
        reason: merged.reason ?? "mergeGateState failed",
      };
    }

    const arr = Array.isArray(merged.state?.[key]) ? merged.state[key] : [];
    if (!arr.includes(entry)) {
      return { ok: false, reason: `${key} read-back failed` };
    }

    return { ok: true, entry, state: merged.state };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error ? err.message : `stamp ${key} failed`,
    };
  }
}

/**
 * @description Merge regate_pending entry feature/task (union, idempotent).
 * @param {{
 *   projectRoot: string,
 *   sessionId: string,
 *   featureId: string,
 *   taskId: string,
 *   merge?: typeof mergeGateState,
 *   resolvePath?: typeof gateStatePath,
 * }} args
 * @returns {{ ok: true, entry: string, state: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function stampRegatePending(args = {}) {
  return stampUnqualifiedArrayMarker({ ...args, key: "regate_pending" });
}

/**
 * @description Append regate_passed feature/task@sha. Requires resolved HEAD or explicit sha.
 * Without sha → ok:false, never unqualified entry.
 * @param {{
 *   projectRoot: string,
 *   sessionId: string,
 *   featureId: string,
 *   taskId: string,
 *   sha?: string|null,
 *   merge?: typeof mergeGateState,
 *   resolvePath?: typeof gateStatePath,
 *   headSha?: (cwd: string) => string|null,
 * }} args
 * @returns {{ ok: true, entry: string, state: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function stampRegatePassed({
  projectRoot,
  sessionId,
  featureId,
  taskId,
  sha,
  merge = mergeGateState,
  resolvePath = gateStatePath,
  headSha = defaultHeadSha,
} = {}) {
  try {
    const req = requireTaskStampArgs({
      projectRoot,
      sessionId,
      featureId,
      taskId,
    });
    if (!req.ok) return req;

    const resolvedSha = resolveSha(sha, headSha, projectRoot);
    if (!resolvedSha) {
      return {
        ok: false,
        reason: "regate_passed requires resolved HEAD sha or explicit sha",
      };
    }

    const entry = fidelityPassEntry(featureId, taskId, resolvedSha);
    const gp = resolvePath({
      projectRoot,
      runtime: "opencode",
      sessionId,
    });
    if (!gp.ok) {
      return { ok: false, reason: gp.reason ?? "gateStatePath failed" };
    }

    const merged = merge(gp.path, { regate_passed: [entry] });
    if (!merged.ok) {
      return {
        ok: false,
        reason: merged.reason ?? "mergeGateState failed",
      };
    }

    const arr = Array.isArray(merged.state?.regate_passed)
      ? merged.state.regate_passed
      : [];
    if (!arr.includes(entry)) {
      return { ok: false, reason: "regate_passed read-back failed" };
    }

    return { ok: true, entry, state: merged.state };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "stampRegatePassed failed",
    };
  }
}

/**
 * @description Merge hand_finished entry feature/task (union, idempotent).
 * @param {{
 *   projectRoot: string,
 *   sessionId: string,
 *   featureId: string,
 *   taskId: string,
 *   merge?: typeof mergeGateState,
 *   resolvePath?: typeof gateStatePath,
 * }} args
 * @returns {{ ok: true, entry: string, state: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function stampHandFinished(args = {}) {
  return stampUnqualifiedArrayMarker({ ...args, key: "hand_finished" });
}

/**
 * @description Append capture_verified feature/task@sha only when hand_finished has feature/task
 * AND a DONE hand-record exists on disk at the OC path. Also sets capturedVerifiedAt ISO on that
 * record (preserves other fields). Without hand_finished, without on-disk record, non-DONE
 * (FAILED/NOT_DONE), or without sha → ok:false, no array append, no invent file.
 * @param {{
 *   projectRoot: string,
 *   sessionId: string,
 *   featureId: string,
 *   taskId: string,
 *   sha?: string|null,
 *   merge?: typeof mergeGateState,
 *   resolvePath?: typeof gateStatePath,
 *   resolveHandPath?: typeof handRecordPath,
 *   headSha?: (cwd: string) => string|null,
 *   readState?: typeof readGateState,
 *   now?: () => string,
 * }} args
 * @returns {{ ok: true, entry: string, state: Record<string, unknown>, capturedVerifiedAt: string } | { ok: false, reason: string }}
 */
export function stampCaptureVerified({
  projectRoot,
  sessionId,
  featureId,
  taskId,
  sha,
  merge = mergeGateState,
  resolvePath = gateStatePath,
  resolveHandPath = handRecordPath,
  headSha = defaultHeadSha,
  readState = readGateState,
  now = () => new Date().toISOString(),
} = {}) {
  try {
    const req = requireTaskStampArgs({
      projectRoot,
      sessionId,
      featureId,
      taskId,
    });
    if (!req.ok) return req;

    const resolvedSha = resolveSha(sha, headSha, projectRoot);
    if (!resolvedSha) {
      return {
        ok: false,
        reason: "capture_verified requires resolved HEAD sha or explicit sha",
      };
    }

    const bare = fidelityPassEntry(featureId, taskId, null);
    const entry = fidelityPassEntry(featureId, taskId, resolvedSha);

    const gp = resolvePath({
      projectRoot,
      runtime: "opencode",
      sessionId,
    });
    if (!gp.ok) {
      return { ok: false, reason: gp.reason ?? "gateStatePath failed" };
    }

    const current = readState(gp.path);
    const finished = Array.isArray(current.hand_finished)
      ? current.hand_finished
      : [];
    if (!finished.includes(bare)) {
      return {
        ok: false,
        reason: "hand_finished does not contain feature/task",
      };
    }

    const hr = resolveHandPath(
      {
        projectRoot,
        runtime: "opencode",
        sessionId,
        featureId,
      },
      taskId,
    );
    if (!hr.ok) {
      return { ok: false, reason: hr.reason ?? "handRecordPath failed" };
    }

    let record;
    try {
      if (!fs.existsSync(hr.path)) {
        return { ok: false, reason: "hand-record file missing" };
      }
      const raw = fs.readFileSync(hr.path, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed == null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return { ok: false, reason: "hand-record unparseable" };
      }
      record = /** @type {Record<string, unknown>} */ (parsed);
    } catch {
      return { ok: false, reason: "hand-record unreadable" };
    }

    if (!isDoneHandRecord(record)) {
      return {
        ok: false,
        reason: "hand-record is not DONE (never stamp FAILED/NOT_DONE)",
      };
    }

    const capturedVerifiedAt = now();
    if (
      typeof capturedVerifiedAt !== "string" ||
      capturedVerifiedAt.length === 0
    ) {
      return { ok: false, reason: "capturedVerifiedAt must be non-empty ISO" };
    }

    // Durable stamp first (idempotent overwrite), then gate array — never invent file.
    try {
      const mergedRecord = { ...record, capturedVerifiedAt };
      const dir = path.dirname(hr.path);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${hr.path}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(mergedRecord, null, 2), "utf8");
      fs.renameSync(tmpPath, hr.path);
    } catch (err) {
      return {
        ok: false,
        reason:
          err instanceof Error
            ? err.message
            : "hand-record capturedVerifiedAt write failed",
      };
    }

    const merged = merge(gp.path, { capture_verified: [entry] });
    if (!merged.ok) {
      return {
        ok: false,
        reason: merged.reason ?? "mergeGateState failed",
      };
    }

    const cv = Array.isArray(merged.state?.capture_verified)
      ? merged.state.capture_verified
      : [];
    if (!cv.includes(entry)) {
      return { ok: false, reason: "capture_verified read-back failed" };
    }

    return {
      ok: true,
      entry,
      state: merged.state,
      capturedVerifiedAt,
    };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error ? err.message : "stampCaptureVerified failed",
    };
  }
}

// CLI: node mark-gate.mjs <brainstormed|adversary_fired|fidelity|dual|regate-pending|regate-passed|hand-finished|capture-verified> ...
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("mark-gate.mjs") ||
    process.argv[1].endsWith("mark-gate"));

if (isMain) {
  const [, , action, ...rest] = process.argv;
  const args = Object.fromEntries(
    rest
      .map((a, i, arr) =>
        a.startsWith("--") ? [a.slice(2), arr[i + 1]] : null,
      )
      .filter(Boolean),
  );
  const projectRoot = args.root || process.cwd();
  const sessionId = args.session || args.sessionId || "";
  const featureId = args.feature || args.featureId || "";
  const taskId = args.task || args.taskId || "";
  const shaArg =
    args.sha === undefined ? undefined : args.sha === "" ? null : args.sha;
  let result;
  if (action === "brainstormed") {
    result = stampBrainstormed({ projectRoot, sessionId });
  } else if (action === "adversary_fired") {
    result = stampAdversaryFired({ projectRoot, sessionId });
  } else if (action === "fidelity") {
    result = stampFidelityPass({
      projectRoot,
      sessionId,
      featureId,
      taskId,
      sha: shaArg ?? null,
    });
  } else if (action === "dual") {
    result = stampDualStatus({
      projectRoot,
      sessionId,
      dualStatus: args.status || args.dualStatus || "",
    });
  } else if (action === "regate-pending") {
    result = stampRegatePending({
      projectRoot,
      sessionId,
      featureId,
      taskId,
    });
  } else if (action === "regate-passed") {
    result = stampRegatePassed({
      projectRoot,
      sessionId,
      featureId,
      taskId,
      sha: shaArg,
    });
  } else if (action === "hand-finished") {
    result = stampHandFinished({
      projectRoot,
      sessionId,
      featureId,
      taskId,
    });
  } else if (action === "capture-verified") {
    result = stampCaptureVerified({
      projectRoot,
      sessionId,
      featureId,
      taskId,
      sha: shaArg,
    });
  } else {
    console.error(
      "usage: mark-gate.mjs brainstormed|adversary_fired|fidelity|dual|regate-pending|regate-passed|hand-finished|capture-verified --session <id> [--root <dir>] ...",
    );
    process.exit(2);
  }
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
