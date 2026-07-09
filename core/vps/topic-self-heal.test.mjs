/**
 * @description Behavioral tests for the Telegram forum-topic self-heal branch of
 * `drainTelegramOutbox` (./notify-telegram.mjs). Contract: when a send reports a dead per-run topic,
 * the drain recreates the topic at most once per cycle via the `createTopic` seam, persists the new
 * threadId, confirms the persistence, re-sends the pending event to the recreated thread, and
 * advances the cursor past it. A transient send failure (any reason other than the dead-topic signal,
 * including no reason at all) never triggers a recreation.
 *
 * Each test builds an isolated temp `stateDir` with `mkdtempSync`, writes the `obs-<issue>.json`
 * meta + `obs-<issue>.events.jsonl` events directly via `node:fs` to set up the precondition, then
 * drives `drainTelegramOutbox` with the REAL `readEvents`/`readMeta`/`advanceCursor`/`updateMeta`
 * from ./obs-outbox.mjs (so persistence is real, on disk, in the temp dir) plus a per-test fake
 * `send` and `createTopic` seam. The final test drives the REAL `makeNotifier` binding end-to-end
 * with a fake `fetch` router instead of an injected drain seam.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { drainTelegramOutbox, makeNotifier } from "./notify-telegram.mjs";
import { readEvents, readMeta, advanceCursor, updateMeta } from "./obs-outbox.mjs";

/** @description The shared main-topic thread the drain routes critical pings to — distinct from any
 * run's own thread and from any recreated thread, so cross-target assertions stay unambiguous. */
const SHARED_THREAD_ID = 999;

/** @description Fresh temp state dir for one test's outbox fixtures. */
function makeStateDir() {
  return mkdtempSync(join(tmpdir(), "topic-self-heal-state-"));
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

test("#ac-1.1 drainTelegramOutbox: a thread-not-found send triggers exactly one createTopic call named with '#141', persists the new threadId, and re-sends to it", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "pipeline-type", mode: "FULL" }]);

  const createTopicCalls = [];
  const createTopic = async (input) => {
    createTopicCalls.push(input);
    return { ok: true, threadId: 2000 };
  };

  const sendCalls = [];
  const send = async (message) => {
    sendCalls.push(message);
    if (message.threadId === 1045) return { sent: false, reason: "thread-not-found" };
    if (message.threadId === 2000) return { sent: true };
    return { sent: false };
  };

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic },
  );

  assert.strictEqual(createTopicCalls.length, 1, "createTopic must be called exactly once for the dead thread");
  assert.ok(
    String(createTopicCalls[0]?.name ?? "").includes("#141"),
    "the recreated topic name must reference '#141' so the operator can identify the run",
  );
  assert.strictEqual(
    readMeta(metaPath(stateDir, 141)).threadId,
    2000,
    "the on-disk meta threadId must be updated to the newly created topic",
  );
  assert.ok(
    sendCalls.some((call) => call.threadId === 2000),
    "the event must be re-sent to the recreated topic's threadId",
  );
});

test("#ac-1.2 drainTelegramOutbox: after a self-heal recreation, the cursor advances past the re-sent event (the feed is unjammed)", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "active",
  });
  const events = [{ type: "pipeline-type", mode: "FULL" }];
  writeEvents(stateDir, 141, events);

  const createTopic = async () => ({ ok: true, threadId: 2000 });
  const send = async (message) => {
    if (message.threadId === 1045) return { sent: false, reason: "thread-not-found" };
    if (message.threadId === 2000) return { sent: true };
    return { sent: false };
  };

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic },
  );

  assert.strictEqual(
    readMeta(metaPath(stateDir, 141)).cursor,
    events.length,
    "the cursor must advance past the re-sent event after a successful self-heal",
  );
});

