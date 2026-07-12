#!/usr/bin/env node
/**
 * @description VPS cron harness — Cron A COMPOSITION ROOT (task-9 glue-3). A crontab invokes
 * this file directly: `node core/vps/run-cron-a.mjs --config <project.json>`. It reads a
 * per-project config and WIRES the real seams — the run-lock (./run-lock.mjs), the `gh` CLI
 * scoped to the configured repo (`--repo <owner>/<repo>`, so a multi-project VPS never acts on
 * the wrong repo), the disk-reading scoped-env adapter (./scoped-env-fromdisk.mjs, NEVER the
 * broken pure ./scoped-env.mjs), a real process spawn, and the cron-state attempt counter
 * (./cron-state.mjs) — around the already-built LOGIC functions cronASelect (./cron-a-select.mjs,
 * task-4) and dispatch (./cron-a-dispatch.mjs, task-5).
 *
 * `runCronA(config, deps)` is the testable seam: `deps` DEFAULTS to the real wiring above but is
 * fully injectable so run-crons.test.mjs can pass fakes for the logic functions (cronASelect,
 * dispatch) plus the real seams (buildScopedEnvFromDisk, ghExec, runLock, spawn, counter) and
 * assert the OBSERVABLE wiring — never real git/gh/tmux/fs from the test.
 *
 * @param {object} config
 * @param {string} config.project
 * @param {string} config.owner
 * @param {string} config.repo
 * @param {string} config.projectRoot
 * @param {string} config.stateDir
 * @param {string} config.worktreeRoot
 * @param {string} config.homeDir
 * @param {string} [config.harnessAuthorLogin]
 * @param {object} [deps] - Injectable seams; each defaults to the real wiring when omitted.
 * @param {(opts: object) => object} [deps.cronASelect] - default: real cronASelect from ./cron-a-select.mjs
 * @param {(issue: object, opts: object) => object} [deps.dispatch] - default: real dispatch from ./cron-a-dispatch.mjs
 * @param {(project: string, opts: object) => Record<string,string>} [deps.buildScopedEnvFromDisk] - default: real buildScopedEnvFromDisk from ./scoped-env-fromdisk.mjs
 * @param {(args: string[]) => any} [deps.ghExec] - default: real `gh` CLI invocation (spawnSync-based)
 * @param {object} [deps.runLock] - default: real { acquire, release, register } from ./run-lock.mjs
 * @param {Function} [deps.spawn] - default: real child_process spawnSync (throws on failure)
 * @param {object} [deps.counter] - default: real { increment, read } from ./cron-state.mjs
 * @param {(sessionId: string) => boolean} [deps.tmuxHasSession] - default: real `tmux has-session` probe
 * @returns {{ ok: boolean, dispatched?: boolean, issue?: { number: number, labels: string[] } }}
 */
