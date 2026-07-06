/**
 * @description Frozen contract tests for task-9 (obs run-topic close lifecycle + terminal-checkpoint
 * production), transcribed verbatim from
 * `.claude/plans/vps-run-observability/run/task-9-assertions.md` (10 pinned assertions). Exercises:
 *
 *   - `notifyExit()` (core/vps/cron-a-exit.mjs) — the composition root that (a) PRODUCES the run's
 *     terminal checkpoint into the outbox via `appendEvent` (existsSync-guarded on
 *     HARNESS_OBSERVABILITY_RUN_PATH, BEFORE the close, REPLACING the legacy direct
 *     session-done/blocked/failed sendNotification when the guard is set) and (b) CLOSES the run's
 *     forum topic reading the threadId from `obs-<issue>.json` (never the session), the close token
 *     resolved via `makeNotifier(config, { homeDir })` reading `~/.claude/.dev.vars` at runtime.
 *   - `reaper()` (core/vps/reaper.mjs) — the orphan-topic sweep: reads pre-enumerated obs-<issue>.json
 *     runs and closes topics for runs whose worktree is absent from the live worktree list, decoupled
 *     from the per-worktree holder-liveness scan; no double-close.
 *   - the REAL `closeForumTopic` / `drainTelegramOutbox` (core/vps/notify-telegram.mjs) and the REAL
 *     `readMeta` / `updateMeta` / `appendEvent` / `readEvents` (core/vps/obs-outbox.mjs) so the
 *     produced -> closed / produced -> drained lifecycle is exercised end to end, not pre-seeded.
 *
 * Every seam is injected exactly as these modules' existing dependency-injection convention already
 * does (mirrors cron-a-exit.test.mjs / reaper.test.mjs): a network call (`closeForumTopic`, `fetch`)
 * is faked or wrapped with a fake `fetch`; a pure file-persistence call (`readMeta`/`updateMeta`/
 * `appendEvent`/`readEvents`) uses the REAL obs-outbox implementation against a real temp stateDir so
 * on-disk state is an observable. `reaper()`'s new orphan-sweep seams (`listObsRuns`,
 * `liveWorktreePaths`) are named by symmetry with its existing `listWorktrees` seam (a zero-arg
 * producer of pre-resolved data — reaper.mjs never touches fs directly) and the spec's explicit
 * "decoupled from the live-worktree scan" wording; the composition root that will wire the real
 * enumeration is left to the executor.
 *
 * This file is RED before task-9 lands: cron-a-exit's `notifyExit` does not yet produce a terminal
 * checkpoint or close a topic, and `reaper()` does not yet sweep orphan topics, so every injected
 * fake above is left uncalled and each assertion fails as a clean AssertionError (never a crash).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { notifyExit } from "./cron-a-exit.mjs";
import { reaper } from "./reaper.mjs";
import { readMeta, updateMeta, appendEvent, readEvents } from "./obs-outbox.mjs";
import { closeForumTopic, drainTelegramOutbox } from "./notify-telegram.mjs";

/** @description Fresh temp root for one test, plus cleanup. */
function makeTempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** @description Writes a real obs-<issue>.json (+ empty sibling events log) mirroring obs-outbox's
 * createRun() shape, so readMeta/updateMeta/appendEvent/readEvents operate on real on-disk state. */
function writeObsMeta(stateDir, issueNumber, overrides = {}) {
  const metaPath = join(stateDir, `obs-${issueNumber}.json`);
  const meta = {
    issueNumber,
    project: "demo-project",
    worktreePath: `/fake/worktrees/harness-demo-project-${issueNumber}`,
    threadId: null,
    cursor: 0,
    status: "active",
    ...overrides,
  };
  writeFileSync(metaPath, JSON.stringify(meta), "utf8");
  writeFileSync(metaPath.replace(/\.json$/, ".events.jsonl"), "", "utf8");
  return metaPath;
}

/** @description Writes a real `~/.claude/.dev.vars`-style file under a temp home dir. */
function writeDevVars(homeDir, vars) {
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  const lines = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  writeFileSync(join(homeDir, ".claude", ".dev.vars"), `${lines}\n`, "utf8");
}

