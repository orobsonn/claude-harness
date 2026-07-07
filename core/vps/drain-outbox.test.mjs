/**
 * @description Frozen behavioral tests for `drainTelegramOutbox` (a NEW export expected on
 * ./notify-telegram.mjs) and its wiring into the Cron A composition root (./run-cron-a.mjs).
 * The function does not exist yet — every test below is expected to fail RED until it ships.
 *
 * Assumed minimal `send` seam contract (kept uniform across every test in this file, since the
 * real signature is not yet fixed): `send(message)` where
 * `message = { event, text, chatId, threadId }` — `text` is the fully rendered outbound body for
 * that message, `chatId`/`threadId` the resolved Telegram destination. `send` resolves
 * `{ sent: boolean }` (or throws/rejects to model a hard failure).
 *
 * Each test builds an isolated temp `stateDir` (and, where needed, a temp `worktreePath`) with
 * `mkdtempSync`, writes the `obs-<issue>.json` meta + `obs-<issue>.events.jsonl` events directly
 * via `node:fs` to set up the precondition, then drives `drainTelegramOutbox` with the REAL
 * `readEvents`/`readMeta`/`advanceCursor`/`updateMeta` from ./obs-outbox.mjs (so persistence is
 * real, on disk, in the temp dir) plus a per-test fake `send` seam.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { drainTelegramOutbox } from "./notify-telegram.mjs";
import { readEvents, readMeta, advanceCursor, updateMeta } from "./obs-outbox.mjs";
import { mainCronA } from "./run-cron-a.mjs";

/** @description Fresh temp state dir for one test's outbox fixtures. */
function makeStateDir() {
  return mkdtempSync(join(tmpdir(), "drain-outbox-state-"));
}

/** @description Path to obs-<issue>.json under a state dir. */
function metaPath(stateDir, issue) {
  return join(stateDir, `obs-${issue}.json`);
}

/** @description Writes the obs-<issue>.json meta fixture directly. */
function writeMeta(stateDir, issue, meta) {
  writeFileSync(metaPath(stateDir, issue), JSON.stringify(meta), "utf8");
}

/** @description Writes the obs-<issue>.events.jsonl events fixture directly. */
function writeEvents(stateDir, issue, events) {
  const eventsPath = join(stateDir, `obs-${issue}.events.jsonl`);
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  writeFileSync(eventsPath, events.length ? `${body}\n` : "", "utf8");
}

/** @description Reads back the current obs-<issue>.json meta as a plain object. */
function readMetaRaw(stateDir, issue) {
  return JSON.parse(readFileSync(metaPath(stateDir, issue), "utf8"));
}

const seams = { readEvents, readMeta, advanceCursor, updateMeta };

/**
 * @description #1 — Given an outbox with 3 events and cursor 1, When drainTelegramOutbox runs
 * and the send fake returns {sent:true} for events index 1 and 2, Then the meta cursor becomes 3
 * and exactly 2 send calls were made (each unsent event delivered once).
 */
test("drainTelegramOutbox advances the cursor from 1 to 3 and makes exactly 2 send calls when both unsent events ack", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141-a",
    threadId: 501,
    cursor: 1,
    status: "active",
  });
  writeEvents(stateDir, 141, [
    { type: "task-executing", task: "t0" },
    { type: "task-executing", task: "t1" },
    { type: "task-executing", task: "t2" },
  ]);

  const sendCalls = [];
  const send = async (message) => {
    sendCalls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 },
    { ...seams, send },
  );

  assert.strictEqual(readMetaRaw(stateDir, 141).cursor, 3);
  assert.strictEqual(sendCalls.length, 2, "each unsent event (index 1 and 2) is delivered exactly once");
});

/**
 * @description #2 — Given cursor 0 and 2 events, When the send fake returns {sent:false} (429)
 * for the event at index 0, Then the cursor stays 0 after the tick (no advance without an ack)
 * and the event is left for the next tick.
 */
test("drainTelegramOutbox leaves the cursor at 0 when the send seam returns {sent:false} for the first unsent event (429)", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 142, {
    issueNumber: 142,
    project: "demo",
    worktreePath: "/tmp/wt-142-a",
    threadId: 502,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 142, [
    { type: "task-executing", task: "t0" },
    { type: "task-executing", task: "t1" },
  ]);

  const send = async () => ({ sent: false });

  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 },
    { ...seams, send },
  );

  assert.strictEqual(readMetaRaw(stateDir, 142).cursor, 0, "no advance without an ack; the event is left for the next tick");
});

/**
 * @description #3 — Given a tick whose unsent events contain a per-task 'task-executing' progress
 * event AND a 'failed' critical event, When drainTelegramOutbox runs, Then the 'failed' ping is
 * sent BEFORE the progress event (critical first) and targets the shared main topic thread, not
 * the run thread.
 */
