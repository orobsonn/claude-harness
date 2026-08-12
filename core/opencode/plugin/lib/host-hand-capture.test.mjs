/** @description Host completion producer keeps capture independent. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as hostHandCapture from "./host-hand-capture.mjs";

test("gitTouchedPaths reports only the current hand delta, never recent committed history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-touched-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init");
    git("config", "user.email", "harness@example.invalid");
    git("config", "user.name", "Harness Test");
    fs.writeFileSync(path.join(root, "historical.txt"), "old\n");
    git("add", "historical.txt");
    git("commit", "-m", "historical");
    fs.writeFileSync(path.join(root, "historical.txt"), "committed\n");
    git("add", "historical.txt");
    git("commit", "-m", "recent history");
    fs.writeFileSync(path.join(root, "dirty.txt"), "current hand\n");
    fs.writeFileSync(path.join(root, "historical.txt"), "current hand edit\n");
    assert.deepEqual(hostHandCapture.gitTouchedPaths(root).sort(), ["dirty.txt", "historical.txt"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveHeadSha uses only its explicit project root and fails best-effort", () => {
  const calls = [];
  assert.equal(hostHandCapture.resolveHeadSha("/explicit", (command, args, options) => {
    calls.push({ command, args, options });
    return " abc123 \n";
  }), "abc123");
  assert.deepEqual(calls, [{ command: "git", args: ["rev-parse", "HEAD"], options: { cwd: "/explicit", encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 } }]);
  assert.equal(hostHandCapture.resolveHeadSha("/explicit", () => { throw new Error("no git"); }), null);
});

test("isAncestorSha distinguishes ancestral, divergent, and unavailable git facts", () => {
  assert.equal(hostHandCapture.isAncestorSha("/explicit", "abc", () => ""), true);
  assert.equal(hostHandCapture.isAncestorSha("/explicit", "abc", () => { throw Object.assign(new Error("diverged"), { status: 1 }); }), false);
  assert.equal(hostHandCapture.isAncestorSha("/explicit", "abc", () => { throw new Error("git missing"); }), null);
});

test("resolveOcHandOutcome never promotes non-DONE output from unrelated git evidence", () => {
  assert.equal(hostHandCapture.resolveOcHandOutcome("BLOCKED", ["src/a.ts"]), "BLOCKED");
  assert.equal(hostHandCapture.resolveOcHandOutcome(null, ["src/a.ts"]), "BLOCKED");
  assert.equal(hostHandCapture.resolveOcHandOutcome("NEEDS_CONTEXT", ["src/a.ts"]), "NEEDS_CONTEXT");
  assert.equal(hostHandCapture.resolveOcHandOutcome("DONE", []), "DONE");
  assert.equal(hostHandCapture.resolveOcHandOutcome("BLOCKED", []), "BLOCKED");
  assert.equal(hostHandCapture.resolveOcHandOutcome(null, [], "Maximum steps reached"), "CAPACITY_EXHAUSTED");
});

function seedDispatch(root, { sessionId, featureId, taskId, role, callId, claimedAt = "2026-08-01T00:00:00.000Z", worktreeBaseline, frozenPaths = [] }) {
  const directory = path.join(root, ".opencode", "plans", ".state", sessionId, "dispatch-records");
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${crypto.createHash("sha256").update(callId).digest("hex")}.json`;
  fs.writeFileSync(path.join(directory, filename), JSON.stringify({
    parent_session_id: sessionId, dispatch_call_id: callId, child_session_id: null,
    feature_id: featureId, task_id: taskId, role, scope_paths: ["src/a.ts"],
    allowed_writes: [], frozen_paths: frozenPaths, snapshot_hash: "a".repeat(64), claimed_at: claimedAt,
    ...(worktreeBaseline ? { worktree_baseline: worktreeBaseline } : {}),
  }));
}

test("recordTaskCompletion ignores unchanged files that predate this exact dispatch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-dispatch-baseline-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init");
    git("config", "user.email", "harness@example.invalid");
    git("config", "user.name", "Harness Test");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, ".gitignore"), ".opencode/plans/.state/\n");
    git("add", "src/a.ts", ".gitignore");
    git("commit", "-m", "baseline");

    fs.writeFileSync(path.join(root, "MEMORY.md"), "pre-existing harness memory\n");
    fs.writeFileSync(path.join(root, "kaizen.md"), "pre-existing harness notes\n");
    const fingerprint = (relativePath) => {
      const absolute = path.join(root, relativePath);
      const bytes = fs.readFileSync(absolute);
      return { kind: "file", mode: fs.lstatSync(absolute).mode & 0o777, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    };
    const worktreeBaseline = {
      version: 1,
      entries: [
        { path: "MEMORY.md", fingerprint: fingerprint("MEMORY.md") },
        { path: "kaizen.md", fingerprint: fingerprint("kaizen.md") },
      ],
    };

    const sessionId = "ses_baseline";
    const featureId = "feat-baseline";
    const taskId = "task-1";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "call-baseline", worktreeBaseline });

    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const value = 2;\n");
    const result = hostHandCapture.recordTaskCompletion({
      projectRoot: root,
      sessionId,
      featureId,
      taskId,
      role: "executor-low",
      producerCallId: "call-baseline",
      outputText: "## Status: DONE",
    });

    assert.equal(result.ok, true);
    assert.equal(result.capturePending, true, JSON.stringify(result));
    const recordPath = path.join(root, ".opencode", "plans", ".state", "hand-records", featureId, sessionId, `${taskId}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.deepEqual(record.touchedPaths, ["src/a.ts"]);
    assert.deepEqual(record.scopeViolations, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recordHandFinished stamps only completion and leaves capture unverified", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-finished-"));
  try {
    const sessionId = "ses_finished";
    const featureId = "feat-finished";
    const taskId = "task-1";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-medium", callId: "call-new" });
    assert.equal(typeof hostHandCapture.recordHandFinished, "function");
    const result = hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-medium", producerCallId: "call-new", outcome: "DONE", touchedPaths: ["src/a.ts"], freezeCommitSha: "abc123" });
    assert.deepEqual(result, { ok: true, recorded: true });
    const record = JSON.parse(fs.readFileSync(path.join(root, ".opencode", "plans", ".state", "hand-records", featureId, sessionId, `${taskId}.json`), "utf8"));
    assert.equal(record.producerCallId, "call-new");
    assert.equal(record.producerClaimedAt, "2026-08-01T00:00:00.000Z");
    assert.equal(record.writtenBy, "host-hand-finished");
    assert.equal(record.capturedVerifiedAt, undefined);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"));
    assert.deepEqual(state.hand_finished, [`${featureId}/${taskId}`]);
    assert.equal(state.capture_verified, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("completion without the exact producer record is rejected without a gate stamp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-unproven-"));
  try {
    const sessionId = "ses_unproven";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: "feat-unproven" }));
    const result = hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId: "feat-unproven", taskId: "task-1", role: "executor-low", producerCallId: "absent", outcome: "DONE", touchedPaths: [], freezeCommitSha: null });
    assert.equal(result.ok, false);
    assert.equal(result.recorded, false);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"));
    assert.equal(state.hand_finished, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("newer producer replaces older producer while an older retry cannot overwrite it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-producer-order-"));
  try {
    const sessionId = "ses_order";
    const featureId = "feat-order";
    const taskId = "task-1";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "older", claimedAt: "2026-08-01T00:00:00.000Z" });
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "newer", claimedAt: "2026-08-01T00:01:00.000Z" });
    assert.equal(hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "older", outcome: "DONE", touchedPaths: ["old.ts"], freezeCommitSha: "old" }).recorded, true);
    assert.equal(hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "newer", outcome: "DONE", touchedPaths: ["new.ts"], freezeCommitSha: "new" }).recorded, true);
    assert.equal(hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "older", outcome: "DONE", touchedPaths: ["retry.ts"], freezeCommitSha: "retry" }).recorded, false);
    const record = JSON.parse(fs.readFileSync(path.join(root, ".opencode", "plans", ".state", "hand-records", featureId, sessionId, `${taskId}.json`), "utf8"));
    assert.equal(record.producerCallId, "newer");
    assert.deepEqual(record.touchedPaths, ["new.ts"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a newer non-DONE producer removes an obsolete bare completion stamp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-stamp-order-"));
  try {
    const sessionId = "ses_stamp";
    const featureId = "feat-stamp";
    const taskId = "task-1";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "done", claimedAt: "2026-08-01T00:00:00.000Z" });
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "blocked", claimedAt: "2026-08-01T00:01:00.000Z" });
    hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "done", outcome: "DONE", touchedPaths: [], freezeCommitSha: null });
    hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "blocked", outcome: "BLOCKED", touchedPaths: [], freezeCommitSha: null });
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"));
    assert.deepEqual(state.hand_finished, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("same-producer contradictory replay keeps the completion record byte-stable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-same-producer-"));
  try {
    const sessionId = "ses_same";
    const featureId = "feat-same";
    const taskId = "task-1";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "same" });
    assert.equal(hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "same", outcome: "DONE", touchedPaths: ["src/a.ts"], freezeCommitSha: "done" }).recorded, true);
    const recordPath = path.join(root, ".opencode", "plans", ".state", "hand-records", featureId, sessionId, `${taskId}.json`);
    const before = fs.readFileSync(recordPath);
    const replay = hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "same", outcome: "BLOCKED", touchedPaths: ["src/other.ts"], freezeCommitSha: "blocked" });
    assert.equal(replay.recorded, false);
    assert.deepEqual(fs.readFileSync(recordPath), before);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8")).hand_finished, [`${featureId}/${taskId}`]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("same-producer retry repairs a missing bare completion stamp without rewriting the record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-repair-stamp-"));
  try {
    const sessionId = "ses_repair";
    const featureId = "feat-repair";
    const taskId = "task-1";
    const statePath = path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "repair" });
    hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "repair", outcome: "DONE", touchedPaths: [], freezeCommitSha: "done" });
    const recordPath = path.join(root, ".opencode", "plans", ".state", "hand-records", featureId, sessionId, `${taskId}.json`);
    const before = fs.readFileSync(recordPath);
    fs.writeFileSync(statePath, JSON.stringify({ session_id: sessionId, feature_id: featureId, hand_finished: [] }));
    const retry = hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "repair", outcome: "BLOCKED", touchedPaths: ["src/other.ts"], freezeCommitSha: "blocked" });
    assert.equal(retry.recorded, false);
    assert.deepEqual(fs.readFileSync(recordPath), before);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).hand_finished, [`${featureId}/${taskId}`]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("capturePending belongs only to the producer that owns the persisted DONE record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-pending-owner-"));
  try {
    const sessionId = "ses_pending";
    const featureId = "feat-pending";
    const taskId = "task-1";
    const statePath = path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "older", claimedAt: "2026-08-01T00:00:00.000Z" });
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "newer", claimedAt: "2026-08-01T00:01:00.000Z" });
    const base = { projectRoot: root, sessionId, featureId, taskId, role: "executor-low" };
    assert.equal(hostHandCapture.recordTaskCompletion({ ...base, producerCallId: "newer", outputText: "Status: DONE" }).capturePending, true);
    assert.equal(hostHandCapture.recordTaskCompletion({ ...base, producerCallId: "older", outputText: "Status: DONE" }).capturePending, false);
    assert.equal(hostHandCapture.recordTaskCompletion({ ...base, producerCallId: "newer", outputText: "Status: BLOCKED" }).capturePending, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("DONE_WITH_CONCERNS records a capture-eligible completion stamp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-concerns-"));
  try {
    const sessionId = "ses_concerns";
    const featureId = "feat-concerns";
    const taskId = "task-1";
    const statePath = path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "concerns" });
    const result = hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "concerns", outcome: "DONE_WITH_CONCERNS", touchedPaths: [], freezeCommitSha: null });
    assert.equal(result.recorded, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).hand_finished, [`${featureId}/${taskId}`]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("DONE_WITH_CONCERNS keeps its exact producer pending for parent capture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-concerns-pending-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init");
    git("config", "user.email", "harness@example.invalid");
    git("config", "user.name", "Harness Test");
    fs.writeFileSync(path.join(root, "anchor.txt"), "anchor\n");
    fs.writeFileSync(path.join(root, ".gitignore"), ".opencode/plans/.state/\n");
    git("add", "anchor.txt", ".gitignore");
    git("commit", "-m", "anchor");
    const sessionId = "ses_concerns_pending";
    const featureId = "feat-concerns-pending";
    const taskId = "task-1";
    const statePath = path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "concerns-pending" });
    const result = hostHandCapture.recordTaskCompletion({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "concerns-pending", outputText: "## Status: DONE_WITH_CONCERNS" });
    assert.equal(result.capturePending, true, JSON.stringify(result));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("DONE_WITH_CONCERNS with a frozen mutation is still downgraded and never stamps completion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-concerns-frozen-"));
  try {
    const sessionId = "ses_concerns_frozen";
    const featureId = "feat-concerns-frozen";
    const taskId = "task-1";
    const statePath = path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "concerns-frozen", frozenPaths: ["tests/oracle.test.mjs"] });
    hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "concerns-frozen", outcome: "DONE_WITH_CONCERNS", touchedPaths: ["tests/oracle.test.mjs"], freezeCommitSha: "done" });
    const record = JSON.parse(fs.readFileSync(path.join(root, ".opencode", "plans", ".state", "hand-records", featureId, sessionId, `${taskId}.json`), "utf8"));
    assert.equal(record.outcome, "BLOCKED");
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).hand_finished, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a frozen-path mutation downgrades a claimed DONE hand and never stamps completion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-frozen-"));
  try {
    const sessionId = "ses_frozen";
    const featureId = "feat-frozen";
    const taskId = "task-1";
    const statePath = path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ session_id: sessionId, feature_id: featureId }));
    seedDispatch(root, { sessionId, featureId, taskId, role: "executor-low", callId: "frozen", frozenPaths: ["tests/oracle.test.mjs"] });
    const result = hostHandCapture.recordHandFinished({ projectRoot: root, sessionId, featureId, taskId, role: "executor-low", producerCallId: "frozen", outcome: "DONE", touchedPaths: ["tests/oracle.test.mjs"], freezeCommitSha: "done" });
    assert.equal(result.recorded, true);
    const record = JSON.parse(fs.readFileSync(path.join(root, ".opencode", "plans", ".state", "hand-records", featureId, sessionId, `${taskId}.json`), "utf8"));
    assert.equal(record.outcome, "BLOCKED");
    assert.deepEqual(record.frozenViolations, ["tests/oracle.test.mjs"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).hand_finished, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