test("#ac-1.3 drainTelegramOutbox: a transient send failure must NOT trigger a topic recreation, and the cursor stays put", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "pipeline-type", mode: "FULL" }]);

  const createTopicCalls = [];
  const createTopic = async (input) => {
    createTopicCalls.push(input);
    return { ok: true, threadId: 2000 };
  };
  const send = async () => ({ sent: false, reason: "transient" });

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic },
  );

  assert.strictEqual(createTopicCalls.length, 0, "a transient reason must never trigger createTopic");
  assert.strictEqual(readMeta(metaPath(stateDir, 141)).threadId, 1045, "the threadId must remain unchanged on a transient failure");
  assert.strictEqual(readMeta(metaPath(stateDir, 141)).cursor, 0, "the cursor must not advance on a transient failure");
});

test("#ac-1.4 drainTelegramOutbox: a failed topic recreation ({ok:false}) leaves the threadId/cursor untouched and does not burst createTopic in the same cycle", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "pipeline-type", mode: "FULL" }]);

  const createTopicCalls = [];
  const createTopic = async (input) => {
    createTopicCalls.push(input);
    return { ok: false };
  };
  const send = async () => ({ sent: false, reason: "thread-not-found" });

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic },
  );

  assert.strictEqual(readMeta(metaPath(stateDir, 141)).threadId, 1045, "the threadId must remain unchanged when the recreation fails");
  assert.strictEqual(readMeta(metaPath(stateDir, 141)).cursor, 0, "the cursor must not advance when the recreation fails");
  assert.strictEqual(createTopicCalls.length, 1, "createTopic must be attempted exactly once — the recreation is attempted, and a failure must not burst a second call in the same cycle");
});

test("#ac-1.4 drainTelegramOutbox: a recreation that returns no usable threadId ({ok:true, threadId:null}) must not re-send nor touch the threadId", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "pipeline-type", mode: "FULL" }]);

  const createTopicCalls = [];
  const createTopic = async () => {
    createTopicCalls.push(null);
    return { ok: true, threadId: null };
  };
  const sendCalls = [];
  const send = async (message) => {
    sendCalls.push(message);
    if (message.threadId === 1045) return { sent: false, reason: "thread-not-found" };
    return { sent: true };
  };

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic },
  );

  assert.strictEqual(createTopicCalls.length, 1, "createTopic must be called once for the recreation attempt — the ok-but-no-threadId path must be exercised, not skipped");
  assert.strictEqual(
    readMeta(metaPath(stateDir, 141)).threadId,
    1045,
    "a recreation with no usable threadId must leave the on-disk threadId unchanged",
  );
  assert.strictEqual(readMeta(metaPath(stateDir, 141)).cursor, 0, "the cursor must not advance when there is no usable recreated threadId");
  assert.ok(
    !sendCalls.some((call) => call.threadId != null && call.threadId !== 1045),
    "the event must NOT be re-sent to any threadId other than the original 1045 when recreation yields no usable threadId",
  );
});

test("#ac-1.5 drainTelegramOutbox: when the persist of the recreated threadId is dropped, the event is not re-sent and the run falls back to the shared topic", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "pipeline-type", mode: "FULL" }]);

  const createTopic = async () => ({ ok: true, threadId: 2000 });
  const sendCalls = [];
  const send = async (message) => {
    sendCalls.push(message);
    if (message.threadId === 1045) return { sent: false, reason: "thread-not-found" };
    return { sent: true };
  };
  // Forwards to the real updateMeta EXCEPT it silently ignores a threadId key, while still honoring
  // a status key — simulating a persist that drops the recreated threadId.
  const dropThreadIdUpdateMeta = (path, partial) => {
    const { threadId, ...rest } = partial ?? {};
    updateMeta(path, rest);
  };

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic, updateMeta: dropThreadIdUpdateMeta },
  );

  assert.ok(
    !sendCalls.some((call) => call.threadId === 2000),
    "the event must NOT be re-sent to the recreated topic when its threadId could not be persisted",
  );
  assert.strictEqual(
    readMeta(metaPath(stateDir, 141)).status,
    "fallback",
    "the run must switch to the shared topic (status:'fallback') when the recreated threadId cannot be persisted",
  );
});

