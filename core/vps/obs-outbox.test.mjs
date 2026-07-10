/**
 * @description Frozen oracle for the per-run observability outbox persistence lib
 * (obs-outbox.mjs). Every test uses a fresh temp state dir (mkdtempSync + os.tmpdir()),
 * never touches a shared/real path, and cleans up after itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
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

test("#5 createRun: idempotent reuse — an existing non-closed outbox is never reset (threadId/events preserved)", () => {
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
    assert.equal(readEvents(metaPath).length, 3, "existing events must not be reset/dropped");
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

test("#8 createRun: re-dispatch on an 'awaiting-review' meta truncates events + resets cursor, but preserves threadId (reuse-with-truncate)", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    updateMeta(metaPath, { status: "awaiting-review", threadId: 777, cursor: 2 });
    appendEvent(metaPath, { type: "e", n: 0 });
    appendEvent(metaPath, { type: "e", n: 1 });
    assert.equal(readEvents(metaPath).length, 2, "sanity: 2 events must be seeded before the re-dispatch");

    const returnedPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    assert.equal(returnedPath, metaPath, "createRun must resolve to the same meta path");

    assert.deepEqual(readEvents(metaPath), [], "events log must be truncated on an awaiting-review re-dispatch");
    const meta = readMeta(metaPath);
    assert.equal(meta.cursor, 0, "cursor must be reset to 0 on an awaiting-review re-dispatch");
    assert.equal(meta.threadId, 777, "threadId must be PRESERVED across an awaiting-review re-dispatch");
    assert.equal(meta.status, "active", "status must transition back to active on re-dispatch");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#9 createRun: re-dispatch on an 'active' meta is unchanged — events and cursor are NOT reset (no regression)", () => {
  const stateDir = makeStateDir();
  try {
    const metaPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    appendEvent(metaPath, { type: "e", n: 0 });
    appendEvent(metaPath, { type: "e", n: 1 });
    advanceCursor(metaPath, 1);
    assert.equal(readMeta(metaPath).status, "active", "sanity: meta must be active before the re-dispatch");

    const returnedPath = createRun({ issueNumber: 141, project: "p", worktreePath: "/w" }, stateDir);
    assert.equal(returnedPath, metaPath, "createRun must resolve to the same meta path");

    assert.equal(readEvents(metaPath).length, 2, "events must NOT be truncated on an active re-dispatch");
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
    assert.equal(meta.cursor, 0, "cursor must be reset to 0 on reuse");
    assert.ok(!("closedAt" in meta), "closedAt fossil must be stripped on reuse");
    assert.ok(!("topicDeletedAt" in meta), "topicDeletedAt fossil must be stripped on reuse");
    assert.equal(meta.threadId, 5, "threadId must be preserved across reuse");
    assert.equal(meta.chatId, 9, "chatId must be preserved across reuse");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.7 createRun: awaiting-review reuse still truncates the events log (reuse-with-truncate preserved)", () => {
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

    assert.deepEqual(readEvents(metaPath), [], "events log must be truncated on an awaiting-review reuse");
    const meta = readMeta(metaPath);
    assert.equal(meta.status, "active");
    assert.equal(meta.cursor, 0);
    assert.ok(!("closedAt" in meta), "closedAt fossil must be stripped on reuse");
    assert.ok(!("topicDeletedAt" in meta), "topicDeletedAt fossil must be stripped on reuse");
    assert.equal(meta.threadId, 5);
    assert.equal(meta.chatId, 9);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.7 createRun: plain active reuse strips fossils, leaves the events log untouched", () => {
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
    assert.equal(events.length, 2, "the events log must NOT be truncated on a plain active reuse");
    assert.deepEqual(
      events.map(({ ts, ...rest }) => rest),
      [
        { type: "e", n: 0 },
        { type: "e", n: 1 },
      ],
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.7 createRun: plain active reuse with no fossil writes nothing (byte-identical no-op)", () => {
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
