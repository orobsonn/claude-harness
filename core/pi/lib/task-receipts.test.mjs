import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { hashTaskReceipt } from "./task-contract.mjs";
import { inspectTaskRun, readIntegratedTaskEvidence } from "./task-receipts.mjs";

const FEATURE = "receipt-feature";
const TASK = "receipt-task";
const PARENT = "ses-receipt-parent";
const CHILD = "ses-receipt-child";
const ATTEMPT = "attempt-receipt-one";
const DIGEST = "a".repeat(64);

const roots = [];
test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function run(root, ...args) {
  return execFileSync(args[0], args.slice(1), { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function commit(root, message) {
  run(root, "git", "add", ".");
  run(root, "git", "commit", "-m", message);
  return run(root, "git", "rev-parse", "HEAD");
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-receipt-"));
  roots.push(root);
  run(root, "git", "init", "-q");
  run(root, "git", "config", "user.email", "receipt@example.test");
  run(root, "git", "config", "user.name", "Receipt Test");
  write(path.join(root, "README.md"), "base\n");
  const base = commit(root, "base");
  return { root: fs.realpathSync(root), base };
}

function review(role, head) {
  const report = { issues: [] };
  return {
    written_by: "host-subagent-completion",
    parent_session_id: CHILD,
    feature_id: FEATURE,
    task_id: TASK,
    role,
    phase: "task",
    agent_id: `agent-${role}`,
    dispatch_call_id: `call-${role}`,
    child_session_id: `child-${role}`,
    status: "completed",
    reviewed_head_sha: head,
    accepted: true,
    input_digest: DIGEST,
    report,
    report_digest: crypto.createHash("sha256").update(JSON.stringify(report)).digest("hex"),
  };
}

function event(type, fields) { return JSON.stringify({ type, ...fields }); }

function inspectionFixture({ historicFailure = false } = {}) {
  const { root, base } = repo();
  write(path.join(root, "src", "task.spec.mjs"), "export const expected = 1;\n");
  const freeze = commit(root, "freeze tests");
  write(path.join(root, "src", "task.mjs"), "export const actual = 1;\n");
  const head = commit(root, "implement task");
  const grantPath = path.join(root, ".pi", "harness", "state", "task-admission", `${ATTEMPT}.json`);
  write(`${grantPath}.claim`, { session_id: CHILD, grant_sha256: "b".repeat(64) });
  const bare = `${FEATURE}/${TASK}`;
  const state = {
    session_id: CHILD,
    feature_id: FEATURE,
    hand_finished: [bare],
    fidelity_pass: [`${bare}@${freeze}`],
    capture_verified: [`${bare}@${freeze}`],
    task_adversary_evidence: { [bare]: review("harness-adversary", head) },
    task_review_evidence: { [bare]: {
      compliance: review("harness-compliance", head),
      security: review("harness-security", head),
    } },
  };
  write(path.join(root, ".pi", "harness", "state", CHILD, "gate-state.json"), state);
  write(path.join(root, ".pi", "harness", "state", "hand-records", FEATURE, CHILD, `${TASK}.json`), {
    writtenBy: "host-hand-finished",
    featureId: FEATURE,
    taskId: TASK,
    sessionId: CHILD,
    agent: "harness-executor",
    producerCallId: "producer",
    freezeCommitSha: freeze,
    outcome: "DONE",
    scopeViolations: [],
    frozenViolations: [],
    capturedVerifiedAt: "2026-09-07T00:00:00.000Z",
  });
  const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-job-"));
  roots.push(jobRoot);
  const calls = [
    event("session", { id: CHILD }),
    event("tool_execution_start", { toolCallId: "author", toolName: "subagent", args: { subagent_type: "harness-test-author" } }),
    event("tool_execution_end", { toolCallId: "author", toolName: "subagent", isError: false, result: { details: { status: "completed" } } }),
    event("tool_execution_start", { toolCallId: "fidelity-eye", toolName: "subagent", args: { subagent_type: "harness-compliance" } }),
    event("tool_execution_end", { toolCallId: "fidelity-eye", toolName: "subagent", isError: false, result: { details: { status: "completed" } } }),
    event("tool_execution_start", { toolCallId: "freeze", toolName: "bash", args: { command: "git commit -m freeze" } }),
    event("tool_execution_end", { toolCallId: "freeze", toolName: "bash", isError: false, result: { content: [{ type: "text", text: `[task ${freeze.slice(0, 7)}] freeze` }] } }),
    event("tool_execution_start", { toolCallId: "fidelity", toolName: "mark", args: { action: "fidelity", task_id: TASK } }),
    event("tool_execution_end", { toolCallId: "fidelity", toolName: "mark", isError: false, result: { details: { ok: true } } }),
    event("tool_execution_start", { toolCallId: "producer", toolName: "subagent", args: { subagent_type: "harness-executor", prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${TASK}"}[/HARNESS_TASK_CONTEXT]` } }),
    event("tool_execution_end", { toolCallId: "producer", toolName: "subagent", isError: false, result: { details: { status: "completed" } } }),
  ];
  const makeLaunch = (runId, pid, lifecycle, eventLines = calls) => {
    const dir = path.join(jobRoot, runId);
    const launch = { run_id: runId, pid, events_path: path.join(dir, "events.jsonl"), process_path: path.join(dir, "process.json"), result_path: path.join(dir, "result.json") };
    write(launch.events_path, `${eventLines.join("\n")}\n`);
    write(launch.process_path, { version: 1, run_id: runId, pid, process_start_ticks: "1", started_at: "2026-09-07T00:00:00.000Z" });
    write(launch.result_path, { version: 1, run_id: runId, pid, ...lifecycle, ended_at: "2026-09-07T00:01:00.000Z" });
    return launch;
  };
  const launches = [];
  if (historicFailure) launches.push(makeLaunch("run-old", 999991, { exitCode: 1, signal: null, timedOut: true }, []));
  launches.push(makeLaunch("run-current", 999992, { exitCode: 0, signal: null, timedOut: false }));
  const grant = {
    task_id: TASK, attempt_id: ATTEMPT, parent_session_id: PARENT, parent_root: root,
    feature_id: FEATURE, plan_sha256: "c".repeat(64), spec_sha256: "d".repeat(64),
    base_sha: base, cwd: root, dependencies: [],
  };
  const task = { id: TASK, depends_on: [], scope_paths: ["src/"], locked_tests: [{ id: "lt-1", path: "src/task.spec.mjs", assertion: "expected behavior" }] };
  const entry = {
    task_id: TASK, attempt_id: ATTEMPT, parent_session_id: PARENT, parent_root: root,
    feature_id: FEATURE, plan_sha256: grant.plan_sha256, spec_sha256: grant.spec_sha256,
    base_sha: base, worktree: root, branch: "task/receipt", grant_path: grantPath,
    job_dir: jobRoot, status: "ready", launches, result: null, integration: null,
  };
  const dependencies = {
    readTaskRunBindingFn: () => ({ ok: true, grant, task, grantPath }),
    captureReviewInputFn: () => ({ ok: true, snapshot: { head_sha: head, input_digest: DIGEST } }),
  };
  return { root, base, freeze, head, entry, dependencies, statePath: path.join(root, ".pi", "harness", "state", CHILD, "gate-state.json") };
}

test("inspectTaskRun issues a child-bound receipt from native lifecycle, fidelity, capture and strong reviews", () => {
  const fixture = inspectionFixture({ historicFailure: true });
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.result.session_id, CHILD);
  assert.equal(inspected.result.child_head, fixture.head);
  assert.equal(inspected.result.freeze_sha, fixture.freeze);
  assert.equal(inspected.result.latest_run_id, "run-current");
  assert.deepEqual(inspected.result.changed_paths, ["src/task.mjs", "src/task.spec.mjs"]);
  assert.match(inspected.result.frozen_blobs["src/task.spec.mjs"], /^[0-9a-f]{64}$/);
});

test("inspectTaskRun rejects the latest failed continuation even when an older event stream is healthy", () => {
  const fixture = inspectionFixture();
  const last = fixture.entry.launches.at(-1);
  write(last.result_path, { version: 1, run_id: last.run_id, pid: last.pid, exitCode: 1, signal: null, timedOut: false, ended_at: "2026-09-07T00:02:00.000Z" });
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /latest task launch/i);
});

test("inspectTaskRun accepts a later repair after a dead historical worker missed its result and event files", () => {
  const fixture = inspectionFixture({ historicFailure: true });
  const old = fixture.entry.launches[0];
  fs.rmSync(old.result_path);
  fs.rmSync(old.events_path);
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.result.launches[0].interrupted, true);
  assert.equal(inspected.result.launches[0].exit_code, null);
  assert.equal(inspected.result.latest_run_id, "run-current");
});

test("inspectTaskRun accepts a later repair after a launch aborted before worker registration", () => {
  const fixture = inspectionFixture();
  const dir = path.join(fixture.entry.job_dir, "run-before-registration");
  fixture.entry.launches.unshift({
    run_id: "run-before-registration",
    pid: null,
    creator_pid: 999999998,
    creator_start_ticks: "1",
    worker_path: path.join(fixture.root, "pi-task-worker.mjs"),
    descriptor_path: path.join(dir, "job.json"),
    events_path: path.join(dir, "events.jsonl"),
    process_path: path.join(dir, "process.json"),
    result_path: path.join(dir, "result.json"),
    start_failure: { written_by: "host-task-launch", reason: "spawn failed", at: "2026-09-07T00:00:00.000Z" },
  });
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.deepEqual(inspected.result.launches[0], {
    run_id: "run-before-registration",
    pid: null,
    exit_code: null,
    signal: "UNKNOWN",
    timed_out: false,
    ended_at: null,
    interrupted: true,
    interruption_reason: "task launch aborted before worker registration",
  });
});

test("inspectTaskRun binds every launch and the receipt to the admitted runtime digest", () => {
  const fixture = inspectionFixture({ historicFailure: true });
  const runtime = { launcher_path: path.join(fixture.root, "core", "pi", "bin", "pi-harness.mjs"), sha256: "9".repeat(64) };
  fixture.entry.runtime = runtime;
  for (const launch of fixture.entry.launches) {
    launch.runtime = runtime;
    const processRecord = JSON.parse(fs.readFileSync(launch.process_path, "utf8"));
    write(launch.process_path, { ...processRecord, run_runtime_sha256: runtime.sha256 });
    const result = JSON.parse(fs.readFileSync(launch.result_path, "utf8"));
    write(launch.result_path, { ...result, run_runtime_sha256: runtime.sha256 });
  }
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.deepEqual(inspected.result.runtime, runtime);
  assert.ok(inspected.result.launches.every((launch) => launch.run_runtime_sha256 === runtime.sha256));

  fixture.entry.launches.at(-1).runtime = { ...runtime, sha256: "8".repeat(64) };
  const changed = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /runtime identity/i);
});

test("inspectTaskRun rejects a review whose input digest is stale on the same HEAD", () => {
  const fixture = inspectionFixture();
  const stale = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  stale.task_review_evidence[`${FEATURE}/${TASK}`].compliance.input_digest = "e".repeat(64);
  write(fixture.statePath, stale);
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /accepted compliance task review/i);
});

test("inspectTaskRun rejects an unstamped current capture and a foreign native producer", () => {
  const unstamped = inspectionFixture();
  const handPath = path.join(unstamped.root, ".pi", "harness", "state", "hand-records", FEATURE, CHILD, `${TASK}.json`);
  const hand = JSON.parse(fs.readFileSync(handPath, "utf8"));
  write(handPath, { ...hand, capturedVerifiedAt: null });
  const missingCapture = inspectTaskRun(unstamped.entry, unstamped.dependencies);
  assert.equal(missingCapture.ok, false);
  assert.match(missingCapture.reason, /capture is invalid/i);

  const foreign = inspectionFixture();
  const foreignPath = path.join(foreign.root, ".pi", "harness", "state", "hand-records", FEATURE, CHILD, `${TASK}.json`);
  const foreignHand = JSON.parse(fs.readFileSync(foreignPath, "utf8"));
  write(foreignPath, { ...foreignHand, producerCallId: "call-not-in-native-events" });
  const wrongProducer = inspectTaskRun(foreign.entry, foreign.dependencies);
  assert.equal(wrongProducer.ok, false);
  assert.match(wrongProducer.reason, /producer.*native call/i);
});

test("inspectTaskRun rejects cumulative changes outside the canonical task scope", () => {
  const fixture = inspectionFixture();
  write(path.join(fixture.root, "outside.txt"), "outside\n");
  run(fixture.root, "git", "add", "outside.txt");
  run(fixture.root, "git", "commit", "-m", "outside task scope");
  const outsideHead = run(fixture.root, "git", "rev-parse", "HEAD");
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  for (const receipt of [state.task_adversary_evidence[`${FEATURE}/${TASK}`], ...Object.values(state.task_review_evidence[`${FEATURE}/${TASK}`])]) receipt.reviewed_head_sha = outsideHead;
  write(fixture.statePath, state);
  fixture.dependencies.captureReviewInputFn = () => ({ ok: true, snapshot: { head_sha: outsideHead, input_digest: DIGEST } });
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /outside canonical scope/i);
});

