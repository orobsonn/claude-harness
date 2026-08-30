/**
 * @description Frozen oracle for the VPS Telegram notification module (notify-telegram.mjs).
 * One-way, best-effort, fail-open. Every network call is an INJECTED fake fetch — ZERO real
 * network, ZERO real fs, and the tests never need a real bot token. Mirrors run-crons.test.mjs:
 * node:test + injected fakes observing behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatEvent,
  sendNotification,
  readTelegramToken,
  resolveNotifyConfig,
  makeNotifier,
  summarizeIssueBody,
  deleteForumTopic,
  createForumTopic,
  closeForumTopic,
  isCriticalEvent,
  drainTelegramOutbox,
  isCuratedFeedEvent,
} from "./notify-telegram.mjs";
import * as notifyTelegram from "./notify-telegram.mjs";
import { createRun, updateMeta, appendEvent } from "../shared/lib/obs-outbox.mjs";

const VALID_CONFIG = { token: "SECRET123:abc", chatId: -1003044689525, threadId: 613 };

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

// ---------------------------------------------------------------------------
// formatEvent — pure
// ---------------------------------------------------------------------------

test("#ac-1.1 formatEvent: emoji + [project] prefix, issue/pr refs, link, no secret", () => {
  const picked = formatEvent({ type: "picked", project: "demo", issue: 42, issueTitle: "add x" });
  assert.match(picked, /^🎯 \[demo\]/, "must start with the type emoji + [project]");
  assert.match(picked, /#42/, "must reference the issue number");

  const done = formatEvent({
    type: "session-done",
    project: "demo",
    issue: 42,
    pr: 7,
    url: "https://github.com/acme/demo/pull/7",
  });
  assert.match(done, /<a href="https:\/\/github\.com\/acme\/demo\/pull\/7">#7<\/a>/, "renders a link");
  assert.doesNotMatch(done, /SECRET123/, "never contains a token");
  assert.doesNotMatch(done, /chat_id|1003044689525/, "never contains a chat_id");
});

test("#ac-1.2 formatEvent: HTML-escapes & < > in dynamic text", () => {
  const out = formatEvent({ type: "picked", project: "de<mo", issue: 1, issueTitle: "a<b&c>d" });
  assert.doesNotMatch(out, /a<b/, "raw < from the title must be escaped");
  assert.match(out, /&lt;/, "< must become &lt;");
  assert.match(out, /&amp;/, "& must become &amp;");
});

test("summarizeIssueBody: picks the first substantive prose line, skipping headers/metadata", () => {
  const body = "## Resumo + por quê\nConsolidar três regras de checklist no SKILL.md, do kaizen.\n\n## Escopo\ncore/x";
  assert.equal(summarizeIssueBody(body), "Consolidar três regras de checklist no SKILL.md, do kaizen.");

  const kaizen = "**Source:** kaizen.md — m2\n**Tier 3** — fail-fast\n\n### Observed\nInvoking cross-family.mjs sem args roda um pass degenerado.";
  assert.equal(summarizeIssueBody(kaizen), "Invoking cross-family.mjs sem args roda um pass degenerado.");

  assert.equal(summarizeIssueBody(""), "");
  assert.match(summarizeIssueBody("x".repeat(300)), /…$/, "truncates a very long line");

  // picked message carries the summary as an italic second line.
  const picked = formatEvent({ type: "picked", project: "demo", issue: 5, issueTitle: "t", summary: "faz X e Y" });
  assert.match(picked, /<i>faz X e Y<\/i>/);
});

test("#ac-1.3 formatEvent: truncates a title longer than 80 chars", () => {
  const longTitle = "x".repeat(200);
  const out = formatEvent({ type: "picked", project: "demo", issue: 1, issueTitle: longTitle });
  assert.ok(out.length < 200, "the long title must be truncated, not emitted whole");
  assert.match(out, /…/, "truncation marker present");
});

// ---------------------------------------------------------------------------
// sendNotification — best-effort, fail-open, timeout, no secret leak
// ---------------------------------------------------------------------------

test("#ac-2.1 sendNotification: valid config POSTs the correct Telegram payload, returns sent:true", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200 });
  const result = await sendNotification(
    { type: "picked", project: "demo", issue: 42 },
    { config: VALID_CONFIG, fetch: fetchImpl }
  );
  assert.deepEqual(result, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/botSECRET123:abc/sendMessage");
  assert.equal(calls[0].options.method, "POST");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, VALID_CONFIG.chatId);
  assert.equal(body.message_thread_id, VALID_CONFIG.threadId);
  assert.equal(body.parse_mode, "HTML");
  assert.equal(body.disable_web_page_preview, true);
  assert.equal(typeof body.text, "string");
});

test("#ac-2.2 sendNotification: wires an AbortSignal (timeout) into the fetch options", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200 });
  await sendNotification({ type: "picked", project: "demo", issue: 1 }, { config: VALID_CONFIG, fetch: fetchImpl });
  const signal = calls[0].options.signal;
  assert.ok(signal, "a signal must be passed");
  assert.ok(typeof signal === "object" && "aborted" in signal, "the signal must be an AbortSignal");
});

test("#ac-2.3 sendNotification: a rejecting fetch does not throw; returns sent:false", async () => {
  const { fetchImpl } = makeFakeFetch(new Error("boom https://api.telegram.org/botSECRET123:abc/x"));
  let threw = false;
  let result;
  try {
    result = await sendNotification({ type: "picked", project: "demo", issue: 1 }, { config: VALID_CONFIG, fetch: fetchImpl });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "sendNotification must never throw on a network error");
  assert.equal(result.sent, false);
});

test("#ac-2.3b sendNotification: a non-2xx / 429 response returns sent:false without throwing", async () => {
  for (const status of [429, 500, 403]) {
    const { fetchImpl } = makeFakeFetch({ ok: false, status });
    const result = await sendNotification({ type: "picked", project: "demo", issue: 1 }, { config: VALID_CONFIG, fetch: fetchImpl });
    assert.equal(result.sent, false, `status ${status} must be sent:false`);
  }
});

test("#ac-2.4 sendNotification: failure log carries ONLY {op,type,project,status} — no token/url/body/chat_id", async () => {
  const logs = [];
  const log = (entry) => logs.push(entry);
  const { fetchImpl } = makeFakeFetch(new Error("boom with https://api.telegram.org/botSECRET123:abc leaked"));
  await sendNotification(
    { type: "picked", project: "demo", issue: 42, issueTitle: "sensitive title" },
    { config: VALID_CONFIG, fetch: fetchImpl, log }
  );
  assert.ok(logs.length >= 1, "a failure must be logged internally");
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /SECRET123/, "the token must never be logged");
  assert.doesNotMatch(serialized, /api\.telegram\.org/, "the URL (which carries the token) must never be logged");
  assert.doesNotMatch(serialized, /sensitive title/, "the message body/title must never be logged");
  assert.doesNotMatch(serialized, /1003044689525/, "the chat_id must never be logged");
  for (const entry of logs) {
    for (const key of Object.keys(entry)) {
      assert.ok(["op", "type", "project", "status"].includes(key), `unexpected log key "${key}" — only op/type/project/status allowed`);
    }
  }
});

test("#ac-2.5 sendNotification: missing/empty token → not-configured, fetch NEVER called", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200 });
  for (const config of [null, undefined, {}, { token: "", chatId: 1 }, { token: "t" /* no chatId */ }]) {
    const result = await sendNotification({ type: "picked", project: "demo", issue: 1 }, { config, fetch: fetchImpl });
    assert.equal(result.sent, false);
    assert.equal(result.reason, "not-configured");
  }
  assert.equal(calls.length, 0, "no network call without a token + chatId");
});

