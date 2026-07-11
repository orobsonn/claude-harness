/** @description Pure capture-oracle for cheap hands: scope/frozen/allowed-write checks, closed outcome enum, evaluateRun. Never throws. Adapters inject git/test IO. */

/**
 * Closed outcome set (03 + 06). Adapters map CONFIG_ERROR / CAPTURE_ERROR;
 * evaluateRun produces DONE | FAILED | NOT_DONE from independent capture evidence.
 */
export const OUTCOME = Object.freeze({
  DONE: "DONE",
  FAILED: "FAILED",
  NOT_DONE: "NOT_DONE",
  CONFIG_ERROR: "CONFIG_ERROR",
  CAPTURE_ERROR: "CAPTURE_ERROR",
});

/** @type {ReadonlySet<string>} */
export const OUTCOME_VALUES = new Set(Object.values(OUTCOME));

/**
 * Exact harness-internal cache paths (both runtimes). Exact equality only — never prefix.
 * @type {readonly string[]}
 */
const HARNESS_INTERNAL_PATHS = Object.freeze([
  ".claude/.harness-version-check-cache",
  ".claude/.harness-version-check-cache.tmp",
  ".opencode/.harness-version-check-cache",
  ".opencode/.harness-version-check-cache.tmp",
]);

/**
 * @description Path covered by allow entry (git-pathspec component boundary).
 * @param {string} path
 * @param {string[]} allowEntries
 * @returns {boolean}
 */
function isPathCovered(path, allowEntries) {
  if (typeof path !== "string" || !Array.isArray(allowEntries)) return false;
  return allowEntries.some((entry) => {
    if (typeof entry !== "string") return false;
    const base = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (!base) return false;
    return path === base || path.startsWith(`${base}/`);
  });
}

/**
 * @param {string[]} [touchedPaths]
 * @param {string[]} [scopePaths]
 * @returns {string[]}
 */
export function checkScope(touchedPaths = [], scopePaths = []) {
  if (!Array.isArray(touchedPaths)) return [];
  if (!Array.isArray(scopePaths)) return [...touchedPaths];
  return touchedPaths.filter((p) => typeof p === "string" && !isPathCovered(p, scopePaths));
}

/**
 * @param {string[]} [touchedPaths]
 * @param {string[]} [frozenPaths]
 * @returns {string[]}
 */
export function checkFrozen(touchedPaths = [], frozenPaths = []) {
  if (!Array.isArray(touchedPaths) || !Array.isArray(frozenPaths)) return [];
  return touchedPaths.filter((p) => typeof p === "string" && isPathCovered(p, frozenPaths));
}

/**
 * @param {string[]} [touchedPaths]
 * @param {string[]} [allowedWrites]
 * @returns {string[]}
 */
export function checkAllowedWrites(touchedPaths = [], allowedWrites = []) {
  if (!Array.isArray(touchedPaths)) return [];
  if (!Array.isArray(allowedWrites)) return touchedPaths.filter((p) => typeof p === "string");
  return touchedPaths.filter((p) => typeof p === "string" && !isPathCovered(p, allowedWrites));
}

/**
 * @param {unknown} path
 * @returns {boolean}
 */
export function isHarnessInternalPath(path) {
  return typeof path === "string" && HARNESS_INTERNAL_PATHS.includes(path);
}

/**
 * @param {string[]} [paths]
 * @returns {string[]}
 */
export function excludeHarnessInternal(paths = []) {
  if (!Array.isArray(paths)) return [];
  return paths.filter((p) => !isHarnessInternalPath(p));
}

/**
 * @description Parse last `# tests N` line from node --test stdout. Returns null if absent.
 * @param {string} [stdout]
 * @returns {number|null}
 */
