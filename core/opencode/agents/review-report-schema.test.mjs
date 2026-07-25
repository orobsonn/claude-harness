/** @description Locks executable review schemas and active build-agent dual-status prose together. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateReviewReport } from "../../shared/lib/review-report-schema.mjs";

test("canonical schemas reject NOT_IN_SCHEMA enum values", () => {
  const plan = validateReviewReport("plan-reviewer", {
    verdict: "APPROVE",
    findings: [{
      area: "NOT_IN_SCHEMA",
      severity: "high",
      task_id: "task-1",
      problem: "bad enum",
      planner_instruction: "do not count",
    }],
  }, 1);
  assert.equal(plan.ok, false);

  const adversary = validateReviewReport("adversary", {
    issues: [{
      description: "bad enum",
      category: "NOT_IN_SCHEMA",
      severity: "high",
      scope: "src/file.ts",
      evidence: "fn",
      suggested_sniper_tier: "sniper-high",
      fix_hint: "src/file.ts:fn:change",
    }],
  }, 1);
  assert.equal(adversary.ok, false);
});

test("a derived tier that disagrees with severity is NORMALIZED, never a reason to lose the report", () => {
  // Live loss: a canonical adversary report with two real findings was thrown away whole because one
  // said severity high with suggested_sniper_tier sniper-medium. The tier carries no information the
  // report does not already state — asking the eye to restate it correctly only created a way to
  // lose judgment. It is now derived from severity on the way in.
  const result = validateReviewReport("adversary", {
    issues: [
      {
        description: "The vault boundary accepts ISO text for the epoch columns.",
        category: "other",
        severity: "high",
        scope: "src/db/vault.ts",
        evidence: "vault.ts:writeToTable",
        suggested_sniper_tier: "sniper-medium",
        fix_hint: "src/db/vault.ts:writeToTable:reject non-integer",
      },
      {
        description: "Residual naming drift.",
        category: "orphan-state",
        severity: "low",
        scope: "src/db/leads.ts",
        evidence: "leads.ts:update",
        suggested_sniper_tier: "sniper-high",
        fix_hint: "src/db/leads.ts:update:rename",
      },
    ],
  }, 1);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.findings[0].suggested_sniper_tier, "sniper-high", "high routes to sniper-high");
  assert.equal(result.findings[1].suggested_sniper_tier, "sniper-low", "low routes to sniper-low");
  // Severity remains the gate axis and is untouched.
  assert.equal(result.findings[0].severity, "high");
  // A genuinely broken enum still fails — the shape contract did not get looser.
  assert.equal(validateReviewReport("adversary", {
    issues: [{
      description: "bad severity",
      category: "race",
      severity: "critical",
      scope: "src/a.ts",
      evidence: "a.ts:f",
      suggested_sniper_tier: "sniper-high",
      fix_hint: "src/a.ts:f:x",
    }],
  }, 1).ok, false);
});

test("build active dual contract uses primary_only and separate secondary failure fields", () => {
  const source = fs.readFileSync(new URL("./build.md", import.meta.url), "utf8");
  assert.doesNotMatch(source, /primary_only_failopen|primary_only_error/);
  assert.match(source, /`primary_only`/);
  assert.match(source, /secondary_status/);
  assert.match(source, /secondary_failure_class/);
});
