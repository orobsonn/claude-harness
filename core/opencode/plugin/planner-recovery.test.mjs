/** @description Behavioral probes for real OC before/after/error-event boundaries and canonical plan binding. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlannerRecoveryHooks } from "./planner-recovery.ts";
import { createPlanGateHooks } from "./plan-gate.ts";
import { reconcilePlannerStateFromDisk, semanticPlanHash } from "./lib/planner-artifact.mjs";
import { sealedMarkerRecord } from "./lib/marker-seal.mjs";

const SESSION = "ses_plannerRecovery01";
const FEATURE = "planner-recovery";
const FALLBACK_MODEL = "ollama-cloud/kimi-k2.7-code";
const FULL_PLAN = {
  feature_id: FEATURE,
  kind: "full",
  mode: "full",
  tasks: [{ id: "task-1", severity: "medium", complexity: "medium", scope_paths: ["src/x.ts"], criterion_refs: ["#ac-1"], depends_on: [], locked_tests: [{ id: "lt-1", path: "src/x.test.ts", assertion: "Given x, When run, Then ok" }] }],
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
    const stateFile = path.join(stateDir, "gate-state.json");
    const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
    await fn({ root, state, stateFile, planPath: path.join(planDir, "execution-plan.json") });
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
      // Primary-only: provider blip opens revision (retry primary), not model ladder.
      assert.equal(state().delivery_status, "planning_revision");
      if (failureClass === "timeout") {
        const gate = await createPlanGateHooks(root);
        for (const role of ["plan-reviewer-family-1", "plan-reviewer-family-2", "test-author", "executor-low", "sniper-high"]) {
          await assert.rejects(
            () => gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, { args: gateArgs(role) }),
            /planner_unavailable|usable|delivery-blocked|bound artifact/,
          );
        }
        // May re-dispatch primary planner
        await before(hooks, "planner", `call-${failureClass}-retry`);
        assert.equal(state().planner_status, "running");
      }
    });
  }
});

test("primary-only: planner-fallback dispatch is rejected even when routing lists fallback", async () => {
  await tempRun(true, async ({ root, state }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-primary");
    await rejection(hooks, "call-primary", "deadline exceeded");
    await assert.rejects(
      () => before(hooks, "planner-fallback", "call-fallback"),
      /fallback disabled|delivery-blocked|terminal/,
    );
    // Retry primary instead
    await before(hooks, "planner", "call-primary-2");
    assert.equal(state().planner_status, "running");
    assert.equal(state().planner_primary_attempts, 2);
  });
});

test("provider failure never arms fallback_pending (primary-only product stop/retry)", async () => {
  await tempRun(true, async ({ root, state }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-p");
    await rejection(hooks, "call-p", "APIError 503: unavailable");
    assert.equal(state().planner_status, "planner_unavailable");
    assert.notEqual(state().planner_retry_outcome, "fallback_pending");
    assert.match(String(state().planner_fallback_diagnostic ?? ""), /fallback disabled|primary/i);
  });
});

test("returning the plan it was asked to revise does not release downstream", async () => {
  // The attempt started from FULL_PLAN on disk and returned it verbatim: nothing was addressed.
  await tempRun(false, async ({ root, state }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-current");
    const output = await after(hooks, "planner", "call-current", JSON.stringify(FULL_PLAN));
    assert.equal(state().planner_status, "plan_invalid");
    assert.equal(state().planner_plan_binding, undefined);
    assert.match(output.metadata.planner_recovery, /idêntico/);
    const gate = await createPlanGateHooks(root);
    await assert.rejects(
      () => gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, { args: gateArgs("test-author") }),
      /bound artifact/,
    );
  }, FULL_PLAN);
});

test("a genuinely revised plan is authored by the plugin and releases downstream with no transcription", async () => {
  const revised = { ...FULL_PLAN, tasks: [{ ...FULL_PLAN.tasks[0], complexity: "high" }] };
  await tempRun(false, async ({ root, state, planPath }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-revised");
    await after(hooks, "planner", "call-revised", JSON.stringify(revised));
    // No orchestrator write happened between the Task returning and the plan being usable.
    assert.equal(state().planner_status, "usable");
    assert.equal(state().planner_plan_binding.call_id, "call-revised");
    assert.equal(JSON.parse(fs.readFileSync(planPath, "utf8")).tasks[0].complexity, "high");
    const gate = await createPlanGateHooks(root);
    await gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, { args: gateArgs("test-author") });
  }, FULL_PLAN);
});

test("a response carrying two distinct plans is refused and the canonical plan is untouched", async () => {
  const decoy = { ...FULL_PLAN, tasks: [{ ...FULL_PLAN.tasks[0], id: "task-decoy" }] };
  await tempRun(false, async ({ root, state, planPath }) => {
    const original = fs.readFileSync(planPath, "utf8");
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-ambiguous");
    await after(
      hooks,
      "planner",
      "call-ambiguous",
      `\`\`\`json\n${JSON.stringify(decoy)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(FULL_PLAN)}\n\`\`\``,
    );
    assert.equal(state().planner_status, "plan_invalid");
    assert.equal(fs.readFileSync(planPath, "utf8"), original);
  });
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
    // The wrong-feature plan is refused at authorship: the canonical stub is never replaced.
    const onDisk = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(onDisk.feature_id, FEATURE);
    assert.match(state().planner_binding_error, /feature_id/);
    const gate = await createPlanGateHooks(root);
    await assert.rejects(() => gate["tool.execute.before"]({ tool: "task", sessionID: SESSION }, { args: gateArgs("test-author") }), /plan_pending_write|plan_invalid|bound artifact/);
    assert.notEqual(state().planner_status, "usable");
  });

  await tempRun(false, async ({ root, state, planPath, stateFile }) => {
    // Swap during the locked bind decision: craft the pending state the plugin produces, then race it.
    fs.writeFileSync(planPath, JSON.stringify(FULL_PLAN, null, 2));
    const pending = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    fs.writeFileSync(stateFile, JSON.stringify({
      ...pending,
      planner_status: "plan_pending_write",
      planner_primary_attempts: 1,
      planner_active_attempt: {
        call_id: "call-swap",
        token: "token-swap",
        role: "planner",
        session_id: SESSION,
        feature_id: FEATURE,
        status: "plan_returned",
        returned_plan_hash: semanticPlanHash(FULL_PLAN),
        baseline_plan: { exists: false, fingerprint: "missing" },
      },
    }));
    const swapped = { ...FULL_PLAN, tasks: [{ ...FULL_PLAN.tasks[0], id: "task-swapped" }] };
    const result = reconcilePlannerStateFromDisk(root, SESSION, Date.now(), {
      beforeConfirm: () => fs.writeFileSync(planPath, JSON.stringify(swapped)),
    });
    assert.equal(result.ok, true);
    assert.equal(state().planner_status, "plan_invalid");
    assert.match(state().planner_binding_error, /changed during gate decision/);
  });
});

test("concurrent primary claims consume one attempt and delayed result cannot overwrite newer primary", async () => {
  await tempRun(false, async ({ root, state }) => {
    let sequence = 0;
    const hooks = await createPlannerRecoveryHooks(root, { token: () => `token-${++sequence}` });
    const claims = await Promise.allSettled([before(hooks, "planner", "call-a"), before(hooks, "planner", "call-b")]);
    assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(state().planner_primary_attempts, 1);
    const winner = state().planner_active_attempt.call_id;
    await rejection(hooks, winner, "ProviderAuthError: unauthorized");
    await before(hooks, "planner", "call-retry");
    await after(hooks, "planner", winner, JSON.stringify(FULL_PLAN));
    assert.equal(state().planner_active_attempt.call_id, "call-retry");
    assert.equal(state().planner_status, "running");
  });
});

test("double before on same callID is idempotent and does not deny the planner Task", async () => {
  await tempRun(false, async ({ root, state }) => {
    let sequence = 0;
    const hooks = await createPlannerRecoveryHooks(root, { token: () => `token-${++sequence}` });
    await before(hooks, "planner", "call-same");
    await before(hooks, "planner", "call-same");
    assert.equal(state().planner_primary_attempts, 1);
    assert.equal(state().planner_active_attempt.call_id, "call-same");
    assert.equal(state().planner_active_attempt.token, "token-1");
    await after(hooks, "planner", "call-same", JSON.stringify(FULL_PLAN));
    assert.equal(state().planner_status, "usable");
    // Re-entrant after-hook (OC 1.18 fires it twice) must not rewrite or rebind.
    const binding = state().planner_plan_binding;
    await after(hooks, "planner", "call-same", JSON.stringify(FULL_PLAN));
    assert.deepEqual(state().planner_plan_binding, binding);
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
    await assert.rejects(() => before(hooks, "planner-fallback", "call-no-fallback"), /fallback disabled/);
    // Primary may retry
    await before(hooks, "planner", "call-retry");
    assert.equal(state().planner_status, "running");
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

test("planner-fallback is never claimable after primary provider death", async () => {
  await tempRun(true, async ({ root, state }) => {
    const hooks = await createPlannerRecoveryHooks(root);
    await before(hooks, "planner", "call-primary");
    await rejection(hooks, "call-primary", "ProviderAuthError: unauthorized");
    await assert.rejects(() => before(hooks, "planner-fallback", "call-fallback"), /fallback disabled/);
    assert.notEqual(state().planner_retry_outcome, "fallback_pending");
  });
});

test("a dead call's claim on disk does not block a fresh dispatch, and its plan binds instead of being discarded", async () => {
  await tempRun(false, async ({ root, state, stateFile, planPath }) => {
    // Simulate a claim left behind by a process that restarted before the Task could
    // complete or fail it (no boundary event ever fires for a truly dead call).
    const pre = state();
    fs.writeFileSync(stateFile, JSON.stringify({
      ...pre,
      planner_status: "running",
      planner_primary_attempts: 1,
      planner_dispatches_total: 1,
      planner_active_attempt: {
        call_id: "dead-call",
        token: "dead-token",
        role: "planner",
        session_id: SESSION,
        feature_id: FEATURE,
        model: "openai/gpt-5.6-sol",
        started_at: 1,
        expires_at: null,
        baseline_plan: { exists: true, fingerprint: "old" },
        process_instance: "prior-process-instance",
      },
    }));
    const hooks = await createPlannerRecoveryHooks(root);
    // A fresh dispatch is not blocked by the dead claim still on disk.
    await assert.doesNotReject(() => before(hooks, "planner", "call-fresh"));
    assert.equal(state().planner_active_attempt.call_id, "call-fresh");
    // The plan for the fresh dispatch binds (accepted:true), instead of being discarded
    // the way a genuinely stale/late result correctly is.
    await after(hooks, "planner", "call-fresh", JSON.stringify(FULL_PLAN));
    assert.equal(state().planner_status, "usable");
    assert.equal(state().planner_plan_binding.call_id, "call-fresh");
    assert.equal(JSON.parse(fs.readFileSync(planPath, "utf8")).feature_id, FEATURE);
  });
});

test("chain: a spec-adversary open risk recorded by loop-guard reaches the planner's PROMPT", async () => {
  // Three links were tested separately (the snapshot write, the brief render, the nonce wiring) but
  // never composed. This is the mechanism that keeps an ACCEPTED risk alive; if the chain breaks
  // anywhere, accepting a risk silently means losing it.
  await tempRun(false, async ({ root, stateFile }) => {
    const { createLoopGuardHooks } = await import("./loop-guard.ts");
    const loop = await createLoopGuardHooks(root);
    // The spec pass runs BEFORE the ceremony marker is stamped.
    const pre = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    fs.writeFileSync(stateFile, JSON.stringify({ ...pre, adversary_fired: false }));
    const advInput = { tool: "task", sessionID: SESSION, callID: "chain-adv" };
    const advOutput = {
      args: { description: "Attack the spec", prompt: "Attack the spec.", subagent_type: "adversary-family-1" },
      output: JSON.stringify({ issues: [{
        description: "The vault boundary accepts ISO text for the epoch columns.",
        category: "boundary",
        severity: "high",
        scope: "src/db/vault.ts",
        evidence: "vault.ts:writeToTable",
        suggested_sniper_tier: "sniper-high",
        fix_hint: "src/db/vault.ts:writeToTable:reject non-integer timestamps",
      }] }),
    };
    await loop["tool.execute.before"](advInput, advOutput);
    await loop["tool.execute.after"](advInput, advOutput);
    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(persisted.spec_adversary_open_risks[0].scope, "src/db/vault.ts");

    // The operator accepted the pass; the marker is stamped and the planner is dispatched.
    fs.writeFileSync(stateFile, JSON.stringify({ ...persisted, adversary_fired: true }));
    const hooks = await createPlannerRecoveryHooks(root);
    const args = { description: "dispatch planner", prompt: "Produce the plan.", subagent_type: "planner" };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: SESSION, callID: "chain-planner" }, { args });

    assert.match(args.prompt, /\[HARNESS_SESSION_FEATURE_ID\]planner-recovery\[\/HARNESS_SESSION_FEATURE_ID\]/);
    assert.match(args.prompt, /BEGIN UNTRUSTED SPEC-ADVERSARY OPEN RISKS/);
    assert.match(args.prompt, /- \[high\] scope=src\/db\/vault\.ts The vault boundary accepts ISO text/);
    assert.match(args.prompt, /never silently dropped/);
  });
});
