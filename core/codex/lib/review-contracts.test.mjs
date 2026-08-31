import assert from "node:assert/strict";
import test from "node:test";
import { mergeVerdicts, parseReviewReportText, scoreFile, validateReviewReport } from "./review-contracts.mjs";

test("portable complexity scoring is advisory and never routes malformed or unknown work down", () => {
  assert.deepEqual(scoreFile(""), { ok: true, score: 0, band: "low", signals: { lines: 0, empty: true } });
  assert.equal(scoreFile(null).ok, false);
  const scored = scoreFile('import x from "x";\n' + "await step();\n".repeat(25), "core/codex/lib/example.mjs");
  assert.equal(scored.band, "medium");
});

test("strict review report parser accepts a bounded report and rejects an unsupported role", () => {
  const parsed = parseReviewReportText('result:\n```json\n{"issues":[]}\n```');
  assert.deepEqual(parsed, { issues: [] });
  assert.equal(validateReviewReport("adversary", parsed).ok, true);
  assert.equal(validateReviewReport("unknown", parsed).ok, false);
  assert.equal(validateReviewReport("adversary", { issues: [{ severity: "high" }] }).ok, false);
});

test("verdict merging stays conservative across one or two independently validated eyes", () => {
  assert.equal(mergeVerdicts({ verdict: "APPROVE" }, null).verdict, "APPROVE");
  assert.equal(mergeVerdicts({ verdict: "APPROVE" }, { verdict: "REVISE" }).verdict, "REVISE");
  assert.equal(mergeVerdicts(null, null).verdict, "REVISE");
  assert.equal(mergeVerdicts({ verdict: "APPROVE", issues: [null] }, null).verdict, "REVISE", "a malformed finding cannot vanish into approval");
});
