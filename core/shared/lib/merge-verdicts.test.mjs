/** @description Locked tests for merge-verdicts (T4). Policy B compatible, never throw on malformed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeVerdicts } from "./merge-verdicts.mjs";

test("t4-verdicts: malformed input never throws; policy-compatible merged verdict output", () => {
  assert.doesNotThrow(() => mergeVerdicts(null, undefined));
  assert.doesNotThrow(() => mergeVerdicts("bad", 42));
  assert.doesNotThrow(() => mergeVerdicts({}, []));

  const bad = mergeVerdicts(null);
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.reason, "string");
  assert.equal(bad.verdict, "REVISE");

  const primaryOnly = mergeVerdicts({ verdict: "APPROVE" }, null);
  assert.equal(primaryOnly.ok, true);
  assert.equal(primaryOnly.verdict, "APPROVE");
  assert.equal(primaryOnly.dual_status, "primary_only");

  const eitherRevise = mergeVerdicts({ verdict: "APPROVE" }, { verdict: "REVISE" });
  assert.equal(eitherRevise.ok, true);
  assert.equal(eitherRevise.verdict, "REVISE");

  const legacyFailure = mergeVerdicts(
    { verdict: "APPROVE" },
    null,
    { dual_status: "primary_only_error" },
  );
  assert.equal(legacyFailure.dual_status, "primary_only");
  assert.equal(eitherRevise.merged, true);
});
