/**
 * @description Tests for #235/task-6: mainCronA (run-cron-a.mjs) wires a real issueOpen seam into
 * its post-dispatch drain, reusing run-reaper.mjs's gh-scoped makeDefaultIssueClosed with a finite
 * gh spawn timeout (#ac-1.4) — mirroring core/vps/run-drain.test.mjs's task-5 coverage for the
 * dedicated drain-only cron.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { mainCronA, makeIssueOpen } from "./run-cron-a.mjs";

function makeStateDir() {
  return mkdtempSync(join(tmpdir(), "run-cron-a-state-"));
}

function homeWithToken() {
  const homeDir = mkdtempSync(join(tmpdir(), "run-cron-a-home-"));
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  writeFileSync(join(homeDir, ".claude", ".dev.vars"), "TELEGRAM_BOT_TOKEN=fake\nTELEGRAM_CHAT_ID=999\n", "utf8");
  return homeDir;
}

/** @description Fake `deps.spawn` seam mirroring spawnSync's shape, resolving a canned
 * `gh issue view --json state` response and recording every call's opts. */
function makeFakeSpawn(ghResponse = { status: 0, stdout: JSON.stringify({ state: "OPEN" }) }) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return ghResponse;
  };
  return { spawn, calls };
}

/** @description Minimal fake cronASelect that finds nothing ready — mainCronA's dispatch/select
 * logic is out of scope here; only the post-dispatch drain wiring is under test. */
function noopCronASelect() {
  return { picked: null, reason: "idle" };
}

function baseConfig(overrides = {}) {
  return {
    project: "demo",
    owner: "acme",
    repo: "widgets",
    projectRoot: "/fake/root",
    stateDir: makeStateDir(),
    worktreeRoot: "/fake/worktrees",
    homeDir: homeWithToken(),
    notify: { chatId: 999 },
    ...overrides,
  };
}

test("#235/task-6 mainCronA: threads a real issueOpen function into the post-dispatch drainOutbox opts, resolving true for a gh-confirmed OPEN issue", async () => {
  const config = baseConfig();
  const { spawn } = makeFakeSpawn({ status: 0, stdout: JSON.stringify({ state: "OPEN" }) });

  let receivedOpts;
  await mainCronA(config, {
    cronASelect: noopCronASelect,
    drainOutbox: async (opts) => { receivedOpts = opts; },
    spawn,
  });

  assert.strictEqual(typeof receivedOpts.issueOpen, "function", "the drain opts must carry an issueOpen function");
  assert.strictEqual(receivedOpts.issueOpen(42), true, "a gh-confirmed OPEN issue must resolve issueOpen(n) === true");
});

test("#235/task-6 mainCronA: issueOpen resolves false for a gh-confirmed CLOSED issue (do-not-mint)", async () => {
  const config = baseConfig();
  const { spawn } = makeFakeSpawn({ status: 0, stdout: JSON.stringify({ state: "CLOSED" }) });

  let receivedOpts;
  await mainCronA(config, {
    cronASelect: noopCronASelect,
    drainOutbox: async (opts) => { receivedOpts = opts; },
    spawn,
  });

  assert.strictEqual(receivedOpts.issueOpen(42), false, "a gh-confirmed CLOSED issue must resolve issueOpen(n) === false");
});

test("#235/task-6 mainCronA: a gh outage (non-zero status) makes issueOpen resolve null (unknown) and mainCronA never rejects", async () => {
  const config = baseConfig();
  const { spawn } = makeFakeSpawn({ status: 1, stdout: "" });

  let receivedOpts;
  await assert.doesNotReject(
    mainCronA(config, {
      cronASelect: noopCronASelect,
      drainOutbox: async (opts) => { receivedOpts = opts; },
      spawn,
    }),
  );

  assert.strictEqual(receivedOpts.issueOpen(42), null, "a gh outage must resolve issueOpen(n) === null (unknown) — never authorize a mint AND never authorize a finalize-closed under uncertainty");
});

test("#235/task-6 makeIssueOpen: passes a finite opts.timeout and killSignal:'SIGKILL' to every gh spawn (#ac-1.4)", () => {
  const { spawn, calls } = makeFakeSpawn({ status: 0, stdout: JSON.stringify({ state: "OPEN" }) });

  const issueOpen = makeIssueOpen({ owner: "acme", repo: "widgets" }, { spawn });
  issueOpen(42);

  assert.strictEqual(calls.length, 1, "exactly one gh spawn call");
  assert.ok(Number.isFinite(calls[0].opts.timeout) && calls[0].opts.timeout > 0, "the spawn call must carry a finite timeout");
  assert.strictEqual(calls[0].opts.killSignal, "SIGKILL", "the spawn call must carry killSignal:'SIGKILL'");
});
