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
 * STUB — throws until implemented by the executor hand. RED for run-crons.test.mjs.
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
 * @param {Function} [deps.spawn] - default: real child_process spawn/spawnSync
 * @param {object} [deps.counter] - default: real { increment, read } from ./cron-state.mjs
 * @returns {{ ok: boolean, dispatched?: boolean, issue?: { number: number, labels: string[] } }}
 */
export function runCronA(config, deps = {}) {
  throw new Error("runCronA not implemented");
}

/**
 * @description Loads and validates a per-project VPS cron config — from a JSON file path or an
 * already-parsed object — throwing a clear error naming the first missing REQUIRED field
 * (project, owner, repo, projectRoot, stateDir, worktreeRoot, homeDir). Never returns a
 * partial/silent config. Shared by run-cron-a.mjs, run-cron-b.mjs and run-reaper.mjs's CLI entry.
 *
 * STUB — throws until implemented by the executor hand. RED for run-crons.test.mjs.
 *
 * @param {string|object} source - Absolute path to a config JSON file, or an already-parsed object.
 * @returns {{ project: string, owner: string, repo: string, projectRoot: string, stateDir: string, worktreeRoot: string, homeDir: string, harnessAuthorLogin?: string }}
 */
export function loadConfig(source) {
  throw new Error("loadConfig not implemented");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runCronA(loadConfig(process.argv[2]));
}
