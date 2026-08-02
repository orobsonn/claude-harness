/** @description Integration-shape tests for observation-only hand hooks. */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { obsPlanWrite } from "./obs-plan-write.ts";
import { obsEye } from "./obs-eye.ts";
import { obsHand } from "./obs-hand.ts";

const { createObsPlanWriteHooks } = obsPlanWrite.testApi;
const { createObsEyeHooks } = obsEye.testApi;
const { createObsHandHooks } = obsHand.testApi;

function taskArgs(taskId, role = "executor-medium", featureId = "feat") {
  return {
    feature_id: featureId,
    subagent_type: role,
    prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]`,
  };
}

function seedDispatch(dir, { sessionId, callId, featureId, taskId, role, claimedAt = "2026-08-01T12:00:00.000Z" }) {
  const records = join(dir, ".opencode", "plans", ".state", sessionId, "dispatch-records");
  mkdirSync(records, { recursive: true });
  const name = crypto.createHash("sha256").update(callId).digest("hex");
  writeFileSync(join(records, `${name}.json`), JSON.stringify({
    parent_session_id: sessionId,
    dispatch_call_id: callId,
    child_session_id: null,
    feature_id: featureId,
    task_id: taskId,
    role,
    scope_paths: ["src"],
    allowed_writes: [],
    snapshot_hash: "a".repeat(64),
    claimed_at: claimedAt,
  }));
  const state = join(dir, ".opencode", "plans", ".state", sessionId, "gate-state.json");
  mkdirSync(dirname(state), { recursive: true });
  if (!existsSync(state)) writeFileSync(state, JSON.stringify({ session_id: sessionId, feature_id: featureId }));
}

function handRecordPath(dir, sessionId, featureId, taskId) {
  return join(dir, ".opencode", "plans", ".state", "hand-records", featureId, sessionId, `${taskId}.json`);
}

test("obs-plan-write: canonical model-tool writes are inert and cannot emit plan-created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-pw-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const planRel = ".opencode/plans/feat/execution-plan.json";
    const planAbs = join(dir, planRel);
    mkdirSync(dirname(planAbs), { recursive: true });
    writeFileSync(planAbs, JSON.stringify({ tasks: [{ id: "t1" }, { id: "t2" }] }));
    const hooks = await createObsPlanWriteHooks();
    await hooks["tool.execute.after"]({ tool: "write" }, { args: { filePath: planRel, content: "model output" } });
    assert.equal(existsSync(join(dir, "obs.events.jsonl")), false);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-plan-write leaves canonical and gate-state bytes unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-pw-inert-"));
  try {
    const sid = "ses_observer_inert";
    const fid = "inert-plan";
    const statePath = join(dir, ".opencode", "plans", ".state", sid, "gate-state.json");
    const planPath = join(dir, ".opencode", "plans", `${sid}-${fid}`, "execution-plan.json");
    mkdirSync(dirname(statePath), { recursive: true });
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ session_id: sid, feature_id: fid, planner_status: "plan_pending_write" }));
    writeFileSync(planPath, JSON.stringify({ feature_id: fid, tasks: [{ id: "task-1" }] }));
    const beforeState = readFileSync(statePath);
    const beforePlan = readFileSync(planPath);
    const hooks = await createObsPlanWriteHooks(dir);
    await hooks["tool.execute.after"]({ tool: "write", sessionID: sid }, { args: { filePath: `.opencode/plans/${sid}-${fid}/execution-plan.json`, content: "model output" } });
    assert.deepEqual(readFileSync(statePath), beforeState);
    assert.deepEqual(readFileSync(planPath), beforePlan);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("obs-eye: stub for this session-feature emits spec-adversary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-eye-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_test1";
    const fid = "my-feat";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}`), { recursive: true });
    writeFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), JSON.stringify({ feature_id: fid }));
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify({ kind: "stub", tasks: [] }));
    const hooks = await createObsEyeHooks(dir);
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid }, { args: { subagent_type: "adversary", feature_id: fid }, output: "attack" });
    assert.match(readFileSync(join(dir, "obs.events.jsonl"), "utf8"), /spec-adversary/);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand emits task-executing and hand-ran without dispatch mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-events-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_obs";
    const fid = "feat-obs";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify({ tasks: [{ id: "t-obs", scope_paths: ["src/a.ts"] }] }));
    const args = taskArgs("t-obs", "executor-medium", fid);
    const hooks = await createObsHandHooks(dir);
    assert.equal(hooks.event, undefined, "obs-hand must not own Task lifecycle events");
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-obs" }, { args });
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: "call-obs" }, { args, output: "Status: DONE" });
    const events = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    assert.match(events, /task-executing/);
    assert.match(events, /hand-ran/);
    assert.equal(existsSync(join(dir, `.opencode/plans/.state/${sid}/dispatch-records`)), false);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand ignores background Task progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-background-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const hooks = await createObsHandHooks(dir);
    const args = taskArgs("t-background", "executor-medium", "feat-background");
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "ses_background", callID: "call-background" }, { args, metadata: { background: true }, output: '<task state="running">' });
    assert.equal(existsSync(handRecordPath(dir, "ses_background", "feat-background", "t-background")), false);
    assert.equal(existsSync(join(dir, "obs.events.jsonl")), false);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand without task id emits no unknown hand event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-skip-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const hooks = await createObsHandHooks(dir);
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "ses_x", callID: "call-x" }, { args: { subagent_type: "executor-high" } });
    assert.equal(existsSync(join(dir, "obs.events.jsonl")), false);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand writes a host completion record from the exact producer claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-rec-"));
  try {
    const sid = "ses_rec";
    const fid = "feat-rec";
    const tid = "t-rec";
    const callId = "call-rec";
    seedDispatch(dir, { sessionId: sid, featureId: fid, taskId: tid, role: "executor-medium", callId });
    const hooks = await createObsHandHooks(dir);
    const args = taskArgs(tid, "executor-medium", fid);
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: callId }, { args, output: "Status: DONE" });
    const disk = JSON.parse(readFileSync(handRecordPath(dir, sid, fid, tid), "utf8"));
    const gate = JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8"));
    assert.equal(disk.writtenBy, "host-hand-finished");
    assert.equal(disk.producerCallId, callId);
    assert.equal(disk.capturedVerifiedAt, undefined);
    assert.deepEqual(gate.hand_finished, [`${fid}/${tid}`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("obs-hand cannot fabricate a completion record without an exact producer claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-no-producer-"));
  try {
    const hooks = await createObsHandHooks(dir);
    const args = taskArgs("t-none", "executor-medium", "feat-none");
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "ses_none", callID: "call-none" }, { args, output: "Status: DONE" });
    assert.equal(existsSync(handRecordPath(dir, "ses_none", "feat-none", "t-none")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("obs-hand cannot borrow a sibling producer claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-sibling-"));
  try {
    seedDispatch(dir, { sessionId: "ses_sibling", featureId: "feat-sibling", taskId: "t-sibling", role: "executor-medium", callId: "call-owner" });
    const hooks = await createObsHandHooks(dir);
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "ses_sibling", callID: "call-other" }, { args: taskArgs("t-sibling", "executor-medium", "feat-sibling"), output: "Status: DONE" });
    assert.equal(existsSync(handRecordPath(dir, "ses_sibling", "feat-sibling", "t-sibling")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("obs-hand ignores non-writing roles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-planner-"));
  try {
    const hooks = await createObsHandHooks(dir);
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "ses_plan", callID: "call-plan" }, { args: taskArgs("t-plan", "planner", "feat-plan"), output: "Status: DONE" });
    assert.equal(existsSync(join(dir, ".opencode/plans/.state/hand-records")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const { role, output, title } of [
  { role: "sniper-high", output: "Status: DONE", title: "sniper-high DONE" },
  { role: "sniper-low", output: "Status: DONE", title: "sniper-low DONE" },
  { role: "sniper-high", output: "Status: BLOCKED", title: "sniper-high BLOCKED" },
]) {
  test(`obs-hand ${title} never arms regate_pending`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-hand-no-regate-"));
    try {
      const sid = `ses-${role}-${output.includes("DONE") ? "done" : "blocked"}`;
      const fid = "feat-reg";
      const tid = "t-reg";
      const callId = `call-${role}-${output.includes("DONE") ? "done" : "blocked"}`;
      seedDispatch(dir, { sessionId: sid, featureId: fid, taskId: tid, role, callId });
      const hooks = await createObsHandHooks(dir);
      await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: callId }, { args: taskArgs(tid, role, fid), output });
      const gate = JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8"));
      assert.equal(gate.regate_pending, undefined);
      assert.equal(output.includes("DONE") ? gate.hand_finished?.[0] : gate.hand_finished?.length, output.includes("DONE") ? `${fid}/${tid}` : 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("obs-hand completion remains fail-open when the producer record is malformed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-malformed-"));
  try {
    const sid = "ses_bad";
    const callId = "call-bad";
    const records = join(dir, `.opencode/plans/.state/${sid}/dispatch-records`);
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, `${crypto.createHash("sha256").update(callId).digest("hex")}.json`), "not-json");
    const hooks = await createObsHandHooks(dir);
    await assert.doesNotReject(() => hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: callId }, { args: taskArgs("t-bad", "executor-medium", "feat-bad"), output: "Status: DONE" }));
    assert.equal(existsSync(handRecordPath(dir, sid, "feat-bad", "t-bad")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
