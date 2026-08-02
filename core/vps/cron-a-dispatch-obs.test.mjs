/**
 * @description Frozen contract tests for task-4 (vps-run-observability): integrating the
 * per-run observability outbox (obs-outbox.mjs) + Telegram forum topic (notify-telegram.mjs)
 * into cron-a-dispatch.mjs's dispatch(), wired from the composition root run-cron-a.mjs. This
 * file transcribes ALL 10 pinned assertions from
 * .claude/plans/vps-run-observability/run/task-4-assertions.md — one test() per assertion.
 *
 * ASSUMED SEAM CONTRACT (the integration does not exist yet — these tests are RED until it does):
 *   - dispatch(issue, opts) gains `issue.title` (optional) and two new opts groups:
 *       - opts.obs = { createRun, appendEvent, updateMeta, readEvents, readMeta } — mirroring
 *         obs-outbox.mjs's real exports EXACTLY (same signatures: createRun(input, stateDir),
 *         appendEvent(metaPath, event), updateMeta(metaPath, partial), readEvents(metaPath),
 *         readMeta(metaPath)) so a production wiring can pass the real module functions through
 *         unchanged.
 *       - opts.createForumTopic({ name }) -> Promise<{ ok, threadId? } | null> and
 *         opts.closeForumTopic({ threadId }) -> Promise<{ ok }> — mirroring notify-telegram.mjs's
 *         real createForumTopic/closeForumTopic signatures, TOKEN-BOUND and handed down already
 *         resolved by the composition root (dispatch never sees a token).
 *   - dispatch is therefore async (or at minimum returns a thenable) so it can await the network
 *     round-trip before the tmux spawn; every call site below uses `await dispatch(...)`, which is
 *     forward-compatible with a synchronous return too.
 *   - run-cron-a.mjs's runCronA(config, deps) builds the real token-bound createForumTopic/
 *     closeForumTopic seams via resolveNotifyConfig/readTelegramToken (reading
 *     `${config.homeDir}/.claude/.dev.vars`) and threads a `deps.fetch` seam through to them,
 *     mirroring the existing deps.fetch convention already used by mainCronA/makeNotifier.
 *
 * Every seam not central to the assertion under test is faked exactly as cron-a-dispatch.test.mjs
 * already does (spawn/runLock/gh/counter/buildScopedEnv), so these tests stay hermetic: no real
 * git/tmux/gh/network call is ever made outside the deliberately-injected fake fetch in test 6.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "./cron-a-dispatch.mjs";
import { runCronA } from "./run-cron-a.mjs";
import {
  createRun as realCreateRun,
  appendEvent as realAppendEvent,
  updateMeta as realUpdateMeta,
  readEvents as realReadEvents,
  readMeta as realReadMeta,
} from "./obs-outbox.mjs";
import { drainTelegramOutbox } from "./notify-telegram.mjs";

/** @description Fresh temp projectRoot/worktreeRoot/stateDir for one test, plus cleanup. */
function makeTempDirs() {
  const root = mkdtempSync(join(tmpdir(), "cron-a-dispatch-obs-"));
  const projectRoot = join(root, "project");
  const worktreeRoot = join(root, "worktrees");
  const stateDir = join(root, "state");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, projectRoot, worktreeRoot, stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @description Fake spawn seam mirroring cron-a-dispatch.test.mjs's makeFakeSpawn, additionally
 * pushing an `spawn:<command>` marker into a shared `order` array so ordering against
 * createForumTopic/obs calls can be asserted.
 */
function makeFakeSpawn({ failCommands = [], order = [] } = {}) {
  const calls = [];
  function spawn(command, args = [], spawnOpts = {}) {
    order.push(`spawn:${command}`);
    calls.push({ command, args, env: spawnOpts.env, cwd: spawnOpts.cwd });
    if (failCommands.includes(command)) {
      throw new Error(`fake spawn: ${command} failed`);
    }
    return { ok: true };
  }
  return { spawn, calls };
}

/** @description Fake run-lock seam (register/release recorded). */
function makeFakeRunLock(initialHolder) {
  let holder = { ...initialHolder };
  const registerCalls = [];
  const releaseCalls = [];
  return {
    holder: () => holder,
    register(tmuxId, opts) {
      registerCalls.push({ tmuxId, opts });
      holder = { ...holder, tmux_session_id: tmuxId };
    },
    release(opts) {
      releaseCalls.push(opts);
      holder = null;
    },
    registerCalls,
    releaseCalls,
  };
}

/** @description Fake gh seam recording argv. */
function makeFakeGh() {
  const calls = [];
  function gh(args) {
    calls.push(args);
    return { ok: true };
  }
  return { gh, calls };
}

/** @description Fake per-issue attempt counter seam. */
function makeFakeCounter(initial = {}) {
  const counts = { ...initial };
  return {
    increment(issueNumber) {
      counts[issueNumber] = (counts[issueNumber] ?? 0) + 1;
    },
    read(issueNumber) {
      return counts[issueNumber] ?? 0;
    },
  };
}

/**
 * @description Fake token-bound createForumTopic seam. Pushes `createForumTopic` into the shared
 * `order` array and records every `{ name }` call so tests can assert the topic-name contract and
 * call ordering / idempotent non-invocation.
 */
function makeFakeCreateForumTopic({ result = { ok: true, threadId: 707 }, order = [] } = {}) {
  const calls = [];
  async function createForumTopic(input) {
    order.push("createForumTopic");
    calls.push(input);
    return result;
  }
  return { createForumTopic, calls };
}

/** @description Fake closeForumTopic seam — records every `{ threadId }` call. */
function makeFakeCloseForumTopic({ order = [] } = {}) {
  const calls = [];
  async function closeForumTopic(input) {
    order.push("closeForumTopic");
    calls.push(input);
    return { ok: true };
  }
  return { closeForumTopic, calls };
}

/**
 * @description Builds the `opts.obs` seam group from the REAL obs-outbox.mjs functions, wrapping
 * appendEvent/updateMeta so their invocations are also pushed into the shared `order` array
 * (needed to assert e.g. "picked appended BEFORE the spawn") while still calling through to the
 * real, file-backed implementation — so obs-141.json / obs-141.events.jsonl genuinely exist on
 * disk afterward, exactly as the assertions require.
 */
function makeRealObsSeam(order = []) {
  return {
    createRun: (input, stateDir) => realCreateRun(input, stateDir),
    appendEvent: (metaPath, event) => {
      order.push(`appendEvent:${event?.type}`);
      return realAppendEvent(metaPath, event);
    },
    updateMeta: (metaPath, partial) => {
      order.push(`updateMeta:${JSON.stringify(partial)}`);
      return realUpdateMeta(metaPath, partial);
    },
    readEvents: (metaPath) => realReadEvents(metaPath),
    readMeta: (metaPath) => realReadMeta(metaPath),
  };
}

/**
 * @description Fake obs seam (task-4 shape) with a FIXED metaPath and a caller-seeded `meta`
 * object, giving full control over readMeta's return value — independent of the real, file-backed
 * obs-outbox.mjs implementation. Used to drive setupObservability's "no open thread" branch (via
 * dispatch) deterministically and to record every updateMeta partial verbatim for exact-shape
 * assertions (#ac-1.2).
 */
function makeFakeObsSeam({
  metaPath = "/tmp/fake-obs-141.json",
  meta = { threadId: null, status: "active", cursor: 0 },
  order = [],
} = {}) {
  let currentMeta = { ...meta };
  const updateMetaCalls = [];
  return {
    createRun: () => metaPath,
    readMeta: () => ({ ...currentMeta }),
    updateMeta: (path, partial) => {
      order.push(`updateMeta:${JSON.stringify(partial)}`);
      updateMetaCalls.push({ metaPath: path, partial });
      currentMeta = { ...currentMeta, ...partial };
    },
    appendEvent: () => {},
    readEvents: () => [],
    updateMetaCalls,
  };
}

/** @description Reads the parsed obs-<issue>.json meta straight off disk via the real reader. */
function readObsMeta(stateDir, issueNumber) {
  return realReadMeta(join(stateDir, `obs-${issueNumber}.json`));
}

/** @description Reads the parsed obs-<issue>.events.jsonl events straight off disk. */
function readObsEvents(stateDir, issueNumber) {
  return realReadEvents(join(stateDir, `obs-${issueNumber}.json`));
}

/** @description Locates the scoped env-file dispatch wrote for this issue in stateDir and returns its content. */
function readEnvFileContent(stateDir, issueNumber) {
  const match = readdirSync(stateDir).find((f) => f.startsWith(`issue-${issueNumber}-env-`) && f.endsWith(".env"));
  if (!match) return null;
  return readFileSync(join(stateDir, match), "utf8");
}

/** @description Assembles a full dispatch() opts object from defaults + per-test overrides. */
function baseOpts({
  projectRoot,
  worktreeRoot,
  stateDir,
  project = "demo-project",
  spawn,
  runLock = makeFakeRunLock({ pid: 111, acquire_ts: 1000 }),
  gh = makeFakeGh().gh,
  counter = makeFakeCounter(),
  buildScopedEnv = () => ({ PATH: "/usr/bin" }),
  lock = { acquireTs: 1000 },
  branchExists = () => false,
  obs,
  createForumTopic,
  closeForumTopic,
  freeMem = () => Number.POSITIVE_INFINITY,
}) {
  return {
    project,
    projectRoot,
    worktreeRoot,
    stateDir,
    lock,
    spawn: spawn ?? makeFakeSpawn().spawn,
    runLock,
    gh,
    counter,
    buildScopedEnv,
    branchExists,
    obs,
    createForumTopic,
    closeForumTopic,
    freeMem,
  };
}

test("assertion 1: dispatch for issue 141 with createForumTopic->thread 707 — obs-141.json written with threadId 707, createForumTopic called BEFORE the tmux spawn, and the env-file threads HARNESS_OBSERVABILITY_RUN_PATH=<absolute obs-141.json path>", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const order = [];
    const fakeSpawn = makeFakeSpawn({ order });
    const fakeTopic = makeFakeCreateForumTopic({ order });
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: makeRealObsSeam(order),
      createForumTopic: fakeTopic.createForumTopic,
    });

    await dispatch({ number: 141, title: "fix billing race", body: "some body" }, opts);

    const meta = readObsMeta(stateDir, 141);
    assert.ok(meta, "obs-141.json must exist");
    assert.equal(meta.threadId, 707, "obs-141.json.threadId must be 707");

    const createIdx = order.indexOf("createForumTopic");
    const spawnTmuxIdx = order.findIndex((entry) => entry === "spawn:tmux");
    assert.notEqual(createIdx, -1, "createForumTopic must have been called");
    assert.notEqual(spawnTmuxIdx, -1, "the tmux spawn must have happened");
    assert.ok(createIdx < spawnTmuxIdx, "createForumTopic must be called BEFORE the tmux spawn");

    const envContent = readEnvFileContent(stateDir, 141);
    assert.ok(envContent, "dispatch must have written a scoped env-file for issue 141");
    const metaPath = join(stateDir, "obs-141.json");
    assert.ok(
      envContent.includes("HARNESS_OBSERVABILITY_RUN_PATH="),
      "the env-file must export HARNESS_OBSERVABILITY_RUN_PATH"
    );
    assert.ok(
      envContent.includes(metaPath),
      "the env-file's HARNESS_OBSERVABILITY_RUN_PATH value must be the absolute obs-141.json path"
    );
  } finally {
    cleanup();
  }
});