test("#ac-1.8 drainTelegramOutbox: self-heal recreates the topic once for two pending events, advancing the cursor by exactly one per event and routing every post-recreation send to the new thread", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "active",
  });
  const events = [{ type: "pipeline-type", mode: "FULL" }, { type: "pr", pr: 7 }];
  writeEvents(stateDir, 141, events);

  const createTopic = async () => ({ ok: true, threadId: 2000 });
  const sendCalls = [];
  const send = async (message) => {
    sendCalls.push(message);
    if (message.threadId === 1045) return { sent: false, reason: "thread-not-found" };
    return { sent: true };
  };

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic },
  );

  assert.strictEqual(
    readMeta(metaPath(stateDir, 141)).cursor,
    events.length,
    "the cursor must advance by exactly one per event — index 0 must not be skipped by the recreation",
  );
  const lastOldThreadSendIndex = sendCalls.map((call) => call.threadId).lastIndexOf(1045);
  const sendsAfterRecreation = sendCalls.slice(lastOldThreadSendIndex + 1);
  assert.ok(sendsAfterRecreation.length > 0, "there must be at least one send after the recreation");
  assert.ok(
    sendsAfterRecreation.every((call) => call.threadId === 2000),
    "every send call after the recreation must carry the new threadId 2000",
  );
});

test("#ac-1.8 drainTelegramOutbox: the createTopic burst cap is bounded PER INVOCATION (at most 3), never a module-global that refuses forever", async () => {
  const stateDir = makeStateDir();
  const issues = [101, 102, 103, 104];
  for (const issue of issues) {
    writeMeta(stateDir, issue, {
      issueNumber: issue,
      project: "demo",
      worktreePath: `/tmp/wt-${issue}`,
      threadId: 1000 + issue,
      cursor: 0,
      status: "active",
    });
    writeEvents(stateDir, issue, [{ type: "pipeline-type", mode: "FULL" }]);
  }

  const createTopicCalls = [];
  // A fresh id per call — the fake still fails every send (including to the new thread), so a
  // "healed" run is not acked and may still need healing on the next cycle. That is expected: this
  // test asserts only the createTopic call counts, per the fixture note.
  const createTopic = async (input) => {
    createTopicCalls.push(input);
    return { ok: true, threadId: 9000 + createTopicCalls.length };
  };
  const send = async () => ({ sent: false, reason: "thread-not-found" });

  const opts = { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 };
  const drainSeams = { ...seams, send, createTopic };

  await drainTelegramOutbox(opts, drainSeams);
  const firstCycleCount = createTopicCalls.length;
  assert.ok(
    firstCycleCount <= 3,
    "createTopic must be called AT MOST 3 times in a single invocation (bounds a mass-deletion burst)",
  );

  await drainTelegramOutbox(opts, drainSeams);
  const secondCycleCount = createTopicCalls.length - firstCycleCount;
  assert.ok(
    secondCycleCount > 0,
    "a SECOND consecutive invocation must call createTopic again for still-unhealed runs — the cap counter is zeroed each cycle, never a module-global refusal",
  );
});

test("#ac-1.6 drainTelegramOutbox: a {sent:false} with NO reason field at all must never trigger a topic recreation", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "pipeline-type", mode: "FULL" }]);

  const createTopicCalls = [];
  const createTopic = async (input) => {
    createTopicCalls.push(input);
    return { ok: true, threadId: 2000 };
  };
  const send = async () => ({ sent: false });

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic },
  );

  assert.strictEqual(createTopicCalls.length, 0, "a reason-less {sent:false} (the shape the 30 frozen drain-outbox tests inject) must never trigger createTopic");
  assert.strictEqual(readMeta(metaPath(stateDir, 141)).threadId, 1045, "the threadId must remain unchanged when no reason is surfaced");
  assert.strictEqual(readMeta(metaPath(stateDir, 141)).cursor, 0, "the cursor must not advance when no reason is surfaced");
});

