/** @description Behavioral identity, replay, concurrency, and byte-neutral denial tests for marker authority. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validatePrivilegedMarkerSeals } from "./lib/marker-seal.mjs";

const stub = `
  const schemaValue = { describe() { return this }, optional() { return this } };
  export const tool = (definition) => definition;
  tool.schema = { string() { return Object.create(schemaValue) } };
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin/tool") {
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { default: MarkerAuthority } = await import("./marker-authority.ts");
const { writeHandRecord, buildTaskHandRecord } = await import("./lib/hand-records.mjs");
const { fidelityPassEntry } = await import("./lib/mark-gate.mjs");
const { handRecordPath } = await import("../../shared/lib/path-helpers.mjs");

function statePath(root, sessionID = "ses-authority") {
  return path.join(root, ".opencode", "plans", ".state", sessionID, "gate-state.json");
}

const SESSION = "ses-authority";
const FEATURE = "feature-authority";
const TASK = "task-one";

async function markOnce(before, execute, action, extra = {}, callID = `call-${action}`) {
  const args = { action, ...extra };
  await before({ tool: "mark", sessionID: SESSION, callID }, { args });
  return execute(args, context(SESSION, callID));
}

function seedDoneHandRecord(root, outcome = "DONE") {
  const record = buildTaskHandRecord({
    featureId: FEATURE,
    taskId: TASK,
    sessionId: SESSION,
    outcome,
    agent: "executor-medium",
  });
  const written = writeHandRecord({
    roots: { projectRoot: root, runtime: "opencode", sessionId: SESSION, featureId: FEATURE },
    taskId: TASK,
    record,
  });
  assert.equal(written.ok, true, written.reason);
  return written.path;
}

function seed(root) {
  const file = statePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = '{\n  "session_id": "ses-authority",\n  "feature_id": "feature-authority",\n  "ceremony_generation": "generation-authority",\n  "classified": true\n}\n';
  fs.writeFileSync(file, bytes);
  const spec = path.join(root, ".opencode", "plans", "ses-authority-feature-authority", "spec.md");
  fs.mkdirSync(path.dirname(spec), { recursive: true });
  fs.writeFileSync(spec, "# Feature\n\n#uj-1\n\n#ac-1.1\n");
  return { file, bytes };
}

async function harness(root) {
  const hooks = await MarkerAuthority({ directory: root, worktree: root });
  return {
    before: hooks["tool.execute.before"],
    execute: hooks.tool.mark.execute,
  };
}

function context(sessionID = "ses-authority", callID = "call-authority") {
  return { sessionID, callID, messageID: "msg-authority", agent: "build", directory: "/ignored", worktree: "/ignored" };
}

test("real before-hook object identity authorizes one bound mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-ok-"));
  try {
    const { file } = seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
    const result = await execute(args, context());
    assert.equal(result.metadata.ok, true, result.output);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual({ ...state.brainstormed_binding, seal: undefined }, {
      session_id: "ses-authority",
      feature_id: "feature-authority",
      operation: "brainstormed",
      seal: undefined,
    });
    assert.equal(typeof state.brainstormed_binding.seal, "string");
    assert.equal(Array.isArray(state.marker_seals), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime adversary result plus accepted official transition persists before planner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-adversary-"));
  try {
    const { file } = seed(root);
    const hooks = await MarkerAuthority({ directory: root, worktree: root });
    const brainstormArgs = { action: "brainstormed" };
    await hooks["tool.execute.before"]({ tool: "mark", sessionID: "ses-authority", callID: "brainstorm-call" }, { args: brainstormArgs });
    assert.equal((await hooks.tool.mark.execute(brainstormArgs, context("ses-authority", "brainstorm-call"))).metadata.ok, true);

    await hooks["tool.execute.after"](
      { tool: "task", sessionID: "ses-authority", callID: "adversary-call" },
      { args: { subagent_type: "adversary-family-1" }, output: '{"issues":[]}' },
    );
    const adversaryArgs = { action: "adversary_fired" };
    await hooks["tool.execute.before"]({ tool: "mark", sessionID: "ses-authority", callID: "accept-call" }, { args: adversaryArgs });
    const accepted = await hooks.tool.mark.execute(adversaryArgs, context("ses-authority", "accept-call"));
    assert.equal(accepted.metadata.ok, true, accepted.output);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(state.brainstormed, true);
    assert.equal(state.adversary_fired, true);
    assert.equal(state.ceremony_evidence.adversary_fired.call_id, "adversary-call");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("another process authority can write bytes but cannot mint host-valid marker semantics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-process-"));
  try {
    const { file } = seed(root);
    const moduleUrl = pathToFileURL(path.resolve("core/opencode/plugin/marker-authority.ts")).href;
    const script = `
      const { registerHooks } = await import("node:module");
      const stub = ${JSON.stringify(stub)};
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === "@opencode-ai/plugin/tool") {
          return { url: \`data:text/javascript,\${encodeURIComponent(stub)}\`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      } });
      const { default: authority } = await import(${JSON.stringify(moduleUrl)});
      const hooks = await authority({ directory: process.argv[1], worktree: process.argv[1] });
      const args = { action: "brainstormed" };
      await hooks["tool.execute.before"](
        { tool: "mark", sessionID: "ses-authority", callID: "child-call" },
        { args },
      );
      const result = await hooks.tool.mark.execute(args, {
        sessionID: "ses-authority", callID: "child-call", messageID: "child-message",
        agent: "build", directory: process.argv[1], worktree: process.argv[1],
      });
      if (!result.metadata.ok) process.exit(2);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, root], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const childState = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(childState.brainstormed, true);
    assert.equal(validatePrivilegedMarkerSeals(childState, {
      sessionId: "ses-authority",
      featureId: "feature-authority",
    }).ok, false);

    seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "parent-call" }, { args });
    await execute(args, context("ses-authority", "parent-call"));
    const parentState = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(validatePrivilegedMarkerSeals(parentState, {
      sessionId: "ses-authority",
      featureId: "feature-authority",
    }).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct execute, structural clone, and mismatched runtime IDs fail byte-neutral", async () => {
  for (const variant of ["direct", "clone", "session", "call"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `marker-authority-${variant}-`));
    try {
      const { file, bytes } = seed(root);
      const { before, execute } = await harness(root);
      const args = { action: "brainstormed" };
      let invoked = args;
      let ctx = context();
      if (variant !== "direct") {
        await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
      }
      if (variant === "clone") invoked = { ...args };
      if (variant === "session") ctx = context("ses-foreign", "call-authority");
      if (variant === "call") ctx = context("ses-authority", "call-foreign");
      const result = await execute(invoked, ctx);
      assert.equal(result.metadata.ok, false, variant);
      assert.equal(fs.readFileSync(file, "utf8"), bytes, variant);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("authorization replay is consumed before mutation and cannot change bytes twice", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-replay-"));
  try {
    const { file } = seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
    const first = await execute(args, context());
    assert.equal(first.metadata.ok, true);
    const afterFirst = fs.readFileSync(file, "utf8");
    const replay = await execute(args, context());
    assert.equal(replay.metadata.ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), afterFirst);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed privileged mutation consumes authorization and remains byte-neutral", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-failure-"));
  try {
    const { file, bytes } = seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "dual", status: "not-an-enum" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
    const failed = await execute(args, context());
    assert.equal(failed.metadata.ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    const replay = await execute(args, context());
    assert.equal(replay.metadata.ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent duplicate before and execute attempts have one winner with no second mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-race-"));
  try {
    const { file, bytes } = seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
    await assert.rejects(
      () => before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args }),
      /already authorized/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    const [a, b] = await Promise.all([execute(args, context()), execute(args, context())]);
    assert.equal([a.metadata.ok, b.metadata.ok].filter(Boolean).length, 1);
    const after = fs.readFileSync(file, "utf8");
    assert.match(after, /brainstormed_binding/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture-verified happy path: DONE hand-record + hand-finished stamps capture_verified and capturedVerifiedAt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-ok-"));
  try {
    const { file } = seed(root);
    const recordPath = seedDoneHandRecord(root, "DONE");
    const { before, execute } = await harness(root);
    const sha = "abc123deadbeef";
    const finished = await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-hand-finished");
    assert.equal(finished.metadata.ok, true, finished.output);
    const captured = await markOnce(
      before,
      execute,
      "capture-verified",
      { task_id: TASK, sha },
      "call-capture-verified",
    );
    assert.equal(captured.metadata.ok, true, captured.output);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const expected = fidelityPassEntry(FEATURE, TASK, sha);
    assert.ok(Array.isArray(state.capture_verified), "capture_verified must be array");
    assert.ok(state.capture_verified.includes(expected), `expected ${expected} in ${JSON.stringify(state.capture_verified)}`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.equal(typeof record.capturedVerifiedAt, "string");
    assert.ok(record.capturedVerifiedAt.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture-verified without hand-record → ok:false hand-record missing, no capture stamp", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-missing-"));
  try {
    const { file } = seed(root);
    const { before, execute } = await harness(root);
    const finished = await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-hand-finished");
    assert.equal(finished.metadata.ok, true, finished.output);
    const captured = await markOnce(
      before,
      execute,
      "capture-verified",
      { task_id: TASK, sha: "abc123deadbeef" },
      "call-capture-verified",
    );
    assert.equal(captured.metadata.ok, false);
    assert.match(String(captured.metadata.reason ?? ""), /hand-record missing/i);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const expected = fidelityPassEntry(FEATURE, TASK, "abc123deadbeef");
    assert.equal(Array.isArray(state.capture_verified) ? state.capture_verified.includes(expected) : false, false);
    const resolved = handRecordPath(
      { projectRoot: root, runtime: "opencode", sessionId: SESSION, featureId: FEATURE },
      TASK,
    );
    assert.equal(resolved.ok, true);
    assert.equal(fs.existsSync(resolved.path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture-verified with BLOCKED hand-record → ok:false not DONE", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-blocked-"));
  try {
    const { file } = seed(root);
    seedDoneHandRecord(root, "BLOCKED");
    const { before, execute } = await harness(root);
    const finished = await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-hand-finished");
    assert.equal(finished.metadata.ok, true, finished.output);
    const captured = await markOnce(
      before,
      execute,
      "capture-verified",
      { task_id: TASK, sha: "abc123deadbeef" },
      "call-capture-verified",
    );
    assert.equal(captured.metadata.ok, false);
    assert.match(String(captured.metadata.reason ?? ""), /hand-record is not DONE/i);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const expected = fidelityPassEntry(FEATURE, TASK, "abc123deadbeef");
    assert.equal(Array.isArray(state.capture_verified) ? state.capture_verified.includes(expected) : false, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regate-passed without regate_pending → ok:false", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-regate-no-pending-"));
  try {
    seed(root);
    const { before, execute } = await harness(root);
    const passed = await markOnce(
      before,
      execute,
      "regate-passed",
      { task_id: TASK, sha: "abc123deadbeef" },
      "call-regate-passed",
    );
    assert.equal(passed.metadata.ok, false);
    assert.match(String(passed.metadata.reason ?? ""), /regate_pending does not contain/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regate-passed after regate-pending → ok:true", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-regate-ok-"));
  try {
    const { file } = seed(root);
    const { before, execute } = await harness(root);
    assert.equal((await markOnce(before, execute, "regate-pending", { task_id: TASK }, "call-regate-pending")).metadata.ok, true);
    const passed = await markOnce(
      before,
      execute,
      "regate-passed",
      { task_id: TASK, sha: "abc123deadbeef" },
      "call-regate-passed",
    );
    assert.equal(passed.metadata.ok, true, passed.output);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(Array.isArray(state.regate_passed) && state.regate_passed.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture-verified rejects forged writtenBy (not host adapter)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-forge-"));
  try {
    const { file } = seed(root);
    const forged = {
      ...buildTaskHandRecord({
        featureId: FEATURE,
        taskId: TASK,
        sessionId: SESSION,
        outcome: "DONE",
        agent: "executor-medium",
      }),
      writtenBy: "model-bash",
    };
    const written = writeHandRecord({
      roots: { projectRoot: root, runtime: "opencode", sessionId: SESSION, featureId: FEATURE },
      taskId: TASK,
      record: forged,
    });
    assert.equal(written.ok, true);
    const { before, execute } = await harness(root);
    assert.equal((await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-hand-finished")).metadata.ok, true);
    const captured = await markOnce(
      before,
      execute,
      "capture-verified",
      { task_id: TASK, sha: "abc123deadbeef" },
      "call-capture-verified",
    );
    assert.equal(captured.metadata.ok, false);
    assert.match(String(captured.metadata.reason ?? ""), /writtenBy is not a host adapter/i);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(Array.isArray(state.capture_verified) ? state.capture_verified.length : 0, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
