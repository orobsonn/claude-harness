import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePiReviewInput, parsePiReviewCompletion, recordPiReviewReceipt } from "../lib/pi-review-evidence.mjs";
import { PARALLEL_REVIEW_ROLES } from "../lib/roles.mjs";

const SESSION = "review-status-session";
const FEATURE = "review-status-feature";
const TASK = "task-one";

async function tool() {
  const tools = new Map();
  const file = new URL("./harness-reviews.ts", import.meta.url);
  if (existsSync(file)) (await import(file.href)).default({ registerTool: (item) => tools.set(item.name, item) });
  assert.ok(tools.has("harness_reviews"), "the parent needs an actual read-only status tool to resume only missing reviews");
  return tools.get("harness_reviews");
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-review-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(root, "feature.txt"), "behavior A");
  writeFileSync(join(root, ".gitignore"), ".pi/harness/state/\n");
  mkdirSync(join(root, ".pi/harness/plans", FEATURE), { recursive: true });
  writeFileSync(join(root, ".pi/harness/plans", FEATURE, "execution-plan.json"), JSON.stringify({ feature_id: FEATURE, final_review: { compliance: true, adversary: true, security: true }, tasks: [{ id: TASK }] }));
  writeFileSync(join(root, ".pi/harness/plans", FEATURE, "spec.md"), "# Expected behavior");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
  const statePath = join(root, ".pi/harness/state", SESSION, "gate-state.json");
  mkdirSync(join(root, ".pi/harness/state", SESSION), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ session_id: SESSION, feature_id: FEATURE }));
  const entries = [];
  const ctx = { cwd: root, sessionManager: { getSessionId: () => SESSION, getHeader: () => ({}), getEntries: () => entries } };
  return { root, statePath, ctx, entries };
}

function reviewDispatch(role, taskId = TASK, { id = `call-${role}`, stopReason = "toolUse", taskReview = true } = {}) {
  const prompt = `${taskReview ? "[HARNESS_TASK_REVIEW]\n" : ""}[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]\nReview implementation.`;
  return {
    type: "message",
    id: `entry-${id}`,
    message: {
      role: "assistant",
      stopReason,
      content: [{ type: "toolCall", id, name: "subagent", arguments: { subagent_type: role, prompt } }],
    },
  };
}

function record(root, role, phase) {
  const input = { projectRoot: root, sessionId: SESSION, featureId: FEATURE, phase, ...(phase === "task" ? { taskId: TASK } : {}) };
  const captured = capturePiReviewInput(input);
  assert.equal(captured.ok, true, captured.reason);
  const id = `agent-${role}`;
  const body = '{"issues":[]}';
  const parsed = parsePiReviewCompletion({
    role, snapshotStart: captured.snapshot, snapshotEnd: captured.snapshot,
    nativeRecord: { id, type: role, status: "completed", isBackground: false, result: body, completedAt: 2 },
    result: { content: [{ type: "text", text: `Agent completed in 1s\nAgent ID: ${id}\n\n${body}` }], details: { agentId: id, status: "completed" } },
  });
  assert.equal(parsed.ok, true, parsed.reason);
  const written = recordPiReviewReceipt({ ...input, completion: parsed.completion, binding: { agentId: id, dispatchCallId: `call-${role}`, childSessionId: `child-${role}` } });
  assert.equal(written.ok, true, written.reason);
}

test("task status separates its required adversary from available opt-in reviewers", async (t) => {
  const f = fixture(t);
  const args = { phase: "task", task_id: TASK };
  const pristine = await (await tool()).execute("status-pristine", args, undefined, undefined, f.ctx);
  assert.deepEqual(pristine.details, {
    required: ["harness-adversary"],
    available: [...PARALLEL_REVIEW_ROLES],
    accepted: [],
    missing: ["harness-adversary"],
  });
  for (const role of PARALLEL_REVIEW_ROLES.slice(0, 2)) record(f.root, role, "task");
  const before = readFileSync(f.statePath, "utf8");
  const first = await (await tool()).execute("status-one", args, undefined, undefined, f.ctx);
  assert.deepEqual(first.details, {
    required: PARALLEL_REVIEW_ROLES.slice(0, 2),
    available: [...PARALLEL_REVIEW_ROLES],
    accepted: PARALLEL_REVIEW_ROLES.slice(0, 2),
    missing: [],
  });
  assert.deepEqual(JSON.parse(first.content[0].text), first.details);
  const resumed = await (await tool()).execute("status-two", args, undefined, undefined, f.ctx);
  assert.deepEqual(resumed.details, first.details);
  writeFileSync(join(f.root, "feature.txt"), "behavior B");
  const stale = await (await tool()).execute("status-three", args, undefined, undefined, f.ctx);
  assert.deepEqual(stale.details, {
    required: PARALLEL_REVIEW_ROLES.slice(0, 2),
    available: [...PARALLEL_REVIEW_ROLES],
    accepted: [],
    missing: PARALLEL_REVIEW_ROLES.slice(0, 2),
  });
  assert.equal(readFileSync(f.statePath, "utf8"), before, "status cannot mutate or fabricate receipts");
});

