/**
 * @description Test suite for the task-6 observability markers/checkpoints.
 * Transcribes the 11 pinned assertions from
 * .claude/plans/vps-run-observability/run/task-6-assertions.md — one test() per
 * assertion, in order. Exercises the REAL mark.mjs (parseArgs/run), the REAL
 * stamp-triage.mjs (handle), the REAL core/vps/obs-outbox.mjs (createRun/readEvents/
 * updateMeta), the REAL core/vps/notify-telegram.mjs (drainTelegramOutbox), and reads
 * the REAL core/skills/orchestrating-delivery/SKILL.md content — no fakes stand in for
 * production code; the only injected seams are the `send` callback (network boundary)
 * and (test 7) a throwing appendEvent seam to prove the fail-open contract.
 * Zero-dep (node:test + node:assert/strict + node builtins only).
 * Run with: node --test core/hooks/obs-markers.test.mjs
 *
 * RED-by-design: assertions 1, 2, 3, 4, 6, 8, 9, 10, 11 exercise markers/appends/
 * SKILL.md emit points that task-6 has not yet implemented — they are expected to
 * fail until that production code lands. Assertions 5 and 7 pin fail-open invariants
 * that may already hold trivially today; they must keep holding after task-6 lands.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, run } from "./mark.mjs";
import { handle } from "./stamp-triage.mjs";
import { createRun, readEvents, updateMeta } from "../vps/obs-outbox.mjs";
import { drainTelegramOutbox } from "../vps/notify-telegram.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Runs fn inside a fresh OS tmpdir (chdir'd to it), then restores cwd and removes
 * the dir. gate-lib (via stamp-triage) resolves triage.json/gate-state.json from
 * cwd, so chdir isolation prevents polluting the repo's .claude/plans/ during tests.
 * @param {() => void} fn - Synchronous test body
 */
