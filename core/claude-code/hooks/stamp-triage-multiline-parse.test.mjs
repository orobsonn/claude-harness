/**
 * @description Test suite for stamp-triage.mjs — pinned assertions for the multi-line stdout
 * parse fix and the task-executing observability belt dedupe. Transcribes 5 pinned assertions:
 *   #ac-1.1 — hand-ran resolves against a REAL multi-line (pretty-printed) spawn-hand run-record.
 *   #ac-1.2 — hand-config-error-nudge resolves against a REAL multi-line config-error stdout.
 *   regression — classify single-line stdout parsing stays unaffected.
 *   #ac-1.2 (fallback) — the last-line-first line-by-line fallback still resolves an object when
 *     a whole-stdout JSON.parse fails (a single-line JSON object followed by a chained-echo line).
 *   belt — task-executing observability events are deduped by (type, n) on the outbox.
 * These assertions are pinned against behavior that does not exist yet in the current
 * stamp-triage.mjs (the multi-line parse fix and the belt dedupe) — several are EXPECTED to be
 * RED until that work lands.
 * Run with: node --test core/hooks/stamp-triage-multiline-parse.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decide, handle } from "./stamp-triage.mjs";
import { createRun, appendEvent, readEvents } from "../vps/obs-outbox.mjs";

// ---------------------------------------------------------------------------
// #ac-1.1 — hand-ran on a REAL multi-line (pretty-printed) run-record
// ---------------------------------------------------------------------------

test("#ac-1.1 decide: hand-ran resolves against a REAL multi-line (pretty-printed) spawn-hand run-record", () => {
  const payload = {
    session_id: "s1",
    tool_input: {
      command:
        "node .claude/skills/orchestrating-delivery/references/spawn-hand.mjs --descriptor /tmp/d.json",
    },
    tool_response: JSON.stringify(
      {
        model: "glm-5.2",
        scope_paths: ["src/"],
        outcome: { status: "done" },
        exitCode: 0,
        freezeCommitSha: "abc123",
      },
      null,
      2,
    ),
  };

  assert.ok(
    payload.tool_response.includes("\n"),
    "tool_response must be genuinely multi-line, not a single-line fake",
  );

  const result = decide(payload);
  assert.deepEqual(result, { action: "hand-ran", descriptorPath: "/tmp/d.json", outcomeStatus: "done" });
});

// ---------------------------------------------------------------------------
// #ac-1.2 — hand-config-error-nudge on a REAL multi-line config-error stdout
// ---------------------------------------------------------------------------

test("#ac-1.2 decide: hand-config-error-nudge resolves against a REAL multi-line (pretty-printed) config-error", () => {
  const payload = {
    session_id: "s1",
    tool_input: {
      command:
        "node .claude/skills/orchestrating-delivery/references/spawn-hand.mjs --descriptor /tmp/d.json",
    },
    tool_response: JSON.stringify(
      { configError: true, reason: "gate not armed", feature_id: "f", task_id: "t" },
      null,
      2,
    ),
  };

  assert.ok(
    payload.tool_response.includes("\n"),
    "tool_response must be genuinely multi-line, not a single-line fake",
  );

  const result = decide(payload);
  assert.equal(result.action, "hand-config-error-nudge");
  assert.equal(result.reason, "gate not armed");
});

// ---------------------------------------------------------------------------
// regression — classify single-line stdout parsing stays unaffected
// ---------------------------------------------------------------------------

test("regression decide: classify single-line stdout parsing → action:triage with exact fields", () => {
  const payload = {
    session_id: "s1",
    tool_input: { command: "node .claude/hooks/classify.mjs --mode light --feature-id foo" },
    tool_response: '{"mode":"LIGHT","feature_id":"foo"}',
  };

  const result = decide(payload);
  assert.deepEqual(result, {
    action: "triage",
    session_id: "s1",
    mode: "LIGHT",
    feature_id: "foo",
  });
});

// ---------------------------------------------------------------------------
// #ac-1.2 (fallback) — last-line-first line-by-line fallback resolves when the whole-stdout parse fails
// ---------------------------------------------------------------------------

test("#ac-1.2 decide: line-by-line fallback resolves hand-config-error-nudge when whole-stdout JSON.parse fails", () => {
  const payload = {
    session_id: "s1",
    tool_input: {
      command:
        "node .claude/skills/orchestrating-delivery/references/spawn-hand.mjs --descriptor /tmp/d.json",
    },
    tool_response: '{"configError":true,"reason":"no token","feature_id":"f","task_id":"t"}\nok',
  };

  const result = decide(payload);
  assert.equal(result.action, "hand-config-error-nudge");
  assert.equal(result.reason, "no token");
});

// ---------------------------------------------------------------------------
// belt — task-executing observability events deduped by (type, n)
// ---------------------------------------------------------------------------

test("belt handle: task-executing belt dedupe — two identical stamps yield exactly ONE (type,n) event on the outbox", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-triage-obs-"));
  const metaPath = createRun(
    { issueNumber: 1, project: "test-project", worktreePath: "/tmp/wt" },
    stateDir,
  );

  const savedEnv = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

  try {
    const payload = {
      session_id: "s1",
      tool_input: {
        command: "node .claude/hooks/mark.mjs task-executing --feature-id f --n 1 --total 3",
      },
      tool_response: '{"marker":"task-executing","feature_id":"f","n":1,"total":3}',
    };

    handle(payload);
    handle(payload);

    const events = readEvents(metaPath);
    const matches = events.filter(
      (e) => e.type === "task-executing" && e.n === 1 && e.total === 3,
    );
    assert.equal(
      matches.length,
      1,
      "task-executing must be deduped by (type,n) — no duplicate on a second identical stamp",
    );
  } finally {
    if (savedEnv === undefined) {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    } else {
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = savedEnv;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
