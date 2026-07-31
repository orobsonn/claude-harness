/**
 * @description Integration-shape tests: after/before hooks use output.args (OC contract).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createObsPlanWriteHooks } from "./obs-plan-write.ts";
import { createObsEyeHooks } from "./obs-eye.ts";
import { createObsHandHooks } from "./obs-hand.ts";
import { createPlanWriteGateHooks } from "./plan-write-gate.ts";
import { semanticPlanHash } from "../lib/planner-artifact.mjs";
import { fidelityPassEntry } from "./lib/mark-gate.mjs";

/** @param {() => Promise<void>} fn */
async function captureWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

/**
 * Replace a session's gate-state directory with a plain file so any subsequent lock/read/write
 * against it fails instantly (ENOTDIR/EEXIST) — a deterministic, fast way to force a
 * binding-accounting helper (bindChildSession, cleanupChild, cleanup/finishActiveDispatch) to
 * return `{ ok: false }` without waiting on lock timeouts.
 * @param {string} dir
 * @param {string} sessionId
 */
function corruptGateStateDir(dir, sessionId) {
  const stateDir = join(dir, ".opencode", "plans", ".state", sessionId);
  rmSync(stateDir, { recursive: true, force: true });
  writeFileSync(stateDir, "corrupted");
}

test("obs-plan-write: output.args → plan-created with tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-pw-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const planRel = ".opencode/plans/feat/execution-plan.json";
    const planAbs = join(dir, planRel);
    mkdirSync(join(dir, ".opencode/plans/feat"), { recursive: true });
    writeFileSync(planAbs, JSON.stringify({ tasks: [{ id: "t1" }, { id: "t2" }] }));
    const hooks = await createObsPlanWriteHooks();
    await hooks["tool.execute.after"](
      { tool: "write" },
      { args: { filePath: planRel, content: JSON.stringify({ tasks: [1, 2] }) } },
    );
    const raw = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    assert.ok(raw.includes("plan-created"), raw);
    assert.ok(raw.includes('"tasks":2') || raw.includes('"tasks": 2'), raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-eye: stub for THIS session-feature → spec-adversary; ignore other full plan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-eye-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_test1";
    const fid = "my-feat";
    mkdirSync(join(dir, ".opencode/plans/old-full"), { recursive: true });
    writeFileSync(
      join(dir, ".opencode/plans/old-full/execution-plan.json"),
      JSON.stringify({ tasks: [{ id: "x" }] }),
    );
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}`), { recursive: true });
    writeFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), JSON.stringify({ feature_id: fid }));
    writeFileSync(
      join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`),
      JSON.stringify({ kind: "stub", tasks: [] }),
    );
    const hooks = await createObsEyeHooks(dir);
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid },
      {
        args: { subagent_type: "adversary", feature_id: fid },
        output: "attack",
      },
    );
    const raw = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    assert.ok(raw.includes("spec-adversary"), raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand: before task-executing + after hand-ran structural", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_h1";
    const fid = "feat-h";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}`), { recursive: true });
    const plan = {
      feature_id: fid,
      kind: "full",
      mode: "full",
      tasks: [{ id: "t-a", severity: "medium", complexity: "medium", scope_paths: ["src/a.ts"], criterion_refs: ["#ac-1"], locked_tests: [{ id: "lt-a", path: "src/a.test.mjs", assertion: "a" }] },
        { id: "t-b", severity: "medium", complexity: "medium", scope_paths: ["src/b.ts"], criterion_refs: ["#ac-2"], locked_tests: [{ id: "lt-b", path: "src/b.test.mjs", assertion: "b" }] }],
    };
    const hash = semanticPlanHash(plan);
    const snapshotRel = `.opencode/plans/.state/${sid}/bound-plans/${hash}.json`;
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}/bound-plans`), { recursive: true });
    writeFileSync(join(dir, snapshotRel), JSON.stringify(plan));
    writeFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), JSON.stringify({ session_id: sid, feature_id: fid, planner_status: "usable", delivery_status: "ready", planner_plan_binding: { session_id: sid, feature_id: fid, snapshot_path: snapshotRel, snapshot_hash: hash } }));
    writeFileSync(
      join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`),
      JSON.stringify(plan),
    );
    let sdkOutage = false;
    const client = { session: { get: async ({ path: sdkPath }) => {
      if (sdkOutage) throw new Error("SDK unavailable");
      return { data: {
        id: sdkPath.id,
        ...(sdkPath.id.startsWith("child-") ? { parentID: sid } : {}),
      } };
    } } };
    const hooks = await createObsHandHooks(dir, { client });
    const args = {
      description: "implement t-b",
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"t-b"}[/HARNESS_TASK_CONTEXT]\nImplement the task.`,
      subagent_type: "executor-medium",
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-background" }, { args });
    sdkOutage = true;
    await hooks.event({ event: { type: "message.updated", properties: { info: { id: "child-user", sessionID: "child-background", role: "user", agent: "executor-medium" } } } });
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid, callID: "call-background" },
      { args, metadata: { parentSessionId: sid, sessionId: "child-background", jobId: "job-background", background: true }, output: '<task id="child-background" state="running"><task_result>running</task_result></task>' },
    );
    let active = JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch;
    assert.equal(active.call_id, "call-background");
    // #403 binds straight from the Task result metadata, so the child lands bound rather than
    // merely pending; bindChildSession drops binding_pending. NOT a stronger guarantee — the
    // id can come from a regex over model-authored output text (obs-hand.ts:266), see #420.
    assert.equal(active.status, "active");
    assert.equal(active.child_session_id, "child-background");
    sdkOutage = false;
    const writeHooks = await createPlanWriteGateHooks(dir, { client });
    // Write authority is still fail-closed for a child whose dispatch binding does not check out.
    await assert.rejects(
      () => writeHooks["tool.execute.before"](
        { tool: "write", sessionID: "child-background", callID: "write-unbound" },
        { args: { filePath: "src/b.ts", content: "blocked" } },
      ),
      /binding invalid|identity unavailable|dispatch binding/,
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child-background" } } });
    assert.equal(JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch, undefined);
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-after-background" }, { args });
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid, callID: "call-after-background" },
      { args, metadata: { parentSessionId: sid, sessionId: "child-new", background: true }, output: '<task id="child-new" state="running"><task_result>running</task_result></task>' },
    );
    // A late session.idle from the PREVIOUS dispatch's child no longer raises (see #417 —
    // the diagnostic was dropped by #403). What still must hold: it does not disturb the
    // dispatch now in flight.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child-background" } } });
    active = JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch;
    assert.equal(active.call_id, "call-after-background");
    assert.equal(active.status, "active");
    assert.equal(active.child_session_id, "child-new");
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child-new" } } });
    assert.equal(JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch, undefined);

    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-hand" }, { args });
    assert.ok(JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch);
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: "call-hand" }, { args });
    assert.equal(JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch, undefined);
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-new" }, { args });
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      type: "tool", tool: "task", sessionID: sid, callID: "call-hand", state: { status: "error" },
    } } } });
    assert.equal(JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch.call_id, "call-new");
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: "call-new" }, { args });
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-rejected" }, { args });
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      type: "tool", tool: "task", sessionID: sid, callID: "call-rejected", state: { status: "error" },
    } } } });
    assert.equal(JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch, undefined);
    for (const [toolName, callID] of [["agent", "call-agent"], ["namespace.task", "call-namespaced"]]) {
      await hooks["tool.execute.before"]({ tool: toolName, sessionID: sid, callID }, { args });
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        type: "tool", tool: toolName, sessionID: sid, callID: `${callID}-other`, state: { status: "error" },
      } } } });
      assert.equal(JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch.call_id, callID);
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        type: "tool", tool: toolName, sessionID: sid, callID, state: { status: "error" },
      } } } });
      assert.equal(JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch, undefined);
    }
    const raw = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    assert.ok(raw.includes("task-executing"), raw);
    assert.ok(raw.includes('"n":2'), raw);
    assert.ok(raw.includes("hand-ran"), raw);
    assert.ok(raw.includes("t-b"), raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#ac-1.1 obs-hand: binding_pending child terminal cleans without SDK (no fail-closed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-pending-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_pending1";
    const fid = "feat-pending";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}`), { recursive: true });
    const plan = {
      feature_id: fid,
      kind: "full",
      mode: "full",
      tasks: [{
        id: "t-p",
        severity: "medium",
        complexity: "medium",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-a", path: "src/a.test.mjs", assertion: "a" }],
      }],
    };
    const hash = semanticPlanHash(plan);
    const snapshotRel = `.opencode/plans/.state/${sid}/bound-plans/${hash}.json`;
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}/bound-plans`), { recursive: true });
    writeFileSync(join(dir, snapshotRel), JSON.stringify(plan));
    writeFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), JSON.stringify({
      session_id: sid,
      feature_id: fid,
      planner_status: "usable",
      delivery_status: "ready",
      planner_plan_binding: { session_id: sid, feature_id: fid, snapshot_path: snapshotRel, snapshot_hash: hash },
    }));
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify(plan));

    const client = {
      session: {
        get: async () => {
          throw new Error("SDK unavailable");
        },
      },
    };
    const hooks = await createObsHandHooks(dir, { client });
    const args = {
      description: "implement t-p",
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"t-p"}[/HARNESS_TASK_CONTEXT]\nImplement.`,
      subagent_type: "executor-medium",
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-bg" }, { args });
    // message.updated cannot bind while SDK is down
    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "u1", sessionID: "child-bg", role: "user", agent: "executor-medium" } },
      },
    });
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid, callID: "call-bg" },
      {
        args,
        metadata: { parentSessionId: sid, sessionId: "child-bg", jobId: "job-bg", background: true },
        output: '<task id="child-bg" state="running"><task_result>running</task_result></task>',
      },
    );
    const active = JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch;
    // #403 binds straight from the Task result metadata, so the child lands bound rather than
    // merely pending; bindChildSession drops binding_pending. NOT a stronger guarantee: the id
    // can fall back to a regex over model-authored output text (obs-hand.ts:266) — see #420.
    assert.equal(active.status, "active");
    assert.equal(active.child_session_id, "child-bg");
    assert.equal(active.binding_pending, undefined);

    // Child ends while SDK still unavailable — must clean without fail-closed
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child-bg" } } });
    assert.equal(
      JSON.parse(readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8")).active_dispatch,
      undefined,
    );
    const eventsPath = join(dir, ".opencode", "plans", ".state", "scope-terminal-events.jsonl");
    assert.equal(existsSync(eventsPath), false, "happy path must not emit hand-scope-terminal-unbound");
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Re-targeted from "truly unbound child ... still fail-closed". cffe42b (#403) removed that
// fail-closed branch to silence N1 false positives from eye/parent/explore children that
// legitimately hold no claim; the lost diagnostic is tracked in #417. The original assertion
// cannot be restored as written — with the SDK down and no live claim, ghost and hand are
// physically indistinguishable.
//
// So the test keeps an invariant instead of retiring one: the silence must be INERT. Note the
// diagnostic that was lost was written to scope-terminal-events.jsonl, which no code reads,
// and thrown from an `event` handler, which blocks no tool.
//
// When #417 is addressed: `claims.size === 0` is NOT a sound discriminator — claims is
// per-plugin-instance and OC may instantiate the factory twice (the very bug #402 fixed), so
// a second instance sees an empty map while a real claim is live on disk. Read the durable
// active_dispatch from gate-state instead.
test("#ac-1.2 obs-hand: unknown child idle is silent and cannot disturb a live dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-unbound-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const client = {
      session: {
        get: async () => {
          throw new Error("SDK unavailable");
        },
      },
    };
    const hooks = await createObsHandHooks(dir, { client });
    // No claim at all and the SDK is down: ghost and hand are indistinguishable here, so
    // #403 chose silence. What must still hold is that the silence is inert.
    await assert.doesNotReject(
      () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "child-ghost" } } }),
    );
    assert.equal(
      existsSync(join(dir, ".opencode", "plans", ".state", "scope-terminal-events.jsonl")),
      false,
      "unknown child must not emit terminal diagnostics (N1 false-positive spam)",
    );
    assert.equal(existsSync(join(dir, ".opencode", "plans", ".state")), false, "no dispatch state may be fabricated");
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand: without task_id does not emit hand-ran unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-skip-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const hooks = await createObsHandHooks(dir);
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: "ses_x" },
      { args: { subagent_type: "executor-high" } },
    );
    // no events file or empty
    let raw = "";
    try {
      raw = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    } catch {
      raw = "";
    }
    assert.equal(raw.includes("unknown"), false, raw);
    assert.equal(raw.includes("hand-ran"), false, raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand: writing-hand terminal Task writes hand-record once with DONE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-rec-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_rec1";
    const fid = "feat-rec";
    const tid = "t-rec";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}`), { recursive: true });
    const plan = {
      feature_id: fid,
      kind: "full",
      mode: "full",
      tasks: [{
        id: tid,
        severity: "medium",
        complexity: "medium",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-a", path: "src/a.test.mjs", assertion: "a" }],
      }],
    };
    const hash = semanticPlanHash(plan);
    const snapshotRel = `.opencode/plans/.state/${sid}/bound-plans/${hash}.json`;
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}/bound-plans`), { recursive: true });
    writeFileSync(join(dir, snapshotRel), JSON.stringify(plan));
    writeFileSync(
      join(dir, `.opencode/plans/.state/${sid}/gate-state.json`),
      JSON.stringify({
        session_id: sid,
        feature_id: fid,
        planner_status: "usable",
        delivery_status: "ready",
        planner_plan_binding: {
          session_id: sid,
          feature_id: fid,
          snapshot_path: snapshotRel,
          snapshot_hash: hash,
        },
      }),
    );
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify(plan));

    const hooks = await createObsHandHooks(dir);
    const args = {
      description: "implement t-rec",
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${tid}"}[/HARNESS_TASK_CONTEXT]\nImplement the task.`,
      subagent_type: "executor-medium",
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-rec" }, { args });
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid, callID: "call-rec" },
      { args, output: "Work complete.\nStatus: DONE\n" },
    );

    const recordPath = join(
      dir,
      ".opencode",
      "plans",
      ".state",
      "hand-records",
      fid,
      sid,
      `${tid}.json`,
    );
    assert.ok(existsSync(recordPath), `expected hand-record at ${recordPath}`);
    const disk = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(disk.outcome, "DONE");
    assert.equal(disk.writtenBy, "obs-hand-task");
    assert.equal(disk.featureId, fid);
    assert.equal(disk.taskId, tid);
    assert.equal(disk.sessionId, sid);
    assert.ok(Array.isArray(disk.touchedPaths));

    const mtime1 = readFileSync(recordPath, "utf8");
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid, callID: "call-rec" },
      { args, output: "Status: BLOCKED\n" },
    );
    assert.equal(readFileSync(recordPath, "utf8"), mtime1, "double after must not rewrite");
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});