test("#ac-2.6 sendNotification: no retry — a 429 calls fetch exactly once", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: false, status: 429 });
  await sendNotification({ type: "picked", project: "demo", issue: 1 }, { config: VALID_CONFIG, fetch: fetchImpl });
  assert.equal(calls.length, 1, "429 must not trigger a retry");
});

test("#ac-4.3 sendNotification: fetch absent (runtime-unsupported) → sent:false, no throw, no network", async () => {
  const original = globalThis.fetch;
  // Simulate a Node runtime without global fetch (and no injected fetch).
  // eslint-disable-next-line no-global-assign
  globalThis.fetch = undefined;
  try {
    const result = await sendNotification({ type: "picked", project: "demo", issue: 1 }, { config: VALID_CONFIG });
    assert.equal(result.sent, false);
    assert.equal(result.reason, "runtime-unsupported");
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// readTelegramToken + resolveNotifyConfig
// ---------------------------------------------------------------------------

test("#ac-3.1 readTelegramToken: extracts TELEGRAM_BOT_TOKEN; missing file → '' (no throw)", () => {
  const readFileSafe = () => "OTHER=x\nTELEGRAM_BOT_TOKEN=123:abc\nMORE=y\n";
  assert.equal(readTelegramToken({ homeDir: "/home/h", readFileSafe }), "123:abc");

  const throwing = () => {
    throw new Error("ENOENT");
  };
  assert.equal(readTelegramToken({ homeDir: "/home/h", readFileSafe: throwing }), "");

  assert.equal(readTelegramToken({ homeDir: "/home/h", readFileSafe: () => "" }), "");
});

test("#ac-3.2 resolveNotifyConfig: null unless notify+chatId+token present", () => {
  const withToken = () => "TELEGRAM_BOT_TOKEN=tok:en\n";
  const noToken = () => "";

  assert.equal(resolveNotifyConfig({}, { homeDir: "/h", readFileSafe: withToken }), null, "no notify block → null");
  assert.equal(
    resolveNotifyConfig({ notify: { threadId: 613 } }, { homeDir: "/h", readFileSafe: withToken }),
    null,
    "no chatId → null"
  );
  assert.equal(
    resolveNotifyConfig({ notify: { chatId: -100, threadId: 613 } }, { homeDir: "/h", readFileSafe: noToken }),
    null,
    "no token → null"
  );

  const resolved = resolveNotifyConfig(
    { notify: { chatId: -100, threadId: 613 } },
    { homeDir: "/h", readFileSafe: withToken }
  );
  assert.equal(resolved.chatId, -100);
  assert.equal(resolved.threadId, 613);
  assert.equal(resolved.token, "tok:en");
});

test("#ac-3.3 resolveNotifyConfig: falls back to .dev.vars TELEGRAM_CHAT_ID/THREAD_ID when config has no notify block", () => {
  // The whole Telegram destination lives in ~/.claude/.dev.vars — no notify block in the config at all.
  const devVars = () => "TELEGRAM_BOT_TOKEN=tok:en\nTELEGRAM_CHAT_ID=-1003044689525\nTELEGRAM_THREAD_ID=613\n";
  const resolved = resolveNotifyConfig({}, { homeDir: "/h", readFileSafe: devVars });
  assert.equal(resolved.chatId, -1003044689525, "chatId read from .dev.vars");
  assert.equal(resolved.threadId, 613, "threadId read from .dev.vars");
  assert.equal(resolved.token, "tok:en");
  assert.equal(resolved.heartbeat, true, "heartbeat defaults ON");

  // config.notify still wins over .dev.vars when present.
  const overridden = resolveNotifyConfig({ notify: { chatId: -42 } }, { homeDir: "/h", readFileSafe: devVars });
  assert.equal(overridden.chatId, -42, "config.notify.chatId overrides the .dev.vars value");

  // token in .dev.vars but no chat anywhere → null (nowhere to send).
  const noChat = () => "TELEGRAM_BOT_TOKEN=tok:en\n";
  assert.equal(resolveNotifyConfig({}, { homeDir: "/h", readFileSafe: noChat }), null);
});

// ---------------------------------------------------------------------------
// makeNotifier — fire-and-forget + drain, fail-open, no-op when unconfigured
// ---------------------------------------------------------------------------

test("#ac-4.1 makeNotifier: unconfigured → no-op notifier, fetch never called", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200 });
  const { notify, drain, enabled } = makeNotifier(
    { notify: undefined, homeDir: "/h" },
    { readFileSafe: () => "", fetch: fetchImpl }
  );
  assert.equal(enabled, false);
  await notify({ type: "picked", project: "demo", issue: 1 });
  await drain();
  assert.equal(calls.length, 0, "an unconfigured notifier makes no network call");
});

