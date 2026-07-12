/**
 * @description OC gate markers — stamp fidelity_pass (and future marks) via mergeGateState.
 * Orchestrator calls stampFidelityPass after compliance fidelity PASS, before executor spawn.
 * Never throws.
 */
import { spawnSync } from "node:child_process";
import { mergeGateState } from "./gate-state.mjs";
import { gateStatePath } from "../../../shared/lib/path-helpers.mjs";

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