test("task status keeps a dispatched optional reviewer required after REVISE or missing completion receipt", async (t) => {
  const f = fixture(t);
  f.entries.push(
    reviewDispatch("harness-compliance", TASK, { id: "call-compliance" }),
    { type: "message", id: "result-compliance", message: {
      role: "toolResult", toolCallId: "call-compliance", toolName: "subagent",
      isError: false, content: [{ type: "text", text: '{"verdict":"REVISE"}' }],
      details: { status: "completed" },
    } },
    reviewDispatch("harness-security", TASK, { id: "call-security" }),
  );
  const result = await (await tool()).execute("status", { phase: "task", task_id: TASK }, undefined, undefined, f.ctx);
  assert.deepEqual(result.details, {
    required: [...PARALLEL_REVIEW_ROLES],
    available: [...PARALLEL_REVIEW_ROLES],
    accepted: [],
    missing: [...PARALLEL_REVIEW_ROLES],
  });
});

test("task status ignores prose, test-fidelity, foreign-task and non-dispatched assistant calls", async (t) => {
  const f = fixture(t);
  f.entries.push(
    { type: "message", id: "prose", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "subagent harness-security for task-one" }] } },
    reviewDispatch("harness-compliance", TASK, { id: "fidelity", taskReview: false }),
    reviewDispatch("harness-security", "task-two", { id: "foreign" }),
    reviewDispatch("harness-security", TASK, { id: "aborted-generation", stopReason: "aborted" }),
  );
  const result = await (await tool()).execute("status", { phase: "task", task_id: TASK }, undefined, undefined, f.ctx);
  assert.deepEqual(result.details, {
    required: ["harness-adversary"],
    available: [...PARALLEL_REVIEW_ROLES],
    accepted: [],
    missing: ["harness-adversary"],
  });
});

test("task status fails closed when durable session entries are unavailable", async (t) => {
  const f = fixture(t);
  const ctx = { ...f.ctx, sessionManager: { getSessionId: () => SESSION, getHeader: () => ({}) } };
  const result = await (await tool()).execute("status", { phase: "task", task_id: TASK }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.details.reason, /durable parent session entries/i);
});

test("final status resumes all reviewers required by the canonical plan", async (t) => {
  const f = fixture(t);
  for (const role of PARALLEL_REVIEW_ROLES.slice(0, 2)) record(f.root, role, "final");
  const result = await (await tool()).execute("status-final", { phase: "final" }, undefined, undefined, f.ctx);
  assert.deepEqual(result.details, { accepted: PARALLEL_REVIEW_ROLES.slice(0, 2), missing: ["harness-security"] });
});

test("status derives identity from the parent and rejects child calls or malformed review scope", async (t) => {
  const f = fixture(t);
  const status = await tool();
  for (const args of [{ phase: "spec" }, { phase: "task" }, { phase: "task", task_id: "../other" }, { phase: "final", task_id: TASK }, { phase: "final", feature_id: "other" }]) {
    assert.equal((await status.execute("invalid", args, undefined, undefined, f.ctx)).isError, true);
  }
  const child = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getHeader: () => ({ parentSession: SESSION }) } };
  assert.equal((await status.execute("child", { phase: "final" }, undefined, undefined, child)).isError, true);
  writeFileSync(f.statePath, JSON.stringify({ session_id: "other-session", feature_id: FEATURE }));
  assert.equal((await status.execute("mismatch", { phase: "final" }, undefined, undefined, f.ctx)).isError, true);
});

test("final status lists only reviewers required by the canonical plan", async (t) => {
  const f = fixture(t);
  const file = join(f.root, ".pi/harness/plans", FEATURE, "execution-plan.json");
  const plan = JSON.parse(readFileSync(file, "utf8"));
  for (const security of [undefined, false]) {
    writeFileSync(file, JSON.stringify({ ...plan, final_review: { compliance: true, adversary: true, ...(security === undefined ? {} : { security }) } }));
    const result = await (await tool()).execute("status", { phase: "final" }, undefined, undefined, f.ctx);
    assert.deepEqual(result.details, { accepted: [], missing: ["harness-adversary", "harness-compliance"] });
  }
  writeFileSync(file, JSON.stringify({ ...plan, final_review: { security: "true" } }));
  assert.equal((await (await tool()).execute("invalid-plan", { phase: "final" }, undefined, undefined, f.ctx)).isError, true);
});