test("assertion 2: given obs-141.json already active with threadId 707 and a picked event already appended, a second dispatch does NOT call createForumTopic again, keeps threadId 707, and does not append a second picked event", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const worktreePath = join(worktreeRoot, "harness-demo-project-141");
    const metaPath = realCreateRun({ issueNumber: 141, project: "demo-project", worktreePath }, stateDir);
    realUpdateMeta(metaPath, { threadId: 707 });
    realAppendEvent(metaPath, { type: "picked" });

    const order = [];
    const fakeSpawn = makeFakeSpawn({ order });
    const fakeTopic = makeFakeCreateForumTopic({ order });
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: makeRealObsSeam(order),
      createForumTopic: fakeTopic.createForumTopic,
    });

    await dispatch({ number: 141, title: "fix billing race", body: "some body" }, opts);

    assert.equal(fakeTopic.calls.length, 0, "createForumTopic must NOT be called a second time for an already-active run");

    const meta = readObsMeta(stateDir, 141);
    assert.equal(meta.threadId, 707, "threadId must remain 707, unchanged by the idempotent requeue");

    const events = readObsEvents(stateDir, 141);
    const pickedCount = events.filter((e) => e.type === "picked").length;
    assert.equal(pickedCount, 1, "exactly one picked event must exist — no duplicate appended on requeue");
  } finally {
    cleanup();
  }
});

