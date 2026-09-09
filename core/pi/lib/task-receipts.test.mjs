import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { hashTaskReceipt } from "./task-contract.mjs";
import { createPiMarkerAuthority } from "./marker-authority.mjs";
import { inspectTaskRun, readIntegratedTaskEvidence } from "./task-receipts.mjs";
import { validateTaskFidelityFreeze } from "./task-run.mjs";

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

function inspectionFixture({ historicFailure = false, frozenFixture = false } = {}) {
  const { root, base } = repo();
  write(path.join(root, "src", "task.spec.mjs"), "export const expected = 1;\n");
  if (frozenFixture) write(path.join(root, "fixtures", "task.json"), '{"expected":1}\n');
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
    capture_verified: [`${bare}@${head}`],
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
    freezeCommitSha: head,
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
    event("tool_execution_end", { toolCallId: "fidelity-eye", toolName: "subagent", isError: false, result: { content: [{ type: "text", text: "Fidelity evidence.\nVerdict: APPROVE" }], details: { status: "completed" } } }),
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
  const task = {
    id: TASK,
    depends_on: [],
    scope_paths: ["src/"],
    locked_tests: [{
      id: "lt-1",
      path: "src/task.spec.mjs",
      assertion: "expected behavior",
      ...(frozenFixture ? { fixture_paths: ["fixtures/task.json"] } : {}),
    }],
  };
  const entry = {
    task_id: TASK, attempt_id: ATTEMPT, parent_session_id: PARENT, parent_root: root,
    feature_id: FEATURE, plan_sha256: grant.plan_sha256, spec_sha256: grant.spec_sha256,
    base_sha: base, worktree: root, branch: "task/receipt", grant_path: grantPath,
    job_dir: jobRoot, status: "ready", launches, result: null, integration: null,
  };
  const dependencies = {
    readTaskRunBindingFn: () => ({ ok: true, grant, task, grantPath }),
    captureReviewInputFn: () => ({ ok: true, snapshot: { head_sha: head, input_digest: DIGEST } }),
    readTaskContextReturnFn: () => null,
  };
  return { root, base, freeze, head, entry, dependencies, statePath: path.join(root, ".pi", "harness", "state", CHILD, "gate-state.json") };
}

function bindPinnedRuntime(fixture, { testReviewer = false } = {}) {
  const piRoot = path.join(fixture.entry.job_dir, "pinned", "core", "pi");
  const launcher = path.join(piRoot, "bin", "pi-harness.mjs");
  write(launcher, "// pinned runtime\n");
  if (testReviewer) write(path.join(piRoot, "runtime", "agents", "harness-test-reviewer.md"), "---\nlocked: true\n---\n");
  const runtime = { launcher_path: launcher, sha256: "9".repeat(64) };
  fixture.entry.runtime = runtime;
  for (const launch of fixture.entry.launches) {
    launch.runtime = runtime;
    const processRecord = JSON.parse(fs.readFileSync(launch.process_path, "utf8"));
    write(launch.process_path, { ...processRecord, run_runtime_sha256: runtime.sha256 });
    const result = JSON.parse(fs.readFileSync(launch.result_path, "utf8"));
    write(launch.result_path, { ...result, run_runtime_sha256: runtime.sha256 });
  }
  return runtime;
}

test("inspectTaskRun issues a child-bound receipt from native lifecycle, fidelity, capture and strong reviews", () => {
  const fixture = inspectionFixture({ historicFailure: true });
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.result.session_id, CHILD);
  assert.equal(inspected.result.child_head, fixture.head);
  assert.equal(inspected.result.freeze_sha, fixture.freeze);
  assert.equal(inspected.result.hand_capture.freeze_sha, fixture.head);
  assert.equal(inspected.result.latest_run_id, "run-current");
  assert.deepEqual(inspected.result.changed_paths, ["src/task.mjs", "src/task.spec.mjs"]);
  assert.match(inspected.result.frozen_blobs["src/task.spec.mjs"], /^[0-9a-f]{64}$/);
});

