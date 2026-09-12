import assert from "node:assert/strict";
import test from "node:test";
import { parseTestReviewVerdict } from "./test-review-verdict.mjs";

for (const verdict of ["APPROVE", "REVISE", "BLOCKED"]) {
  test(`accepts consistent ${verdict} at both reviewer body boundaries`, () => {
    const body = `Verdict: ${verdict}\n\nEvidence for the task.\n\nVerdict: ${verdict}`;
    for (const source of [body, `Agent completed in 42.0s (4 tool uses).\nAgent ID: reviewer\n\n${body}`]) {
      assert.equal(parseTestReviewVerdict(source)?.verdict, verdict);
    }
  });
}

test("preserves exact single-boundary verdicts", () => {
  for (const verdict of ["APPROVE", "REVISE", "BLOCKED"]) {
    assert.equal(parseTestReviewVerdict(`Verdict: ${verdict}\nEvidence`)?.verdict, verdict);
    assert.equal(parseTestReviewVerdict(`Evidence\nVerdict: ${verdict}`)?.verdict, verdict);
  }
});

test("rejects conflicting, malformed, quoted and interior verdict declarations", () => {
  for (const body of [
    "Verdict: APPROVE\nEvidence\nVerdict: REVISE",
    "Verdict: BLOCKED\nEvidence\nVerdict: APPROVE",
    "Verdict: APPROVE\nEvidence\nVerdict: APPROVED",
    "Verdict: APPROVE\nEvidence\n**Verdict:** REVISE",
    "Verdict: APPROVE\nEvidence\n> Verdict: APPROVE",
    "Verdict: APPROVE\nEvidence\n- Verdict: BLOCKED",
    "Evidence\nVerdict: APPROVE\nMore evidence",
    "Verdict: APPROVE\nEvidence\nVerdict: APPROVE\nMore evidence",
    "Verdict: APPROVE\nVerdict: REVISE\nVerdict: APPROVE",
  ]) assert.equal(parseTestReviewVerdict(body), null, body);
});