test("assertion 3: when createForumTopic returns a failure (falsy), dispatch proceeds with obs-141.json.status==='fallback', threadId null, and still exports HARNESS_OBSERVABILITY_RUN_PATH in the env-file", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const order = [];
    const fakeSpawn = makeFakeSpawn({ order });
    // The seam resolves a literal falsy value, exactly as the assertion prose states.
    const fakeTopic = makeFakeCreateForumTopic({ result: null, order });
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: makeRealObsSeam(order),
      createForumTopic: fakeTopic.createForumTopic,
    });

    await dispatch({ number: 141, title: "fix billing race", body: "some body" }, opts);

    const meta = readObsMeta(stateDir, 141);
    assert.ok(meta, "obs-141.json must exist even on createForumTopic failure");
    assert.equal(meta.status, "fallback", "status must be 'fallback' when createForumTopic fails");
    assert.equal(meta.threadId, null, "threadId must be null when createForumTopic fails");

    const envContent = readEnvFileContent(stateDir, 141);
    assert.ok(envContent, "dispatch must still write the scoped env-file on createForumTopic failure");
    assert.ok(
      envContent.includes("HARNESS_OBSERVABILITY_RUN_PATH="),
      "HARNESS_OBSERVABILITY_RUN_PATH must still be exported so events fall back to the shared topic"
    );
  } finally {
    cleanup();
  }
});