test("drainTelegramOutbox sends the 'failed' critical ping before the cosmetic progress event, targeting the shared main topic (not the run thread)", async () => {
  const stateDir = makeStateDir();
  const runThreadId = 707;
  writeMeta(stateDir, 143, {
    issueNumber: 143,
    project: "demo",
    worktreePath: "/tmp/wt-143-a",
    threadId: runThreadId,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 143, [
    { type: "task-executing", task: "t0" },
    { type: "failed", reason: "retries exhausted" },
  ]);

  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 },
    { ...seams, send },
  );

  const failedIndex = calls.findIndex((call) => call.event?.type === "failed");
  const progressIndex = calls.findIndex((call) => call.event?.type === "task-executing");
  assert.notStrictEqual(failedIndex, -1, "the failed ping was sent");
  assert.notStrictEqual(progressIndex, -1, "the progress event was sent");
  assert.ok(failedIndex < progressIndex, "the failed ping must be sent BEFORE the progress event (critical first)");
  assert.notStrictEqual(
    calls[failedIndex].threadId,
    runThreadId,
    "the critical ping must target the shared main topic thread, not the run's own thread",
  );
  assert.strictEqual(
    calls[failedIndex].chatId,
    999,
    "the critical ping must target the shared config chatId (the shared main topic destination)",
  );
  assert.ok(
    calls[failedIndex].threadId == null,
    "the critical ping must NOT carry a specific run thread — it targets the shared destination",
  );
});

/**
 * @description #4 — Given a 'failed' critical event for issue 141 whose run topic is thread 707,
 * When the critical ping is sent, Then its rendered body contains a reference to the run topic
 * (the string '141' or a t.me thread link) so the operator can jump to it.
 */
test("drainTelegramOutbox's rendered critical ping body references the run topic (issue number or a t.me link)", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141-b",
    threadId: 707,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "failed", reason: "retries exhausted" }]);

  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 },
    { ...seams, send },
  );

  const failedCall = calls.find((call) => call.event?.type === "failed");
  assert.ok(failedCall, "the failed ping was sent");
  const body = String(failedCall.text ?? "");
  assert.ok(
    body.includes("141") || /t\.me\//.test(body),
    "the rendered body must reference the run topic — the string '141' or a t.me thread link",
  );
});

/**
 * @description #5 — Given the state dir holds TWO active outboxes obs-141.json and obs-142.json
 * each with 1 unsent event, When drainTelegramOutbox runs for a SINGLE tick (readdir enumerates
 * both), Then BOTH runs' events are sent (one send call each) and both cursors advance to 1 in
 * that one tick.
 */
test("drainTelegramOutbox drains TWO active outboxes in a single tick (readdir enumerates both)", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141-c",
    threadId: 701,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "task-executing", task: "t0" }]);
  writeMeta(stateDir, 142, {
    issueNumber: 142,
    project: "demo",
    worktreePath: "/tmp/wt-142-c",
    threadId: 702,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 142, [{ type: "task-executing", task: "t0" }]);

  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 },
    { ...seams, send },
  );

  assert.strictEqual(calls.filter((call) => call.threadId === 701).length, 1, "run 141 got exactly one send");
  assert.strictEqual(calls.filter((call) => call.threadId === 702).length, 1, "run 142 got exactly one send");
  assert.strictEqual(readMetaRaw(stateDir, 141).cursor, 1);
  assert.strictEqual(readMetaRaw(stateDir, 142).cursor, 1);
});

/**
 * @description #6 — Given one active outbox with 1 unsent event and a send seam that THROWS,
 * When drainTelegramOutbox runs, Then it returns without throwing and the meta cursor is
 * unchanged (the event is deferred to the next tick — fail-open, no cursor corruption).
 */
test("drainTelegramOutbox never throws when the send seam throws, and leaves the cursor unchanged", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 144, {
    issueNumber: 144,
    project: "demo",
    worktreePath: "/tmp/wt-144-a",
    threadId: 703,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 144, [{ type: "task-executing", task: "t0" }]);

  const send = async () => {
    throw new Error("network exploded");
  };

  await assert.doesNotReject(
    drainTelegramOutbox(
      { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 },
      { ...seams, send },
    ),
  );

  assert.strictEqual(readMetaRaw(stateDir, 144).cursor, 0, "the event is deferred to the next tick, no cursor corruption");
});

/**
 * @description #7 — Given obs-141.json (thread 707) whose worktreePath contains
 * .claude/plans/f/spec.md and whose events have NO spec-created, When the drain tick runs
 * (derive-then-drain), Then a {type:'spec-created'} event is appended AND delivered by exactly
 * one send to thread 707 (produced→consumed in one module, not a pre-seeded event).
 */
test("drainTelegramOutbox derives a {type:'spec-created'} checkpoint from spec.md and delivers it by exactly one send", async () => {
  const stateDir = makeStateDir();
  const worktreePath = mkdtempSync(join(tmpdir(), "drain-outbox-wt-"));
  mkdirSync(join(worktreePath, ".claude", "plans", "f"), { recursive: true });
  writeFileSync(join(worktreePath, ".claude", "plans", "f", "spec.md"), "# spec\n", "utf8");

  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath,
    threadId: 707,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, []);

  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 },
    { ...seams, send },
  );

  const specEvents = readEvents(metaPath(stateDir, 141)).filter((event) => event.type === "spec-created");
  assert.strictEqual(specEvents.length, 1, "spec-created was appended exactly once (produced, not pre-seeded)");
  const specSends = calls.filter((call) => call.event?.type === "spec-created" && call.threadId === 707);
  assert.strictEqual(specSends.length, 1, "the derived spec-created checkpoint was delivered by exactly one send to thread 707");
});

