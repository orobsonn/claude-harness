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
import { readFileSync } from "node:fs";

import { cronASelect } from "./cron-a-select.mjs";
import { dispatch } from "./cron-a-dispatch.mjs";
import { buildScopedEnvFromDisk } from "./scoped-env-fromdisk.mjs";
import { scopedGh, defaultGhExec } from "./gh-exec.mjs";
import * as runLockModule from "./run-lock.mjs";
import * as counterModule from "./cron-state.mjs";
import { makeNotifier } from "./notify-telegram.mjs";

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
  const heartbeat = deps.heartbeat ?? config.notify?.heartbeat === true;
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

  // The dispatch seam handed to cronASelect: cronASelect calls dispatch(issue, lock); the seam
  // composes the full dispatch opts from config + the already-held lock handle + the wired seams.
  // It also observes dispatch's structured result: a {ok:false} (spawn failure → re-queued) fires
  // the dispatch-failed notification and records the failure so the post-select `picked` is
  // suppressed (a failed dispatch never "started a session"). notify config is threaded down so the
  // detached session's cron-a-exit can notify session-done/blocked/failed.
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
    });
    if (result && result.ok === false) {
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
  if (selectResult && selectResult.dispatched && selectResult.issue && !dispatchFailed) {
    safeNotify({ type: "picked", project: config.project, issue: selectResult.issue.number });
  } else if (selectResult && selectResult.dispatched === false && heartbeat) {
    safeNotify({ type: "idle", project: config.project });
  }

  return selectResult;
}

/**
 * @description CLI wrapper: builds the REAL best-effort notifier, runs runCronA with it injected,
 * and awaits drain() so the short-lived cron process does not exit before in-flight notifications
 * settle (bounded by the send timeout). A notify failure never affects the cron's exit.
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function mainCronA(config) {
  const notifier = makeNotifier(config, { homeDir: config.homeDir });
  try {
    runCronA(config, { notify: notifier.notify, heartbeat: notifier.heartbeat });
  } finally {
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