test("assertion 4: when createForumTopic succeeds (thread 707) but the tmux spawn throws, recoverSpawnFailure closes the created topic (closeForumTopic(707)) or marks obs-141.json.status==='orphan' — no orphan topic", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const order = [];
    const fakeSpawn = makeFakeSpawn({ failCommands: ["tmux"], order });
    const fakeTopic = makeFakeCreateForumTopic({ order });
    const fakeClose = makeFakeCloseForumTopic({ order });
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: makeRealObsSeam(order),
      createForumTopic: fakeTopic.createForumTopic,
      closeForumTopic: fakeClose.closeForumTopic,
    });

    try {
      await dispatch({ number: 141, title: "fix billing race", body: "some body" }, opts);
    } catch {
      // A spawn-failure path may legitimately surface as a thrown error after cleanup runs —
      // either way, the observables below are what this test pins.
    }

    const closedWithThread707 = fakeClose.calls.some((c) => c?.threadId === 707);
    const meta = readObsMeta(stateDir, 141);
    const markedOrphan = meta && meta.status === "orphan";
    assert.ok(
      closedWithThread707 || markedOrphan,
      "recoverSpawnFailure must either call closeForumTopic(707) or mark obs-141.json.status='orphan'"
    );
  } finally {
    cleanup();
  }
});

