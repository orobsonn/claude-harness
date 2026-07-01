/**
 * @description Tests for gate-lib.mjs validators, helpers, and gate-state I/O.
 * Run with: node --test core/hooks/lib/gate-lib.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSafeFeatureId,
  isSafeSessionId,
  VALID_MODES,
  isDeliveryRole,
  stateDirFor,
  isExpired,
  gateStatePathFor,
  readGateState,
  mergeGateState,
  resetGateState,
  bareRole,
  handRecordPathFor,
  readHandRecord,
  listHandRecordsForFeature,
  markHandRecordCaptured,
} from "./gate-lib.mjs";

/**
 * Runs fn inside a fresh OS tmpdir, chdir'd to it, then restores cwd and removes the dir.
 * All gate-state I/O helpers use relative paths resolved from cwd, so this isolation
 * approach avoids polluting the repo's .claude/plans/ during tests.
 * Safe for synchronous tests: sync code runs atomically on the event loop — no interleave.
 * @param {() => void} fn - Synchronous test body to run inside the temp dir
 */
function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lib-test-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    fn();
  } finally {
    process.chdir(savedCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("handRecordPathFor nests the record under a per-feature directory: <feature>/<task>.json", () => {
  assert.strictEqual(
    handRecordPathFor("my-feature/task-1"),
    path.join(".claude/plans/.state/hand-records", "my-feature", "task-1.json")
  );
});

test("listHandRecordsForFeature returns [] when the feature directory does not exist", () => {
  withTempDir(() => {
    assert.deepStrictEqual(listHandRecordsForFeature("no-such-feature"), []);
  });
});

test("listHandRecordsForFeature lists every task record under a feature directory", () => {
  withTempDir(() => {
    const p1 = handRecordPathFor("feat-x/task-1");
    const p2 = handRecordPathFor("feat-x/task-2");
    fs.mkdirSync(path.dirname(p1), { recursive: true });
    fs.writeFileSync(p1, JSON.stringify({ outcome: { status: "DONE" } }));
    fs.writeFileSync(p2, JSON.stringify({ outcome: { status: "FAILED" } }));
    const records = listHandRecordsForFeature("feat-x");
    assert.strictEqual(records.length, 2);
    const byTaskId = Object.fromEntries(records.map((r) => [r.taskId, r.record]));
    assert.strictEqual(byTaskId["task-1"].outcome.status, "DONE");
    assert.strictEqual(byTaskId["task-2"].outcome.status, "FAILED");
  });
});

test("listHandRecordsForFeature skips a garbage JSON file instead of throwing", () => {
  withTempDir(() => {
    const p1 = handRecordPathFor("feat-y/task-1");
    fs.mkdirSync(path.dirname(p1), { recursive: true });
    fs.writeFileSync(p1, "{not json");
    assert.deepStrictEqual(listHandRecordsForFeature("feat-y"), []);
  });
});

test("markHandRecordCaptured returns false and writes nothing when no record exists", () => {
  withTempDir(() => {
    assert.strictEqual(markHandRecordCaptured("ghost/task-1", "2026-07-01T00:00:00.000Z"), false);
    assert.strictEqual(fs.existsSync(handRecordPathFor("ghost/task-1")), false);
  });
});

test("markHandRecordCaptured stamps capturedVerifiedAt onto an existing record without losing other fields", () => {
  withTempDir(() => {
    const p = handRecordPathFor("feat-z/task-1");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ outcome: { status: "DONE" } }));
    assert.strictEqual(markHandRecordCaptured("feat-z/task-1", "2026-07-01T00:00:00.000Z"), true);
    const updated = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(updated.capturedVerifiedAt, "2026-07-01T00:00:00.000Z");
    assert.strictEqual(updated.outcome.status, "DONE");
  });
});

test("readHandRecord returns null when no record on disk", () => {
  withTempDir(() => {
    assert.strictEqual(readHandRecord("feat/missing"), null);
  });
});

test("readHandRecord parses a written run-record by qualified id", () => {
  withTempDir(() => {
    const p = handRecordPathFor("feat/task-1");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ outcome: { status: "FAILED" }, exitCode: 1 }), "utf8");
    const rec = readHandRecord("feat/task-1");
    assert.strictEqual(rec?.outcome?.status, "FAILED");
  });
});