test("#ac-4.2 makeNotifier: notify never rejects even if fetch throws; drain settles", async () => {
  const { fetchImpl } = makeFakeFetch(new Error("network down"));
  const { notify, drain, enabled } = makeNotifier(
    { notify: { chatId: -100, threadId: 613 }, homeDir: "/h" },
    { readFileSafe: () => "TELEGRAM_BOT_TOKEN=tok:en\n", fetch: fetchImpl }
  );
  assert.equal(enabled, true);
  let threw = false;
  try {
    await notify({ type: "picked", project: "demo", issue: 1 });
    await drain();
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "notify + drain must never reject");
});

test("makeNotifier: a configured notifier POSTs via the injected fetch and drain awaits it", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200 });
  const { notify, drain } = makeNotifier(
    { notify: { chatId: -100, threadId: 613 }, homeDir: "/h" },
    { readFileSafe: () => "TELEGRAM_BOT_TOKEN=tok:en\n", fetch: fetchImpl }
  );
  notify({ type: "pr-merged", project: "demo", pr: 9 });
  await drain();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/bottok:en\/sendMessage$/);
});

// ---------------------------------------------------------------------------
// pr-merged — autonomous-merge notification carries a one-line revert instruction
// ---------------------------------------------------------------------------

test("#ac-5.1 formatEvent: pr-merged message contains the PR reference AND a one-line git revert instruction referencing the merge sha", () => {
  const event = {
    type: "pr-merged",
    project: "demo",
    pr: 9,
    url: "https://github.com/acme/demo/pull/9",
    mergeSha: "abc1234",
  };
  const text = formatEvent(event);
  assert.match(text, /#9/, "must reference the PR number");
  assert.match(text, /git revert/i, "must include a one-line git revert instruction");
  assert.match(text, /abc1234/, "the revert instruction must reference the merge sha");
});

test("#ac-5.2 sendNotification: pr-merged failure log stays redacted to exactly {op,type,project,status} — no revert text, pr url, or merge sha leaked", async () => {
  const logs = [];
  const log = (entry) => logs.push(entry);
  const { fetchImpl } = makeFakeFetch(new Error("boom with https://api.telegram.org/botSECRET123:abc leaked"));
  await sendNotification(
    {
      type: "pr-merged",
      project: "demo",
      pr: 9,
      url: "https://github.com/acme/demo/pull/9",
      mergeSha: "abc1234",
    },
    { config: VALID_CONFIG, fetch: fetchImpl, log }
  );
  assert.ok(logs.length >= 1, "a failure must be logged internally");
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /SECRET123/, "the token must never be logged");
  assert.doesNotMatch(serialized, /git revert/i, "the revert instruction text must never be logged");
  assert.doesNotMatch(serialized, /abc1234/, "the merge sha must never be logged");
  assert.doesNotMatch(serialized, /pull\/9/, "the PR url must never be logged");
  for (const entry of logs) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["op", "project", "status", "type"],
      "the log entry must stay exactly {op,type,project,status} — no extra keys"
    );
  }
});

