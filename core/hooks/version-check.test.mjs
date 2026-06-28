import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSemver, compareSemver, decide, resolveRemoteTag, handle } from "./version-check.mjs";

test("parseSemver", () => {
  assert.deepEqual(parseSemver("v0.14.4"), { major: 0, minor: 14, patch: 4 });
  assert.deepEqual(parseSemver("0.14.4"), { major: 0, minor: 14, patch: 4 });
  assert.deepEqual(parseSemver("v0.14.4-3-gabcdef"), { major: 0, minor: 14, patch: 4 });
  assert.equal(parseSemver("abc1234"), null);
  assert.equal(parseSemver(""), null);
  assert.equal(parseSemver("garbage"), null);
});

test("compareSemver numeric not lexical", () => {
  assert.equal(compareSemver({major:0,minor:9,patch:0}, {major:0,minor:10,patch:0}), -1);
  assert.equal(compareSemver({major:0,minor:10,patch:0}, {major:0,minor:9,patch:0}), 1);
  assert.equal(compareSemver({major:0,minor:15,patch:0}, {major:0,minor:15,patch:0}), 0);
  assert.equal(compareSemver({major:1,minor:0,patch:0}, {major:0,minor:99,patch:99}), 1);
});

test("decide up-to-date returns null", () => {
  assert.equal(decide({ localVersion: "v0.15.0", remoteTag: "v0.15.0" }), null);
  assert.equal(decide({ localVersion: "v0.10.0", remoteTag: "v0.9.0" }), null);
  assert.equal(decide({ localVersion: "v0.15.0-2-gabc123", remoteTag: "v0.15.0" }), null);
  assert.equal(decide({ localVersion: "v0.16.0", remoteTag: "v0.15.0" }), null);
  assert.equal(decide({ localVersion: "abc1234", remoteTag: "v0.15.0" }), null);
  assert.equal(decide({ localVersion: "v0.14.4", remoteTag: "garbage" }), null);
});

test("decide stale returns systemMessage", () => {
  const d = decide({ localVersion: "v0.14.4", remoteTag: "v0.15.0" });
  assert.ok(d && typeof d.systemMessage === "string");
  assert.ok(d.systemMessage.includes("0.14.4"));
  assert.ok(d.systemMessage.includes("0.15.0"));
  assert.ok(d.systemMessage.includes("updating-harness"));
  assert.ok(d.systemMessage.includes("reinicie"));
  // numeric-stale case also nags:
  assert.ok(decide({ localVersion: "v0.9.0", remoteTag: "v0.10.0" }) !== null);
});

test("resolveRemoteTag cache fresh skips fetch", () => {
  let fetched = 0, wrote = 0;
  const tag = resolveRemoteTag({
    nowMs: 1000 + 3600000,
    readCache: () => ({ tag: "v0.15.0", cachedAt: 1000 }),
    writeCache: () => { wrote++; },
    fetchRemoteTag: () => { fetched++; return "v9.9.9"; },
    ttlMs: 21600000,
  });
  assert.equal(tag, "v0.15.0");
  assert.equal(fetched, 0);
  assert.equal(wrote, 0);
});

test("resolveRemoteTag cache stale fetches and writes", () => {
  let fetched = 0; let writtenArg = null;
  const now = 7 * 3600000;
  const tag = resolveRemoteTag({
    nowMs: now,
    readCache: () => ({ tag: "v0.14.0", cachedAt: 0 }),
    writeCache: (o) => { writtenArg = o; },
    fetchRemoteTag: () => { fetched++; return "v0.15.0"; },
    ttlMs: 21600000,
  });
  assert.equal(tag, "v0.15.0");
  assert.equal(fetched, 1);
  assert.deepEqual(writtenArg, { tag: "v0.15.0", cachedAt: now });
});

test("resolveRemoteTag cache absent fetches", () => {
  let fetched = 0;
  const tag = resolveRemoteTag({
    nowMs: 5000,
    readCache: () => null,
    writeCache: () => {},
    fetchRemoteTag: () => { fetched++; return "v0.15.0"; },
    ttlMs: 21600000,
  });
  assert.equal(tag, "v0.15.0");
  assert.equal(fetched, 1);
});

test("resolveRemoteTag future timestamp treated as miss", () => {
  let fetched = 0;
  const now = 1000000;
  const tag = resolveRemoteTag({
    nowMs: now,
    readCache: () => ({ tag: "v0.1.0", cachedAt: now + 999999 }),
    writeCache: () => {},
    fetchRemoteTag: () => { fetched++; return "v0.15.0"; },
    ttlMs: 21600000,
  });
  assert.equal(tag, "v0.15.0");
  assert.equal(fetched, 1);
});

test("resolveRemoteTag corrupt cache shape treated as miss", () => {
  let fetched = 0;
  const tag = resolveRemoteTag({
    nowMs: 5000,
    readCache: () => ({ garbage: true }),
    writeCache: () => {},
    fetchRemoteTag: () => { fetched++; return "v0.15.0"; },
    ttlMs: 21600000,
  });
  assert.equal(tag, "v0.15.0");
  assert.equal(fetched, 1);
});

test("resolveRemoteTag fetch null returns null no write", () => {
  let wrote = 0;
  const tag = resolveRemoteTag({
    nowMs: 5000,
    readCache: () => null,
    writeCache: () => { wrote++; },
    fetchRemoteTag: () => null,
    ttlMs: 21600000,
  });
  assert.equal(tag, null);
  assert.equal(wrote, 0);
});

test("handle headless is total no-op", () => {
  let localCalls = 0, remoteCalls = 0;
  const r = handle({}, {
    env: { CLAUDE_CODE_REMOTE: "1" },
    readLocalVersion: () => { localCalls++; return "v0.14.4"; },
    resolveRemoteTag: () => { remoteCalls++; return "v0.15.0"; },
    nowMs: 0,
  });
  assert.equal(r, null);
  assert.equal(localCalls, 0);
  assert.equal(remoteCalls, 0);
});

test("handle up-to-date returns null", () => {
  const r = handle({}, {
    env: {},
    readLocalVersion: () => "v0.15.0",
    resolveRemoteTag: () => "v0.15.0",
    nowMs: 0,
  });
  assert.equal(r, null);
});

test("handle stale returns systemMessage with continue true", () => {
  const r = handle({}, {
    env: {},
    readLocalVersion: () => "v0.14.4",
    resolveRemoteTag: () => "v0.15.0",
    nowMs: 0,
  });
  assert.ok(r && typeof r.systemMessage === "string");
  assert.ok(r.systemMessage.includes("updating-harness"));
  assert.equal(r.continue, true);
});

test("handle no local short-circuits before remote", () => {
  let remoteCalls = 0;
  const r = handle({}, {
    env: {},
    readLocalVersion: () => null,
    resolveRemoteTag: () => { remoteCalls++; return "v0.15.0"; },
    nowMs: 0,
  });
  assert.equal(r, null);
  assert.equal(remoteCalls, 0);
});

test("handle remote null fails open", () => {
  const r = handle({}, {
    env: {},
    readLocalVersion: () => "v0.14.4",
    resolveRemoteTag: () => null,
    nowMs: 0,
  });
  assert.equal(r, null);
});

test("handle throw inside dep fails open returns null", () => {
  const r = handle({}, {
    env: {},
    readLocalVersion: () => { throw new Error("boom"); },
    resolveRemoteTag: () => "v0.15.0",
    nowMs: 0,
  });
  assert.equal(r, null);
});