/** @description Base notifyExit() env: always carries HARNESS_NOTIFY_PROJECT (else notifyExit
 * no-ops as "not an engine-dispatched session") and, when given, HARNESS_OBSERVABILITY_RUN_PATH. */
function baseEnv({ homeDir, metaPath, project = "demo-project" } = {}) {
  const env = { HOME: homeDir, HARNESS_NOTIFY_PROJECT: project };
  if (metaPath !== undefined) env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;
  return env;
}

/** @description Fake closeForumTopic seam. Records every `(input, opts)` call; never touches the
 * network. Mirrors the real `closeForumTopic({ threadId }, opts)` signature. */
function makeFakeCloseForumTopic(result = { ok: true }) {
  const calls = [];
  const fn = (input, opts) => {
    calls.push({ input, opts });
    return Promise.resolve(result);
  };
  fn.calls = calls;
  return fn;
}

/** @description Fake fetch seam for the REAL closeForumTopic: records every (url, init) call and
 * resolves with a fixed status — never touches the network. */
function makeFakeFetch({ ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => ({ result: { message_thread_id: 707 } }) };
  };
  fn.calls = calls;
  return fn;
}

/** @description Wraps the REAL obs-outbox updateMeta with a call-recorder so a test can assert the
 * CANONICAL seam was invoked (not merely that the final on-disk state happens to match). */
function makeSpyUpdateMeta() {
  const calls = [];
  const fn = (metaPath, partial) => {
    calls.push({ metaPath, partial });
    return updateMeta(metaPath, partial);
  };
  fn.calls = calls;
  return fn;
}

// --- assertion 1 ------------------------------------------------------------------------------

/** @description Assertion 1: Given obs-141.json with threadId 707 and status 'active' and a
 * graceful exit, When cron-a-exit's close step runs, Then closeForumTopic was called with 707 and
 * obs-141.json.status==='closed' (written via the CANONICAL obs-outbox updateMeta seam). */
test("cron-a-exit close step: obs-141.json threadId 707 status 'active' + graceful exit -> closeForumTopic called with 707 and obs-141.json.status becomes 'closed' via obs-outbox updateMeta", async () => {
  const { root, cleanup } = makeTempRoot("obs-topic-close-1-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const homeDir = join(root, "home");
    writeDevVars(homeDir, { TELEGRAM_BOT_TOKEN: "tok-1", TELEGRAM_CHAT_ID: "555", TELEGRAM_THREAD_ID: "999" });
    const metaPath = writeObsMeta(stateDir, 141, { threadId: 707, status: "active" });

    const fakeClose = makeFakeCloseForumTopic({ ok: true });
    const updateMetaSpy = makeSpyUpdateMeta();
    const outcome = { outcome: "done", issueNumber: 141, hadPr: true, finding: null };

    await notifyExit(outcome, {
      env: baseEnv({ homeDir, metaPath }),
      prLookup: () => ({ number: 7, url: "https://github.com/x/y/pull/7" }),
      readMeta,
      updateMeta: updateMetaSpy,
      appendEvent,
      closeForumTopic: fakeClose,
    });

    assert.ok(
      fakeClose.calls.some((call) => call.input && call.input.threadId === 707),
      "closeForumTopic must be called with the obs-141.json threadId (707) on a graceful exit"
    );
    assert.ok(
      updateMetaSpy.calls.some((call) => call.metaPath === metaPath && call.partial && call.partial.status === "closed"),
      "the CANONICAL obs-outbox updateMeta seam must be called with { status: 'closed' } for obs-141.json"
    );
    const finalMeta = readMeta(metaPath);
    assert.equal(finalMeta && finalMeta.status, "closed", "obs-141.json.status must be 'closed' after the close step");
  } finally {
    cleanup();
  }
});

// --- assertion 2 ------------------------------------------------------------------------------

/** @description Assertion 2: Given obs-141.json already status 'closed', When the reaper orphan
 * sweep runs, Then closeForumTopic is NOT called for that thread (no double-close). */