/**
 * @description #8 — Given the worktreePath contains .claude/plans/f/execution-plan.json with 9
 * tasks and no plan-created event yet, When the drain tick runs TWICE, Then a single
 * {type:'plan-created', tasks:9} event is appended and delivered on the first tick and NO second
 * plan-created is appended (nor delivered) on the second tick (idempotent append-if-absent AND
 * idempotent delivery).
 */
test("drainTelegramOutbox derives {type:'plan-created', tasks:9} once, idempotently across two ticks", async () => {
  const stateDir = makeStateDir();
  const worktreePath = mkdtempSync(join(tmpdir(), "drain-outbox-wt-"));
  mkdirSync(join(worktreePath, ".claude", "plans", "f"), { recursive: true });
  writeFileSync(
    join(worktreePath, ".claude", "plans", "f", "execution-plan.json"),
    JSON.stringify({ tasks: Array.from({ length: 9 }, (_, i) => ({ id: `task-${i}` })) }),
    "utf8",
  );

  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath,
    threadId: 707,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, []);

  const opts = { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 };
  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox(opts, { ...seams, send });
  const afterFirstTick = readEvents(metaPath(stateDir, 141)).filter((event) => event.type === "plan-created");
  assert.strictEqual(afterFirstTick.length, 1, "plan-created is appended on the first tick");
  assert.strictEqual(afterFirstTick[0].tasks, 9);
  const planSendsAfterFirstTick = calls.filter(
    (call) => call.event?.type === "plan-created" && call.threadId === 707,
  );
  assert.strictEqual(
    planSendsAfterFirstTick.length,
    1,
    "the derived plan-created checkpoint was delivered by exactly one send to thread 707 on the first tick",
  );

  await drainTelegramOutbox(opts, { ...seams, send });
  const afterSecondTick = readEvents(metaPath(stateDir, 141)).filter((event) => event.type === "plan-created");
  assert.strictEqual(afterSecondTick.length, 1, "a second tick must NOT append a duplicate plan-created event");
  const planSendsAfterSecondTick = calls.filter(
    (call) => call.event?.type === "plan-created" && call.threadId === 707,
  );
  assert.strictEqual(
    planSendsAfterSecondTick.length,
    1,
    "a second tick must NOT deliver a duplicate plan-created send (still exactly one, cumulative across both ticks)",
  );
});

/**
 * @description #9 — Given obs-141.json with status 'fallback' (threadId null) and 1 unsent run
 * event, When the drain runs, Then the send targets the SHARED config threadId (not a run
 * thread) AND the rendered message body contains '#141' (per-message run identity on the
 * fallback path — #ac-1.2).
 */
test("drainTelegramOutbox routes a fallback-status run to the shared config threadId with a '#141' prefix in the body", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141-d",
    threadId: null,
    cursor: 0,
    status: "fallback",
  });
  writeEvents(stateDir, 141, [{ type: "task-executing", task: "t0" }]);

  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 },
    { ...seams, send },
  );

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].chatId, 999, "the send targets the shared config chatId");
  assert.ok(calls[0].threadId == null, "the send must NOT target a specific run thread (fallback → shared destination)");
  assert.ok(String(calls[0].text ?? "").includes("#141"), "the rendered body must carry the '#141' per-message run-identity prefix");
});

/**
 * @description #10 — Given obs-141.json with status 'closed', cursor 0, and 1 unsent 'PR' event,
 * When the drain runs, Then the 'PR' event is delivered by one send (a closed-but-undrained run
 * is NOT skipped) and the cursor advances to 1.
 */
test("drainTelegramOutbox still drains a 'closed' run with an unsent event instead of skipping it", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141-e",
    threadId: 707,
    cursor: 0,
    status: "closed",
  });
  writeEvents(stateDir, 141, [{ type: "pr", pr: 55 }]);

  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 },
    { ...seams, send },
  );

  assert.strictEqual(calls.length, 1, "the closed-but-undrained run's PR event was delivered by one send, not skipped");
  assert.strictEqual(readMetaRaw(stateDir, 141).cursor, 1);
});

/**
 * @description #11 — Given an outbox with events [progress@index0, blocked@index1] and cursor 0,
 * When drainTelegramOutbox runs a tick where the critical 'blocked' send succeeds but the
 * cosmetic 'progress' send at index 0 returns {sent:false} (429), Then within the tick 'blocked'
 * was sent FIRST (before the progress attempt) via the separate critical path, the cosmetic
 * cursor stays 0 (progress@0 not lost), and on the NEXT tick 'blocked' is NOT re-sent (deduped by
 * its per-critical sent-marker) while progress@0 is retried — the critical path never flows
 * through nor blocks the cosmetic cursor.
 */