export function parseTestsCount(stdout = "") {
  try {
    const matches = [...String(stdout).matchAll(/^# tests (\d+)$/gm)];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  } catch {
    return null;
  }
}

/**
 * @description Drop pre-existing untracked paths whose content hash is unchanged.
 * @param {string[]} paths
 * @param {Map<string, string>|Record<string, string>|null|undefined} preUntracked
 * @param {Map<string, string>|Record<string, string>|null|undefined} currentHashes
 * @returns {string[]}
 */
export function subtractUnchanged(paths, preUntracked, currentHashes) {
  if (!Array.isArray(paths)) return [];
  const pre =
    preUntracked instanceof Map
      ? preUntracked
      : preUntracked && typeof preUntracked === "object"
        ? new Map(Object.entries(preUntracked))
        : null;
  if (!pre || pre.size === 0) return paths.filter((p) => typeof p === "string");

  const cur =
    currentHashes instanceof Map
      ? currentHashes
      : currentHashes && typeof currentHashes === "object"
        ? new Map(Object.entries(currentHashes))
        : new Map();

  return paths.filter((p) => {
    if (typeof p !== "string") return false;
    const preHash = pre.get(p);
    if (preHash === undefined) return true;
    return cur.get(p) !== preHash;
  });
}

/**
 * @description Decide run outcome from independent capture evidence — never prose, never exit-code alone.
 * Returns `{ ok:true, outcome, details }` or `{ ok:false, reason }`. Never throws.
 *
 * @param {{
 *   dispatch?: {
 *     scope_paths?: string[],
 *     frozen_paths?: string[],
 *     allowed_writes?: string[],
 *     no_tests?: boolean,
 *   },
 *   child?: {
 *     captured?: boolean,
 *     source?: string,
 *     touchedPaths?: string[],
 *     lockedTestExitCode?: number,
 *     testsCount?: number,
 *     exitCode?: number,
 *     stdout?: string,
 *     stderr?: string,
 *   },
 *   task?: { no_tests?: boolean },
 * }} [args]
 * @returns {{
 *   ok: true,
 *   outcome: string,
 *   details: {
 *     scopeViolations: string[],
 *     frozenViolations: string[],
 *     allowedWriteViolations: string[],
 *     reasons: string[],
 *   },
 * } | { ok: false, reason: string }}
 */
export function evaluateRun(args) {
  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { ok: false, reason: "invalid args" };
    }
    const dispatch = args.dispatch;
    const child = args.child;
    if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) {
      return { ok: false, reason: "invalid dispatch" };
    }
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      return { ok: false, reason: "invalid child" };
    }

    const noTests =
      args.task?.no_tests === true ||
      dispatch.no_tests === true ||
      child.no_tests === true;

    const reasons = [];

    // Fail closed: independent capture attestation required. Prose / exit-code-only never DONE.
    if (child.source === "model_prose" || child.captured !== true) {
      reasons.push(
        "untrusted child: touchedPaths/lockedTestExitCode must come from independent capture, not model prose or exit code"
      );
      return {
        ok: true,
        outcome: OUTCOME.NOT_DONE,
        details: {
          scopeViolations: [],
          frozenViolations: [],
          allowedWriteViolations: [],
          reasons,
        },
      };
    }

    const touched = excludeHarnessInternal(
      Array.isArray(child.touchedPaths) ? child.touchedPaths : []
    );

    const scopeViolations = checkScope(touched, dispatch.scope_paths ?? []);
    const frozenViolations = checkFrozen(touched, dispatch.frozen_paths ?? []);
    const allowedWriteViolations = checkAllowedWrites(
      touched,
      dispatch.allowed_writes ?? []
    );

    let outcome = OUTCOME.DONE;

    if (scopeViolations.length) {
      outcome = OUTCOME.FAILED;
      reasons.push(`scope violation: ${scopeViolations.join(", ")}`);
    } else if (frozenViolations.length) {
      outcome = OUTCOME.FAILED;
      reasons.push(`frozen-manifest violation: ${frozenViolations.join(", ")}`);
    } else if (allowedWriteViolations.length) {
      outcome = OUTCOME.FAILED;
      reasons.push(`allowed-write violation: ${allowedWriteViolations.join(", ")}`);
    } else if (touched.length === 0) {
      // Empty diff: prose-only / exit-code-only success is not acceptance
      outcome = OUTCOME.NOT_DONE;
      reasons.push("empty diff — prose-only or exit-code-only success is not acceptance");
    } else if (!noTests) {
      const lockedExit =
        typeof child.lockedTestExitCode === "number" ? child.lockedTestExitCode : 1;
      if (lockedExit !== 0) {
        outcome = OUTCOME.FAILED;
        reasons.push(`locked tests exited ${lockedExit}`);
      } else if (
        typeof child.testsCount === "number" &&
        child.testsCount === 0
      ) {
        // Vacuous green guard (adapter should already force non-zero exit; belt-and-suspenders)
        outcome = OUTCOME.FAILED;
        reasons.push("vacuous green: zero tests collected");
      }
    }
    // no_tests: skip test re-run requirement; scope + frozen + capture + non-empty touched suffice

    // Explicitly ignore child.exitCode for DONE — OC exit 0 is not success (probe).
    // Non-zero exit alone also does not override a green independent capture.

    return {
      ok: true,
      outcome,
      details: {
        scopeViolations,
        frozenViolations,
        allowedWriteViolations,
        reasons,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "evaluateRun failed",
    };
  }
}