test("reaper orphan sweep: obs-141.json already status 'closed' -> closeForumTopic is NOT called (no double-close)", () => {
  const { root, cleanup } = makeTempRoot("obs-topic-close-2-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const metaPath = writeObsMeta(stateDir, 141, { threadId: 707, status: "closed" });

    const fakeClose = makeFakeCloseForumTopic({ ok: true });

    reaper({
      listWorktrees: () => [],
      listObsRuns: () => [{ metaPath, meta: readMeta(metaPath) }],
      liveWorktreePaths: () => [],
      closeForumTopic: fakeClose,
      updateMeta,
    });

    assert.equal(
      fakeClose.calls.length,
      0,
      "closeForumTopic must NOT be called for an obs run whose status is already 'closed' (no double-close)"
    );
  } finally {
    cleanup();
  }
});

// --- assertion 3 ------------------------------------------------------------------------------

/** @description Assertion 3: Given obs-141.json status 'active' with thread 707 whose worktree is
 * absent from the live worktree list, When the reaper orphan sweep runs, Then closeForumTopic was
 * called with 707 and obs-141.json.status becomes 'closed' (via the CANONICAL obs-outbox
 * updateMeta, not a bespoke JSON rewrite). */
test("reaper orphan sweep: obs-141.json status 'active' thread 707 whose worktree is ABSENT from the live worktree list -> closeForumTopic called with 707 and status becomes 'closed' via obs-outbox updateMeta", () => {
  const { root, cleanup } = makeTempRoot("obs-topic-close-3-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const worktreePath = "/fake/worktrees/harness-demo-project-141";
    const metaPath = writeObsMeta(stateDir, 141, { threadId: 707, status: "active", worktreePath });

    const fakeClose = makeFakeCloseForumTopic({ ok: true });
    const updateMetaSpy = makeSpyUpdateMeta();

    reaper({
      listWorktrees: () => [],
      listObsRuns: () => [{ metaPath, meta: readMeta(metaPath) }],
      liveWorktreePaths: () => ["/fake/worktrees/harness-other-project-9"], // 141's worktree is absent
      closeForumTopic: fakeClose,
      updateMeta: updateMetaSpy,
    });

    assert.ok(
      fakeClose.calls.some((call) => call.input && call.input.threadId === 707),
      "an orphan run (worktree absent from the live worktree list) must have closeForumTopic called with its threadId (707)"
    );
    assert.ok(
      updateMetaSpy.calls.some((call) => call.metaPath === metaPath && call.partial && call.partial.status === "closed"),
      "the orphan sweep must write status:'closed' via the CANONICAL obs-outbox updateMeta seam, never a bespoke JSON rewrite"
    );
    const finalMeta = readMeta(metaPath);
    assert.equal(finalMeta && finalMeta.status, "closed", "obs-141.json.status must be 'closed' after the orphan sweep");
  } finally {
    cleanup();
  }
});

// --- assertion 4 ------------------------------------------------------------------------------

/** @description Assertion 4: Given obs-141.json status 'active' with thread 707 whose worktree IS
 * present in the live worktree list, When the reaper orphan sweep runs, Then closeForumTopic is NOT
 * called for 707 (a live run's topic is never closed). */
test("reaper orphan sweep: obs-141.json status 'active' thread 707 whose worktree IS present in the live worktree list -> closeForumTopic is NOT called (a live run's topic is never closed)", () => {
  const { root, cleanup } = makeTempRoot("obs-topic-close-4-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const worktreePath = "/fake/worktrees/harness-demo-project-141";
    const metaPath = writeObsMeta(stateDir, 141, { threadId: 707, status: "active", worktreePath });

    const fakeClose = makeFakeCloseForumTopic({ ok: true });

    reaper({
      listWorktrees: () => [],
      listObsRuns: () => [{ metaPath, meta: readMeta(metaPath) }],
      liveWorktreePaths: () => [worktreePath], // 141's worktree is live
      closeForumTopic: fakeClose,
      updateMeta,
    });

    assert.equal(
      fakeClose.calls.length,
      0,
      "closeForumTopic must NOT be called for a run whose worktree is present in the live worktree list"
    );
  } finally {
    cleanup();
  }
});