test("drainTelegramOutbox sends 'blocked' first via the critical path, keeps the cosmetic cursor at 0 on a 429, and dedupes 'blocked' on the next tick while retrying progress@0", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 145, {
    issueNumber: 145,
    project: "demo",
    worktreePath: "/tmp/wt-145-a",
    threadId: 709,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 145, [
    { type: "task-executing", task: "t0" },
    { type: "blocked", reason: "needs human input" },
  ]);

  const opts = { stateDir, homeDir: stateDir, chatId: 999, limitPerMinute: 30 };

  const tick1Calls = [];
  const tick1Send = async (message) => {
    tick1Calls.push(message);
    if (message.event?.type === "blocked") return { sent: true };
    return { sent: false };
  };
  await drainTelegramOutbox(opts, { ...seams, send: tick1Send });

  const blockedIndexTick1 = tick1Calls.findIndex((call) => call.event?.type === "blocked");
  const progressIndexTick1 = tick1Calls.findIndex((call) => call.event?.type === "task-executing");
  assert.notStrictEqual(blockedIndexTick1, -1, "blocked was sent in tick 1");
  assert.notStrictEqual(progressIndexTick1, -1, "the cosmetic progress send was attempted in tick 1");
  assert.ok(blockedIndexTick1 < progressIndexTick1, "blocked must be sent BEFORE the cosmetic progress attempt");
  assert.strictEqual(
    readMetaRaw(stateDir, 145).cursor,
    0,
    "the cosmetic cursor must not advance — progress@0 was not acked, and it is not lost",
  );

  const tick2Calls = [];
  const tick2Send = async (message) => {
    tick2Calls.push(message);
    return { sent: true };
  };
  await drainTelegramOutbox(opts, { ...seams, send: tick2Send });

  assert.strictEqual(
    tick2Calls.filter((call) => call.event?.type === "blocked").length,
    0,
    "blocked must be deduped by its per-critical sent-marker on the next tick",
  );
  assert.strictEqual(
    tick2Calls.filter((call) => call.event?.type === "task-executing").length,
    1,
    "the cosmetic progress@0 event is retried on the next tick",
  );
  assert.strictEqual(readMetaRaw(stateDir, 145).cursor, 1, "after the retried ack, the cosmetic cursor advances past progress@0");
});

/**
 * @description #12 — Given cronASelect returns {dispatched:false} and the stateDir holds
 * obs-141.json with one pending (unsent) event, When the run-cron-a composition root
 * (mainCronA/runCronA) runs the tick with injected drain/send seams, Then drainTelegramOutbox is
 * invoked exactly once that tick and the pending event is sent / the cursor advances — proving
 * the PRODUCTION idle-tick call path actually wires the drain, not a test calling
 * drainTelegramOutbox directly.
 */
test("run-cron-a's composition root invokes drainTelegramOutbox exactly once per tick, even on an idle tick (dispatched:false)", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141-f",
    threadId: 707,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "task-executing", task: "t0" }]);

  const homeDir = mkdtempSync(join(tmpdir(), "drain-outbox-home-"));
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  writeFileSync(join(homeDir, ".claude", ".dev.vars"), "TELEGRAM_BOT_TOKEN=fake-token\n", "utf8");

  const config = {
    project: "demo",
    owner: "acme",
    repo: "widgets",
    projectRoot: "/tmp/demo-root",
    stateDir,
    worktreeRoot: "/tmp/demo-worktrees",
    homeDir,
    notify: { chatId: 999 },
  };

  let drainCallCount = 0;
  const drainOutboxSpy = async (drainOpts, drainSeams) => {
    drainCallCount += 1;
    return drainTelegramOutbox(drainOpts, { ...drainSeams, send: async () => ({ sent: true }) });
  };

  await mainCronA(config, {
    cronASelect: () => ({ ok: true, dispatched: false }),
    drainOutbox: drainOutboxSpy,
  });

  assert.strictEqual(drainCallCount, 1, "drainTelegramOutbox must be invoked exactly once per tick, even when idle");
  assert.strictEqual(
    readMetaRaw(stateDir, 141).cursor,
    1,
    "the pending event was sent and the cursor advanced through the PRODUCTION wiring, not a direct test call",
  );
});

/**
 * @description #13 (curated feed) — Given events [curated, regate-pending, curated] and cursor 0,
 * When the drain runs, Then `regate-pending` is neither sent via the critical path (it is no longer
 * a CRITICAL type) nor via the cosmetic path (it is not curated) — ONLY the 2 curated events are
 * sent — AND the cursor still advances past all three. The critical invariant: a suppressed event
 * must ack-advance the contiguous cursor, never jam the outbox and starve later milestones.
 */
