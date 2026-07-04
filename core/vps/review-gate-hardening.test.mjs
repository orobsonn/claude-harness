/**
 * @description Frozen oracle for the VPS review-gate hardening module (review-gate-hardening.mjs).
 * This module composes review-verdict-source.mjs (fresh verdict) and review-cross-family.mjs
 * (cross-family eligibility) with two additional primitives that harden the merge gate against a
 * flaky single-pass CLEAN on gate-machinery diffs:
 *
 * - `touchesGateMachinery(changedFiles: string[]): boolean` — returns true when ANY entry in
 *   `changedFiles` matches a gate-machinery glob: `core/vps/**`, `core/skills/**`,
 *   `core/agents/**`, `core/rules/**`, `verdict-block*`, `settings.json`, or the entry `CLAUDE.md`.
 *   Pure, synchronous, no I/O — `changedFiles` is caller-supplied (e.g. from the PR diff listing).
 *
 * - `mergeEligible(inputs: {freshVerdictClean: boolean, crossFamilyEligible: boolean,
 *   secondPassRequired: boolean, secondPassClean: boolean}): {eligible: boolean,
 *   second_pass_required: boolean}` — the merge-eligible conjunction. `second_pass_required` is
 *   echoed straight through from `inputs.secondPassRequired` so it is observable on the returned
 *   routing decision (callers derive `secondPassRequired` from `touchesGateMachinery(changedFiles)`
 *   before calling `mergeEligible`). `eligible` is:
 *
 *     eligible = freshVerdictClean
 *       && crossFamilyEligible
 *       && (secondPassRequired ? secondPassClean : true)
 *
 *   A single flaky fresh CLEAN is NEVER sufficient on its own — cross-family eligibility is always
 *   required, and gate-machinery diffs additionally require a CLEAN second independent pass. A
 *   non-eligible decision routes the caller to harness:awaiting-merge / blocked — this module never
 *   performs the merge itself, it only returns the routing decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { touchesGateMachinery, mergeEligible } from "./review-gate-hardening.mjs";

test("Given a PR whose changed-files include a core/vps/ path (gate machinery), When the routing decision is computed, Then second_pass_required is true", () => {
  const changedFiles = ["core/vps/cron-b.mjs"];

  const isGateMachinery = touchesGateMachinery(changedFiles);
  assert.equal(isGateMachinery, true, "core/vps/** must be detected as gate machinery");

  const decision = mergeEligible({
    freshVerdictClean: true,
    crossFamilyEligible: true,
    secondPassRequired: isGateMachinery,
    secondPassClean: true,
  });
  assert.equal(decision.second_pass_required, true, "second_pass_required must be observable and true for a gate-machinery diff");
});

test("Given a gate-machinery PR whose 2nd fresh-eyes pass returns BLOCKED, When mergeEligible runs, Then it is NOT eligible to merge", () => {
  const decision = mergeEligible({
    freshVerdictClean: true,
    crossFamilyEligible: true,
    secondPassRequired: true,
    secondPassClean: false,
  });

  assert.equal(decision.eligible, false, "a BLOCKED second pass on a gate-machinery diff must never be eligible to merge");
  assert.equal(decision.second_pass_required, true, "second_pass_required stays true on the routing decision regardless of the outcome");
});

test("Given a PR whose changed-files touch only docs/, When touchesGateMachinery runs, Then second_pass_required is false", () => {
  const changedFiles = ["docs/usage.md"];

  const isGateMachinery = touchesGateMachinery(changedFiles);
  assert.equal(isGateMachinery, false, "docs/ paths are not gate machinery");

  const decision = mergeEligible({
    freshVerdictClean: true,
    crossFamilyEligible: true,
    secondPassRequired: isGateMachinery,
    secondPassClean: false,
  });
  assert.equal(decision.second_pass_required, false, "second_pass_required must be false for a non-gate-machinery diff");
  assert.equal(decision.eligible, true, "with second_pass_required false, an unclean second pass value must not block eligibility");
});

test("Given a fresh verdict CLEAN but cross-family absent, When the merge-eligible conjunction is evaluated, Then it is false", () => {
  const decision = mergeEligible({
    freshVerdictClean: true,
    crossFamilyEligible: false,
    secondPassRequired: false,
    secondPassClean: true,
  });

  assert.equal(decision.eligible, false, "a single flaky fresh CLEAN without cross-family eligibility must never auto-merge");
});