test("inspectTaskRun rejects a forged dependency payload even after binding", () => {
  const fixture = inspectionFixture();
  const dependencyReceipt = {
    version: 1, written_by: "host-task-integration", parent_session_id: PARENT, feature_id: FEATURE,
    task_id: "dependency-one", parent_root: fixture.root, plan_sha256: fixture.entry.plan_sha256,
    spec_sha256: fixture.entry.spec_sha256, child_head: fixture.base, integrated_head: fixture.base,
  };
  fixture.dependencies.readTaskRunBindingFn = () => ({
    ok: true,
    grant: {
      task_id: TASK, attempt_id: ATTEMPT, parent_session_id: PARENT, parent_root: fixture.root,
      feature_id: FEATURE, plan_sha256: fixture.entry.plan_sha256, spec_sha256: fixture.entry.spec_sha256,
      base_sha: fixture.base, cwd: fixture.root,
      dependencies: [{ task_id: "dependency-one", child_head: fixture.base, integrated_head: fixture.base,
        receipt: dependencyReceipt, receipt_sha256: "f".repeat(64) }],
    },
    task: { id: TASK, depends_on: ["dependency-one"], scope_paths: ["src/"], locked_tests: [{ id: "lt-1", path: "src/task.spec.mjs", assertion: "expected behavior" }] },
    grantPath: fixture.entry.grant_path,
  });
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /dependency-one.*invalid/i);
});