test("drainTelegramOutbox suppresses a regate-pending between two curated events (no critical ping, no cosmetic send) while the cursor advances past all three", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 150, {
    issueNumber: 150,
    project: "demo",
    worktreePath: "/tmp/wt-150-a",
    threadId: 710,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 150, [
    { type: "pipeline-type", mode: "FULL" },
    { type: "regate-pending", task: "task-5", matched: false },
    { type: "pr", pr: 55 },
  ]);

  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox({ stateDir, homeDir: stateDir, chatId: 999 }, { ...seams, send });

  assert.deepStrictEqual(
    calls.map((call) => call.event?.type),
    ["pipeline-type", "pr"],
    "only the two curated events are sent — regate-pending is suppressed from the feed entirely",
  );
  assert.strictEqual(
    calls.filter((call) => call.event?.type === "regate-pending").length,
    0,
    "regate-pending must NOT ride the critical path either — it is no longer a critical type",
  );
  assert.strictEqual(
    readMetaRaw(stateDir, 150).cursor,
    3,
    "the cursor must advance past the suppressed regate-pending — a suppressed event never jams the contiguous cursor",
  );
});

/**
 * @description #14 (curated feed) — Given only non-curated events ('eye', 'picked') and cursor 0,
 * When the drain runs, Then NO send is made but the cursor advances past both (suppress-but-ack).
 */
test("drainTelegramOutbox suppresses non-curated types (eye, regate-pending) with zero sends while still ack-advancing the cursor", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 151, {
    issueNumber: 151,
    project: "demo",
    worktreePath: "/tmp/wt-151-a",
    threadId: 711,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 151, [
    { type: "eye", role: "compliance" },
    { type: "regate-pending", task: "task-1", matched: false },
  ]);

  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox({ stateDir, homeDir: stateDir, chatId: 999 }, { ...seams, send });

  assert.strictEqual(calls.length, 0, "non-curated audit events must never reach the feed");
  assert.strictEqual(
    readMetaRaw(stateDir, 151).cursor,
    2,
    "the cursor must advance past every suppressed event",
  );
});

/**
 * @description #15 (curated feed) — Given one event of EVERY curated type, When the drain runs,
 * Then all of them are sent, in order, and the cursor advances past all of them.
 */
test("drainTelegramOutbox sends every curated type (pipeline-type, spec-created, spec-adversary, plan-created, plan-reviewed, task-executing, hand-ran, final-review-done, pr)", async () => {
  const stateDir = makeStateDir();
  const curatedEvents = [
    { type: "pipeline-type", mode: "FULL" },
    { type: "spec-created" },
    { type: "spec-adversary" },
    { type: "plan-created", tasks: 4 },
    { type: "plan-reviewed", verdict: "APPROVE" },
    { type: "task-executing", n: 1, total: 4 },
    { type: "hand-ran", task: "task-1", model: "glm-5.2" },
    { type: "final-review-done" },
    { type: "pr", pr: 88 },
  ];
  writeMeta(stateDir, 152, {
    issueNumber: 152,
    project: "demo",
    worktreePath: "/tmp/wt-152-a",
    threadId: 712,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 152, curatedEvents);

  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox({ stateDir, homeDir: stateDir, chatId: 999 }, { ...seams, send });

  assert.deepStrictEqual(
    calls.map((call) => call.event?.type),
    curatedEvents.map((event) => event.type),
    "every curated type must be sent, in outbox order",
  );
  assert.strictEqual(readMetaRaw(stateDir, 152).cursor, curatedEvents.length);
});

/**
 * @description #16 (curated renderer) — Given plan-reviewed (APPROVE and REVISE) and hand-ran
 * events, When the drain renders them, Then each title is the status emoji + the pt-br label
 * ('Revisão do plano' / 'Tarefa implementada'), the plan-reviewed body reflects the verdict
 * ('aprovado' / 'requer revisão'), and the hand-ran body carries the model.
 */
test("drainTelegramOutbox renders emoji + pt-br titles, verdict-aware plan-reviewed bodies, and the model in the hand-ran body", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 153, {
    issueNumber: 153,
    project: "demo",
    worktreePath: "/tmp/wt-153-a",
    threadId: 713,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 153, [
    { type: "plan-reviewed", verdict: "APPROVE" },
    { type: "plan-reviewed", verdict: "REVISE" },
    { type: "hand-ran", task: "task-3", model: "glm-5.2" },
  ]);

  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return { sent: true };
  };

  await drainTelegramOutbox({ stateDir, homeDir: stateDir, chatId: 999 }, { ...seams, send });

  assert.strictEqual(calls.length, 3);

  // Titles keep natural case (<b>🧐 Revisão do plano</b> — …); asserted case-insensitively.
  const [approve, revise, handRan] = calls.map((call) => String(call.text ?? "").toLowerCase());
  assert.ok(approve.includes("🧐"), "the plan-reviewed title must carry its status emoji");
  assert.ok(approve.includes("revisão do plano"), "the plan-reviewed title must carry the pt-br label");
  assert.ok(approve.includes("aprovado"), "the APPROVE body must read 'aprovado'");
  assert.ok(revise.includes("requer revisão"), "the REVISE body must read 'requer revisão'");
  assert.ok(handRan.includes("✋"), "the hand-ran title must carry its status emoji");
  assert.ok(handRan.includes("tarefa implementada"), "the hand-ran title must carry the pt-br label");
  assert.ok(handRan.includes("glm-5.2"), "the hand-ran body must carry the model");
  assert.ok(handRan.includes("task-3"), "the hand-ran body must carry the task");
});