test("readHandRecord returns null on garbage JSON (fail-closed)", () => {
  withTempDir(() => {
    const p = handRecordPathFor("feat/task-1");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not json", "utf8");
    assert.strictEqual(readHandRecord("feat/task-1"), null);
  });
});

test("isSafeFeatureId rejects path-traversal '../etc/passwd'", () => {
  assert.strictEqual(isSafeFeatureId("../etc/passwd"), false);
});

test("isSafeFeatureId rejects 65-character kebab string (max 64)", () => {
  const longString = "a".repeat(65); // 65 chars, all valid kebab chars but exceeds length
  assert.strictEqual(isSafeFeatureId(longString), false);
});

test("isSafeFeatureId accepts 'deterministic-entry-gate'", () => {
  assert.strictEqual(isSafeFeatureId("deterministic-entry-gate"), true);
});

test("isSafeFeatureId accepts valid 64-character kebab string", () => {
  const maxLengthString = "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z-0-1-2-3-a-b"; // 64 chars
  assert.strictEqual(isSafeFeatureId(maxLengthString), true);
});

test("isSafeFeatureId rejects empty string", () => {
  assert.strictEqual(isSafeFeatureId(""), false);
});

test("isSafeFeatureId rejects non-string values", () => {
  assert.strictEqual(isSafeFeatureId(null), false);
  assert.strictEqual(isSafeFeatureId(undefined), false);
  assert.strictEqual(isSafeFeatureId(123), false);
});

test("isSafeFeatureId rejects uppercase letters", () => {
  assert.strictEqual(isSafeFeatureId("Deterministic-Entry-Gate"), false);
});

test("isSafeFeatureId rejects underscores", () => {
  assert.strictEqual(isSafeFeatureId("deterministic_entry_gate"), false);
});

test("isDeliveryRole returns true for all 9 delivery roles", () => {
  const roles = [
    "planner",
    "executor",
    "compliance",
    "adversary",
    "sniper",
    "security",
    "harvester",
    "shipper",
    "plan-reviewer",
  ];
  for (const role of roles) {
    assert.strictEqual(
      isDeliveryRole(role),
      true,
      `role '${role}' should be a delivery role`
    );
  }
});

test("isDeliveryRole returns false for non-delivery roles", () => {
  const nonDeliveryRoles = ["Explore", "claude", "general-purpose"];
  for (const role of nonDeliveryRoles) {
    assert.strictEqual(
      isDeliveryRole(role),
      false,
      `role '${role}' should NOT be a delivery role`
    );
  }
});

test("isDeliveryRole returns false for non-string values", () => {
  assert.strictEqual(isDeliveryRole(null), false);
  assert.strictEqual(isDeliveryRole(undefined), false);
  assert.strictEqual(isDeliveryRole(123), false);
});

test("VALID_MODES contains 'FULL' and 'no-ceremony'", () => {
  assert.strictEqual(VALID_MODES.has("FULL"), true);
  assert.strictEqual(VALID_MODES.has("no-ceremony"), true);
});

test("VALID_MODES contains 'LIGHT' and 'QUICK'", () => {
  assert.strictEqual(VALID_MODES.has("LIGHT"), true);
  assert.strictEqual(VALID_MODES.has("QUICK"), true);
});

test("VALID_MODES does not contain 'BOGUS'", () => {
  assert.strictEqual(VALID_MODES.has("BOGUS"), false);
});

test("VALID_MODES has size 4", () => {
  assert.strictEqual(VALID_MODES.size, 4);
});

test("isExpired returns true when mtime is 8 days before now (max age 7)", () => {
  const now = Date.now();
  const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
  assert.strictEqual(isExpired(eightDaysAgo, now, 7), true);
});

test("isExpired returns false when mtime is 6 days before now (max age 7)", () => {
  const now = Date.now();
  const sixDaysAgo = now - 6 * 24 * 60 * 60 * 1000;
  assert.strictEqual(isExpired(sixDaysAgo, now, 7), false);
});