test("inspectTaskRun rejects a frozen test modified after the event-proven freeze", () => {
  const fixture = inspectionFixture();
  write(path.join(fixture.root, "src", "task.spec.mjs"), "export const expected = 2;\n");
  run(fixture.root, "git", "add", "src/task.spec.mjs");
  run(fixture.root, "git", "commit", "-m", "tamper frozen test");
  const changedHead = run(fixture.root, "git", "rev-parse", "HEAD");
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  for (const receipt of [state.task_adversary_evidence[`${FEATURE}/${TASK}`], ...Object.values(state.task_review_evidence[`${FEATURE}/${TASK}`])]) receipt.reviewed_head_sha = changedHead;
  write(fixture.statePath, state);
  fixture.dependencies.captureReviewInputFn = () => ({ ok: true, snapshot: { head_sha: changedHead, input_digest: DIGEST } });
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /frozen file changed/i);
});

function integratedFixture() {
  const { root, base } = repo();
  const result = {
    version: 1, written_by: "host-task-inspection", parent_session_id: PARENT, feature_id: FEATURE,
    task_id: TASK, attempt_id: ATTEMPT, parent_root: root, worktree: path.join(root, ".tasks", TASK),
    session_id: CHILD, plan_sha256: "c".repeat(64), spec_sha256: "d".repeat(64), base_sha: base,
    child_head: base, changed_paths: [], freeze_sha: null, frozen_blobs: {},
    hand_capture: { agent: "harness-executor", producer_call_id: "producer", freeze_sha: base,
      captured_verified_at: "2026-09-07T00:00:00.000Z", capture_marker: `${FEATURE}/${TASK}@${base}` },
    review_input_digest: DIGEST,
    review_receipts: Object.fromEntries(["adversary", "compliance", "security"].map((role) => [role, {
      agent_id: `agent-${role}`, dispatch_call_id: `call-${role}`, child_session_id: `child-${role}`,
      input_digest: DIGEST, report_digest: "b".repeat(64),
    }])),
    regate: { pending: [], passed: [] },
    latest_run_id: "run-current",
    launches: [{ run_id: "run-current", pid: 999990, exit_code: 0, signal: null, timed_out: false, ended_at: "2026-09-07T00:01:00.000Z" }],
  };
  const integration = {
    version: 1, written_by: "host-task-integration", parent_session_id: PARENT, feature_id: FEATURE,
    task_id: TASK, attempt_id: ATTEMPT, parent_root: root, worktree: result.worktree, session_id: CHILD,
    plan_sha256: result.plan_sha256, spec_sha256: result.spec_sha256, base_sha: base, child_head: base,
    integrated_head: base, result_sha256: hashTaskReceipt(result),
  };
  const entry = { ...result, status: "integrated", launches: [{ run_id: "run-current", pid: 999990 }], result, integration };
  const registryPath = path.join(root, ".pi", "harness", "state", PARENT, "task-runs", "index.json");
  const registry = { version: 1, parent_session_id: PARENT, feature_id: FEATURE, plan_sha256: result.plan_sha256, spec_sha256: result.spec_sha256, tasks: { [TASK]: entry } };
  write(registryPath, registry);
  return { root, base, registryPath, registry, entry, integration };
}

