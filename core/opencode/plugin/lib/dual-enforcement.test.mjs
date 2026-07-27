/**
 * @description Locked tests for ADR-003 dual classification (task-3, record-only per #483).
 * decideDualBeforeDelivery/enforceDualOrThrow/enforceDualFromDiskOrThrow never deny a delivery
 * hand anymore — pending/missing/invalid dual_status, a non-APPROVE plan_verdict, a forged
 * dual_completed boolean, and an unreadable/corrupt gate-state all resolve to "allow"
 * (#ac-1.1, #ac-1.3). `details` still reports the classification (dual_status/plan_verdict/
 * isFullDualCoverage) for observability; the actual recording of dual_status/plan_verdict is a
 * separate writer path (dual-merge.mjs/dual-nudge.mjs, #ac-1.2) untouched by this change.
 * Sniper fixes retained: case-insensitive roles, disk loaders, session-id ceremony binding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideDualBeforeDelivery,
  enforceDualOrThrow,
  isDeliveryHandRequiringDual,
  isFullDualCoverage,
  isRecordedDualAttempt,
  isTaskTool,
  extractSubagentType,
  extractHookTaskContext,
  readRequireDualOn,
  readPlanVerdict,
  readDualStatus,
  dualStatusGatePatch,
  loadGateStateFromDisk,
  loadRoutingFromDisk,
  enforceDualFromDiskOrThrow,
  isSafeSessionIdSegment,
  DUAL_STATUS,
} from "./dual-enforcement.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROUTING = {
  constraints: {
    requireDualOn: ["plan-reviewer", "adversary"],
  },
};
const DEFAULT_ROUTING = JSON.parse(
  fs.readFileSync(new URL("../../harness.routing.json", import.meta.url), "utf8"),
);

function asLegacyRouting(routing) {
  const legacy = structuredClone(routing);
  legacy.version = 1;
  legacy.roles.build.model = "xai/grok-4.3";
  legacy.roles.planner.model = "xai/grok-4.5";
  legacy.roles["test-author"].model = "xai/grok-build-0.1";
  legacy.modelCapabilities["xai/grok-4.3"] = { supportsReasoningEffort: true };
  legacy.modelCapabilities["xai/grok-4.5"] = { supportsReasoningEffort: true };
  legacy.modelCapabilities["xai/grok-build-0.1"] = { supportsReasoningEffort: false };
  for (const role of ["plan-reviewer", "adversary"]) {
    const primary = { ...legacy.roles[role].families["family-1"] };
    const secondary = { ...legacy.roles[role].families["family-2"] };
    delete primary.primary;
    delete primary.optional;
    delete primary.countsLoop;
    delete secondary.primary;
    delete secondary.optional;
    delete secondary.countsLoop;
    primary.model = "xai/grok-4.5";
    legacy.roles[role] = { ...primary, dual: [secondary] };
  }
  return legacy;
}

// ---- record-only: pending/missing no longer deny before executor (#483) ----

test("dual_status pending before executor is record-only — plan-gate and entry-gate both allow, not deny (#ac-1.1)", () => {
  const plan = enforceDualOrThrow("[plan-gate]", {
    subagentType: "executor-high",
    gateState: { dual_status: "pending" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.decision, "allow");
  assert.match(plan.reason, /pending/i);

  const entry = enforceDualOrThrow("[entry-gate]", {
    subagentType: "executor-medium",
    gateState: { dual_status: DUAL_STATUS.PENDING },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(entry.ok, true);
  assert.equal(entry.decision, "allow");
  assert.match(entry.reason, /pending/i);
});

test("dual_status missing before executor is record-only — plan-gate and entry-gate both allow, not deny (#ac-1.1)", () => {
  const plan = enforceDualOrThrow("[plan-gate]", {
    subagentType: "executor-low",
    gateState: {},
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.decision, "allow");
  assert.match(plan.reason, /missing|dual_status/i);

  const entry = enforceDualOrThrow("[entry-gate]", {
    subagentType: "sniper-high",
    gateState: { feature_id: "oc-port-phase-2" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(entry.ok, true);
  assert.equal(entry.decision, "allow");

  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: {},
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.ok, true);
});

// ---- locked: primary_only_failopen allows continue; not full dual ----

test("asserts dual_status primary_only_failopen is accepted and allows continue while isFullDualCoverage returns false", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "primary_only_failopen", plan_verdict: "APPROVE" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.ok, true);
  assert.equal(d.details?.dual_status, "primary_only_failopen");
  assert.equal(d.details?.isFullDualCoverage, false);
  assert.equal(isFullDualCoverage("primary_only_failopen"), false);

  // enforceDualOrThrow never throws (record-only, #483) — verified explicitly here too
  const r = enforceDualOrThrow("[plan-gate]", {
    subagentType: "executor-high",
    gateState: { dual_status: "primary_only_failopen", plan_verdict: "APPROVE" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.details?.isFullDualCoverage, false);
});

// ---- locked: both allows; never dual_completed boolean ----

test("asserts dual_status both allows executor path, and a forged dual_completed boolean is record-only — flagged in `reason`, never denied (#483)", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "both", plan_verdict: "APPROVE" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.details?.isFullDualCoverage, true);
  assert.equal(isFullDualCoverage("both"), true);

  const patch = dualStatusGatePatch("both");
  assert.equal("dual_completed" in patch, false);
  assert.equal(/** @type {{ dual_status: string }} */ (patch).dual_status, "both");

  // Forged dual_completed boolean is flagged in `reason` but no longer denies dispatch,
  // even if dual_status is otherwise both.
  const forged = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "both", dual_completed: true },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(forged.ok, true);
  assert.equal(forged.decision, "allow");
  assert.match(forged.reason, /dual_completed|boolean/i);

  const entryForged = enforceDualOrThrow("[entry-gate]", {
    subagentType: "executor-high",
    gateState: { dual_completed: true },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(entryForged.ok, true);
  assert.equal(entryForged.decision, "allow");
  assert.match(entryForged.reason, /dual_completed|boolean|invalid/i);
});

