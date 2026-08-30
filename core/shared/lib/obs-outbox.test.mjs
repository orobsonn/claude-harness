/**
 * @description Frozen oracle for the per-run observability outbox persistence lib
 * (obs-outbox.mjs). Every test uses a fresh temp state dir (mkdtempSync + os.tmpdir()),
 * never touches a shared/real path, and cleans up after itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRun, appendEvent, readEvents, readMeta, advanceCursor, updateMeta, updateMetaIfUnchanged } from "./obs-outbox.mjs";

/** @description Creates a fresh, isolated state dir for one test. */
function makeStateDir() {
  return mkdtempSync(path.join(tmpdir(), "obs-outbox-test-"));
}

/** @description Path to the events JSONL sibling of a meta path. */
function eventsPathFor(metaPath) {
  return metaPath.replace(/\.json$/, ".events.jsonl");
}

test("#1 createRun: no existing outbox writes obs-<issue>.json with the expected initial shape", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    const expectedPath = path.join(stateDir, "obs-141.json");
    assert.equal(metaPath, expectedPath, "createRun must return the meta path");
    assert.ok(existsSync(expectedPath), "obs-141.json must exist");
    const meta = JSON.parse(readFileSync(expectedPath, "utf8"));
    assert.deepEqual(meta, {
      issueNumber: 141,
      project: "p",
      worktreePath: "/w",
      threadId: null,
      cursor: 0,
      status: "active",
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#2 appendEvent: called twice appends exactly 2 ordered JSON lines to obs-<issue>.events.jsonl", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    appendEvent(metaPath, { type: "eye", role: "compliance", n: 0 });
    appendEvent(metaPath, { type: "eye", role: "compliance", n: 1 });
    const eventsPath = eventsPathFor(metaPath);
    assert.equal(eventsPath, path.join(stateDir, "obs-141.events.jsonl"));
    const lines = readFileSync(eventsPath, "utf8").split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 2, "exactly 2 lines must be present");
    // appendEvent stamps an ISO `ts` at append time (issue #251, AC-2.1); assert the payload fields
    // minus the stamp, and that a valid ISO ts is present.
    const { ts: ts0, ...payload0 } = JSON.parse(lines[0]);
    const { ts: ts1, ...payload1 } = JSON.parse(lines[1]);
    assert.deepEqual(payload0, { type: "eye", role: "compliance", n: 0 });
    assert.deepEqual(payload1, { type: "eye", role: "compliance", n: 1 });
    assert.match(ts0, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(ts1, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#3 advanceCursor: meta cursor 0 with 3 events, advanceCursor(metaPath, 2) leaves exactly 1 unsent event", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    appendEvent(metaPath, { type: "e", n: 0 });
    appendEvent(metaPath, { type: "e", n: 1 });
    appendEvent(metaPath, { type: "e", n: 2 });
    advanceCursor(metaPath, 2);
    assert.equal(readMeta(metaPath).cursor, 2, "cursor must be advanced to 2");
    const unsent = readEvents(metaPath).slice(2);
    assert.equal(unsent.length, 1, "exactly the single unsent event must remain past the cursor");
    const { ts: unsentTs, ...unsentPayload } = unsent[0];
    assert.deepEqual(unsentPayload, { type: "e", n: 2 });
    assert.match(unsentTs, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#4 advanceCursor: atomic rewrite leaves no leftover .tmp file and obs-141.json still parses cleanly", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    advanceCursor(metaPath, 2);
    const files = readdirSync(stateDir);
    assert.ok(!files.some((f) => f.includes(".tmp")), "no leftover .tmp file after the atomic rewrite");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(meta.cursor, 2, "obs-141.json must parse cleanly with the new cursor");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#5 createRun: active re-dispatch preserves the audit and appends tentativa 2", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = path.join(stateDir, "obs-141.json");
    const eventsPath = path.join(stateDir, "obs-141.events.jsonl");
    writeFileSync(
      metaPath,
      JSON.stringify({ issueNumber: 141, project: "p", worktreePath: "/w", threadId: 707, cursor: 0, status: "active" })
    );
    writeFileSync(eventsPath, [{ a: 1 }, { a: 2 }, { a: 3 }].map((e) => JSON.stringify(e)).join("\n") + "\n");

    const returnedPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    assert.equal(returnedPath, metaPath, "createRun must resolve to the same existing meta path");

    const meta = readMeta(metaPath);
    assert.equal(meta.threadId, 707, "threadId must not be reset by a re-run createRun");
    assert.deepEqual(
      readEvents(metaPath).map(({ ts, ...event }) => event),
      [{ a: 1 }, { a: 2 }, { a: 3 }, { type: "attempt-started", attempt: 2 }],
      "existing events must not be reset/dropped; the retry is an append-only boundary",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#6 updateMeta: partial merge sets threadId+status, leaves the rest untouched, no leftover .tmp file", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    updateMeta(metaPath, { threadId: 707, status: "closed" });
    const meta = readMeta(metaPath);
    assert.equal(meta.threadId, 707);
    assert.equal(meta.status, "closed");
    assert.equal(meta.issueNumber, 141, "issueNumber must be unchanged by a partial update");
    assert.equal(meta.project, "p", "project must be unchanged by a partial update");
    assert.equal(meta.worktreePath, "/w", "worktreePath must be unchanged by a partial update");
    assert.equal(meta.cursor, 0, "cursor must be unchanged by a partial update");
    const files = readdirSync(stateDir);
    assert.ok(!files.some((f) => f.includes(".tmp")), "no leftover .tmp file after the atomic partial merge");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#7 readEvents: a truncated last line (in-flight append, no trailing newline) is skipped, not dropped to []", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    const eventsPath = eventsPathFor(metaPath);
    const complete = [
      { type: "e", n: 0 },
      { type: "e", n: 1 },
    ];
    const truncatedTail = '{"type":"e","n":2,"incompl';
    writeFileSync(eventsPath, complete.map((e) => JSON.stringify(e)).join("\n") + "\n" + truncatedTail);

    let events;
    let threw = false;
    try {
      events = readEvents(metaPath);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "readEvents must never throw on a truncated trailing line");
    assert.equal(events.length, 2, "exactly the 2 complete events must be returned, not [] and not 3");
    assert.deepEqual(events, complete);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#8b createRun: orphan re-dispatch reactivates append-only, preserving cursor and thread", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 291, project: "claude-harness", worktreePath: "/old/wt" }, stateDir);
    updateMeta(metaPath, { status: "orphan", threadId: 1653, cursor: 2, chatId: -100 });
    appendEvent(metaPath, { type: "picked" });
    appendEvent(metaPath, { type: "pipeline-type", mode: "LIGHT" });
    advanceCursor(metaPath, 2);

    const returnedPath = createRun(
      { issueNumber: 291, project: "claude-harness", worktreePath: "/new/wt-291" },
      stateDir,
    );
    assert.equal(returnedPath, metaPath);
    const meta = readMeta(metaPath);
    assert.equal(meta.status, "active", "orphan must reactivate to active");
    assert.equal(meta.threadId, 1653, "threadId preserved for existing forum topic");
    assert.equal(meta.cursor, 2, "cursor stays monotonic; old events are never replayed");
    assert.equal(meta.worktreePath, "/new/wt-291", "worktreePath refreshed");
    assert.deepEqual(
      readEvents(metaPath).map(({ ts, ...event }) => event),
      [{ type: "picked" }, { type: "pipeline-type", mode: "LIGHT" }, { type: "attempt-started", attempt: 2 }],
      "the original audit is kept and the retry is explicitly delimited",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#8 createRun: awaiting-review re-dispatch preserves events/cursor and appends a boundary", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    updateMeta(metaPath, { status: "awaiting-review", threadId: 777, cursor: 2 });
    appendEvent(metaPath, { type: "e", n: 0 });
    appendEvent(metaPath, { type: "e", n: 1 });
    assert.equal(readEvents(metaPath).length, 2, "sanity: 2 events must be seeded before the re-dispatch");

    const returnedPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    assert.equal(returnedPath, metaPath, "createRun must resolve to the same meta path");

    assert.deepEqual(
      readEvents(metaPath).map(({ ts, ...event }) => event),
      [{ type: "e", n: 0 }, { type: "e", n: 1 }, { type: "attempt-started", attempt: 2 }],
      "events log remains append-only",
    );
    const meta = readMeta(metaPath);
    assert.equal(meta.cursor, 2, "cursor must not rewind on an awaiting-review re-dispatch");
    assert.equal(meta.threadId, 777, "threadId must be PRESERVED across an awaiting-review re-dispatch");
    assert.equal(meta.status, "active", "status must transition back to active on re-dispatch");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#9 createRun: active re-dispatch appends one boundary without resetting events or cursor", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    appendEvent(metaPath, { type: "e", n: 0 });
    appendEvent(metaPath, { type: "e", n: 1 });
    advanceCursor(metaPath, 1);
    assert.equal(readMeta(metaPath).status, "active", "sanity: meta must be active before the re-dispatch");

    const returnedPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    assert.equal(returnedPath, metaPath, "createRun must resolve to the same meta path");

    assert.deepEqual(
      readEvents(metaPath).map(({ ts, ...event }) => event),
      [{ type: "e", n: 0 }, { type: "e", n: 1 }, { type: "attempt-started", attempt: 2 }],
      "events must NOT be truncated on an active re-dispatch",
    );
    assert.equal(readMeta(metaPath).cursor, 1, "cursor must be unchanged on an active re-dispatch");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.3 updateMetaIfUnchanged: CAS match applies the patch and returns true", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = path.join(stateDir, "obs-201.json");
    const baseline = {
      issueNumber: 201,
      project: "p",
      worktreePath: "/w",
      status: "closed",
      closedAt: 100,
      threadId: 5,
      chatId: 9,
      cursor: 0,
    };
    writeFileSync(metaPath, JSON.stringify(baseline));

    const result = updateMetaIfUnchanged(
      metaPath,
      { status: "closed", closedAt: 100, threadId: 5, chatId: 9 },
      { topicDeletedAt: 200 }
    );
    assert.equal(result, true, "CAS must succeed when the snapshot matches the on-disk meta");

    const meta = readMeta(metaPath);
    assert.equal(meta.topicDeletedAt, 200, "the patch must be applied on a CAS match");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.3 updateMetaIfUnchanged: CAS divergence rejects the patch and returns false", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = path.join(stateDir, "obs-202.json");
    const baseline = {
      issueNumber: 202,
      project: "p",
      worktreePath: "/w",
      status: "closed",
      closedAt: 100,
      threadId: 5,
      chatId: 9,
      cursor: 0,
    };
    writeFileSync(metaPath, JSON.stringify(baseline));

    // Diverges on disk AFTER the snapshot was taken (simulating a concurrent writer).
    writeFileSync(metaPath, JSON.stringify({ ...baseline, status: "active" }));

    const result = updateMetaIfUnchanged(
      metaPath,
      { status: "closed", closedAt: 100, threadId: 5, chatId: 9 },
      { topicDeletedAt: 200 }
    );
    assert.equal(result, false, "CAS must fail when the on-disk meta has diverged from the snapshot");

    const meta = readMeta(metaPath);
    assert.ok(!("topicDeletedAt" in meta), "the patch must NOT be applied on a CAS divergence");
    assert.equal(meta.status, "active", "the on-disk divergent status must be left untouched");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.7 createRun: awaiting-review reuse strips closedAt/topicDeletedAt fossils, preserves threadId/chatId", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = path.join(stateDir, "obs-203.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 203,
        project: "p",
        worktreePath: "/w",
        status: "awaiting-review",
        closedAt: 100,
        topicDeletedAt: 200,
        threadId: 5,
        chatId: 9,
        cursor: 3,
      })
    );

    const returnedPath = createRun({ issueNumber: 203, project: "p", worktreePath: "/w" }, stateDir);
    assert.equal(returnedPath, metaPath, "createRun must resolve to the same existing meta path");

    const meta = readMeta(metaPath);
    assert.equal(meta.status, "active", "status must transition back to active on reuse");
    assert.equal(meta.cursor, 3, "cursor must remain monotonic on reuse");
    assert.ok(!("closedAt" in meta), "closedAt fossil must be stripped on reuse");
    assert.ok(!("topicDeletedAt" in meta), "topicDeletedAt fossil must be stripped on reuse");
    assert.equal(meta.threadId, 5, "threadId must be preserved across reuse");
    assert.equal(meta.chatId, 9, "chatId must be preserved across reuse");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.7 createRun: awaiting-review reuse preserves the event audit and appends attempt 2", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = path.join(stateDir, "obs-204.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 204,
        project: "p",
        worktreePath: "/w",
        status: "awaiting-review",
        closedAt: 100,
        topicDeletedAt: 200,
        threadId: 5,
        chatId: 9,
        cursor: 3,
      })
    );
    appendEvent(metaPath, { type: "e", n: 0 });
    appendEvent(metaPath, { type: "e", n: 1 });
    assert.equal(readEvents(metaPath).length, 2, "sanity: 2 events must be seeded before the reuse");

    const returnedPath = createRun({ issueNumber: 204, project: "p", worktreePath: "/w" }, stateDir);
    assert.equal(returnedPath, metaPath, "createRun must resolve to the same existing meta path");

    assert.deepEqual(
      readEvents(metaPath).map(({ ts, ...event }) => event),
      [{ type: "e", n: 0 }, { type: "e", n: 1 }, { type: "attempt-started", attempt: 2 }],
      "events log remains append-only on an awaiting-review reuse",
    );
    const meta = readMeta(metaPath);
    assert.equal(meta.status, "active");
    assert.equal(meta.cursor, 3);
    assert.ok(!("closedAt" in meta), "closedAt fossil must be stripped on reuse");
    assert.ok(!("topicDeletedAt" in meta), "topicDeletedAt fossil must be stripped on reuse");
    assert.equal(meta.threadId, 5);
    assert.equal(meta.chatId, 9);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.7 createRun: plain active reuse strips fossils and appends attempt 2", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = path.join(stateDir, "obs-205.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 205,
        project: "p",
        worktreePath: "/w",
        status: "active",
        cursor: 4,
        closedAt: 100,
        topicDeletedAt: 200,
        threadId: 5,
      })
    );
    appendEvent(metaPath, { type: "e", n: 0 });
    appendEvent(metaPath, { type: "e", n: 1 });

    const returnedPath = createRun({ issueNumber: 205, project: "p", worktreePath: "/w" }, stateDir);
    assert.equal(returnedPath, metaPath, "createRun must resolve to the same existing meta path");

    const meta = readMeta(metaPath);
    assert.ok(!("closedAt" in meta), "closedAt fossil must be stripped on a plain active reuse");
    assert.ok(!("topicDeletedAt" in meta), "topicDeletedAt fossil must be stripped on a plain active reuse");
    assert.equal(meta.threadId, 5, "threadId must be preserved on a plain active reuse");
    assert.equal(meta.cursor, 4, "cursor must be preserved on a plain active reuse");

    const events = readEvents(metaPath);
    assert.equal(events.length, 3, "the events log must remain append-only on a plain active reuse");
    assert.deepEqual(
      events.map(({ ts, ...rest }) => rest),
      [
        { type: "e", n: 0 },
        { type: "e", n: 1 },
        { type: "attempt-started", attempt: 2 },
      ],
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.7 createRun: plain active reuse with no fossil only appends its attempt boundary", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = path.join(stateDir, "obs-206.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 206,
        project: "p",
        worktreePath: "/w",
        status: "active",
        cursor: 4,
        threadId: 5,
      })
    );
    const before = readFileSync(metaPath, "utf8");

    const returnedPath = createRun({ issueNumber: 206, project: "p", worktreePath: "/w" }, stateDir);
    assert.equal(returnedPath, metaPath, "createRun must resolve to the same existing meta path");

    const after = readFileSync(metaPath, "utf8");
    assert.equal(after, before, "a fossil-free active reuse must not rewrite the meta file at all");
    assert.deepEqual(
      readEvents(metaPath).map(({ ts, ...event }) => event),
      [{ type: "attempt-started", attempt: 2 }],
      "the event log records the retry without widening the meta state",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.7 createRun: fresh createRun's initial meta literal stays frozen (no chatId/closedAt/topicDeletedAt)", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 207, project: "p", worktreePath: "/w" }, stateDir);
    const meta = readMeta(metaPath);
    assert.deepEqual(meta, {
      issueNumber: 207,
      project: "p",
      worktreePath: "/w",
      threadId: null,
      cursor: 0,
      status: "active",
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- #807 gap tests (issue #807 §3.1): the extraction moved obs-outbox's home; these tests were
// never written for the ORIGINAL module either. Added here, at the new home, without touching any
// module behavior — a failure below is a pre-existing defect for a separate issue, not something
// to fix as part of this address change. ---

test("#807-gap readMeta: round-trips a written meta, returns null on a missing path, and returns null on corrupt (non-JSON) content — never throws", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 301, project: "p", worktreePath: "/w" }, stateDir);
    assert.deepEqual(readMeta(metaPath), {
      issueNumber: 301,
      project: "p",
      worktreePath: "/w",
      threadId: null,
      cursor: 0,
      status: "active",
    }, "readMeta must round-trip exactly what createRun wrote");

    const missingPath = path.join(stateDir, "obs-999999.json");
    assert.equal(readMeta(missingPath), null, "a missing meta path must return null, never throw");

    const corruptPath = path.join(stateDir, "obs-corrupt.json");
    writeFileSync(corruptPath, "{ not valid json", "utf8");
    assert.equal(readMeta(corruptPath), null, "corrupt (non-JSON) meta content must return null, never throw");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#807-gap createRun: a non-integer issueNumber ('../../x') is rejected before any path.join, returns null and writes nothing", () => {
  const stateDir = makeStateDir();
  const parentBefore = readdirSync(path.dirname(stateDir));
  try {
    const result = createRun({ issueNumber: "../../x", project: "p", worktreePath: "/w" }, stateDir);
    assert.equal(result, null, "a non-integer issueNumber must be rejected with a null return");
    assert.deepEqual(readdirSync(stateDir), [], "no file must be written inside stateDir");
    assert.deepEqual(
      readdirSync(path.dirname(stateDir)),
      parentBefore,
      "no file must be written outside stateDir either — the traversal guard must not merely fail late",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#807-gap appendEvent: a non-string metaPath is a silent no-op, and an unwritable eventsPath never throws or propagates", () => {
  const stateDir = makeStateDir();
  try {
    assert.doesNotThrow(() => appendEvent(123, { type: "x" }), "a non-string metaPath must never throw");
    assert.doesNotThrow(() => appendEvent(null, { type: "x" }), "a null metaPath must never throw");
    assert.doesNotThrow(() => appendEvent(undefined, { type: "x" }), "an undefined metaPath must never throw");

    // An eventsPath whose parent directory cannot be created (its own parent is a REGULAR FILE, not
    // a directory) makes mkdirSync(dirname(eventsPath), { recursive: true }) throw ENOTDIR internally
    // — appendEvent's docstring promises "a failed append must never propagate to the session hook".
    const blockerFile = path.join(stateDir, "blocker");
    writeFileSync(blockerFile, "not a directory", "utf8");
    const unwritableMetaPath = path.join(blockerFile, "nested", "obs-1.json");
    assert.doesNotThrow(
      () => appendEvent(unwritableMetaPath, { type: "x" }),
      "appendEvent must never propagate a failure writing to an unwritable events path",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#807-gap readEvents: fail-open on missing/empty files, and a torn MIDDLE line is skipped while surrounding complete events survive", () => {
  const stateDir = makeStateDir();
  try {
    const missingMetaPath = path.join(stateDir, "obs-404.json");
    assert.deepEqual(readEvents(missingMetaPath), [], "a missing events file must return []");

    const emptyMetaPath = path.join(stateDir, "obs-empty.json");
    writeFileSync(eventsPathFor(emptyMetaPath), "", "utf8");
    assert.deepEqual(readEvents(emptyMetaPath), [], "an empty events file must return []");

    // The module's own docstring documents the MIDDLE-line tear case explicitly (a concurrent
    // append > PIPE_BUF can tear a line other than the last); today only the LAST-line case is
    // pinned anywhere in this suite.
    const tornMetaPath = path.join(stateDir, "obs-torn.json");
    const tornEventsPath = eventsPathFor(tornMetaPath);
    const first = JSON.stringify({ type: "first", n: 1 });
    const torn = '{"type":"torn", "n":2, unterminated';
    const last = JSON.stringify({ type: "last", n: 3 });
    writeFileSync(tornEventsPath, `${first}\n${torn}\n${last}\n`, "utf8");
    assert.deepEqual(
      readEvents(tornMetaPath),
      [{ type: "first", n: 1 }, { type: "last", n: 3 }],
      "a torn middle line must be skipped silently while the complete events around it survive",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#807-gap atomicWriteMeta failure path (via updateMeta): an unwritable meta directory returns without throwing and leaves no .tmp residue", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 512, project: "p", worktreePath: "/w" }, stateDir);
    // Make stateDir read-only (no write/execute-for-create) AFTER the meta already exists, so
    // updateMeta's readMetaRecord succeeds but atomicWriteMeta's writeFileSync(tmpPath, ...) fails.
    chmodSync(stateDir, 0o555);
    try {
      assert.doesNotThrow(
        () => updateMeta(metaPath, { status: "closed" }),
        "updateMeta must never throw when the meta directory is unwritable",
      );
    } finally {
      chmodSync(stateDir, 0o755);
    }
    const residue = readdirSync(stateDir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(residue, [], "atomicWriteMeta's failure path must never leave a .tmp file behind");
    // The meta on disk must be untouched by the failed write (fail-open, not partial-write).
    const meta = readMeta(metaPath);
    assert.equal(meta.status, "active", "a failed write must not have mutated the on-disk meta");
  } finally {
    chmodSync(stateDir, 0o755);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REHOMED from core/notify/checkpoint-timestamp.test.mjs (#834).
// That file imported BOTH this live module and the retired notify-telegram, so
// deleting core/notify/ would have taken these three oracles with it — they pin
// `appendEvent`, which has four production importers and which #834 declared
// untouchable. Exactly the #807 lesson: an oracle for live code hidden inside a
// doomed directory. The two formatCheckpointTime tests that shared that file
// pinned the notifier and correctly went with it.
// ---------------------------------------------------------------------------

test("#ac-2.1 appendEvent: stamps an ISO ts when the event has none", () => {
  const dir = makeStateDir();
  try {
    const metaPath = path.join(dir, "obs-9.json");
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
    const metaPath = path.join(dir, "obs-9.json");
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
    const metaPath = path.join(dir, "obs-9.json");
    assert.doesNotThrow(() => appendEvent(metaPath, "x"), "a non-object event must never crash the append");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