test("#ac-1.7 makeNotifier.drainOutbox: an end-to-end thread-not-found send drives a real createForumTopic call and persists the new threadId", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    threadId: 1045,
    cursor: 0,
    status: "active",
  });
  writeEvents(stateDir, 141, [{ type: "pipeline-type", mode: "FULL" }]);

  const fetchCalls = [];
  const fakeFetch = async (url, options) => {
    fetchCalls.push({ url, options });
    if (url.endsWith("/sendMessage")) {
      const body = JSON.parse(options.body);
      if (body.message_thread_id === 1045) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ ok: false, description: "Bad Request: message thread not found" }),
        };
      }
      if (body.message_thread_id === 2000) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    }
    if (url.endsWith("/createForumTopic")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_thread_id: 2000 } }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };

  const notifier = makeNotifier(
    { notify: { chatId: -100, threadId: 613 } },
    { homeDir: "/h", readFileSafe: () => "TELEGRAM_BOT_TOKEN=SECRET123:abc\n", fetch: fakeFetch },
  );

  await notifier.drainOutbox({ stateDir });

  const createTopicCall = fetchCalls.find((call) => call.url.endsWith("/createForumTopic"));
  assert.ok(createTopicCall, "the fake fetch must receive a POST to a URL ending '/createForumTopic'");
  assert.strictEqual(
    readMeta(metaPath(stateDir, 141)).threadId,
    2000,
    "the token-bound createTopic seam must be reached end-to-end and the recreated threadId persisted",
  );
});

test("#ac-1.9 drainTelegramOutbox: an 'orphan' run (dead spawn) does NOT own its topic — a thread-not-found send never mints a fresh topic", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "orphan",
  });
  writeEvents(stateDir, 141, [{ type: "pipeline-type", mode: "FULL" }]);

  const createTopicCalls = [];
  const createTopic = async (input) => {
    createTopicCalls.push(input);
    return { ok: true, threadId: 2000 };
  };
  const send = async (message) => {
    if (message.threadId === 1045) return { sent: false, reason: "thread-not-found" };
    return { sent: false };
  };

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic },
  );

  assert.strictEqual(
    createTopicCalls.length,
    0,
    "an orphan run must never mint a fresh topic — ownsTopic is an allowlist (active|awaiting-review), not a denylist",
  );
});

test("#ac-1.10 drainTelegramOutbox: a run at the persisted heal cap (healAttempts >= MAX) routes to fallback instead of minting yet another topic", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "active",
    healAttempts: 3,
  });
  writeEvents(stateDir, 141, [{ type: "pipeline-type", mode: "FULL" }]);

  const createTopicCalls = [];
  const createTopic = async (input) => {
    createTopicCalls.push(input);
    return { ok: true, threadId: 2000 };
  };
  const send = async (message) => {
    if (message.threadId === 1045) return { sent: false, reason: "thread-not-found" };
    return { sent: false };
  };

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic },
  );

  assert.strictEqual(
    createTopicCalls.length,
    0,
    "a run at the persisted heal cap must NOT mint another topic — it stops re-minting every cron tick",
  );
  assert.strictEqual(
    readMeta(metaPath(stateDir, 141)).status,
    "fallback",
    "a run at the heal cap is routed to the shared topic (status:fallback), the same terminal escape as the other dead-end paths",
  );
});

test("#ac-1.11 drainTelegramOutbox: a successful self-heal increments the persisted healAttempts so the lifetime cap is reachable across cycles", async () => {
  const stateDir = makeStateDir();
  writeMeta(stateDir, 141, {
    issueNumber: 141,
    project: "demo",
    worktreePath: "/tmp/wt-141",
    threadId: 1045,
    cursor: 0,
    status: "active",
    healAttempts: 1,
  });
  writeEvents(stateDir, 141, [{ type: "pipeline-type", mode: "FULL" }]);

  const createTopic = async () => ({ ok: true, threadId: 2000 });
  const send = async (message) => {
    if (message.threadId === 1045) return { sent: false, reason: "thread-not-found" };
    if (message.threadId === 2000) return { sent: true };
    return { sent: false };
  };

  await drainTelegramOutbox(
    { stateDir, chatId: -100, threadId: SHARED_THREAD_ID, limitPerMinute: 1000, sendDelayMs: 0 },
    { ...seams, send, createTopic },
  );

  assert.strictEqual(
    readMeta(metaPath(stateDir, 141)).healAttempts,
    2,
    "a heal must bump the persisted healAttempts so repeated per-cycle heals converge on the lifetime cap",
  );
});