test("formatEvent: chain-released reads as a queue-release and names the merged dependencies", () => {
  const text = formatEvent({ type: "chain-released", project: "demo", issue: 50, deps: [12, 13] });
  assert.match(text, /^🔗 \[demo\]/, "must start with the chain emoji + [project]");
  assert.match(text, /#50/, "must reference the released issue");
  assert.match(text, /#12, #13/, "must name the merged dependencies");
  assert.match(text, /liberada|pronta/i, "must read as a release message");
});

test("formatEvent: chain-stranded reads as a dead-subtree warning", () => {
  const text = formatEvent({ type: "chain-stranded", project: "demo", issue: 70, deps: [30, 31] });
  assert.match(text, /^⛓️‍💥 \[demo\]/, "must start with the broken-chain emoji + [project]");
  assert.match(text, /#70/, "must reference the stranded issue");
  assert.match(text, /encalhada|blocked/i, "must read as a stranded/dead-dependency message");
});

test("formatEvent: review-started references the PR and reads as an analysis-started message", () => {
  const text = formatEvent({ type: "review-started", project: "demo", pr: 7, url: "https://github.com/acme/demo/pull/7" });
  assert.match(text, /^🔍 \[demo\]/, "must start with the review emoji + [project]");
  assert.match(text, /#7/, "must reference the PR number");
  assert.match(text, /revis/i, "must read as a review-started message");
});

test("formatEvent: pr-awaiting-merge references the PR and signals a pending manual merge", () => {
  const text = formatEvent({ type: "pr-awaiting-merge", project: "demo", pr: 8, url: "https://github.com/acme/demo/pull/8" });
  assert.match(text, /^🟡 \[demo\]/, "must start with the awaiting-merge emoji + [project]");
  assert.match(text, /#8/, "must reference the PR number");
  assert.match(text, /merge/i, "must mention the pending merge");
});

// ---------------------------------------------------------------------------
// per-event threadId routing — #ac-1.3 / F4 (frozen oracle)
// ---------------------------------------------------------------------------

test("#ac-1.3/F4 makeNotifier: a per-event threadId overrides the resolved global in message_thread_id", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200 });
  const { notify, drain } = makeNotifier(
    { notify: { chatId: -100, threadId: 100 }, homeDir: "/h" },
    { readFileSafe: () => "TELEGRAM_BOT_TOKEN=xx:en\n", fetch: fetchImpl }
  );
  await notify({ type: "review-started", pr: 5, threadId: 900 });
  await drain();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.message_thread_id, 900, "a per-event threadId must win over the resolved global");
});

test("#ac-1.3/F4 makeNotifier: without a per-event threadId, message_thread_id falls back to the resolved global", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200 });
  const { notify, drain } = makeNotifier(
    { notify: { chatId: -100, threadId: 100 }, homeDir: "/h" },
    { readFileSafe: () => "TELEGRAM_BOT_TOKEN=xx:en\n", fetch: fetchImpl }
  );
  await notify({ type: "review-started", pr: 5 });
  await drain();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.message_thread_id, 100, "without a per-event threadId, the resolved global must be used");
});