/**
 * @description #17 (one-line format) — Given a curated event with body info, When rendered, Then the
 * message is a SINGLE line `<b><emoji> <label></b> — <info>` (no blank line, no <i> body block); an
 * event with no info renders the title alone.
 */
test("drainTelegramOutbox renders each checkpoint as a single line (title — info), no multi-line body block", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 160, {
    issueNumber: 160, project: "demo", worktreePath: "/tmp/wt-160-a", threadId: 720, cursor: 0, status: "active",
  });
  writeEvents(stateDir, 160, [
    { type: "pipeline-type", mode: "LIGHT" },
    { type: "spec-created" },
  ]);

  const calls = [];
  const send = async (message) => { calls.push(message); return { sent: true }; };
  await drainTelegramOutbox({ stateDir, homeDir: stateDir, chatId: 999 }, { ...seams, send });

  const [classify, spec] = calls.map((call) => String(call.text ?? ""));
  assert.strictEqual(classify, "<b>🚀 Classificação</b> — modo LIGHT", "classify is one line: title — info");
  assert.strictEqual(spec, "<b>📝 Spec criada</b>", "an info-less checkpoint is the title alone");
  assert.ok(!classify.includes("\n") && !spec.includes("\n"), "no checkpoint may span multiple lines");
  assert.ok(!classify.includes("<i>"), "the single-line format carries no <i> body block");
});

/**
 * @description #18 (spec-adversary emoji) — Given a spec-adversary checkpoint, When rendered, Then
 * the title carries the 🛡️ emoji (regression: it used to fall through to the 🔔 fallback).
 */
test("drainTelegramOutbox renders spec-adversary with the 🛡️ emoji, not the 🔔 fallback", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 161, {
    issueNumber: 161, project: "demo", worktreePath: "/tmp/wt-161-a", threadId: 721, cursor: 0, status: "active",
  });
  writeEvents(stateDir, 161, [{ type: "spec-adversary" }]);

  const calls = [];
  const send = async (message) => { calls.push(message); return { sent: true }; };
  await drainTelegramOutbox({ stateDir, homeDir: stateDir, chatId: 999 }, { ...seams, send });

  const text = String(calls[0]?.text ?? "");
  assert.ok(text.includes("🛡️"), "spec-adversary must carry the 🛡️ emoji");
  assert.ok(!text.includes("🔔"), "spec-adversary must NOT fall through to the 🔔 fallback emoji");
});

/**
 * @description #19 (numbered plan review) — Given plan-reviewed events carrying a `round`, When
 * rendered, Then the body reads "revisão N — <verdict>"; a plan-reviewed with no round renders the
 * verdict alone (legacy / mark.mjs fallback).
 */
test("drainTelegramOutbox renders 'revisão N — <verdict>' when a plan-reviewed carries a round", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 162, {
    issueNumber: 162, project: "demo", worktreePath: "/tmp/wt-162-a", threadId: 722, cursor: 0, status: "active",
  });
  writeEvents(stateDir, 162, [
    { type: "plan-reviewed", verdict: "REVISE", round: 1 },
    { type: "plan-reviewed", verdict: "APPROVE", round: 2 },
    { type: "plan-reviewed", verdict: "APPROVE" },
  ]);

  const calls = [];
  const send = async (message) => { calls.push(message); return { sent: true }; };
  await drainTelegramOutbox({ stateDir, homeDir: stateDir, chatId: 999 }, { ...seams, send });

  const [r1, r2, noRound] = calls.map((call) => String(call.text ?? ""));
  assert.ok(r1.includes("revisão 1 — requer revisão"), "round-1 REVISE reads 'revisão 1 — requer revisão'");
  assert.ok(r2.includes("revisão 2 — aprovado"), "round-2 APPROVE reads 'revisão 2 — aprovado'");
  assert.ok(noRound.endsWith("aprovado") && !noRound.includes("revisão 3"), "a round-less plan-reviewed renders the verdict alone");
});

/**
 * @description #20 (send spacing) — Given N unsent events and opts.sendDelayMs > 0 with an injected
 * `sleep` spy, When the drain runs, Then `sleep` is called BETWEEN sends (N-1 times), each with the
 * configured delay — spacing the burst so it never trips Telegram's rate limit.
 */
