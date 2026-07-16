#!/usr/bin/env node
/**
 * @description Locked tests for #361 — the hand model leaves the LLM's hands. The orchestrator no
 * longer types a model: the executor's comes from the plan's ladder, the sniper's from arithmetic
 * over the applied set. Both refuse an off-ladder id and announce every fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExecutorModel, resolveSniperModel } from "./descriptor-emitter.mjs";

const LADDER = { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" };

function planWith(tasks, hand_tiers = LADDER) {
  return { tasks, model_strategy: { hand_tiers } };
}

// ---------------------------------------------------------------------------
// executor — tier from the plan, complexity FIRST
// ---------------------------------------------------------------------------
test("#ac-3.1 executor: complexity medium resolves to hand_tiers.medium, no --model anywhere", () => {
  const r = resolveExecutorModel({
    plan: planWith([{ id: "task-1", complexity: "medium" }]),
    taskId: "task-1",
  });
  assert.equal(r.model, "glm-5.2");
  assert.equal(r.modelFallbackUsed, false);
  assert.equal(r.model_resolution.tier, "medium");
});

test("executor: complexity wins over severity (severity drives review rigor, not the hand)", () => {
  const r = resolveExecutorModel({
    plan: planWith([{ id: "task-1", complexity: "low", severity: "high" }]),
    taskId: "task-1",
  });
  assert.equal(r.model, "gemma4", "a high-severity task still runs the low-complexity hand");
  assert.equal(r.model_resolution.tier_source, "task.complexity");
});

test("executor: severity is the fallback when complexity is absent", () => {
  const r = resolveExecutorModel({
    plan: planWith([{ id: "task-1", severity: "high" }]),
    taskId: "task-1",
  });
  assert.equal(r.model, "kimi-k2.7-code");
  assert.equal(r.model_resolution.tier_source, "task.severity");
});

test("#ac-1.4 executor: a tier absent from hand_tiers falls back to glm-5.2 and STAMPS the signal", () => {
  const r = resolveExecutorModel({
    plan: planWith([{ id: "task-1", complexity: "high" }], { low: "gemma4", medium: "glm-5.2" }),
    taskId: "task-1",
  });
  assert.equal(r.model, "glm-5.2");
  assert.equal(r.modelFallbackUsed, true, "the fallback must never be silent");
  assert.equal(r.model_resolution.modelFallbackUsed, true);
});

test("executor: a plan with no model_strategy at all falls back, still announced", () => {
  const r = resolveExecutorModel({ plan: { tasks: [{ id: "task-1", complexity: "low" }] }, taskId: "task-1" });
  assert.equal(r.model, "glm-5.2");
  assert.equal(r.modelFallbackUsed, true);
});

test("#ac-1.1/#ac-1.2 executor: an off-ladder tier is refused, never laundered into the fallback", () => {
  for (const bad of ["gpt-oss:120b", "deepseek-v4-pro"]) {
    assert.throws(
      () => resolveExecutorModel({ plan: planWith([{ id: "t", complexity: "low" }], { ...LADDER, low: bad }), taskId: "t" }),
      new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("executor: a task absent from the plan is a hard error (never a guessed model)", () => {
  assert.throws(
    () => resolveExecutorModel({ plan: planWith([{ id: "task-1" }]), taskId: "task-9" }),
    /not in the execution plan/,
  );
});

// ---------------------------------------------------------------------------
// sniper — the arithmetic lives in the emitter, the inputs are persisted
// ---------------------------------------------------------------------------
test("sniper: the tier is the MAX over the applied set, never the first or the lowest", () => {
  const r = resolveSniperModel({ plan: planWith([]), severities: ["low", "high", "low"] });
  assert.equal(r.model, "kimi-k2.7-code");
  assert.equal(r.model_resolution.tier, "high");
});

test("sniper: `critical` has no rung of its own — it is the top of the ladder", () => {
  const r = resolveSniperModel({ plan: planWith([]), severities: ["critical", "low"] });
  assert.equal(r.model, "kimi-k2.7-code");
  assert.equal(r.model_resolution.tier, "high");
});

test("sniper: a gate failure is auto-high regardless of what the findings claim", () => {
  const r = resolveSniperModel({ plan: planWith([]), severities: ["low"], gateFailure: true });
  assert.equal(r.model_resolution.tier, "high");
  assert.equal(r.model_resolution.gate_failure, true);
});

test("sniper: a fail-class finding floors the tier at medium, never below", () => {
  const r = resolveSniperModel({ plan: planWith([]), severities: ["low"], failClass: true });
  assert.equal(r.model, "glm-5.2");
  assert.equal(r.model_resolution.tier, "medium");
});

test("sniper: the floor only RAISES — it never pulls a high batch down to medium", () => {
  const r = resolveSniperModel({ plan: planWith([]), severities: ["high"], failClass: true });
  assert.equal(r.model_resolution.tier, "high");
});

test("sniper: the INPUTS are persisted — the record distinguishes arithmetic from assertion", () => {
  const r = resolveSniperModel({ plan: planWith([]), severities: ["low", "medium"], failClass: true });
  assert.deepEqual(r.model_resolution.applied_severities, ["low", "medium"]);
  assert.equal(r.model_resolution.fail_class, true);
  assert.equal(r.model_resolution.gate_failure, false);
  assert.equal(r.model_resolution.role, "sniper");
});

// normalizeSeverity maps anything unrecognized to `medium`. Left unchecked, a typo'd "hgih" would
// quietly run a HIGH batch on the medium hand — the silent degradation this whole issue kills.
test("sniper: a typo'd severity is refused, never silently degraded to medium", () => {
  assert.throws(
    () => resolveSniperModel({ plan: planWith([]), severities: ["hgih"] }),
    (err) => {
      assert.match(err.message, /"hgih"/, "the error must name the offending value");
      assert.match(err.message, /low\|medium\|high\|critical/);
      return true;
    },
  );
});

test("sniper: a valid severity in any casing still resolves (the guard is not over-strict)", () => {
  assert.equal(resolveSniperModel({ plan: planWith([]), severities: ["HIGH", " low "] }).model_resolution.tier, "high");
});

test("sniper: an empty applied set is a hard error — there is nothing to resolve against", () => {
  assert.throws(() => resolveSniperModel({ plan: planWith([]), severities: [] }), /--severities is empty/);
});

test("sniper: a gate failure alone still resolves (no severities needed — it is auto-high)", () => {
  const r = resolveSniperModel({ plan: planWith([]), severities: [], gateFailure: true });
  assert.equal(r.model_resolution.tier, "high");
});

test("sniper: an off-ladder tier in the plan is refused at dispatch too", () => {
  assert.throws(
    () => resolveSniperModel({ plan: planWith([], { ...LADDER, high: "gpt-oss:120b" }), severities: ["high"] }),
    /gpt-oss:120b/,
  );
});
