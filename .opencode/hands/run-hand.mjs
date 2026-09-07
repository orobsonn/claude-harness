/**
 * @description OpenCode cheap-hand adapter: spawn mode-all agents via `opencode run`,
 * independent capture (shared capture-oracle), worktree policy by outcome, session-scoped
 * run-records. DONE never from prose or process exit code. Plugins never read hand auth tokens.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  OUTCOME,
  evaluateRun,
  checkScope,
  checkFrozen,
  checkAllowedWrites,
  excludeHarnessInternal,
  parseTestsCount,
  subtractUnchanged,
} from "../shared/lib/capture-oracle.mjs";
import { gateStatePath } from "../shared/lib/path-helpers.mjs";
import { mergeGateState } from "../lib/gate-state.mjs";
import { hasFidelityPass } from "../lib/entry-decide.mjs";
import { claimDispatchForRuntime, removeDispatchRecord } from "../lib/dispatch-scope.mjs";
import { writeHandRecord } from "../lib/hand-records.mjs";

export { writeHandRecord };

/** Forced non-zero locked-test exit for vacuous-green guard. */
export const VACUOUS_GREEN_EXIT = 1;

/** Hand roles that may be CLI-spawned. */
export const SPAWNABLE_HAND_ROLES = Object.freeze([
  "executor-low",
  "executor-medium",
  "executor-high",
  "sniper-low",
  "sniper-medium",
  "sniper-high",
  "test-author",
]);

/**
 * @description Map a hand role to its shared in-session/CLI agent id.
 * @param {string} role
 * @returns {string}
 */
export function spawnAgentName(role) {
  return String(role ?? "");
}

/**
 * @description Parse agent markdown frontmatter block.
 * @param {string} md
 * @returns {string|null}
 */
