/**
 * @description Frozen oracle for the VPS cross-family auto-merge eligibility gate
 * (review-cross-family.mjs). `crossFamilyEligible(pr, opts)` is a POSITIVE assertion: auto-merge
 * eligibility requires a distinct second-family (Codex/GPT) verdict artifact that EXISTS and is
 * CLEAN — never derived from a fail-open "Claude ran ok". Both seams (`opts.available` and
 * `opts.secondFamilyVerdict`) are INJECTED so the module never hard-depends on the gitignored
 * codex driver and every test stays deterministic — ZERO real availability probe, ZERO real
 * codex call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { crossFamilyEligible } from "./review-cross-family.mjs";

const PR = { number: 42, headRefName: "harness/feat-x", headSha: "abc123", url: "https://github.com/acme/demo/pull/42" };

test("Given the second family is UNAVAILABLE, When crossFamilyEligible runs, Then it returns false even with a CLEAN verdict present (fail-closed)", () => {
  const unavailableButClean = crossFamilyEligible(PR, {
    available: false,
    secondFamilyVerdict: { status: "CLEAN" },
  });
  assert.equal(unavailableButClean, false, "unavailable must return false even when a CLEAN verdict object is also present");

  const unavailableViaFn = crossFamilyEligible(PR, {
    available: () => false,
    secondFamilyVerdict: () => ({ status: "CLEAN" }),
  });
  assert.equal(unavailableViaFn, false, "unavailable via a checkAvailability() fn must also return false with a CLEAN verdict present");
});

test("Given availability is TRUE but there is NO CLEAN second-family verdict object, When crossFamilyEligible runs, Then false", () => {
  const withNullVerdict = crossFamilyEligible(PR, {
    available: true,
    secondFamilyVerdict: null,
  });
  assert.equal(withNullVerdict, false, "a null verdict is absence of a positive artifact — never treated as a pass");

  const withBlockedVerdict = crossFamilyEligible(PR, {
    available: true,
    secondFamilyVerdict: { status: "BLOCKED" },
  });
  assert.equal(withBlockedVerdict, false, "a non-CLEAN status must never be treated as a pass");

  const withGetterReturningNull = crossFamilyEligible(PR, {
    available: () => true,
    secondFamilyVerdict: (prArg) => {
      assert.equal(prArg, PR, "getSecondFamilyVerdict(pr) must receive the pr under review");
      return null;
    },
  });
  assert.equal(withGetterReturningNull, false, "a getSecondFamilyVerdict(pr) fn returning null must also return false");
});

test("Given availability is TRUE AND a real second-family CLEAN verdict object exists, When crossFamilyEligible runs, Then true", () => {
  const eligible = crossFamilyEligible(PR, {
    available: true,
    secondFamilyVerdict: { status: "CLEAN" },
  });
  assert.equal(eligible, true, "available AND an existing CLEAN verdict must be eligible");

  const eligibleViaFns = crossFamilyEligible(PR, {
    available: () => true,
    secondFamilyVerdict: (prArg) => (prArg.number === PR.number ? { status: "CLEAN" } : null),
  });
  assert.equal(eligibleViaFns, true, "eligibility must also hold when both seams are functions resolving to available+CLEAN");
});