test("#ac-1.3/F4 makeNotifier: threadId is routing-only — it must never appear in the rendered text", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200 });
  const { notify, drain } = makeNotifier(
    { notify: { chatId: -100, threadId: 100 }, homeDir: "/h" },
    { readFileSafe: () => "TELEGRAM_BOT_TOKEN=xx:en\n", fetch: fetchImpl }
  );
  await notify({ type: "review-started", pr: 5, threadId: 900 });
  await drain();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.doesNotMatch(body.text, /900/, "threadId must live only in message_thread_id, never in the rendered text");
});

// ---------------------------------------------------------------------------
// deleteForumTopic — forum-topic wrapper, injectable fetch/log seam
// (module does not yet export deleteForumTopic — RED until an executor implements it)
// ---------------------------------------------------------------------------

test("#ac-1.5 deleteForumTopic: happy path — POSTs deleteForumTopic with chat_id/message_thread_id, resolves {ok:true}", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ ok: true, status: 200, json: async () => ({ ok: true, result: true }) });
  const result = await deleteForumTopic({ threadId: 5 }, { config: { token: "t", chatId: 9 }, fetch: fetchImpl });
  assert.equal(calls.length, 1, "exactly one fetch call");
  assert.match(calls[0].url, /\/deleteForumTopic$/, "the request must target the deleteForumTopic method");
  assert.deepEqual(JSON.parse(calls[0].options.body), { chat_id: 9, message_thread_id: 5 });
  assert.deepEqual(result, { ok: true });
});

test("#ac-1.9 deleteForumTopic: a 'message thread not found' description classifies the reason as thread-not-found", async () => {
  const { fetchImpl } = makeFakeFetch({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, description: "Bad Request: message thread not found" }),
  });
  const result = await deleteForumTopic(
    { threadId: 5 },
    { config: { token: "t", chatId: 9 }, fetch: fetchImpl, log: () => {} }
  );
  assert.deepEqual(result, { ok: false, reason: "thread-not-found" });
});

test("#ac-1.9 deleteForumTopic: a rejecting fetch never throws, resolves {ok:false, reason:'transient'}, and the log stays redacted to op/type/status", async () => {
  const logs = [];
  const log = (entry) => logs.push(entry);
  const { fetchImpl } = makeFakeFetch(new Error("boom https://api.telegram.org/botSECRET123:abc/deleteForumTopic"));

  let threw = false;
  let result;
  try {
    result = await deleteForumTopic(
      { threadId: 5 },
      { config: { token: "SECRET123:abc", chatId: 9 }, fetch: fetchImpl, log }
    );
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "deleteForumTopic must never throw on a network error");
  assert.deepEqual(result, { ok: false, reason: "transient" });

  assert.equal(logs.length, 1, "exactly one log entry for the failure");
  const [entry] = logs;
  assert.deepEqual(Object.keys(entry).sort(), ["op", "status", "type"], "the log entry must have exactly the keys op/type/status");
  assert.equal(entry.op, "deleteForumTopic");
  assert.equal(entry.type, "forum-topic");
  assert.equal(entry.status, "error");

  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /SECRET123/, "the token must never be logged");
  assert.doesNotMatch(serialized, /api\.telegram\.org/, "the api URL (which carries the token) must never be logged");
  assert.doesNotMatch(serialized, /message_thread_id/, "the payload field name must never be logged");
});

