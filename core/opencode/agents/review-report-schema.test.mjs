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

test("build active dual contract uses primary_only and separate secondary failure fields", () => {
  const source = fs.readFileSync(new URL("./build.md", import.meta.url), "utf8");
  assert.doesNotMatch(source, /primary_only_failopen|primary_only_error/);
  assert.match(source, /`primary_only`/);
  assert.match(source, /secondary_status/);
  assert.match(source, /secondary_failure_class/);
});