// ---- locked: dualStatusGatePatch rejects bare boolean / unknown ----

test("asserts dualStatusGatePatch or gate shape validation rejects bare boolean true and unknown dual_status strings", () => {
  const bad = dualStatusGatePatch(/** @type {any} */ (true));
  assert.equal(bad.ok, false);
  assert.match(String(bad.reason), /boolean|invalid/i);

  const unknown = dualStatusGatePatch("completed");
  assert.equal(unknown.ok, false);

  const ok = dualStatusGatePatch("primary_only_error");
  assert.equal(
    /** @type {{ dual_status: string }} */ (ok).dual_status,
    "primary_only_error",
  );
});

// ---- primary_only_error allows continue ----

test("primary_only_error allows executor continue and is not full dual coverage", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-medium",
    gateState: { dual_status: "primary_only_error", plan_verdict: "APPROVE" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.details?.isFullDualCoverage, false);
});

// ---- adversarial: dual_status pending no longer blocks dispatch (#483) ----

test("adversarial: dual_status pending is record-only — allow, not deny (#483)", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "pending" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.ok, true);
});

// ---- adversarial: forged dual_completed is flagged, not denied ----

test("adversarial: forged dual_completed true boolean is record-only — allow, flagged in reason (#483)", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_completed: true, dual_status: "both" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.match(d.reason, /dual_completed|boolean/i);
});

// ---- adversarial: treat failopen as full dual ----

test("adversarial: primary_only_failopen must not count as full dual coverage", () => {
  assert.equal(isFullDualCoverage("primary_only_failopen"), false);
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "primary_only_failopen", plan_verdict: "APPROVE" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.details?.isFullDualCoverage, false);
  // Still allows continue (fail-open path when OpenAI unavailable)
  assert.equal(d.decision, "allow");
});

// ---- adversarial: invent secondary findings / leak verdict ----
// Gate is pure decision — it never invents findings or carries secondary verdicts.

test("adversarial: dual enforcement never invents secondary findings or leaks secondary verdicts", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "primary_only_failopen", plan_verdict: "APPROVE" },
    routing: ROUTING,
    toolName: "task",
  });
  // Decision object has no findings array and no secondary_verdict field
  assert.equal("findings" in d, false);
  assert.equal("secondary_verdict" in d, false);
  assert.equal("secondaryFindings" in d, false);
  assert.equal(d.details?.isFullDualCoverage, false);
  // reason must not claim secondary ran
  assert.ok(!/secondary findings|invent/i.test(d.reason));
});

// ---- helpers ----