test("isExpired returns false when mtime equals now", () => {
  const now = Date.now();
  assert.strictEqual(isExpired(now, now, 7), false);
});

test("isExpired returns true when mtime is exactly at boundary (8 days, inclusive)", () => {
  const now = Date.now();
  const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
  const atBoundary = now - eightDaysMs;
  assert.strictEqual(isExpired(atBoundary, now, 7), true);
});

test("stateDirFor returns path ending with '.claude/plans/<sessionId>'", () => {
  const sessionId = "ses_abc123";
  const result = stateDirFor(sessionId);
  assert.strictEqual(result.endsWith(".claude/plans/.state/ses_abc123"), true);
});

test("stateDirFor with different session ID", () => {
  const sessionId = "ses_xyz789";
  const result = stateDirFor(sessionId);
  assert.strictEqual(result.endsWith(".claude/plans/.state/ses_xyz789"), true);
});

test("stateDirFor returns exact path '.claude/plans/<sessionId>'", () => {
  const sessionId = "ses_test";
  const result = stateDirFor(sessionId);
  assert.strictEqual(result, ".claude/plans/.state/ses_test");
});

// ---------------------------------------------------------------------------
// Gate-state I/O tests — gateStatePathFor, readGateState, mergeGateState
// ---------------------------------------------------------------------------

test("gateStatePathFor returns path ending with gate-state.json for session", () => {
  const p = gateStatePathFor("ses_abc");
  assert.ok(p.endsWith("gate-state.json"), `expected .../gate-state.json, got: ${p}`);
  assert.ok(p.includes("ses_abc"), `expected session id in path, got: ${p}`);
});

test("readGateState returns {} for missing session dir (no throw)", () => {
  withTempDir(() => {
    const state = readGateState("ses-nonexistent");
    assert.deepStrictEqual(state, {});
  });
});

test("mergeGateState then readGateState round-trips a flag", () => {
  withTempDir(() => {
    const sid = "ses-roundtrip";
    const ok = mergeGateState(sid, { brainstormed: true });
    assert.strictEqual(ok, true, "mergeGateState should return true on success");
    const state = readGateState(sid);
    assert.strictEqual(state.brainstormed, true);
  });
});

test("mergeGateState does not drop adversary_fired when brainstormed is written second", () => {
  withTempDir(() => {
    const sid = "ses-nodrop";
    mergeGateState(sid, { brainstormed: true });
    mergeGateState(sid, { adversary_fired: true });
    const state = readGateState(sid);
    assert.strictEqual(state.brainstormed, true, "brainstormed must be retained after second write");
    assert.strictEqual(state.adversary_fired, true, "adversary_fired must be present after second write");
  });
});

test("mergeGateState leaves no .tmp file on success", () => {
  withTempDir(() => {
    const sid = "ses-notmp";
    mergeGateState(sid, { brainstormed: true });
    const tmpPath = `${gateStatePathFor(sid)}.tmp`;
    // gateStatePathFor returns a relative path — resolves from cwd (the tmpDir)
    assert.strictEqual(
      fs.existsSync(tmpPath),
      false,
      "no .tmp leftover should remain after a successful atomic write"
    );
  });
});

test("readGateState returns {} when gate-state.json contains corrupt JSON", () => {
  withTempDir(() => {
    const sid = "ses-corrupt-json";
    const stateDir = stateDirFor(sid);
    const statePath = gateStatePathFor(sid);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath, "{not json", "utf8");
    const state = readGateState(sid);
    assert.deepStrictEqual(state, {});
  });
});

test("readGateState returns {} when gate-state.json is valid JSON but not an object", () => {
  withTempDir(() => {
    const sid = "ses-json-notobj";
    const stateDir = stateDirFor(sid);
    const statePath = gateStatePathFor(sid);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath, "[]", "utf8");
    const state = readGateState(sid);
    assert.deepStrictEqual(state, {});
  });
});

