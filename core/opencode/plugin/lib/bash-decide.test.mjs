/**
 * @description Locked tests for OC bash delivery + forge decide (issue #481 — parity with
 * Claude Code entry-gate.mjs decideBash: 4 rails kept 1:1 (branch/zero-commits, regate,
 * capture, real-file), fail-open on infra error, the WHOLE ceremony/mode ladder removed,
 * spawn-hand.mjs fidelity rail + freeze-commit early trigger ported).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  decideBashDelivery,
  decideBashAdvisory,
  applyAdvisory,
  adviseIssueForm,
} from "./bash-decide.mjs";

const SID = "ses_test_delivery_1";
const CLEAN_GIT = { branch: "feat/x", commitsAhead: 1, defaultBranch: "main" };
const emptyList = () => [];
const ancestorTrue = () => true;
const ancestorFalse = () => false;

test("high adversary hold denies delivery until the authorized re-gate clears it", () => {
  const decision = decideBashDelivery({
    command: "git push origin feat/x",
    sessionId: SID,
    gateState: { autonomy_adversary_hold: true },
    gitState: CLEAN_GIT,
    listHandRecordsForFeatureFn: emptyList,
  });
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /high adversary finding/);
});

/** Green on-disk DONE+stamp fixture — used to prove the real-file rail still fires. */
const stampedDoneList = () => [
  {
    taskId: "t1",
    sessionId: SID,
    record: {
      outcome: "DONE",
      freezeCommitSha: "abc",
      capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
      scopeViolations: [],
      frozenViolations: [],
    },
  },
];

/** @param {Record<string, unknown>} [extra] */
function cleanDeps(extra = {}) {
  return {
    sessionId: SID,
    gitState: CLEAN_GIT,
    isAncestorFn: ancestorTrue,
    listHandRecordsForFeatureFn: emptyList,
    ...extra,
  };
}

/** @param {Record<string, unknown>} [extra] */
function cleanDepsWithCapture(extra = {}) {
  return cleanDeps({
    listHandRecordsForFeatureFn: stampedDoneList,
    ...extra,
  });
}

// ── #ac-1.1 / #ac-1.5: empty/unreadable gate-state and missing/unsafe sessionId → allow ──

test("#ac-1.1: empty gate-state {} on a feature branch with commits ahead → allow (was denied by 'requires readable gate-state')", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {},
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "delivery-ok");
});

test("#ac-1.1: same scenario via gh pr create → allow", () => {
  const d = decideBashDelivery({
    command: "gh pr create --draft",
    gateState: {},
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

test("#ac-1.5: sessionId null → allow (fail-open, infra error) regardless of gateState content", () => {
  const d = decideBashDelivery({
    command: "git push",
    gitState: CLEAN_GIT,
    sessionId: null,
    // Even an otherwise-blocking gateState must not matter — CC's decideBash returns
    // allow before ever reading gate-state when sessionId is missing/unsafe.
    gateState: { regate_pending: ["feat/t1"] },
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "sessionId-missing-or-unsafe");
});

test("#ac-1.5: sessionId unsafe (path traversal) → allow (fail-open)", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    gitState: CLEAN_GIT,
    sessionId: "../../evil",
    gateState: {},
  });
  assert.equal(d.decision, "allow");
});

test("#ac-1.5: gitState probe error (null) does not alone deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {},
    ...cleanDeps({ gitState: null }),
  });
  assert.equal(d.decision, "allow");
});

// ── #ac-1.2 / #ac-1.3: branch/zero-commits rail kept 1:1 ──────────────────────────────

test("#ac-1.2: git push from main → deny protected branch", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {},
    ...cleanDeps({ gitState: { branch: "main", commitsAhead: 3, defaultBranch: "main" } }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /protected branch/i);
});

test("#ac-1.2: git push from master → deny protected branch", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {},
    ...cleanDeps({ gitState: { branch: "master", commitsAhead: 2, defaultBranch: "master" } }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /protected branch/i);
});

test("#ac-1.2: branch === resolved defaultBranch (non-main name) → deny protected branch", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {},
    ...cleanDeps({ gitState: { branch: "trunk", commitsAhead: 1, defaultBranch: "trunk" } }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /protected branch/i);
});

