/**
 * @description Frozen oracle for the Telegram forum-topic self-heal wiring on
 * notify-telegram.mjs. `sendRenderedMessage` classifies an unsuccessful send into a bounded
 * `reason` — an unclassifiable or ambiguous response body is fail-closed to `"transient"`; ONLY
 * an explicit Telegram dead-thread description classifies as `"thread-not-found"`, and that raw
 * description string never leaks into the returned reason or into any log entry (every failure
 * log entry carries exactly `{ op, type, status }`). `makeNotifier`, when configured, exposes a
 * token-bound `send` seam that propagates the classified reason through to the drain, and a
 * token-bound `createTopic` seam that issues a real `createForumTopic` call (not the drain's
 * default `{ok:false}` no-op). When unconfigured, `makeNotifier` exposes neither `send` nor
 * `createTopic`, reports `enabled:false`, and never touches the network — including through
 * `drainOutbox`. Every network call in this file is an INJECTED fake fetch — ZERO real network,
 * ZERO real bot token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { sendRenderedMessage, makeNotifier } from "./notify-telegram.mjs";

const CONFIG = { token: "SECRET123:abc", chatId: -100, threadId: 613 };

/** @description A fake fetch recording calls and returning a canned response. */
function makeFakeFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetchImpl, calls };
}

test("#ac-1.6 sendRenderedMessage: an unreadable 400 body fails closed to reason:\"transient\", never \"thread-not-found\"", async () => {
  const noJsonMethod = { ok: false, status: 400 };
  const result1 = await sendRenderedMessage({ config: CONFIG, text: "<b>x</b>", fetch: async () => noJsonMethod });
  assert.deepEqual(
    result1,
    { ok: false, reason: "transient" },
    "a response with no json() method must be unclassifiable and fail closed to transient",
  );

  const rejectingJson = {
    ok: false,
    status: 400,
    json: async () => {
      throw new Error("malformed body");
    },
  };
  const result2 = await sendRenderedMessage({ config: CONFIG, text: "<b>x</b>", fetch: async () => rejectingJson });
  assert.deepEqual(
    result2,
    { ok: false, reason: "transient" },
    "a response whose json() rejects must be unclassifiable and fail closed to transient",
  );
});

test("#ac-1.6 sendRenderedMessage: a 400 whose description does NOT mean a dead thread classifies as reason:\"transient\"", async () => {
  const response = {
    ok: false,
    status: 400,
    json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
  };
  const result = await sendRenderedMessage({ config: CONFIG, text: "<b>x</b>", fetch: async () => response });
  assert.deepEqual(
    result,
    { ok: false, reason: "transient" },
    "positive gate: only an explicit dead-thread description may classify as thread-not-found",
  );
});

test("#ac-1.6 sendRenderedMessage: a dead-thread 400 classifies as reason:\"thread-not-found\" without leaking the raw description", async () => {
  const logs = [];
  const log = (entry) => logs.push(entry);
  const response = {
    ok: false,
    status: 400,
    json: async () => ({ ok: false, description: "Bad Request: message thread not found" }),
  };
  const result = await sendRenderedMessage({ config: CONFIG, text: "<b>x</b>", fetch: async () => response, log });

  assert.deepEqual(
    result,
    { ok: false, reason: "thread-not-found" },
    "a dead-thread description must classify as thread-not-found",
  );
  assert.doesNotMatch(
    String(result.reason),
    /message thread not found/,
    "the returned reason must never carry the raw Telegram description string",
  );
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(
    serializedLogs,
    /message thread not found/,
    "no recorded log entry may carry the raw Telegram description string",
  );
  assert.ok(logs.length >= 1, "a classified failure must still be logged");
  for (const entry of logs) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["op", "status", "type"],
      "every recorded failure log entry must carry EXACTLY the keys op/type/status",
    );
  }
});

test("#ac-1.7 makeNotifier.send: propagates the classified reason \"thread-not-found\" through the exact seam wired to the drain", async () => {
  const response = {
    ok: false,
    status: 400,
    json: async () => ({ ok: false, description: "Bad Request: message thread not found" }),
  };
  const notifier = makeNotifier(
    { notify: { chatId: -100, threadId: 613 } },
    {
      readFileSafe: () => "TELEGRAM_BOT_TOKEN=SECRET123:abc\n",
      homeDir: "/h",
      fetch: async () => response,
      log: () => {},
    },
  );
  const result = await notifier.send({ event: { type: "pr" }, text: "<b>x</b>", chatId: -100, threadId: 613 });
  assert.deepEqual(
    result,
    { sent: false, reason: "thread-not-found" },
    "the classified bounded reason must reach the exact send seam makeNotifier passes to the drain, wired in production",
  );
});

test("#ac-1.7 makeNotifier.createTopic: binds a REAL token-bound createForumTopic call, not the drain's default {ok:false} no-op", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_thread_id: 4242 } }) };
  };
  const notifier = makeNotifier(
    { notify: { chatId: -100, threadId: 613 } },
    { readFileSafe: () => "TELEGRAM_BOT_TOKEN=SECRET123:abc\n", homeDir: "/h", fetch: fetchImpl, log: () => {} },
  );

  const result = await notifier.createTopic({ name: "[demo] #141" });

  assert.equal(calls.length, 1, "createTopic must issue exactly one POST");
  assert.ok(calls[0].url.endsWith("/createForumTopic"), "the single POST must target the createForumTopic method");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.name, "[demo] #141", "the request body must carry the topic name verbatim");
  assert.equal(body.chat_id, -100, "the request body must target the resolved chatId");
  assert.deepEqual(
    result,
    { ok: true, threadId: 4242, chatId: -100 },
    "createTopic must resolve the new topic's threadId — proving a real token-bound call, not the drain's default no-op — AND must surface the chatId the topic was minted in, which the caller must persist alongside the threadId so a later retention sweep can match the run's persisted chatId against the currently-resolved one",
  );
});

test("#ac-1.7 makeNotifier: an unconfigured notifier exposes no send/createTopic surface and never touches the network via drainOutbox", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200 });
  const notifier = makeNotifier(
    { notify: undefined },
    { readFileSafe: () => "", homeDir: "/h", fetch: fetchImpl },
  );
  const stateDir = mkdtempSync(join(tmpdir(), "topic-self-heal-wiring-"));

  assert.equal(notifier.enabled, false, "an unconfigured notifier must report enabled:false");
  assert.equal(typeof notifier.send, "undefined", "an unconfigured notifier must expose no send surface");
  assert.equal(typeof notifier.createTopic, "undefined", "an unconfigured notifier must expose no createTopic surface");

  await notifier.drainOutbox({ stateDir });
  assert.equal(calls.length, 0, "the no-op branch must never touch the network, not even via drainOutbox");
});