import { spawnSync } from "node:child_process";
import { readFileSync, openSync, closeSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { cronASelect } from "./cron-a-select.mjs";
import { dispatch } from "./cron-a-dispatch.mjs";
import { buildScopedEnvFromDisk } from "./scoped-env-fromdisk.mjs";
import { scopedGh, defaultGhExec } from "./gh-exec.mjs";
import * as runLockModule from "./run-lock.mjs";
import * as counterModule from "./cron-state.mjs";
// #235/task-6: reuses run-reaper.mjs's gh-scoped makeDefaultIssueClosed for the drain's issueOpen
// seam (no new dependency). This creates a run-cron-a.mjs <-> run-reaper.mjs ESM cycle (run-reaper.mjs
// already imports loadConfig from this file) — SAFE: both cross-imported symbols (loadConfig,
// makeDefaultIssueClosed) are hoisted function declarations consumed only at CALL time inside a
// function body, never at module-eval top level, so the cycle resolves cleanly under Node's ESM loader.
import { makeDefaultIssueClosed } from "./run-reaper.mjs";
import {
  makeNotifier,
  resolveNotifyConfig,
  summarizeIssueBody,
  createForumTopic as realCreateForumTopic,
  closeForumTopic as realCloseForumTopic,
} from "./notify-telegram.mjs";
import {
  createRun,
  appendEvent,
  updateMeta,
  readEvents,
  readMeta,
  advanceCursor,
} from "./obs-outbox.mjs";

import { resolveRuntime } from "./resolve-runtime.mjs";

/** @description Required fields every per-project VPS cron config must supply. */
export const REQUIRED_CONFIG_FIELDS = [
  "project",
  "owner",
  "repo",
  "projectRoot",
  "stateDir",
  "worktreeRoot",
  "homeDir",
];

/**
 * @description Real spawn seam matching dispatch's throw-on-failure contract: a non-zero exit or
 * a spawn error (e.g. ENOENT) throws, so dispatch's pre-registration failure-recovery path fires.
 * @param {string} command
 * @param {string[]} args
 * @param {object} [spawnOpts]
 * @returns {object} the spawnSync result on success.
 */
function defaultSpawn(command, args, spawnOpts = {}) {
  const res = spawnSync(command, args, { encoding: "utf8", ...spawnOpts });
  if (res.error || res.status !== 0) {
    const err = new Error(`spawn ${command} failed (status=${res.status ?? "n/a"})`);
    err.command = command;
    err.status = res.status;
    err.stderr = res.stderr;
    throw err;
  }
  return res;
}

/** @description Real `tmux has-session -t <id>` liveness probe — true iff the session exists. */
function defaultTmuxHasSession(sessionId) {
  const res = spawnSync("tmux", ["has-session", "-t", sessionId], { stdio: "ignore" });
  return res.status === 0 && !res.error;
}

/**
 * @description Builds the TOKEN-BOUND forum-topic seams the composition root hands down to dispatch.
 * The token is resolved ONCE here via resolveNotifyConfig reading `~/.claude/.dev.vars` (the same
 * disk source makeNotifier uses) — NEVER written into the env-file, argv, or any log. dispatch never
 * resolves the token itself; it only receives these pre-bound async seams. When notify is
 * unconfigured (no token / no chatId) the seams resolve to no-op `{ ok:false }` results with NO
 * network call and `enabled:false` so the legacy direct 'picked' sendNotification stays active.
 * @param {object} config
 * @param {object} deps - { fetch, log, timeoutMs, readFileSafe } threaded through to the API calls.
 * @returns {{ createForumTopic: Function, closeForumTopic: Function, enabled: boolean }}
 */
function makeForumTopicSeams(config, deps = {}) {
  const homeDir = config?.homeDir;
  let resolved = null;
  try {
    resolved = resolveNotifyConfig(config, { homeDir, readFileSafe: deps.readFileSafe });
  } catch {
    resolved = null;
  }
  if (!resolved) {
    return {
      createForumTopic: async () => ({ ok: false }),
      closeForumTopic: async () => ({ ok: false }),
      enabled: false,
    };
  }
  const callOpts = { config: resolved, fetch: deps.fetch, log: deps.log, timeoutMs: deps.timeoutMs };
  return {
    createForumTopic: (input) => realCreateForumTopic(input, callOpts),
    closeForumTopic: (input) => realCloseForumTopic(input, callOpts),
    enabled: true,
  };
}

/** @description Real obs-outbox seam group handed to dispatch, mirroring obs-outbox.mjs exports. */
const realObsSeam = {
  createRun: (input, stateDir) => createRun(input, stateDir),
  appendEvent: (metaPath, event) => appendEvent(metaPath, event),
  updateMeta: (metaPath, partial) => updateMeta(metaPath, partial),
  readEvents: (metaPath) => readEvents(metaPath),
  readMeta: (metaPath) => readMeta(metaPath),
};

export function runCronA(config, deps = {}) {
  const cronASelectFn = deps.cronASelect ?? cronASelect;
  const dispatchFn = deps.dispatch ?? dispatch;
  const buildScopedEnvFromDiskFn = deps.buildScopedEnvFromDisk ?? buildScopedEnvFromDisk;
  const ghExec = deps.ghExec ?? defaultGhExec;
  const runLock = deps.runLock ?? runLockModule;
  const counter = deps.counter ?? counterModule;
  const spawn = deps.spawn ?? defaultSpawn;
  const tmuxHasSession = deps.tmuxHasSession ?? defaultTmuxHasSession;
  // Best-effort notifier: injected (tests observe it) or a no-op default. Building the REAL
  // notifier + draining before exit is the CLI main wrapper's job (mainCronA), not this root — so
  // an injected spy is observable and a project without notify is unaffected.
  const notify = deps.notify ?? (() => {});
  // Heartbeat defaults ON when notify is configured (opt-out via `heartbeat: false`); with no notify
  // block at all it stays off (the notifier is a no-op anyway).
  const heartbeat = deps.heartbeat ?? (config.notify ? config.notify.heartbeat !== false : false);
  // best-effort wrapper: a throwing notifier can NEVER break a cron.
  const safeNotify = (event) => {
    try {
      notify(event);
    } catch {
      // fail-open — notification is never on the cron's critical path
    }
  };

  // The gh seam scopes EVERY call to the configured repo so a multi-project VPS never acts on the
  // wrong project's repo. `--repo <owner>/<repo>` is appended — valid anywhere in a gh argv.
  const gh = scopedGh(config.owner, config.repo, ghExec);

  // The scoped-env producer wired into dispatch is the DISK adapter (buildScopedEnvFromDisk), NEVER
  // the pure buildScopedEnv (which returns {} given only {stateDir,projectRoot}). dispatch calls
  // buildScopedEnv(project, { stateDir, projectRoot }); the wrapper merges the disk adapter's
  // required homeDir from config so the adapter reads ~/.claude/.dev.vars correctly.
  const buildScopedEnv = (project, args) =>
    buildScopedEnvFromDiskFn(project, { ...args, homeDir: config.homeDir });

  // Token-bound forum-topic seams + the real obs-outbox seam group, handed DOWN to dispatch. The
  // token is resolved HERE via resolveNotifyConfig reading ~/.claude/.dev.vars — dispatch never
  // resolves the token from the session env-file. `deps.fetch` is threaded through to the API calls
  // (mirroring the existing deps.fetch convention in mainCronA/makeNotifier). Injectable so a test
  // can override the seams; defaults to the real .dev.vars-reading wiring.
  const forumTopicSeams = deps.forumTopicSeams ?? makeForumTopicSeams(config, {
    fetch: deps.fetch,
    log: deps.log,
    timeoutMs: deps.timeoutMs,
    readFileSafe: deps.readFileSafe,
  });
  const obsSeam = deps.obs ?? realObsSeam;
  const observabilityEnabled = forumTopicSeams.enabled;

  const runtime = resolveRuntime(config);

  // The dispatch seam handed to cronASelect: cronASelect calls dispatch(issue, lock); the seam
  // composes the full dispatch opts from config + the already-held lock handle + the wired seams.
  // It also observes dispatch's structured result: a {ok:false} (spawn failure → re-queued) fires
  // the dispatch-failed notification and records the failure so the post-select `picked` is
  // suppressed (a failed dispatch never "started a session"). notify config is threaded down so the
  // detached session's cron-a-exit can notify session-done/blocked/failed. The token-bound
  // createForumTopic/closeForumTopic + obs seam are threaded so dispatch creates the run's forum
  // topic and outbox before the spawn (HARNESS_OBSERVABILITY_RUN_PATH set when observability wired).
  let dispatchFailed = false;
  const dispatchSeam = (issue, lock) => {
    const result = dispatchFn(issue, {
      project: config.project,
      projectRoot: config.projectRoot,
      worktreeRoot: config.worktreeRoot,
      stateDir: config.stateDir,
      lock,
      spawn,
      runLock,
      gh,
      counter,
      buildScopedEnv,
      notify: config.notify,
      obs: observabilityEnabled ? obsSeam : undefined,
      createForumTopic: forumTopicSeams.createForumTopic,
      closeForumTopic: forumTopicSeams.closeForumTopic,
      runtime,
    });
    // dispatch is async, so in production `result` is a Promise — a sync `result.ok` read sees
    // undefined and silently drops the dispatch-failed notification on every spawn failure. Chain
    // on the resolved value when it is a thenable; fall back to the sync check for a non-thenable
    // result (e.g. an injected sync fake) so the observable wiring stays identical. Fire-and-forget
    // so the cron's critical path never awaits a notifier.
    if (result && typeof result.then === "function") {
      result
        .then((r) => {
          if (r && r.ok === false) {
            dispatchFailed = true;
            safeNotify({ type: "dispatch-failed", project: config.project, issue: issue.number });
          }
        })
        .catch(() => {});
    } else if (result && result.ok === false) {
      dispatchFailed = true;
      safeNotify({ type: "dispatch-failed", project: config.project, issue: issue.number });
    }
    return result;
  };

  const selectResult = cronASelectFn({
    project: config.project,
    stateDir: config.stateDir,
    runLock,
    gh,
    dispatch: dispatchSeam,
    tmuxHasSession,
  });

  // Translate the structured select result into an event (best-effort, off the critical path).
  // The legacy direct `picked` sendNotification is SUPPRESSED for an observability-enabled run
  // (HARNESS_OBSERVABILITY_RUN_PATH set): picked flows through the per-run outbox exactly once
  // (dispatch appended it) and is delivered by the drain to the run's forum topic — never
  // double-sent. A run without observability keeps the direct picked (unchanged behavior).
  if (selectResult && selectResult.dispatched && selectResult.issue && !dispatchFailed) {
    if (!observabilityEnabled) {
      // Observability OFF → the legacy picked ping (with title + one-line body summary so the
      // operator sees WHAT is being implemented). Observability ON → 'picked' goes to the outbox.
      safeNotify({
        type: "picked",
        project: config.project,
        issue: selectResult.issue.number,
        issueTitle: selectResult.issue.title,
        summary: summarizeIssueBody(selectResult.issue.body),
      });
    }
  } else if (selectResult && selectResult.dispatched === false && heartbeat) {
    safeNotify({ type: "idle", project: config.project });
  }

  return selectResult;
}

/** @description Finite timeout (ms) + kill signal applied to every gh spawnSync the issueOpen seam
 * below issues — #235/#ac-1.4: a hung gh process must NEVER block the post-dispatch drain. */
const GH_SPAWN_TIMEOUT_MS = 5000;

/**
 * @description Builds a real issueOpen(issueNumber) seam for this project's single-repo config,
 * reusing run-reaper.mjs's existing gh-scoped makeDefaultIssueClosed (no new dependency). Returns a
 * TRI-STATE: `true` = confirmed OPEN (authorizes a self-heal re-mint), `false` = confirmed CLOSED
 * (authorizes finalizing the run terminal), `null` = UNKNOWN (a gh outage/timeout — authorizes
 * NEITHER a mint nor a finalize; collapsing an outage into "closed" would wrongly terminate a
 * genuinely active run on a transient blip). The spawn's finite timeout keeps the cron itself
 * fail-open (never blocked by a hung gh).
 * @param {{ owner: string, repo: string }} config
 * @param {{ spawn?: Function }} [deps] - test seam; defaults to the real spawnSync
 * @returns {(issueNumber: number) => boolean | null}
 */
export function makeIssueOpen(config, deps = {}) {
  const spawn = deps.spawn ?? spawnSync;
  const spawnWithTimeout = (cmd, args, opts) =>
    spawn(cmd, args, { ...opts, timeout: GH_SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" });
  const issueClosed = makeDefaultIssueClosed(spawnWithTimeout, config.owner, config.repo);
  return (issueNumber) => {
    const closed = issueClosed(issueNumber);
    if (closed === true) return false;
    if (closed === false) return true;
    return null;
  };
}

/**
 * @description CLI wrapper: builds the REAL best-effort notifier, runs runCronA with it injected,
 * and awaits drain() so the short-lived cron process does not exit before in-flight notifications
 * settle (bounded by the send timeout). A notify failure never affects the cron's exit. Wires a real
 * issueOpen seam (#235/#ac-1.3) into the post-dispatch drain so the self-heal branch never re-mints a
 * topic for a closed issue.
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function mainCronA(config, deps = {}) {
  const notifier = makeNotifier(config, {
    homeDir: config.homeDir,
    readFileSafe: deps.readFileSafe,
    fetch: deps.fetch,
    log: deps.log,
    timeoutMs: deps.timeoutMs,
  });

  const drainOutbox = deps.drainOutbox
    ? (opts) =>
        deps.drainOutbox(opts, {
          readEvents,
          readMeta,
          advanceCursor,
          updateMeta,
        })
    : notifier.drainOutbox;

  try {
    runCronA(config, {
      notify: notifier.notify,
      heartbeat: notifier.heartbeat,
      cronASelect: deps.cronASelect,
      dispatch: deps.dispatch,
      buildScopedEnvFromDisk: deps.buildScopedEnvFromDisk,
      ghExec: deps.ghExec,
      runLock: deps.runLock,
      spawn: deps.spawn,
      counter: deps.counter,
      tmuxHasSession: deps.tmuxHasSession,
    });
  } finally {
    // Best-effort file lock so two overlapping cron-A drains cannot double-append
    // spec-created/plan-created checkpoints nor double-send cosmetics. Fail-open: if the lock is
    // already held (another drain in progress) or cannot be created, this tick skips the drain —
    // the next tick drains. NEVER throws, NEVER blocks the cron.
    const lockPath = join(config.stateDir, "drain.lock");
    // A drain now spaces its sends (~1.1s each) to respect Telegram's rate limit, so it runs longer
    // than the old instant burst — widening the window in which a SIGKILL/OOM/reboot mid-drain can
    // leave an ORPHAN drain.lock. Without reclaim, one orphan lock silences the feed on every future
    // tick (fail-open masks it). Reclaim a lock whose mtime is older than the stale TTL.
    const LOCK_STALE_MS = 15 * 60 * 1000;
    let lockFd = null;
    try {
      lockFd = openSync(lockPath, "wx");
    } catch {
      // Lock exists — reclaim it only if it is stale (a prior drain died without cleanup). A fresh
      // lock (another drain in progress) is left alone: this tick skips the drain, the next drains.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          lockFd = openSync(lockPath, "wx");
        }
      } catch {
        // still busy, unreadable, or a reclaim raced another drain — skip this tick, next tick drains
      }
    }
    if (lockFd !== null) {
      try {
        await drainOutbox({
          stateDir: config.stateDir,
          homeDir: config.homeDir,
          chatId: notifier.config?.chatId,
          limitPerMinute: config.notify?.limitPerMinute ?? 20,
          sendDelayMs: config.notify?.sendDelayMs ?? 1100,
          issueOpen: makeIssueOpen(config, { spawn: deps.spawn }),
        });
      } catch {
        // fail-open: a drain failure never throws or delays the cron
      } finally {
        try {
          closeSync(lockFd);
        } catch {
          // best-effort fd close
        }
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // best-effort lock cleanup
        }
      }
    }
    try {
      await notifier.drain();
    } catch {
      // fail-open
    }
  }
}

/**
 * @description Loads and validates a per-project VPS cron config — from a JSON file path or an
 * already-parsed object — throwing a clear error naming the first missing REQUIRED field
 * (project, owner, repo, projectRoot, stateDir, worktreeRoot, homeDir). Never returns a
 * partial/silent config. Shared by run-cron-a.mjs, run-cron-b.mjs and run-reaper.mjs's CLI entry.
 *
 * @param {string|object} source - Absolute path to a config JSON file, or an already-parsed object.
 * @returns {{ project: string, owner: string, repo: string, projectRoot: string, stateDir: string, worktreeRoot: string, homeDir: string, harnessAuthorLogin?: string, projects?: Array<object> }}
 */
export function loadConfig(source) {
  const cfg = typeof source === "string" ? JSON.parse(readFileSync(source, "utf8")) : source;
  for (const field of REQUIRED_CONFIG_FIELDS) {
    if (!cfg[field]) {
      throw new Error(`loadConfig: missing required field "${field}"`);
    }
  }
  return { ...cfg };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = process.argv[2];
  const configPath = arg === "--config" ? process.argv[3] : arg;
  mainCronA(loadConfig(configPath)).catch((err) => {
    console.error(`run-cron-a: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}