test("#ac-1.3: zero commits ahead on a feature branch → deny naming commit", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {},
    ...cleanDeps({ gitState: { branch: "feat/x", commitsAhead: 0, defaultBranch: "main" } }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /zero commits/i);
});

test("feature branch with commits ahead → allow (this rail alone)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {},
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

test("base unresolved (commitsAhead null) on a feature branch → allow (branch floor only)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {},
    ...cleanDeps({ gitState: { branch: "feat/x", commitsAhead: null, defaultBranch: "main" } }),
  });
  assert.equal(d.decision, "allow");
});

test("read-only command on main → allow (not a delivery command)", () => {
  const d = decideBashDelivery({
    command: "git status",
    gateState: {},
    ...cleanDeps({ gitState: { branch: "main", commitsAhead: 3, defaultBranch: "main" } }),
  });
  assert.equal(d.decision, "allow");
});

test("LOCKED default-branch #6 parity: branch 'feature/develop-stuff' vs defaultBranch 'develop' → allow (only EXACT branch match denies, not a substring/prefix match)", () => {
  const d = decideBashDelivery({
    command: "git push -u origin feature/develop-stuff",
    gateState: {},
    ...cleanDeps({ gitState: { branch: "feature/develop-stuff", commitsAhead: 2, defaultBranch: "develop" } }),
  });
  assert.equal(d.decision, "allow");
});

test("git --git-dir=... --work-tree=... push with unmatched regate_pending → deny (global-flag form still classified as delivery)", () => {
  const d = decideBashDelivery({
    command: "git --git-dir=/repo/.git --work-tree=/repo push",
    gateState: { regate_pending: ["feat/t1"] },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t1/);
});

test("trilho-4 #3 parity: git status with unmatched hand_finished → allow (read-only never gated)", () => {
  const d = decideBashDelivery({
    command: "git status",
    gateState: { hand_finished: ["feat/t1"] },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

// ── #ac-1.4: regate rail kept 1:1 (same message in both runtimes) ─────────────────────

test("#ac-1.4: unmatched regate_pending → deny naming the qualified task, same message shape as Claude Code", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { regate_pending: ["feat/t1"] },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t1/);
  assert.match(d.reason, /mandatory strong-eye re-gate/);
});

test("#ac-1.4: regate matched by an ancestor-sha regate_passed → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { regate_pending: ["feat/t1"], regate_passed: ["feat/t1@abc"] },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

test("regate_passed at a divergent (non-ancestor) sha → deny (stale absolution ignored)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { regate_pending: ["feat/t1"], regate_passed: ["feat/t1@sha"] },
    ...cleanDeps({ isAncestorFn: ancestorFalse }),
  });
  assert.equal(d.decision, "deny");
});

test("unqualified (no @sha) regate_passed → deny (treated as absent)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { regate_pending: ["feat/t1"], regate_passed: ["feat/t1"] },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
});

test("no re-gate markers at all → allow (nothing to consume)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {},
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

test("LOCKED B1b parity: gh pr create with unmatched regate_pending → deny naming task-1 (same rail as git push)", () => {
  const d = decideBashDelivery({
    command: "gh pr create --title 'My PR'",
    gateState: { regate_pending: ["task-1"] },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /task-1/);
});

// ── capture rail (hand_finished vs capture_verified) kept 1:1 ─────────────────────────

test("hand_finished without capture_verified → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { hand_finished: ["feat/t1"] },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t1/);
});

test("hand_finished + capture_verified divergent sha → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { hand_finished: ["feat/t1"], capture_verified: ["feat/t1@deadbeef"] },
    ...cleanDeps({ isAncestorFn: ancestorFalse }),
  });
  assert.equal(d.decision, "deny");
});

test("regate matched AND capture unmatched → deny (independent rails)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {
      regate_pending: ["feat/t1"],
      regate_passed: ["feat/t1@abc"],
      hand_finished: ["feat/t2"],
    },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t2|capture|hand-finished/i);
});

test("both regate+capture matched + real-file clear → allow (single terminal)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {
      regate_pending: ["feat/t1"],
      regate_passed: ["feat/t1@abc"],
      hand_finished: ["feat/t2"],
      capture_verified: ["feat/t2@def"],
    },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "delivery-ok");
});

