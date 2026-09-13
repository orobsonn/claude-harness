import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { hashTaskReceipt } from "./task-contract.mjs";
import { createPiMarkerAuthority } from "./marker-authority.mjs";
import { inspectTaskRun, readIntegratedTaskEvidence, inspectTaskResumeAbandonment } from "./task-receipts.mjs";
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

function replaceEventText(events, toolCallId, text) {
  return `${events.trimEnd().split(/\r?\n/).map((line) => {
    const parsed = JSON.parse(line);
    if (parsed.type === "tool_execution_end" && parsed.toolCallId === toolCallId) {
      parsed.result.content = [{ type: "text", text }];
    }
    return JSON.stringify(parsed);
  }).join("\n")}\n`;
}

function appendImplementationReviews(f, roles = ["harness-adversary", "harness-compliance", "harness-security"]) {
  for (const role of roles) {
    const callId = `call-${role}`;
    const prompt = (role === "harness-adversary" ? "" : "[HARNESS_TASK_REVIEW]\n") +
      '[HARNESS_TASK_CONTEXT]{"task_id":"' + TASK + '"}[/HARNESS_TASK_CONTEXT]';
    fs.appendFileSync(f.entry.launches.at(-1).events_path, [
      event("tool_execution_start", { toolCallId: callId, toolName: "subagent", args: { subagent_type: role, prompt } }),
      event("tool_execution_end", { toolCallId: callId, toolName: "subagent", result: { details: { status: "completed" } } }), "",
    ].join("\n"));
  }
}

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
    readTaskRunBindingFn: () => ({ ok: true, grant, task, grantPath, plan: { mode: "full", tasks: [task] } }),
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

function archiveInspectedIntegration(f) {
  fs.appendFileSync(path.join(f.root, ".git/info/exclude"), "\n.pi/harness/plans/\n");
  const binding = f.dependencies.readTaskRunBindingFn();
  const planPath = path.join(f.root, ".pi/harness/plans", FEATURE, "execution-plan.json");
  write(planPath, { ...binding.plan, feature_id: FEATURE });
  const planSha = crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex");
  f.entry.plan_sha256 = binding.grant.plan_sha256 = planSha;
  const inspected = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  const result = inspected.result;
  const integration = {
    version: 1, written_by: "host-task-integration", parent_session_id: PARENT, feature_id: FEATURE,
    task_id: TASK, attempt_id: ATTEMPT, parent_root: f.entry.parent_root, worktree: f.root, session_id: CHILD,
    plan_sha256: result.plan_sha256, spec_sha256: result.spec_sha256, base_sha: f.base,
    child_head: f.head, integrated_head: f.head, result_sha256: hashTaskReceipt(result),
  };
  (f.entry.integration_history ??= []).push(integration);
  (f.entry.result_history ??= {})[integration.result_sha256] = result;
  const previous = f.entry.launches.at(-1);
  const runId = "run-recovery-" + f.entry.integration_history.length;
  const runDir = path.join(f.entry.job_dir, runId);
  const launch = { ...previous, run_id: runId, events_path: path.join(runDir, "events.jsonl"),
    process_path: path.join(runDir, "process.json"), result_path: path.join(runDir, "result.json") };
  write(launch.events_path, event("session", { id: CHILD }) + "\n");
  for (const field of ["process_path", "result_path"]) {
    write(launch[field], { ...JSON.parse(fs.readFileSync(previous[field], "utf8")), run_id: runId });
  }
  f.entry.launches.push(launch);
  return { result, integration };
}

function abandonedResumeFixture({ blockedHand = true, separateParent = false } = {}) {
  const f = inspectionFixture();
  const spec = path.join(f.root, ".pi/harness/plans", FEATURE, "spec.md");
  write(spec, "Approved spec\n");
  f.entry.spec_sha256 = f.dependencies.readTaskRunBindingFn().grant.spec_sha256 =
    crypto.createHash("sha256").update(fs.readFileSync(spec)).digest("hex");
  if (separateParent) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-abandon-parent-"));
    roots.push(parent);
    run(f.root, "git", "clone", "--quiet", "--shared", f.root, parent);
    run(parent, "git", "config", "user.email", "test@example.com");
    run(parent, "git", "config", "user.name", "Test");
    f.entry.parent_root = f.dependencies.readTaskRunBindingFn().grant.parent_root = parent;
  }
  const previous = archiveInspectedIntegration(f);
  if (separateParent) fs.cpSync(path.join(f.root, ".pi/harness/plans"),
    path.join(f.entry.parent_root, ".pi/harness/plans"), { recursive: true });
  const handPath = path.join(f.root, ".pi/harness/state/hand-records", FEATURE, CHILD, `${TASK}.json`);
  const hand = JSON.parse(fs.readFileSync(handPath));
  if (!blockedHand) return { ...f, ...previous, handPath };
  write(handPath, { ...hand, agent: "harness-sniper", producerCallId: "blocked-resume",
    outcome: "BLOCKED", touchedPaths: [], capturedVerifiedAt: undefined });
  fs.appendFileSync(f.entry.launches.at(-1).events_path, [
    event("tool_execution_start", { toolCallId: "blocked-resume", toolName: "subagent", args: {
      subagent_type: "harness-sniper", prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${TASK}"}[/HARNESS_TASK_CONTEXT]`,
    } }),
    event("tool_execution_end", { toolCallId: "blocked-resume", toolName: "subagent",
      result: { details: { status: "completed" }, content: [{ type: "text", text: "BLOCKED" }] } }), "",
  ].join("\n"));
  return { ...f, ...previous, handPath };
}

