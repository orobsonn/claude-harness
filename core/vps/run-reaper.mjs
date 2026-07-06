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
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./run-cron-a.mjs";
import { reaper } from "./reaper.mjs";
import { listWorktrees } from "./list-worktrees.mjs";
import { readHolder } from "./run-lock.mjs";
import { scopedGh, defaultGhExec } from "./gh-exec.mjs";
import * as counterModule from "./cron-state.mjs";
import * as runLockModule from "./run-lock.mjs";
import { makeNotifier, closeForumTopic as realCloseForumTopic } from "./notify-telegram.mjs";
import { readMeta as realReadMeta, updateMeta as realUpdateMeta } from "./obs-outbox.mjs";

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
 * @description Default listObsRuns producer: sweeps every configured project's stateDir for
 * obs-<issue>.json files and returns { metaPath, meta } pairs (meta pre-read via the canonical
 * obs-outbox readMeta). reaper.mjs never touches fs directly — this is the composition-root wiring.
 * Fail-soft per project: an unreadable stateDir contributes no runs (the shared cron never aborts
 * every other project because one stateDir is unreadable).
 * @param {Array<{ project: string, projectRoot: string, stateDir: string }>} projects
 * @param {(metaPath: string) => object|null} readMetaFn
 * @returns {Array<{ metaPath: string, meta: object }>}
 */
function defaultListObsRuns(projects, readMetaFn) {
  const runs = [];
  for (const project of projects ?? []) {
    let files;
    try {
      files = readdirSync(project.stateDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith("obs-") || !file.endsWith(".json")) continue;
      const metaPath = join(project.stateDir, file);
      const meta = readMetaFn(metaPath);
      if (meta) runs.push({ metaPath, meta });
    }
  }
  return runs;
}

/**
 * @description Default liveWorktreePaths producer: the set of harness worktree paths that still
 * exist on disk across every configured project (via the same listWorktrees producer the
 * holder-liveness scan uses). Decoupled from listWorktrees at the SEAM level (a test injects it
 * directly); the production wiring shares the producer so a run whose worktree is still live is
 * never mistaken for an orphan.
 * @param {object} producerOpts - threaded straight to listWorktreesFn.
 * @returns {Array<string>}
 */
function defaultLiveWorktreePaths(producerOpts) {
  return listWorktrees(producerOpts).map((entry) => entry.worktreePath);
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
  const readMetaFn = deps.readMeta ?? realReadMeta;
  const updateMetaFn = deps.updateMeta ?? realUpdateMeta;

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

  // Orphan topic-close seams (task-9). listObsRuns/liveWorktreePaths default to real fs/git
  // enumeration over config.projects; closeForumTopic is the token-bound seam mainReaper builds
  // (the token is resolved there via makeNotifier reading ~/.claude/.dev.vars — never the session
  // env). When closeForumTopic is NOT injected (e.g. a run-crons test that only exercises the
  // worktree scan), sweepOrphanTopics no-ops.
  const listObsRunsSeam = deps.listObsRuns ?? (() => defaultListObsRuns(config.projects, readMetaFn));
  const liveWorktreePathsSeam =
    deps.liveWorktreePaths ?? (() => defaultLiveWorktreePaths({
      projects: config.projects,
      runGitWorktreeList,
      readHolder: readHolderFn,
    }));
  const closeForumTopicFn = deps.closeForumTopic ?? null;
  const updateMetaSeam = deps.updateMeta ?? updateMetaFn;

  const result = reaperFn({
    listWorktrees: listWorktreesSeam,
    tmuxHasSession,
    kill,
    now,
    prExists,
    gh,
    runLock,
    counter,
    tmuxKillSession,
    listObsRuns: listObsRunsSeam,
    liveWorktreePaths: liveWorktreePathsSeam,
    closeForumTopic: closeForumTopicFn,
    updateMeta: closeForumTopicFn ? updateMetaSeam : undefined,
  });

  // reaper returns the actions array with a `topicCloses` property attached; a fake/injected
  // reaper may return undefined or a bare array (backward compatible with the existing tests).
  const actions = Array.isArray(result) ? result : (result?.actions ?? []);
  const topicCloses = (result && result.topicCloses) || (result?.actions?.topicCloses) || [];

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

  // Return the orphan close promises so mainReaper can await them before the process exits.
  return topicCloses;
}

/**
 * @description CLI wrapper: builds the real FLEET-level notifier, runs runReaper with it injected,
 * and awaits drain() — AND the orphan topic-close promises — before the shared reaper process
 * exits so its notifications and topic closes are not dropped. The closeForumTopic token is
 * resolved HERE via makeNotifier(config,{homeDir}) reading ~/.claude/.dev.vars at runtime (mirrors
 * the task-4 token judgment) — never from the session env-file or a threaded secret. When notify is
 * unconfigured the token-bound closeForumTopic resolves to a no-op { ok:false } so the orphan sweep
 * still records status:'closed' on disk (the close is best-effort, fail-open).
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function mainReaper(config) {
  const notifier = makeNotifier(config, { homeDir: config.homeDir });
  // Token-bound closeForumTopic: the token lives on notifier.config (resolved from ~/.claude/.dev.vars).
  // Bound here so the reaper logic never resolves the token itself; it only receives this seam.
  const closeForumTopic = notifier.config
    ? (input) => realCloseForumTopic(input, {
        config: notifier.config,
        fetch: config.fetch,
        log: config.log,
        timeoutMs: config.timeoutMs,
      })
    : async () => ({ ok: false });

  let topicCloses = [];
  try {
    topicCloses = runReaper(config, { notify: notifier.notify, closeForumTopic }) ?? [];
  } finally {
    try {
      await Promise.allSettled(topicCloses);
    } catch {
      // fail-open: a close failure never blocks the reaper exit
    }
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