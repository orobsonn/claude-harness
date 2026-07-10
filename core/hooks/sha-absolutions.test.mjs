/**
 * @description A2 locked tests — sha-qualified absolutions (#ac-2.1, #ac-2.2, #ac-2.3).
 *
 * The three ABSOLUTION markers (regate_passed, capture_verified, fidelity_pass) are stamped
 * sha-qualified `<feature>/<task>@<sha>`; the OBLIGATION markers (regate_pending, hand_finished)
 * stay unqualified. Reader validity = the absolution's sha is an ancestor of (or equal to) HEAD.
 *
 * Run with: node --test core/hooks/sha-absolutions.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  matchesAbsolution,
  absolutionPrefix,
  resetGateState,
  mergeGateState,
  readGateState,
} from "./lib/gate-lib.mjs";
import { decide as entryDecide } from "./entry-gate.mjs";
import { handle as stampHandle } from "./stamp-triage.mjs";

function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sha-abs-test-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    fn();
  } finally {
    process.chdir(savedCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function makeAgentPayload(sessionId, subagentType, extra = {}) {
  return {
    session_id: sessionId,
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType, prompt: "x" },
    ...extra,
  };
}

function makeBashPayload(sessionId, command, extra = {}) {
  return { session_id: sessionId, tool_name: "Bash", tool_input: { command }, ...extra };
}

function makeMarkerPayload(sessionId, marker, featureId, taskId) {
  return {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: {
      command: `node .claude/hooks/mark.mjs ${marker} --feature-id ${featureId} --task-id ${taskId}`,
    },
    tool_response: JSON.stringify({ marker, feature_id: featureId, task_id: taskId }),
  };
}

// ---------------------------------------------------------------------------
// gate-lib: matchesAbsolution + absolutionPrefix
// ---------------------------------------------------------------------------

// #ac-2.1 — an absolution at a DIVERGENT sha (not an ancestor of HEAD) is treated as absent.
test("#ac-2.1 matchesAbsolution: divergent-sha absolution (isAncestor false) → absent (no match)", () => {
  assert.equal(matchesAbsolution("feat/t", ["feat/t@X"], () => false), false);
});

// Healthy-run guard (CRITICAL) — an absolution earned at an ANCESTOR sha still matches after HEAD
// advances to a descendant commit (per-task commits advance HEAD; earlier absolutions must count).
test("healthy-run guard: ancestor-sha absolution (isAncestor true) → still matches (no false block)", () => {
  assert.equal(matchesAbsolution("feat/t", ["feat/t@X"], () => true), true);
});

// #ac-2.2 (reader half) — an UNqualified (legacy/no-@sha) absolution is treated as absent.
test("#ac-2.2 matchesAbsolution: unqualified legacy absolution → absent even with isAncestor true", () => {
  assert.equal(matchesAbsolution("feat/t", ["feat/t"], () => true), false);
});

test("matchesAbsolution: undetermined ancestry (isAncestor null) → absent (fail-safe)", () => {
  assert.equal(matchesAbsolution("feat/t", ["feat/t@X"], () => null), false);
});

test("matchesAbsolution: prefix must match exactly (a different task's absolution never matches)", () => {
  assert.equal(matchesAbsolution("feat/t", ["feat/other@X"], () => true), false);
});

test("matchesAbsolution: a throwing isAncestorFn is swallowed → absent", () => {
  assert.equal(
    matchesAbsolution("feat/t", ["feat/t@X"], () => {
      throw new Error("git blew up");
    }),
    false,
  );
});

test("matchesAbsolution: one ancestor entry among several clears the obligation", () => {
  const arr = ["feat/t@stale", "feat/t@fresh"];
  // only @fresh is an ancestor
  assert.equal(matchesAbsolution("feat/t", arr, (sha) => sha === "fresh"), true);
});

test("absolutionPrefix: strips @sha; passes through an unqualified entry unchanged", () => {
  assert.equal(absolutionPrefix("feat/t@abc123"), "feat/t");
  assert.equal(absolutionPrefix("feat/t"), "feat/t");
  assert.equal(absolutionPrefix(42), "");
});

// ---------------------------------------------------------------------------
// #ac-2.2 / #ac-2.3 — resetGateState purge belt + obligation survival
// ---------------------------------------------------------------------------

test("#ac-2.2 resetGateState DROPS an unqualified absolution but keeps sha-qualified ones", () => {
  withTempDir(() => {
    const sid = "ses-purge";
    mergeGateState(sid, {
      feature_id: "feat-a",
      regate_pending: ["feat-a/t1", "feat-a/t2"],
      regate_passed: ["feat-a/t1", "feat-a/t2@abc123"], // t1 legacy-unqualified, t2 qualified
      capture_verified: ["feat-a/t3"], // legacy-unqualified
      hand_finished: ["feat-a/t3"],
    });
    resetGateState(sid, "feat-a");
    const state = readGateState(sid);
    assert.deepEqual(
      state.regate_passed,
      ["feat-a/t2@abc123"],
      "the unqualified regate_passed entry must be purged; the sha-qualified one survives",
    );
    assert.deepEqual(state.capture_verified, [], "the unqualified capture_verified entry must be purged");
  });
});

test("#ac-2.3 resetGateState preserves obligations (regate_pending, hand_finished) verbatim across re-dispatch", () => {
  withTempDir(() => {
    const sid = "ses-obligation";
    mergeGateState(sid, {
      feature_id: "feat-a",
      regate_pending: ["feat-a/t1"],
      hand_finished: ["feat-a/t3"],
      regate_passed: ["feat-a/t1"], // unqualified → will be purged
    });
    resetGateState(sid, "feat-b"); // genuine re-dispatch / feature switch
    const state = readGateState(sid);
    assert.deepEqual(state.regate_pending, ["feat-a/t1"], "obligation regate_pending survives verbatim");
    assert.deepEqual(state.hand_finished, ["feat-a/t3"], "obligation hand_finished survives verbatim");
    assert.deepEqual(state.regate_passed, [], "the unqualified absolution was purged, leaving the obligation unmatched");
  });
});

// ---------------------------------------------------------------------------
// entry-gate reader wiring — the sha-qualified absolution clears the obligation
// only when its sha is an ancestor of HEAD.
// ---------------------------------------------------------------------------

// #ac-2.1 via the delivery gate (decideBash regate rail)
test("#ac-2.1 decideBash: divergent-sha regate_passed → git push denied (obligation stays unmatched)", () => {
  const payload = makeBashPayload("ses_div", "git push origin main");
  const readGateStateFn = () => ({ regate_pending: ["feat/t"], regate_passed: ["feat/t@X"] });
  const verdict = entryDecide(payload, { readGateStateFn, isAncestorFn: () => false });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("healthy-run guard via decideBash: ancestor-sha regate_passed → git push allowed", () => {
  const payload = makeBashPayload("ses_anc", "git push origin main");
  const readGateStateFn = () => ({ regate_pending: ["feat/t"], regate_passed: ["feat/t@X"] });
  const verdict = entryDecide(payload, { readGateStateFn, isAncestorFn: () => true });
  assert.equal(verdict.allow, true);
});

// #ac-2.1 for the capture rail (hand_finished / capture_verified)
test("#ac-2.1 decideBash: divergent-sha capture_verified → git push denied", () => {
  const payload = makeBashPayload("ses_capdiv", "git push origin main");
  const readGateStateFn = () => ({ hand_finished: ["feat/t"], capture_verified: ["feat/t@X"] });
  const verdict = entryDecide(payload, { readGateStateFn, isAncestorFn: () => false });
  assert.equal(verdict.allow, false);
});

test("capture rail: ancestor-sha capture_verified → git push allowed", () => {
  const payload = makeBashPayload("ses_capanc", "git push origin main");
  const readGateStateFn = () => ({ hand_finished: ["feat/t"], capture_verified: ["feat/t@X"] });
  const verdict = entryDecide(payload, { readGateStateFn, isAncestorFn: () => true });
  assert.equal(verdict.allow, true);
});

// fidelity_pass consumer stays PREFIX-lenient (sha ignored) — a sha-qualified entry still allows.
test("fidelity consumer: sha-qualified fidelity_pass entry allows the spawn-hand dispatch (prefix match)", () => {
  const payload = makeBashPayload(
    "ses_fid",
    "node .claude/skills/orchestrating-delivery/references/spawn-hand.mjs --descriptor /tmp/d.json",
  );
  const readDescriptorFn = () => ({ feature_id: "F", task_id: "T" });
  const readGateStateFn = () => ({ fidelity_pass: ["F/T@abc123"] });
  const verdict = entryDecide(payload, { readDescriptorFn, readGateStateFn });
  assert.equal(verdict.allow, true, "sha-qualified fidelity_pass must still authorize the spawn (prefix match)");
});

// ---------------------------------------------------------------------------
// stamp-triage — the STAMP is sha-qualified when a sha is available, unqualified fallback otherwise.
// ---------------------------------------------------------------------------

test("stamp: regate-passed is stored sha-qualified when a HEAD sha is available", () => {
  withTempDir(() => {
    const sid = "ses_stamp_rp";
    stampHandle(makeMarkerPayload(sid, "regate-pending", "my-feature", "task-1"));
    stampHandle(makeMarkerPayload(sid, "regate-passed", "my-feature", "task-1"), { headShaFn: () => "deadbeef" });
    const state = readGateState(sid);
    assert.deepEqual(state.regate_passed, ["my-feature/task-1@deadbeef"]);
  });
});

test("stamp: null HEAD sha falls back to the UNqualified id (non-git env still works)", () => {
  withTempDir(() => {
    const sid = "ses_stamp_null";
    stampHandle(makeMarkerPayload(sid, "regate-pending", "my-feature", "task-1"));
    stampHandle(makeMarkerPayload(sid, "regate-passed", "my-feature", "task-1"), { headShaFn: () => null });
    const state = readGateState(sid);
    assert.deepEqual(state.regate_passed, ["my-feature/task-1"]);
  });
});

test("stamp: fidelity-pass is stored sha-qualified when a HEAD sha is available", () => {
  withTempDir(() => {
    const sid = "ses_stamp_fp";
    const payload = {
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: "node .claude/hooks/mark.mjs fidelity-pass --feature-id F --task-id T" },
      tool_response: JSON.stringify({ marker: "fidelity-pass", feature_id: "F", task_id: "T" }),
    };
    stampHandle(payload, { headShaFn: () => "cafe01" });
    const state = readGateState(sid);
    assert.deepEqual(state.fidelity_pass, ["F/T@cafe01"]);
  });
});

test("stamp: same-sha re-stamp of regate-passed is idempotent (no duplicate entry)", () => {
  withTempDir(() => {
    const sid = "ses_stamp_idem";
    stampHandle(makeMarkerPayload(sid, "regate-pending", "my-feature", "task-1"));
    stampHandle(makeMarkerPayload(sid, "regate-passed", "my-feature", "task-1"), { headShaFn: () => "sha1" });
    stampHandle(makeMarkerPayload(sid, "regate-passed", "my-feature", "task-1"), { headShaFn: () => "sha1" });
    const state = readGateState(sid);
    assert.deepEqual(state.regate_passed, ["my-feature/task-1@sha1"]);
  });
});

test("stamp: a NEW sha after a re-dispatch adds a fresh regate_passed entry (both retained)", () => {
  withTempDir(() => {
    const sid = "ses_stamp_newsha";
    stampHandle(makeMarkerPayload(sid, "regate-pending", "my-feature", "task-1"));
    stampHandle(makeMarkerPayload(sid, "regate-passed", "my-feature", "task-1"), { headShaFn: () => "sha1" });
    stampHandle(makeMarkerPayload(sid, "regate-passed", "my-feature", "task-1"), { headShaFn: () => "sha2" });
    const state = readGateState(sid);
    assert.deepEqual(state.regate_passed, ["my-feature/task-1@sha1", "my-feature/task-1@sha2"]);
  });
});