function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-cwd-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    fn();
  } finally {
    process.chdir(savedCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

/**
 * Async variant of withTempDir for tests that await the real drainTelegramOutbox.
 * @param {() => Promise<void>} fn - Asynchronous test body
 */
async function withTempDirAsync(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-cwd-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    await fn();
  } finally {
    process.chdir(savedCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

// ---------------------------------------------------------------------------
// 1. mark.mjs plan-reviewed --verdict APPROVE
// ---------------------------------------------------------------------------

/**
 * @description Given argv 'mark.mjs plan-reviewed --feature-id vps-run-observability
 * --task-id task-1 --verdict APPROVE', when run() executes, then it returns success
 * and the output JSON equals {marker, feature_id, task_id, verdict}.
 */
test("mark.mjs run(): plan-reviewed --verdict APPROVE echoes {marker, feature_id, task_id, verdict}", () => {
  const argv = [
    "node",
    "mark.mjs",
    "plan-reviewed",
    "--feature-id",
    "vps-run-observability",
    "--task-id",
    "task-1",
    "--verdict",
    "APPROVE",
  ];
  const parsed = parseArgs(argv);
  assert.ok(parsed, "parseArgs must recognize the plan-reviewed marker command");

  const result = run(parsed);
  assert.equal(result.success, true);
  assert.deepEqual(result.output, {
    marker: "plan-reviewed",
    feature_id: "vps-run-observability",
    task_id: "task-1",
    verdict: "APPROVE",
  });
});

// ---------------------------------------------------------------------------
// 2. mark.mjs task-executing --n --total
// ---------------------------------------------------------------------------

/**
 * @description Given argv 'mark.mjs task-executing --feature-id vps-run-observability
 * --n 2 --total 5', when run() executes, then the output JSON equals
 * {marker, feature_id, n:2, total:5}.
 */
test("mark.mjs run(): task-executing --n --total echoes {marker, feature_id, n, total}", () => {
  const argv = [
    "node",
    "mark.mjs",
    "task-executing",
    "--feature-id",
    "vps-run-observability",
    "--n",
    "2",
    "--total",
    "5",
  ];
  const parsed = parseArgs(argv);
  assert.ok(parsed, "parseArgs must recognize the task-executing marker command");

  const result = run(parsed);
  assert.equal(result.success, true);
  assert.deepEqual(result.output, {
    marker: "task-executing",
    feature_id: "vps-run-observability",
    n: 2,
    total: 5,
  });
});

// ---------------------------------------------------------------------------
// 3. classify.mjs FULL triage -> {type:'pipeline-type', mode:'FULL'} appended
// ---------------------------------------------------------------------------

/**
 * @description Given a classify.mjs PostToolUse[Bash] payload whose stdout is
 * {mode:'FULL', feature_id:'vps-run-observability'} and HARNESS_OBSERVABILITY_RUN_PATH
 * pointing at an existing obs meta, when stamp-triage handle() runs, then a
 * {type:'pipeline-type', mode:'FULL'} event is appended as a new line to the events JSONL.
 */
test("stamp-triage handle(): classify.mjs FULL triage appends {type:'pipeline-type', mode:'FULL'} to the outbox", () => {
  withTempDir(() => {
    const sessionId = "ses_obs3";
    const featureId = "vps-run-observability";
    const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-outbox-"));
    try {
      const metaPath = createRun({ issueNumber: 3, project: "proj", worktreePath: obsDir }, obsDir);
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

      const payload = {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: {
          command: `node .claude/hooks/classify.mjs --mode FULL --feature-id ${featureId}`,
        },
        tool_response: JSON.stringify({ mode: "FULL", feature_id: featureId }),
      };

      handle(payload);

      const events = readEvents(metaPath);
      const found = events.some((e) => e.type === "pipeline-type" && e.mode === "FULL");
      assert.ok(found, `expected a {type:'pipeline-type', mode:'FULL'} event, got ${JSON.stringify(events)}`);
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. mark.mjs plan-reviewed --verdict APPROVE -> {type:'plan-reviewed', verdict:'APPROVE'} appended
// ---------------------------------------------------------------------------

/**
 * @description Given a 'mark.mjs plan-reviewed ... --verdict APPROVE' payload with
 * HARNESS_OBSERVABILITY_RUN_PATH set, when stamp-triage handle() runs, then a
 * {type:'plan-reviewed', verdict:'APPROVE'} event is appended to the events JSONL.
 */
test("stamp-triage handle(): mark.mjs plan-reviewed --verdict APPROVE appends {type:'plan-reviewed', verdict:'APPROVE'} to the outbox", () => {
  withTempDir(() => {
    const sessionId = "ses_obs4";
    const featureId = "vps-run-observability";
    const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-outbox-"));
    try {
      const metaPath = createRun({ issueNumber: 4, project: "proj", worktreePath: obsDir }, obsDir);
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

      const payload = {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: {
          command: `node .claude/hooks/mark.mjs plan-reviewed --feature-id ${featureId} --task-id task-1 --verdict APPROVE`,
        },
        tool_response: JSON.stringify({
          marker: "plan-reviewed",
          feature_id: featureId,
          task_id: "task-1",
          verdict: "APPROVE",
        }),
      };

      handle(payload);

      const events = readEvents(metaPath);
      const found = events.some((e) => e.type === "plan-reviewed" && e.verdict === "APPROVE");
      assert.ok(found, `expected a {type:'plan-reviewed', verdict:'APPROVE'} event, got ${JSON.stringify(events)}`);
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. HARNESS_OBSERVABILITY_RUN_PATH unset/nonexistent -> cheap no-op
// ---------------------------------------------------------------------------

/**
 * @description Given HARNESS_OBSERVABILITY_RUN_PATH unset (or pointing at a
 * nonexistent file), when stamp-triage handle() runs a marker payload, then NO event
 * file is created/written and handle() does not throw (cheap no-op).
 */
test("stamp-triage handle(): HARNESS_OBSERVABILITY_RUN_PATH unset or pointing at a nonexistent file writes no event file and never throws", () => {
  withTempDir(() => {
    const sessionId = "ses_obs5";
    const featureId = "vps-run-observability";
    const payload = {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: {
        command: `node .claude/hooks/mark.mjs regate-pending --feature-id ${featureId} --task-id task-9`,
      },
      tool_response: JSON.stringify({ marker: "regate-pending", feature_id: featureId, task_id: "task-9" }),
    };

    // Case A: env var unset entirely.
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    assert.doesNotThrow(() => handle(payload));

    // Case B: env var points at a metaPath that was never created (nonexistent file).
    const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-outbox-"));
    const missingMetaPath = path.join(obsDir, "obs-999.json");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = missingMetaPath;
    try {
      assert.doesNotThrow(() => handle(payload));
      const eventsPath = missingMetaPath.replace(/\.json$/, ".events.jsonl");
      assert.equal(
        fs.existsSync(eventsPath),
        false,
        "no event file should be created when HARNESS_OBSERVABILITY_RUN_PATH points at a nonexistent obs meta",
      );
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. orchestrating-delivery/SKILL.md emits the three new checkpoints
// ---------------------------------------------------------------------------

/**
 * @description Given the orchestrating-delivery SKILL.md content, when scanned, then
 * it contains the emit commands 'mark.mjs plan-reviewed' (plan-review/HARD-GATE 2
 * verdict), 'mark.mjs task-executing' (per-task loop top), and
 * 'mark.mjs final-review-done' (final dual-review join) — the three new checkpoints
 * are actually emitted by the skill, not merely recognized by the hook.
 */
test("orchestrating-delivery SKILL.md emits mark.mjs plan-reviewed / task-executing / final-review-done", () => {
  const skillPath = fileURLToPath(new URL("../skills/orchestrating-delivery/SKILL.md", import.meta.url));
  const content = fs.readFileSync(skillPath, "utf8");

  assert.ok(
    content.includes("mark.mjs plan-reviewed"),
    "SKILL.md must emit 'mark.mjs plan-reviewed' at the plan-review/HARD-GATE 2 verdict",
  );
  assert.ok(
    content.includes("mark.mjs task-executing"),
    "SKILL.md must emit 'mark.mjs task-executing' at the per-task loop top",
  );
  assert.ok(
    content.includes("mark.mjs final-review-done"),
    "SKILL.md must emit 'mark.mjs final-review-done' at the final dual-review join",
  );
});

// ---------------------------------------------------------------------------
// 7. appendEvent throw never blocks triage.json / gate-state write (fail-open)
// ---------------------------------------------------------------------------

/**
 * @description Given a classify.mjs triage payload with HARNESS_OBSERVABILITY_RUN_PATH
 * set AND an obs-outbox appendEvent seam that THROWS, when stamp-triage handle() runs,
 * then triage.json is still written and gate-state is still reset (the pipeline-type
 * append failure is swallowed — strictly additive + fail-open).
 */
test("stamp-triage handle(): a throwing appendEvent seam never blocks the triage.json write or the gate-state reset", () => {
  withTempDir(() => {
    const sessionId = "ses_obs7";
    const featureId = "vps-run-observability";
    const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-outbox-"));
    try {
      const metaPath = createRun({ issueNumber: 7, project: "proj", worktreePath: obsDir }, obsDir);
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

      const payload = {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: {
          command: `node .claude/hooks/classify.mjs --mode FULL --feature-id ${featureId}`,
        },
        tool_response: JSON.stringify({ mode: "FULL", feature_id: featureId }),
      };

      const throwingAppendEvent = () => {
        throw new Error("boom: obs-outbox appendEvent seam failure");
      };

      assert.doesNotThrow(() => handle(payload, { appendEventFn: throwingAppendEvent }));

      const triagePath = path.join(".claude/plans/.state", sessionId, "triage.json");
      assert.ok(fs.existsSync(triagePath), "triage.json must still be written despite the appendEvent throw");
      const triage = JSON.parse(fs.readFileSync(triagePath, "utf8"));
      assert.equal(triage.mode, "FULL");
      assert.equal(triage.feature_id, featureId);

      const gateStatePath = path.join(".claude/plans/.state", sessionId, "gate-state.json");
      assert.ok(fs.existsSync(gateStatePath), "gate-state.json must still be reset despite the appendEvent throw");
      const gateState = JSON.parse(fs.readFileSync(gateStatePath, "utf8"));
      assert.equal(gateState.feature_id, featureId);
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 8. mark.mjs regate-pending -> CRITICAL {type:'regate-pending', task} appended
// ---------------------------------------------------------------------------

/**
 * @description Given a 'mark.mjs regate-pending --feature-id vps-run-observability
 * --task-id task-5' payload with HARNESS_OBSERVABILITY_RUN_PATH set, when stamp-triage
 * handle() runs, then a CRITICAL {type:'regate-pending', task:'task-5'} event is
 * appended to the events JSONL (and the existing gate-state regate stamping still occurs).
 */
test("stamp-triage handle(): mark.mjs regate-pending appends a CRITICAL {type:'regate-pending', task:'task-5'} event (gate-state stamping unaffected)", () => {
  withTempDir(() => {
    const sessionId = "ses_obs8";
    const featureId = "vps-run-observability";
    const taskId = "task-5";
    const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-outbox-"));
    try {
      const metaPath = createRun({ issueNumber: 8, project: "proj", worktreePath: obsDir }, obsDir);
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

      const payload = {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: {
          command: `node .claude/hooks/mark.mjs regate-pending --feature-id ${featureId} --task-id ${taskId}`,
        },
        tool_response: JSON.stringify({ marker: "regate-pending", feature_id: featureId, task_id: taskId }),
      };

      handle(payload);

      // existing gate-state regate stamping still occurs
      const gateStatePath = path.join(".claude/plans/.state", sessionId, "gate-state.json");
      const gateState = JSON.parse(fs.readFileSync(gateStatePath, "utf8"));
      assert.ok(
        Array.isArray(gateState.regate_pending) && gateState.regate_pending.includes(`${featureId}/${taskId}`),
        "existing regate-pending gate-state stamping must still occur",
      );

      // new: a CRITICAL {type:'regate-pending', task:'task-5'} outbox event is appended
      const events = readEvents(metaPath);
      const found = events.some((e) => e.type === "regate-pending" && e.task === taskId);
      assert.ok(found, `expected a CRITICAL {type:'regate-pending', task:'${taskId}'} event, got ${JSON.stringify(events)}`);
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9. regate-pending critical event: produced -> consumed to the SHARED threadId
// ---------------------------------------------------------------------------

/**
 * @description Given stamp-triage appends the {type:'regate-pending', task:'task-5'}
 * critical event AND the REAL drainTelegramOutbox (notify-telegram.mjs) then runs,
 * then the regate-pending signal is sent to the SHARED config threadId (critical
 * destination) — produced->consumed proof for the sniper-HIGH safety signal.
 */
test("regate-pending critical event: produced by stamp-triage, delivered to the SHARED config threadId via the real drainTelegramOutbox", async () => {
  await withTempDirAsync(async () => {
    const sessionId = "ses_obs9";
    const featureId = "vps-run-observability";
    const taskId = "task-5";
    const obsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-outbox-"));
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-worktree-"));
    try {
      const metaPath = createRun({ issueNumber: 9, project: "proj", worktreePath }, obsStateDir);
      // Give the run its OWN (non-shared) thread so a critical delivery landing on the
      // SHARED thread is unambiguous proof of the critical-first path, not an artifact
      // of the no-threadId fallback case.
      updateMeta(metaPath, { threadId: 555 });
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

      const payload = {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: {
          command: `node .claude/hooks/mark.mjs regate-pending --feature-id ${featureId} --task-id ${taskId}`,
        },
        tool_response: JSON.stringify({ marker: "regate-pending", feature_id: featureId, task_id: taskId }),
      };
      handle(payload);

      const sendCalls = [];
      const fakeSend = async (message) => {
        sendCalls.push(message);
        return { sent: true };
      };
      const SHARED_THREAD_ID = 999;

      await drainTelegramOutbox(
        { stateDir: obsStateDir, chatId: "shared-chat", threadId: SHARED_THREAD_ID },
        { send: fakeSend },
      );

      const delivered = sendCalls.some(
        (call) =>
          call.event?.type === "regate-pending" &&
          call.event?.task === taskId &&
          call.threadId === SHARED_THREAD_ID,
      );
      assert.ok(
        delivered,
        `expected the regate-pending event delivered to the shared threadId ${SHARED_THREAD_ID}, got ${JSON.stringify(sendCalls)}`,
      );
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsStateDir, { recursive: true, force: true });
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 10. pipeline-type FULL: produced -> consumed, delivered exactly once
// ---------------------------------------------------------------------------

/**
 * @description Given a classify.mjs FULL triage payload produces a
 * {type:'pipeline-type', mode:'FULL'} event via stamp-triage AND the REAL
 * drainTelegramOutbox then runs over the outbox, then the pipeline-type checkpoint is
 * delivered by exactly one send (produced->consumed end to end, not pre-seeded).
 */
test("pipeline-type FULL event: produced by stamp-triage, delivered by exactly one send via the real drainTelegramOutbox", async () => {
  await withTempDirAsync(async () => {
    const sessionId = "ses_obs10";
    const featureId = "vps-run-observability";
    const obsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-outbox-"));
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-worktree-"));
    try {
      const metaPath = createRun({ issueNumber: 10, project: "proj", worktreePath }, obsStateDir);
      updateMeta(metaPath, { threadId: 555 });
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

      const payload = {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: {
          command: `node .claude/hooks/classify.mjs --mode FULL --feature-id ${featureId}`,
        },
        tool_response: JSON.stringify({ mode: "FULL", feature_id: featureId }),
      };
      handle(payload);

      const sendCalls = [];
      const fakeSend = async (message) => {
        sendCalls.push(message);
        return { sent: true };
      };

      await drainTelegramOutbox(
        { stateDir: obsStateDir, chatId: "shared-chat", threadId: 999 },
        { send: fakeSend },
      );

      const matching = sendCalls.filter(
        (call) => call.event?.type === "pipeline-type" && call.event?.mode === "FULL",
      );
      assert.equal(
        matching.length,
        1,
        `expected exactly one send for the pipeline-type FULL checkpoint, got ${JSON.stringify(sendCalls)}`,
      );
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsStateDir, { recursive: true, force: true });
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 11. plan-reviewed APPROVE: produced -> consumed, delivered exactly once
// ---------------------------------------------------------------------------

/**
 * @description Given a 'mark.mjs plan-reviewed --verdict APPROVE' payload produces a
 * {type:'plan-reviewed', verdict:'APPROVE'} event via stamp-triage AND the REAL drain
 * then runs, then the plan-reviewer verdict checkpoint is delivered by exactly one
 * send (produced->consumed end to end).
 */
test("plan-reviewed APPROVE event: produced by stamp-triage, delivered by exactly one send via the real drainTelegramOutbox", async () => {
  await withTempDirAsync(async () => {
    const sessionId = "ses_obs11";
    const featureId = "vps-run-observability";
    const obsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-outbox-"));
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "obs-markers-worktree-"));
    try {
      const metaPath = createRun({ issueNumber: 11, project: "proj", worktreePath }, obsStateDir);
      updateMeta(metaPath, { threadId: 555 });
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

      const payload = {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: {
          command: `node .claude/hooks/mark.mjs plan-reviewed --feature-id ${featureId} --task-id task-1 --verdict APPROVE`,
        },
        tool_response: JSON.stringify({
          marker: "plan-reviewed",
          feature_id: featureId,
          task_id: "task-1",
          verdict: "APPROVE",
        }),
      };
      handle(payload);

      const sendCalls = [];
      const fakeSend = async (message) => {
        sendCalls.push(message);
        return { sent: true };
      };

      await drainTelegramOutbox(
        { stateDir: obsStateDir, chatId: "shared-chat", threadId: 999 },
        { send: fakeSend },
      );

      const matching = sendCalls.filter(
        (call) => call.event?.type === "plan-reviewed" && call.event?.verdict === "APPROVE",
      );
      assert.equal(
        matching.length,
        1,
        `expected exactly one send for the plan-reviewed APPROVE checkpoint, got ${JSON.stringify(sendCalls)}`,
      );
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsStateDir, { recursive: true, force: true });
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});