// ---------------------------------------------------------------------------
// closeForumTopic — mirrors deleteForumTopic's { ok:false, reason } failure shape (#ac-1.1/#ac-1.2
// of issue #235: callers need to distinguish a permanent thread-not-found from a transient failure).
// ---------------------------------------------------------------------------

test("#235/task-1 closeForumTopic: a 'message thread not found' response resolves exactly { ok:false, reason:'thread-not-found' }", async () => {
  const { fetchImpl } = makeFakeFetch({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, description: "Bad Request: message thread not found" }),
  });
  const result = await closeForumTopic(
    { threadId: 5 },
    { config: { token: "t", chatId: 9 }, fetch: fetchImpl, log: () => {} }
  );
  assert.deepEqual(result, { ok: false, reason: "thread-not-found" });
});

test("#235/task-1 closeForumTopic: a rejecting fetch never throws, resolves { ok:false, reason:'transient' }, and the log stays redacted to op/type/status", async () => {
  const logs = [];
  const log = (entry) => logs.push(entry);
  const { fetchImpl } = makeFakeFetch(new Error("boom https://api.telegram.org/botSECRET123:abc/closeForumTopic"));

  let threw = false;
  let result;
  try {
    result = await closeForumTopic(
      { threadId: 5 },
      { config: { token: "SECRET123:abc", chatId: 9 }, fetch: fetchImpl, log }
    );
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "closeForumTopic must never throw on a network error");
  assert.deepEqual(result, { ok: false, reason: "transient" });

  assert.equal(logs.length, 1, "exactly one log entry for the failure");
  const [entry] = logs;
  assert.deepEqual(Object.keys(entry).sort(), ["op", "status", "type"], "the log entry must have exactly the keys op/type/status");
  assert.equal(entry.status, "error");

  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /SECRET123/, "the token must never be logged");
});

test("#235/task-1 closeForumTopic: a 2xx Telegram response resolves exactly { ok:true } with no reason key", async () => {
  const { fetchImpl } = makeFakeFetch({ ok: true, status: 200, json: async () => ({ ok: true, result: true }) });
  const result = await closeForumTopic({ threadId: 5 }, { config: { token: "t", chatId: 9 }, fetch: fetchImpl });
  assert.deepEqual(result, { ok: true });
  assert.ok(!("reason" in result), "the success shape must carry no reason key");
});

// ---------------------------------------------------------------------------
// isCriticalEvent — canonical critical-event classifier, exported (not the raw Set)
// (module does not yet export isCriticalEvent — RED until an executor implements it)
// ---------------------------------------------------------------------------

test("#ac-1.4 isCriticalEvent: exported canonical classifier for blocked/failed; CRITICAL_TYPES itself is NOT exported", () => {
  assert.equal(typeof isCriticalEvent, "function");
  assert.equal(isCriticalEvent({ type: "blocked" }), true);
  assert.equal(isCriticalEvent({ type: "failed" }), true);
  assert.equal(isCriticalEvent({ type: "picked" }), false);
  assert.equal(isCriticalEvent({ type: "pr-merged" }), false);
  assert.ok(!("CRITICAL_TYPES" in notifyTelegram), "CRITICAL_TYPES must stay module-private, never exported");
});

// ---------------------------------------------------------------------------
// createForumTopic — surfaces the chat it created the topic in (#ac-1.2)
// ---------------------------------------------------------------------------

test("#ac-1.2 createForumTopic: surfaces the chatId it created the topic in alongside threadId on success, and exactly {ok:false} on failure", async () => {
  const { fetchImpl } = makeFakeFetch({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_thread_id: 77 } }),
  });
  const success = await createForumTopic({ name: "x" }, { config: { token: "t", chatId: -100123 }, fetch: fetchImpl });
  assert.deepEqual(success, { ok: true, threadId: 77, chatId: -100123 });

  const { fetchImpl: fetchImpl2 } = makeFakeFetch(new Error("boom"));
  const failure = await createForumTopic(
    { name: "x" },
    { config: { token: "t", chatId: -100123 }, fetch: fetchImpl2, log: () => {} }
  );
  assert.deepEqual(failure, { ok: false }, "no chatId key, no threadId key, no extra keys on failure");
});