test("drainTelegramOutbox paces sends: sleep is called between consecutive sends when sendDelayMs > 0", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 163, {
    issueNumber: 163, project: "demo", worktreePath: "/tmp/wt-163-a", threadId: 723, cursor: 0, status: "active",
  });
  writeEvents(stateDir, 163, [
    { type: "task-executing", n: 1, total: 3 },
    { type: "task-executing", n: 2, total: 3 },
    { type: "task-executing", n: 3, total: 3 },
  ]);

  const sleepCalls = [];
  const sleep = async (ms) => { sleepCalls.push(ms); };
  const send = async () => ({ sent: true });
  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999, sendDelayMs: 1100 },
    { ...seams, send, sleep },
  );

  assert.strictEqual(sleepCalls.length, 2, "3 sends → sleep is called 2 times (between, never before the first)");
  assert.ok(sleepCalls.every((ms) => ms === 1100), "each pace uses the configured delay");
});

/**
 * @description #21 (spacing off by default) — Given events and NO sendDelayMs, When the drain runs
 * with an injected sleep spy, Then sleep is NEVER called (default = no spacing keeps the frozen drain
 * tests fast); and the delay passed to sleep is clamped so a huge sendDelayMs cannot hang the cron.
 */
test("drainTelegramOutbox does not pace when sendDelayMs is absent, and clamps an oversized delay", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 164, {
    issueNumber: 164, project: "demo", worktreePath: "/tmp/wt-164-a", threadId: 724, cursor: 0, status: "active",
  });
  writeEvents(stateDir, 164, [{ type: "task-executing", n: 1, total: 1 }, { type: "pr", pr: 9 }]);

  const noDelayCalls = [];
  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999 },
    { ...seams, send: async () => ({ sent: true }), sleep: async (ms) => noDelayCalls.push(ms) },
  );
  assert.strictEqual(noDelayCalls.length, 0, "no spacing when sendDelayMs is absent (default 0)");

  const stateDir2 = makeStateDir();
  writeMeta(stateDir2, 165, {
    issueNumber: 165, project: "demo", worktreePath: "/tmp/wt-165-a", threadId: 725, cursor: 0, status: "active",
  });
  writeEvents(stateDir2, 165, [{ type: "task-executing", n: 1, total: 1 }, { type: "pr", pr: 9 }]);
  const clampCalls = [];
  await drainTelegramOutbox(
    { stateDir: stateDir2, homeDir: stateDir2, chatId: 999, sendDelayMs: 999999 },
    { ...seams, send: async () => ({ sent: true }), sleep: async (ms) => clampCalls.push(ms) },
  );
  assert.ok(clampCalls.length >= 1 && clampCalls.every((ms) => ms <= 3000), "an oversized sendDelayMs is clamped to <= 3000ms");
});

/**
 * @description #22 (production wiring — FURO 7 guard) — Given the run-cron-a composition root runs a
 * tick, Then it passes a positive sendDelayMs AND limitPerMinute:20 to the drain — so spacing can
 * never silently regress to a burst by someone forgetting to wire it.
 */
test("run-cron-a wires sendDelayMs > 0 and limitPerMinute 20 into the drain (spacing cannot silently regress)", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141, project: "demo", worktreePath: "/tmp/wt-141-g", threadId: 707, cursor: 0, status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "task-executing", n: 1, total: 1 }]);

  const homeDir = mkdtempSync(join(tmpdir(), "drain-outbox-home-"));
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  writeFileSync(join(homeDir, ".claude", ".dev.vars"), "TELEGRAM_BOT_TOKEN=fake-token\n", "utf8");

  const config = {
    project: "demo", owner: "acme", repo: "widgets", projectRoot: "/tmp/demo-root",
    stateDir, worktreeRoot: "/tmp/demo-worktrees", homeDir, notify: { chatId: 999 },
  };

  let seenOpts = null;
  const drainOutboxSpy = async (drainOpts) => { seenOpts = drainOpts; };

  await mainCronA(config, {
    cronASelect: () => ({ ok: true, dispatched: false }),
    drainOutbox: drainOutboxSpy,
  });

  assert.ok(seenOpts, "the drain was invoked");
  assert.ok(typeof seenOpts.sendDelayMs === "number" && seenOpts.sendDelayMs > 0, "run-cron-a must wire a positive sendDelayMs");
  assert.strictEqual(seenOpts.limitPerMinute, 20, "run-cron-a must cap sends at 20/min (Telegram's per-group limit)");
});

/**
 * @description #25 (global-group attribution) — Given a 'failed' critical event whose run meta carries
 * project 'proj-x', When the critical ping is rendered for the shared global topic, Then its body
 * leads with '[proj-x]' so the operator knows WHICH project the error came from (the global topic mixes
 * every project's error/extraordinary events).
 */
test("drainTelegramOutbox's critical ping (shared global topic) leads with the [project] tag", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141, project: "proj-x", worktreePath: "/tmp/wt-141-px", threadId: 707, cursor: 0, status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "failed", reason: "retries exhausted" }]);

  const calls = [];
  const send = async (message) => { calls.push(message); return { sent: true }; };
  await drainTelegramOutbox({ stateDir, homeDir: stateDir, chatId: 999 }, { ...seams, send });

  const body = String(calls.find((c) => c.event?.type === "failed")?.text ?? "");
  assert.ok(body.includes("[proj-x]"), "the critical ping must lead with the [project] tag");
  assert.ok(body.includes("141"), "the critical ping still references the run topic");
});

