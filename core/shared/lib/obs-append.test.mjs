/**
 * @description Locked tests for shared obs-append (fail-open JSONL outbox).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, readEvents, metaExists, eventsPathFor } from "./obs-append.mjs";

test("metaExists: false for unset/missing; true for existing file", () => {
  assert.equal(metaExists(null), false);
  assert.equal(metaExists(""), false);
  const dir = mkdtempSync(join(tmpdir(), "obs-meta-"));
  try {
    const meta = join(dir, "obs-1.json");
    assert.equal(metaExists(meta), false);
    writeFileSync(meta, "{}");
    assert.equal(metaExists(meta), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendEvent + readEvents: round-trip with ts stamp; never throws on bad path", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-ap-"));
  try {
    const meta = join(dir, "obs-9.json");
    writeFileSync(meta, JSON.stringify({ issueNumber: 9 }));
    appendEvent(meta, { type: "pipeline-type", mode: "FULL" });
    const ev = readEvents(meta);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, "pipeline-type");
    assert.equal(ev[0].mode, "FULL");
    assert.ok(typeof ev[0].ts === "string" && ev[0].ts.length > 0);
    // preserve producer ts
    appendEvent(meta, { type: "picked", ts: "2020-01-01T00:00:00.000Z" });
    const ev2 = readEvents(meta);
    assert.equal(ev2[1].ts, "2020-01-01T00:00:00.000Z");
    // fail-open (best-effort smoke: a bad path may or may not throw depending on OS/user perms)
    assert.doesNotThrow(() => appendEvent("/no/such/dir/obs.json", { type: "x" }));
    assert.deepEqual(readEvents("/no/such/obs.json"), []);
    assert.equal(eventsPathFor(meta), meta.replace(/\.json$/, ".events.jsonl"));
    assert.ok(existsSync(eventsPathFor(meta)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendEvent: fail-open when the write itself throws (hermetic, no reliance on OS perms)", () => {
  const throwingIo = {
    mkdirSync: () => {
      throw new Error("disk full");
    },
    appendFileSync: () => {
      throw new Error("disk full");
    },
  };
  assert.doesNotThrow(() => appendEvent("/any/path/obs.json", { type: "x" }, throwingIo));
});

test("readEvents: fail-open when the read itself throws (hermetic, no reliance on OS perms)", () => {
  const throwingIo = {
    readFileSync: () => {
      throw new Error("ENOENT");
    },
  };
  assert.deepEqual(readEvents("/any/path/obs.json", throwingIo), []);
});
