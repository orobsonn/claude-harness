/**
 * @description Pins AC-2.1 (appendEvent stamps a real event.ts) and AC-2.2 (formatCheckpointTime
 * renders that ts in America/Sao_Paulo) of issue #251 — the Telegram checkpoint timestamp fix.
 * Each test uses a fresh temp state dir (mkdtempSync + os.tmpdir()) and cleans up after itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendEvent, readEvents } from "../shared/lib/obs-outbox.mjs";
import { formatCheckpointTime } from "./notify-telegram.mjs";

/** @description Creates a fresh, isolated state dir for one test. */
function makeStateDir() {
  return mkdtempSync(join(tmpdir(), "checkpoint-ts-test-"));
}

test("#ac-2.1 appendEvent: stamps an ISO ts when the event has none", () => {
  const dir = makeStateDir();
  try {
    const metaPath = join(dir, "obs-9.json");
    appendEvent(metaPath, { type: "picked" });
    const events = readEvents(metaPath);
    assert.equal(events.length, 1, "exactly 1 event must be recorded");
    const [ev] = events;
    assert.equal(typeof ev.ts, "string", "ts must be stamped as a string");
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(ev.ts),
      `ts must look like ISO 8601, got: ${ev.ts}`
    );
    assert.equal(
      new Date(ev.ts).toISOString(),
      ev.ts,
      "ts must round-trip through Date/toISOString unchanged"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#ac-2.1 appendEvent: preserves a caller-provided ts", () => {
  const dir = makeStateDir();
  try {
    const metaPath = join(dir, "obs-9.json");
    appendEvent(metaPath, { type: "pr", ts: "2020-01-02T03:04:05.000Z" });
    const events = readEvents(metaPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].ts, "2020-01-02T03:04:05.000Z", "a caller-supplied ts must not be overwritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#ac-2.1 appendEvent: tolerates a non-object event without throwing", () => {
  const dir = makeStateDir();
  try {
    const metaPath = join(dir, "obs-9.json");
    assert.doesNotThrow(() => appendEvent(metaPath, "x"), "a non-object event must never crash the append");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#ac-2.2 formatCheckpointTime: renders a known ISO instant as HH:MM in America/Sao_Paulo", () => {
  assert.equal(formatCheckpointTime("2026-07-10T17:32:00.000Z"), "14:32");
});

test("#ac-2.2 formatCheckpointTime: returns \"\" for undefined, empty string, an unparseable string, and a non-string", () => {
  assert.equal(formatCheckpointTime(undefined), "");
  assert.equal(formatCheckpointTime(""), "");
  assert.equal(formatCheckpointTime("not-a-date"), "");
  assert.equal(formatCheckpointTime(123), "");
});