// ── corrupt-marker fail-closed exception: regate_pending ALONE (#ac-1.5 "única exceção") ──

test("#ac-1.5: regate_pending non-array → deny gate-state corrupted (not 'stamp regate-passed') — the sole deliberate fail-closed exception", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { regate_pending: "BROKEN" },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gate-state corrupted/);
  assert.match(d.reason, /BROKEN/);
  assert.doesNotMatch(d.reason, /stamp regate-passed/);
});

// hand_finished / capture_verified / regate_passed are explicitly NOT the fail-closed
// exception — a non-array value there silently coerces to [], mirroring Claude Code exactly
// (entry-gate.mjs never denies on a malformed one of these, only on regate_pending).

test("#ac-1.5: hand_finished non-array → coerces to [] (allow), not a corrupt-content deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { hand_finished: { y: 2 } },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

test("#ac-1.5: capture_verified non-array → coerces to [] (allow), not a corrupt-content deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { capture_verified: { z: 3 } },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

test("#ac-1.5: regate_passed non-array → coerces to [] — an unmatched regate_pending still denies on its own rail (not the corrupt-content path)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { regate_pending: ["feat/t1"], regate_passed: { x: 1 } },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t1/);
  assert.doesNotMatch(d.reason, /gate-state corrupted/);
});

test("regate_pending raw value is truncated in the deny reason (cap 200)", () => {
  const big = "X".repeat(5000);
  const d = decideBashDelivery({
    command: "git push",
    gateState: { regate_pending: big },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.ok(!d.reason.includes(big), "deny reason must not include the full 5000-char blob");
  assert.ok(
    !d.reason.includes("X".repeat(201)),
    "deny reason must not include a run of more than 200 consecutive 'X' characters",
  );
});

// ── fail_open catch-all: an internal bug in decideBashDelivery must never opaquely brick
// delivery (docs/OC-CC-PARITY-REPORT.md item #60 "delivery-decision-catch-all | A (fail-open)").

test("internal error inside decideBashDelivery → fails OPEN (allow), never an opaque deny", () => {
  const throwingGateState = new Proxy(
    {},
    {
      get() {
        throw new Error("boom");
      },
    },
  );
  const d = decideBashDelivery({
    command: "git push",
    gateState: throwingGateState,
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "delivery-decision-failed-open");
});

// ── real-file rail: fires on feature_id alone, no ceremony/mode dependency ────────────

test("no feature_id → real-file rail never consulted (allow) even with no hand records", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: {},
    ...cleanDeps({ listHandRecordsForFeatureFn: emptyList }),
  });
  assert.equal(d.decision, "allow");
});

test("feature_id present + empty hand-record list → allow (real-file rail is vacuous-ship-ok without ceremony, CC parity)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { feature_id: "feat" },
    ...cleanDeps({ listHandRecordsForFeatureFn: emptyList }),
  });
  assert.equal(d.decision, "allow");
});

test("feature_id present + listFn missing → deny real-file-list-unavailable", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { feature_id: "feat" },
    sessionId: SID,
    gitState: CLEAN_GIT,
    isAncestorFn: ancestorTrue,
    // listFn absent
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /real-file-list-unavailable/);
});

test("listFn throws → deny real-file-list-unavailable", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { feature_id: "feat" },
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => {
        throw new Error("readdir failed");
      },
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /real-file-list-unavailable/);
});

test("listFn DONE record missing capturedVerifiedAt → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { feature_id: "feat" },
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => [
        { taskId: "t1", sessionId: "s1", record: { outcome: "DONE", freezeCommitSha: "abc" } },
      ],
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /capturedVerifiedAt/);
});

test("DONE+stamp+scopeViolations → deny hard-stop", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { feature_id: "feat" },
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => [
        {
          taskId: "t1",
          sessionId: "s1",
          record: {
            outcome: "DONE",
            freezeCommitSha: "abc",
            capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
            scopeViolations: ["leak.ts"],
          },
        },
      ],
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /SCOPE\/FROZEN/);
});

test("feature_id + DONE+stamp hand record → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { feature_id: "feat" },
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

test("real-file rail ignores a hand-record whose freezeCommitSha is not an ancestor of HEAD", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { feature_id: "feat" },
    ...cleanDeps({ listHandRecordsForFeatureFn: stampedDoneList, isAncestorFn: ancestorFalse }),
  });
  assert.equal(d.decision, "allow");
});