test("isDeliveryHandRequiringDual matches executor/sniper tiers only", () => {
  assert.equal(isDeliveryHandRequiringDual("executor-high"), true);
  assert.equal(isDeliveryHandRequiringDual("executor-low"), true);
  assert.equal(isDeliveryHandRequiringDual("sniper-medium"), true);
  assert.equal(isDeliveryHandRequiringDual("executor-high-spawn"), true);
  assert.equal(isDeliveryHandRequiringDual("test-author"), false);
  assert.equal(isDeliveryHandRequiringDual("plan-reviewer"), false);
  assert.equal(isDeliveryHandRequiringDual("adversary"), false);
  assert.equal(isDeliveryHandRequiringDual("planner"), false);
  assert.equal(isDeliveryHandRequiringDual(""), false);
});

test("isDeliveryHandRequiringDual is case-insensitive — Executor-High requires dual", () => {
  assert.equal(isDeliveryHandRequiringDual("Executor-High"), true);
  assert.equal(isDeliveryHandRequiringDual("EXECUTOR-HIGH"), true);
  assert.equal(isDeliveryHandRequiringDual("Sniper-Medium"), true);
  assert.equal(isDeliveryHandRequiringDual("harness:Executor-High"), true);

  const d = decideDualBeforeDelivery({
    subagentType: "Executor-High",
    gateState: { dual_status: "pending" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.match(d.reason, /pending/i);

  // Mixed-case still allows when dual_status is recorded failopen
  const fo = decideDualBeforeDelivery({
    subagentType: "Executor-High",
    gateState: { dual_status: "primary_only_failopen", plan_verdict: "APPROVE" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(fo.decision, "allow");
  assert.equal(fo.details?.isFullDualCoverage, false);
});

test("task tool with empty subagent_type is not a delivery hand — allow; dual no longer special-cases it as a bypass attempt (#483)", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "",
    gateState: { dual_status: "both" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "not-a-delivery-hand");

  const r = enforceDualOrThrow("[entry-gate]", {
    subagentType: "",
    gateState: { dual_status: "both" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(r.decision, "allow");
});

test("non-delivery hands allow without dual_status", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "plan-reviewer",
    gateState: {},
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "not-a-delivery-hand");
});

// ---- #375 plan_verdict gates executor (money-preflight) ----

test("REVISE + dual_status both → record-only allow (#483 supersedes the old money-preflight deny; discipline is prose+orchestration now)", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "both", plan_verdict: "REVISE" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.ok, true);
  assert.match(d.reason, /REVISE/);
  assert.equal(d.details?.plan_verdict, "REVISE");
  assert.equal(d.details?.dual_status, "both");
});

test("APPROVE + dual_status both → allow executor", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "both", plan_verdict: "APPROVE" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.ok, true);
  assert.equal(d.details?.plan_verdict, "APPROVE");
});

// ---- #383 dual_status per-phase ----

test("#383 plan_review dual both + adversary missing → executor ALLOW if plan_verdict APPROVE", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: {
      dual_status: { plan_review: "both" },
      plan_verdict: "APPROVE",
    },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.ok, true);
  assert.equal(d.details?.dual_status, "both");
  assert.equal(d.details?.plan_verdict, "APPROVE");
});

test("#383 plan_review dual both does NOT satisfy adversary axis (fail-closed)", () => {
  const gs = { dual_status: { plan_review: "both" }, plan_verdict: "APPROVE" };
  assert.equal(readDualStatus(gs, "plan_review"), "both");
  assert.equal(readDualStatus(gs, "adversary"), undefined);
  assert.equal(isRecordedDualAttempt(readDualStatus(gs, "adversary")), false);

  // Legacy scalar also does not invent adversary coverage.
  const legacy = { dual_status: "both", plan_verdict: "APPROVE" };
  assert.equal(readDualStatus(legacy, "plan_review"), "both");
  assert.equal(readDualStatus(legacy, "adversary"), undefined);
});

test("#383 adversary dual both alone does not read as plan_review coverage, but no longer blocks executor either (#483)", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: {
      dual_status: { adversary: "both" },
      plan_verdict: "APPROVE",
    },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.match(d.reason, /dual_status|missing|plan_review/i);
});

test("#383 legacy scalar dual_status both + plan_verdict APPROVE still allows executor", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "both", plan_verdict: "APPROVE" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(readDualStatus({ dual_status: "both" }, "plan_review"), "both");
});

