/** @description Locked tests for real-file capture rail (OC + CC shapes). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRealFileCaptureRail } from "./real-file-capture-rail.mjs";

const ancTrue = () => true;
const ancFalse = () => false;
const ancNull = () => null;

function listOf(...records) {
  return () => records;
}

test("OC string DONE without stamp → deny capturedVerifiedAt + task-id", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: { outcome: "DONE", freezeCommitSha: "abc" },
    }),
    isAncestorFn: ancTrue,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /feat\/t1/);
  assert.match(d.reason, /capturedVerifiedAt/);
});

test("OC DONE + valid stamp + empty violations → null allow", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: {
        outcome: "DONE",
        freezeCommitSha: "abc",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        scopeViolations: [],
        frozenViolations: [],
      },
    }),
    isAncestorFn: ancTrue,
  });
  assert.equal(d, null);
});

test("OC DONE + stamp + root scopeViolations → SCOPE/FROZEN deny", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: {
        outcome: "DONE",
        freezeCommitSha: "abc",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        scopeViolations: ["x"],
      },
    }),
    isAncestorFn: ancTrue,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /SCOPE\/FROZEN/);
  assert.equal(d.reason.includes("capturedVerifiedAt missing"), false);
});

test("OC DONE + stamp + root frozenViolations → hard-stop", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: {
        outcome: "DONE",
        freezeCommitSha: "abc",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        frozenViolations: ["y"],
      },
    }),
    isAncestorFn: ancTrue,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /SCOPE\/FROZEN/);
});

test("CC nested DONE without stamp → deny", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: {
        outcome: { status: "DONE", scopeViolations: [], frozenViolations: [] },
        freezeCommitSha: "abc",
      },
    }),
    isAncestorFn: ancTrue,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /capturedVerifiedAt/);
});

test("CC nested DONE + nested scopeViolations → hard-stop", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: {
        outcome: {
          status: "DONE",
          scopeViolations: ["leak"],
          frozenViolations: [],
        },
        freezeCommitSha: "abc",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
      },
    }),
    isAncestorFn: ancTrue,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /SCOPE\/FROZEN/);
});

test("isDone without freezeCommitSha → deny unresolved-freeze", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: { outcome: "DONE" },
    }),
    isAncestorFn: ancTrue,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /unresolved-freeze/);
});

test("isDone with empty freezeCommitSha → deny unresolved-freeze", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: { outcome: "DONE", freezeCommitSha: "" },
    }),
    isAncestorFn: ancTrue,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /unresolved-freeze/);
});

test("DONE + empty-string capturedVerifiedAt → deny missing stamp", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: {
        outcome: "DONE",
        freezeCommitSha: "abc",
        capturedVerifiedAt: "",
      },
    }),
    isAncestorFn: ancTrue,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /capturedVerifiedAt/);
});

test("FAILED + scope violations + freeze ancestor → hard-stop without isDone", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: {
        outcome: "FAILED",
        freezeCommitSha: "abc",
        scopeViolations: ["out"],
      },
    }),
    isAncestorFn: ancTrue,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /SCOPE\/FROZEN/);
});

test("DONE missing stamp but isAncestor null → deny ancestor-undetermined", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: { outcome: "DONE", freezeCommitSha: "abc" },
    }),
    isAncestorFn: ancNull,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /ancestor-undetermined/);
  assert.match(d.reason, /feat\/t1/);
});

test("DONE + scope + isAncestor null → deny ancestor-undetermined", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: {
        outcome: "DONE",
        freezeCommitSha: "abc",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        scopeViolations: ["leak"],
      },
    }),
    isAncestorFn: ancNull,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /ancestor-undetermined/);
});

test("DONE missing stamp but isAncestor false → skip abandoned lineage", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      record: { outcome: "DONE", freezeCommitSha: "abc" },
    }),
    isAncestorFn: ancFalse,
  });
  assert.equal(d, null);
});

test("listFn throws → deny real-file-list-unavailable (not empty allow)", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: () => {
      throw new Error("boom");
    },
    isAncestorFn: ancTrue,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /real-file-list-unavailable/);
});

test("requireCaptureEvidence + empty list → deny real-file-no-capture-evidence", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: () => [],
    isAncestorFn: ancTrue,
    requireCaptureEvidence: true,
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /real-file-no-capture-evidence/);
});

test("empty list without requireCaptureEvidence → null allow", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: () => [],
    isAncestorFn: ancTrue,
  });
  assert.equal(d, null);
});

test("requireCaptureEvidence + requiredSessionId: other-session only → deny", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      sessionId: "other_ses",
      record: {
        outcome: "DONE",
        freezeCommitSha: "abc",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        scopeViolations: [],
        frozenViolations: [],
      },
    }),
    isAncestorFn: ancTrue,
    requireCaptureEvidence: true,
    requiredSessionId: "current_ses",
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /real-file-no-capture-evidence/);
  assert.match(d.reason, /current_ses/);
});

test("requireCaptureEvidence + requiredSessionId: current session DONE stamp → null allow", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      sessionId: "current_ses",
      record: {
        outcome: "DONE",
        freezeCommitSha: "abc",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        scopeViolations: [],
        frozenViolations: [],
      },
    }),
    isAncestorFn: ancTrue,
    requireCaptureEvidence: true,
    requiredSessionId: "current_ses",
  });
  assert.equal(d, null);
});

test("requiredSessionId: other-session DONE without stamp still hard-stop", () => {
  const d = checkRealFileCaptureRail("feat", {
    listHandRecordsForFeatureFn: listOf({
      taskId: "t1",
      sessionId: "other_ses",
      record: { outcome: "DONE", freezeCommitSha: "abc" },
    }),
    isAncestorFn: ancTrue,
    requireCaptureEvidence: true,
    requiredSessionId: "current_ses",
  });
  assert.equal(d?.decision, "deny");
  assert.match(d.reason, /capturedVerifiedAt/);
});