test("pinned runtimes with the dedicated test reviewer cannot use compliance as new fidelity evidence", () => {
  const fixture = inspectionFixture();
  bindPinnedRuntime(fixture, { testReviewer: true });
  const legacyReview = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(legacyReview.ok, false);
  assert.match(legacyReview.reason, /harness-test-reviewer/);

  const eventsPath = fixture.entry.launches.at(-1).events_path;
  const events = fs.readFileSync(eventsPath, "utf8").replace(
    '"subagent_type":"harness-compliance"',
    '"subagent_type":"harness-test-reviewer"',
  );
  write(eventsPath, events);
  const dedicatedReview = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(dedicatedReview.ok, true, dedicatedReview.reason);

  for (const verdict of ["REVISE", "BLOCKED"]) {
    write(eventsPath, events.replace("Verdict: APPROVE", `Verdict: ${verdict}`));
    const rejectedReview = inspectTaskRun(fixture.entry, fixture.dependencies);
    assert.equal(rejectedReview.ok, false, verdict);
    assert.match(rejectedReview.reason, /harness-test-reviewer/);
  }

  for (const invalid of ["Verdict: APPROVED", "Verdict: REVISE\nVerdict: APPROVE"]) {
    write(eventsPath, events.replace("Verdict: APPROVE", invalid));
    const malformedReview = inspectTaskRun(fixture.entry, fixture.dependencies);
    assert.equal(malformedReview.ok, false, invalid);
    assert.match(malformedReview.reason, /harness-test-reviewer/);
  }

  const freezeStart = event("tool_execution_start", { toolCallId: "freeze", toolName: "bash", args: { command: "git commit -m freeze" } });
  const laterStart = event("tool_execution_start", { toolCallId: "fidelity-eye-later", toolName: "subagent", args: { subagent_type: "harness-test-reviewer" } });
  for (const laterEnd of [
    event("tool_execution_end", { toolCallId: "fidelity-eye-later", toolName: "subagent", isError: false, result: { content: [{ type: "text", text: "Corrective finding.\nVerdict: REVISE" }], details: { status: "completed" } } }),
    event("tool_execution_end", { toolCallId: "fidelity-eye-later", toolName: "subagent", isError: true, result: { details: { status: "failed" } } }),
  ]) {
    write(eventsPath, events.replace(freezeStart, `${laterStart}\n${laterEnd}\n${freezeStart}`));
    const supersededApproval = inspectTaskRun(fixture.entry, fixture.dependencies);
    assert.equal(supersededApproval.ok, false, "a later non-approval must supersede an earlier APPROVE");
    assert.match(supersededApproval.reason, /harness-test-reviewer/);
  }

  const legacy = inspectionFixture();
  bindPinnedRuntime(legacy);
  const legacyCompatible = inspectTaskRun(legacy.entry, legacy.dependencies);
  assert.equal(legacyCompatible.ok, true, legacyCompatible.reason);
});