test("dual both without plan_verdict → record-only allow (#483); plan_verdict still reported as missing", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "both" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.ok, true);
  assert.match(d.reason, /plan_verdict missing/i);
  assert.equal(d.details?.plan_verdict, null);
  assert.equal(readPlanVerdict({ dual_status: "both" }), undefined);
  assert.equal(readPlanVerdict({ plan_verdict: "APPROVE" }), "APPROVE");
  assert.equal(readPlanVerdict({ plan_verdict: "REVISE" }), "REVISE");
});

test("readRequireDualOn reads harness.routing constraints.requireDualOn", () => {
  const roles = readRequireDualOn(ROUTING);
  assert.deepEqual(roles, ["plan-reviewer", "adversary"]);
});

test("extractSubagentType and isTaskTool parse OC task args including nested input", () => {
  assert.equal(isTaskTool("task"), true);
  assert.equal(isTaskTool("agent"), true);
  assert.equal(isTaskTool("foo.task"), true);
  assert.equal(isTaskTool("foo.agent"), true);
  assert.equal(isTaskTool("Task"), true);
  assert.equal(isTaskTool("bash"), false);
  assert.equal(isTaskTool("my_task"), false);
  assert.equal(
    extractSubagentType({ subagent_type: "executor-high" }),
    "executor-high",
  );
  assert.equal(
    extractSubagentType({ input: { subagent_type: "sniper-low" } }),
    "sniper-low",
  );
  assert.equal(
    extractSubagentType({ subagent: "executor-medium" }),
    "executor-medium",
  );
  // Official Task `command` is resume/host field — never harness role.
  assert.equal(extractSubagentType({ command: "executor-high" }), "");
  assert.equal(
    extractSubagentType({
      subagent_type: "plan-reviewer-family-1",
      command: "resume-or-skill-command",
      task_id: "official-resume-id",
    }),
    "plan-reviewer-family-1",
  );
});

test("loadGateStateFromDisk and loadRoutingFromDisk read real files under project root", () => {
  assert.equal(isSafeSessionIdSegment("ses_testDual123"), true);
  assert.equal(isSafeSessionIdSegment("../evil"), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-enf-disk-"));
  try {
    const sessionId = "ses_testDual123";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        dual_status: "primary_only_failopen",
        plan_verdict: "APPROVE",
        feature_id: "oc-port-phase-2",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, ".opencode", "harness.routing.json"),
      JSON.stringify(DEFAULT_ROUTING),
      "utf8",
    );

    const gsScan = loadGateStateFromDisk(root, {});
    assert.equal(gsScan.ok, false, "missing sessionId must fail-closed");

    const gs = loadGateStateFromDisk(root, { sessionId });
    assert.equal(gs.ok, true, !gs.ok ? String(gs.reason) : "session ok");
    if (gs.ok) {
      assert.equal(
        /** @type {{ dual_status: string }} */ (gs.state).dual_status,
        "primary_only_failopen",
      );
    }

    const rt = loadRoutingFromDisk(root);
    assert.equal(rt.ok, true, !rt.ok ? String(rt.reason) : "routing ok");

    const missing = loadGateStateFromDisk(root, {
      sessionId: "ses_doesNotExist999",
    });
    // Missing file = empty ceremony state (not infra unreadable)
    assert.equal(missing.ok, true);
    assert.deepEqual(missing.state, {});

    const allowed = enforceDualFromDiskOrThrow("[plan-gate]", {
      projectRoot: root,
      toolName: "task",
      toolArgs: { subagent_type: "executor-high", session_id: sessionId },
      sessionId,
    });
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.details?.isFullDualCoverage, false);

    const allowedMissing = enforceDualFromDiskOrThrow("[entry-gate]", {
      projectRoot: root,
      toolName: "task",
      toolArgs: { subagent_type: "executor-high" },
      sessionId: "ses_missing_xyz",
    });
    // Empty missing gate-state → dual_status missing — record-only allow, not a throw (#483).
    assert.equal(allowedMissing.decision, "allow");
    assert.match(allowedMissing.reason, /dual_status|missing/i);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on some FS
    }
  }
});

