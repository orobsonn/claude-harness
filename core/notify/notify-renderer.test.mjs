/**
 * @description Frozen oracle for the VPS Telegram checkpoint renderer + forum-topic wrappers
 * (renderCheckpoint / createForumTopic / closeForumTopic on notify-telegram.mjs). Every network
 * call is an INJECTED fake fetch — ZERO real network. Mirrors notify-telegram.test.mjs: node:test
 * + injected fakes observing behavior. This file is RED until the module exports these three
 * functions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderCheckpoint, createForumTopic, closeForumTopic, sendNotification } from "./notify-telegram.mjs";

const VALID_CONFIG = { token: "SECRET123:abc", chatId: -1003044689525 };

/** @description A fake fetch recording (url, options) calls and returning a canned response. */
function makeFakeFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// renderCheckpoint — pure
// ---------------------------------------------------------------------------

test("#1 renderCheckpoint: single line — bold title (natural case) + ' — ' joined body, exact shape", () => {
  const result = renderCheckpoint({ title: "🚀 Classificação", bodyLines: ["modo LIGHT"] });
  assert.equal(result, "<b>🚀 Classificação</b> — modo LIGHT");
});

test("#1b renderCheckpoint: title alone when there is no body info, and empty lines are dropped from the joiner", () => {
  assert.equal(renderCheckpoint({ title: "📝 Spec criada", bodyLines: [] }), "<b>📝 Spec criada</b>");
  assert.equal(renderCheckpoint({ title: "📝 Spec criada", bodyLines: [""] }), "<b>📝 Spec criada</b>");
  assert.equal(
    renderCheckpoint({ title: "t", bodyLines: ["a", "", "b"] }),
    "<b>t</b> — a — b",
    "empty body lines must not create a doubled ' —  — ' joiner",
  );
});

test("#2 renderCheckpoint: HTML-escapes every dynamic body line (&, <, >)", () => {
  const result = renderCheckpoint({ title: "x", bodyLines: ["a<b&c>d"] });
  assert.equal(result, "<b>x</b> — a&lt;b&amp;c&gt;d");
});

// ---------------------------------------------------------------------------
// createForumTopic — forum-topic wrapper, injectable fetch/log seam
// ---------------------------------------------------------------------------

test("#3 createForumTopic: payload.name is truncated to <=128 code points and NEVER escapeHtml'd", async () => {
  const { fetchImpl, calls } = makeFakeFetch({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_thread_id: 1 } }),
  });
  const longName = "<" + "a".repeat(199); // 200 code points total, starts with a literal '<'

  await createForumTopic({ name: longName }, { config: VALID_CONFIG, fetch: fetchImpl, log: () => {} });

  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].options.body);
  assert.ok(payload.name.length <= 128, "payload.name must be truncated to at most 128 code points");
  assert.equal(payload.name, longName.slice(0, 128), "payload.name must be exactly the first 128 code points");
  assert.ok(payload.name.includes("<"), "the literal '<' must survive — the name is never escapeHtml'd");
  assert.doesNotMatch(payload.name, /&lt;/, "the name must NEVER be HTML-escaped");
});

// ---------------------------------------------------------------------------
// closeForumTopic — forum-topic wrapper, injectable fetch/log seam
// ---------------------------------------------------------------------------

test("#4 closeForumTopic: targets the closeForumTopic method with message_thread_id in the payload", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200, json: async () => ({ ok: true, result: true }) });

  await closeForumTopic({ threadId: 707 }, { config: VALID_CONFIG, fetch: fetchImpl, log: () => {} });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/closeForumTopic$/, "the request must target the closeForumTopic method");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.message_thread_id, 707);
});

// ---------------------------------------------------------------------------
// Legacy event send — replaces the flat single-line formatEvent shape
// ---------------------------------------------------------------------------

test("#5 sendNotification: a legacy event (type 'picked') is formatted via the renderer shape, not the flat one-liner", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200 });

  await sendNotification({ type: "picked", project: "demo", issue: 42 }, { config: VALID_CONFIG, fetch: fetchImpl });

  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].options.body);
  assert.match(payload.text, /^<b>.+<\/b>\n\n<i>[\s\S]*<\/i>$/, "text must follow the renderCheckpoint multi-line shape");
});

// ---------------------------------------------------------------------------
// createForumTopic — fail-open + redacted log
// ---------------------------------------------------------------------------

test("#6 createForumTopic: a rejecting fetch never throws, returns {ok:false}, and logs ONLY op/type/status", async () => {
  const logs = [];
  const log = (entry) => logs.push(entry);
  const { fetchImpl } = makeFakeFetch(new Error(`boom https://api.telegram.org/bot${VALID_CONFIG.token}/createForumTopic`));

  let threw = false;
  let result;
  try {
    result = await createForumTopic({ name: "topic" }, { config: VALID_CONFIG, fetch: fetchImpl, log });
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "createForumTopic must never throw on a network error");
  assert.deepEqual(result, { ok: false });

  assert.equal(logs.length, 1, "exactly one log entry for the failure");
  assert.deepEqual(Object.keys(logs[0]).sort(), ["op", "status", "type"], "the log entry must have exactly the keys op/type/status");

  const serialized = JSON.stringify(logs[0]);
  assert.doesNotMatch(serialized, /SECRET123/, "the token must never be logged");
  assert.doesNotMatch(serialized, /api\.telegram\.org/, "the api URL must never be logged");
});