test("assertion 5: the env-file dispatch writes never contains the Telegram bot token — dispatch never sees or threads the token, only the pre-bound createForumTopic seam does", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const CANARY_TOKEN = "TG_CANARY_TOKEN_NEVER_IN_ENV_FILE_998877";
    const order = [];
    const fakeSpawn = makeFakeSpawn({ order });
    // The token is only ever known inside this closure (simulating the composition root's
    // already-bound seam) and is never handed to dispatch's opts at all.
    async function tokenBoundCreateForumTopic() {
      order.push("createForumTopic");
      void CANARY_TOKEN; // pretend this closure would use CANARY_TOKEN to call the real API
      return { ok: true, threadId: 707 };
    }
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: makeRealObsSeam(order),
      createForumTopic: tokenBoundCreateForumTopic,
    });

    await dispatch({ number: 141, title: "fix billing race", body: "some body" }, opts);

    const envContent = readEnvFileContent(stateDir, 141);
    assert.ok(envContent, "dispatch must have written a scoped env-file");
    assert.equal(
      envContent.includes(CANARY_TOKEN),
      false,
      "the env-file must never contain the Telegram bot token — only chatId/threadId/project/path are threaded"
    );

    for (const call of fakeSpawn.calls) {
      for (const arg of call.args ?? []) {
        assert.equal(
          typeof arg === "string" && arg.includes(CANARY_TOKEN),
          false,
          `spawned argv for ${call.command} must never contain the Telegram bot token`
        );
      }
      for (const value of Object.values(call.env ?? {})) {
        assert.equal(
          typeof value === "string" && value.includes(CANARY_TOKEN),
          false,
          `the env handed to the ${call.command} spawn must never contain the Telegram bot token`
        );
      }
    }
  } finally {
    cleanup();
  }
});

test("assertion 6: run-cron-a.mjs wires the REAL token-bound createForumTopic seam (resolved via readTelegramToken/makeNotifier reading ~/.claude/.dev.vars) — the token literal appears nowhere in the env-file bytes nor in any argv handed to spawn", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  const homeDir = mkdtempSync(join(tmpdir(), "cron-a-dispatch-obs-home-"));
  try {
    const REAL_TOKEN = "REAL_RUNTIME_DEVVARS_TOKEN_554433";
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(homeDir, ".claude", ".dev.vars"),
      `TELEGRAM_BOT_TOKEN=${REAL_TOKEN}\nTELEGRAM_CHAT_ID=999888\n`,
      "utf8"
    );

    const config = {
      project: "demo-project",
      owner: "demo-owner",
      repo: "demo-repo",
      projectRoot,
      stateDir,
      worktreeRoot,
      homeDir,
    };

    const fetchCalls = [];
    async function fakeFetch(url, requestOpts) {
      fetchCalls.push({ url, requestOpts });
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { message_thread_id: 707 } }),
      };
    }

    const spawnCalls = [];
    function fakeSpawn(command, args = [], spawnOpts = {}) {
      spawnCalls.push({ command, args, env: spawnOpts.env, cwd: spawnOpts.cwd });
      return { ok: true };
    }

    const runLock = makeFakeRunLock({ pid: 111, acquire_ts: 4242 });
    const gh = makeFakeGh();
    const counter = makeFakeCounter();

    // dispatchPromise captures dispatch's own return value regardless of whether runCronA's
    // internal composition awaits it — future-proof against runCronA staying synchronous while
    // dispatch itself becomes async.
    let dispatchPromise;
    const deps = {
      dispatch: (issue, opts) => dispatch(issue, { ...opts, freeMem: () => Number.POSITIVE_INFINITY }),
      cronASelect: (selectOpts) => {
        dispatchPromise = selectOpts.dispatch(
          { number: 141, title: "fix billing race", body: "some body" },
          { acquireTs: 4242 }
        );
        return { dispatched: false };
      },
      buildScopedEnvFromDisk: () => ({ PATH: "/usr/bin" }),
      ghExec: gh.gh,
      runLock,
      spawn: fakeSpawn,
      counter,
      tmuxHasSession: () => false,
      fetch: fakeFetch,
    };

    await runCronA(config, deps);
    await dispatchPromise;

    assert.ok(fetchCalls.length > 0, "the real token-bound createForumTopic wiring must actually perform a network call — proving it is not a bare no-token stub");
    assert.ok(
      fetchCalls.some((c) => typeof c.url === "string" && c.url.includes(REAL_TOKEN)),
      "the resolved createForumTopic seam must use the REAL token read from ~/.claude/.dev.vars at runtime"
    );

    const envContent = readEnvFileContent(stateDir, 141);
    if (envContent) {
      assert.equal(
        envContent.includes(REAL_TOKEN),
        false,
        "the token must NEVER land in the scoped env-file — it is resolved only via the runtime .dev.vars seam"
      );
    }

    for (const call of spawnCalls) {
      for (const arg of call.args ?? []) {
        assert.equal(
          typeof arg === "string" && arg.includes(REAL_TOKEN),
          false,
          `spawned argv for ${call.command} must never contain the Telegram bot token`
        );
      }
      for (const value of Object.values(call.env ?? {})) {
        assert.equal(
          typeof value === "string" && value.includes(REAL_TOKEN),
          false,
          `the env handed to the ${call.command} spawn must never contain the Telegram bot token`
        );
      }
    }
  } finally {
    cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("assertion 7: dispatch appends a {type:'picked'} event to obs-141.events.jsonl BEFORE the tmux spawn — the opening border checkpoint enters the outbox, not a direct notify", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const order = [];
    const fakeSpawn = makeFakeSpawn({ order });
    const fakeTopic = makeFakeCreateForumTopic({ order });
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: makeRealObsSeam(order),
      createForumTopic: fakeTopic.createForumTopic,
    });

    await dispatch({ number: 141, title: "fix billing race", body: "some body" }, opts);

    const events = readObsEvents(stateDir, 141);
    assert.ok(
      events.some((e) => e.type === "picked"),
      "a {type:'picked'} event must have been appended to the outbox"
    );

    const pickedIdx = order.indexOf("appendEvent:picked");
    const spawnTmuxIdx = order.findIndex((entry) => entry === "spawn:tmux");
    assert.notEqual(pickedIdx, -1, "the picked append must be observable in the recorded order");
    assert.notEqual(spawnTmuxIdx, -1, "the tmux spawn must have happened");
    assert.ok(pickedIdx < spawnTmuxIdx, "the picked event must be appended BEFORE the tmux spawn");
  } finally {
    cleanup();
  }
});