/**
 * @description #26 (fallback attribution) — Given a fallback-status run for project 'proj-y', When a
 * cosmetic event is routed to the shared topic, Then the body prefix is '[proj-y] #<issue>' so a
 * fallback (per-run topic creation failed) is still attributable to its project.
 */
test("drainTelegramOutbox's fallback cosmetic body prefixes '[project] #issue'", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 142, {
    issueNumber: 142, project: "proj-y", worktreePath: "/tmp/wt-142-py", threadId: null, cursor: 0, status: "fallback",
  });
  writeEvents(stateDir, 142, [{ type: "pipeline-type", mode: "LIGHT" }]);

  const calls = [];
  const send = async (message) => { calls.push(message); return { sent: true }; };
  await drainTelegramOutbox({ stateDir, homeDir: stateDir, chatId: 999 }, { ...seams, send });

  assert.ok(String(calls[0]?.text ?? "").includes("[proj-y] #142"), "fallback body must carry '[project] #issue'");
});

/** @description Builds a minimal valid cron config + a homeDir carrying a fake token. */
function cronConfigWith(stateDir) {
  const homeDir = mkdtempSync(join(tmpdir(), "drain-outbox-home-"));
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  writeFileSync(join(homeDir, ".claude", ".dev.vars"), "TELEGRAM_BOT_TOKEN=fake-token\n", "utf8");
  return {
    project: "demo", owner: "acme", repo: "widgets", projectRoot: "/tmp/demo-root",
    stateDir, worktreeRoot: "/tmp/demo-worktrees", homeDir, notify: { chatId: 999 },
  };
}

/**
 * @description #22b (real default sleep settles) — Given sendDelayMs > 0 and NO injected sleep seam
 * (the real defaultSleep runs), When the drain runs, Then it settles and delivers every event with
 * the cursor advanced — a regression guard that the pacing timer keeps the process alive on the
 * critical path (a mid-pace early exit would truncate the remaining sends).
 */
test("drainTelegramOutbox settles with the REAL default sleep on the critical path and delivers every event", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 166, {
    issueNumber: 166, project: "demo", worktreePath: "/tmp/wt-166-a", threadId: 726, cursor: 0, status: "active",
  });
  writeEvents(stateDir, 166, [
    { type: "task-executing", n: 1, total: 3 },
    { type: "task-executing", n: 2, total: 3 },
    { type: "task-executing", n: 3, total: 3 },
  ]);

  const calls = [];
  const send = async (message) => { calls.push(message); return { sent: true }; };
  // Real defaultSleep (no sleep seam), tiny delay so the test stays fast.
  await drainTelegramOutbox(
    { stateDir, homeDir: stateDir, chatId: 999, sendDelayMs: 5 },
    { ...seams, send },
  );

  assert.strictEqual(calls.length, 3, "every event was delivered — the drain did not truncate mid-pace");
  assert.strictEqual(readMetaRaw(stateDir, 166).cursor, 3, "the cursor advanced past all events");
});

/**
 * @description #23 (drain.lock stale-reclaim) — Given an ORPHAN drain.lock whose mtime is older than
 * the stale TTL (a prior drain died mid-run without cleanup), When run-cron-a runs a tick, Then the
 * stale lock is reclaimed and the drain still runs — an orphan lock can never silence the feed forever.
 */
test("run-cron-a reclaims a stale drain.lock (old mtime) so an orphaned lock cannot silence the feed forever", async () => {
  const stateDir = makeStateDir();
  const lockPath = join(stateDir, "drain.lock");
  writeFileSync(lockPath, "", "utf8");
  const stale = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago — past the 15-min TTL
  utimesSync(lockPath, stale, stale);

  let drainCalled = 0;
  await mainCronA(cronConfigWith(stateDir), {
    cronASelect: () => ({ ok: true, dispatched: false }),
    drainOutbox: async () => { drainCalled += 1; },
  });

  assert.strictEqual(drainCalled, 1, "the stale lock was reclaimed and the drain ran");
});

/**
 * @description #24 (drain.lock fresh-lock respected) — Given a FRESH drain.lock (current mtime, a
 * real concurrent drain), When run-cron-a runs a tick, Then the drain is SKIPPED this tick (the fresh
 * lock is left alone; the next tick drains) — stale-reclaim must not trample a live lock.
 */
test("run-cron-a leaves a FRESH drain.lock alone and skips the drain this tick", async () => {
  const stateDir = makeStateDir();
  writeFileSync(join(stateDir, "drain.lock"), "", "utf8"); // just created → mtime = now

  let drainCalled = 0;
  await mainCronA(cronConfigWith(stateDir), {
    cronASelect: () => ({ ok: true, dispatched: false }),
    drainOutbox: async () => { drainCalled += 1; },
  });

  assert.strictEqual(drainCalled, 0, "a fresh lock is respected — the drain is skipped this tick");
  assert.ok(existsSync(join(stateDir, "drain.lock")), "the fresh lock is left in place for the holder to clean up");
});
