/** @description Locks executable review schemas without dual-family markers. */
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
  });
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
  });
  assert.equal(adversary.ok, false);
});

test("a derived tier that disagrees with severity is NORMALIZED, never a reason to lose the report", () => {
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
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.findings[0].suggested_sniper_tier, "sniper-high", "high routes to sniper-high");
  assert.equal(result.findings[1].suggested_sniper_tier, "sniper-low", "low routes to sniper-low");
  assert.equal(result.findings[0].severity, "high");
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
  }).ok, false);
});

test("legacy family marker on a report is ignored, never required", () => {
  const plan = validateReviewReport("plan-reviewer", {
    verdict: "APPROVE",
    family: "family-2",
    findings: [],
  });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(Object.hasOwn(plan.report, "family"), false);

  const adversary = validateReviewReport("adversary", {
    family: "family-2",
    issues: [],
  });
  assert.equal(adversary.ok, true, adversary.reason);
  assert.equal(Object.hasOwn(adversary.report, "family"), false);
});

test("build contract keeps optional eyes advisory and primary-authoritative", () => {
  const source = fs.readFileSync(new URL("./build.md", import.meta.url), "utf8");
  assert.match(source, /optional second eye/i);
  assert.match(source, /primary result remains authoritative/i);
  assert.doesNotMatch(source, /dual_status|dual-runtime|secondary_failure_class/);
  assert.match(source, /primary verdict advances normally without blocking/i);
  assert.match(source, /evidence.*file:function/i);
});
