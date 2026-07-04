#!/usr/bin/env node
/**
 * @description VPS cron harness — Cron B COMPOSITION ROOT (task-9 glue-3). A crontab invokes
 * this file directly: `node core/vps/run-cron-b.mjs --config <project.json>`. It reads a
 * per-project config and WIRES the real seams — the `gh` CLI scoped to the configured repo
 * (`--repo <owner>/<repo>`), the cron-state reviewed-SHA marker (./cron-state.mjs), and the
 * verdict-block parser — around the already-built LOGIC function cronB (./cron-b.mjs).
 *
 * Fail-closed author gate: cronB's `harnessAuthorLogin` option gates auto-merge to only
 * harness-originated PRs. When `config.harnessAuthorLogin` is absent, `runCronB` DEFAULTS it to
 * the authenticated `gh` user (`deps.getAuthenticatedGhUser()`) — NEVER leaves it unset/empty,
 * which would silently fall back to cronB's legacy branch-prefix-only default and widen the
 * auto-merge gate. When `config.harnessAuthorLogin` is present, the config value wins.
 *
 * `runCronB(config, deps)` is the testable seam: `deps` DEFAULTS to the real wiring above but is
 * fully injectable so run-crons.test.mjs can pass a fake cronB + fake getAuthenticatedGhUser and
 * assert the OBSERVABLE opts cronB receives — never a real `gh` call from the test.
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
 * @param {(opts: object) => void} [deps.cronB] - default: real cronB from ./cron-b.mjs
 * @param {() => string} [deps.getAuthenticatedGhUser] - default: real `gh api user --jq .login`
 * @param {(args: string[]) => any} [deps.ghExec] - default: real `gh` CLI invocation
 * @param {(body: string) => object} [deps.parseVerdictBlock] - default: real parser from ./verdict-block.mjs
 * @param {Function} [deps.alreadyReviewed] - default: real alreadyReviewed from ./cron-state.mjs
 * @param {Function} [deps.recordReviewed] - default: real recordReviewed from ./cron-state.mjs
 * @returns {void}
 */
import { spawnSync } from "node:child_process";

import { loadConfig } from "./run-cron-a.mjs";
import { cronB } from "./cron-b.mjs";
import { parseVerdictBlock } from "./verdict-block.mjs";
import { alreadyReviewed, recordReviewed } from "./cron-state.mjs";
import { scopedGh, defaultGhExec } from "./gh-exec.mjs";

/**
 * @description Real authenticated-gh-user lookup: `gh api user --jq .login`. Returns "" on
 * failure — combined with the `??` default chain this keeps the author gate fail-closed (an empty
 * login means cronB's isHarnessAuthor treats every PR as non-harness and skips auto-merge).
 * @returns {string}
 */
function defaultGetAuthenticatedGhUser() {
  const res = spawnSync("gh", ["api", "user", "--jq", ".login"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0 || res.error) return "";
  return (res.stdout || "").trim();
}

export function runCronB(config, deps = {}) {
  const cronBFn = deps.cronB ?? cronB;
  const getAuthenticatedGhUser = deps.getAuthenticatedGhUser ?? defaultGetAuthenticatedGhUser;
  const ghExec = deps.ghExec ?? defaultGhExec;
  const parseVerdictBlockFn = deps.parseVerdictBlock ?? parseVerdictBlock;
  const alreadyReviewedFn = deps.alreadyReviewed ?? alreadyReviewed;
  const recordReviewedFn = deps.recordReviewed ?? recordReviewed;

  // Fail-closed author gate: config wins, else the authenticated gh user — NEVER unset/empty.
  const harnessAuthorLogin = config.harnessAuthorLogin ?? getAuthenticatedGhUser();

  const gh = scopedGh(config.owner, config.repo, ghExec);

  cronBFn({
    gh,
    parseVerdictBlock: parseVerdictBlockFn,
    alreadyReviewed: alreadyReviewedFn,
    recordReviewed: recordReviewedFn,
    stateDir: config.stateDir,
    harnessAuthorLogin,
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = process.argv[2];
  const configPath = arg === "--config" ? process.argv[3] : arg;
  runCronB(loadConfig(configPath));
}