// ---------------------------------------------------------------------------
// spec-adversaried checkpoint render — the operator-facing 'Spec atacada' checkpoint. The event
// is seeded DIRECTLY into a fresh run's outbox (appendEvent) so these 4 tests exercise ONLY the
// render/curation contract (formatting + isCuratedFeedEvent membership) — the produced->consumed
// wiring across mark.mjs/stamp-triage.mjs is covered separately by the e2e test in
// spec-adversaried-e2e.test.mjs. (module does not yet export isCuratedFeedEvent, and
// 'spec-adversaried' is not yet in CURATED_FEED_TYPES/EMOJI/CHECKPOINT_LABELS/cosmeticBodyLines —
// RED until an executor implements the checkpoint.)
// ---------------------------------------------------------------------------

test("#spec-adversaried-1 drainTelegramOutbox: a SHIP verdict with findings:2 renders the emoji/label/count/verdict", async () => {
  const obsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-telegram-outbox-"));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "notify-telegram-worktree-"));
  try {
    const metaPath = createRun({ issueNumber: 201, project: "proj", worktreePath }, obsStateDir);
    updateMeta(metaPath, { threadId: 555 });
    appendEvent(metaPath, { type: "spec-adversaried", verdict: "SHIP", findings: 2 });

    const sendCalls = [];
    const fakeSend = async (message) => {
      sendCalls.push(message);
      return { sent: true };
    };

    await drainTelegramOutbox({ stateDir: obsStateDir, chatId: "shared-chat", threadId: 999 }, { send: fakeSend });

    const matching = sendCalls.filter((call) => call.event?.type === "spec-adversaried");
    const text = matching.map((call) => call.text).join(" ");
    assert.match(text, /Spec atacada/, "the checkpoint must render the 'Spec atacada' label");
    assert.match(text, /2 achados/, "the checkpoint must count the findings as '2 achados'");
    assert.match(text, /aprovado/, "a SHIP verdict must render as 'aprovado'");
  } finally {
    fs.rmSync(obsStateDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test("#spec-adversaried-2 drainTelegramOutbox: findings:1 pluralizes as '1 achado', never '1 achados'", async () => {
  const obsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-telegram-outbox-"));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "notify-telegram-worktree-"));
  try {
    const metaPath = createRun({ issueNumber: 202, project: "proj", worktreePath }, obsStateDir);
    updateMeta(metaPath, { threadId: 555 });
    appendEvent(metaPath, { type: "spec-adversaried", verdict: "SHIP", findings: 1 });

    const sendCalls = [];
    const fakeSend = async (message) => {
      sendCalls.push(message);
      return { sent: true };
    };

    await drainTelegramOutbox({ stateDir: obsStateDir, chatId: "shared-chat", threadId: 999 }, { send: fakeSend });

    const matching = sendCalls.filter((call) => call.event?.type === "spec-adversaried");
    const text = matching.map((call) => call.text).join(" ");
    assert.match(text, /\b1 achado\b/, "a single finding must be the singular '1 achado'");
    assert.doesNotMatch(text, /1 achados/, "a single finding must never pluralize as '1 achados'");
  } finally {
    fs.rmSync(obsStateDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test("#spec-adversaried-3 drainTelegramOutbox: a BLOCK verdict renders as 'bloqueado'", async () => {
  const obsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-telegram-outbox-"));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "notify-telegram-worktree-"));
  try {
    const metaPath = createRun({ issueNumber: 203, project: "proj", worktreePath }, obsStateDir);
    updateMeta(metaPath, { threadId: 555 });
    appendEvent(metaPath, { type: "spec-adversaried", verdict: "BLOCK", findings: 2 });

    const sendCalls = [];
    const fakeSend = async (message) => {
      sendCalls.push(message);
      return { sent: true };
    };

    await drainTelegramOutbox({ stateDir: obsStateDir, chatId: "shared-chat", threadId: 999 }, { send: fakeSend });

    const matching = sendCalls.filter((call) => call.event?.type === "spec-adversaried");
    const text = matching.map((call) => call.text).join(" ");
    assert.match(text, /bloqueado/, "a BLOCK verdict must render as 'bloqueado'");
  } finally {
    fs.rmSync(obsStateDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test("#spec-adversaried-4 isCuratedFeedEvent: a spec-adversaried event reaches the curated Telegram feed", () => {
  assert.equal(isCuratedFeedEvent({ type: "spec-adversaried" }), true);
});