// ── #ac-2.1: spawn-hand.mjs fidelity rail (ported from Claude Code entry-gate.mjs :451-521) ──

test("#ac-2.1: spawn-hand.mjs without --descriptor → allow (fail-open, read-only commands like cat/grep must pass)", () => {
  const d = decideBashDelivery({
    command: "cat .claude/skills/orchestrating-delivery/references/spawn-hand.mjs",
    gateState: {},
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

test("#ac-2.1: spawn-hand.mjs --descriptor unreadable → deny fail-closed", () => {
  const d = decideBashDelivery({
    command: "node spawn-hand.mjs --descriptor missing.json",
    gateState: {},
    sessionId: SID,
    readDescriptorFn: () => null,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /descriptor/);
});

test("#ac-2.1: spawn-hand.mjs --descriptor with non-string ids → deny fail-closed", () => {
  const d = decideBashDelivery({
    command: "node spawn-hand.mjs --descriptor d.json",
    gateState: {},
    sessionId: SID,
    readDescriptorFn: () => ({ feature_id: 1, task_id: "T" }),
  });
  assert.equal(d.decision, "deny");
});

test("#ac-2.1: spawn-hand.mjs --descriptor {F,T} + fidelity_pass=[] → deny naming missing fidelity-pass for F/T", () => {
  const d = decideBashDelivery({
    command: "node spawn-hand.mjs --descriptor d.json",
    gateState: { fidelity_pass: [] },
    sessionId: SID,
    readDescriptorFn: () => ({ feature_id: "F", task_id: "T" }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason.toLowerCase(), /fidelity/);
  assert.match(d.reason, /F\/T/);
});

test("#ac-2.1: spawn-hand.mjs --descriptor {F,T} + fidelity_pass=[F/T] → allow", () => {
  const d = decideBashDelivery({
    command: "node spawn-hand.mjs --descriptor d.json",
    gateState: { fidelity_pass: ["F/T"] },
    sessionId: SID,
    readDescriptorFn: () => ({ feature_id: "F", task_id: "T" }),
  });
  assert.equal(d.decision, "allow");
});

test("#ac-2.1: spawn-hand.mjs --descriptor {F,T} + fidelity_pass=[WRONG/T] → deny (qualified-id match, not blanket allow)", () => {
  const d = decideBashDelivery({
    command: "node spawn-hand.mjs --descriptor d.json",
    gateState: { fidelity_pass: ["WRONG/T"] },
    sessionId: SID,
    readDescriptorFn: () => ({ feature_id: "F", task_id: "T" }),
  });
  assert.equal(d.decision, "deny");
});

test("#ac-2.1: spawn-hand.mjs --descriptor {F,T} + sha-qualified fidelity_pass=[F/T@abc] → allow (prefix match)", () => {
  const d = decideBashDelivery({
    command: "node spawn-hand.mjs --descriptor d.json",
    gateState: { fidelity_pass: ["F/T@abc"] },
    sessionId: SID,
    readDescriptorFn: () => ({ feature_id: "F", task_id: "T" }),
  });
  assert.equal(d.decision, "allow");
});

// ── #ac-2.1 precedence regression: mentioning spawn-hand.mjs must never be a delivery
// free-pass. The fidelity rail is a narrow trail on spawn-hand.mjs DISPATCHES, not a
// substring escape hatch for an unrelated delivery command that merely contains the text
// (e.g. in a PR body) or composes it with `&&`. A fidelity ALLOW must fall through to the
// branch/regate/capture/real-file rails whenever the command is ALSO a delivery command; only
// a fidelity DENY may short-circuit unconditionally. ──────────────────────────────────────

test("#ac-2.1 precedence: gh pr create whose --body merely mentions spawn-hand.mjs still crosses the branch/zero-commits rail (protected branch) → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create --body 'dispatched via spawn-hand.mjs; capture verified.'",
    gateState: {},
    ...cleanDeps({ gitState: { branch: "main", commitsAhead: 3, defaultBranch: "main" } }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /protected branch/i);
});

test("#ac-2.1 precedence: git push composed with a spawn-hand.mjs comment still crosses the regate rail → deny naming the unmatched task", () => {
  const d = decideBashDelivery({
    command: "git push --force origin main # spawn-hand.mjs",
    gateState: { regate_pending: ["feat/t1"] },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t1/);
});

test("#ac-2.1 precedence: gh pr merge composed with a spawn-hand.mjs comment still crosses the regate rail → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr merge --admin 42 # spawn-hand.mjs",
    gateState: { regate_pending: ["feat/t1"] },
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
});

test("#ac-2.1 precedence: literal spawn-hand.mjs dispatch composed with && git push — fidelity ALLOW is not a delivery free-pass, unmatched regate still denies", () => {
  const d = decideBashDelivery({
    command: "node spawn-hand.mjs --descriptor d.json && git push origin main",
    gateState: { fidelity_pass: ["F/T"], regate_pending: ["feat/t1"] },
    sessionId: SID,
    readDescriptorFn: () => ({ feature_id: "F", task_id: "T" }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t1/);
});

test("#ac-2.1 precedence: literal spawn-hand.mjs dispatch composed with && git push — fidelity DENY still short-circuits (no fall-through needed)", () => {
  const d = decideBashDelivery({
    command: "node spawn-hand.mjs --descriptor d.json && git push origin main",
    gateState: { fidelity_pass: [] },
    sessionId: SID,
    readDescriptorFn: () => ({ feature_id: "F", task_id: "T" }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason.toLowerCase(), /fidelity/);
});

test("#ac-2.1 precedence: a genuinely non-delivery spawn-hand.mjs dispatch (no && push) still returns the fidelity verdict directly", () => {
  const allow = decideBashDelivery({
    command: "node spawn-hand.mjs --descriptor d.json",
    gateState: { fidelity_pass: ["F/T"] },
    sessionId: SID,
    readDescriptorFn: () => ({ feature_id: "F", task_id: "T" }),
  });
  assert.equal(allow.decision, "allow");
  assert.equal(allow.reason, "spawn-hand-fidelity-ok");
});

// ── #ac-2.2: freeze-commit early capture trigger (ported from :530-554) ───────────────

test("#ac-2.2: freeze-commit message + unresolved hand-record for the current feature → deny early (same rail as delivery gate)", () => {
  const d = decideBashDelivery({
    command: 'git commit -m "test(cron): freeze locked tests for task-2"',
    gateState: { feature_id: "feat" },
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => [
        { taskId: "t1", sessionId: SID, record: { outcome: "DONE", freezeCommitSha: "abc" } },
      ],
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /capturedVerifiedAt/);
});

test("#ac-2.2: ordinary git commit (not a freeze-commit message) → allow even with an unresolved hand-record — best-effort, not the mandatory gate", () => {
  const d = decideBashDelivery({
    command: 'git commit -m "chore: update memory notes"',
    gateState: { feature_id: "feat" },
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => [
        { taskId: "t1", sessionId: SID, record: { outcome: "DONE", freezeCommitSha: "abc" } },
      ],
    }),
  });
  assert.equal(d.decision, "allow");
});

test("#ac-2.2: freeze-commit message with no feature_id → allow (fail-open, nothing to check)", () => {
  const d = decideBashDelivery({
    command: 'git commit -m "test(cron): freeze locked tests for task-2"',
    gateState: {},
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

test("#ac-2.2: freeze-commit message clears (DONE+stamp hand record) → allow", () => {
  const d = decideBashDelivery({
    command: 'git commit -m "test(cron): freeze locked tests for task-2"',
    gateState: { feature_id: "feat" },
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

// ── the mode ladder is GONE: ceremony fields no longer influence the bash gate ────────

test("no mode / not classified + clean rails + feature_id → allow (mode ladder removed)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { feature_id: "feat" },
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

test("mode=no-ceremony + clean rails → allow (was a hard deny; ceremony is not the bash gate's concern anymore)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { mode: "no-ceremony", classified: true, feature_id: "feat" },
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

test("FULL mode with clean delivery facts → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { mode: "FULL", classified: true, feature_id: "feat" },
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

test("a legacy review status does not block the bash gate", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: { feature_id: "feat", review_status: "legacy-review-status" },
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

// ── previously-forge-denied command shapes stay allowed (unrelated to this issue, still true) ──

test("previously forge-denied command shapes still allow via decideBashAdvisory/decideBashDelivery", () => {
  const previouslyDenied = [
    "npm run build",
    "make test",
    'node -e "console.log(1)"',
    "bash script.sh",
    "npx some-tool",
  ];
  for (const command of previouslyDenied) {
    assert.equal(decideBashAdvisory({ command }).decision, "allow");
    assert.equal(decideBashDelivery({ command }).decision, "allow");
  }
});

// ── decideBashAdvisory / applyAdvisory / adviseIssueForm — unaffected by this issue ───

test("decideBashAdvisory is fail-open — never denies, even on malformed input", () => {
  const malformed = [{}, { command: undefined }, { command: 123 }, { command: null }];
  for (const input of malformed) {
    const d = decideBashAdvisory(input);
    assert.equal(d.ok, true);
    assert.equal(d.decision, "allow");
  }
});

test("decideBashAdvisory attaches an advisory for gh issue create in a vendored repo", () => {
  const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "../../../..");
  const d = decideBashAdvisory({ command: "gh issue create --title x", cwd: repoRoot });
  assert.equal(d.decision, "allow");
  assert.equal(typeof d.advisory, "string");
  assert.match(d.advisory, /harness-task\.yml/);
});

test("decideBashAdvisory omits advisory when convention already followed", () => {
  const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "../../../..");
  const d = decideBashAdvisory({
    command: 'gh issue create --title "[harness] foo" --label "harness:ready"',
    cwd: repoRoot,
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.advisory, undefined);
});

test("applyAdvisory writes the advisory to output.metadata.bash_advisory and preserves existing keys", () => {
  const output = { metadata: { model: "x" } };
  applyAdvisory({ ok: true, decision: "allow", reason: "advisory", advisory: "hint text" }, output);
  assert.equal(output.metadata.model, "x");
  assert.equal(output.metadata.bash_advisory, "hint text");
});

test("applyAdvisory is fail-open on malformed output (never throws)", () => {
  const decision = { ok: true, decision: "allow", reason: "advisory", advisory: "hint text" };
  assert.doesNotThrow(() => applyAdvisory(decision, null));
  assert.doesNotThrow(() => applyAdvisory(decision, undefined));
  assert.doesNotThrow(() => applyAdvisory(decision, "not-an-object"));
  assert.doesNotThrow(() => applyAdvisory(null, {}));
});

test("adviseIssueForm: gh issue create + existsFn=true + abs cwd → advisory string", () => {
  const result = adviseIssueForm("gh issue create --title x", "/abs/repo", () => true);
  assert.ok(result);
  assert.equal(typeof result, "string");
});

test("adviseIssueForm: non-gh-issue command → null", () => {
  assert.equal(adviseIssueForm("ls -la", "/abs/repo", () => true), null);
});

test("adviseIssueForm: -l short flag with harness:ready suppresses the nudge", () => {
  assert.equal(
    adviseIssueForm('gh issue create --title x -l harness:ready', "/abs/repo", () => true),
    null,
  );
});

// ── #ac-2.4 / #ac-2.11: opencode.json.example permission.bash contract (config only, unrelated to this issue) ──

test("#ac-2.4 #ac-2.11: opencode.json.example bash permission baseline", () => {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const jsonPath = path.join(__dirname, "../../../opencode/opencode.json.example");
  const raw = fs.readFileSync(jsonPath, "utf8");
  const config = JSON.parse(raw);
  const bash = config.permission && config.permission.bash;
  assert.ok(bash, "permission.bash must exist");
  assert.equal(bash["*"], "allow");
  assert.equal(bash["node*.opencode/plans/.state/*"], "deny");
  assert.equal(bash["python*.opencode/plans/.state/*"], "deny");
  assert.equal(bash["sed *.opencode/plans/.state/*"], "deny");
  assert.equal(bash["tee *.opencode/plans/.state/*"], "deny");
  assert.equal(bash["rm *.opencode/plans/.state/*"], "deny");
  assert.equal(Object.hasOwn(bash, "node .opencode/plugin/lib/mark-gate.mjs *"), false);
  assert.equal(Object.hasOwn(bash, "node core/opencode/plugin/lib/mark-gate.mjs *"), false);
  assert.equal(bash["gh *"], "allow");
});