test("loadRoutingFromDisk adapts v1 and warns exactly once per path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "routing-v1-"));
  const warnings = [];
  const originalWarn = console.warn;
  try {
    fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".opencode", "harness.routing.json"),
      JSON.stringify(asLegacyRouting(DEFAULT_ROUTING)),
    );
    console.warn = (message) => warnings.push(message);
    const first = loadRoutingFromDisk(root);
    const second = loadRoutingFromDisk(root);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.routing.version, 2);
    assert.equal(first.routing.roles.adversary.families["family-1"].primary, true);
    assert.equal(first.routing.roles.adversary.families["family-1"].model, "openai/gpt-5.6-sol");
    assert.equal(first.routing.roles.build.model, "openai/gpt-5.6-sol");
    assert.equal(first.routing.roles["test-author"].model, "ollama-cloud/glm-5.2");
    assert.equal(Object.keys(first.routing.modelCapabilities).some((model) => model.startsWith("xai/grok")), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /routing v1 compatibility adapter used/);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- extractHookTaskContext (OC hook shape: input.tool + output.args) ----

test("extractHookTaskContext({tool:'task',sessionID:'ses_x'},{args:{subagent_type:'executor-low'}}) returns toolName, subagentType, sessionId", () => {
  const ctx = extractHookTaskContext(
    { tool: "task", sessionID: "ses_x" },
    { args: { subagent_type: "executor-low" } },
  );
  assert.equal(ctx.toolName, "task");
  assert.equal(ctx.subagentType, "executor-low");
  assert.equal(ctx.sessionId, "ses_x");
  assert.deepEqual(ctx.toolArgs, { subagent_type: "executor-low" });
});

test("extractHookTaskContext belt-reads input.args when output.args missing", () => {
  const ctx1 = extractHookTaskContext(
    { tool: "task", args: { subagent_type: "executor-low" } },
    {},
  );
  assert.equal(ctx1.subagentType, "executor-low");
  assert.equal(ctx1.toolName, "task");

  const ctx2 = extractHookTaskContext(
    { tool: "task", args: { subagent_type: "adversary" } },
    null,
  );
  assert.equal(ctx2.subagentType, "adversary");

  const ctx3 = extractHookTaskContext({ tool: "task" }, {});
  assert.equal(ctx3.subagentType, "");
});

test("loadGateStateFromDisk / loadRoutingFromDisk fall back to cwd when projectRoot empty", () => {
  const routing = loadRoutingFromDisk("");
  // cwd is this repo during tests — routing file may or may not exist under cwd;
  // critical: never fail with projectRoot missing when cwd is available.
  assert.notEqual(routing.ok === false && routing.reason === "projectRoot missing", true);
  if (!routing.ok) {
    assert.equal(/projectRoot missing/.test(routing.reason), false);
  }

  const gate = loadGateStateFromDisk("", { sessionId: "ses_testfallback01" });
  assert.notEqual(gate.ok === false && gate.reason === "projectRoot missing", true);
  if (!gate.ok) {
    assert.equal(/projectRoot missing/.test(gate.reason), false);
  }
});

// ---- enforceDualOrThrow entry-gate + executor-low missing (record-only, #483) ----
test("enforceDualOrThrow with missing dual + executor-low is record-only allow, never a throw", () => {
  const r = enforceDualOrThrow("[entry-gate]", {
    subagentType: "executor-low",
    gateState: {},
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(r.ok, true);
  assert.equal(r.decision, "allow");
  assert.match(r.reason, /missing|dual_status/i);
});

// ---- task-1 locked tests: sessionId ceremony for load / extract / dual bind (no toolArgs rebind) ----

test("lt-load-missing-sessionid — loadGateStateFromDisk without sessionId / null / empty → ok===false, reason matches /sessionId/", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-lt-missing-sid-"));
  try {
    const r1 = loadGateStateFromDisk(root);
    assert.equal(r1.ok, false);
    assert.match(String(r1.reason || ""), /sessionId/);

    const r2 = loadGateStateFromDisk(root, {});
    assert.equal(r2.ok, false);
    assert.match(String(r2.reason || ""), /sessionId/);

    const r3 = loadGateStateFromDisk(root, { sessionId: null });
    assert.equal(r3.ok, false);
    assert.match(String(r3.reason || ""), /sessionId/);

    const r4 = loadGateStateFromDisk(root, { sessionId: "" });
    assert.equal(r4.ok, false);
    assert.match(String(r4.reason || ""), /sessionId/);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
});

test("lt-load-unsafe-sessionid — unsafe sessionId like '../evil' → ok===false, reason matches /sessionId/ (contiguous token — current code says \"unsafe session id\" with space and WILL FAIL until production fix)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-lt-unsafe-sid-"));
  try {
    const r = loadGateStateFromDisk(root, { sessionId: "../evil" });
    assert.equal(r.ok, false);
    assert.match(String(r.reason || ""), /sessionId/);

    assert.equal(isSafeSessionIdSegment("../evil"), false);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
});

