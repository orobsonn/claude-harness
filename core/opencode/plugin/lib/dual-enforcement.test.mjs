/**
 * @description Locked tests for ADR-003 dual enforcement (task-3).
 * plan-gate/entry-gate throw deny on pending/missing before executor;
 * primary_only_failopen accepted but isFullDualCoverage false;
 * both allows path; bare boolean dual_completed rejected.
 * Adversarial: skip-pending, forge dual_completed, treat failopen as full dual,
 * invent secondary, leak verdict.
 * Sniper fixes: case-insensitive roles, empty subagent fail-closed, disk loaders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideDualBeforeDelivery,
  enforceDualOrThrow,
  isDeliveryHandRequiringDual,
  isFullDualCoverage,
  isTaskTool,
  extractSubagentType,
  extractHookTaskContext,
  readRequireDualOn,
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

// ---- locked: pending/missing throws deny before executor ----

test("asserts plan-gate or entry-gate throws deny when dual_status is pending before executor", () => {
  let threwPlan = false;
  try {
    enforceDualOrThrow("[plan-gate]", {
      subagentType: "executor-high",
      gateState: { dual_status: "pending" },
      routing: ROUTING,
      toolName: "task",
    });
  } catch (err) {
    threwPlan = true;
    assert.ok(err instanceof Error);
    assert.match(err.message, /^\[plan-gate\]/);
    assert.match(err.message, /pending/i);
  }
  assert.equal(threwPlan, true);

  let threwEntry = false;
  try {
    enforceDualOrThrow("[entry-gate]", {
      subagentType: "executor-medium",
      gateState: { dual_status: DUAL_STATUS.PENDING },
      routing: ROUTING,
      toolName: "task",
    });
  } catch (err) {
    threwEntry = true;
    assert.ok(err instanceof Error);
    assert.match(err.message, /^\[entry-gate\]/);
    assert.match(err.message, /pending/i);
  }
  assert.equal(threwEntry, true);
});

test("asserts plan-gate or entry-gate throws deny when dual_status is missing before executor", () => {
  let threwPlan = false;
  try {
    enforceDualOrThrow("[plan-gate]", {
      subagentType: "executor-low",
      gateState: {},
      routing: ROUTING,
      toolName: "task",
    });
  } catch (err) {
    threwPlan = true;
    assert.ok(err instanceof Error);
    assert.match(err.message, /^\[plan-gate\]/);
    assert.match(err.message, /missing|dual_status/i);
  }
  assert.equal(threwPlan, true);

  let threwEntry = false;
  try {
    enforceDualOrThrow("[entry-gate]", {
      subagentType: "sniper-high",
      gateState: { feature_id: "oc-port-phase-2" },
      routing: ROUTING,
      toolName: "task",
    });
  } catch (err) {
    threwEntry = true;
    assert.ok(err instanceof Error);
    assert.match(err.message, /^\[entry-gate\]/);
  }
  assert.equal(threwEntry, true);

  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: {},
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "deny");
  assert.equal(d.ok, false);
});

// ---- locked: primary_only_failopen allows continue; not full dual ----

test("asserts dual_status primary_only_failopen is accepted and allows continue while isFullDualCoverage returns false", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "primary_only_failopen" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.ok, true);
  assert.equal(d.details?.dual_status, "primary_only_failopen");
  assert.equal(d.details?.isFullDualCoverage, false);
  assert.equal(isFullDualCoverage("primary_only_failopen"), false);

  // enforceDualOrThrow must NOT throw on failopen
  const r = enforceDualOrThrow("[plan-gate]", {
    subagentType: "executor-high",
    gateState: { dual_status: "primary_only_failopen" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.details?.isFullDualCoverage, false);
});

// ---- locked: both allows; never dual_completed boolean ----

test("asserts dual_status both allows executor path and gate-state never stores dual_completed as bare boolean true", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "both" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.details?.isFullDualCoverage, true);
  assert.equal(isFullDualCoverage("both"), true);

  const patch = dualStatusGatePatch("both");
  assert.equal("dual_completed" in patch, false);
  assert.equal(/** @type {{ dual_status: string }} */ (patch).dual_status, "both");

  // Forged dual_completed boolean is denied even if dual_status is both
  const forged = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "both", dual_completed: true },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(forged.decision, "deny");
  assert.match(forged.reason, /dual_completed|boolean/i);

  let threwForge = false;
  try {
    enforceDualOrThrow("[entry-gate]", {
      subagentType: "executor-high",
      gateState: { dual_completed: true },
      routing: ROUTING,
      toolName: "task",
    });
  } catch (err) {
    threwForge = true;
    assert.ok(err instanceof Error);
    assert.match(err.message, /^\[entry-gate\]/);
    assert.match(err.message, /dual_completed|boolean|invalid/i);
  }
  assert.equal(threwForge, true);
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
    gateState: { dual_status: "primary_only_error" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.details?.isFullDualCoverage, false);
});