test("abandoning an operational resume revalidates the original integration without approving its blocked hand", () => {
  const f = abandonedResumeFixture();
  const before = fs.readFileSync(f.handPath, "utf8");
  const inspected = inspectTaskResumeAbandonment(f.entry, { headSha: f.head }, f.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.deepEqual(inspected.result, f.result);
  assert.deepEqual(inspected.integration, f.integration);
  assert.equal(inspected.proof.launch_count, 2);
  assert.equal(inspected.proof.inspected_launch_count, 1);
  assert.equal(f.entry.launches.length, 2, "all launches remain auditable and countable");
  assert.equal(fs.readFileSync(f.handPath, "utf8"), before);
  assert.equal(inspectTaskRun(f.entry, f.dependencies).ok, false, "the resumed hand remains blocked");
});

test("coordinator-only resume can retain its original captured hand without a new writer", () => {
  const f = abandonedResumeFixture({ blockedHand: false });
  const inspected = inspectTaskResumeAbandonment(f.entry, { headSha: f.head }, f.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.result.hand_capture.producer_call_id, "producer");
  assert.equal(inspected.proof.launch_count, 2);
});

test("an explicitly abandoned blocked writer does not become the producer of later real test-only recovery", () => {
  const f = abandonedResumeFixture();
  const abandoned = inspectTaskResumeAbandonment(f.entry, { headSha: f.head }, f.dependencies);
  assert.equal(abandoned.ok, true, abandoned.reason);
  f.entry.abandoned_resumes = [{ written_by: "host-task-resume-abandonment", no_product_obligation: true,
    reason: "Delivery work belonged to the parent", proof: abandoned.proof }];
  const previous = f.entry.launches.at(-1);
  const runId = "real-test-recovery";
  const runDir = path.join(f.entry.job_dir, runId);
  const launch = { ...previous, run_id: runId, events_path: path.join(runDir, "events.jsonl"),
    process_path: path.join(runDir, "process.json"), result_path: path.join(runDir, "result.json") };
  write(launch.events_path, event("session", { id: CHILD }) + "\n");
  for (const field of ["process_path", "result_path"]) write(launch[field], {
    ...JSON.parse(fs.readFileSync(previous[field], "utf8")), run_id: runId,
  });
  f.entry.launches.push(launch);
  const recovered = testOnlyRecovery({ fixture: f, capturedImplementation: false });
  const inspected = inspectTaskRun(recovered.entry, recovered.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.result.hand_capture.recovery_origin.producer_call_id, "producer");
  assert.equal(inspected.result.launches.length, 3);
  assert.notEqual(inspected.result.child_head, abandoned.result.child_head, "the test correction is a real commit");
  const validDigest = abandoned.proof.events_sha256[1];
  abandoned.proof.events_sha256[1] = "0".repeat(64);
  assert.equal(inspectTaskRun(recovered.entry, recovered.dependencies).ok, false, "forged abandonment cannot select older producers");
  abandoned.proof.events_sha256[1] = validDigest;
  const state = JSON.parse(fs.readFileSync(recovered.statePath));
  state.task_review_evidence[`${FEATURE}/${TASK}`].security.accepted = false;
  write(recovered.statePath, state);
  assert.equal(inspectTaskRun(recovered.entry, recovered.dependencies).ok, false, "new negative eyes are never abandoned");
});

function restoredResumeFixture(options = {}) {
  const f = abandonedResumeFixture(options);
  const inspected = inspectTaskResumeAbandonment(f.entry, { headSha: f.head }, f.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  const grant = f.dependencies.readTaskRunBindingFn().grant;
  f.entry.grant = { ...grant, version: 1, kind: "task-run",
    origin: { kind: "parent-approved-plan", plan_review_call_id: "plan-call" } };
  f.entry.status = "integrated";
  f.entry.integration = inspected.integration;
  f.entry.result = inspected.result;
  f.entry.abandoned_resumes = [{ written_by: "host-task-resume-abandonment", no_product_obligation: true,
    reason: "No product obligation remains", proof: inspected.proof }];
  const registryPath = path.join(f.entry.parent_root, ".pi/harness/state", PARENT, "task-runs/index.json");
  const registry = { version: 1, parent_session_id: PARENT, feature_id: FEATURE,
    plan_sha256: f.entry.plan_sha256, spec_sha256: f.entry.spec_sha256, tasks: { [TASK]: f.entry } };
  write(registryPath, registry);
  write(path.join(f.entry.parent_root, ".pi/harness/state", PARENT, "gate-state.json"), {
    session_id: PARENT, feature_id: FEATURE, mode: "FULL", spec_status: "adversary-reviewed",
    reviewed_spec_sha256: f.entry.spec_sha256, adversary_fired: true, adversary_spec_sha256: f.entry.spec_sha256,
    plan_review_evidence: { written_by: "host-subagent-completion", parent_session_id: PARENT, feature_id: FEATURE,
      role: "harness-plan-reviewer", status: "completed", verdict: "APPROVE", dispatch_call_id: "plan-call",
      child_session_id: "plan-child", agent_id: "plan-agent", plan_sha256: f.entry.plan_sha256, spec_sha256: f.entry.spec_sha256 },
  });
  const input = { projectRoot: f.entry.parent_root, sessionId: PARENT, featureId: FEATURE, taskId: TASK, headSha: f.head };
  const readEvidence = () => readIntegratedTaskEvidence(input, f.dependencies);
  return { ...f, registry, registryPath, input, readEvidence };
}

test("restored evidence reads retain all launches and reject changed abandonment proof or later negative reviews", () => {
  const f = restoredResumeFixture();
  const { registry, registryPath, readEvidence } = f;
  const restored = readEvidence();
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.entry.launches.length, 2);
  assert.equal(restored.result.child_head, f.head);
  f.entry.abandoned_resumes[0].proof.events_sha256[1] = "0".repeat(64);
  write(registryPath, registry);
  assert.match(readEvidence().reason, /abandonment evidence changed/);
  f.entry.abandoned_resumes[0].proof = inspectTaskResumeAbandonment(f.entry, { headSha: f.head }, f.dependencies).proof;
  write(registryPath, registry);
  const state = JSON.parse(fs.readFileSync(f.statePath));
  state.task_review_evidence[`${FEATURE}/${TASK}`].security.accepted = false;
  write(f.statePath, state);
  assert.equal(readEvidence().ok, false, "restoration cannot mask a later negative review");
});

test("abandonment seals the parent obligation without freezing later legitimate production ownership", () => {
  const f = restoredResumeFixture({ separateParent: true });
  assert.equal(f.readEvidence().ok, true);
  const sealed = f.entry.abandoned_resumes[0].proof;
  write(path.join(f.entry.parent_root, "src/task.mjs"), "export const actual = 2;\n");
  f.input.headSha = commit(f.entry.parent_root, "next owner improves production");
  assert.equal(inspectTaskResumeAbandonment(f.entry, { headSha: f.input.headSha }, f.dependencies).ok, false,
    "production drift before abandonment still fails");
  const evolved = f.readEvidence();
  assert.equal(evolved.ok, true, evolved.reason);
  assert.equal(sealed.parent_head, f.head);
  write(path.join(f.entry.parent_root, "src/task.spec.mjs"), "export const expected = 2;\n");
  f.input.headSha = commit(f.entry.parent_root, "change frozen test");
  assert.equal(f.readEvidence().ok, false, "current frozen hashes remain strict after abandonment");
  f.input.headSha = f.base;
  assert.equal(f.readEvidence().ok, false, "the sealed parent must remain ancestral to the requested HEAD");
});

test("resume abandonment refuses drift, live processes, invalid history, and new negative or missing reviews", () => {
  for (const scenario of ["dirty", "new-head", "history-hash", "running", "touched-hand", "scope-violation", "new-negative-review", "new-missing-review", "input-digest"]) {
    const f = abandonedResumeFixture();
    if (scenario === "dirty") fs.appendFileSync(path.join(f.root, "src/task.mjs"), "// changed\n");
    if (scenario === "new-head") { write(path.join(f.root, "extra.txt"), "new\n"); commit(f.root, "new head"); }
    if (scenario === "history-hash") f.entry.result_history[f.integration.result_sha256].child_head = f.base;
    if (scenario === "running") f.dependencies.readTaskProcessFn = () => ({ running: true, terminal: false });
    if (scenario === "touched-hand" || scenario === "scope-violation") {
      const hand = JSON.parse(fs.readFileSync(f.handPath));
      hand[scenario === "touched-hand" ? "touchedPaths" : "scopeViolations"] = ["src/task.mjs"];
      write(f.handPath, hand);
    }
    if (scenario === "new-negative-review" || scenario === "new-missing-review") {
      appendImplementationReviews(f, ["harness-security"]);
      const state = JSON.parse(fs.readFileSync(f.statePath));
      if (scenario === "new-missing-review") delete state.task_review_evidence[`${FEATURE}/${TASK}`].security;
      else state.task_review_evidence[`${FEATURE}/${TASK}`].security.accepted = false;
      write(f.statePath, state);
    }
    if (scenario === "input-digest") f.dependencies.captureReviewInputFn = () => ({ ok: true, snapshot: { head_sha: f.head, input_digest: "0".repeat(64) } });
    const inspected = inspectTaskResumeAbandonment(f.entry, { headSha: f.head }, f.dependencies);
    assert.equal(inspected.ok, false, scenario);
    assert.equal(f.entry.integration, null, scenario);
  }
});

function testOnlyRecovery({ capturedImplementation = true, productDelta = false, laterWriter = false,
  extraAuthor = false, earlierAuthorProductDrift = false, lateCapture = false, failedWriter = false,
  overlappingCapture = false, dirtyCaptureFirst = false, originOverride = {},
  fixture = inspectionFixture(), integrated = false, suffix = "" } = {}) {
  const f = fixture;
  if (integrated) archiveInspectedIntegration(f);
  let baseline = f.head;
  const eventsPath = f.entry.launches.at(-1).events_path;
  const extra = [];
  const add = (id, tool, args, result = { details: { ok: true } }) => {
    id += suffix;
    extra.push(event("tool_execution_start", { toolCallId: id, toolName: tool, args }));
    extra.push(event("tool_execution_end", { toolCallId: id, toolName: tool, isError: false, result }));
  };
  const prompt = '[HARNESS_TASK_CONTEXT]{"task_id":"' + TASK + '"}[/HARNESS_TASK_CONTEXT]';
  const capture = () => add("prior-capture", "mark", { action: "capture-verified", task_id: TASK },
    { details: { ok: true, capture_origin: { task_id: TASK, producer_call_id: "producer", head_sha: f.head,
      worktree_clean: true, ...originOverride } } });
  if (dirtyCaptureFirst) add("dirty-capture", "mark", { action: "capture-verified", task_id: TASK },
    { details: { ok: true, capture_origin: { task_id: TASK, producer_call_id: "producer", head_sha: f.freeze, worktree_clean: false } } });
  if (capturedImplementation && !lateCapture) capture();
  if (extraAuthor || earlierAuthorProductDrift || lateCapture) {
    add("earlier-author", "subagent", { subagent_type: "harness-test-author", prompt }, { details: { status: "completed" } });
    if (earlierAuthorProductDrift) {
      write(path.join(f.root, "src/task.mjs"), "export const actual = 'unverified earlier writer';\n");
      baseline = commit(f.root, "bad earlier author product");
    }
    add("earlier-eye", "subagent", { subagent_type: "harness-compliance" },
      { content: [{ type: "text", text: "Verdict: REVISE" }], details: { status: "completed" } });
  }
  if (capturedImplementation && lateCapture) capture();
  if (failedWriter) add("failed-sniper", "subagent", { subagent_type: "harness-sniper", prompt }, { details: { status: "failed" } });
  add("correct-author", "subagent", { subagent_type: "harness-test-author", prompt }, { details: { status: "completed" } });
  write(path.join(f.root, "src/task.spec.mjs"), "export const expected = { error: 'invalid_state" + suffix + "' };\n");
  if (productDelta) {
    write(path.join(f.root, "src/task.mjs"), "export const actual = 'unauthorized drift';\n");
    run(f.root, "git", "add", "src/task.mjs");
    run(f.root, "git", "commit", "-m", "unverified product");
  }
  add("correct-eye", "subagent", { subagent_type: "harness-compliance" }, {
    content: [{ type: "text", text: "Verdict: APPROVE" }], details: { status: "completed" } });
  run(f.root, "git", "add", "src/task.spec.mjs");
  run(f.root, "git", "commit", "-m", "correct oracle only");
  const freeze = run(f.root, "git", "rev-parse", "HEAD");
  add("correct-freeze", "bash", { command: "git commit -m correct" }, { content: [{ type: "text", text: "[task " + freeze.slice(0, 7) + "] correct" }] });
  add("correct-fidelity", "mark", { action: "fidelity", task_id: TASK });
  add("correct-capture", "mark", { action: "capture-verified", task_id: TASK });
  if (laterWriter) add("later-writer", "subagent", { subagent_type: "harness-sniper", prompt }, { details: { status: "completed" } });
  if (overlappingCapture) {
    const captureEnd = extra.findIndex((line) => { const e = JSON.parse(line); return e.type === "tool_execution_end" && e.toolCallId === "prior-capture"; });
    const [end] = extra.splice(captureEnd, 1);
    const authorStart = extra.findIndex((line) => { const e = JSON.parse(line); return e.type === "tool_execution_start" && e.args?.subagent_type === "harness-test-author"; });
    extra.splice(authorStart + 1, 0, end);
  }
  write(eventsPath, fs.readFileSync(eventsPath, "utf8") + extra.join("\n") + "\n");
  const recordPath = path.join(f.root, ".pi/harness/state/hand-records", FEATURE, CHILD, TASK + ".json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  write(recordPath, { ...record, agent: "harness-test-author", producerCallId: "correct-author" + suffix,
    freezeCommitSha: baseline, outcome: "DONE", capturedVerifiedAt: "2026-09-07T00:02:00.000Z" });
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  const bare = FEATURE + "/" + TASK;
  state.fidelity_pass.push(bare + "@" + freeze);
  state.capture_verified.push(bare + "@" + baseline);
  for (const receipt of [state.task_adversary_evidence[bare], ...Object.values(state.task_review_evidence[bare])]) receipt.reviewed_head_sha = freeze;
  write(f.statePath, state);
  f.dependencies.captureReviewInputFn = () => ({ ok: true, snapshot: { head_sha: freeze, input_digest: DIGEST } });
  return { ...f, head: freeze, recoveryBaseline: baseline };
}

