/** @description Behavioral probes for real OC before/after/error-event boundaries and canonical plan binding. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlannerRecoveryHooks } from "./planner-recovery.ts";
import { createPlanGateHooks } from "./plan-gate.ts";
import { reconcilePlannerStateFromDisk } from "./lib/planner-artifact.mjs";
import { sealedMarkerRecord } from "./lib/marker-seal.mjs";

const SESSION = "ses_plannerRecovery01";
const FEATURE = "planner-recovery";
const FALLBACK_MODEL = "ollama-cloud/kimi-k2.7-code";
const FULL_PLAN = {
  feature_id: FEATURE,
  kind: "full",
  mode: "full",
  tasks: [{ id: "task-1", severity: "medium", complexity: "medium", scope_paths: ["src/x.ts"], criterion_refs: ["#ac-1"], depends_on: [], locked_tests: [{ id: "lt-1", path: "src/x.test.ts" }] }],
};

async function tempRun(configureFallback, fn, initialPlan = { feature_id: FEATURE, kind: "stub", mode: "FULL", tasks: [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "planner-recovery-"));
  try {
    const stateDir = path.join(root, ".opencode", "plans", ".state", SESSION);
    const planDir = path.join(root, ".opencode", "plans", `${SESSION}-${FEATURE}`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(planDir, { recursive: true });
    const brainstormed = sealedMarkerRecord({ sessionId: SESSION, featureId: FEATURE, operation: "brainstormed", payload: true });
    const adversary = sealedMarkerRecord({ sessionId: SESSION, featureId: FEATURE, operation: "adversary_fired", payload: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({
      session_id: SESSION,
      feature_id: FEATURE,
      classified: true,
      mode: "FULL",
      brainstormed: true,
      adversary_fired: true,
      marker_seals: [brainstormed, adversary],
      brainstormed_binding: { session_id: SESSION, feature_id: FEATURE, operation: "brainstormed", seal: brainstormed.seal },
      adversary_fired_binding: { session_id: SESSION, feature_id: FEATURE, operation: "adversary_fired", seal: adversary.seal },
    }));
    fs.writeFileSync(path.join(planDir, "execution-plan.json"), JSON.stringify(initialPlan));
    const planner = { model: "openai/gpt-5.6-sol" };
    if (configureFallback) planner.fallback = { model: FALLBACK_MODEL };
    fs.writeFileSync(path.join(root, ".opencode", "harness.routing.json"), JSON.stringify({ roles: { planner }, constraints: { requireDualOn: ["plan-reviewer", "adversary"] } }));
    const agents = path.join(root, ".opencode", "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "planner-fallback.md"), `---\nmodel: ${FALLBACK_MODEL}\n---\n`);
    const state = () => JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"));
    await fn({ root, state, planPath: path.join(planDir, "execution-plan.json") });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function before(hooks, role, callID) {
  return hooks["tool.execute.before"](
    { tool: "task", sessionID: SESSION, callID },
    { args: { description: `dispatch ${role}`, prompt: "Produce the plan.", subagent_type: role } },
  );
}

function after(hooks, role, callID, response) {
  const output = { title: "task", output: response, metadata: {} };
  return hooks["tool.execute.after"](
    { tool: "task", sessionID: SESSION, callID, args: { description: `dispatch ${role}`, prompt: "Produce the plan.", subagent_type: role } },
    output,
  ).then(() => output);
}

function rejection(hooks, callID, error, partSessionID = SESSION) {
  return hooks.event({ event: { type: "message.part.updated", properties: { part: {
    id: "part", messageID: "message", type: "tool", tool: "task", sessionID: partSessionID, callID,
    state: { status: "error", input: {}, error, time: { start: 1, end: 2 } },
  } } } });
}

function gateArgs(role) {
  const taskLevel = /^(?:executor|sniper|test-author)/.test(role);
  return {
    description: `dispatch ${role}`,
    prompt: taskLevel
      ? `[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT]\nDo the task.`
      : "Review the plan.",
    subagent_type: role,
  };
}

test("promise-rejection boundary records auth/credit/timeout/provider without tool.execute.after", async () => {
  for (const [failureClass, error] of [
    ["auth", "ProviderAuthError: 401 unauthorized"],
    ["credit", "APIError 402: insufficient credits"],
    ["timeout", "MessageAbortedError: deadline exceeded"],
    ["provider", "APIError 503: service unavailable"],
  ]) {
    await tempRun(false, async ({ root, state }) => {
      const hooks = await createPlannerRecoveryHooks(root);
      await before(hooks, "planner", `call-${failureClass}`);
      await rejection(hooks, `call-${failureClass}`, error);
      assert.equal(state().planner_status, "planner_unavailable");
      assert.equal(state().planner_failure_class, failureClass);
      assert.equal(state().planner_retry_outcome, "fallback_unavailable");
      assert.equal(state().delivery_status, "delivery-blocked");
      if (failureClass === "timeout") {
        const gate = await createPlanGateHooks(root);
        for (const role of ["plan-reviewer-family-1", "plan-reviewer-family-2", "test-author", "executor-low", "sniper-high"]) {
          await assert.rejects(
            () => gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, { args: gateArgs(role) }),
            /delivery-blocked/,
          );
        }
      }
    });
  }
});

test("configured fallback is claimed once and only becomes usable after a fresh matching canonical write", async () => {
  await tempRun(true, async ({ root, state, planPath }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-primary");
    await rejection(hooks, "call-primary", "deadline exceeded");
    await before(hooks, "planner-fallback", "call-fallback");
    assert.equal(state().planner_fallback_attempts, 1);
    assert.equal(state().planner_fallback_model, FALLBACK_MODEL);
    await after(hooks, "planner-fallback", "call-fallback", JSON.stringify(FULL_PLAN));
    assert.equal(state().planner_status, "plan_pending_write");

    const gate = await createPlanGateHooks(root);
    await assert.rejects(() => gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, { args: gateArgs("plan-reviewer-family-1") }), /plan_pending_write/);
    fs.writeFileSync(planPath, JSON.stringify(FULL_PLAN, null, 2));
    await gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, { args: gateArgs("plan-reviewer-family-1") });
    assert.equal(state().planner_status, "usable");
    assert.equal(state().planner_retry_outcome, "fallback_succeeded");
    assert.equal(state().planner_plan_binding.call_id, "call-fallback");
    assert.equal(state().planner_plan_binding.model, FALLBACK_MODEL);
    await assert.rejects(() => before(hooks, "planner-fallback", "call-fallback-2"), /attempt already consumed|fallback requires/);
  });
});

test("invalid or mismatched fallback config persists delivery-blocked instead of leaving fallback_pending", async () => {
  for (const variant of ["invalid-routing", "agent-mismatch"]) {
    await tempRun(true, async ({ root, state }) => {
      const routingPath = path.join(root, ".opencode", "harness.routing.json");
      const routing = JSON.parse(fs.readFileSync(routingPath, "utf8"));
      if (variant === "invalid-routing") routing.roles.planner.fallback.model = "provider/";
      fs.writeFileSync(routingPath, JSON.stringify(routing));
      if (variant === "agent-mismatch") {
        fs.writeFileSync(path.join(root, ".opencode", "agents", "planner-fallback.md"), "---\nmodel: other-provider/other-model\n---\n");
      }
      const hooks = await createPlannerRecoveryHooks(root);
      await before(hooks, "planner", `call-${variant}`);
      await rejection(hooks, `call-${variant}`, "APIError 503: unavailable");
      assert.equal(state().planner_status, "planner_unavailable", variant);
      assert.equal(state().planner_retry_outcome, "fallback_unavailable", variant);
      assert.equal(state().delivery_status, "delivery-blocked", variant);
      assert.match(state().planner_fallback_diagnostic, /provider\/model|does not match/, variant);
      await assert.rejects(() => before(hooks, "planner-fallback", `fallback-${variant}`), /delivery-blocked/);
      assert.equal(state().delivery_status, "delivery-blocked", variant);
    });
  }
});

test("old matching full plan does not release downstream until current attempt rewrites it", async () => {
  await tempRun(false, async ({ root, state, planPath }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-current");
    await after(hooks, "planner", "call-current", JSON.stringify(FULL_PLAN));
    const gate = await createPlanGateHooks(root);
    await assert.rejects(() => gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, { args: gateArgs("test-author") }), /plan_pending_write/);
    assert.equal(state().planner_plan_binding, undefined);
    fs.writeFileSync(planPath, `${JSON.stringify(FULL_PLAN)}\n`);
    await gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, { args: gateArgs("test-author") });
    assert.equal(state().planner_plan_binding.call_id, "call-current");
  }, FULL_PLAN);
});

test("content-addressed prompt snapshot survives dd/sponge overwrite, ln replacement, and background write semantics", async () => {
  await tempRun(false, async ({ root, planPath }) => {
    const recovery = await createPlannerRecoveryHooks(root);
    await before(recovery, "planner", "call-snapshot");
    await after(recovery, "planner", "call-snapshot", JSON.stringify(FULL_PLAN));
    fs.writeFileSync(planPath, JSON.stringify(FULL_PLAN, null, 2));
    const gate = await createPlanGateHooks(root);
    const firstOutput = { args: gateArgs("test-author") };
    await gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, firstOutput);
    const boundPrompt = firstOutput.args.prompt;
    assert.match(boundPrompt, /HARNESS_BOUND_PLAN/);
    assert.match(boundPrompt, /"id":"task-1"/);

    const malicious = { ...FULL_PLAN, tasks: [{ ...FULL_PLAN.tasks[0], id: "task-background" }] };
    // Direct overwrite models dd/sponge; unlink+link models ln replacement; delayed write models `&`.
    fs.writeFileSync(planPath, JSON.stringify(malicious));
    const replacement = `${planPath}.replacement`;
    fs.writeFileSync(replacement, JSON.stringify(malicious));
    fs.unlinkSync(planPath);
    fs.linkSync(replacement, planPath);
    await new Promise((resolve) => setImmediate(() => {
      fs.writeFileSync(planPath, JSON.stringify(malicious));
      resolve();
    }));

    assert.equal(firstOutput.args.prompt, boundPrompt);
    const secondOutput = { args: gateArgs("test-author") };
    await gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, secondOutput);
    assert.match(secondOutput.args.prompt, /"id":"task-1"/);
    assert.doesNotMatch(secondOutput.args.prompt, /task-background/);
  });
});

test("feature mismatch and artifact swap during locked gate decision both fail closed", async () => {
  const wrongFeaturePlan = { ...FULL_PLAN, feature_id: "other-feature" };
  await tempRun(false, async ({ root, state, planPath }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-feature");
    await after(hooks, "planner", "call-feature", JSON.stringify(wrongFeaturePlan));
    fs.writeFileSync(planPath, JSON.stringify(wrongFeaturePlan));
    const gate = await createPlanGateHooks(root);
    await assert.rejects(() => gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, { args: gateArgs("test-author") }), /plan_pending_write|bound artifact/);
    assert.notEqual(state().planner_status, "usable");
  });

  await tempRun(false, async ({ root, state, planPath }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-swap");
    await after(hooks, "planner", "call-swap", JSON.stringify(FULL_PLAN));
    fs.writeFileSync(planPath, JSON.stringify(FULL_PLAN, null, 2));
    const swapped = { ...FULL_PLAN, tasks: [{ ...FULL_PLAN.tasks[0], id: "task-swapped" }] };
    const result = reconcilePlannerStateFromDisk(root, SESSION, Date.now(), {
      beforeConfirm: () => fs.writeFileSync(planPath, JSON.stringify(swapped)),
    });
    assert.equal(result.ok, true);
    assert.equal(state().planner_status, "plan_invalid");
    assert.match(state().planner_binding_error, /changed during gate decision/);
  });
});

test("concurrent primary claims consume one attempt and delayed result cannot overwrite fallback", async () => {
  await tempRun(true, async ({ root, state }) => {
    let sequence = 0;
    const hooks = await createPlannerRecoveryHooks(root, { token: () => `token-${++sequence}` });
    const claims = await Promise.allSettled([before(hooks, "planner", "call-a"), before(hooks, "planner", "call-b")]);
    assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(state().planner_primary_attempts, 1);
    const winner = state().planner_active_attempt.call_id;
    await rejection(hooks, winner, "ProviderAuthError: unauthorized");
    await before(hooks, "planner-fallback", "call-fallback");
    await after(hooks, "planner", winner, JSON.stringify(FULL_PLAN));
    assert.equal(state().planner_active_attempt.call_id, "call-fallback");
    assert.equal(state().planner_status, "running");
  });
});

test("stub/malformed output containing provider prose is plan_invalid and never activates fallback", async () => {
  await tempRun(true, async ({ root, state }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-invalid");
    await after(hooks, "planner", "call-invalid", `${JSON.stringify({ feature_id: FEATURE, kind: "stub", mode: "FULL", tasks: [] })}\n429 provider error`);
    assert.equal(state().planner_status, "plan_invalid");
    assert.equal(state().planner_retry_outcome, "not_applicable");
    assert.equal(state().planner_fallback_attempts, undefined);
    await assert.rejects(() => before(hooks, "planner-fallback", "call-no-fallback"), /fallback requires/);
  });
});

test("non-provider task rejection is terminal planner_failed and does not activate fallback", async () => {
  await tempRun(true, async ({ root, state }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-config-error");
    await rejection(hooks, "call-config-error", "invalid subagent type");
    assert.equal(state().planner_status, "planner_failed");
    assert.equal(state().planner_retry_outcome, "not_applicable");
    assert.equal(state().delivery_status, "delivery-blocked");
    await assert.rejects(() => before(hooks, "planner-fallback", "call-forbidden"), /terminal/);
    await assert.rejects(() => before(hooks, "planner", "call-primary-forbidden"), /terminal/);
  });
});

test("official error event shape authenticates by part session + callID against active trusted claim", async () => {
  await tempRun(true, async ({ root, state }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-current");
    await rejection(hooks, "call-current", "ProviderAuthError: unauthorized", "ses_other");
    assert.equal(state().planner_status, "running");
    assert.equal(state().planner_active_attempt.call_id, "call-current");
    await rejection(hooks, "call-current", "ProviderAuthError: 401 unauthorized", SESSION);
    assert.equal(state().planner_status, "planner_unavailable");
    assert.equal(state().planner_failure_class, "auth");
  });
});

test("fallback rejection or invalid output consumes the lease and ends delivery-blocked", async () => {
  for (const [kind, finish] of [
    ["rejection", (hooks) => rejection(hooks, "call-fallback", "APIError 503: unavailable")],
    ["invalid", (hooks) => after(hooks, "planner-fallback", "call-fallback", JSON.stringify({ feature_id: FEATURE, kind: "stub", mode: "FULL", tasks: [] }))],
  ]) {
    await tempRun(true, async ({ root, state }) => {
      const hooks = await createPlannerRecoveryHooks(root);
      await before(hooks, "planner", "call-primary");
      await rejection(hooks, "call-primary", "ProviderAuthError: unauthorized");
      await before(hooks, "planner-fallback", "call-fallback");
      await finish(hooks);
      assert.equal(state().planner_retry_outcome, "fallback_failed", kind);
      assert.equal(state().delivery_status, "delivery-blocked", kind);
      await assert.rejects(() => before(hooks, "planner-fallback", "call-retry"));
      await assert.rejects(() => before(hooks, "planner", "call-primary-retry"), /terminal/);
    });
  }
});
