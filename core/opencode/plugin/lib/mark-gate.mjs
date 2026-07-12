/**
 * @description OC gate markers — stamp ceremony + fidelity via mergeGateState.
 * stampBrainstormed / stampAdversaryFired / stampDualStatus / stampFidelityPass.
 * dual_status only via dualStatusGatePatch (enum). CLI: node mark-gate.mjs <action> ...
 * Never throws.
 */
import { spawnSync } from "node:child_process";
import { mergeGateState } from "./gate-state.mjs";
import { gateStatePath } from "../../../shared/lib/path-helpers.mjs";
import { dualStatusGatePatch } from "./dual-enforcement.mjs";

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

// CLI: node mark-gate.mjs <brainstormed|adversary_fired|fidelity|dual> ...
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
  let result;
  if (action === "brainstormed") {
    result = stampBrainstormed({ projectRoot, sessionId });
  } else if (action === "adversary_fired") {
    result = stampAdversaryFired({ projectRoot, sessionId });
  } else if (action === "fidelity") {
    result = stampFidelityPass({
      projectRoot,
      sessionId,
      featureId: args.feature || args.featureId || "",
      taskId: args.task || args.taskId || "",
      sha: args.sha ?? null,
    });
  } else if (action === "dual") {
    result = stampDualStatus({
      projectRoot,
      sessionId,
      dualStatus: args.status || args.dualStatus || "",
    });
  } else {
    console.error(
      "usage: mark-gate.mjs brainstormed|adversary_fired|fidelity|dual --session <id> [--root <dir>] ...",
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
