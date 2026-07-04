#!/usr/bin/env node
/**
 * @description Locked unit tests for resolveEyeTier() — the deterministic per-dispatch
 * tier resolver for a per-task judgment eye (Change 1: process-eye-routing).
 *
 * Invariants pinned (the FULL invariant, not a happy path):
 *   - boundary gate      -> opus (always, regardless of severity/sensitivePath)
 *   - sensitive-path task -> opus (grave by construction)
 *   - severity high       -> opus (blast radius is the primary axis)
 *   - otherwise           -> sonnet  (NEVER haiku — the sonnet floor, SKILL.md:62)
 *   - never a non-Claude / Ollama tier
 * Tests run under node:test.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveEyeTier } from "./eye-tier.mjs";

const CLAUDE_TIERS = new Set(["opus", "sonnet", "haiku"]);

// ─── boundary always opus ───────────────────────────────────────────────────
test("boundary=true -> opus regardless of severity/sensitivePath", () => {
  assert.equal(resolveEyeTier({ boundary: true, severity: "low", sensitivePath: false }), "opus");
  assert.equal(resolveEyeTier({ boundary: true, severity: "medium", sensitivePath: false }), "opus");
  assert.equal(resolveEyeTier({ boundary: true, severity: "high", sensitivePath: true }), "opus");
});

// ─── sensitive path -> opus ───────────────────────────────────────────────────
test("sensitivePath=true (severity not high) -> opus", () => {
  assert.equal(resolveEyeTier({ boundary: false, severity: "low", sensitivePath: true }), "opus");
  assert.equal(resolveEyeTier({ boundary: false, severity: "medium", sensitivePath: true }), "opus");
});

// ─── severity high -> opus ────────────────────────────────────────────────────
test("severity=high (non-boundary, non-sensitive) -> opus", () => {
  assert.equal(resolveEyeTier({ boundary: false, severity: "high", sensitivePath: false }), "opus");
});

// ─── the sonnet floor (never haiku) ──────────────────────────────────────────
test("severity medium/low, non-grave, non-boundary -> sonnet (never haiku, never Ollama)", () => {
  for (const severity of ["medium", "low"]) {
    const tier = resolveEyeTier({ boundary: false, severity, sensitivePath: false });
    assert.equal(tier, "sonnet", `${severity} non-grave must resolve to sonnet, got ${tier}`);
    assert.notEqual(tier, "haiku", "an eye must never fall below sonnet");
    assert(CLAUDE_TIERS.has(tier), `tier must be a Claude tier, got ${tier}`);
  }
});

// ─── output is always a Claude tier (never a non-Claude/Ollama id) ───────────
test("every resolution is a Claude tier — never a non-Claude/Ollama model id", () => {
  const combos = [];
  for (const boundary of [true, false]) {
    for (const sensitivePath of [true, false]) {
      for (const severity of ["low", "medium", "high"]) {
        combos.push({ boundary, sensitivePath, severity });
      }
    }
  }
  for (const c of combos) {
    const tier = resolveEyeTier(c);
    assert(CLAUDE_TIERS.has(tier), `resolveEyeTier(${JSON.stringify(c)}) => ${tier} is not a Claude tier`);
  }
});

// ─── defensive default: missing/unknown severity is non-grave -> sonnet floor ─
test("missing/unknown severity defaults to the sonnet floor (never below sonnet)", () => {
  assert.equal(resolveEyeTier({ boundary: false, sensitivePath: false }), "sonnet");
  assert.equal(resolveEyeTier({ boundary: false, severity: "bogus", sensitivePath: false }), "sonnet");
});

// ─── severity is normalized: casing/whitespace never misroutes GRAVE -> sonnet ──
test("severity high is normalized (High/HIGH/' high ') -> opus (never misroute grave down)", () => {
  for (const variant of ["High", "HIGH", " high", "high ", "  HiGh  "]) {
    assert.equal(
      resolveEyeTier({ boundary: false, sensitivePath: false, severity: variant }),
      "opus",
      `severity '${variant}' must normalize to opus (grave), not fall through to sonnet`
    );
  }
});