test("a captured implementation survives a reviewed test-only correction without another executor", () => {
  const f = testOnlyRecovery({ extraAuthor: true, dirtyCaptureFirst: true });
  const inspected = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.result.hand_capture.agent, "harness-test-author");
  assert.equal(inspected.result.freeze_sha, f.head);
  assert.equal(inspected.result.hand_capture.freeze_sha, f.recoveryBaseline);
  assert.equal(inspected.result.hand_capture.recovery_origin.head_sha, f.recoveryBaseline);
});

function reconciledTestRecovery({ productDelta = false, memoryDelta = false } = {}) {
  const f = inspectionFixture();
  bindPinnedRuntime(f);
  appendImplementationReviews(f);
  const binding = f.dependencies.readTaskRunBindingFn();
  const upstreamTask = { id: "upstream", depends_on: [], scope_paths: ["upstream.mjs"],
    locked_tests: [{ id: "upstream-test", path: "upstream.spec.mjs", assertion: "upstream behavior" }] };
  binding.task.depends_on = [upstreamTask.id];
  binding.plan.tasks.unshift(upstreamTask);
  f.dependencies.readTaskRunBindingFn = () => binding;
  const planPath = path.join(f.root, ".pi/harness/plans", FEATURE, "execution-plan.json");
  write(planPath, { ...binding.plan, feature_id: FEATURE });
  f.entry.plan_sha256 = binding.grant.plan_sha256 = crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex");
  const oldResult = { child_head: f.base };
  const previous = { version: 1, written_by: "host-task-integration", task_id: "upstream", attempt_id: "upstream-attempt",
    session_id: "upstream-session", result_sha256: hashTaskReceipt(oldResult), parent_session_id: PARENT,
    feature_id: FEATURE, parent_root: f.root, plan_sha256: f.entry.plan_sha256, spec_sha256: f.entry.spec_sha256,
    child_head: f.base, integrated_head: f.base };
  binding.grant.dependencies = [{ task_id: "upstream", child_head: f.base, integrated_head: f.base,
    receipt: previous, receipt_sha256: hashTaskReceipt(previous) }];
  archiveInspectedIntegration(f);
  run(f.root, "git", "checkout", "-b", "upstream-correction", f.base);
  write(path.join(f.root, "upstream.spec.mjs"), "export const oracle = 'corrected';\n");
  if (productDelta) write(path.join(f.root, "upstream.mjs"), "export const behavior = 'changed';\n");
  if (memoryDelta) write(path.join(f.root, "MEMORY.md"), "Host-harvested lesson.\n");
  run(f.root, "git", "add", "upstream.spec.mjs", ...(productDelta ? ["upstream.mjs"] : []), ...(memoryDelta ? ["MEMORY.md"] : []));
  run(f.root, "git", "commit", "-m", "upstream correction");
  const parent = run(f.root, "git", "rev-parse", "HEAD");
  run(f.root, "git", "checkout", "-b", "dependent-recovery", f.head);
  run(f.root, "git", "merge", "--no-ff", "-m", "host reconciliation", parent);
  const merged = run(f.root, "git", "rev-parse", "HEAD");
  const result = { child_head: parent };
  const receipt = { ...previous, child_head: parent, integrated_head: parent, result_sha256: hashTaskReceipt(result) };
  const registry = { version: 1, parent_session_id: PARENT, feature_id: FEATURE,
    plan_sha256: f.entry.plan_sha256, spec_sha256: f.entry.spec_sha256,
    tasks: { upstream: { status: "integrated", attempt_id: "upstream-attempt", integration: receipt,
      integration_history: [previous], result, result_history: { [previous.result_sha256]: oldResult } } } };
  write(path.join(f.root, ".pi/harness/state", PARENT, "task-runs/index.json"), registry);
  f.entry.reconciliations = [{ written_by: "host-task-reconciliation", task_id: TASK, attempt_id: ATTEMPT,
    scope_base_sha: f.base, pre_child_head: f.head, parent_head: parent, merged_head: merged,
    tree: run(f.root, "git", "rev-parse", "HEAD^{tree}"), launch_count: f.entry.launches.length - 1,
    upstreams: [{ task_id: "upstream", attempt_id: "upstream-attempt", previous_receipt_sha256: hashTaskReceipt(previous), receipt }] }];
  return testOnlyRecovery({ fixture: { ...f, head: merged }, capturedImplementation: false });
}

