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
  const ctx = { cwd: root, sessionManager: { getSessionId: () => SESSION, getHeader: () => ({}) } };
  return { root, statePath, ctx };
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

for (const phase of ["task", "final"]) test(`status resumes only missing ${phase} reviewers and invalidates stale inputs without writing state`, async (t) => {
  const f = fixture(t);
  const args = { phase, ...(phase === "task" ? { task_id: TASK } : {}) };
  for (const role of PARALLEL_REVIEW_ROLES.slice(0, 2)) record(f.root, role, phase);
  const before = readFileSync(f.statePath, "utf8");
  // A new extension instance represents a fresh parent process reading durable receipts.
  const first = await (await tool()).execute("status-one", args, undefined, undefined, f.ctx);
  assert.deepEqual(first.details, { accepted: PARALLEL_REVIEW_ROLES.slice(0, 2), missing: ["harness-security"] });
  assert.deepEqual(JSON.parse(first.content[0].text), first.details);
  const resumed = await (await tool()).execute("status-two", args, undefined, undefined, f.ctx);
  assert.deepEqual(resumed.details, first.details);
  writeFileSync(join(f.root, "feature.txt"), "behavior B");
  const stale = await (await tool()).execute("status-three", args, undefined, undefined, f.ctx);
  assert.deepEqual(stale.details, { accepted: [], missing: [...PARALLEL_REVIEW_ROLES] });
  assert.equal(readFileSync(f.statePath, "utf8"), before, "status cannot mutate or fabricate receipts");
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