test("mergeGateState returns false when write cannot succeed (parent is file, not dir)", () => {
  withTempDir(() => {
    const sid = "ses-conflict";
    fs.mkdirSync(".claude/plans", { recursive: true });
    // Make the .state parent a FILE so mkdir of the per-session state dir fails.
    fs.writeFileSync(".claude/plans/.state", "I am a file", "utf8");
    const ok = mergeGateState(sid, { test: true });
    assert.strictEqual(ok, false);
  });
});

// ---------------------------------------------------------------------------
// isSafeSessionId tests (Fix 1: unified validator)
// ---------------------------------------------------------------------------

test("isSafeSessionId accepts 'ses_abc-123'", () => {
  assert.strictEqual(isSafeSessionId("ses_abc-123"), true);
});

test("isSafeSessionId rejects path-traversal '../../evil'", () => {
  assert.strictEqual(isSafeSessionId("../../evil"), false);
});

test("isSafeSessionId rejects 'a/b' (path separator)", () => {
  assert.strictEqual(isSafeSessionId("a/b"), false);
});

test("isSafeSessionId rejects 'a.b' (dot)", () => {
  assert.strictEqual(isSafeSessionId("a.b"), false);
});

test("isSafeSessionId rejects empty string", () => {
  assert.strictEqual(isSafeSessionId(""), false);
});

test("isSafeSessionId rejects non-string values", () => {
  assert.strictEqual(isSafeSessionId(null), false);
  assert.strictEqual(isSafeSessionId(undefined), false);
  assert.strictEqual(isSafeSessionId(123), false);
});

// ---------------------------------------------------------------------------
// isDeliveryRole namespace-prefix tests (Fix 2: plugin-distribution defense)
// ---------------------------------------------------------------------------

test("isDeliveryRole: 'harness:planner' → true (namespace prefix stripped)", () => {
  assert.strictEqual(isDeliveryRole("harness:planner"), true);
});

test("isDeliveryRole: 'planner' → true (no namespace, unchanged behavior)", () => {
  assert.strictEqual(isDeliveryRole("planner"), true);
});

test("isDeliveryRole: 'harness:general-purpose' → false (non-delivery even with namespace)", () => {
  assert.strictEqual(isDeliveryRole("harness:general-purpose"), false);
});

// ---------------------------------------------------------------------------
// bareRole tests (Fix 2: namespaced role parity)
// ---------------------------------------------------------------------------

test("bareRole: 'harness:planner' → 'planner' (segment after last colon)", () => {
  assert.strictEqual(bareRole("harness:planner"), "planner");
});

test("bareRole: 'planner' → 'planner' (no colon, unchanged)", () => {
  assert.strictEqual(bareRole("planner"), "planner");
});

test("bareRole: 'a:b:adversary' → 'adversary' (last segment only)", () => {
  assert.strictEqual(bareRole("a:b:adversary"), "adversary");
});

test("bareRole: non-string passes through unchanged", () => {
  assert.strictEqual(bareRole(null), null);
  assert.strictEqual(bareRole(undefined), undefined);
  assert.strictEqual(bareRole(123), 123);
});

// ---------------------------------------------------------------------------
// resetGateState tests (Fix 1: per-feature ceremony reset)
// ---------------------------------------------------------------------------

test("resetGateState OVERWRITES gate-state with exactly { feature_id } (drops stale flags)", () => {
  withTempDir(() => {
    const sid = "ses-reset";
    mergeGateState(sid, { brainstormed: true, adversary_fired: true, feature_id: "old-feat" });
    const ok = resetGateState(sid, "new-feat");
    assert.strictEqual(ok, true, "resetGateState should return true on success");
    const state = readGateState(sid);
    assert.deepStrictEqual(state, { feature_id: "new-feat" });
    assert.strictEqual(state.brainstormed, undefined, "stale brainstormed must be gone");
    assert.strictEqual(state.adversary_fired, undefined, "stale adversary_fired must be gone");
  });
});

test("resetGateState leaves no .tmp file on success", () => {
  withTempDir(() => {
    const sid = "ses-reset-notmp";
    resetGateState(sid, "feat");
    const tmpPath = `${gateStatePathFor(sid)}.${process.pid}.tmp`;
    assert.strictEqual(fs.existsSync(tmpPath), false, "no pid-suffixed .tmp should remain");
  });
});

