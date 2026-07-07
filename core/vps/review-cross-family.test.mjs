/**
 * @description Frozen oracle for the VPS cross-family auto-merge eligibility gate
 * (review-cross-family.mjs). `crossFamilyEligible(pr, opts)` is fail-open ONLY on genuine
 * absence of a verdict artifact (Codex never ran — no subscription, switch off, unreachable):
 * with no verdict at all, eligibility no longer blocks on the missing second family. The moment
 * ANY verdict artifact exists, the original guarantee is unconditional: a non-CLEAN verdict
 * always blocks, and an `available:false` verdict (a suspicious/forged-looking CLEAN paired with
 * an availability flag saying otherwise) is never trusted either. Both seams (`opts.available`
 * and `opts.secondFamilyVerdict`) are INJECTED so the module never hard-depends on the gitignored
 * codex driver and every test stays deterministic — ZERO real availability probe, ZERO real
 * codex call.
 *
 * Also covers `deriveSecondFamilyVerdict(codexEyes, { securityVerdict })` — a pure helper that
 * folds the codex adversary + security eye outputs into a single { status } verdict object, using
 * an injected `securityVerdict` fn to judge each eye's issues. It is fail-closed: CLEAN requires
 * BOTH eyes present AND both judged SECURE; any missing eye or any UNSAFE judgement yields
 * BLOCKED, never a false CLEAN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { crossFamilyEligible, deriveSecondFamilyVerdict } from "./review-cross-family.mjs";
import { securityVerdict as realSecurityVerdict } from "../../modules/codex-adversary/references/merge-findings.mjs";

const PR = { number: 42, headRefName: "harness/feat-x", headSha: "abc123", url: "https://github.com/acme/demo/pull/42" };

const fakeSecurityVerdict = (issues = []) => (issues.some((i) => i.severity === "high" || i.severity === "medium") ? "UNSAFE" : "SECURE");

test("Given a verdict artifact is genuinely ABSENT (available false, no verdict), When crossFamilyEligible runs, Then true (fail-open — Codex never ran)", () => {
  const absent = crossFamilyEligible(PR, { available: false, secondFamilyVerdict: null });
  assert.equal(absent, true, "no verdict at all must fail-open — the operator accepted this trade-off (no Codex budget)");

  const absentViaFn = crossFamilyEligible(PR, { available: () => false, secondFamilyVerdict: () => null });
  assert.equal(absentViaFn, true, "genuine absence via seam functions must also fail-open");
});

test("Given availability is FALSE but a verdict object IS present (forged/stale-looking CLEAN), When crossFamilyEligible runs, Then it still returns false (anti-spoof guard, unchanged)", () => {
  const unavailableButClean = crossFamilyEligible(PR, {
    available: false,
    secondFamilyVerdict: { status: "CLEAN" },
  });
  assert.equal(unavailableButClean, false, "a verdict object paired with available:false is never trusted — this is not the same as genuine absence");

  const unavailableViaFn = crossFamilyEligible(PR, {
    available: () => false,
    secondFamilyVerdict: () => ({ status: "CLEAN" }),
  });
  assert.equal(unavailableViaFn, false, "unavailable via a checkAvailability() fn must also return false with a CLEAN verdict present");
});

test("Given availability is TRUE but there is NO CLEAN second-family verdict object, When crossFamilyEligible runs, Then behavior depends on whether a verdict exists at all", () => {
  const withNullVerdict = crossFamilyEligible(PR, {
    available: true,
    secondFamilyVerdict: null,
  });
  assert.equal(withNullVerdict, true, "no verdict object at all is genuine absence — fail-open, regardless of the available flag");

  const withBlockedVerdict = crossFamilyEligible(PR, {
    available: true,
    secondFamilyVerdict: { status: "BLOCKED" },
  });
  assert.equal(withBlockedVerdict, false, "a non-CLEAN status must never be treated as a pass — Codex ran and found a problem, unconditional block");

  const withGetterReturningNull = crossFamilyEligible(PR, {
    available: () => true,
    secondFamilyVerdict: (prArg) => {
      assert.equal(prArg, PR, "getSecondFamilyVerdict(pr) must receive the pr under review");
      return null;
    },
  });
  assert.equal(withGetterReturningNull, true, "a getSecondFamilyVerdict(pr) fn returning null is genuine absence — fail-open");
});

test("Given availability is FALSE and a real BLOCKED verdict is present (one codex eye failed structurally, the other produced a real BLOCKED fold — run-cron-review.mjs's available=advOk&&secOk wiring), When crossFamilyEligible runs, Then false — never confused with genuine absence", () => {
  const partialRunBlocked = crossFamilyEligible(PR, {
    available: false,
    secondFamilyVerdict: { status: "BLOCKED" },
  });
  assert.equal(
    partialRunBlocked,
    false,
    "a present BLOCKED verdict always blocks regardless of the available flag — this is the case a naive available-only fail-open check would get wrong",
  );
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

test("deriveSecondFamilyVerdict: codex security has a high issue + clean adversary → BLOCKED, and crossFamilyEligible false", () => {
  const v = deriveSecondFamilyVerdict(
    { adversary: { issues: [] }, security: { issues: [{ severity: "high", scope: "x" }] } },
    { securityVerdict: fakeSecurityVerdict },
  );
  assert.equal(v.status, "BLOCKED");
  assert.equal(crossFamilyEligible(PR, { available: true, secondFamilyVerdict: v }), false);
});

test("deriveSecondFamilyVerdict: clean adversary (zero high/medium) + SECURE security → CLEAN, and crossFamilyEligible true", () => {
  const v = deriveSecondFamilyVerdict(
    { adversary: { issues: [{ severity: "low", scope: "y" }] }, security: { issues: [] } },
    { securityVerdict: fakeSecurityVerdict },
  );
  assert.equal(v.status, "CLEAN");
  assert.equal(crossFamilyEligible(PR, { available: true, secondFamilyVerdict: v }), true);
});

test("deriveSecondFamilyVerdict: adversary has a medium issue → BLOCKED (adversaryClean false, never a false-CLEAN)", () => {
  const v = deriveSecondFamilyVerdict(
    { adversary: { issues: [{ severity: "medium", scope: "z" }] }, security: { issues: [] } },
    { securityVerdict: fakeSecurityVerdict },
  );
  assert.equal(v.status, "BLOCKED");
});

test("deriveSecondFamilyVerdict: a missing/null eye output → BLOCKED (absent eye never derives CLEAN)", () => {
  assert.equal(
    deriveSecondFamilyVerdict({ adversary: null, security: { issues: [] } }, { securityVerdict: fakeSecurityVerdict }).status,
    "BLOCKED",
  );
  assert.equal(
    deriveSecondFamilyVerdict({ adversary: { issues: [] }, security: null }, { securityVerdict: fakeSecurityVerdict }).status,
    "BLOCKED",
  );
});

test("deriveSecondFamilyVerdict: an eye envelope carrying available:false (unavailable, never ran) is BLOCKED even with empty issues (no false-CLEAN from an unrun eye)", () => {
  const bothUnavailable = deriveSecondFamilyVerdict(
    { adversary: { available: false, issues: [] }, security: { available: false, issues: [] } },
    { securityVerdict: fakeSecurityVerdict }
  );
  assert.equal(bothUnavailable.status, "BLOCKED");
  const oneUnavailable = deriveSecondFamilyVerdict(
    { adversary: { available: false, issues: [] }, security: { available: true, issues: [] } },
    { securityVerdict: fakeSecurityVerdict }
  );
  assert.equal(oneUnavailable.status, "BLOCKED");
});

test("deriveSecondFamilyVerdict: a codex adversary 'critical' finding blocks under the REAL securityVerdict (critical normalizes to high)", () => {
  const v = deriveSecondFamilyVerdict(
    { adversary: { available: true, issues: [{ severity: "critical", scope: "x" }] }, security: { available: true, issues: [] } },
    { securityVerdict: realSecurityVerdict }
  );
  assert.equal(v.status, "BLOCKED");
});