// --- assertion 5 ------------------------------------------------------------------------------

/** @description Assertion 5: Given cron-a-exit closes the run topic on graceful exit, When the
 * close token is resolved, Then it comes from makeNotifier(config,{homeDir}) reading
 * ~/.claude/.dev.vars (never a value read from the session env-file) and no token literal appears
 * in any log line. */
test("cron-a-exit close: the close token comes from makeNotifier(config,{homeDir}) reading ~/.claude/.dev.vars at runtime (never the session env-file), and no token literal appears in any log line", async () => {
  const { root, cleanup } = makeTempRoot("obs-topic-close-5-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const homeDir = join(root, "home");
    const devVarsToken = "devvars-secret-token-XYZ";
    const sessionEnvToken = "SESSION-ENV-TOKEN-MUST-NEVER-BE-USED";
    writeDevVars(homeDir, { TELEGRAM_BOT_TOKEN: devVarsToken, TELEGRAM_CHAT_ID: "555", TELEGRAM_THREAD_ID: "999" });
    const metaPath = writeObsMeta(stateDir, 141, { threadId: 707, status: "active" });

    const fakeFetch = makeFakeFetch({ ok: false, status: 403 }); // force the failure log path
    const logCalls = [];
    const outcome = { outcome: "done", issueNumber: 141, hadPr: true, finding: null };

    await notifyExit(outcome, {
      env: {
        ...baseEnv({ homeDir, metaPath }),
        // Simulates a bogus token threaded through the session env-file — must NEVER be the source.
        TELEGRAM_BOT_TOKEN: sessionEnvToken,
      },
      prLookup: () => ({ number: 7, url: "https://github.com/x/y/pull/7" }),
      readMeta,
      updateMeta,
      appendEvent,
      closeForumTopic, // the REAL closeForumTopic — no fake standing in for the token-resolution path
      fetch: fakeFetch,
      log: (entry) => logCalls.push(entry),
    });

    assert.ok(
      fakeFetch.calls.length >= 1,
      "the close step must issue a real closeForumTopic HTTP call once HARNESS_OBSERVABILITY_RUN_PATH is set"
    );
    assert.ok(
      fakeFetch.calls.some((call) => call.url.includes(devVarsToken)),
      "the token used to close the topic must be the one resolved from ~/.claude/.dev.vars via makeNotifier"
    );
    assert.ok(
      !fakeFetch.calls.some((call) => call.url.includes(sessionEnvToken)),
      "the close token must NEVER come from a value read off the session env-file"
    );
    const serializedLogs = JSON.stringify(logCalls);
    assert.ok(!serializedLogs.includes(devVarsToken), "no log line may ever contain the token literal");
  } finally {
    cleanup();
  }
});

// --- assertion 6 ------------------------------------------------------------------------------

/** @description Assertion 6: Given cron-a-exit's main()/notifyExit() composition root runs the
 * 'done' outcome for issue 141 with HARNESS_OBSERVABILITY_RUN_PATH set, When it produces the
 * terminal checkpoint, Then a {type:'PR', pr, url} event is appended to obs-141.events.jsonl BEFORE
 * the topic close, and NO direct session-done sendNotification is issued on the observability
 * path. */