test("obs-hand: terminal after writes hand-record even when child binding fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-bind-fail-rec-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_bindfail";
    const fid = "feat-bindfail";
    const tid = "t-bindfail";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}/bound-plans`), { recursive: true });
    const plan = {
      feature_id: fid,
      kind: "full",
      mode: "full",
      tasks: [{
        id: tid,
        severity: "medium",
        complexity: "medium",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-a", path: "src/a.test.mjs", assertion: "a" }],
      }],
    };
    const hash = semanticPlanHash(plan);
    const snapshotRel = `.opencode/plans/.state/${sid}/bound-plans/${hash}.json`;
    writeFileSync(join(dir, snapshotRel), JSON.stringify(plan));
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify(plan));
    writeFileSync(
      join(dir, `.opencode/plans/.state/${sid}/gate-state.json`),
      JSON.stringify({
        session_id: sid,
        feature_id: fid,
        planner_status: "usable",
        planner_plan_binding: {
          session_id: sid,
          feature_id: fid,
          snapshot_path: snapshotRel,
          snapshot_hash: hash,
        },
      }),
    );
    const hooks = await createObsHandHooks(dir);
    const args = {
      description: "implement",
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${tid}"}[/HARNESS_TASK_CONTEXT]\nGo.`,
      subagent_type: "executor-medium",
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-bf" }, { args });
    // Terminal after with orphan child id (no binding) — must still write hand-record.
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid, callID: "call-bf" },
      {
        args,
        output: `Status: DONE\n<task id="ses_orphan_child" state="completed"></task>`,
        metadata: { sessionId: "ses_orphan_child", parentSessionId: sid },
      },
    );
    const recordPath = join(dir, ".opencode", "plans", ".state", "hand-records", fid, sid, `${tid}.json`);
    assert.ok(existsSync(recordPath), `expected hand-record at ${recordPath}`);
    const disk = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(disk.outcome, "DONE");
    assert.equal(disk.writtenBy, "obs-hand-task");
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand: non-hand role does not write hand-record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-planner-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_plan1";
    const fid = "feat-plan";
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}`), { recursive: true });
    writeFileSync(
      join(dir, `.opencode/plans/.state/${sid}/gate-state.json`),
      JSON.stringify({ session_id: sid, feature_id: fid }),
    );
    const hooks = await createObsHandHooks(dir);
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid, callID: "call-plan" },
      {
        args: {
          subagent_type: "planner",
          task_id: "t-plan",
          feature_id: fid,
          prompt: "plan it",
        },
        output: "Status: DONE\n",
      },
    );
    const recordsRoot = join(dir, ".opencode", "plans", ".state", "hand-records");
    assert.equal(existsSync(recordsRoot), false);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#ac-1.1 obs-hand: sniper-high DONE → sealed regate_pending for feature/task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-regate-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_reg1";
    const fid = "feat-reg";
    const tid = "t-reg";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}`), { recursive: true });
    const plan = {
      feature_id: fid,
      kind: "full",
      mode: "full",
      tasks: [{
        id: tid,
        severity: "high",
        complexity: "high",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-a", path: "src/a.test.mjs", assertion: "a" }],
      }],
    };
    const hash = semanticPlanHash(plan);
    const snapshotRel = `.opencode/plans/.state/${sid}/bound-plans/${hash}.json`;
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}/bound-plans`), { recursive: true });
    writeFileSync(join(dir, snapshotRel), JSON.stringify(plan));
    const gatePath = join(dir, `.opencode/plans/.state/${sid}/gate-state.json`);
    writeFileSync(
      gatePath,
      JSON.stringify({
        session_id: sid,
        feature_id: fid,
        planner_status: "usable",
        delivery_status: "ready",
        planner_plan_binding: {
          session_id: sid,
          feature_id: fid,
          snapshot_path: snapshotRel,
          snapshot_hash: hash,
        },
      }),
    );
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify(plan));

    const hooks = await createObsHandHooks(dir);
    const args = {
      description: "fix t-reg high",
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${tid}"}[/HARNESS_TASK_CONTEXT]\nSurgical fix.`,
      subagent_type: "sniper-high",
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-reg" }, { args });
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid, callID: "call-reg" },
      { args, output: "Fixed race.\nStatus: DONE\n" },
    );

    const disk = JSON.parse(readFileSync(gatePath, "utf8"));
    const expected = fidelityPassEntry(fid, tid, null);
    assert.ok(Array.isArray(disk.regate_pending), "regate_pending array");
    assert.ok(disk.regate_pending.includes(expected), `expected ${expected} in ${JSON.stringify(disk.regate_pending)}`);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand: sniper-low DONE does not arm regate_pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-regate-low-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_low1";
    const fid = "feat-low";
    const tid = "t-low";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}`), { recursive: true });
    const plan = {
      feature_id: fid,
      kind: "full",
      mode: "full",
      tasks: [{
        id: tid,
        severity: "low",
        complexity: "low",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-a", path: "src/a.test.mjs", assertion: "a" }],
      }],
    };
    const hash = semanticPlanHash(plan);
    const snapshotRel = `.opencode/plans/.state/${sid}/bound-plans/${hash}.json`;
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}/bound-plans`), { recursive: true });
    writeFileSync(join(dir, snapshotRel), JSON.stringify(plan));
    const gatePath = join(dir, `.opencode/plans/.state/${sid}/gate-state.json`);
    writeFileSync(
      gatePath,
      JSON.stringify({
        session_id: sid,
        feature_id: fid,
        planner_status: "usable",
        delivery_status: "ready",
        planner_plan_binding: {
          session_id: sid,
          feature_id: fid,
          snapshot_path: snapshotRel,
          snapshot_hash: hash,
        },
      }),
    );
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify(plan));

    const hooks = await createObsHandHooks(dir);
    const args = {
      description: "fix t-low",
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${tid}"}[/HARNESS_TASK_CONTEXT]\nTiny fix.`,
      subagent_type: "sniper-low",
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-low" }, { args });
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid, callID: "call-low" },
      { args, output: "Status: DONE\n" },
    );

    const disk = JSON.parse(readFileSync(gatePath, "utf8"));
    assert.equal(disk.regate_pending == null || disk.regate_pending.length === 0, true);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand: sniper-high BLOCKED does not arm regate_pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-regate-blocked-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_blk1";
    const fid = "feat-blk";
    const tid = "t-blk";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}`), { recursive: true });
    const plan = {
      feature_id: fid,
      kind: "full",
      mode: "full",
      tasks: [{
        id: tid,
        severity: "high",
        complexity: "high",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-a", path: "src/a.test.mjs", assertion: "a" }],
      }],
    };
    const hash = semanticPlanHash(plan);
    const snapshotRel = `.opencode/plans/.state/${sid}/bound-plans/${hash}.json`;
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}/bound-plans`), { recursive: true });
    writeFileSync(join(dir, snapshotRel), JSON.stringify(plan));
    const gatePath = join(dir, `.opencode/plans/.state/${sid}/gate-state.json`);
    writeFileSync(
      gatePath,
      JSON.stringify({
        session_id: sid,
        feature_id: fid,
        planner_status: "usable",
        delivery_status: "ready",
        planner_plan_binding: {
          session_id: sid,
          feature_id: fid,
          snapshot_path: snapshotRel,
          snapshot_hash: hash,
        },
      }),
    );
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify(plan));

    const hooks = await createObsHandHooks(dir);
    const args = {
      description: "fix t-blk",
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${tid}"}[/HARNESS_TASK_CONTEXT]\nBlocked fix.`,
      subagent_type: "sniper-high",
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-blk" }, { args });
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid, callID: "call-blk" },
      { args, output: "Status: BLOCKED\n" },
    );

    const disk = JSON.parse(readFileSync(gatePath, "utf8"));
    assert.equal(disk.regate_pending == null || disk.regate_pending.length === 0, true);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// #532: the observability belt (obs-hand's event/after-hook binding accounting) is declared
