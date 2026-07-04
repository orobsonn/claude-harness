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
 * @param {(projectRoot: string) => string} [deps.runGitWorktreeList] - default: real `git worktree list --porcelain`
 * @param {(opts: {stateDir: string}) => object|null} [deps.readHolder] - default: real readHolder from ./run-lock.mjs
 * @param {(args: string[]) => any} [deps.ghExec] - default: real `gh` CLI invocation
 * @param {object} [deps.runLock] - default: real { release } from ./run-lock.mjs
 * @param {object} [deps.counter] - default: real read-only { read } from ./cron-state.mjs
 * @param {(sessionId: string) => boolean} [deps.tmuxHasSession] - default: real `tmux has-session` probe
 * @param {(sessionId: string) => void} [deps.tmuxKillSession] - default: real `tmux kill-session`
 * @param {(issueNumber: number) => boolean} [deps.prExists] - default: real `gh pr list --head harness/<n>` check
 * @returns {void}
 */
import { spawnSync } from "node:child_process";

import { loadConfig } from "./run-cron-a.mjs";
import { reaper } from "./reaper.mjs";
import { listWorktrees } from "./list-worktrees.mjs";
import { readHolder } from "./run-lock.mjs";
import { scopedGh, defaultGhExec } from "./gh-exec.mjs";
import * as counterModule from "./cron-state.mjs";
import * as runLockModule from "./run-lock.mjs";
import { makeNotifier } from "./notify-telegram.mjs";

/** @description Real `git -C <projectRoot> worktree list --porcelain` stdout. Fail-soft -> "". */
function defaultRunGitWorktreeList(projectRoot) {
  const res = spawnSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error || res.status !== 0) return "";
  return res.stdout ?? "";
}

/** @description Real `tmux has-session -t <id>` liveness probe — true iff the session exists. */
function defaultTmuxHasSession(sessionId) {
  const res = spawnSync("tmux", ["has-session", "-t", sessionId], { stdio: "ignore" });
  return res.status === 0 && !res.error;
}

/** @description Real `tmux kill-session -t <id>`. Best-effort; failures swallowed. */
function defaultTmuxKillSession(sessionId) {
  try {
    spawnSync("tmux", ["kill-session", "-t", sessionId], { stdio: "ignore" });
  } catch {
    // best-effort watchdog kill
  }
}

/**
 * @description Builds the real prExists seam bound to the scoped gh: true iff an open OR merged
 * harness PR exists for the issue's head branch `harness/<issueNumber>`. Fail-closed (returns
 * false on any gh failure) so a dead holder with a PR is never wrongly relabeled back to ready.
 * @param {(args: string[]) => any} gh
 * @returns {(issueNumber: number) => boolean}
 */
function defaultPrExists(gh) {
  return (issueNumber) => {
    const prs = gh([
      "pr",
      "list",
      "--head",
      `harness/${issueNumber}`,
      "--state",
      "all",
      "--json",
      "number",
    ]);
    return Array.isArray(prs) && prs.length > 0;
  };
}

export function runReaper(config, deps = {}) {
  const reaperFn = deps.reaper ?? reaper;
  const listWorktreesFn = deps.listWorktrees ?? listWorktrees;
  const runGitWorktreeList = deps.runGitWorktreeList ?? defaultRunGitWorktreeList;
  const readHolderFn = deps.readHolder ?? readHolder;
  const ghExec = deps.ghExec ?? defaultGhExec;
  const runLock = deps.runLock ?? runLockModule;
  const counter = deps.counter ?? counterModule;
  const tmuxHasSession = deps.tmuxHasSession ?? defaultTmuxHasSession;
  const tmuxKillSession = deps.tmuxKillSession ?? defaultTmuxKillSession;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const kill = deps.kill ?? process.kill;

  const gh = scopedGh(config.owner, config.repo, ghExec);
  const prExists = deps.prExists ?? defaultPrExists(gh);

  // The zero-arg listWorktrees seam handed to the reaper logic: delegates to the injected producer
  // over config.projects (every project the shared cron sweeps in one invocation), bound to the
  // real git-worktree-list and readHolder seams (or their injected fakes).
  const listWorktreesSeam = () =>
    listWorktreesFn({
      projects: config.projects,
      runGitWorktreeList,
      readHolder: readHolderFn,
    });

  // Best-effort notifier: injected (tests observe) or no-op default. The real notifier + drain live
  // in mainReaper. Each notification's `<project>` prefix comes from the per-worktree action entry
  // (the reaper is a shared cron over many projects), never a single fleet value.
  const notify = deps.notify ?? (() => {});

  const actions =
    reaperFn({
      listWorktrees: listWorktreesSeam,
      tmuxHasSession,
      kill,
      now,
      prExists,
      gh,
      runLock,
      counter,
      tmuxKillSession,
    }) || [];

  const ACTION_TYPE = {
    "watchdog-killed": "reaper-killed",
    "crash-recovered": "reaper-recovered",
    "orphan-cleaned": "reaper-orphan-cleaned",
  };
  for (const a of actions) {
    try {
      const type = ACTION_TYPE[a.action];
      if (type) notify({ type, project: a.project, issue: a.issueNumber });
    } catch {
      // fail-open — a notify failure never blocks the sweep
    }
  }
}

/**
 * @description CLI wrapper: builds the real FLEET-level notifier, runs runReaper with it injected,
 * and awaits drain() before the shared reaper process exits so its notifications are not dropped.
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function mainReaper(config) {
  const notifier = makeNotifier(config, { homeDir: config.homeDir });
  try {
    runReaper(config, { notify: notifier.notify });
  } finally {
    try {
      await notifier.drain();
    } catch {
      // fail-open
    }
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = process.argv[2];
  const configPath = arg === "--config" ? process.argv[3] : arg;
  mainReaper(loadConfig(configPath)).catch((err) => {
    console.error(`run-reaper: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}