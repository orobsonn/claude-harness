/** @description Behavioral identity, replay, concurrency, and byte-neutral denial tests for marker authority. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
const { writeHandRecord } = await import("../lib/hand-records.mjs");
const { formatFeatureTaskEntry } = await import("../../shared/lib/absolution.mjs");
const { handRecordPath } = await import("../../shared/lib/path-helpers.mjs");
const { projectRuntimeTodo } = await import("../lib/runtime-todo-projection.mjs");

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

function ensureGitHead(root) {
  if (!fs.existsSync(path.join(root, ".git"))) {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
    fs.writeFileSync(path.join(root, "capture-anchor.txt"), "anchor\n");
    assert.equal(spawnSync("git", ["add", "capture-anchor.txt"], { cwd: root }).status, 0);
    const committed = spawnSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "test anchor"], { cwd: root });
    assert.equal(committed.status, 0, committed.stderr?.toString());
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  return head.stdout.trim();
}

function exactDispatchPath(root, callId) {
  return path.join(root, ".opencode", "plans", ".state", SESSION, "dispatch-records", `${crypto.createHash("sha256").update(callId).digest("hex")}.json`);
}

function seedProducerDispatch(root, callId = "task-call-one") {
  const file = exactDispatchPath(root, callId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    parent_session_id: SESSION,
    dispatch_call_id: callId,
    child_session_id: "child-task-one",
    feature_id: FEATURE,
    task_id: TASK,
    role: "executor-medium",
    scope_paths: ["src"],
    allowed_writes: [],
    snapshot_hash: "a".repeat(64),
    claimed_at: "2026-08-01T00:00:00.000Z",
  }));
  return file;
}

function seedDoneHandRecord(root, outcome = "DONE", overrides = {}, dispatchCallId = "task-call-one") {
  const sha = ensureGitHead(root);
  const dispatchPath = seedProducerDispatch(root, dispatchCallId);
  const record = {
    featureId: FEATURE,
    taskId: TASK,
    sessionId: SESSION,
    producerCallId: "task-call-one",
    freezeCommitSha: sha,
    outcome,
    agent: "executor-medium",
    writtenBy: "host-hand-finished",
    ...overrides,
  };
  const written = writeHandRecord({
    roots: { projectRoot: root, runtime: "opencode", sessionId: SESSION, featureId: FEATURE },
    taskId: TASK,
    record,
  });
  assert.equal(written.ok, true, written.reason);
  return { path: written.path, sha, dispatchPath };
}

function seed(root) {
  const file = statePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = '{\n  "session_id": "ses-authority",\n  "feature_id": "feature-authority",\n  "classified": true\n}\n';
  fs.writeFileSync(file, bytes);
  return { file, bytes };
}

function seedPlan(root, tasks = [TASK]) {
  const file = path.join(root, ".opencode", "plans", `${SESSION}-${FEATURE}`, "execution-plan.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ feature_id: FEATURE, tasks: tasks.map((id) => ({ id })) }));
  return file;
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

test("marker authority has no ceremony transition, adversary capture, or Task after-hook", async () => {
  const source = fs.readFileSync(new URL("marker-authority.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ceremony-transition|transitionCeremony|captureSpecAdversaryResult/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-hooks-"));
  try {
    const hooks = await MarkerAuthority({ directory: root, worktree: root });
    assert.equal(hooks["tool.execute.after"], undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real before-hook object identity writes only the plain boolean workflow fact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-ok-"));
  try {
    const { file } = seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
    const result = await execute(args, context());
    assert.equal(result.metadata.ok, true, result.output);
    assert.deepEqual(result.metadata.todo_projection, { available: false }, "a missing plan must never offer an empty list that clears native todos");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(state.brainstormed, true);
    assert.equal(state.brainstormed_binding, undefined);
    assert.equal(state.ceremony_generation, undefined);
    assert.equal(state.ceremony_evidence, undefined);
    assert.equal(state.marker_seals, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("adversary_fired requires brainstormed first and persists only plain booleans", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-adversary-"));
  try {
    const { file } = seed(root);
    const { before, execute } = await harness(root);
    const tooEarly = await markOnce(before, execute, "adversary_fired", {}, "early-adversary-call");
    assert.equal(tooEarly.metadata.ok, false);
    assert.match(String(tooEarly.metadata.reason ?? tooEarly.output), /brainstormed/i);
    assert.equal(fs.readFileSync(file, "utf8").includes("adversary_fired"), false);

    assert.equal((await markOnce(before, execute, "brainstormed", {}, "brainstorm-call")).metadata.ok, true);
    assert.equal((await markOnce(before, execute, "adversary_fired", {}, "adversary-call")).metadata.ok, true);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(state.brainstormed, true);
    assert.equal(state.adversary_fired, true);
    assert.equal(state.brainstormed_binding, undefined);
    assert.equal(state.adversary_fired_binding, undefined);
    assert.equal(state.ceremony_evidence, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A native mark invocation in another process still persists only a durable plain fact.
test("a marker minted entirely in another process persists as a plain boolean (#423, #484)", async () => {
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
    assert.equal(childState.brainstormed_binding, undefined);
    assert.equal(childState.ceremony_evidence, undefined);
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

test("unsafe task_id values are rejected before formatting and remain byte-neutral", async () => {
  for (const [label, taskId] of [
    ["at", "@task"],
    ["slash", "task/child"],
    ["whitespace", "task one"],
    ["non-string", 42],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `marker-authority-task-id-${label}-`));
    try {
      const { file, bytes } = seed(root);
      const { before, execute } = await harness(root);
      const result = await markOnce(
        before,
        execute,
        "regate-pending",
        { task_id: taskId },
        `call-unsafe-task-${label}`,
      );
      assert.equal(result.metadata.ok, false, label);
      assert.match(String(result.metadata.reason ?? result.output), /safe task_id/i, label);
      assert.equal(fs.readFileSync(file, "utf8"), bytes, label);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("unsafe feature_id in gate-state is denied before authorization and remains byte-neutral", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-feature-id-"));
  try {
    const file = statePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = '{\n  "session_id": "ses-authority",\n  "feature_id": "feature/escape",\n  "classified": true\n}\n';
    fs.writeFileSync(file, bytes, "utf8");
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };

    await assert.rejects(
      () => before({ tool: "mark", sessionID: SESSION, callID: "call-unsafe-feature" }, { args }),
      /safe feature_id/i,
    );
    const denied = await execute(args, context(SESSION, "call-unsafe-feature"));
    assert.equal(denied.metadata.ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("feature change after before-hook authorization denies and preserves the replacement state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-feature-race-"));
  try {
    const { file } = seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };
    await before({ tool: "mark", sessionID: SESSION, callID: "call-authority" }, { args });

    const replacement = {
      session_id: SESSION,
      feature_id: "feature-reclassified",
      classified: true,
      unrelated_fact: "preserve-me",
    };
    const replacementBytes = `${JSON.stringify(replacement, null, 2)}\n`;
    fs.writeFileSync(file, replacementBytes, "utf8");

    const result = await execute(args, context());
    assert.equal(result.metadata.ok, false);
    assert.match(String(result.metadata.reason ?? result.output), /gate-state identity changed before marker mutation/);
    assert.equal(fs.readFileSync(file, "utf8"), replacementBytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), replacement);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
    const args = { action: "regate-passed", task_id: "task-1", sha: "a".repeat(40) };
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
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(state.brainstormed, true);
    assert.equal(state.brainstormed_binding, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture-verified happy path: DONE hand-record + hand-finished stamps capture_verified and capturedVerifiedAt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-ok-"));
  try {
    const { file } = seed(root);
    const { path: recordPath, sha, dispatchPath } = seedDoneHandRecord(root, "DONE");
    const { before, execute } = await harness(root);
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
    const expected = formatFeatureTaskEntry(FEATURE, TASK, sha);
    assert.ok(Array.isArray(state.capture_verified), "capture_verified must be array");
    assert.ok(state.capture_verified.includes(expected), `expected ${expected} in ${JSON.stringify(state.capture_verified)}`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.equal(typeof record.capturedVerifiedAt, "string");
    assert.ok(record.capturedVerifiedAt.length > 0);
    assert.equal(fs.existsSync(dispatchPath), false, "capture consumes its exact producer record");
    const stableState = fs.readFileSync(file);
    const stableRecord = fs.readFileSync(recordPath);
    const replay = await markOnce(before, execute, "capture-verified", { task_id: TASK, sha }, "call-capture-replay");
    assert.equal(replay.metadata.ok, true, replay.output);
    assert.deepEqual(fs.readFileSync(file), stableState);
    assert.deepEqual(fs.readFileSync(recordPath), stableRecord);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("successful task marks return the canonical todo projection for immediate native todowrite", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-todo-projection-"));
  try {
    seed(root);
    seedPlan(root);
    const { sha } = seedDoneHandRecord(root, "DONE");
    const { before, execute } = await harness(root);
    const started = await markOnce(before, execute, "fidelity", { task_id: TASK, sha }, "call-todo-fidelity");
    assert.equal(started.metadata.ok, true, started.output);
    assert.equal(started.metadata.todo_projection.todos.find((todo) => todo.content === `Deliver task: ${TASK}`)?.status, "in_progress");

    assert.equal((await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-todo-finished")).metadata.ok, true);
    const captured = await markOnce(before, execute, "capture-verified", { task_id: TASK }, "call-todo-captured");
    assert.equal(captured.metadata.ok, true, captured.output);
    assert.equal(captured.metadata.todo_projection.todos.find((todo) => todo.content === `Deliver task: ${TASK}`)?.status, "completed");
    assert.deepEqual(captured.metadata.todo_projection, projectRuntimeTodo(root, SESSION));
    assert.match(captured.output, /todowrite/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture-verified rejects a DONE record with scope or frozen violations", async () => {
  for (const violations of [
    { scopeViolations: ["outside/evil.ts"], frozenViolations: [] },
    { scopeViolations: [], frozenViolations: ["test/locked.test.ts"] },
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-violation-"));
    try {
      const { file } = seed(root);
      const { path: recordPath, sha } = seedDoneHandRecord(root, "DONE", violations);
      const { before, execute } = await harness(root);
      assert.equal((await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-hand-finished")).metadata.ok, true);
      const captured = await markOnce(before, execute, "capture-verified", { task_id: TASK, sha }, "call-capture-violation");
      assert.equal(captured.metadata.ok, false);
      assert.match(String(captured.metadata.reason ?? captured.output), /scope|frozen|violation/i);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).capture_verified ?? [], []);
      assert.equal(JSON.parse(fs.readFileSync(recordPath, "utf8")).capturedVerifiedAt, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("hand-finished and capture-verified reject a path-correct record with foreign internal identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-foreign-"));
  try {
    const { file } = seed(root);
    const { path: recordPath, sha } = seedDoneHandRecord(root, "DONE", {
      featureId: "foreign-feature",
      taskId: "foreign-task",
      sessionId: "foreign-session",
      producerCallId: "foreign-call-nonempty",
    });
    const beforeRecord = fs.readFileSync(recordPath, "utf8");
    const { before, execute } = await harness(root);
    const finished = await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-foreign-finished");
    assert.equal(finished.metadata.ok, false);
    const captured = await markOnce(before, execute, "capture-verified", { task_id: TASK, sha }, "call-foreign-capture");
    assert.equal(captured.metadata.ok, false);
    assert.equal(fs.readFileSync(recordPath, "utf8"), beforeRecord);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(state.hand_finished ?? [], []);
    assert.deepEqual(state.capture_verified ?? [], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture-verified is parent-only even with a valid record and hand_finished", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-child-"));
  try {
    seed(root);
    const { sha } = seedDoneHandRecord(root);
    const { before, execute } = await harness(root);
    assert.equal((await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-parent-finished")).metadata.ok, true);
    const args = { action: "capture-verified", task_id: TASK, sha };
    await before({ tool: "mark", sessionID: SESSION, callID: "call-child-capture" }, { args });
    const captured = await execute(args, { ...context(SESSION, "call-child-capture"), agent: "executor-low" });
    assert.equal(captured.metadata.ok, false);
    assert.match(String(captured.metadata.reason ?? captured.output), /build|parent/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DONE_WITH_CONCERNS remains visible to normal review but can receive the same parent capture proof", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-concerns-capture-"));
  try {
    const { file } = seed(root);
    const { path: recordPath, sha } = seedDoneHandRecord(root, "DONE_WITH_CONCERNS");
    const { before, execute } = await harness(root);
    const finished = await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-concerns-finished");
    assert.equal(finished.metadata.ok, true, finished.metadata.reason);
    const captured = await markOnce(before, execute, "capture-verified", { task_id: TASK }, "call-concerns-capture");
    assert.equal(captured.metadata.ok, true, captured.metadata.reason);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(state.hand_finished, [`${FEATURE}/${TASK}`]);
    assert.deepEqual(state.capture_verified, [`${FEATURE}/${TASK}@${sha}`]);
    assert.match(String(JSON.parse(fs.readFileSync(recordPath, "utf8")).capturedVerifiedAt), /^\d{4}-/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("NEEDS_CONTEXT and CAPACITY_EXHAUSTED stay ineligible for hand and capture markers", async () => {
  for (const outcome of ["NEEDS_CONTEXT", "CAPACITY_EXHAUSTED"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-nonterminal-"));
    try {
      const { file } = seed(root);
      seedDoneHandRecord(root, outcome);
      const { before, execute } = await harness(root);
      const finished = await markOnce(before, execute, "hand-finished", { task_id: TASK }, `call-${outcome}-finished`);
      assert.equal(finished.metadata.ok, false);
      const captured = await markOnce(before, execute, "capture-verified", { task_id: TASK }, `call-${outcome}-capture`);
      assert.equal(captured.metadata.ok, false);
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(state.hand_finished ?? [], []);
      assert.deepEqual(state.capture_verified ?? [], []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("capture-verified ignores args.sha and stamps the record's own freeze SHA", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-sha-"));
  try {
    const { file } = seed(root);
    const { sha } = seedDoneHandRecord(root);
    const { before, execute } = await harness(root);
    assert.equal((await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-sha-finished")).metadata.ok, true);
    const captured = await markOnce(before, execute, "capture-verified", { task_id: TASK, sha: "abc123deadbeef" }, "call-sha-capture");
    assert.equal(captured.metadata.ok, true, captured.metadata.reason);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).capture_verified, [`${FEATURE}/${TASK}@${sha}`]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture-verified survives HEAD advancing between the hand finishing and the stamp", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-head-moved-"));
  try {
    const { file } = seed(root);
    const { sha } = seedDoneHandRecord(root);
    // The freeze commit of the NEXT task lands before the orchestrator stamps this one — the exact
    // shape that used to invalidate the record permanently.
    fs.writeFileSync(path.join(root, "next-task-freeze.txt"), "freeze\n");
    assert.equal(spawnSync("git", ["add", "next-task-freeze.txt"], { cwd: root }).status, 0);
    assert.equal(
      spawnSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "next freeze"], { cwd: root }).status,
      0,
    );
    const { before, execute } = await harness(root);
    assert.equal((await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-moved-finished")).metadata.ok, true);
    const captured = await markOnce(before, execute, "capture-verified", { task_id: TASK }, "call-moved-capture");
    assert.equal(captured.metadata.ok, true, captured.metadata.reason);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).capture_verified, [`${FEATURE}/${TASK}@${sha}`]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture-verified revalidates the producer when a later hand rewrote the record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-rewritten-"));
  try {
    const { file, path: recordPath, sha } = { ...seed(root), ...seedDoneHandRecord(root) };
    const { before, execute } = await harness(root);
    assert.equal((await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-rw-finished")).metadata.ok, true);
    assert.equal((await markOnce(before, execute, "capture-verified", { task_id: TASK }, "call-rw-capture")).metadata.ok, true);
    const entry = `${FEATURE}/${TASK}@${sha}`;
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath(root), "utf8")).capture_verified, [entry]);

    // A later hand on the same task rewrites the record from scratch: same freeze SHA (no commit in
    // between), so the payload still collides — but `capturedVerifiedAt` is gone. This must NOT be
    // treated as a replay; the fresh producer has to be validated and the record re-stamped.
    seedDoneHandRecord(root, "DONE", {}, "task-call-one");
    assert.equal(JSON.parse(fs.readFileSync(recordPath, "utf8")).capturedVerifiedAt, undefined);
    const recaptured = await markOnce(before, execute, "capture-verified", { task_id: TASK }, "call-rw-capture-2");
    assert.equal(recaptured.metadata.ok, true, recaptured.metadata.reason);
    assert.match(String(JSON.parse(fs.readFileSync(recordPath, "utf8")).capturedVerifiedAt), /^\d{4}-/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).capture_verified, [entry]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hand-finished without hand-record → ok:false (blocks capture path)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-missing-"));
  try {
    const { file } = seed(root);
    const { before, execute } = await harness(root);
    const finished = await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-hand-finished");
    assert.equal(finished.metadata.ok, false);
    assert.match(String(finished.metadata.reason ?? ""), /hand-record missing/i);
    const captured = await markOnce(
      before,
      execute,
      "capture-verified",
      { task_id: TASK, sha: "abc123deadbeef" },
      "call-capture-verified",
    );
    assert.equal(captured.metadata.ok, false);
    assert.match(String(captured.metadata.reason ?? ""), /hand_finished does not contain|hand-record missing/i);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const expected = formatFeatureTaskEntry(FEATURE, TASK, "abc123deadbeef");
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

test("hand-finished with BLOCKED hand-record → ok:false not capture-eligible", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-blocked-"));
  try {
    const { file } = seed(root);
    seedDoneHandRecord(root, "BLOCKED");
    const { before, execute } = await harness(root);
    const finished = await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-hand-finished");
    assert.equal(finished.metadata.ok, false);
    assert.match(String(finished.metadata.reason ?? ""), /hand-record is not capture-eligible/i);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(Array.isArray(state.hand_finished) ? state.hand_finished.length : 0, 0);
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

test("hand-finished rejects forged writtenBy (not host adapter)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-capture-forge-"));
  try {
    const { file } = seed(root);
    const forged = {
      featureId: FEATURE,
      taskId: TASK,
      sessionId: SESSION,
      producerCallId: "task-call-one",
      freezeCommitSha: "abc123deadbeef",
      outcome: "DONE",
      agent: "executor-medium",
      writtenBy: "model-bash",
    };
    const written = writeHandRecord({
      roots: { projectRoot: root, runtime: "opencode", sessionId: SESSION, featureId: FEATURE },
      taskId: TASK,
      record: forged,
    });
    assert.equal(written.ok, true);
    const { before, execute } = await harness(root);
    const finished = await markOnce(before, execute, "hand-finished", { task_id: TASK }, "call-hand-finished");
    assert.equal(finished.metadata.ok, false);
    assert.match(String(finished.metadata.reason ?? ""), /writtenBy is not a host adapter/i);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(Array.isArray(state.hand_finished) ? state.hand_finished.length : 0, 0);
    assert.equal(Array.isArray(state.capture_verified) ? state.capture_verified.length : 0, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