test("test-only host reconciliation preserves captured implementation without a no-op writer", () => {
  for (const memoryDelta of [false, true]) {
    const f = reconciledTestRecovery({ memoryDelta });
    const inspected = inspectTaskRun(f.entry, f.dependencies);
    assert.equal(inspected.ok, true, inspected.reason);
    assert.equal(inspected.result.hand_capture.agent, "harness-test-author");
    assert.equal(inspected.result.hand_capture.recovery_origin.producer_launch_index, 0);
    // Reopening/recovering again must validate the reconciled receipt, not discard its proof.
    const second = testOnlyRecovery({ fixture: f, integrated: true, capturedImplementation: false, suffix: "-second" });
    const again = inspectTaskRun(second.entry, second.dependencies);
    assert.equal(again.ok, true, again.reason);
    assert.equal(again.result.hand_capture.recovery_origin.head_sha, f.head);
  }
});

test("a product change in host reconciliation still requires a current implementation producer", () => {
  const f = reconciledTestRecovery({ productDelta: true });
  const inspected = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /cannot change product/);
});

test("test-only reconciliation does not excuse child memory edits or a forged historical proof", () => {
  for (const variant of ["child-memory", "host-tree", "historical-digest"]) {
    const f = reconciledTestRecovery({ memoryDelta: true });
    assert.equal(inspectTaskRun(f.entry, f.dependencies).ok, true, variant + " baseline");
    if (variant === "child-memory") {
      write(path.join(f.root, "MEMORY.md"), "Unowned child write.\n");
      run(f.root, "git", "add", "MEMORY.md");
      run(f.root, "git", "commit", "-m", "unowned child memory");
    } else if (variant === "host-tree") {
      f.entry.reconciliations[0].tree = f.base;
    } else {
      const integration = f.entry.integration_history.at(-1);
      const result = f.entry.result_history[integration.result_sha256];
      result.reconciliation_sha256 = hashTaskReceipt(f.entry.reconciliations);
      integration.result_sha256 = hashTaskReceipt(result);
      f.entry.result_history[integration.result_sha256] = result;
    }
    assert.equal(inspectTaskRun(f.entry, f.dependencies).ok, false, variant);
  }
});

test("host-integrated implementation survives dirty capture and two test-only recoveries", () => {
  const f = inspectionFixture();
  bindPinnedRuntime(f);
  const recordPath = path.join(f.root, ".pi/harness/state/hand-records", FEATURE, CHILD, TASK + ".json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  write(recordPath, { ...record, freezeCommitSha: f.freeze });
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  state.capture_verified = [FEATURE + "/" + TASK + "@" + f.freeze];
  write(f.statePath, state);
  fs.appendFileSync(f.entry.launches.at(-1).events_path, [
    event("tool_execution_start", { toolCallId: "dirty-capture", toolName: "mark", args: { action: "capture-verified", task_id: TASK } }),
    event("tool_execution_end", { toolCallId: "dirty-capture", toolName: "mark", result: { details: {
      ok: true, capture_origin: { task_id: TASK, producer_call_id: "producer", head_sha: f.freeze, worktree_clean: false },
    } } }), "",
  ].join("\n"));
  const first = testOnlyRecovery({ fixture: f, integrated: true, capturedImplementation: false });
  const inspected = inspectTaskRun(first.entry, first.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.result.hand_capture.recovery_origin.head_sha, f.head);
  const second = testOnlyRecovery({ fixture: first, integrated: true, capturedImplementation: false, suffix: "-second" });
  const again = inspectTaskRun(second.entry, second.dependencies);
  assert.equal(again.ok, true, again.reason);
  assert.equal(again.result.hand_capture.recovery_origin.head_sha, first.head);
});

test("historical recovery revalidates the immediate host pair without older fallback", () => {
  const mutations = {
    hash: (result, integration) => { integration.result_sha256 = "0".repeat(64); },
    attempt: (result) => { result.attempt_id = "other-attempt"; },
    session: (result, integration) => { result.session_id = integration.session_id = "ses-other-child"; },
    parentSession: (result) => { result.parent_session_id = "ses-other-parent"; },
    plan: (result) => { result.plan_sha256 = "1".repeat(64); },
    spec: (result) => { result.spec_sha256 = "2".repeat(64); },
    inspectionOwner: (result) => { result.written_by = "child"; },
    integrationOwner: (result, integration) => { integration.written_by = "child"; },
    runtime: (result) => { result.runtime.sha256 = "3".repeat(64); },
    worktree: (result) => { result.worktree += "-other"; },
    frozenPaths: (result) => { result.frozen_blobs["src/task.mjs"] = DIGEST; },
    producer: (result) => { result.hand_capture.producer_call_id = "foreign"; },
    ancestry: (result, integration) => { result.child_head = integration.child_head = "0".repeat(40); },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const f = inspectionFixture();
    bindPinnedRuntime(f);
    const recovery = testOnlyRecovery({ fixture: f, integrated: true });
    assert.equal(inspectTaskRun(recovery.entry, recovery.dependencies).ok, true, name + " baseline");
    const valid = f.entry.integration_history.at(-1);
    const result = structuredClone(f.entry.result_history[valid.result_sha256]);
    const invalid = structuredClone(valid);
    mutate(result, invalid);
    if (name !== "hash") invalid.result_sha256 = hashTaskReceipt(result);
    f.entry.result_history[invalid.result_sha256] = result;
    f.entry.integration_history.push(invalid);
    assert.equal(inspectTaskRun(recovery.entry, recovery.dependencies).ok, false, name);
  }
});

test("historical recovery requires the result at its exact digest key", () => {
  const f = testOnlyRecovery({ integrated: true });
  assert.equal(inspectTaskRun(f.entry, f.dependencies).ok, true);
  const integration = f.entry.integration_history.at(-1);
  const result = f.entry.result_history[integration.result_sha256];
  for (const history of [{ wrong_key: result }, [result]]) {
    f.entry.result_history = history;
    assert.equal(inspectTaskRun(f.entry, f.dependencies).ok, false);
  }
});

test("integrated recovery rejects product drift, later writers and forged recovery origins", () => {
  for (const options of [{ productDelta: true }, { laterWriter: true }, { failedWriter: true }]) {
    const f = testOnlyRecovery({ integrated: true, capturedImplementation: false, ...options });
    assert.equal(inspectTaskRun(f.entry, f.dependencies).ok, false, JSON.stringify(options));
  }
  const first = testOnlyRecovery({ integrated: true, capturedImplementation: false });
  const second = testOnlyRecovery({ fixture: first, integrated: true, capturedImplementation: false, suffix: "-second" });
  const integration = second.entry.integration_history.at(-1);
  const result = second.entry.result_history[integration.result_sha256];
  result.hand_capture.recovery_origin.producer_call_id = "forged";
  integration.result_sha256 = hashTaskReceipt(result);
  second.entry.result_history[integration.result_sha256] = result;
  assert.equal(inspectTaskRun(second.entry, second.dependencies).ok, false);
});

test("test-only recovery cannot cover an uncaptured implementation, product drift or later writer", () => {
  for (const options of [{ capturedImplementation: false }, { productDelta: true }, { laterWriter: true },
    { earlierAuthorProductDrift: true }, { lateCapture: true }, { failedWriter: true },
    { overlappingCapture: true }, { originOverride: { head_sha: undefined } },
    { originOverride: { worktree_clean: false } }, { originOverride: { producer_call_id: "foreign" } },
    { originOverride: { head_sha: "0".repeat(40) } }]) {
    const f = testOnlyRecovery(options);
    assert.equal(inspectTaskRun(f.entry, f.dependencies).ok, false, JSON.stringify(options));
  }
});

test("uncaptured recovery reports a current upstream blocker without authorizing integration", () => {
  const f = testOnlyRecovery({ capturedImplementation: false });
  const head = run(f.root, "git", "rev-parse", "HEAD");
  const content = "BLOCKED: current RED requires correction in upstream task-3 before this task can finish.";
  const context = { version: 1, kind: "task-context-return", session_id: CHILD, task_id: TASK,
    head_sha: head, content, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  f.dependencies.readTaskContextReturnFn = () => context;
  const inspected = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /clean captured implementation/);
  assert.deepEqual(inspected.details?.context_return, context);
  assert.equal(inspected.result, undefined);
  f.dependencies.readTaskContextReturnFn = () => ({ ...context, head_sha: f.base });
  assert.equal(inspectTaskRun(f.entry, f.dependencies).details?.context_return, undefined);
});

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
    write(eventsPath, replaceEventText(events, "fidelity-eye", `Fidelity evidence.\nVerdict: ${verdict}`));
    const rejectedReview = inspectTaskRun(fixture.entry, fixture.dependencies);
    assert.equal(rejectedReview.ok, false, verdict);
    assert.match(rejectedReview.reason, /harness-test-reviewer/);
  }

  for (const invalid of [
    "Verdict: APPROVED",
    "Verdict: REVISE\nVerdict: APPROVE",
    "Evidence excerpt:\nVerdict: APPROVE\nActual conclusion: review blocked.",
    "Verdict: APPROVE\nVerdict: REVISE.",
    "Verdict: APPROVE\nEvidence\n**Verdict:** REVISE",
    "Verdict: APPROVE\nEvidence\n> Verdict: REVISE",
    "Verdict: APPROVE\nEvidence\n- Verdict: BLOCKED",
  ]) {
    write(eventsPath, replaceEventText(events, "fidelity-eye", invalid));
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

test("dedicated test reviewer accepts one canonical APPROVE verdict before its evidence prose", () => {
  const fixture = inspectionFixture();
  bindPinnedRuntime(fixture, { testReviewer: true });
  const eventsPath = fixture.entry.launches.at(-1).events_path;
  const events = fs.readFileSync(eventsPath, "utf8")
    .replace('"subagent_type":"harness-compliance"', '"subagent_type":"harness-test-reviewer"')
    .replace(
      "Fidelity evidence.\\nVerdict: APPROVE",
      "Agent completed in 2.0s (3 tool uses).\\nAgent ID: child-1\\n\\nVerdict: APPROVE\\n\\nPhase: test-fidelity. All obligations pass.",
    );
  write(eventsPath, events);

  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);

  assert.equal(inspected.ok, true, inspected.reason);
});