// fail-open by orchestrating-delivery's skill doc. A binding-accounting miss used to `throw`
// from inside the plugin hook, which OpenCode surfaces as a tool-error that kills the whole
// headless run — discarding an approved plan and already-written code for what should be, at
// most, a missing line in the Telegram feed. These four tests pin the fail-open contract at
// each site that used to throw.

test("#532 ac-1.1: message.updated bind failure warns, never crashes the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-532-bind-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    // No claim was ever armed for "ses_no_claim_532" — bindChildSession fails with the exact
    // reason observed in the wild (#532): "live parent dispatch capability or role mismatch".
    const client = {
      session: { get: async ({ path: p }) => ({ data: { id: p.id, parentID: "ses_no_claim_532" } }) },
    };
    const hooks = await createObsHandHooks(dir, { client });
    const warnings = await captureWarnings(() =>
      assert.doesNotReject(() =>
        hooks.event({
          event: {
            type: "message.updated",
            properties: {
              info: { id: "u1", sessionID: "child-no-claim-532", role: "user", agent: "executor-medium" },
            },
          },
        }),
      ),
    );
    assert.ok(
      warnings.some((w) => /message\.updated bind skipped/.test(String(w))),
      `expected a bind-skip warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#532 ac-1.2: session.idle cleanupChild failure warns, never crashes the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-532-idle-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_532_idle";
    const fid = "feat-532-idle";
    const tid = "t-532-idle";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}/bound-plans`), { recursive: true });
    const plan = {
      feature_id: fid,
      kind: "full",
      mode: "full",
      tasks: [{
        id: tid,
        severity: "medium",
        complexity: "medium",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-a", path: "src/a.test.mjs", assertion: "a" }],
      }],
    };
    const hash = semanticPlanHash(plan);
    const snapshotRel = `.opencode/plans/.state/${sid}/bound-plans/${hash}.json`;
    writeFileSync(join(dir, snapshotRel), JSON.stringify(plan));
    writeFileSync(
      join(dir, `.opencode/plans/.state/${sid}/gate-state.json`),
      JSON.stringify({
        session_id: sid,
        feature_id: fid,
        planner_status: "usable",
        delivery_status: "ready",
        planner_plan_binding: { session_id: sid, feature_id: fid, snapshot_path: snapshotRel, snapshot_hash: hash },
      }),
    );
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify(plan));

    const client = { session: { get: async ({ path: p }) => ({ data: { id: p.id, parentID: sid } }) } };
    const hooks = await createObsHandHooks(dir, { client });
    const args = {
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${tid}"}[/HARNESS_TASK_CONTEXT]\nGo.`,
      subagent_type: "executor-medium",
      feature_id: fid,
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-532-idle" }, { args });
    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "u1", sessionID: "child-532-idle", role: "user", agent: "executor-medium" } },
      },
    });
    const boundBefore = JSON.parse(
      readFileSync(join(dir, `.opencode/plans/.state/${sid}/gate-state.json`), "utf8"),
    ).active_dispatch;
    assert.equal(boundBefore.status, "active");
    assert.equal(boundBefore.child_session_id, "child-532-idle");

    // Simulate the parent's gate-state directory becoming unreadable mid-flight (disk
    // contention, permission drift) — cleanupChild must degrade to a warning, not a crash.
    corruptGateStateDir(dir, sid);

    const warnings = await captureWarnings(() =>
      assert.doesNotReject(() =>
        hooks.event({ event: { type: "session.idle", properties: { sessionID: "child-532-idle" } } }),
      ),
    );
    assert.ok(
      warnings.some((w) => /session\.idle cleanup skipped/.test(String(w))),
      `expected a cleanup-skip warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#532 ac-1.3: after-hook finally cleanup failure warns, never crashes the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-532-finally-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_532_finally";
    const fid = "feat-532-finally";
    const tid = "t-532-finally";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}/bound-plans`), { recursive: true });
    const plan = {
      feature_id: fid,
      kind: "full",
      mode: "full",
      tasks: [{
        id: tid,
        severity: "medium",
        complexity: "medium",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-a", path: "src/a.test.mjs", assertion: "a" }],
      }],
    };
    const hash = semanticPlanHash(plan);
    const snapshotRel = `.opencode/plans/.state/${sid}/bound-plans/${hash}.json`;
    writeFileSync(join(dir, snapshotRel), JSON.stringify(plan));
    writeFileSync(
      join(dir, `.opencode/plans/.state/${sid}/gate-state.json`),
      JSON.stringify({
        session_id: sid,
        feature_id: fid,
        planner_status: "usable",
        delivery_status: "ready",
        planner_plan_binding: { session_id: sid, feature_id: fid, snapshot_path: snapshotRel, snapshot_hash: hash },
      }),
    );
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify(plan));

    const hooks = await createObsHandHooks(dir);
    const args = {
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${tid}"}[/HARNESS_TASK_CONTEXT]\nGo.`,
      subagent_type: "executor-medium",
      feature_id: fid,
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-532-finally" }, { args });

    // Simulate the parent's gate-state directory becoming unreadable/unwritable mid-flight —
    // the terminal after-hook's finally cleanup must degrade to a warning, not crash the run.
    corruptGateStateDir(dir, sid);

    const warnings = await captureWarnings(() =>
      assert.doesNotReject(() =>
        hooks["tool.execute.after"](
          { tool: "task", sessionID: sid, callID: "call-532-finally" },
          { args, output: "Status: DONE\n" },
        ),
      ),
    );
    assert.ok(
      warnings.some((w) => /after-hook cleanup skipped/.test(String(w))),
      `expected an after-hook cleanup-skip warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#532 message.part.updated tool-error cleanup failure warns, never crashes the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-532-toolerr-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_532_toolerr";
    const fid = "feat-532-toolerr";
    const tid = "t-532-toolerr";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    mkdirSync(join(dir, `.opencode/plans/.state/${sid}/bound-plans`), { recursive: true });
    const plan = {
      feature_id: fid,
      kind: "full",
      mode: "full",
      tasks: [{
        id: tid,
        severity: "medium",
        complexity: "medium",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-a", path: "src/a.test.mjs", assertion: "a" }],
      }],
    };
    const hash = semanticPlanHash(plan);
    const snapshotRel = `.opencode/plans/.state/${sid}/bound-plans/${hash}.json`;
    writeFileSync(join(dir, snapshotRel), JSON.stringify(plan));
    writeFileSync(
      join(dir, `.opencode/plans/.state/${sid}/gate-state.json`),
      JSON.stringify({
        session_id: sid,
        feature_id: fid,
        planner_status: "usable",
        delivery_status: "ready",
        planner_plan_binding: { session_id: sid, feature_id: fid, snapshot_path: snapshotRel, snapshot_hash: hash },
      }),
    );
    writeFileSync(join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`), JSON.stringify(plan));

    const hooks = await createObsHandHooks(dir);
    const args = {
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${tid}"}[/HARNESS_TASK_CONTEXT]\nGo.`,
      subagent_type: "executor-medium",
      feature_id: fid,
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "call-532-toolerr" }, { args });

    corruptGateStateDir(dir, sid);

    const warnings = await captureWarnings(() =>
      assert.doesNotReject(() =>
        hooks.event({
          event: {
            type: "message.part.updated",
            properties: {
              part: { type: "tool", tool: "task", sessionID: sid, callID: "call-532-toolerr", state: { status: "error" } },
            },
          },
        }),
      ),
    );
    assert.ok(
      warnings.some((w) => /tool-error cleanup skipped/.test(String(w))),
      `expected a tool-error cleanup-skip warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});
