import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkPiFinalCommands, registerPiCommandEvidence } from "./pi-command-evidence.mjs";
import { checkPiReviewPreparation } from "./pi-review-evidence.mjs";

function fixture(t, commands = ["npm test", "npm run typecheck", "npm run build"]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-final-checks-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  fs.writeFileSync(path.join(root, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(root, "product.txt"), "implemented\n");
  git("add", "."); git("commit", "-qm", "aggregate");
  const sessionId = "final-parent", featureId = "feature";
  const planDir = path.join(root, ".pi/harness/plans", featureId);
  const stateDir = path.join(root, ".pi/harness/state", sessionId);
  fs.mkdirSync(planDir, { recursive: true }); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "execution-plan.json"), JSON.stringify({ feature_id: featureId, tasks: [], final_review: { verification_commands: commands } }));
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId }));
  const handlers = new Map(); registerPiCommandEvidence({ on: (name, fn) => handlers.set(name, fn) });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
  let id = 0;
  async function record(command, { failure = false, during, start = true } = {}) {
    const event = { toolName: "bash", toolCallId: `call-${++id}`, input: { command } };
    if (start) handlers.get("tool_execution_start")(event, ctx);
    during?.();
    return handlers.get("tool_result")({ ...event, isError: failure, content: [{ type: "text", text: failure ? "Command exited with code 1" : "passed" }] }, ctx);
  }
  const input = { projectRoot: root, sessionId, featureId, phase: "final" };
  return { root, git, record, input, check: () => checkPiReviewPreparation(input) };
}

test("final preparation asks only for pending declared checks and keeps task eyes independent", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.check().commands, ["npm test", "npm run typecheck", "npm run build"]);
  assert.deepEqual(checkPiReviewPreparation({ ...f.input, phase: "task" }), { ok: true });
  await f.record("npm test"); await f.record("npm run typecheck");
  assert.deepEqual(f.check().commands, ["npm run build"]);
  await f.record("npm run build", { failure: true });
  assert.deepEqual(f.check().commands, ["npm run build"]);
  const pass = await f.record("npm run build");
  assert.deepEqual(f.check(), { ok: true });
  fs.writeFileSync(pass.details.command_evidence.path, "altered");
  assert.deepEqual(f.check().commands, ["npm run build"], "changed output cannot substitute for a check");
});

test("new HEAD, a dirty start and a later failure invalidate successful check evidence", async (t) => {
  const f = fixture(t, ["npm test"]);
  await f.record("npm test", { start: false });
  assert.equal(f.check().ok, false, "legacy end-only evidence does not establish the checked tree");
  await f.record("npm test"); assert.equal(f.check().ok, true);
  await f.record("npm test", { failure: true }); assert.equal(f.check().ok, false);
  await f.record("npm test");
  f.git("commit", "--allow-empty", "-qm", "new head");
  assert.equal(f.check().ok, false);
  fs.writeFileSync(path.join(f.root, "product.txt"), "new implementation\n");
  await f.record("npm test", { during: () => { f.git("add", "product.txt"); f.git("commit", "-qm", "during check"); } });
  assert.equal(f.check().ok, false, "a clean result boundary cannot hide dirty execution input");
  await f.record("npm test"); assert.equal(f.check().ok, true);
  assert.equal(checkPiFinalCommands({ ...f.input, sessionId: "other-parent", commands: ["npm test"] }).ok, false);
});

test("declared custom commands are archived without executing them and malformed declarations fail closed", async (t) => {
  const f = fixture(t, ["make verify"]);
  const result = await f.record("make verify");
  assert.equal(result.details.command_evidence.status, "available");
  assert.equal(f.check().ok, true);
  assert.equal(checkPiFinalCommands({ ...f.input, commands: "npm test" }).ok, false);
  assert.deepEqual(checkPiFinalCommands({ ...f.input }), { ok: true });
});