test("cron-a-exit terminal checkpoint: 'done' outcome for issue 141 with HARNESS_OBSERVABILITY_RUN_PATH set -> {type:'PR', pr, url} appended to the outbox BEFORE the topic close, and no direct session-done sendNotification is issued", async () => {
  const { root, cleanup } = makeTempRoot("obs-topic-close-6-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const homeDir = join(root, "home");
    const metaPath = writeObsMeta(stateDir, 141, { threadId: 707, status: "active" });

    const order = [];
    const appendCalls = [];
    const wrappedAppendEvent = (path, event) => {
      order.push("append");
      appendCalls.push({ path, event });
      return appendEvent(path, event);
    };
    const wrappedClose = (input, opts) => {
      order.push("close");
      return Promise.resolve({ ok: true });
    };
    const notifyCalls = [];
    const fakeMakeNotifier = () => ({
      notify: (event) => {
        notifyCalls.push(event);
      },
      drain: async () => {},
      config: { token: "tok", chatId: 555, threadId: 999 },
    });

    const outcome = { outcome: "done", issueNumber: 141, hadPr: true, finding: null };

    await notifyExit(outcome, {
      env: baseEnv({ homeDir, metaPath }),
      prLookup: () => ({ number: 99, url: "https://github.com/x/y/pull/99" }),
      readMeta,
      updateMeta,
      appendEvent: wrappedAppendEvent,
      closeForumTopic: wrappedClose,
      makeNotifier: fakeMakeNotifier,
    });

    assert.ok(
      appendCalls.some(
        (call) => call.event.type === "PR" && call.event.pr === 99 && call.event.url === "https://github.com/x/y/pull/99"
      ),
      "a {type:'PR', pr, url} event must be appended to the outbox on the 'done' outcome"
    );
    assert.ok(
      order.includes("append") && order.includes("close") && order.indexOf("append") < order.indexOf("close"),
      "the terminal event append must happen BEFORE the topic close"
    );
    assert.ok(
      !notifyCalls.some((event) => event.type === "session-done"),
      "no direct session-done sendNotification may be issued on the observability path (the outbox append replaces it)"
    );
  } finally {
    cleanup();
  }
});

// --- assertion 7 ------------------------------------------------------------------------------

/** @description Assertion 7: Given the 'failed' outcome for issue 141 with
 * HARNESS_OBSERVABILITY_RUN_PATH set, When the composition root runs, Then a CRITICAL
 * {type:'failed'} event is appended to the outbox (the drain later sends it critical-first to the
 * shared topic). */
test("cron-a-exit terminal checkpoint: 'failed' outcome for issue 141 with HARNESS_OBSERVABILITY_RUN_PATH set -> a CRITICAL {type:'failed'} event is appended to the outbox", async () => {
  const { root, cleanup } = makeTempRoot("obs-topic-close-7-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const homeDir = join(root, "home");
    const metaPath = writeObsMeta(stateDir, 141, { threadId: 707, status: "active" });

    const outcome = { outcome: "failed", issueNumber: 141, hadPr: false, finding: null };

    await notifyExit(outcome, {
      env: baseEnv({ homeDir, metaPath }),
      readMeta,
      updateMeta,
      appendEvent,
      closeForumTopic: makeFakeCloseForumTopic({ ok: true }),
    });

    const events = readEvents(metaPath);
    assert.ok(
      events.some((event) => event.type === "failed"),
      "a CRITICAL {type:'failed'} event must be appended to obs-141.events.jsonl on the 'failed' outcome"
    );
  } finally {
    cleanup();
  }
});

// --- assertion 8 ------------------------------------------------------------------------------

/** @description Assertion 8: Given the 'blocked' outcome for issue 141 with
 * HARNESS_OBSERVABILITY_RUN_PATH set, When the composition root runs, Then a CRITICAL
 * {type:'blocked'} event is appended to the outbox (the drain later sends it critical-first to the
 * shared topic, mirroring the 'failed' terminal-checkpoint path). */
test("cron-a-exit terminal checkpoint: 'blocked' outcome for issue 141 with HARNESS_OBSERVABILITY_RUN_PATH set -> a CRITICAL {type:'blocked'} event is appended to the outbox", async () => {
  const { root, cleanup } = makeTempRoot("obs-topic-close-8-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const homeDir = join(root, "home");
    const metaPath = writeObsMeta(stateDir, 141, { threadId: 707, status: "active" });

    const outcome = { outcome: "blocked", issueNumber: 141, hadPr: false, finding: "adversary flagged a risk" };

    await notifyExit(outcome, {
      env: baseEnv({ homeDir, metaPath }),
      readMeta,
      updateMeta,
      appendEvent,
      closeForumTopic: makeFakeCloseForumTopic({ ok: true }),
    });

    const events = readEvents(metaPath);
    assert.ok(
      events.some((event) => event.type === "blocked"),
      "a CRITICAL {type:'blocked'} event must be appended to obs-141.events.jsonl on the 'blocked' outcome, mirroring the 'failed' path"
    );
  } finally {
    cleanup();
  }
});

