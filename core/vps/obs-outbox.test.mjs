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

import { createRun, appendEvent, readEvents, readMeta, advanceCursor, updateMeta } from "./obs-outbox.mjs";

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
    assert.deepEqual(JSON.parse(lines[0]), { type: "eye", role: "compliance", n: 0 });
    assert.deepEqual(JSON.parse(lines[1]), { type: "eye", role: "compliance", n: 1 });
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
    assert.deepEqual(unsent[0], { type: "e", n: 2 });
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