export function extractFrontmatter(md) {
  const m = String(md ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

/**
 * @description Validate a CLI hand agent: refuse subagent mode and nested task dispatch.
 * Never throws.
 * @param {string} agentMd
 * @param {string} [agentName]
 * @returns {{ ok: true, agentName: string, model: string } | { ok: false, reason: string, outcome: string }}
 */
export function validateSpawnAgent(agentMd, agentName = "agent") {
  try {
    const fm = extractFrontmatter(agentMd);
    if (!fm) {
      return {
        ok: false,
        reason: `agent ${agentName}: missing frontmatter`,
        outcome: OUTCOME.CONFIG_ERROR,
      };
    }
    const modeM = fm.match(/^mode:\s*(.+)$/m);
    const mode = modeM ? modeM[1].trim().replace(/^["']|["']$/g, "") : "";
    if (mode === "subagent") {
      return {
        ok: false,
        reason: `agent ${agentName}: mode subagent refused for CLI spawn`,
        outcome: OUTCOME.CONFIG_ERROR,
      };
    }
    const modelM = fm.match(/^model:\s*(.+)$/m);
    const model = modelM ? modelM[1].trim().replace(/^["']|["']$/g, "") : "";
    if (!model) {
      return {
        ok: false,
        reason: `agent ${agentName}: model is required for CLI spawn`,
        outcome: OUTCOME.CONFIG_ERROR,
      };
    }
    // tools.task: false required
    const taskM = fm.match(/^tools:\s*\n((?:  .+\n?)*)/m);
    let taskVal;
    if (taskM) {
      const line = taskM[1].match(/^  task:\s*(.+)$/m);
      if (line) {
        const v = line[1].trim();
        if (v === "false") taskVal = false;
        else if (v === "true") taskVal = true;
        else taskVal = v;
      }
    }
    if (taskVal !== false) {
      return {
        ok: false,
        reason: `agent ${agentName}: tools.task must be false for hand spawn`,
        outcome: OUTCOME.CONFIG_ERROR,
      };
    }
    return { ok: true, agentName, model };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "validateSpawnAgent failed",
      outcome: OUTCOME.CONFIG_ERROR,
    };
  }
}

/**
 * @description Build argv for `opencode run` (token never in argv).
 * @param {{ projectDir: string, agent: string, model: string, title: string, prompt: string }} p
 * @returns {string[]}
 */
export function buildOpencodeRunArgs({ projectDir, agent, model, title, prompt }) {
  return [
    "run",
    "--dir",
    projectDir,
    "--agent",
    agent,
    "--model",
    model,
    "--auto",
    "--format",
    "json",
    "--title",
    title,
    prompt,
  ];
}

/**
 * @description Content hash (sha256 hex) of file bytes; null if unreadable.
 * @param {string} absPath
 * @param {{ readFileSync?: typeof readFileSync }} [fs]
 * @returns {string|null}
 */
export function hashFileContents(absPath, fs = { readFileSync }) {
  try {
    const buf = fs.readFileSync(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/**
 * @description Snapshot untracked paths + content hashes (pre-spawn).
 * Caller should pass all-others listing (`git ls-files --others`, no --exclude-standard)
 * so gitignored hand writes (e.g. .env) are included in cleanup set-diff.
 * @param {{
 *   lsUntracked: () => string[],
 *   projectRoot: string,
 *   hashFile?: (abs: string) => string|null,
 * }} deps
 * @returns {{ paths: Set<string>, contents: Map<string, { hash: string, bytes: Buffer|null }> }}
 */
export function snapshotPreUntracked({
  lsUntracked,
  projectRoot,
  hashFile = (abs) => hashFileContents(abs),
  readFile = (abs) => {
    try {
      return readFileSync(abs);
    } catch {
      return null;
    }
  },
}) {
  const paths = new Set(lsUntracked() ?? []);
  /** @type {Map<string, { hash: string, bytes: Buffer|null }>} */
  const contents = new Map();
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : join(projectRoot, p);
    const hash = hashFile(abs);
    const bytes = readFile(abs);
    if (hash) contents.set(p, { hash, bytes });
  }
  return { paths, contents };
}

/**
 * @description Qualified feature+task key for gate-state hand_quarantine marker.
 * @param {string} featureId
 * @param {string} taskId
 * @returns {string}
 */
export function quarantineMarkerKey(featureId, taskId) {
  return `${featureId}/${taskId}`;
}

/**
 * @description True when gate-state marks this feature+task as hand_quarantine.
 * @param {unknown} state
 * @param {string} featureId
 * @param {string} taskId
 * @returns {boolean}
 */
export function isQuarantinedInGateState(state, featureId, taskId) {
  try {
    if (!state || typeof state !== "object" || Array.isArray(state)) return false;
    const key = quarantineMarkerKey(featureId, taskId);
    const s = /** @type {Record<string, unknown>} */ (state);
    const q = s.hand_quarantine;
    if (Array.isArray(q)) {
      return q.includes(key) || q.includes(taskId);
    }
    if (q && typeof q === "object") {
      return Boolean(/** @type {Record<string, unknown>} */ (q)[key]);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * @description Read gate-state and check hand_quarantine for feature+task. Never throws.
 * @param {{ projectRoot: string, sessionId: string, featureId: string, taskId: string }} args
 * @returns {boolean}
 */
export function defaultIsHandQuarantined({ projectRoot, sessionId, featureId, taskId }) {
  try {
    const gp = gateStatePath({
      projectRoot,
      runtime: "opencode",
      sessionId,
    });
    if (!gp.ok || !existsSync(gp.path)) return false;
    const raw = readFileSync(gp.path, "utf8");
    const state = JSON.parse(raw);
    return isQuarantinedInGateState(state, featureId, taskId);
  } catch {
    return false;
  }
}

/**
 * @description True when role is an executor tier (requires fidelity-pass before spawn).
 * test-author and sniper are not executors.
 * @param {unknown} role
 * @returns {boolean}
 */
export function isExecutorHandRole(role) {
  const bare = String(role ?? "").replace(/-spawn$/, "");
  return bare === "executor" || bare.startsWith("executor-");
}

/**
 * @description Read gate-state fidelity_pass for feature+task. Fail-closed (false) on missing/error.
 * @param {{ projectRoot: string, sessionId: string, featureId: string, taskId: string }} args
 * @returns {boolean}
 */
export function defaultHasFidelityPass({ projectRoot, sessionId, featureId, taskId }) {
  try {
    const gp = gateStatePath({
      projectRoot,
      runtime: "opencode",
      sessionId,
    });
    if (!gp.ok || !existsSync(gp.path)) return false;
    const raw = readFileSync(gp.path, "utf8");
    const state = JSON.parse(raw);
    const s =
      state && typeof state === "object" && !Array.isArray(state)
        ? /** @type {Record<string, unknown>} */ (state)
        : {};
    return hasFidelityPass(s.fidelity_pass, featureId, taskId);
  } catch {
    return false;
  }
}

/**
 * @description Append hand_quarantine marker for feature+task in gate-state. Never throws.
 * @param {{ projectRoot: string, sessionId: string, featureId: string, taskId: string }} args
 * @returns {{ ok: boolean, reason?: string }}
 */
export function defaultMarkHandQuarantine({ projectRoot, sessionId, featureId, taskId }) {
  try {
    const gp = gateStatePath({
      projectRoot,
      runtime: "opencode",
      sessionId,
    });
    if (!gp.ok) return { ok: false, reason: gp.reason };
    const key = quarantineMarkerKey(featureId, taskId);
    const merged = mergeGateState(gp.path, { hand_quarantine: [key] });
    if (!merged.ok) {
      return { ok: false, reason: merged.reason ?? "mergeGateState failed" };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "defaultMarkHandQuarantine failed",
    };
  }
}

/**
 * @description Default all-others untracked listing (no --exclude-standard) so gitignored
 * hand-created files (.env, dist/, etc.) enter cleanup set-diff. Filters node_modules/.
 * @param {string} projectRoot
 * @returns {string[]}
 */
export function defaultLsAllOthers(projectRoot) {
  try {
    const r = spawnSync("git", ["ls-files", "--others"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    return (r.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((p) => !p.startsWith("node_modules/"));
  } catch {
    return [];
  }
}

/**
 * @description Worktree cleanup after non-DONE: reset hard + set-diff untracked + restore pre contents.
 * `lsUntracked` must be all-others (`git ls-files --others`, no --exclude-standard) so gitignored
 * hand-created files (e.g. .env) are deleted. Never throws — returns success flag; on failure
 * caller sets hand_quarantine.
 *
 * @param {{
 *   freezeCommitSha: string,
 *   preUntracked: Set<string>,
 *   preUntrackedContents: Map<string, { hash: string, bytes: Buffer|null }>,
 *   projectRoot: string,
 *   gitResetHard: (sha: string) => { ok: boolean, reason?: string },
 *   lsUntracked: () => string[],
 *   removePath: (rel: string) => { ok: boolean, reason?: string },
 *   writePath: (rel: string, bytes: Buffer) => { ok: boolean, reason?: string },
 *   hashFile?: (abs: string) => string|null,
 * }} args
 * @returns {{ ok: true } | { ok: false, reason: string, hand_quarantine: true }}
 */
export function cleanupWorktreeAfterNonDone({
  freezeCommitSha,
  preUntracked,
  preUntrackedContents,
  projectRoot,
  gitResetHard,
  lsUntracked,
  removePath,
  writePath,
  hashFile = (abs) => hashFileContents(abs),
}) {
  try {
    const reset = gitResetHard(freezeCommitSha);
    if (!reset.ok) {
      return {
        ok: false,
        reason: reset.reason ?? "git reset --hard failed",
        hand_quarantine: true,
      };
    }

    // all-others listing (caller supplies no --exclude-standard) so .env etc. are visible
    const post = new Set(lsUntracked() ?? []);
    const pre = preUntracked instanceof Set ? preUntracked : new Set(preUntracked ?? []);

    // Delete hand-created untracked (post - pre), including gitignored and outside scope_paths
    for (const p of post) {
      if (!pre.has(p)) {
        const del = removePath(p);
        if (!del.ok) {
          return {
            ok: false,
            reason: del.reason ?? `failed to delete hand-created untracked ${p}`,
            hand_quarantine: true,
          };
        }
      }
    }

    // Restore pre-existing untracked contents
    const contents =
      preUntrackedContents instanceof Map
        ? preUntrackedContents
        : new Map(Object.entries(preUntrackedContents ?? {}));

    for (const [p, snap] of contents) {
      const abs = isAbsolute(p) ? p : join(projectRoot, p);
      const curHash = hashFile(abs);
      const needRestore =
        curHash === null || // missing (hand deleted) or unreadable
        (snap && snap.hash && curHash !== snap.hash);
      if (needRestore) {
        if (!snap?.bytes) {
          return {
            ok: false,
            reason: `cannot restore preUntracked ${p}: no snapshot bytes`,
            hand_quarantine: true,
          };
        }
        const w = writePath(p, snap.bytes);
        if (!w.ok) {
          return {
            ok: false,
            reason: w.reason ?? `failed to restore ${p}`,
            hand_quarantine: true,
          };
        }
      }
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "cleanupWorktreeAfterNonDone failed",
      hand_quarantine: true,
    };
  }
}

/**
 * @description Apply worktree policy table (06 §4b) for a closed outcome.
 * @param {string} outcome
 * @param {object} ctx cleanup args + isDirtyVsFreeze
 * @returns {{
 *   kept: boolean,
 *   cleaned: boolean,
 *   hand_quarantine: boolean,
 *   reason?: string,
 * }}
 */
export function applyWorktreePolicy(outcome, ctx) {
  if (outcome === OUTCOME.DONE) {
    return { kept: true, cleaned: false, hand_quarantine: false };
  }

  if (
    outcome === OUTCOME.FAILED ||
    outcome === OUTCOME.NOT_DONE ||
    outcome === OUTCOME.CONFIG_ERROR
  ) {
    // CONFIG_ERROR: reset if dirty vs freeze; FAILED/NOT_DONE always reset
    if (outcome === OUTCOME.CONFIG_ERROR && ctx.isDirtyVsFreeze && !ctx.isDirtyVsFreeze()) {
      return { kept: false, cleaned: false, hand_quarantine: false };
    }
    const cleaned = cleanupWorktreeAfterNonDone(ctx);
    if (!cleaned.ok) {
      return {
        kept: false,
        cleaned: false,
        hand_quarantine: true,
        reason: cleaned.reason,
      };
    }
    return { kept: false, cleaned: true, hand_quarantine: false };
  }

  if (outcome === OUTCOME.CAPTURE_ERROR) {
    // Quarantine: reset if possible else hand_quarantine
    const cleaned = cleanupWorktreeAfterNonDone(ctx);
    if (!cleaned.ok) {
      return {
        kept: false,
        cleaned: false,
        hand_quarantine: true,
        reason: cleaned.reason,
      };
    }
    return { kept: false, cleaned: true, hand_quarantine: false };
  }

  // Unknown outcome → fail closed quarantine attempt
  const cleaned = cleanupWorktreeAfterNonDone(ctx);
  return {
    kept: false,
    cleaned: cleaned.ok,
    hand_quarantine: !cleaned.ok,
    reason: cleaned.ok ? `unknown outcome ${outcome}` : cleaned.reason,
  };
}

/**
 * @description Independent capture: git snapshot + optional test re-run → evaluateRun.
 * Never trusts prose or exit code alone.
 *
 * @param {{
 *   dispatch: object,
 *   child: { exitCode?: number, stdout?: string, stderr?: string },
 *   freezeCommitSha: string,
 *   testPath?: string|null,
 *   no_tests?: boolean,
 *   git: {
 *     headSha: () => string,
 *     diffNameOnly: (sha: string) => string[],
 *     lsFilesOthers: () => string[],
 *     lsFilesAllOthers?: () => string[],
 *     hashObject?: (paths: string[]) => Map<string, string>,
 *   },
 *   testRunner?: (testPath: string) => { stdout: string, stderr?: string, exitCode: number },
 *   preUntrackedHashes?: Map<string, string>,
 *   parseCount?: (stdout: string) => number|null,
 * }} args
 * @returns {{
 *   ok: true,
 *   outcome: string,
 *   details: object,
 *   child: object,
 *   criticalException?: boolean,
 *   reason?: string,
 * } | {
 *   ok: false,
 *   outcome: string,
 *   reason: string,
 *   criticalException?: boolean,
 * }}
 */
export function captureHandResult({
  dispatch,
  child,
  freezeCommitSha,
  testPath = null,
  no_tests = false,
  git,
  testRunner,
  preUntrackedHashes = new Map(),
  parseCount = parseTestsCount,
}) {
  try {
    if (!git || typeof git.headSha !== "function") {
      return {
        ok: false,
        outcome: OUTCOME.CAPTURE_ERROR,
        reason: "git adapter missing headSha",
      };
    }
    const headSha = git.headSha();
    if (headSha !== freezeCommitSha) {
      return {
        ok: false,
        outcome: OUTCOME.CAPTURE_ERROR,
        criticalException: true,
        reason: `HEAD ${headSha} diverged from freeze baseline ${freezeCommitSha}`,
      };
    }

    const diffPaths = git.diffNameOnly(freezeCommitSha) ?? [];
    const rawUntracked = git.lsFilesOthers() ?? [];
    const rawAllOthers =
      typeof git.lsFilesAllOthers === "function"
        ? git.lsFilesAllOthers() ?? []
        : rawUntracked;

    const currentHashes =
      preUntrackedHashes.size && typeof git.hashObject === "function"
        ? git.hashObject([...new Set([...rawUntracked, ...rawAllOthers])])
        : new Map();

    const untrackedPaths = subtractUnchanged(
      rawUntracked,
      preUntrackedHashes,
      currentHashes
    );
    let touchedPaths = [...new Set([...diffPaths, ...untrackedPaths])];

    const allOthers = subtractUnchanged(rawAllOthers, preUntrackedHashes, currentHashes);
    const flagged = new Set([
      ...checkScope(allOthers, dispatch.scope_paths ?? []),
      ...checkFrozen(allOthers, dispatch.frozen_paths ?? []),
      ...checkAllowedWrites(allOthers, dispatch.allowed_writes ?? []),
    ]);
    for (const p of flagged) {
      if (!touchedPaths.includes(p)) touchedPaths.push(p);
    }
    touchedPaths = excludeHarnessInternal(touchedPaths);

    let lockedTestExitCode = 0;
    let testsCount = 0;
    let testStdout = "";
    let testStderr = "";

    if (!no_tests) {
      if (!testPath || typeof testRunner !== "function") {
        return {
          ok: false,
          outcome: OUTCOME.CAPTURE_ERROR,
          reason: "testPath and testRunner required when no_tests is false",
        };
      }
      let runner;
      try {
        runner = testRunner(testPath);
      } catch (err) {
        return {
          ok: false,
          outcome: OUTCOME.CAPTURE_ERROR,
          reason: err instanceof Error ? err.message : "testRunner failed",
        };
      }
      testStdout = runner.stdout ?? "";
      testStderr = runner.stderr ?? "";
      const count = parseCount(testStdout);
      testsCount = count ?? 0;
      lockedTestExitCode =
        count === null || count === 0 ? VACUOUS_GREEN_EXIT : runner.exitCode;
    }

    const built = {
      captured: true,
      touchedPaths,
      lockedTestExitCode,
      testsCount,
      exitCode: child?.exitCode ?? 0,
      stdout: child?.stdout ?? "",
      stderr: child?.stderr ?? "",
      testStdout,
      testStderr,
      no_tests: no_tests === true,
    };

    const judged = evaluateRun({
      dispatch: { ...dispatch, no_tests: no_tests === true },
      child: built,
      task: { no_tests: no_tests === true },
    });

    if (!judged.ok) {
      return {
        ok: false,
        outcome: OUTCOME.CAPTURE_ERROR,
        reason: judged.reason,
      };
    }

    return {
      ok: true,
      outcome: judged.outcome,
      details: judged.details,
      child: built,
    };
  } catch (err) {
    return {
      ok: false,
      outcome: OUTCOME.CAPTURE_ERROR,
      reason: err instanceof Error ? err.message : "captureHandResult failed",
    };
  }
}

/**
 * @description Build on-disk run-record fields (adapter-written, not model prose).
 * @param {object} p
 * @returns {object}
 */
export function buildHandRunRecord({
  featureId,
  taskId,
  sessionId,
  freezeCommitSha,
  outcome,
  touchedPaths = [],
  details = {},
  agent,
  timestamps = {},
  hand_quarantine = false,
  worktree = {},
  producerCallId,
}) {
  const now = timestamps.finishedAt ?? new Date().toISOString();
  return {
    featureId,
    taskId,
    sessionId,
    ...(typeof producerCallId === "string" && producerCallId ? { producerCallId } : {}),
    freezeCommitSha,
    outcome,
    touchedPaths,
    scopeViolations: details.scopeViolations ?? [],
    frozenViolations: details.frozenViolations ?? [],
    allowedWriteViolations: details.allowedWriteViolations ?? [],
    reasons: details.reasons ?? [],
    agent,
    hand_quarantine,
    worktree,
    startedAt: timestamps.startedAt ?? now,
    finishedAt: now,
    // Adapter attestation — never model prose
    writtenBy: "run-hand-adapter",
    // capturedVerifiedAt is set only by the host-bound native mark tool, never here
  };
}

/**
 * @description Load and validate a spawn agent file from agents dir.
 * @param {string} agentsDir
 * @param {string} agentName e.g. executor-high
 * @param {{ readFileSync?: typeof readFileSync, existsSync?: typeof existsSync }} [fs]
 */
export function loadAndValidateSpawnAgent(
  agentsDir,
  agentName,
  fs = { readFileSync, existsSync }
) {
  const path = join(agentsDir, `${agentName}.md`);
  if (!fs.existsSync(path)) {
    return {
      ok: false,
      reason: `agent file missing: ${path}`,
      outcome: OUTCOME.CONFIG_ERROR,
    };
  }
  let md;
  try {
    md = fs.readFileSync(path, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "read agent failed",
      outcome: OUTCOME.CONFIG_ERROR,
    };
  }
  return validateSpawnAgent(md, agentName);
}

/**
 * @description Full hand run orchestration with injectable seams (unit-testable).
 * Plugins never receive hand auth tokens — this adapter does not read OLLAMA/hand tokens.
 *
 * @param {object} descriptor
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
export async function runHand(descriptor, deps = {}) {
  const startedAt = new Date().toISOString();
  const {
    spawn = defaultSpawnOpencode,
    git = null,
    testRunner = null,
    agentsDir = null,
    readAgent = null,
    lsUntracked = null,
    gitResetHard = null,
    removePath = null,
    writePath = null,
    isDirtyVsFreeze = null,
    writeRecord = writeHandRecord,
    isHandQuarantined = null,
    markHandQuarantine = null,
    checkFidelityPass = null,
    now = () => new Date().toISOString(),
    dispatchCallId = () => `run-hand:${randomUUID()}`,
    finishDispatch = removeDispatchRecord,
    dispatchEnvironment = process.env,
    isReviewedShaAncestor = null,
  } = deps;

  const featureId = descriptor?.feature_id ?? descriptor?.featureId;
  const taskId = descriptor?.task_id ?? descriptor?.taskId;
  const sessionId = descriptor?.session_id ?? descriptor?.sessionId;
  const projectRoot = descriptor?.project_root ?? descriptor?.projectRoot ?? process.cwd();
  let freezeCommitSha = descriptor?.freeze_commit_sha ?? descriptor?.freezeCommitSha;
  const role = descriptor?.role ?? descriptor?.agent ?? "executor-medium";
  const agent = spawnAgentName(role);
  const no_tests = descriptor?.no_tests === true;
  const brief = descriptor?.brief ?? descriptor?.prompt ?? "";
  const title = `hand:${featureId}:${taskId}`;
  const resolvedAgentsDir = agentsDir ?? join(projectRoot, ".opencode", "agents");

  const checkQuarantine = () => {
    if (typeof isHandQuarantined === "function") {
      return isHandQuarantined({ featureId, taskId, sessionId, projectRoot });
    }
    return defaultIsHandQuarantined({ projectRoot, sessionId, featureId, taskId });
  };

  const writeQuarantineMarker = () => {
    if (typeof markHandQuarantine === "function") {
      return markHandQuarantine({ featureId, taskId, sessionId, projectRoot });
    }
    return defaultMarkHandQuarantine({ projectRoot, sessionId, featureId, taskId });
  };

  const failConfig = (reason, extra = {}) => {
    const outcome = OUTCOME.CONFIG_ERROR;
    const record = buildHandRunRecord({
      featureId,
      taskId,
      sessionId,
      freezeCommitSha,
      outcome,
      details: { reasons: [reason] },
      agent,
      timestamps: { startedAt, finishedAt: now() },
      ...extra,
    });
    let recordPath;
    if (featureId && taskId && sessionId) {
      const w = writeRecord({
        roots: {
          projectRoot,
          runtime: "opencode",
          sessionId,
          featureId,
        },
        taskId,
        record,
      });
      if (w.ok) recordPath = w.path;
    }
    // CONFIG_ERROR: reset if dirty
    let worktree = { cleaned: false, hand_quarantine: false };
    if (
      freezeCommitSha &&
      gitResetHard &&
      lsUntracked &&
      removePath &&
      writePath &&
      typeof isDirtyVsFreeze === "function" &&
      isDirtyVsFreeze()
    ) {
      const policy = applyWorktreePolicy(outcome, {
        freezeCommitSha,
        preUntracked: extra.preUntracked ?? new Set(),
        preUntrackedContents: extra.preUntrackedContents ?? new Map(),
        projectRoot,
        gitResetHard,
        lsUntracked,
        removePath,
        writePath,
        isDirtyVsFreeze,
      });
      worktree = policy;
      record.worktree = policy;
      record.hand_quarantine = policy.hand_quarantine;
      if (policy.hand_quarantine === true && featureId && taskId && sessionId) {
        writeQuarantineMarker();
      }
      if (recordPath) {
        writeRecord({
          roots: { projectRoot, runtime: "opencode", sessionId, featureId },
          taskId,
          record,
        });
      }
    }
    return {
      ok: false,
      outcome,
      reason,
      record,
      recordPath,
      worktree,
    };
  };

  if (!featureId || !taskId || !sessionId) {
    return failConfig("feature_id, task_id, and session_id are required");
  }
  if (!freezeCommitSha) {
    return failConfig("freeze_commit_sha is required");
  }
  if (!SPAWNABLE_HAND_ROLES.includes(role)) {
    return failConfig(`role ${role}: not a CLI-spawnable hand`);
  }

  // Deny spawn while gate-state hand_quarantine marker is set for this feature+task
  if (checkQuarantine()) {
    return failConfig(
      `hand_quarantine active for ${quarantineMarkerKey(featureId, taskId)} — deny spawn until orchestrator clears marker`,
    );
  }

  // Fidelity rail: executor-* blocked until fidelity_pass; test-author exempt (producer)
  if (isExecutorHandRole(role)) {
    const fidelityOk =
      typeof checkFidelityPass === "function"
        ? checkFidelityPass({ featureId, taskId, sessionId, projectRoot })
        : defaultHasFidelityPass({ projectRoot, sessionId, featureId, taskId });
    if (!fidelityOk) {
      return failConfig(
        `fidelity-pass missing for ${quarantineMarkerKey(featureId, taskId)} — dispatch test-author + compliance fidelity PASS and stamp before executor spawn`,
      );
    }
  }

  // The vendored frontmatter is authoritative for both lockdown and the CLI model override.
  let validation;
  if (readAgent) {
    const md = readAgent(agent);
    if (md == null) {
      return failConfig(`agent ${agent} not found`);
    }
    validation = validateSpawnAgent(md, agent);
  } else {
    validation = loadAndValidateSpawnAgent(resolvedAgentsDir, agent);
  }
  if (!validation.ok) {
    return failConfig(validation.reason);
  }
  const handModel = validation.model;

  // Pre-spawn snapshot: all-others (no --exclude-standard) so gitignored hand writes
  // (.env etc.) are in the set-diff and deleted on non-DONE cleanup.
  const ls = lsUntracked ?? (() => defaultLsAllOthers(projectRoot));

  const preSnap = snapshotPreUntracked({
    lsUntracked: ls,
    projectRoot,
  });
  const preUntrackedHashes = new Map(
    [...preSnap.contents.entries()].map(([p, v]) => [p, v.hash])
  );

  const callId = dispatchCallId();
  const claimed = claimDispatchForRuntime(projectRoot, {
    sessionId,
    callId,
    role,
    taskId,
    featureId,
  }, {
    env: dispatchEnvironment,
    isAncestorFn: isReviewedShaAncestor ?? ((sha) => {
      try {
        const status = spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
          cwd: projectRoot,
          stdio: "ignore",
        }).status;
        return status === 0 ? true : status === 1 ? false : null;
      } catch { return null; }
    }),
  });
  if (!claimed.ok) {
    return failConfig(`dispatch record claim failed: ${claimed.reason}`, {
      preUntracked: preSnap.paths,
      preUntrackedContents: preSnap.contents,
    });
  }
  if (typeof claimed.reviewedSha === "string" && freezeCommitSha !== claimed.reviewedSha) {
    const suppliedFreezeCommitSha = freezeCommitSha;
    freezeCommitSha = claimed.reviewedSha;
    const finished = finishDispatch(projectRoot, { sessionId, callId });
    return failConfig(
      finished.ok
        ? `descriptor freeze sha conflicts with fix-mode authority: ${suppliedFreezeCommitSha}`
        : `descriptor freeze sha conflicts with fix-mode authority and ${finished.reason}`,
      { preUntracked: preSnap.paths, preUntrackedContents: preSnap.contents },
    );
  }
  const dispatchScope = claimed.claim;

  // Spawn subprocess (injectable)
  let child;
  try {
    child = await spawn({
      projectDir: projectRoot,
      agent,
      model: handModel,
      title,
      prompt: brief,
      descriptor,
      dispatchAuthority: {
        sessionId,
        callId,
      },
    });
  } catch (err) {
    const finished = finishDispatch(projectRoot, { sessionId, callId });
    if (!finished.ok) {
      return failConfig(`spawn failed and ${finished.reason}`, {
        preUntracked: preSnap.paths,
        preUntrackedContents: preSnap.contents,
      });
    }
    return failConfig(err instanceof Error ? err.message : "spawn failed", {
      preUntracked: preSnap.paths,
      preUntrackedContents: preSnap.contents,
    });
  }
  // Capture
  const gitAdapter =
    git ??
    realGit(projectRoot);

  const capture = captureHandResult({
    dispatch: {
      scope_paths: dispatchScope.scope_paths,
      frozen_paths: descriptor.frozen_paths ?? [],
      allowed_writes: dispatchScope.allowed_writes.length > 0 ? dispatchScope.allowed_writes : dispatchScope.scope_paths,
      no_tests,
    },
    child: {
      exitCode: child?.exitCode ?? 0,
      stdout: child?.stdout ?? "",
      stderr: child?.stderr ?? "",
    },
    freezeCommitSha,
    testPath: descriptor.locked_test ?? descriptor.test_path ?? null,
    no_tests,
    git: gitAdapter,
    testRunner:
      testRunner ??
      ((p) => realTestRunner(p, projectRoot)),
    preUntrackedHashes,
  });

  let outcome = capture.ok ? capture.outcome : capture.outcome ?? OUTCOME.CAPTURE_ERROR;
  let details = capture.ok ? capture.details : { reasons: [capture.reason] };
  let touchedPaths = capture.ok ? capture.child?.touchedPaths ?? [] : [];

  // Worktree policy
  const resetHard =
    gitResetHard ??
    ((sha) => {
      try {
        const r = spawnSync("git", ["reset", "--hard", sha], {
          cwd: projectRoot,
          encoding: "utf8",
        });
        return r.status === 0
          ? { ok: true }
          : { ok: false, reason: r.stderr || "reset failed" };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : "reset failed",
        };
      }
    });

  const rem =
    removePath ??
    ((rel) => {
      try {
        const abs = isAbsolute(rel) ? rel : join(projectRoot, rel);
        rmSync(abs, { recursive: true, force: true });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : "remove failed",
        };
      }
    });

  const wr =
    writePath ??
    ((rel, bytes) => {
      try {
        const abs = isAbsolute(rel) ? rel : join(projectRoot, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : "write failed",
        };
      }
    });

  const dirtyFn =
    isDirtyVsFreeze ??
    (() => {
      try {
        const r = spawnSync("git", ["status", "--porcelain"], {
          cwd: projectRoot,
          encoding: "utf8",
        });
        return (r.stdout ?? "").trim().length > 0;
      } catch {
        return true;
      }
    });

  const worktree = applyWorktreePolicy(outcome, {
    freezeCommitSha,
    preUntracked: preSnap.paths,
    preUntrackedContents: preSnap.contents,
    projectRoot,
    gitResetHard: resetHard,
    lsUntracked: ls,
    removePath: rem,
    writePath: wr,
    isDirtyVsFreeze: dirtyFn,
  });

  if (worktree.hand_quarantine) {
    // Persist gate-state marker so subsequent runHand for this feature+task is denied
    writeQuarantineMarker();
  }

  const record = buildHandRunRecord({
    featureId,
    taskId,
    sessionId,
    freezeCommitSha,
    outcome,
    touchedPaths,
    details,
    agent,
    timestamps: { startedAt, finishedAt: now() },
    hand_quarantine: worktree.hand_quarantine === true,
    worktree,
    producerCallId: callId,
  });

  const written = writeRecord({
    roots: {
      projectRoot,
      runtime: "opencode",
      sessionId,
      featureId,
    },
    taskId,
    record,
  });

  if (outcome !== OUTCOME.DONE || !written.ok) {
    const finished = finishDispatch(projectRoot, { sessionId, callId });
    if (!finished.ok) {
      return failConfig(finished.reason, {
        preUntracked: preSnap.paths,
        preUntrackedContents: preSnap.contents,
      });
    }
  }

  return {
    ok: outcome === OUTCOME.DONE,
    outcome,
    details,
    child: capture.ok ? capture.child : null,
    record,
    recordPath: written.ok ? written.path : null,
    recordWriteError: written.ok ? null : written.reason,
    worktree,
    // Explicit: process exit code is NOT the oracle
    processExitCode: child?.exitCode,
  };
}

/**
 * @param {string} cwd
 */
export function realGit(cwd = process.cwd()) {
  const run = (args) =>
    spawnSync("git", args, { cwd, encoding: "utf8" });
  const lines = (out) =>
    String(out ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  return {
    headSha: () => (run(["rev-parse", "HEAD"]).stdout ?? "").trim(),
    diffNameOnly: (sha) => lines(run(["diff", "--name-only", sha]).stdout),
    lsFilesOthers: () =>
      lines(run(["ls-files", "--others", "--exclude-standard"]).stdout),
    lsFilesAllOthers: () =>
      lines(run(["ls-files", "--others"]).stdout).filter(
        (p) => !p.startsWith("node_modules/")
      ),
    hashObject: (paths) => {
      const map = new Map();
      if (!paths?.length) return map;
      const r = run(["hash-object", ...paths]);
      if (r.status !== 0) return map;
      const shas = lines(r.stdout);
      paths.forEach((p, i) => {
        if (shas[i]) map.set(p, shas[i]);
      });
      return map;
    },
  };
}

/**
 * @param {string} testPath
 * @param {string} [cwd]
 */
export function realTestRunner(testPath, cwd = process.cwd()) {
  const abs = isAbsolute(testPath) ? testPath : resolve(cwd, testPath);
  const r = spawnSync(process.execPath, ["--test", abs], {
    cwd,
    encoding: "utf8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: typeof r.status === "number" ? r.status : 1,
  };
}

/**
 * @description Default spawn: opencode run (not exercised by unit tests).
 */
function defaultSpawnOpencode({ projectDir, agent, model, title, prompt, dispatchAuthority }) {
  const args = buildOpencodeRunArgs({ projectDir, agent, model, title, prompt });
  const r = spawnSync("opencode", args, {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      HARNESS_DISPATCH_PARENT_SESSION_ID: dispatchAuthority?.sessionId ?? "",
      HARNESS_DISPATCH_CALL_ID: dispatchAuthority?.callId ?? "",
    },
  });
  return {
    exitCode: typeof r.status === "number" ? r.status : 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

export { OUTCOME };
