/**
 * @description Frozen oracle for the VPS Telegram notification module (notify-telegram.mjs).
 * One-way, best-effort, fail-open. Every network call is an INJECTED fake fetch — ZERO real
 * network, ZERO real fs, and the tests never need a real bot token. Mirrors run-crons.test.mjs:
 * node:test + injected fakes observing behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatEvent,
  sendNotification,
  readTelegramToken,
  resolveNotifyConfig,
  makeNotifier,
  summarizeIssueBody,
} from "./notify-telegram.mjs";

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