// --- assertion 9 ------------------------------------------------------------------------------

/** @description Assertion 9: Given HARNESS_OBSERVABILITY_RUN_PATH UNSET, When notifyExit runs the
 * 'done' outcome, Then NO outbox event is written and the legacy direct session-done notify path
 * still fires (backward compatible, existsSync-guarded). */
test("cron-a-exit terminal checkpoint: HARNESS_OBSERVABILITY_RUN_PATH UNSET -> 'done' outcome writes NO outbox event, and the legacy direct session-done notify path still fires", async () => {
  const { root, cleanup } = makeTempRoot("obs-topic-close-9-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const homeDir = join(root, "home");
    // A real obs meta for issue 141 exists on disk, so a WRONGFUL write (guard ignored) is observable.
    const metaPath = writeObsMeta(stateDir, 141, { threadId: 707, status: "active" });

    const appendCalls = [];
    const notifyCalls = [];
    const fakeMakeNotifier = () => ({
      notify: (event) => {
        notifyCalls.push(event);
      },
      drain: async () => {},
      config: { token: "tok", chatId: 555, threadId: 999 },
    });

    const outcome = { outcome: "done", issueNumber: 141, hadPr: true, finding: null };

    await notifyExit(outcome, {
      // HARNESS_OBSERVABILITY_RUN_PATH deliberately absent — the legacy path must be byte-identical.
      env: baseEnv({ homeDir }),
      prLookup: () => ({ number: 99, url: "https://github.com/x/y/pull/99" }),
      readMeta,
      updateMeta,
      appendEvent: (path, event) => {
        appendCalls.push({ path, event });
        return appendEvent(path, event);
      },
      closeForumTopic: makeFakeCloseForumTopic({ ok: true }),
      makeNotifier: fakeMakeNotifier,
    });

    assert.equal(appendCalls.length, 0, "no outbox event may be written when HARNESS_OBSERVABILITY_RUN_PATH is unset");
    assert.equal(readEvents(metaPath).length, 0, "obs-141.events.jsonl must remain empty when the run-path guard is unset");
    assert.ok(
      notifyCalls.some((event) => event.type === "session-done"),
      "the legacy direct session-done notify path must still fire when HARNESS_OBSERVABILITY_RUN_PATH is unset (backward compatible)"
    );
  } finally {
    cleanup();
  }
});

// --- assertion 10 -----------------------------------------------------------------------------

/** @description Assertion 10: Given cron-a-exit appends the {type:'PR'} terminal event for issue
 * 141 (thread 707) and then the REAL drainTelegramOutbox runs, Then the PR checkpoint is delivered
 * to thread 707 by exactly one send (produced -> consumed end to end, not pre-seeded). */
test("cron-a-exit -> real drainTelegramOutbox: the appended {type:'PR'} terminal event for issue 141 (thread 707) is delivered to thread 707 by exactly one send", async () => {
  const { root, cleanup } = makeTempRoot("obs-topic-close-10-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const homeDir = join(root, "home");
    const metaPath = writeObsMeta(stateDir, 141, { threadId: 707, status: "active" });

    const outcome = { outcome: "done", issueNumber: 141, hadPr: true, finding: null };

    await notifyExit(outcome, {
      env: baseEnv({ homeDir, metaPath }),
      prLookup: () => ({ number: 99, url: "https://github.com/x/y/pull/99" }),
      readMeta,
      updateMeta,
      appendEvent,
      closeForumTopic: makeFakeCloseForumTopic({ ok: true }),
    });

    const sendCalls = [];
    const fakeSend = async ({ event, text, chatId, threadId }) => {
      sendCalls.push({ event, text, chatId, threadId });
      return { sent: true };
    };

    await drainTelegramOutbox({ stateDir, chatId: 555, threadId: 999 }, { send: fakeSend });

    const prSends = sendCalls.filter((call) => call.threadId === 707 && call.event && call.event.type === "PR");
    assert.equal(
      prSends.length,
      1,
      "the produced {type:'PR'} terminal event must be delivered to thread 707 by exactly one send (produced -> consumed end to end)"
    );
  } finally {
    cleanup();
  }
});