test("readIntegratedTaskEvidence preserves the child session and accepts ancestry at a later global HEAD", () => {
  const fixture = integratedFixture();
  write(path.join(fixture.root, "later.txt"), "later\n");
  const later = commit(fixture.root, "later integration");
  const evidence = readIntegratedTaskEvidence({ projectRoot: fixture.root, sessionId: PARENT, featureId: FEATURE, taskId: TASK, headSha: later });
  assert.equal(evidence.ok, true, evidence.reason);
  assert.equal(evidence.result.session_id, CHILD);
  assert.equal(evidence.result.integrated_head, fixture.base);
});

test("readIntegratedTaskEvidence rejects revoked status and a forged result hash", () => {
  const fixture = integratedFixture();
  fixture.registry.tasks[TASK].status = "running";
  write(fixture.registryPath, fixture.registry);
  assert.equal(readIntegratedTaskEvidence({ projectRoot: fixture.root, sessionId: PARENT, featureId: FEATURE, taskId: TASK, headSha: fixture.base }).ok, false);
  fixture.registry.tasks[TASK].status = "integrated";
  fixture.registry.tasks[TASK].integration.result_sha256 = "f".repeat(64);
  write(fixture.registryPath, fixture.registry);
  const forged = readIntegratedTaskEvidence({ projectRoot: fixture.root, sessionId: PARENT, featureId: FEATURE, taskId: TASK, headSha: fixture.base });
  assert.equal(forged.ok, false);
  assert.match(forged.reason, /does not match/i);
});

test("readIntegratedTaskEvidence rejects all historical integrations while a correction barrier is active", () => {
  const fixture = integratedFixture();
  fixture.registry.correction_barrier = { task_id: "correcting-task", attempt_id: "attempt-correction" };
  write(fixture.registryPath, fixture.registry);
  const blocked = readIntegratedTaskEvidence({ projectRoot: fixture.root, sessionId: PARENT, featureId: FEATURE, taskId: TASK, headSha: fixture.base });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /current integrated task registry entry/i);
});