test("assertion 8: the topic name built for issue 141 with title 'fix billing race' STARTS WITH '[demo-project] #141' — the project + run identity prefix, never the bare title", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const order = [];
    const fakeSpawn = makeFakeSpawn({ order });
    const fakeTopic = makeFakeCreateForumTopic({ order });
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: makeRealObsSeam(order),
      createForumTopic: fakeTopic.createForumTopic,
    });

    await dispatch({ number: 141, title: "fix billing race", body: "some body" }, opts);

    assert.equal(fakeTopic.calls.length, 1, "createForumTopic must have been called exactly once");
    const { name } = fakeTopic.calls[0];
    assert.ok(
      typeof name === "string" && name.startsWith("[demo-project] #141"),
      "the topic name must START WITH the '[<project>] #141' project + run-identity prefix"
    );
    assert.notEqual(
      name,
      "fix billing race",
      "the topic name must NEVER be the bare title with no '[<project>] #141' prefix"
    );
  } finally {
    cleanup();
  }
});

test("assertion 9: given a 300-code-point title, the built topic name is <=128 code points AND still begins with '[demo-project] #141 · ' — the prefix is preserved, the TITLE is what gets truncated", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const order = [];
    const fakeSpawn = makeFakeSpawn({ order });
    const fakeTopic = makeFakeCreateForumTopic({ order });
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: makeRealObsSeam(order),
      createForumTopic: fakeTopic.createForumTopic,
    });

    const longTitle = "A".repeat(300);
    assert.equal(Array.from(longTitle).length, 300, "sanity: the fixture title must be exactly 300 code points");

    await dispatch({ number: 141, title: longTitle, body: "some body" }, opts);

    assert.equal(fakeTopic.calls.length, 1, "createForumTopic must have been called exactly once");
    const { name } = fakeTopic.calls[0];
    assert.ok(typeof name === "string", "createForumTopic must be called with a string name");
    assert.ok(
      Array.from(name).length <= 128,
      "the topic name must be truncated to at most 128 Unicode code points"
    );
    assert.ok(
      name.startsWith("[demo-project] #141 · "),
      "the '[<project>] #141 · ' project + run-identity prefix must be preserved — the TITLE is what gets truncated, never the prefix"
    );
  } finally {
    cleanup();
  }
});