test("reconciled dependencies keep original audit paths but require fresh reviews and exact host merge proof", () => {
  const f = inspectionFixture();
  // A correction outside the dependent task scope is supplied only by a host merge.
  run(f.root, "git", "checkout", "-b", "parent-correction", f.base);
  write(path.join(f.root, "upstream.mjs"), "export const corrected = true;\n");
  run(f.root, "git", "add", "upstream.mjs");
  run(f.root, "git", "commit", "-m", "upstream correction");
  const parent = run(f.root, "git", "rev-parse", "HEAD");
  run(f.root, "git", "checkout", "-b", "dependent-recovery", f.head);
  run(f.root, "git", "merge", "--no-ff", "-m", "host dependency merge", parent);
  const head = run(f.root, "git", "rev-parse", "HEAD");
  f.entry.reconciliations = [{
    written_by: "host-task-reconciliation", task_id: TASK, attempt_id: ATTEMPT,
    scope_base_sha: f.base, pre_child_head: f.head, parent_head: parent,
    merged_head: head, tree: run(f.root, "git", "rev-parse", "HEAD^{tree}"), launch_count: 1,
    upstreams: [{ task_id: "upstream", attempt_id: "upstream-attempt", previous_receipt_sha256: "f".repeat(64), receipt: {
      version: 1, written_by: "host-task-integration", task_id: "upstream", attempt_id: "upstream-attempt",
      session_id: "upstream-session", result_sha256: "e".repeat(64),
      parent_session_id: PARENT, feature_id: FEATURE, parent_root: f.root,
      plan_sha256: f.entry.plan_sha256, spec_sha256: f.entry.spec_sha256,
      child_head: parent, integrated_head: parent,
    } }],
  }];
  f.dependencies.captureReviewInputFn = () => ({ ok: true, snapshot: { head_sha: head, input_digest: DIGEST } });
  const stale = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /capture after dependency reconciliation/);
  const handPath = path.join(f.root, ".pi/harness/state/hand-records", FEATURE, CHILD, `${TASK}.json`);
  const hand = JSON.parse(fs.readFileSync(handPath));
  write(handPath, { ...hand, freezeCommitSha: head });
  assert.match(inspectTaskRun(f.entry, f.dependencies).reason, /producer after dependency reconciliation/);
  const oldLaunch = f.entry.launches[0];
  const dir = path.join(f.entry.job_dir, "run-reconciled");
  const launch = { ...oldLaunch, run_id: "run-reconciled", pid: 999993,
    events_path: path.join(dir, "events.jsonl"), process_path: path.join(dir, "process.json"), result_path: path.join(dir, "result.json") };
  for (const key of ["process_path", "result_path"]) {
    const record = JSON.parse(fs.readFileSync(oldLaunch[key]));
    write(launch[key], { ...record, run_id: launch.run_id, pid: launch.pid });
  }
  write(launch.events_path, [event("session", { id: CHILD }),
    event("tool_execution_start", { toolCallId: "recovered-producer", toolName: "subagent", args: { subagent_type: "harness-executor", prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${TASK}"}[/HARNESS_TASK_CONTEXT]` } }),
    event("tool_execution_end", { toolCallId: "recovered-producer", toolName: "subagent", isError: false, result: { details: { status: "completed" } } }), ""].join("\n"));
  f.entry.launches.push(launch);
  write(handPath, { ...hand, freezeCommitSha: head, producerCallId: "recovered-producer" });
  const state = JSON.parse(fs.readFileSync(f.statePath));
  const bare = `${FEATURE}/${TASK}`;
  state.capture_verified = [`${bare}@${head}`];
  write(f.statePath, state);
  assert.match(inspectTaskRun(f.entry, f.dependencies).reason, /current accepted adversary task review/);
  state.task_adversary_evidence[bare] = review("harness-adversary", head);
  state.task_review_evidence[bare] = { compliance: review("harness-compliance", head), security: review("harness-security", head) };
  write(f.statePath, state);
  const current = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(current.ok, true, current.reason);
  assert.equal(current.result.base_sha, f.base);
  assert.equal(current.result.scope_base_sha, parent);
  assert.match(current.result.reconciliation_sha256, /^[a-f0-9]{64}$/);
  assert.ok(current.result.changed_paths.includes("upstream.mjs"), "audit retains inherited changes");
  f.entry.reconciliation_required = { pre_child_head: head };
  assert.match(inspectTaskRun(f.entry, f.dependencies).reason, /requires reconciliation/);
  delete f.entry.reconciliation_required;
  f.entry.reconciliations[0].upstreams[0].receipt.task_id = "unrelated-task";
  assert.match(inspectTaskRun(f.entry, f.dependencies).reason, /invalid corrected dependency/);
  f.entry.reconciliations[0].upstreams[0].receipt.task_id = "upstream";
  f.entry.reconciliations[0].tree = f.base;
  assert.match(inspectTaskRun(f.entry, f.dependencies).reason, /reserved parents or tree/);
});

test("inspectTaskRun accepts cumulative locked tests and fixtures outside production scope", () => {
  const fixture = inspectionFixture({ frozenFixture: true });
  const binding = fixture.dependencies.readTaskRunBindingFn();
  binding.task.scope_paths = ["src/task.mjs"];
  fixture.dependencies.readTaskRunBindingFn = () => binding;
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.deepEqual(inspected.result.changed_paths, [
    "fixtures/task.json",
    "src/task.mjs",
    "src/task.spec.mjs",
  ]);
  assert.match(inspected.result.frozen_blobs["fixtures/task.json"], /^[0-9a-f]{64}$/);
});

test("inspectTaskRun does not grant wildcard semantics absent from the native hand rails", () => {
  const fixture = inspectionFixture();
  const binding = fixture.dependencies.readTaskRunBindingFn();
  binding.task.scope_paths = ["src/**/*.mjs"];
  fixture.dependencies.readTaskRunBindingFn = () => binding;
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /unsupported glob syntax/i);
});

test("native task markers bind a real test-only freeze commit through executor capture and inspection", () => {
  const { root, base } = repo();
  const bare = `${FEATURE}/${TASK}`;
  const statePath = path.join(root, ".pi", "harness", "state", CHILD, "gate-state.json");
  const handPath = path.join(root, ".pi", "harness", "state", "hand-records", FEATURE, CHILD, `${TASK}.json`);
  const task = {
    id: TASK,
    depends_on: [],
    scope_paths: ["src/"],
    locked_tests: [{ id: "lt-1", path: "src/task.spec.mjs", assertion: "expected behavior" }],
  };
  const grantPath = path.join(root, ".pi", "harness", "state", "task-admission", `${ATTEMPT}.json`);
  const grant = {
    task_id: TASK,
    attempt_id: ATTEMPT,
    parent_session_id: PARENT,
    parent_root: root,
    feature_id: FEATURE,
    plan_sha256: "c".repeat(64),
    spec_sha256: "d".repeat(64),
    base_sha: base,
    cwd: root,
    dependencies: [],
  };
  write(`${grantPath}.claim`, { session_id: CHILD, grant_sha256: "b".repeat(64) });
  write(statePath, {
    session_id: CHILD,
    feature_id: FEATURE,
    task_pipeline_version: 1,
    task_run: { task_id: TASK, attempt_id: ATTEMPT },
  });

  const dispatches = new Map([
    ["author", "harness-test-author"],
    ["executor", "harness-executor"],
  ]);
  const removedDispatches = [];
  const binding = { ok: true, grant, task, grantPath };
  const authority = createPiMarkerAuthority({
    projectRoot: root,
    readDispatchRecord: (_projectRoot, { parentSessionId, callId }) => {
      const role = dispatches.get(callId);
      return parentSessionId === CHILD && role
        ? { ok: true, record: {
            parent_session_id: CHILD,
            dispatch_call_id: callId,
            feature_id: FEATURE,
            task_id: TASK,
            role,
          } }
        : { ok: false, reason: "dispatch record absent" };
    },
    removeDispatchRecord: (_projectRoot, ids) => {
      removedDispatches.push(ids);
      return { ok: true, removed: true };
    },
    validateTaskFidelityFreezeFn: (input) => validateTaskFidelityFreeze(input, {
      readTaskRunBindingFn: () => binding,
    }),
    now: () => "2026-09-08T00:00:00.000Z",
  });
  const mark = (action, callId) => {
    const args = { action, task_id: TASK };
    assert.deepEqual(authority.authorize({ toolName: "mark", input: args, sessionId: CHILD, toolCallId: callId }), { ok: true });
    const result = authority.execute({ toolCallId: callId, params: args, sessionId: CHILD, isChild: false });
    assert.equal(result.ok, true, result.output);
    return result;
  };
  const hand = (agent, producerCallId, freezeCommitSha) => write(handPath, {
    writtenBy: "host-hand-finished",
    featureId: FEATURE,
    taskId: TASK,
    sessionId: CHILD,
    agent,
    producerCallId,
    freezeCommitSha,
    outcome: "DONE",
    scopeViolations: [],
    frozenViolations: [],
  });

  write(path.join(root, "src", "task.spec.mjs"), "export const expected = 1;\n");
  hand("harness-test-author", "author", base);
  const authorFinished = mark("hand-finished", "author-finished");
  run(root, "git", "add", "--", "src/task.spec.mjs");
  run(root, "git", "commit", "-m", "freeze tests");
  const freeze = run(root, "git", "rev-parse", "HEAD");
  const fidelity = mark("fidelity", "fidelity");
  const authorCapture = mark("capture-verified", "author-capture");
  let state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(state.fidelity_pass, [`${bare}@${freeze}`]);
  assert.deepEqual(state.capture_verified, [`${bare}@${base}`]);
  assert.deepEqual(removedDispatches, [{ sessionId: CHILD, callId: "author" }]);

  write(path.join(root, "src", "task.mjs"), "export const actual = 1;\n");
  run(root, "git", "add", "--", "src/task.mjs");
  run(root, "git", "commit", "-m", "implement task");
  const head = run(root, "git", "rev-parse", "HEAD");
  hand("harness-executor", "executor", head);
  const executorFinished = mark("hand-finished", "executor-finished");
  const capture = mark("capture-verified", "capture");

  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(state.capture_verified, [`${bare}@${base}`, `${bare}@${head}`]);
  assert.deepEqual(removedDispatches, [
    { sessionId: CHILD, callId: "author" },
    { sessionId: CHILD, callId: "executor" },
  ]);
  state.task_adversary_evidence = { [bare]: review("harness-adversary", head) };
  write(statePath, state);
  const events = [
    event("session", { id: CHILD }),
    event("tool_execution_start", { toolCallId: "author", toolName: "subagent", args: { subagent_type: "harness-test-author" } }),
    event("tool_execution_end", { toolCallId: "author", toolName: "subagent", isError: false, result: { details: { status: "completed" } } }),
    event("tool_execution_start", { toolCallId: "author-finished", toolName: "mark", args: { action: "hand-finished", task_id: TASK } }),
    event("tool_execution_end", { toolCallId: "author-finished", toolName: "mark", isError: false, result: { details: authorFinished.metadata } }),
    event("tool_execution_start", { toolCallId: "fidelity-eye", toolName: "subagent", args: { subagent_type: "harness-compliance" } }),
    event("tool_execution_end", { toolCallId: "fidelity-eye", toolName: "subagent", isError: false, result: { details: { status: "completed" } } }),
    event("tool_execution_start", { toolCallId: "freeze", toolName: "bash", args: { command: "git commit -m 'freeze tests'" } }),
    event("tool_execution_end", { toolCallId: "freeze", toolName: "bash", isError: false, result: { content: [{ type: "text", text: `[task ${freeze.slice(0, 7)}] freeze tests` }] } }),
    event("tool_execution_start", { toolCallId: "fidelity", toolName: "mark", args: { action: "fidelity", task_id: TASK } }),
    event("tool_execution_end", { toolCallId: "fidelity", toolName: "mark", isError: false, result: { details: fidelity.metadata } }),
    event("tool_execution_start", { toolCallId: "author-capture", toolName: "mark", args: { action: "capture-verified", task_id: TASK } }),
    event("tool_execution_end", { toolCallId: "author-capture", toolName: "mark", isError: false, result: { details: authorCapture.metadata } }),
    event("tool_execution_start", { toolCallId: "executor", toolName: "subagent", args: { subagent_type: "harness-executor", prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${TASK}"}[/HARNESS_TASK_CONTEXT]` } }),
    event("tool_execution_end", { toolCallId: "executor", toolName: "subagent", isError: false, result: { details: { status: "completed" } } }),
    event("tool_execution_start", { toolCallId: "executor-finished", toolName: "mark", args: { action: "hand-finished", task_id: TASK } }),
    event("tool_execution_end", { toolCallId: "executor-finished", toolName: "mark", isError: false, result: { details: executorFinished.metadata } }),
    event("tool_execution_start", { toolCallId: "capture", toolName: "mark", args: { action: "capture-verified", task_id: TASK } }),
    event("tool_execution_end", { toolCallId: "capture", toolName: "mark", isError: false, result: { details: capture.metadata } }),
    event("tool_execution_start", { toolCallId: "call-harness-adversary", toolName: "subagent", args: { subagent_type: "harness-adversary", prompt: `[HARNESS_TASK_REVIEW]\n[HARNESS_TASK_CONTEXT]{"task_id":"${TASK}"}[/HARNESS_TASK_CONTEXT]` } }),
    event("tool_execution_end", { toolCallId: "call-harness-adversary", toolName: "subagent", isError: false, result: { details: { status: "completed" } } }),
  ];
  const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-native-marker-job-"));
  roots.push(jobRoot);
  const launchDir = path.join(jobRoot, "run-native-markers");
  const launch = {
    run_id: "run-native-markers",
    pid: 999992,
    events_path: path.join(launchDir, "events.jsonl"),
    process_path: path.join(launchDir, "process.json"),
    result_path: path.join(launchDir, "result.json"),
  };
  write(launch.events_path, `${events.join("\n")}\n`);
  const entry = {
    task_id: TASK,
    attempt_id: ATTEMPT,
    parent_session_id: PARENT,
    parent_root: root,
    feature_id: FEATURE,
    plan_sha256: grant.plan_sha256,
    spec_sha256: grant.spec_sha256,
    base_sha: base,
    worktree: root,
    branch: "task/receipt",
    grant_path: grantPath,
    job_dir: jobRoot,
    status: "ready",
    launches: [launch],
    result: null,
    integration: null,
  };
  const inspected = inspectTaskRun(entry, {
    readTaskRunBindingFn: () => binding,
    readTaskProcessFn: () => ({
      ok: true,
      running: false,
      terminal: true,
      result: { exitCode: 0, signal: null, timedOut: false, ended_at: "2026-09-08T00:01:00.000Z" },
    }),
    captureReviewInputFn: () => ({ ok: true, snapshot: { head_sha: head, input_digest: DIGEST } }),
    readTaskContextReturnFn: () => null,
  });
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.result.freeze_sha, freeze);
  assert.equal(inspected.result.hand_capture.freeze_sha, head);
  assert.equal(inspected.result.child_head, head);
});

test("inspectTaskRun rejects a captured implementation hand that predates the latest fidelity freeze", () => {
  const fixture = inspectionFixture();
  const handPath = path.join(fixture.root, ".pi", "harness", "state", "hand-records", FEATURE, CHILD, `${TASK}.json`);
  const hand = JSON.parse(fs.readFileSync(handPath, "utf8"));
  write(handPath, { ...hand, freezeCommitSha: fixture.base });
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  state.capture_verified = [`${FEATURE}/${TASK}@${fixture.base}`];
  write(fixture.statePath, state);

  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /not descended from.*latest freeze/i);
});

test("inspectTaskRun requires the current hand producer to be the latest implementation after fidelity", () => {
  const fixture = inspectionFixture();
  const eventsPath = fixture.entry.launches.at(-1).events_path;
  fs.appendFileSync(eventsPath, [
    event("tool_execution_start", { toolCallId: "later-sniper", toolName: "subagent", args: { subagent_type: "harness-sniper", prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${TASK}"}[/HARNESS_TASK_CONTEXT]` } }),
    event("tool_execution_end", { toolCallId: "later-sniper", toolName: "subagent", isError: false, result: { details: { status: "completed" } } }),
    "",
  ].join("\n"));

  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /latest successful implementation call after fidelity/i);
});

test("inspectTaskRun accepts a post-freeze sniper hand while retaining the test freeze", () => {
  const fixture = inspectionFixture();
  const handPath = path.join(fixture.root, ".pi", "harness", "state", "hand-records", FEATURE, CHILD, `${TASK}.json`);
  const hand = JSON.parse(fs.readFileSync(handPath, "utf8"));
  write(handPath, { ...hand, agent: "harness-sniper" });
  const eventsPath = fixture.entry.launches.at(-1).events_path;
  write(eventsPath, fs.readFileSync(eventsPath, "utf8").replace(
    '"subagent_type":"harness-executor"',
    '"subagent_type":"harness-sniper"',
  ));

  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.result.freeze_sha, fixture.freeze);
  assert.equal(inspected.result.hand_capture.freeze_sha, fixture.head);
  assert.equal(inspected.result.hand_capture.agent, "harness-sniper");
});

test("inspectTaskRun rejects implementation evidence that only predates fidelity", () => {
  const fixture = inspectionFixture();
  const eventsPath = fixture.entry.launches.at(-1).events_path;
  const lines = fs.readFileSync(eventsPath, "utf8").trimEnd().split("\n");
  const producer = lines.splice(-2);
  lines.splice(3, 0, ...producer);
  write(eventsPath, `${lines.join("\n")}\n`);

  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /latest successful implementation call after fidelity/i);
});

test("inspectTaskRun rejects successful test-author work after the latest fidelity marker", () => {
  const fixture = inspectionFixture();
  const eventsPath = fixture.entry.launches.at(-1).events_path;
  fs.appendFileSync(eventsPath, [
    event("tool_execution_start", { toolCallId: "late-author", toolName: "subagent", args: { subagent_type: "harness-test-author", prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${TASK}"}[/HARNESS_TASK_CONTEXT]` } }),
    event("tool_execution_end", { toolCallId: "late-author", toolName: "subagent", isError: false, result: { details: { status: "completed" } } }),
    "",
  ].join("\n"));

  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /test-author work has no subsequent fidelity marker/i);
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

test("inspectTaskRun accepts the registered worker PID for an Orca terminal launch", () => {
  const fixture = inspectionFixture();
  const launch = fixture.entry.launches.at(-1);
  launch.pid = null;
  launch.terminal_mode = true;
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.result.launches.at(-1).pid, null);
  assert.equal(inspected.result.launches.at(-1).exit_code, 0);
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

test("inspectTaskRun requires the baseline adversary without inventing optional implementation reviews", () => {
  const fixture = inspectionFixture();
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  delete state.task_review_evidence;
  write(fixture.statePath, state);
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.deepEqual(Object.keys(inspected.result.review_receipts), ["adversary"]);

  delete state.task_adversary_evidence;
  write(fixture.statePath, state);
  const missing = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /accepted adversary task review/i);
});

test("inspectTaskRun cannot ignore a failed optional implementation reviewer from launch history", () => {
  const fixture = inspectionFixture({ historicFailure: true });
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  delete state.task_review_evidence[`${FEATURE}/${TASK}`].security;
  write(fixture.statePath, state);
  const launch = fixture.entry.launches[0];
  fs.appendFileSync(launch.events_path, [
    event("tool_execution_start", {
      toolCallId: "security-review",
      toolName: "subagent",
      args: {
        subagent_type: "harness-security",
        prompt: `[HARNESS_TASK_REVIEW]\n[HARNESS_TASK_CONTEXT]{"task_id":"${TASK}"}[/HARNESS_TASK_CONTEXT]`,
      },
    }),
    event("tool_execution_end", {
      toolCallId: "security-review",
      toolName: "subagent",
      isError: true,
      result: { details: { status: "failed" }, content: [{ type: "text", text: "review process failed" }] },
    }),
    "",
  ].join("\n"));
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /accepted security task review/i);
});

test("inspectTaskRun binds a validated child context return to task identity and HEAD", () => {
  const fixture = inspectionFixture();
  const content = "D1 retries must preserve the first response.";
  const contextReturn = {
    version: 1,
    kind: "task-context-return",
    session_id: CHILD,
    task_id: TASK,
    head_sha: fixture.head,
    content,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
  fixture.dependencies.readTaskContextReturnFn = () => contextReturn;
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.deepEqual(inspected.result.context_return, contextReturn);

  fixture.dependencies.readTaskContextReturnFn = () => ({ ...contextReturn, head_sha: fixture.base });
  const foreign = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /context return.*identity/i);
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
  const planPath = path.join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json");
  const specPath = path.join(root, ".pi", "harness", "plans", FEATURE, "spec.md");
  write(planPath, { feature_id: FEATURE, tasks: [{ id: TASK }] });
  write(specPath, "approved task spec\n");
  const planSha = crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex");
  const specSha = crypto.createHash("sha256").update(fs.readFileSync(specPath)).digest("hex");
  const planReviewCallId = "plan-review-current";
  const result = {
    version: 1, written_by: "host-task-inspection", parent_session_id: PARENT, feature_id: FEATURE,
    task_id: TASK, attempt_id: ATTEMPT, parent_root: root, worktree: path.join(root, ".tasks", TASK),
    session_id: CHILD, plan_sha256: planSha, spec_sha256: specSha, base_sha: base,
    child_head: base, changed_paths: [], freeze_sha: null, frozen_blobs: {},
    hand_capture: { agent: "harness-executor", producer_call_id: "producer", freeze_sha: base,
      captured_verified_at: "2026-09-07T00:00:00.000Z", capture_marker: `${FEATURE}/${TASK}@${base}` },
    review_input_digest: DIGEST,
    review_receipts: Object.fromEntries(["adversary", "compliance", "security"].map((role) => [role, {
      agent_id: `agent-${role}`, dispatch_call_id: `call-${role}`, child_session_id: `child-${role}`,
      input_digest: DIGEST, report_digest: "b".repeat(64),
    }])),
    context_return: null,
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
  const grant = {
    version: 1,
    kind: "task-run",
    parent_session_id: PARENT,
    feature_id: FEATURE,
    task_id: TASK,
    plan_sha256: planSha,
    spec_sha256: specSha,
    origin: { kind: "parent-approved-plan", plan_review_call_id: planReviewCallId },
  };
  const entry = { ...result, grant, status: "integrated", launches: [{ run_id: "run-current", pid: 999990 }], result, integration };
  const registryPath = path.join(root, ".pi", "harness", "state", PARENT, "task-runs", "index.json");
  const registry = { version: 1, parent_session_id: PARENT, feature_id: FEATURE, plan_sha256: result.plan_sha256, spec_sha256: result.spec_sha256, tasks: { [TASK]: entry } };
  const statePath = path.join(root, ".pi", "harness", "state", PARENT, "gate-state.json");
  write(statePath, {
    session_id: PARENT,
    feature_id: FEATURE,
    mode: "FULL",
    spec_status: "adversary-reviewed",
    reviewed_spec_sha256: specSha,
    adversary_fired: true,
    adversary_spec_sha256: specSha,
    plan_review_evidence: {
      written_by: "host-subagent-completion",
      parent_session_id: PARENT,
      feature_id: FEATURE,
      role: "harness-plan-reviewer",
      status: "completed",
      verdict: "APPROVE",
      dispatch_call_id: planReviewCallId,
      child_session_id: "plan-review-child",
      agent_id: "plan-review-agent",
      plan_sha256: planSha,
      spec_sha256: specSha,
    },
  });
  write(registryPath, registry);
  return { root, base, planPath, specPath, statePath, registryPath, registry, entry, integration };
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

test("readIntegratedTaskEvidence rejects current canonical plan or spec drift with unchanged task ids", () => {
  const changedPlan = integratedFixture();
  write(changedPlan.planPath, { feature_id: FEATURE, tasks: [{ id: TASK, changed: true }] });
  const stalePlan = readIntegratedTaskEvidence({
    projectRoot: changedPlan.root,
    sessionId: PARENT,
    featureId: FEATURE,
    taskId: TASK,
    headSha: changedPlan.base,
  });
  assert.equal(stalePlan.ok, false);
  assert.match(stalePlan.reason, /current canonical artifacts/i);

  const changedSpec = integratedFixture();
  write(changedSpec.specPath, "replacement task spec\n");
  const staleSpec = readIntegratedTaskEvidence({
    projectRoot: changedSpec.root,
    sessionId: PARENT,
    featureId: FEATURE,
    taskId: TASK,
    headSha: changedSpec.base,
  });
  assert.equal(staleSpec.ok, false);
  assert.match(staleSpec.reason, /current canonical artifacts|current approved canonical spec/i);
});

test("integrated receipts reject pending recovery and an unbound reconciliation baseline", () => {
  for (const variant of ["pending", "baseline", "digest"]) {
    const f = integratedFixture();
    if (variant === "pending") f.entry.reconciliation_required = { pre_child_head: f.base };
    if (variant === "baseline") f.entry.result.scope_base_sha = "a".repeat(40);
    if (variant === "digest") f.entry.result.reconciliation_sha256 = "a".repeat(64);
    f.entry.integration.result_sha256 = hashTaskReceipt(f.entry.result);
    write(f.registryPath, f.registry);
    const inspected = readIntegratedTaskEvidence({ projectRoot: f.root, sessionId: PARENT,
      featureId: FEATURE, taskId: TASK, headSha: f.base });
    assert.equal(inspected.ok, false, variant);
    assert.match(inspected.reason, /reconciliation/, variant);
  }
});

test("readIntegratedTaskEvidence rejects a replaced plan approval for the same artifact hashes", () => {
  const fixture = integratedFixture();
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  state.plan_review_evidence.dispatch_call_id = "replacement-plan-review";
  write(fixture.statePath, state);
  const replaced = readIntegratedTaskEvidence({
    projectRoot: fixture.root,
    sessionId: PARENT,
    featureId: FEATURE,
    taskId: TASK,
    headSha: fixture.base,
  });
  assert.equal(replaced.ok, false);
  assert.match(replaced.reason, /current host-owned plan approval/i);
});

test("readIntegratedTaskEvidence accepts a receipt containing only the baseline adversary review", () => {
  const fixture = integratedFixture();
  fixture.registry.tasks[TASK].result.review_receipts = {
    adversary: fixture.registry.tasks[TASK].result.review_receipts.adversary,
  };
  fixture.registry.tasks[TASK].integration.result_sha256 = hashTaskReceipt(fixture.registry.tasks[TASK].result);
  write(fixture.registryPath, fixture.registry);
  const evidence = readIntegratedTaskEvidence({
    projectRoot: fixture.root,
    sessionId: PARENT,
    featureId: FEATURE,
    taskId: TASK,
    headSha: fixture.base,
  });
  assert.equal(evidence.ok, true, evidence.reason);
  assert.deepEqual(Object.keys(evidence.entry.result.review_receipts), ["adversary"]);
});

test("readIntegratedTaskEvidence rejects forged freeze or hand ancestry after receipt hashes are recomputed", () => {
  for (const field of ["freeze", "hand"]) {
    const fixture = integratedFixture();
    const forgedSha = "f".repeat(40);
    if (field === "freeze") {
      fixture.registry.tasks[TASK].result.freeze_sha = forgedSha;
      fixture.registry.tasks[TASK].result.frozen_blobs = {
        "README.md": crypto.createHash("sha256").update(fs.readFileSync(path.join(fixture.root, "README.md"))).digest("hex"),
      };
    } else {
      fixture.registry.tasks[TASK].result.hand_capture.freeze_sha = forgedSha;
      fixture.registry.tasks[TASK].result.hand_capture.capture_marker = `${FEATURE}/${TASK}@${forgedSha}`;
    }
    fixture.registry.tasks[TASK].integration.result_sha256 = hashTaskReceipt(fixture.registry.tasks[TASK].result);
    write(fixture.registryPath, fixture.registry);

    const evidence = readIntegratedTaskEvidence({
      projectRoot: fixture.root,
      sessionId: PARENT,
      featureId: FEATURE,
      taskId: TASK,
      headSha: fixture.base,
    });
    assert.equal(evidence.ok, false, field);
    assert.match(evidence.reason, /freeze and hand capture.*not ancestral/i, field);
  }
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

test("readIntegratedTaskEvidence rejects a forged context return even with a recomputed result hash", () => {
  const fixture = integratedFixture();
  const content = "foreign child context";
  fixture.registry.tasks[TASK].result.context_return = {
    version: 1,
    kind: "task-context-return",
    session_id: "ses-foreign-child",
    task_id: TASK,
    head_sha: fixture.base,
    content,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
  fixture.registry.tasks[TASK].integration.result_sha256 = hashTaskReceipt(fixture.registry.tasks[TASK].result);
  write(fixture.registryPath, fixture.registry);
  const forged = readIntegratedTaskEvidence({
    projectRoot: fixture.root,
    sessionId: PARENT,
    featureId: FEATURE,
    taskId: TASK,
    headSha: fixture.base,
  });
  assert.equal(forged.ok, false);
  assert.match(forged.reason, /incomplete|registry entry/i);
});

test("readIntegratedTaskEvidence rejects all historical integrations while a correction barrier is active", () => {
  const fixture = integratedFixture();
  fixture.registry.correction_barrier = { task_id: "correcting-task", attempt_id: "attempt-correction" };
  write(fixture.registryPath, fixture.registry);
  const blocked = readIntegratedTaskEvidence({ projectRoot: fixture.root, sessionId: PARENT, featureId: FEATURE, taskId: TASK, headSha: fixture.base });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /current integrated task registry entry/i);
});
