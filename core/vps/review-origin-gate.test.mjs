/**
 * @description Contract tests for review-origin-gate.mjs — the machine-origin gate that decides
 * whether a PR is eligible for the harness's autonomous review path. The module is
 * self-contained (it does NOT import from cron-b.mjs); `isReviewEligible(pr, opts)` takes a
 * `pr` shaped like the `gh pr view --json number,headRefName,author,labels` output and an
 * `opts` bag carrying two injected seams so the gate is deterministic under test:
 *   - `opts.authenticatedUser`: the gh-user login string, OR a zero-arg fn returning it
 *     (`() => string`) — the "is this PR mine" cross-check.
 *   - `opts.engineKnows(pr)`: a fn returning whether the PR maps to a harness issue/branch the
 *     engine itself dispatched — the engine-known cross-check backing the secondary label path.
 *
 * Branch prefix `harness/` is the PRIMARY machine-origin signal (author match alone suffices).
 * Label `harness:autoreview` is a SECONDARY signal that only qualifies a PR when BOTH the author
 * matches the authenticated gh-user AND `engineKnows(pr)` confirms the engine dispatched it — a
 * label on a foreign-author PR, or a label with no engine-known mapping, must never qualify.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isReviewEligible } from "./review-origin-gate.mjs";

const GH_USER = "harness-bot";

test("harness/ branch + author == authenticated gh-user: eligible (primary signal alone suffices)", () => {
  const pr = {
    number: 12,
    headRefName: "harness/12",
    author: { login: GH_USER },
    labels: [],
  };
  const opts = {
    authenticatedUser: GH_USER,
    engineKnows: () => false,
  };

  assert.equal(
    isReviewEligible(pr, opts),
    true,
    "a PR on branch harness/12 authored by the authenticated gh-user must be eligible"
  );
});

test("fix/foo branch (human WIP), authored by the gh-user, no autoreview label: not eligible", () => {
  const pr = {
    number: 13,
    headRefName: "fix/foo",
    author: { login: GH_USER },
    labels: [],
  };
  const opts = {
    authenticatedUser: GH_USER,
    engineKnows: () => false,
  };

  assert.equal(
    isReviewEligible(pr, opts),
    false,
    "fix/foo is not harness/* and carries no autoreview label — no positive machine-origin signal"
  );
});

test("harness:autoreview label but author != gh-user, and not on a harness/* branch: not eligible", () => {
  const pr = {
    number: 14,
    headRefName: "fix/someone-elses-branch",
    author: { login: "random-human" },
    labels: [{ name: "harness:autoreview" }],
  };
  const opts = {
    authenticatedUser: GH_USER,
    engineKnows: () => true,
  };

  assert.equal(
    isReviewEligible(pr, opts),
    false,
    "a label alone must never qualify a foreign-author PR, even when engineKnows would say yes"
  );
});

test("harness:autoreview label + author == gh-user, but engineKnows(pr) is false, not on harness/*: not eligible", () => {
  const pr = {
    number: 15,
    headRefName: "chore/manual-pr",
    author: { login: GH_USER },
    labels: [{ name: "harness:autoreview" }],
  };
  const opts = {
    authenticatedUser: GH_USER,
    engineKnows: () => false,
  };

  assert.equal(
    isReviewEligible(pr, opts),
    false,
    "the autoreview label needs the engine-known cross-check — engineKnows() returning false must block it"
  );
});

test("harness:autoreview label + author == gh-user + engineKnows(pr) true, not on harness/*: eligible (secondary path satisfied)", () => {
  const pr = {
    number: 16,
    headRefName: "chore/manual-pr",
    author: { login: GH_USER },
    labels: [{ name: "harness:autoreview" }],
  };
  const opts = {
    authenticatedUser: GH_USER,
    engineKnows: () => true,
  };

  assert.equal(
    isReviewEligible(pr, opts),
    true,
    "label + matching author + engine-known mapping fully satisfies the secondary path"
  );
});