test("assertion 10: after dispatch appends 'picked' for issue 141 (thread 707), the REAL drainTelegramOutbox delivers it via exactly one send call to thread 707 — produced then consumed end to end", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const order = [];
    const fakeSpawn = makeFakeSpawn({ order });
    const fakeTopic = makeFakeCreateForumTopic({ order });
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: makeRealObsSeam(order),
      createForumTopic: fakeTopic.createForumTopic,
    });

    await dispatch({ number: 141, title: "fix billing race", body: "some body" }, opts);

    const sendCalls = [];
    async function fakeSend(message) {
      sendCalls.push(message);
      return { sent: true };
    }

    await drainTelegramOutbox(
      { stateDir, chatId: "shared-chat-id", threadId: "shared-thread-id", limitPerMinute: 30 },
      { send: fakeSend }
    );

    const pickedSends = sendCalls.filter((m) => m.event && m.event.type === "picked");
    assert.equal(pickedSends.length, 1, "the picked event must be delivered by exactly one send call");
    assert.equal(pickedSends[0].threadId, 707, "the picked event must be routed to thread 707");
  } finally {
    cleanup();
  }
});

test("#ac-1.2 chatId is stamped from the seam's return — the successful-threadId updateMeta partial deep-equals exactly {threadId:77, chatId:-100123, status:'active'}, sourced from createForumTopic's own result, never from opts.notify.chatId", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const order = [];
    const fakeSpawn = makeFakeSpawn({ order });
    const fakeTopic = makeFakeCreateForumTopic({
      result: { ok: true, threadId: 77, chatId: -100123 },
      order,
    });
    const fakeObs = makeFakeObsSeam({ order });
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: fakeObs,
      createForumTopic: fakeTopic.createForumTopic,
    });
    // A DIFFERENT chatId injected on notify config — the test would fail if the implementation
    // read config.notify.chatId instead of the seam's own result.chatId.
    opts.notify = { chatId: -999999999, threadId: 1 };

    await dispatch({ number: 141, title: "fix billing race", body: "some body" }, opts);

    const call = fakeObs.updateMetaCalls.find((c) => "threadId" in c.partial);
    assert.ok(call, "the successful-threadId updateMeta call must have been recorded");
    assert.deepEqual(
      call.partial,
      { threadId: 77, chatId: -100123, status: "active" },
      "the successful-threadId updateMeta partial must deep-equal exactly {threadId, chatId, status}"
    );

    const otherChatIdWrites = fakeObs.updateMetaCalls.filter((c) => c !== call && "chatId" in c.partial);
    assert.equal(
      otherChatIdWrites.length,
      0,
      "no OTHER updateMeta call may write a chatId key"
    );
  } finally {
    cleanup();
  }
});

test("#ac-1.2 no chatId on the seam's return => no chatId key stamped (fail-closed) — the successful-threadId updateMeta partial has threadId 77 + status 'active' but NO chatId key at all, key absence not chatId===undefined", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const order = [];
    const fakeSpawn = makeFakeSpawn({ order });
    const fakeTopic = makeFakeCreateForumTopic({ result: { ok: true, threadId: 77 }, order });
    const fakeObs = makeFakeObsSeam({ order });
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fakeSpawn.spawn,
      obs: fakeObs,
      createForumTopic: fakeTopic.createForumTopic,
    });

    await dispatch({ number: 141, title: "fix billing race", body: "some body" }, opts);

    const call = fakeObs.updateMetaCalls.find((c) => "threadId" in c.partial);
    assert.ok(call, "the successful-threadId updateMeta call must have been recorded");
    assert.equal(call.partial.threadId, 77, "the partial's threadId must be 77");
    assert.equal(call.partial.status, "active", "the partial's status must be 'active'");
    assert.ok(
      !("chatId" in call.partial),
      "the partial must have NO chatId key at all — key absence, not chatId===undefined (fail-closed: an un-keyed meta stays permanently un-sweepable by the retention sweep)"
    );
  } finally {
    cleanup();
  }
});