test("lt-load-missing-file-empty-ceremony — safe S1 no file → ok===true, state {}", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-lt-missingfile-"));
  try {
    const S1 = "ses_safeNoFile123";
    // intentionally do not create dir or gate-state.json
    const r = loadGateStateFromDisk(root, { sessionId: S1 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.state, {});
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
});

test("lt-extract-hook-sessionid-alias — extractHookTaskContext accepts sessionId camelCase AND sessionID; toolArgs.session_id alone does NOT set sessionId from extractHookTaskContext", () => {
  const ctxUpper = extractHookTaskContext(
    { tool: "task", sessionID: "ses_upperID" },
    { args: { subagent_type: "executor-low" } },
  );
  assert.equal(ctxUpper.sessionId, "ses_upperID");

  const ctxCamel = extractHookTaskContext(
    { tool: "task", sessionId: "ses_camelId" },
    { args: { subagent_type: "executor-low" } },
  );
  assert.equal(ctxCamel.sessionId, "ses_camelId");

  // toolArgs must never populate sessionId in this extractor (hook input only)
  const ctxArgs = extractHookTaskContext(
    { tool: "task" },
    { args: { session_id: "ses_fromToolArgsOnly" } },
  );
  assert.equal(ctxArgs.sessionId, null);
  assert.equal(ctxArgs.toolName, "task");
});

test("lt-dual-caller-bind-no-toolargs-rebind — enforceDualFromDiskOrThrow always allows now (#483), but still classifies against the CALLER's sessionId (S1), never rebinding to toolArgs.session_id (S2). When sessionId is explicitly null (unbound), gate-state load fails closed on sessionId (a separate, still-enforced identity concern) — shadow-recorded and classified against an empty state, never S2's favorable one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-lt-callerbind-"));
  try {
    const S1 = "ses_S1_incomplete";
    const S2 = "ses_S2_fullDual";

    // S1: incomplete (pending)
    const d1 = path.join(root, ".opencode", "plans", ".state", S1);
    fs.mkdirSync(d1, { recursive: true });
    fs.writeFileSync(
      path.join(d1, "gate-state.json"),
      JSON.stringify({ dual_status: "pending", feature_id: "oc-sid-ceremony" }),
      "utf8",
    );

    // S2: full dual
    const d2 = path.join(root, ".opencode", "plans", ".state", S2);
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(
      path.join(d2, "gate-state.json"),
      JSON.stringify({ dual_status: "both", plan_verdict: "APPROVE", feature_id: "oc-sid-ceremony" }),
      "utf8",
    );

    // ensure routing present (defaults would also enforce but explicit)
    fs.writeFileSync(
      path.join(root, ".opencode", "harness.routing.json"),
      JSON.stringify(ROUTING),
      "utf8",
    );

    // Subcase A: explicit caller sessionId S1 must win over toolArgs S2 — classification
    // reflects S1 (pending), never S2 (both/APPROVE), even though both now allow (#483).
    const a = enforceDualFromDiskOrThrow("[plan-gate]", {
      projectRoot: root,
      toolName: "task",
      toolArgs: { subagent_type: "executor-high", session_id: S2 },
      sessionId: S1,
    });
    assert.equal(a.ok, true);
    assert.equal(a.decision, "allow");
    assert.equal(a.details?.dual_status, "pending");

    // Subcase B: explicit sessionId: null (unbound) must NOT fall back to toolArgs S2 either.
    // sessionId resolution is a separate identity concern from dual/plan_verdict — it still
    // fails closed on disk load, but that failure is shadow-recorded (not thrown) and
    // classification proceeds against an empty state, never S2's.
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    let b;
    try {
      b = enforceDualFromDiskOrThrow("[entry-gate]", {
        projectRoot: root,
        toolName: "task",
        toolArgs: { subagent_type: "executor-high", session_id: S2 },
        sessionId: null,
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(b.ok, true);
    assert.equal(b.decision, "allow");
    assert.equal(b.details?.dual_status, null);
    assert.ok(
      warnings.some(
        (w) => /gate-state-unreadable/.test(String(w)) && /sessionId/i.test(String(w)),
      ),
      `expected a gate-state-unreadable shadow-record log mentioning sessionId, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on some FS
    }
  }
});
