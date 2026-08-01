/** @description Planner-recovery hooks preserve session/call identity and canonical artifacts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { createPlannerRecoveryHooks } from "./planner-recovery.ts";
const savedObservabilityRunPath = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
const hadObservabilityRunPath = Object.prototype.hasOwnProperty.call(process.env, "HARNESS_OBSERVABILITY_RUN_PATH");
before(() => { delete process.env.HARNESS_OBSERVABILITY_RUN_PATH; });
after(() => {
  if (hadObservabilityRunPath) process.env.HARNESS_OBSERVABILITY_RUN_PATH = savedObservabilityRunPath;
  else delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
});

const sessionId = "ses_plannerRecovery01";
const featureId = "planner-recovery";
const plan = {
  feature_id: featureId,
  kind: "full",
  mode: "full",
  tasks: [{ id: "task-1", severity: "medium", complexity: "medium", scope_paths: ["src/x.ts"], criterion_refs: ["#ac-1"], depends_on: [], locked_tests: [{ id: "lt-1", path: "src/x.test.ts", assertion: "Given x, When run, Then ok" }] }],
};

async function withRun(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "planner-recovery-"));
  try {
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    const planDir = path.join(root, ".opencode", "plans", `${sessionId}-${featureId}`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId, classified: true }));
    fs.writeFileSync(path.join(root, ".opencode", "harness.routing.json"), JSON.stringify({ roles: { planner: { model: "openai/gpt-5.6-sol" } } }));
    await run(root, () => JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("planner output creates a canonical identity-bound plan", async () => {
  await withRun(async (root, state) => {
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    const args = { subagent_type: "planner", prompt: "Produce a plan." };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "call" }, { args });
    assert.match(args.prompt, new RegExp(`HARNESS_SESSION_FEATURE_ID]${featureId}`));
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sessionId, callID: "call", args },
      { output: JSON.stringify(plan), metadata: {} },
    );
    assert.equal(state().planner_status, "usable");
    assert.equal(state().planner_plan_binding.feature_id, featureId);
  });
});

test("a planner boundary failure records only the active call identity", async () => {
  await withRun(async (root, state) => {
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "call" }, { args: { subagent_type: "planner" } });
    await hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "tool", tool: "task", sessionID: sessionId, callID: "call", state: { status: "error", error: "timeout" } } } } });
    assert.equal(state().planner_status, "planner_failed");
    assert.equal(state().planner_active_attempt, null);
  });
});
