/** @description Planner-recovery hooks preserve session/call identity and canonical artifacts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { createPlannerRecoveryHooks } from "./planner-recovery.ts";
import { createPlanGateHooks } from "./plan-gate.ts";
const savedObservabilityRunPath = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
const hadObservabilityRunPath = Object.prototype.hasOwnProperty.call(process.env, "HARNESS_OBSERVABILITY_RUN_PATH");
before(() => { delete process.env.HARNESS_OBSERVABILITY_RUN_PATH; });
after(() => {
  if (hadObservabilityRunPath) process.env.HARNESS_OBSERVABILITY_RUN_PATH = savedObservabilityRunPath;
  else delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
});

const sessionId = "ses_plannerRecovery01";
const featureId = "planner-recovery";
const modelStrategy = {
  hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
  planner: "openai/gpt-5.6-sol",
  "plan-reviewer": "openai/gpt-5.6-sol",
  compliance: "openai/gpt-5.6-terra",
  adversary: "openai/gpt-5.6-sol",
  security: "openai/gpt-5.6-sol",
  shipper: "openai/gpt-5.6-luna",
  harvester: "openai/gpt-5.6-luna",
};
const plan = {
  feature_id: featureId,
  kind: "full",
  mode: "full",
  model_strategy: modelStrategy,
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
    fs.copyFileSync(path.resolve(process.cwd(), "core/opencode/harness.routing.json"), path.join(root, ".opencode", "harness.routing.json"));
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

test("duplicate planner before reuses its frozen snapshot after routing changes", async () => {
  await withRun(async (root, state) => {
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    const firstArgs = { subagent_type: "planner", prompt: "Plan." };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "call" }, { args: firstArgs });
    const frozen = state().planner_active_attempt.expected_model_strategy;
    fs.writeFileSync(path.join(root, ".opencode", "harness.routing.json"), "{ invalid", "utf8");
    const duplicateArgs = { subagent_type: "planner", prompt: "Plan again." };
    await assert.doesNotReject(() => hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "call" }, { args: duplicateArgs }));
    assert.deepEqual(state().planner_active_attempt.expected_model_strategy, frozen);
    assert.match(duplicateArgs.prompt, /HARNESS_EXPECTED_MODEL_STRATEGY/);
  });
});

test("a bound baseline returned unchanged by a revision is rejected", async () => {
  await withRun(async (root, state) => {
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    const firstArgs = { subagent_type: "planner", prompt: "Plan." };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "first" }, { args: firstArgs });
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sessionId, callID: "first", args: firstArgs }, { output: JSON.stringify(plan), metadata: {} });
    assert.equal(state().planner_status, "usable");

    const revisionArgs = { subagent_type: "planner", prompt: "Revise." };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "revision" }, { args: revisionArgs });
    assert.equal(state().planner_active_attempt.baseline_plan.bound, true);
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sessionId, callID: "revision", args: revisionArgs }, { output: JSON.stringify(plan), metadata: {} });
    assert.equal(state().planner_status, "plan_invalid");
    assert.match(state().planner_invalid_errors[0], /unchanged/);
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

test("retired planner fallback cannot claim, bind, or write a canonical plan", async () => {
  await withRun(async (root, state) => {
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    const args = { subagent_type: "planner-fallback", prompt: "Produce a plan." };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "retired" }, { args });
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sessionId, callID: "retired", args },
      { output: JSON.stringify(plan), metadata: {} },
    );
    assert.deepEqual(state(), { session_id: sessionId, feature_id: featureId, classified: true });
    assert.equal(fs.existsSync(path.join(root, ".opencode", "plans", `${sessionId}-${featureId}`, "execution-plan.json")), false);
  });
});

test("canonical planner preserves the opaque model_strategy fallback namespace", async () => {
  await withRun(async (root) => {
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    const args = { subagent_type: "planner" };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "canonical" }, { args });
    const fallback = { provider: "acme", model: "opaque/model", sentinel: "preserve-exactly" };
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sessionId, callID: "canonical", args },
      { output: JSON.stringify({ ...plan, model_strategy: { ...modelStrategy, fallback } }), metadata: {} },
    );
    const written = JSON.parse(fs.readFileSync(path.join(root, ".opencode", "plans", `${sessionId}-${featureId}`, "execution-plan.json"), "utf8"));
    assert.deepEqual(written.model_strategy.fallback, fallback);
  });
});

test("invalid R15 planner output leaves existing canonical bytes untouched", async () => {
  await withRun(async (root, state) => {
    const canonical = path.join(root, ".opencode", "plans", `${sessionId}-${featureId}`, "execution-plan.json");
    const original = Buffer.from('{"preexisting":"canonical bytes"}\n');
    fs.writeFileSync(canonical, original);
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    const args = { subagent_type: "planner" };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "r15" }, { args });
    const invalid = { ...plan, model_strategy: { ...modelStrategy, hand_tiers: { low: "gemma4", medium: "glm-5.2" } } };
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sessionId, callID: "r15", args }, { output: JSON.stringify(invalid), metadata: {} });
    assert.equal(state().planner_status, "plan_invalid");
    assert.deepEqual(fs.readFileSync(canonical), original);
    assert.equal(fs.existsSync(path.join(root, ".opencode", "plans", ".state", sessionId, "bound-plans")), false);
  });
});

test("wrong call and corrupt active identity leave state and canonical bytes unchanged", async () => {
  for (const corruption of ["wrong-call", "empty-token", "wrong-feature"]) {
    await withRun(async (root, state) => {
      const canonical = path.join(root, ".opencode", "plans", `${sessionId}-${featureId}`, "execution-plan.json");
      const original = Buffer.from('{"preexisting":"canonical bytes"}\n');
      fs.writeFileSync(canonical, original);
      const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
      const args = { subagent_type: "planner" };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "claimed" }, { args });
      if (corruption !== "wrong-call") {
        const changed = state();
        if (corruption === "empty-token") changed.planner_active_attempt.token = "";
        else changed.planner_active_attempt.feature_id = "foreign-feature";
        fs.writeFileSync(path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json"), JSON.stringify(changed, null, 2));
      }
      const stateBefore = fs.readFileSync(path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json"));
      await hooks["tool.execute.after"](
        { tool: "task", sessionID: sessionId, callID: corruption === "wrong-call" ? "other" : "claimed", args },
        { output: JSON.stringify(plan), metadata: {} },
      );
      assert.deepEqual(fs.readFileSync(path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json")), stateBefore, corruption);
      assert.deepEqual(fs.readFileSync(canonical), original, corruption);
    });
  }
});

test("malformed vendored routing rejects planner dispatch without falling back to root routing", async () => {
  await withRun(async (root, state) => {
    fs.writeFileSync(path.join(root, ".opencode", "harness.routing.json"), "{ malformed", "utf8");
    fs.copyFileSync(path.resolve(process.cwd(), "core/opencode/harness.routing.json"), path.join(root, "harness.routing.json"));
    const before = fs.readFileSync(path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json"));
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    await assert.rejects(
      () => hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "routing" }, { args: { subagent_type: "planner" } }),
      /routing is missing or invalid/,
    );
    assert.deepEqual(fs.readFileSync(path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json")), before);
    assert.deepEqual(state(), { session_id: sessionId, feature_id: featureId, classified: true });
  });
});

test("bound plan remains dispatchable after routing changes because its call snapshot is frozen", async () => {
  await withRun(async (root, state) => {
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    const args = { subagent_type: "planner", prompt: "Plan." };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "frozen" }, { args });
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sessionId, callID: "frozen", args }, { output: JSON.stringify(plan), metadata: {} });
    assert.equal(state().planner_status, "usable");
    const routing = JSON.parse(fs.readFileSync(path.join(root, ".opencode", "harness.routing.json"), "utf8"));
    routing.roles.planner.model = "other/provider";
    fs.writeFileSync(path.join(root, ".opencode", "harness.routing.json"), JSON.stringify(routing));
    const gate = await createPlanGateHooks(root);
    await assert.doesNotReject(() => gate["tool.execute.before"](
      { tool: "task", sessionID: sessionId },
      { args: { subagent_type: "executor-low", prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT]' } },
    ));
  });
});

test("snapshot failure happens before canonical promotion and leaves prior canonical bytes inert", async () => {
  await withRun(async (root, state) => {
    const canonical = path.join(root, ".opencode", "plans", `${sessionId}-${featureId}`, "execution-plan.json");
    const original = Buffer.from('{"prior":"canonical"}\n');
    fs.writeFileSync(canonical, original);
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    const args = { subagent_type: "planner" };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "snapshot-fault" }, { args });
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to).includes(`${path.sep}bound-plans${path.sep}`)) throw new Error("snapshot rename fault");
      return originalRename(from, to);
    };
    try {
      await hooks["tool.execute.after"]({ tool: "task", sessionID: sessionId, callID: "snapshot-fault", args }, { output: JSON.stringify(plan), metadata: {} });
    } finally {
      fs.renameSync = originalRename;
    }
    assert.deepEqual(fs.readFileSync(canonical), original);
    assert.equal(state().planner_status, "plan_invalid");
    assert.equal(state().planner_plan_binding, undefined);
  });
});

test("canonical promotion failure cannot bind or emit plan-created", async () => {
  await withRun(async (root, state) => {
    const meta = path.join(root, "obs.json");
    fs.writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    const args = { subagent_type: "planner" };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "canonical-fault" }, { args });
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (path.basename(String(to)) === "execution-plan.json") throw new Error("canonical rename fault");
      return originalRename(from, to);
    };
    try {
      await hooks["tool.execute.after"]({ tool: "task", sessionID: sessionId, callID: "canonical-fault", args }, { output: JSON.stringify(plan), metadata: {} });
    } finally {
      fs.renameSync = originalRename;
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    }
    assert.equal(state().planner_status, "plan_invalid");
    assert.equal(state().planner_plan_binding, undefined);
    assert.equal(fs.existsSync(path.join(root, "obs.events.jsonl")), false);
  });
});

test("final gate-state write failure leaves bytes unbound and a distinct planner call can bind them", async () => {
  await withRun(async (root, state) => {
    const meta = path.join(root, "obs.json");
    fs.writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const hooks = await createPlannerRecoveryHooks(root, { token: () => "token" });
    const firstArgs = { subagent_type: "planner" };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "first" }, { args: firstArgs });
    const originalRename = fs.renameSync;
    let gateStateRenames = 0;
    fs.renameSync = (from, to) => {
      if (path.basename(String(to)) === "gate-state.json" && ++gateStateRenames === 1) throw new Error("final gate-state rename fault");
      return originalRename(from, to);
    };
    try {
      await assert.rejects(
        () => hooks["tool.execute.after"]({ tool: "task", sessionID: sessionId, callID: "first", args: firstArgs }, { output: JSON.stringify(plan), metadata: {} }),
        /gate-state-write-failed/,
      );
    } finally {
      fs.renameSync = originalRename;
    }
    const canonical = path.join(root, ".opencode", "plans", `${sessionId}-${featureId}`, "execution-plan.json");
    assert.equal(fs.existsSync(canonical), true);
    assert.notEqual(state().planner_status, "usable");
    assert.equal(state().planner_plan_binding, undefined);
    assert.equal(fs.existsSync(path.join(root, "obs.events.jsonl")), false);

    const secondArgs = { subagent_type: "planner" };
    // Same JSON meaning, but deliberately different serialized bytes/order. The failed
    // first final-state write left its snapshot inert; the next call must be able to
    // publish its own byte-addressed snapshot instead of colliding with it.
    const reorderedPlan = {
      tasks: plan.tasks,
      model_strategy: plan.model_strategy,
      mode: plan.mode,
      kind: plan.kind,
      feature_id: plan.feature_id,
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "second" }, { args: secondArgs });
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sessionId, callID: "second", args: secondArgs }, { output: JSON.stringify(reorderedPlan), metadata: {} });
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    assert.equal(state().planner_status, "usable");
    assert.equal(state().planner_plan_binding.call_id, "second");
  });
});
