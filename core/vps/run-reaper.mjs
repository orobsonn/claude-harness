#!/usr/bin/env node
/**
 * @description VPS cron harness — Reaper COMPOSITION ROOT (task-9 glue-3). ONE shared cron for
 * the WHOLE VPS: a crontab invokes this file once (`node core/vps/run-reaper.mjs --config
 * <fleet.json>`), and it reads a config carrying every project to sweep, then WIRES the real
 * seams — the `listWorktrees` producer (./list-worktrees.mjs) scoped over `config.projects`, the
 * run-lock release (./run-lock.mjs), the cron-state read-only attempt counter (./cron-state.mjs),
 * real tmux liveness/kill probes, and `git worktree remove` / `git branch -D` — around the
 * already-built LOGIC function reaper (./reaper.mjs, task-8).
 *
 * `runReaper(config, deps)` is the testable seam: `deps` DEFAULTS to the real wiring above but is
 * fully injectable so run-crons.test.mjs can pass a fake reaper + a fake listWorktrees producer
 * and assert the OBSERVABLE wiring — specifically that the zero-arg `listWorktrees` seam handed
 * to the reaper logic delegates to the injected producer over `config.projects`, never a real git
 * call from the test.
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
 * @param {Array<{project: string, projectRoot: string, stateDir: string}>} [config.projects] -
 *   every project the shared reaper sweeps in one invocation.
 * @param {object} [deps] - Injectable seams; each defaults to the real wiring when omitted.
 * @param {(opts: object) => void} [deps.reaper] - default: real reaper from ./reaper.mjs
 * @param {(opts: object) => Array<object>} [deps.listWorktrees] - default: real listWorktrees from ./list-worktrees.mjs
 * @param {(args: string[]) => any} [deps.ghExec] - default: real `gh` CLI invocation
 * @param {object} [deps.runLock] - default: real { release } from ./run-lock.mjs
 * @param {object} [deps.counter] - default: real read-only { read } from ./cron-state.mjs
 * @returns {void}
 */
import { loadConfig } from "./run-cron-a.mjs";

export function runReaper(config, deps = {}) {
  throw new Error("runReaper not implemented");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runReaper(loadConfig(process.argv[2]));
}