test("dedicated test reviewer accepts consistent boundary approvals in persisted evidence", () => {
  const fixture = inspectionFixture();
  bindPinnedRuntime(fixture, { testReviewer: true });
  const eventsPath = fixture.entry.launches.at(-1).events_path;
  const events = fs.readFileSync(eventsPath, "utf8")
    .replace('"subagent_type":"harness-compliance"', '"subagent_type":"harness-test-reviewer"')
    .replace("Fidelity evidence.\\nVerdict: APPROVE", "Verdict: APPROVE\\nFidelity evidence.\\nVerdict: APPROVE");
  write(eventsPath, events);
  const before = fs.readFileSync(eventsPath, "utf8");
  for (let restart = 0; restart < 2; restart++) {
    const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
    assert.equal(inspected.ok, true, inspected.reason);
    assert.equal(fs.readFileSync(eventsPath, "utf8"), before, "approval is interpreted without rewriting native evidence");
  }
});

test("reconciled dependencies keep original audit paths but require fresh reviews and exact host merge proof", () => {
  const f = inspectionFixture();
  appendImplementationReviews(f);
  const specPath = path.join(f.root, ".pi/harness/plans", FEATURE, "spec.md");
  write(specPath, "Approved dependency recovery spec\n");
  f.entry.spec_sha256 = f.dependencies.readTaskRunBindingFn().grant.spec_sha256 =
    crypto.createHash("sha256").update(fs.readFileSync(specPath)).digest("hex");
  // A correction outside the dependent task scope is supplied only by a host merge.
  run(f.root, "git", "checkout", "-b", "parent-correction", f.base);
  write(path.join(f.root, "upstream.mjs"), "export const corrected = true;\n");
  run(f.root, "git", "add", "upstream.mjs");
  run(f.root, "git", "commit", "-m", "upstream correction");
  const parent = run(f.root, "git", "rev-parse", "HEAD");
  run(f.root, "git", "checkout", "-b", "dependent-recovery", f.head);
  run(f.root, "git", "merge", "--no-ff", "-m", "host dependency merge", parent);
  const head = run(f.root, "git", "rev-parse", "HEAD");
  const planPath = path.join(f.root, ".pi/harness/plans", FEATURE, "execution-plan.json");
  write(planPath, { feature_id: FEATURE, tasks: [{ id: "upstream", depends_on: [] }, { id: "unregistered", depends_on: [] }, { id: TASK, depends_on: ["upstream"] }] });
  fs.appendFileSync(path.join(f.root, ".git/info/exclude"), "\n.pi/harness/plans/\n");
  f.entry.plan_sha256 = crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex");
  f.dependencies.readTaskRunBindingFn().grant.plan_sha256 = f.entry.plan_sha256;
  const oldResult = { child_head: f.base };
  const correctedResult = { child_head: parent };
  const receipt = {
    version: 1, written_by: "host-task-integration", task_id: "upstream", attempt_id: "upstream-attempt",
    session_id: "upstream-session", result_sha256: hashTaskReceipt(correctedResult),
    parent_session_id: PARENT, feature_id: FEATURE, parent_root: f.root,
    plan_sha256: f.entry.plan_sha256, spec_sha256: f.entry.spec_sha256,
    child_head: parent, integrated_head: parent,
  };
  const previous = { ...receipt, child_head: f.base, integrated_head: f.base, result_sha256: hashTaskReceipt(oldResult) };
  const registryPath = path.join(f.root, ".pi/harness/state", PARENT, "task-runs/index.json");
  const registry = { version: 1, parent_session_id: PARENT, feature_id: FEATURE,
    plan_sha256: f.entry.plan_sha256, spec_sha256: f.entry.spec_sha256,
    tasks: { upstream: { status: "integrated", attempt_id: "upstream-attempt", integration: receipt, integration_history: [previous],
      result: correctedResult, result_history: { [previous.result_sha256]: oldResult } } } };
  write(registryPath, registry);
  f.entry.reconciliations = [{
    written_by: "host-task-reconciliation", task_id: TASK, attempt_id: ATTEMPT,
    scope_base_sha: f.base, pre_child_head: f.head, parent_head: parent,
    merged_head: head, tree: run(f.root, "git", "rev-parse", "HEAD^{tree}"), launch_count: 1,
    upstreams: [{ task_id: "upstream", attempt_id: "upstream-attempt", previous_receipt_sha256: hashTaskReceipt(previous), receipt }],
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
  assert.equal(inspectTaskRun(f.entry, f.dependencies).ok, true, "ancestral positives survive the captured reconciliation");
  state.task_adversary_evidence[bare] = review("harness-adversary", head);
  state.task_review_evidence[bare] = { compliance: review("harness-compliance", head), security: review("harness-security", head) };
  write(f.statePath, state);
  const current = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(current.ok, true, current.reason);
  assert.equal(current.result.base_sha, f.base);
  assert.equal(current.result.scope_base_sha, parent);
  assert.match(current.result.reconciliation_sha256, /^[a-f0-9]{64}$/);
  assert.ok(current.result.changed_paths.includes("upstream.mjs"), "audit retains inherited changes");
  // Real #237: the host merged upstream; the child recaptured its unchanged
  // producer at the merged HEAD. Replaying capture does not rewrite freezeCommitSha.
  const beforeReplay = fs.readFileSync(launch.events_path, "utf8");
  write(handPath, hand);
  state.capture_verified = [`${bare}@${hand.freezeCommitSha}`];
  write(f.statePath, state);
  write(launch.events_path, [event("session", { id: CHILD }),
    event("tool_execution_start", { toolCallId: "recapture", toolName: "mark", args: { action: "capture-verified", task_id: TASK } }),
    event("tool_execution_end", { toolCallId: "recapture", toolName: "mark", result: { details: {
      ok: true, capture_origin: { task_id: TASK, producer_call_id: hand.producerCallId, head_sha: head, worktree_clean: true },
    }, content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } }), ""].join("\n"));
  const recaptured = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(recaptured.ok, true, recaptured.reason);
  assert.equal(recaptured.result.hand_capture.producer_call_id, hand.producerCallId);
  // The exact inspection emitted above must remain consumable after integration
  // and reopening; preserving capture only at status is not sufficient.
  const grant = { ...f.dependencies.readTaskRunBindingFn().grant, version: 1, kind: "task-run",
    origin: { kind: "parent-approved-plan", plan_review_call_id: "plan-current" } };
  write(path.join(f.root, ".pi/harness/state", PARENT, "gate-state.json"), {
    session_id: PARENT, feature_id: FEATURE, mode: "FULL", spec_status: "adversary-reviewed",
    reviewed_spec_sha256: f.entry.spec_sha256, adversary_fired: true, adversary_spec_sha256: f.entry.spec_sha256,
    plan_review_evidence: { written_by: "host-subagent-completion", parent_session_id: PARENT,
      feature_id: FEATURE, role: "harness-plan-reviewer", status: "completed", verdict: "APPROVE",
      dispatch_call_id: "plan-current", child_session_id: "plan-child", agent_id: "plan-agent",
      plan_sha256: f.entry.plan_sha256, spec_sha256: f.entry.spec_sha256 },
  });
  const result = recaptured.result;
  const integration = { version: 1, written_by: "host-task-integration", parent_session_id: PARENT,
    feature_id: FEATURE, task_id: TASK, attempt_id: ATTEMPT, parent_root: f.root, worktree: f.root,
    session_id: CHILD, plan_sha256: f.entry.plan_sha256, spec_sha256: f.entry.spec_sha256,
    base_sha: f.base, child_head: head, integrated_head: head, result_sha256: hashTaskReceipt(result) };
  registry.tasks[TASK] = { ...f.entry, grant, status: "integrated", result, integration };
  write(registryPath, registry);
  const readFinal = () => readIntegratedTaskEvidence({ projectRoot: f.root, sessionId: PARENT,
    featureId: FEATURE, taskId: TASK, headSha: head });
  const registryBefore = fs.readFileSync(registryPath, "utf8");
  for (let restart = 0; restart < 2; restart++) {
    const final = readFinal();
    assert.equal(final.ok, true, final.reason);
    assert.equal(fs.readFileSync(registryPath, "utf8"), registryBefore, "final read must not rewrite receipt hashes");
  }
  const validReplay = fs.readFileSync(launch.events_path, "utf8");
  for (const override of [{ head_sha: f.head }, { worktree_clean: false }, { producer_call_id: "foreign" }, { task_id: "other-task" }]) {
    const rows = validReplay.trim().split("\n").map(JSON.parse);
    Object.assign(rows.find((row) => row.type === "tool_execution_end").result.details.capture_origin, override);
    write(launch.events_path, rows.map(JSON.stringify).join("\n") + "\n");
    assert.equal(inspectTaskRun(f.entry, f.dependencies).ok, false, JSON.stringify(override));
    assert.equal(readFinal().ok, false, `final gate must reject ${JSON.stringify(override)}`);
  }
  const foreignSession = validReplay.replace(`"id":"${CHILD}"`, '"id":"foreign-child"');
  write(launch.events_path, foreignSession);
  assert.equal(readFinal().ok, false, "foreign child event stream is not capture authority");
  const originalEvents = fs.readFileSync(oldLaunch.events_path, "utf8");
  write(oldLaunch.events_path, originalEvents + validReplay);
  write(launch.events_path, event("session", { id: CHILD }) + "\n");
  assert.equal(readFinal().ok, false, "capture before the reconciliation launch cannot approve final evidence");
  write(oldLaunch.events_path, originalEvents);
  write(launch.events_path, validReplay);
  assert.equal(readFinal().ok, true, "restored native evidence revalidates without rewriting the integrated receipt");
  const interruptedEntry = structuredClone(registry.tasks[TASK]);
  interruptedEntry.launches.splice(1, 0, { ...oldLaunch, run_id: "interrupted-history",
    events_path: path.join(f.entry.job_dir, "interrupted-history", "events.jsonl") });
  interruptedEntry.result.launches.splice(1, 0, { ...result.launches[0], run_id: "interrupted-history",
    interrupted: true, exit_code: null, signal: "UNKNOWN", ended_at: null });
  interruptedEntry.integration.result_sha256 = hashTaskReceipt(interruptedEntry.result);
  registry.tasks[TASK] = interruptedEntry;
  write(registryPath, registry);
  const interruptedFinal = readFinal();
  assert.equal(interruptedFinal.ok, true, interruptedFinal.reason);
  delete interruptedEntry.result.launches[1].interrupted;
  interruptedEntry.integration.result_sha256 = hashTaskReceipt(interruptedEntry.result);
  write(registryPath, registry);
  assert.equal(readFinal().ok, false, "missing ordinary launch events still fail closed");
  registry.tasks[TASK] = { ...f.entry, grant, status: "integrated", result, integration };
  write(registryPath, registry);
  write(launch.events_path, beforeReplay);
  write(handPath, { ...hand, freezeCommitSha: head, producerCallId: "recovered-producer" });
  state.capture_verified = [`${bare}@${head}`];
  write(f.statePath, state);
  const unregistered = structuredClone(f.entry);
  unregistered.reconciliations[0].upstreams[0].task_id = "unregistered";
  unregistered.reconciliations[0].upstreams[0].receipt.task_id = "unregistered";
  assert.equal(inspectTaskRun(unregistered, f.dependencies).ok, false, "an internally consistent but unregistered upstream receipt is not authority");
  const siblingPrevious = { ...previous, task_id: "unregistered" };
  unregistered.reconciliations[0].upstreams[0].previous_receipt_sha256 = hashTaskReceipt(siblingPrevious);
  registry.tasks.unregistered = { ...registry.tasks.upstream,
    integration: unregistered.reconciliations[0].upstreams[0].receipt,
    integration_history: [siblingPrevious] };
  write(registryPath, registry);
  assert.match(inspectTaskRun(unregistered, f.dependencies).reason, /not a registered ancestor/, "a registered sibling is not dependency authority");
  const results = registry.tasks.upstream.result_history;
  registry.tasks.upstream.result_history = {};
  write(registryPath, registry);
  assert.match(inspectTaskRun(f.entry, f.dependencies).reason, /matching registry history and result/);
  registry.tasks.upstream.result_history = results;
  write(registryPath, registry);
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
  const sessionEntries = [];
  const nativeCompleted = (id, name, args, text = "", details = { status: "completed" }) => {
    sessionEntries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
    sessionEntries.push({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, details, content: [{ type: "text", text }] } });
  };
  const nativePrompt = `[HARNESS_TASK_CONTEXT]{"task_id":"${TASK}"}[/HARNESS_TASK_CONTEXT]`;
  const authority = createPiMarkerAuthority({
    projectRoot: root,
    readSessionEntries: () => sessionEntries,
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
  nativeCompleted("author", "subagent", { subagent_type: "harness-test-author", prompt: nativePrompt });
  nativeCompleted("reviewer", "subagent", { subagent_type: "harness-test-reviewer", prompt: nativePrompt }, "Verdict: APPROVE");
  nativeCompleted("freeze", "bash", { command: "git commit -m freeze" }, `[task ${freeze}] freeze`, {});
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
  nativeCompleted("executor", "subagent", { subagent_type: "harness-executor", prompt: nativePrompt });
  mark("fidelity", "resume-fidelity");

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
    event("tool_execution_start", { toolCallId: "call-harness-adversary", toolName: "subagent", args: { subagent_type: "harness-adversary", prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${TASK}"}[/HARNESS_TASK_CONTEXT]` } }),
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

test("inspectTaskRun requires initial compliance without inventing adversary or security reviews", () => {
  const fixture = inspectionFixture();
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  delete state.task_adversary_evidence;
  delete state.task_review_evidence[`${FEATURE}/${TASK}`].security;
  write(fixture.statePath, state);
  const inspected = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(inspected.ok, true, inspected.reason);
  assert.deepEqual(Object.keys(inspected.result.review_receipts), ["compliance"]);

  delete state.task_review_evidence;
  write(fixture.statePath, state);
  const missing = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /accepted compliance task review/i);
});

test("LIGHT task inspection accepts no implementation reviews", () => {
  const f = inspectionFixture();
  const binding = f.dependencies.readTaskRunBindingFn();
  f.dependencies.readTaskRunBindingFn = () => ({ ...binding, plan: { ...binding.plan, mode: "light" } });
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  delete state.task_review_evidence;
  delete state.task_adversary_evidence;
  write(f.statePath, state);
  const result = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.result.review_receipts, {});
});

test("LIGHT legacy pending re-gate does not invent implementation reviews", () => {
  const f = inspectionFixture();
  const binding = f.dependencies.readTaskRunBindingFn();
  f.dependencies.readTaskRunBindingFn = () => ({ ...binding, plan: { ...binding.plan, mode: "light" } });
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  delete state.task_review_evidence;
  delete state.task_adversary_evidence;
  state.regate_pending = [`${FEATURE}/${TASK}`];
  write(f.statePath, state);
  const before = fs.readFileSync(f.statePath, "utf8");
  const result = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.result.review_receipts, {});
  assert.deepEqual(result.result.regate.pending, state.regate_pending);
  assert.equal(fs.readFileSync(f.statePath, "utf8"), before, "inspection must not forge a marker");
  state.capture_verified = [];
  write(f.statePath, state);
  assert.match(inspectTaskRun(f.entry, f.dependencies).reason, /capture markers are incomplete/);
});

test("LIGHT pending re-gate still enforces an actually dispatched negative review", () => {
  const f = inspectionFixture();
  const binding = f.dependencies.readTaskRunBindingFn();
  f.dependencies.readTaskRunBindingFn = () => ({ ...binding, plan: { ...binding.plan, mode: "light" } });
  appendImplementationReviews(f, ["harness-security"]);
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  state.regate_pending = [`${FEATURE}/${TASK}`];
  state.task_review_evidence[`${FEATURE}/${TASK}`].security.accepted = false;
  write(f.statePath, state);
  const result = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing or negative reviews/);
});

test("task inspection preserves ancestral positive reviews but stale negatives still block", () => {
  const f = inspectionFixture();
  appendImplementationReviews(f, ["harness-security"]);
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  const receipt = state.task_review_evidence[`${FEATURE}/${TASK}`].security;
  receipt.reviewed_head_sha = f.freeze;
  receipt.input_digest = "e".repeat(64);
  write(f.statePath, state);
  assert.equal(inspectTaskRun(f.entry, f.dependencies).ok, true);
  receipt.accepted = false;
  write(f.statePath, state);
  assert.match(inspectTaskRun(f.entry, f.dependencies).reason, /accepted security task review/);
});

test("an ancestral approval dispatched before executor completion cannot satisfy implementation review", () => {
  for (const timing of ["before", "in-flight", "after"]) {
    const f = inspectionFixture();
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
    const receipt = state.task_review_evidence[`${FEATURE}/${TASK}`].security;
    receipt.reviewed_head_sha = f.freeze;
    receipt.input_digest = "e".repeat(64);
    write(f.statePath, state);
    const file = f.entry.launches.at(-1).events_path;
    const events = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    const review = event("tool_execution_start", { toolCallId: receipt.dispatch_call_id, toolName: "subagent", args: {
      subagent_type: "harness-security", prompt: '[HARNESS_TASK_REVIEW]\n[HARNESS_TASK_CONTEXT]{"task_id":"' + TASK + '"}[/HARNESS_TASK_CONTEXT]',
    } });
    const producerStart = events.findIndex((line) => { const row = JSON.parse(line); return row.type === "tool_execution_start" && row.toolCallId === "producer"; });
    const producerEnd = events.findIndex((line) => { const row = JSON.parse(line); return row.type === "tool_execution_end" && row.toolCallId === "producer"; });
    events.splice(timing === "before" ? producerStart : timing === "in-flight" ? producerEnd : events.length, 0, review);
    write(file, events.join("\n") + "\n");
    const result = inspectTaskRun(f.entry, f.dependencies);
    assert.equal(result.ok, timing === "after", result.reason ?? timing);
  }
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

test("context-first adversary redispatch supersedes an older approval", () => {
  const f = inspectionFixture();
  fs.appendFileSync(f.entry.launches.at(-1).events_path, event("tool_execution_start", {
    toolCallId: "new-adversary", toolName: "subagent", args: { subagent_type: "harness-adversary",
      prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"' + TASK + '"}[/HARNESS_TASK_CONTEXT]' },
  }) + "\n");
  assert.match(inspectTaskRun(f.entry, f.dependencies).reason, /accepted adversary task review/);
});

test("repeating fidelity after captured implementation preserves the original freeze chain", () => {
  const f = inspectionFixture();
  fs.appendFileSync(f.entry.launches.at(-1).events_path, [
    event("tool_execution_start", { toolCallId: "impl-commit", toolName: "bash", args: { command: "git commit -m product" } }),
    event("tool_execution_end", { toolCallId: "impl-commit", toolName: "bash", result: { content: [{ type: "text", text: "[task " + f.head + "] product" }] } }),
    event("tool_execution_start", { toolCallId: "resumed-fidelity", toolName: "mark", args: { action: "fidelity", task_id: TASK } }),
    event("tool_execution_end", { toolCallId: "resumed-fidelity", toolName: "mark", result: { details: { ok: true } } }), "",
  ].join("\n"));
  const result = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.result.freeze_sha, f.freeze);
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

test("accepted task reviews close pending re-gate through the native marker without new dispatches", () => {
  const f = inspectionFixture();
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  state.regate_pending = [`${FEATURE}/${TASK}`];
  write(f.statePath, state);
  const beforeEvents = fs.readFileSync(f.entry.launches.at(-1).events_path, "utf8");
  const blocked = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /reviews are accepted.*task session.*regate-passed/);
  assert.match(blocked.reason, /Do not repeat writers or accepted reviews/);
  const authority = createPiMarkerAuthority({ projectRoot: f.root,
    captureReviewInputFn: f.dependencies.captureReviewInputFn });
  const params = { action: "regate-passed", task_id: TASK };
  assert.deepEqual(authority.authorize({ toolName: "mark", input: params,
    sessionId: CHILD, toolCallId: "close-regate" }), { ok: true });
  const result = authority.execute({ toolCallId: "close-regate", params,
    sessionId: CHILD, isChild: false });
  assert.equal(result.ok, true, result.output);
  const ready = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(ready.ok, true, ready.reason);
  assert.equal(ready.result.child_head, f.head);
  const after = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.deepEqual(after.task_review_evidence, state.task_review_evidence);
  assert.deepEqual(after.task_adversary_evidence, state.task_adversary_evidence);
  assert.equal(fs.readFileSync(f.entry.launches.at(-1).events_path, "utf8"), beforeEvents);
});

test("blocked re-gate exposes current task context and review findings without a ready receipt", () => {
  const fixture = inspectionFixture();
  const content = "Fix the task-1 signer before resuming task-4; task-4 cannot fix its dependency.";
  const context = { version: 1, kind: "task-context-return", session_id: CHILD, task_id: TASK,
    head_sha: fixture.head, content, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  fixture.dependencies.readTaskContextReturnFn = () => context;
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  state.regate_pending = [FEATURE + "/" + TASK];
  const security = state.task_review_evidence[FEATURE + "/" + TASK].security;
  security.accepted = false;
  security.report = { issues: [{ description: "Signing precedes the ownership check", category: "auth",
    severity: "high", scope: "task-1", evidence: "src/task.mjs:1", fix_hint: "Validate before signing" }] };
  security.report_digest = crypto.createHash("sha256").update(JSON.stringify(security.report)).digest("hex");
  write(fixture.statePath, state);
  const blocked = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /re-gate.*pending/);
  assert.match(blocked.reason, /resolve only missing or negative reviews/);
  assert.equal(blocked.result, undefined);
  assert.deepEqual(blocked.details.context_return, context);
  assert.deepEqual(blocked.details.review_findings, [{ role: "harness-security", issues: security.report.issues }]);

  security.input_digest = "0".repeat(64);
  write(fixture.statePath, state);
  const staleReview = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(staleReview.ok, false);
  assert.deepEqual(staleReview.details.review_findings, []);
  fixture.dependencies.readTaskContextReturnFn = () => ({ ...context, head_sha: fixture.base });
  const staleContext = inspectTaskRun(fixture.entry, fixture.dependencies);
  assert.equal(staleContext.ok, false);
  assert.equal(staleContext.details?.context_return, undefined);
});

test("blocked author preserves current scope diagnosis without a capture or ready receipt", () => {
  const f = inspectionFixture();
  const handPath = path.join(f.root, ".pi", "harness", "state", "hand-records", FEATURE, CHILD, `${TASK}.json`);
  const previous = JSON.parse(fs.readFileSync(handPath, "utf8"));
  write(handPath, { ...previous, agent: "harness-test-author", outcome: "BLOCKED", capturedVerifiedAt: null });
  const content = "PLAN_CONTRADICTION: src/lib/publish/publish-publicacao.spec.ts is outside admitted test scope; do not redispatch without changing authorization.";
  const context = { version: 1, kind: "task-context-return", session_id: CHILD, task_id: TASK,
    head_sha: f.head, content, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  f.dependencies.readTaskContextReturnFn = () => context;
  const blocked = inspectTaskRun(f.entry, f.dependencies);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /not capture-eligible/);
  assert.equal(blocked.result, undefined);
  assert.deepEqual(blocked.details?.context_return, context);
  for (const invalid of [
    { ...context, session_id: "foreign-session" },
    { ...context, task_id: "foreign-task" },
    { ...context, head_sha: f.base },
    { ...context, sha256: "0".repeat(64) },
  ]) {
    f.dependencies.readTaskContextReturnFn = () => invalid;
    const rejected = inspectTaskRun(f.entry, f.dependencies);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.result, undefined);
    assert.equal(rejected.details?.context_return, undefined);
  }
  f.dependencies.readTaskContextReturnFn = () => null;
  assert.equal(inspectTaskRun(f.entry, f.dependencies).details?.context_return, undefined);
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

function integratedFixture({ lockedPaths = [], mode = "full" } = {}) {
  const { root, base } = repo();
  const planPath = path.join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json");
  const specPath = path.join(root, ".pi", "harness", "plans", FEATURE, "spec.md");
  write(planPath, { feature_id: FEATURE, mode, tasks: [{ id: TASK,
    locked_tests: lockedPaths.map((file, index) => ({ id: "locked-" + index, path: file })) }] });
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

test("integration accepts the inspected test-author recovery lineage but not product drift", () => {
  for (const scenario of ["valid", "product-drift", "forged-frozen-product"]) {
    const productDrift = scenario !== "valid";
    const f = integratedFixture({ lockedPaths: ["acceptance.test.mjs"] });
    write(path.join(f.root, "acceptance.test.mjs"), "export const expected = 1;\n");
    run(f.root, "git", "add", "acceptance.test.mjs");
    if (productDrift) {
      write(path.join(f.root, "README.md"), "changed product baseline\n");
      run(f.root, "git", "add", "README.md");
    }
    run(f.root, "git", "commit", "-m", "reviewed test correction");
    const head = run(f.root, "git", "rev-parse", "HEAD");
    const result = f.entry.result;
    result.child_head = head;
    result.freeze_sha = head;
    result.frozen_blobs = { "acceptance.test.mjs": crypto.createHash("sha256").update("export const expected = 1;\n").digest("hex") };
    result.changed_paths = run(f.root, "git", "diff", "--name-only", f.base, head).split("\n");
    result.hand_capture.agent = "harness-test-author";
    result.hand_capture.recovery_origin = { head_sha: f.base, producer_call_id: "captured-executor", producer_launch_index: 0 };
    if (scenario === "forged-frozen-product") result.frozen_blobs["README.md"] =
      crypto.createHash("sha256").update(fs.readFileSync(path.join(f.root, "README.md"))).digest("hex");
    f.integration.child_head = head;
    f.integration.integrated_head = head;
    f.integration.result_sha256 = hashTaskReceipt(result);
    write(f.registryPath, f.registry);
    const checked = readIntegratedTaskEvidence({ projectRoot: f.root, sessionId: PARENT, featureId: FEATURE, taskId: TASK, headSha: head });
    assert.equal(checked.ok, !productDrift, checked.reason);
  }
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

test("integrated task entries cannot redirect authority to another parent root", () => {
  const f = integratedFixture();
  f.entry.parent_root = path.join(f.root, "foreign-owner");
  write(f.registryPath, f.registry);
  const inspected = readIntegratedTaskEvidence({ projectRoot: f.root, sessionId: PARENT,
    featureId: FEATURE, taskId: TASK, headSha: f.base });
  assert.equal(inspected.ok, false);
  assert.match(inspected.reason, /parent root/);
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

test("readIntegratedTaskEvidence accepts baseline compliance and rejects an omitted required eye", () => {
  const fixture = integratedFixture();
  fixture.registry.tasks[TASK].result.review_receipts = {
    compliance: fixture.registry.tasks[TASK].result.review_receipts.compliance,
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
  assert.deepEqual(Object.keys(evidence.entry.result.review_receipts), ["compliance"]);
  fixture.registry.tasks[TASK].result.review_receipts = {};
  fixture.registry.tasks[TASK].integration.result_sha256 = hashTaskReceipt(fixture.registry.tasks[TASK].result);
  write(fixture.registryPath, fixture.registry);
  assert.equal(readIntegratedTaskEvidence({ projectRoot: fixture.root, sessionId: PARENT,
    featureId: FEATURE, taskId: TASK, headSha: fixture.base }).ok, false);
});

test("LIGHT integration accepts a receipt without implementation eyes", () => {
  const f = integratedFixture({ mode: "light" });
  f.entry.result.review_receipts = {};
  f.entry.result.regate = { pending: [`${FEATURE}/${TASK}`], passed: [] };
  f.entry.integration.result_sha256 = hashTaskReceipt(f.entry.result);
  write(f.registryPath, f.registry);
  const result = readIntegratedTaskEvidence({ projectRoot: f.root, sessionId: PARENT, featureId: FEATURE,
    taskId: TASK, headSha: f.base });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.registryPath, "utf8")).tasks[TASK].result.regate,
    { pending: [`${FEATURE}/${TASK}`], passed: [] }, "restart preserves the historical marker without inventing approval");
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

test("only the exact blocked dependent can read its corrected upstream during reconciliation", () => {
  const f = integratedFixture();
  const context = { task_id: "dependent", attempt_id: "dependent-attempt" };
  f.registry.correction_barrier = { ...context, aggregate_invalidated: true };
  f.registry.tasks.dependent = {
    ...context, parent_session_id: PARENT, feature_id: FEATURE, status: "blocked",
    plan_sha256: f.registry.plan_sha256, spec_sha256: f.registry.spec_sha256,
    reconciliation_required: { pre_child_head: f.base, upstreams: {
      [TASK]: { task_id: TASK, attempt_id: ATTEMPT, receipt_sha256: "c".repeat(64) },
    } },
  };
  const input = { projectRoot: f.root, sessionId: PARENT, featureId: FEATURE, taskId: TASK, headSha: f.base };
  write(f.registryPath, f.registry);
  const before = fs.readFileSync(f.registryPath, "utf8");
  assert.equal(readIntegratedTaskEvidence({ ...input, reconciliationFor: context }).ok, true);
  assert.equal(fs.readFileSync(f.registryPath, "utf8"), before, "read cannot clear the correction barrier");
  assert.equal(readIntegratedTaskEvidence(input).ok, false, "final/admission callers retain their barrier");
  for (const invalid of [{ ...context, attempt_id: "stale" }, { ...context, task_id: "other" }, { task_id: TASK, attempt_id: ATTEMPT }]) {
    assert.equal(readIntegratedTaskEvidence({ ...input, reconciliationFor: invalid }).ok, false);
  }
  for (const corrupt of [
    (r) => { r.tasks.dependent.status = "running"; },
    (r) => { r.tasks.dependent.plan_sha256 = "d".repeat(64); },
    (r) => { delete r.tasks.dependent.reconciliation_required.upstreams[TASK]; },
    (r) => { r.tasks.dependent.reconciliation_required.upstreams[TASK].attempt_id = "stale"; },
    (r) => { r.tasks[TASK].integration.result_sha256 = "d".repeat(64); },
    (r) => { r.tasks[TASK].status = "blocked"; },
  ]) {
    const registry = JSON.parse(before);
    corrupt(registry);
    write(f.registryPath, registry);
    assert.equal(readIntegratedTaskEvidence({ ...input, reconciliationFor: context }).ok, false);
  }
});
