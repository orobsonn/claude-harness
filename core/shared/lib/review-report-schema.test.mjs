import test from "node:test";
import assert from "node:assert/strict";
import { validateReviewReport } from "./review-report-schema.mjs";

const finding = { description: "Pre-existing DELETE race, outside this change", category: "race",
  severity: "medium", scope: "src/delete.ts", evidence: "unchanged baseline function", fix_hint: "separate follow-up" };

test("optional follow-ups remain diagnostic, never sniper findings", () => {
  for (const role of ["adversary", "compliance", "security"]) {
    for (const issues of [[], [finding]]) {
      const report = { issues, follow_ups: [finding] };
      const parsed = validateReviewReport(role, report);
      assert.equal(parsed.ok, true, parsed.reason);
      assert.deepEqual(parsed.report, report);
      assert.equal(parsed.findings.length, issues.length);
    }
    assert.equal(validateReviewReport(role, { issues: [], follow_ups: "note" }).ok, false);
    assert.equal(validateReviewReport(role, { issues: [], follow_ups: [{}] }).ok, false);
    assert.deepEqual(validateReviewReport(role, { issues: [] }).report, { issues: [] });
  }
});