test("resetGateState returns false when write cannot succeed (parent is file, not dir)", () => {
  withTempDir(() => {
    const sid = "ses-reset-conflict";
    fs.mkdirSync(".claude/plans", { recursive: true });
    // Make the .state parent a FILE so mkdir of the per-session state dir fails.
    fs.writeFileSync(".claude/plans/.state", "I am a file", "utf8");
    assert.strictEqual(resetGateState(sid, "feat"), false);
  });
});

test("resetGateState on SAME feature preserves regate_pending/regate_passed (delivery-blocking rail survives reclassify)", () => {
  withTempDir(() => {
    const sid = "ses-reset-samefeat";
    mergeGateState(sid, {
      feature_id: "feat-x",
      brainstormed: true,
      adversary_fired: true,
      regate_pending: ["task-1"],
      regate_passed: [],
    });
    const ok = resetGateState(sid, "feat-x"); // SAME feature reclassify
    assert.strictEqual(ok, true);
    const state = readGateState(sid);
    assert.strictEqual(state.feature_id, "feat-x");
    assert.deepStrictEqual(state.regate_pending, ["task-1"], "regate_pending must survive same-feature reset");
    assert.deepStrictEqual(state.regate_passed, [], "regate_passed must survive same-feature reset");
    assert.strictEqual(state.brainstormed, undefined, "ceremony flags are still cleared on reclassify");
    assert.strictEqual(state.adversary_fired, undefined, "ceremony flags are still cleared on reclassify");
  });
});

test("resetGateState on a DIFFERENT feature PRESERVES regate markers (session-scoped obligation survives a feature switch)", () => {
  withTempDir(() => {
    const sid = "ses-reset-switchfeat";
    mergeGateState(sid, {
      feature_id: "feat-a",
      brainstormed: true,
      adversary_fired: true,
      regate_pending: ["feat-a/task-1"],
      regate_passed: [],
    });
    resetGateState(sid, "feat-b"); // genuine switch — re-gate obligation must NOT be erased
    const state = readGateState(sid);
    assert.strictEqual(state.feature_id, "feat-b");
    assert.deepStrictEqual(
      state.regate_pending,
      ["feat-a/task-1"],
      "an un-pushed grave fix's re-gate obligation survives a feature switch",
    );
    assert.deepStrictEqual(state.regate_passed, [], "regate_passed survives the switch too");
    assert.strictEqual(state.brainstormed, undefined, "per-feature ceremony flags are still cleared");
    assert.strictEqual(state.adversary_fired, undefined, "per-feature ceremony flags are still cleared");
  });
});

test("mergeGateState after resetGateState preserves feature_id (merge does not drop it)", () => {
  withTempDir(() => {
    const sid = "ses-reset-merge";
    resetGateState(sid, "feat-x");
    mergeGateState(sid, { brainstormed: true });
    const state = readGateState(sid);
    assert.strictEqual(state.feature_id, "feat-x", "feature_id must survive a later merge");
    assert.strictEqual(state.brainstormed, true);
  });
});

// adversary Finding 1: the capture rail is a session-level delivery obligation like the regate
// rail — a re-triage must NOT launder an un-captured finished hand.
test("resetGateState preserves hand_finished/capture_verified across a feature switch", () => {
  withTempDir(() => {
    const sid = "ses-reset-capture";
    mergeGateState(sid, {
      feature_id: "feat-a",
      hand_finished: ["feat-a/task-1"],
      capture_verified: [],
      brainstormed: true,
    });
    resetGateState(sid, "feat-b"); // genuine switch — the capture obligation must NOT be erased
    const state = readGateState(sid);
    assert.strictEqual(state.feature_id, "feat-b");
    assert.deepStrictEqual(
      state.hand_finished,
      ["feat-a/task-1"],
      "an un-captured finished hand's obligation survives a feature switch",
    );
    assert.deepStrictEqual(state.capture_verified, [], "capture_verified survives the switch too");
    assert.strictEqual(state.brainstormed, undefined, "per-feature ceremony flags are still cleared");
  });
});
