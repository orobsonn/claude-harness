import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PLAN_REVIEW_AREAS,
  REVIEW_SEVERITIES,
  parseReviewReportText,
  validateReviewReport,
} from "../../../shared/lib/review-report-schema.mjs";

const role = readFileSync(new URL("./harness-plan-reviewer.md", import.meta.url), "utf8");

test("plan-reviewer documents canonical APPROVE and REVISE reports accepted by the host", () => {
  const examples = [...role.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => parseReviewReportText(match[1]));
  assert.equal(examples.length, 2);

  const reports = examples.map((example) => validateReviewReport("plan-reviewer", example));
  assert.deepEqual(reports.map((report) => report.ok), [true, true]);
  assert.deepEqual(reports.map((report) => report.report.verdict), ["APPROVE", "REVISE"]);
  assert.deepEqual(reports[0].report.findings, []);
  assert.ok(reports[1].report.findings.length > 0);
  assert.deepEqual(Object.keys(reports[1].report.findings[0]).sort(), [
    "area", "planner_instruction", "problem", "severity", "task_id",
  ]);
});

test("plan-reviewer names every canonical area and severity and requires JSON-only output", () => {
  for (const area of PLAN_REVIEW_AREAS) assert.match(role, new RegExp(`\\b${area}\\b`));
  for (const severity of REVIEW_SEVERITIES) assert.match(role, new RegExp(`\\b${severity}\\b`));
  assert.match(role, /exactly one JSON object/i);
  assert.match(role, /no Markdown fences or prose/i);
});
