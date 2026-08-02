/** @description SDK scope identity resolves exact records without sibling borrowing. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { resolveScopeRuntimeIdentity } from "./scope-runtime-identity.mjs";
import { PlanWriteGate } from "../plan-write-gate.ts";

const { createPlanWriteGateHooks } = PlanWriteGate.testApi;

function seed(root, callId, { scopePaths = ["src/a.ts"], taskId = "task" } = {}) {
  const sessionId = "parent";
  const dir = path.join(root, ".opencode", "plans", ".state", sessionId, "dispatch-records");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${crypto.createHash("sha256").update(callId).digest("hex")}.json`), JSON.stringify({ parent_session_id: sessionId, dispatch_call_id: callId, child_session_id: null, feature_id: "feat", task_id: taskId, role: "executor-low", scope_paths: scopePaths, allowed_writes: [], snapshot_hash: "a".repeat(64), claimed_at: "2026-08-01T00:00:00.000Z" }));
}

function messages(sessionId, callId) {
  return [{ info: { id: "user", sessionID: sessionId, role: "user", agent: "executor-low" }, parts: [] }, { info: { id: "assistant", sessionID: sessionId, role: "assistant", agent: "executor-low", parentID: "user" }, parts: [{ type: "tool", sessionID: sessionId, messageID: "assistant", callID: "write", tool: "write" }] }];
}

test("CLI adapter binds only its exact parent and call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-cli-"));
  try {
    seed(root, "left");
    seed(root, "right");
    const reader = { getSession: async () => ({ id: "child" }), getMessages: async () => messages("child", "write") };
    const resolved = await resolveScopeRuntimeIdentity(root, { sessionID: "child", callID: "write", tool: "write" }, { reader, adapterParentSessionId: "parent", adapterCallId: "left" });
    assert.equal(resolved.ok, true, resolved.reason);
    assert.equal(resolved.callId, "left");
    const left = JSON.parse(fs.readFileSync(path.join(root, ".opencode", "plans", ".state", "parent", "dispatch-records", `${crypto.createHash("sha256").update("left").digest("hex")}.json`), "utf8"));
    const right = JSON.parse(fs.readFileSync(path.join(root, ".opencode", "plans", ".state", "parent", "dispatch-records", `${crypto.createHash("sha256").update("right").digest("hex")}.json`), "utf8"));
    assert.equal(left.child_session_id, "child");
    assert.equal(right.child_session_id, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("missing SDK opens and returned contradiction denies", async () => {
  const unavailable = await resolveScopeRuntimeIdentity("/tmp", { sessionID: "child", callID: "write", tool: "write" }, { reader: { getSession: async () => { throw new Error("down"); } } });
  assert.equal(unavailable.unavailable, true);
  const conflict = await resolveScopeRuntimeIdentity("/tmp", { sessionID: "child", callID: "write", tool: "write" }, { reader: { getSession: async () => ({ id: "wrong" }), getMessages: async () => [] } });
  assert.equal(conflict.conflict, true);
});

test("bound child keeps its exact scope rail when official SDK metadata is temporarily unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-bound-fallback-"));
  try {
    seed(root, "bound-call", { scopePaths: ["src/a.ts"], taskId: "bound" });
    const recordPath = path.join(root, ".opencode", "plans", ".state", "parent", "dispatch-records", `${crypto.createHash("sha256").update("bound-call").digest("hex")}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.child_session_id = "child";
    fs.writeFileSync(recordPath, JSON.stringify(record));
    const reader = { getSession: async () => { throw new Error("SDK unavailable"); } };
    const resolved = await resolveScopeRuntimeIdentity(root, { sessionID: "child", callID: "write", tool: "write" }, { reader });
    assert.equal(resolved.ok, true, resolved.reason);
    assert.equal(resolved.parentSessionId, "parent");
    assert.equal(resolved.callId, "bound-call");
    assert.deepEqual(resolved.record.scope_paths, ["src/a.ts"]);

    const before = (await createPlanWriteGateHooks(root, { identityReader: reader }))["tool.execute.before"];
    await assert.rejects(
      () => before({ tool: "write", sessionID: "child", callID: "write" }, { args: { filePath: "outside/evil.ts", content: "x" } }),
      /OUTSIDE/i,
    );
    await assert.doesNotReject(
      () => before({ tool: "write", sessionID: "child", callID: "write-in-scope" }, { args: { filePath: path.join(root, "src/a.ts"), content: "x" } }),
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("durable child fallback rejects duplicate bindings instead of borrowing either scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-bound-duplicate-"));
  try {
    for (const callId of ["left", "right"]) {
      seed(root, callId);
      const recordPath = path.join(root, ".opencode", "plans", ".state", "parent", "dispatch-records", `${crypto.createHash("sha256").update(callId).digest("hex")}.json`);
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      record.child_session_id = "child";
      fs.writeFileSync(recordPath, JSON.stringify(record));
    }
    const resolved = await resolveScopeRuntimeIdentity(root, { sessionID: "child", callID: "write", tool: "write" }, { reader: { getSession: async () => { throw new Error("SDK unavailable"); } } });
    assert.equal(resolved.conflict, true, resolved.reason);
    assert.match(resolved.reason, /multiple|duplicate/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("top-level build Bash stays outside the writing-hand scope rail with official SDK metadata", async () => {
  const sessionId = "top-level-build";
  const reader = {
    getSession: async () => ({ id: sessionId }),
    getMessages: async () => [{
      info: { id: "user", sessionID: sessionId, role: "user", agent: "build" },
      parts: [],
    }, {
      info: { id: "assistant", sessionID: sessionId, role: "assistant", agent: "build", parentID: "user" },
      parts: [{ type: "tool", sessionID: sessionId, messageID: "assistant", callID: "bash-call", tool: "bash" }],
    }],
  };

  const resolved = await resolveScopeRuntimeIdentity(
    "/tmp",
    { sessionID: sessionId, callID: "bash-call", tool: "bash" },
    { reader },
  );
  assert.equal(resolved.notWritingSession, true, resolved.reason);
  assert.notEqual(resolved.conflict, true, resolved.reason);

  const before = (await createPlanWriteGateHooks("/tmp", { identityReader: reader }))["tool.execute.before"];
  await assert.doesNotReject(() => before(
    { tool: "bash", sessionID: sessionId, callID: "bash-call" },
    { args: { command: "gh issue view 134 --comments" } },
  ));
});

test("official child metadata resolves one exact bound parent call and rejects ambiguity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-child-"));
  try {
    seed(root, "child-call");
    const parentMessages = [{ info: { id: "parent-assistant", sessionID: "parent", role: "assistant" }, parts: [{ type: "tool", tool: "task", sessionID: "parent", messageID: "parent-assistant", callID: "child-call", state: { status: "running", input: { subagent_type: "executor-low" }, metadata: { sessionId: "child" } } }] }];
    const childMessages = messages("child", "write");
    const recordPath = path.join(root, ".opencode", "plans", ".state", "parent", "dispatch-records", `${crypto.createHash("sha256").update("child-call").digest("hex")}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.child_session_id = "child";
    fs.writeFileSync(recordPath, JSON.stringify(record));
    const reader = { getSession: async () => ({ id: "child", parentID: "parent" }), getMessages: async (id) => id === "parent" ? parentMessages : childMessages };
    const resolved = await resolveScopeRuntimeIdentity(root, { sessionID: "child", callID: "write", tool: "write" }, { reader });
    assert.equal(resolved.ok, true, resolved.reason);
    const zero = await resolveScopeRuntimeIdentity(root, { sessionID: "child", callID: "write", tool: "write" }, { reader: { ...reader, getMessages: async (id) => id === "parent" ? [] : childMessages } });
    assert.equal(zero.conflict, true);
    const ambiguous = await resolveScopeRuntimeIdentity(root, { sessionID: "child", callID: "write", tool: "write" }, { reader: { ...reader, getMessages: async (id) => id === "parent" ? [...parentMessages, structuredClone(parentMessages[0])] : childMessages } });
    assert.equal(ambiguous.conflict, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("independent official hook factories deny by the one matched call without borrowing a permissive sibling", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-independent-factories-"));
  try {
    seed(root, "narrow-call", { scopePaths: ["src/a.ts"], taskId: "narrow" });
    seed(root, "permissive-sibling", { scopePaths: ["outside"], taskId: "sibling" });
    const parentMessages = [{ info: { id: "parent-assistant", sessionID: "parent", role: "assistant" }, parts: [{ type: "tool", tool: "task", sessionID: "parent", messageID: "parent-assistant", callID: "narrow-call", state: { status: "running", input: { subagent_type: "executor-low" }, metadata: { sessionId: "child" } } }] }];
    const childMessages = messages("child", "write");
    const client = { session: {
      get: async ({ path: requestPath }) => ({ data: { id: requestPath.id, parentID: requestPath.id === "child" ? "parent" : undefined } }),
      messages: async ({ path: requestPath }) => ({ data: requestPath.id === "parent" ? parentMessages : childMessages }),
    } };
    const first = await PlanWriteGate({ directory: root, client });
    const second = await PlanWriteGate({ directory: root, client });
    for (const hooks of [first, second]) {
      await assert.rejects(
        () => hooks["tool.execute.before"]({ tool: "write", sessionID: "child", callID: "write" }, { args: { filePath: "outside/evil.ts", content: "x" } }),
        /OUTSIDE/i,
      );
    }
    const read = (callId) => JSON.parse(fs.readFileSync(path.join(root, ".opencode", "plans", ".state", "parent", "dispatch-records", `${crypto.createHash("sha256").update(callId).digest("hex")}.json`), "utf8"));
    assert.equal(read("narrow-call").child_session_id, "child");
    assert.equal(read("permissive-sibling").child_session_id, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("first child Write binds from the official parent Task fact when eager event binding is delayed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-child-first-write-"));
  try {
    seed(root, "delayed-call");
    const parentMessages = [{ info: { id: "parent-assistant", sessionID: "parent", role: "assistant" }, parts: [{ type: "tool", tool: "task", sessionID: "parent", messageID: "parent-assistant", callID: "delayed-call", state: { status: "running", input: { subagent_type: "executor-low" }, metadata: { sessionId: "child" } } }] }];
    const reader = {
      getSession: async () => ({ id: "child", parentID: "parent" }),
      getMessages: async (id) => id === "parent" ? parentMessages : messages("child", "write"),
    };
    const resolved = await resolveScopeRuntimeIdentity(root, { sessionID: "child", callID: "write", tool: "write" }, { reader });
    assert.equal(resolved.ok, true, resolved.reason);
    const recordPath = path.join(root, ".opencode", "plans", ".state", "parent", "dispatch-records", `${crypto.createHash("sha256").update("delayed-call").digest("hex")}.json`);
    assert.equal(JSON.parse(fs.readFileSync(recordPath, "utf8")).child_session_id, "child");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("official out-of-scope Write denies when its present exact record is malformed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-malformed-official-"));
  try {
    seed(root, "malformed-call");
    const recordPath = path.join(root, ".opencode", "plans", ".state", "parent", "dispatch-records", `${crypto.createHash("sha256").update("malformed-call").digest("hex")}.json`);
    const malformed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete malformed.scope_paths;
    fs.writeFileSync(recordPath, JSON.stringify(malformed));
    const parentMessages = [{ info: { id: "parent-assistant", sessionID: "parent", role: "assistant" }, parts: [{ type: "tool", tool: "task", sessionID: "parent", messageID: "parent-assistant", callID: "malformed-call", state: { status: "running", input: { subagent_type: "executor-low" }, metadata: { sessionId: "child" } } }] }];
    const reader = {
      getSession: async () => ({ id: "child", parentID: "parent" }),
      getMessages: async (id) => id === "parent" ? parentMessages : messages("child", "write"),
    };
    const before = (await createPlanWriteGateHooks(root, { identityReader: reader }))["tool.execute.before"];
    await assert.rejects(
      () => before({ tool: "write", sessionID: "child", callID: "write" }, { args: { filePath: "outside/evil.ts", content: "x" } }),
      /conflict|malformed|invalid/i,
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