// ---- adversarial: skip dual with pending ----

test("adversarial: skip dual and proceed with pending is denied", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "pending" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "deny");
  assert.equal(d.ok, false);
});

// ---- adversarial: forge dual_completed ----

test("adversarial: forge dual_completed true boolean is denied", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_completed: true, dual_status: "both" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "deny");
});

// ---- adversarial: treat failopen as full dual ----

test("adversarial: primary_only_failopen must not count as full dual coverage", () => {
  assert.equal(isFullDualCoverage("primary_only_failopen"), false);
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: { dual_status: "primary_only_failopen" },
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
    gateState: { dual_status: "primary_only_failopen" },
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
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /pending/i);

  // Mixed-case still allows when dual_status is recorded failopen
  const fo = decideDualBeforeDelivery({
    subagentType: "Executor-High",
    gateState: { dual_status: "primary_only_failopen" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(fo.decision, "allow");
  assert.equal(fo.details?.isFullDualCoverage, false);
});

test("task tool with empty subagent_type fails closed (cannot skip dual)", () => {
  const d = decideDualBeforeDelivery({
    subagentType: "",
    gateState: { dual_status: "both" },
    routing: ROUTING,
    toolName: "task",
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /unknown-agent|missing subagent/i);

  let threw = false;
  try {
    enforceDualOrThrow("[entry-gate]", {
      subagentType: "",
      gateState: { dual_status: "both" },
      routing: ROUTING,
      toolName: "task",
    });
  } catch (err) {
    threw = true;
    assert.ok(err instanceof Error);
    assert.match(err.message, /^\[entry-gate\]/);
  }
  assert.equal(threw, true);
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

test("readRequireDualOn reads harness.routing constraints.requireDualOn", () => {
  const roles = readRequireDualOn(ROUTING);
  assert.deepEqual(roles, ["plan-reviewer", "adversary"]);
});

test("extractSubagentType and isTaskTool parse OC task args including nested input", () => {
  assert.equal(isTaskTool("task"), true);
  assert.equal(isTaskTool("bash"), false);
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
  assert.equal(extractSubagentType({ command: "executor-high" }), "executor-high");
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
        feature_id: "oc-port-phase-2",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, ".opencode", "harness.routing.json"),
      JSON.stringify(ROUTING),
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
    assert.equal(missing.ok, false);

    const allowed = enforceDualFromDiskOrThrow("[plan-gate]", {
      projectRoot: root,
      toolName: "task",
      toolArgs: { subagent_type: "executor-high", session_id: sessionId },
      sessionId,
    });
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.details?.isFullDualCoverage, false);

    let threw = false;
    try {
      enforceDualFromDiskOrThrow("[entry-gate]", {
        projectRoot: root,
        toolName: "task",
        toolArgs: { subagent_type: "executor-high" },
        sessionId: "ses_missing_xyz",
      });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
      assert.match(err.message, /\[entry-gate\].*gate-state-unreadable/i);
    }
    assert.equal(threw, true, "expected throw on missing gate-state");
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on some FS
    }
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

test("extractHookTaskContext({tool:'task',args:...}, {}) or first-arg-only wrong shape returns empty subagentType", () => {
  const ctx1 = extractHookTaskContext(
    { tool: "task", args: { subagent_type: "executor-low" } },
    {},
  );
  assert.equal(ctx1.subagentType, "");
  assert.equal(ctx1.toolName, "task");

  const ctx2 = extractHookTaskContext(
    { tool: "task", args: { subagent_type: "executor-low" } },
    null,
  );
  assert.equal(ctx2.subagentType, "");

  const ctx3 = extractHookTaskContext({ tool: "task" }, {});
  assert.equal(ctx3.subagentType, "");
});

// ---- enforceDualOrThrow entry-gate + executor-low missing (if not covered) ----
test("enforceDualOrThrow with missing dual + executor-low throws [entry-gate]", () => {
  let threw = false;
  try {
    enforceDualOrThrow("[entry-gate]", {
      subagentType: "executor-low",
      gateState: {},
      routing: ROUTING,
      toolName: "task",
    });
  } catch (err) {
    threw = true;
    assert.ok(err instanceof Error);
    assert.match(err.message, /^\[entry-gate\]/);
    assert.match(err.message, /missing|dual_status/i);
  }
  assert.equal(threw, true);
});
