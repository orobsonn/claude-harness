import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  admitTaskRun,
  capturePlanReviewInput,
  decideTaskRunTool,
  hashTaskArtifact,
  parsePlanReviewCompletion,
  readTaskRunBinding,
  taskRunPrompt,
  validateTaskFidelityFreeze,
} from "./task-run.mjs";
import { hashTaskReceipt, stableTaskJson, taskRegistryPath } from "./task-contract.mjs";
import { captureTaskContext } from "./task-context.mjs";
import { updateSharedContext } from "./memory-cycle.mjs";
import { recoverPiParentSession } from "./parent-session-recovery.mjs";
import { validateSubagentDispatch } from "./dispatch-rail.mjs";
import { classifyPiReviewDispatch } from "./pi-review-concurrency.mjs";
import { runPiHarnessCli } from "../bin/pi-harness.mjs";
import harnessTaskRun from "../extensions/harness-task-run.ts";
import { writePiChildIdentity } from "./pi-child-identity.mjs";

const MODELS = {
  hand_tiers: {
    low: "openai-codex/gpt-5.6-luna",
    medium: "openai-codex/gpt-5.6-terra",
    high: "openai-codex/gpt-5.6-terra",
  },
  planner: "openai-codex/gpt-5.6-sol",
  "plan-reviewer": "openai-codex/gpt-6-astra",
  compliance: "openai-codex/gpt-5.6-terra",
  adversary: "openai-codex/gpt-5.6-sol",
  security: "openai-codex/gpt-5.6-sol",
  shipper: "openai-codex/gpt-5.6-luna",
  harvester: "openai-codex/gpt-5.6-luna",
};

function fixture(t, { dependent = false, complexity = "low" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-run-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "task-attempt");
  git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-q", "--allow-empty", "-m", "base");

  const task = (id, depends_on = []) => ({
    id,
    title: `Implement ${id}`,
    description: `Implement isolated ${id} behavior`,
    depends_on,
    severity: "medium",
    complexity,
    scope_paths: [`src/${id}.ts`, `test/${id}.test.ts`],
    resolved_judgments: { behavior: "fixed" },
    criterion_refs: ["#ac-1"],
    locked_tests: [{ id: `lt-${id}`, path: `test/${id}.test.ts`, assertion: "Given input, When invoked, Then behavior holds" }],
    adversarial: { enabled: false, focus: [] },
  });
  const plan = {
    feature_id: "task-pipeline",
    kind: "full",
    mode: "full",
    model_strategy: MODELS,
    tasks: [task("task-one"), task("task-two", dependent ? ["task-one"] : [])],
    final_review: { compliance: true, adversary: true },
    demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] },
  };
  const planDir = path.join(root, ".pi", "harness", "plans", plan.feature_id);
  fs.mkdirSync(planDir, { recursive: true });
  const planPath = path.join(planDir, "execution-plan.json");
  const specPath = path.join(planDir, "spec.md");
  fs.writeFileSync(planPath, JSON.stringify(plan));
  fs.writeFileSync(specPath, "# Approved task contract\n");

  let dependency = null;
  if (dependent) {
    git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-q", "--allow-empty", "-m", "dependency child");
    const childHead = git("rev-parse", "HEAD");
    git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-q", "--allow-empty", "-m", "dependency integrated");
    const integratedHead = git("rev-parse", "HEAD");
    const result = { status: "ready", child_head: childHead };
    const receipt = {
      version: 1,
      written_by: "host-task-integration",
      parent_session_id: "global-parent",
      feature_id: plan.feature_id,
      task_id: "task-one",
      attempt_id: "attempt-one",
      parent_root: root,
      worktree: root,
      session_id: "task-parent-one",
      plan_sha256: hashTaskArtifact(planPath),
      spec_sha256: hashTaskArtifact(specPath),
      base_sha: git("rev-parse", "HEAD~1"),
      child_head: childHead,
      integrated_head: integratedHead,
      result_sha256: hashTaskReceipt(result),
    };
    dependency = { task_id: "task-one", child_head: childHead, integrated_head: integratedHead, receipt_sha256: hashTaskReceipt(receipt), receipt };
    const registryPath = taskRegistryPath(root, "global-parent");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({
      version: 1,
      parent_session_id: "global-parent",
      feature_id: plan.feature_id,
      plan_sha256: hashTaskArtifact(planPath),
      spec_sha256: hashTaskArtifact(specPath),
      tasks: { "task-one": { status: "integrated", result, integration: receipt } },
    }));
  }

  const callId = "call-plan-review";
  const stateDir = path.join(root, ".pi", "harness", "state", "global-parent");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({
    session_id: "global-parent",
    feature_id: plan.feature_id,
    mode: "FULL",
    task_pipeline_version: 1,
    spec_status: "adversary-reviewed",
    reviewed_spec_sha256: hashTaskArtifact(specPath),
    adversary_fired: true,
    adversary_spec_sha256: hashTaskArtifact(specPath),
    plan_review_evidence: {
      written_by: "host-subagent-completion",
      parent_session_id: "global-parent",
      feature_id: plan.feature_id,
      role: "harness-plan-reviewer",
      dispatch_call_id: callId,
      child_session_id: "plan-review-child",
      agent_id: "plan-review-agent",
      status: "completed",
      plan_sha256: hashTaskArtifact(planPath),
      spec_sha256: hashTaskArtifact(specPath),
      verdict: "APPROVE",
    },
  }));
  const attemptId = dependent ? "attempt-two" : "attempt-one";
  const grantDir = path.join(root, ".pi", "harness", "state", "task-admission");
  fs.mkdirSync(grantDir, { recursive: true });
  const grantPath = path.join(grantDir, `${attemptId}.json`);
  const grant = {
    version: 1,
    kind: "task-run",
    parent_session_id: "global-parent",
    parent_root: root,
    attempt_id: attemptId,
    feature_id: plan.feature_id,
    task_id: dependent ? "task-two" : "task-one",
    cwd: root,
    branch: "task-attempt",
    base_sha: git("rev-parse", "HEAD"),
    plan_sha256: hashTaskArtifact(planPath),
    spec_sha256: hashTaskArtifact(specPath),
    origin: { kind: "parent-approved-plan", plan_review_call_id: callId },
    dependencies: dependency ? [dependency] : [],
  };
  const save = () => fs.writeFileSync(grantPath, JSON.stringify(grant));
  save();
  return { root, git, planPath, specPath, grantPath, grant, dependency, save };
}

test("stable receipt JSON is key-order independent", () => {
  assert.equal(stableTaskJson({ b: 1, a: { d: 2, c: 3 } }), stableTaskJson({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(hashTaskReceipt({ b: 1, a: 2 }), hashTaskReceipt({ a: 2, b: 1 }));
});

test("admission requires the current host-owned plan APPROVE and initializes no fake task evidence", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.planPath, "utf8");
  const admitted = admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent" });
  assert.equal(admitted.ok, true, admitted.reason);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, ".pi", "harness", "state", "task-parent", "gate-state.json")));
  assert.equal(state.classification_source, "delegated-task");
  assert.equal(state.task_pipeline_version, 1);
  for (const field of ["fidelity_pass", "capture_verified", "hand_finished", "task_review_evidence"]) assert.equal(state[field], undefined);
  assert.equal(fs.readFileSync(f.planPath, "utf8"), before);
  assert.equal(readTaskRunBinding(f.root, "task-parent").ok, true);
});

test("fresh admission rejects unsupported scope globs before claim or local state", (t) => {
  const f = fixture(t);
  const plan = JSON.parse(fs.readFileSync(f.planPath, "utf8"));
  plan.tasks[0].locked_tests[0].fixture_paths = ["test/fixtures/{valid,invalid}.json"];
  fs.writeFileSync(f.planPath, JSON.stringify(plan));
  const planSha = hashTaskArtifact(f.planPath);
  f.grant.plan_sha256 = planSha;
  f.save();
  const parentStatePath = path.join(f.root, ".pi", "harness", "state", "global-parent", "gate-state.json");
  const parentState = JSON.parse(fs.readFileSync(parentStatePath, "utf8"));
  parentState.plan_review_evidence.plan_sha256 = planSha;
  fs.writeFileSync(parentStatePath, JSON.stringify(parentState));

  const admitted = admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent" });
  assert.equal(admitted.ok, false);
  assert.match(admitted.reason, /unsupported glob syntax/);
  assert.equal(fs.existsSync(`${f.grantPath}.claim`), false);
  assert.equal(fs.existsSync(path.join(f.root, ".pi", "harness", "state", "task-parent")), false);
});

test("a changed plan/spec, grant, branch or plan receipt invalidates task authority", (t) => {
  for (const change of ["plan", "spec", "receipt", "branch"]) {
    const f = fixture(t);
    if (change === "plan") fs.appendFileSync(f.planPath, " ");
    if (change === "spec") fs.appendFileSync(f.specPath, "changed");
    if (change === "receipt") {
      const statePath = path.join(f.root, ".pi", "harness", "state", "global-parent", "gate-state.json");
      const state = JSON.parse(fs.readFileSync(statePath));
      state.plan_review_evidence.verdict = "REVISE";
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    if (change === "branch") f.grant.branch = "other-branch";
    f.save();
    assert.equal(admitTaskRun(f.grantPath, { cwd: f.root, sessionId: `task-parent-${change}` }).ok, false, change);
  }
});

test("dependent task admission verifies exact current integration receipt and ancestry", (t) => {
  const f = fixture(t, { dependent: true });
  assert.equal(admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent-two" }).ok, true);

  const invalid = fixture(t, { dependent: true });
  invalid.grant.dependencies[0].receipt.integrated_head = invalid.grant.dependencies[0].child_head;
  invalid.save();
  assert.equal(admitTaskRun(invalid.grantPath, { cwd: invalid.root, sessionId: "task-parent-two" }).ok, false);
});

test("an admitted child keeps its historical dependency receipt after an ancestor correction", (t) => {
  const f = fixture(t, { dependent: true });
  assert.equal(admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent-two" }).ok, true);
  const registryPath = taskRegistryPath(f.root, "global-parent");
  const registry = JSON.parse(fs.readFileSync(registryPath));
  const entry = registry.tasks["task-one"];
  const oldIntegration = entry.integration;
  const oldResult = entry.result;
  f.git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-q", "--allow-empty", "-m", "dependency correction child");
  const correctedChild = f.git("rev-parse", "HEAD");
  f.git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-q", "--allow-empty", "-m", "dependency correction integrated");
  const correctedIntegrated = f.git("rev-parse", "HEAD");
  const correctedResult = { status: "ready", child_head: correctedChild };
  entry.integration_history = [oldIntegration];
  entry.result_history = { [oldIntegration.result_sha256]: oldResult };
  entry.result = correctedResult;
  entry.integration = { ...oldIntegration, child_head: correctedChild, integrated_head: correctedIntegrated, result_sha256: hashTaskReceipt(correctedResult) };
  fs.writeFileSync(registryPath, JSON.stringify(registry));

  assert.equal(readTaskRunBinding(f.root, "task-parent-two").ok, true, "existing B remains auditable against A's historical receipt");
  assert.equal(admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "fresh-task-parent" }).ok, false, "fresh admission cannot reuse stale A receipt");
});

test("task fidelity accepts a reviewed ancestral freeze across executor sniper and resume", (t) => {
  const prepare = (reviewVerdict = "Verdict: APPROVE") => {
    const f = fixture(t);
    const testAuthorSha = f.git("rev-parse", "HEAD");
    const admitted = admitTaskRun(f.grantPath, { cwd: f.root, sessionId: `task-parent-${crypto.randomUUID()}` });
    assert.equal(admitted.ok, true, admitted.reason);
    const entries = [];
    const completed = (id, name, args, text = "", details = { status: "completed" }) => {
      entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
      entries.push({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, isError: false, details, content: [{ type: "text", text }] } });
    };
    const prompt = '[HARNESS_TASK_CONTEXT]{"task_id":"task-one"}[/HARNESS_TASK_CONTEXT]';
    completed("author", "subagent", { subagent_type: "harness-test-author", prompt });
    completed("reviewer", "subagent", { subagent_type: "harness-test-reviewer", prompt }, reviewVerdict);
    return { ...f, sessionId: admitted.sessionId, testAuthorSha, entries, completed, prompt };
  };
  const writeLockedTest = (f) => {
    fs.mkdirSync(path.join(f.root, "test"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "test", "task-one.test.ts"), "// expected RED\n");
  };
  const check = (f) => validateTaskFidelityFreeze({
    projectRoot: f.root,
    sessionId: f.sessionId,
    taskId: "task-one",
    testAuthorSha: f.testAuthorSha,
    sessionEntries: f.entries,
  });
  const freezeEvent = (f) => f.completed("freeze", "bash", { command: "git commit -m freeze" }, `[task ${f.git("rev-parse", "HEAD")}] freeze`, {});

  const repeated = prepare("Verdict: APPROVE\nRED collected; obligations are faithful.\nVerdict: APPROVE");
  writeLockedTest(repeated);
  repeated.git("add", "--", "test/task-one.test.ts");
  repeated.git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-q", "-m", "freeze tests");
  freezeEvent(repeated);
  assert.equal(check(repeated).ok, true, "the same recorded approval must not require a format-only reviewer rerun");

  const valid = prepare();
  writeLockedTest(valid);
  valid.git("add", "--", "test/task-one.test.ts");
  valid.git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-q", "-m", "freeze tests");
  freezeEvent(valid);
  const freezeSha = valid.git("rev-parse", "HEAD");
  assert.deepEqual(check(valid), {
    ok: true,
    freezeSha,
    frozenPaths: ["test/task-one.test.ts"],
  });
  for (const role of ["harness-executor", "harness-sniper"]) {
    valid.completed(role, "subagent", { subagent_type: role, prompt: valid.prompt });
    fs.mkdirSync(path.join(valid.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(valid.root, "src", "task-one.ts"), `export const hand = ${JSON.stringify(role)};\n`);
    valid.git("add", "src/task-one.ts");
    valid.git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-qm", role);
  }
  assert.equal(check(valid).freezeSha, freezeSha, "resume must preserve initial freeze after captured product fixes");
  const unreviewed = [...valid.entries];
  valid.completed("later-author", "subagent", { subagent_type: "harness-test-author", prompt: valid.prompt });
  assert.equal(check(valid).ok, false, "a later test author invalidates earlier fidelity");
  valid.entries = unreviewed;
  fs.writeFileSync(path.join(valid.root, "test/task-one.test.ts"), "// mutated test\n");
  valid.git("add", "test/task-one.test.ts");
  valid.git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-qm", "mutate test");
  assert.match(check(valid).reason, /frozen file changed/);

  const beforeCommit = prepare();
  writeLockedTest(beforeCommit);
  assert.equal(check(beforeCommit).ok, false);

  const mixed = prepare();
  writeLockedTest(mixed);
  fs.mkdirSync(path.join(mixed.root, "src"), { recursive: true });
  fs.writeFileSync(path.join(mixed.root, "src", "task-one.ts"), "export const value = 1;\n");
  mixed.git("add", "--", "test/task-one.test.ts", "src/task-one.ts");
  mixed.git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-q", "-m", "mixed freeze");
  freezeEvent(mixed);
  assert.match(check(mixed).reason, /only canonical locked tests/);

  const dirty = prepare();
  writeLockedTest(dirty);
  dirty.git("add", "--", "test/task-one.test.ts");
  dirty.git("-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-q", "-m", "freeze tests");
  freezeEvent(dirty);
  fs.mkdirSync(path.join(dirty.root, "src"), { recursive: true });
  fs.writeFileSync(path.join(dirty.root, "src", "task-one.ts"), "export const dirty = true;\n");
  assert.match(check(dirty).reason, /worktree must be clean/);
});

test("task authority blocks global ceremony, sibling work and delivery while allowing native task reviews", (t) => {
  const f = fixture(t);
  assert.equal(admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent" }).ok, true);
  const binding = readTaskRunBinding(f.root, "task-parent");
  const dispatch = (role, taskId) => ({ toolName: "subagent", input: {
    subagent_type: role,
    prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]\nbrief`,
  } });
  assert.equal(decideTaskRunTool(binding, dispatch("harness-adversary", "task-one")).block, false);
  assert.equal(decideTaskRunTool(binding, dispatch("harness-adversary", "task-two")).block, true);
  for (const event of [
    { toolName: "classify", input: {} },
    { toolName: "harness_tasks", input: { action: "dispatch" } },
    { toolName: "mark", input: { action: "final-review", task_id: "task-one" } },
    { toolName: "harness_memory", input: { action: "apply" } },
    { toolName: "harness_memory", input: { action: "reconcile" } },
    { toolName: "harness_memory", input: { action: "finalize" } },
    { toolName: "bash", input: { command: "git push origin HEAD" } },
  ]) assert.equal(decideTaskRunTool(binding, event).block, true);
  for (const action of ["read", "update"]) {
    assert.equal(decideTaskRunTool(binding, { toolName: "harness_memory", input: { action } }).block, false);
  }
});

test("task ancestry inspection permits standalone merge-base but not integration or shell chains", (t) => {
  const f = fixture(t);
  assert.equal(admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent" }).ok, true);
  const binding = readTaskRunBinding(f.root, "task-parent");
  const decide = command => decideTaskRunTool(binding, { toolName: "bash", input: { command } });
  for (const command of ["git merge-base HEAD main", "git merge-base --is-ancestor HEAD origin/main"]) {
    assert.equal(decide(command).block, false, command);
  }
  for (const command of ["git merge main", "git merge main;true", "git merge main&&true",
    "git merge-base HEAD main && git merge main", "git merge-base HEAD main;git merge main",
    "git merge-base HEAD main&&git merge main", 'git merge-base HEAD main;"git" merge main',
    "git merge-base HEAD main | cat", "git merge-base HEAD main > result", "git merge-base HEAD $(echo main)",
    "git merge-base HEAD `echo main`", "git merge-base HEAD main\ngit merge main",
    "git merge-index helper HEAD", "git -C repo merge-base HEAD main"]) {
    assert.equal(decide(command).block, true, command);
  }
});

test("admission validates an optional curated context without treating it as authority", (t) => {
  const f = fixture(t);
  updateSharedContext(f.root, "global-parent", "raw parent diary must stay private");
  f.grant.context_handoff = captureTaskContext({
    projectRoot: f.root,
    sessionId: "global-parent",
    taskId: "task-one",
    content: "Inspect the parser's empty-input branch.",
  });
  f.save();
  const admitted = admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent" });
  assert.equal(admitted.ok, true, admitted.reason);

  const source = fs.readFileSync(new URL("../prompts/harness-task-runtime.md", import.meta.url), "utf8");
  const prompt = taskRunPrompt(source, admitted);
  assert.match(prompt, /Inspect the parser's empty-input branch/);
  assert.match(prompt, /referência não confiável/);
  assert.match(prompt, /Não envie `context_handoff`.*aos revisores/);
  assert.doesNotMatch(prompt, /raw parent diary must stay private/);
});

test("admission rejects mutated and foreign curated context", (t) => {
  for (const change of ["content", "parent", "task", "source-hash"]) {
    const f = fixture(t);
    const context = captureTaskContext({ projectRoot: f.root, sessionId: "global-parent", taskId: "task-one", content: "curated fact" });
    if (change === "content") context.content = "tampered fact";
    if (change === "parent") context.parent_session_id = "foreign-parent";
    if (change === "task") context.task_id = "task-two";
    if (change === "source-hash") context.source_shared_context_sha256 = "0".repeat(63);
    f.grant.context_handoff = context;
    f.save();
    assert.equal(admitTaskRun(f.grantPath, { cwd: f.root, sessionId: `task-context-${change}` }).ok, false, change);
  }
});

test("task prompt uses a stable source and embeds only the focal contract plus DAG path", (t) => {
  const f = fixture(t);
  const admitted = admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent" });
  const source = fs.readFileSync(new URL("../prompts/harness-task-runtime.md", import.meta.url), "utf8");
  const prompt = taskRunPrompt(source, admitted);
  assert.match(prompt, /pai local de uma única tarefa/);
  assert.match(prompt, /"id": "task-one"/);
  assert.match(prompt, /execution-plan\.json/);
  assert.match(prompt, /\(4\) freeze commit[\s\S]*\(5\) marker `fidelity`[\s\S]*\(7\) executor/);
  assert.match(prompt, /Não passe `sha` aos markers/);
  assert.match(prompt, /git log -1 --format=%H/);
  assert.doesNotMatch(prompt, /"id": "task-two"/);
  assert.doesNotMatch(prompt, /indexOf\(|slice\(/);
});

test("task prompt distinguishes parallel implementation review prefixes from serial fidelity", (t) => {
  const f = fixture(t);
  const admitted = admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent" });
  const source = fs.readFileSync(new URL("../prompts/harness-task-runtime.md", import.meta.url), "utf8");
  const prompt = taskRunPrompt(source, admitted);
  const context = '[HARNESS_TASK_CONTEXT]{"task_id":"task-one"}[/HARNESS_TASK_CONTEXT]';
  const implementation = `[HARNESS_TASK_REVIEW]\n${context}\nReview the immutable task HEAD.`;

  assert.deepEqual(classifyPiReviewDispatch("harness-adversary", `${context}\nReview the immutable task HEAD.`), {
    phase: "task",
    taskId: "task-one",
  });
  for (const role of ["harness-compliance", "harness-security"]) {
    assert.deepEqual(classifyPiReviewDispatch(role, implementation), { phase: "task", taskId: "task-one" }, role);
  }
  assert.equal(
    classifyPiReviewDispatch("harness-test-reviewer", `${context}\nValidate test fidelity.`),
    null,
    "the dedicated test reviewer remains a serial dispatch",
  );
  assert.match(prompt, /harness-test-reviewer de fidelidade e adversary de implementação[\s\S]*primeira linha[\s\S]*HARNESS_TASK_CONTEXT/);
  assert.match(prompt, /compliance[\s\S]*security de implementação[\s\S]*primeira linha[\s\S]*HARNESS_TASK_REVIEW[\s\S]*seguinte[\s\S]*HARNESS_TASK_CONTEXT/);
});

test("task prompt exposes gate-derived dispatch routes consumable at every task complexity", (t) => {
  const roles = [
    "harness-test-author", "harness-executor", "harness-sniper",
    "harness-test-reviewer", "harness-compliance", "harness-adversary", "harness-security",
  ];
  for (const complexity of ["low", "medium", "high", "max"]) {
    const f = fixture(t, { complexity });
    const admitted = admitTaskRun(f.grantPath, { cwd: f.root, sessionId: `task-parent-${complexity}` });
    assert.equal(admitted.ok, true, admitted.reason);
    const source = fs.readFileSync(new URL("../prompts/harness-task-runtime.md", import.meta.url), "utf8");
    const prompt = taskRunPrompt(source, admitted);
    const encoded = prompt.match(/\[HARNESS_TASK_RUN\]\n([\s\S]+)\n\[\/HARNESS_TASK_RUN\]$/)?.[1];
    const envelope = JSON.parse(encoded);

    assert.deepEqual(Object.keys(envelope.contract.dispatch_routes), roles);
    for (const role of roles) {
      const route = envelope.contract.dispatch_routes[role];
      assert.equal(route.ok, undefined);
      assert.deepEqual(validateSubagentDispatch({ subagent_type: role, ...route }), { ok: true });
    }
    for (const role of ["harness-test-author", "harness-executor", "harness-sniper"])
      assert.equal(envelope.contract.dispatch_routes[role].complexity, complexity);
    assert.deepEqual(envelope.contract.dispatch_routes["harness-security"], {
      model: "openai-codex/gpt-5.6-sol",
    });
    assert.match(prompt, /contract\.dispatch_routes/);
    assert.match(prompt, /não consulte.*Codex.*model-routing\.mjs/is);
    assert.match(prompt, /\.pi\/harness\/vendor\/codex\/model-routing\.mjs/);
  }
});

test("plan review completion requires unchanged hashes, native identity and canonical APPROVE", (t) => {
  const f = fixture(t);
  const start = capturePlanReviewInput({ projectRoot: f.root, sessionId: "global-parent", featureId: "task-pipeline" });
  assert.equal(start.ok, true);
  const body = '{"verdict":"APPROVE","findings":[]}';
  const result = {
    content: [{ type: "text", text: `Agent completed in 1s\nAgent ID: plan-agent\n\n${body}` }],
    details: { status: "completed", agentId: "plan-agent" },
  };
  const record = { id: "plan-agent", type: "harness-plan-reviewer", status: "completed", isBackground: false, pendingQuestion: null, completedAt: 1, result: body };
  assert.equal(parsePlanReviewCompletion({ result, isError: false, nativeRecord: record, snapshotStart: start.snapshot, snapshotEnd: start.snapshot }).ok, true);
  assert.equal(parsePlanReviewCompletion({ result, isError: false, nativeRecord: record, snapshotStart: start.snapshot, snapshotEnd: { ...start.snapshot, plan_sha256: "0".repeat(64) } }).ok, false);
});

test("exact resume preserves task state and restores the stable task runtime", (t) => {
  const f = fixture(t);
  assert.equal(admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent" }).ok, true);
  const sessions = path.join(f.root, ".pi", "harness", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "2026-01-01_task-parent.jsonl"), `${JSON.stringify({ type: "session", id: "task-parent", cwd: f.root })}\n`);
  const statePath = path.join(f.root, ".pi", "harness", "state", "task-parent", "gate-state.json");
  const before = fs.readFileSync(statePath, "utf8");
  const recovered = recoverPiParentSession(f.root, "task-parent");
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(recovered.taskAdmission.resumed, true);
  let invocation;
  const result = runPiHarnessCli(["--harness-resume", "task-parent", "-p", "finish capture"], {
    cwd: f.root,
    env: { PI_HARNESS_TASK_RUN: "foreign-inherited-value" },
    packageRoot: path.resolve(new URL("../../../", import.meta.url).pathname),
    runtimePrompt: "global runtime",
    taskRuntimePrompt: "stable task runtime",
    acquireParentLockFn: () => ({ ok: true, release() {} }),
    buildInvocationFn: (args) => { invocation = args; return { command: "unused", args: [], env: { ...args.env, PI_CODING_AGENT_DIR: path.join(f.root, ".pi/harness/runtime") } }; },
    materializeRuntimeFn() {},
    spawnSyncFn: () => ({ status: 0 }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(invocation.env.PI_HARNESS_TASK_RUN).sessionId, "task-parent");
  assert.match(invocation.runtimePrompt, /stable task runtime/);
  assert.match(invocation.runtimePrompt, /"resumed": true/);
  assert.doesNotMatch(invocation.runtimePrompt, /global runtime/);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
});

test("fresh task launcher admits the CLI grant and replaces inherited task authority", (t) => {
  const f = fixture(t);
  let invocation;
  const result = runPiHarnessCli(["--harness-task", f.grantPath, "--mode", "json", "-p", "run task"], {
    cwd: f.root,
    env: { PI_HARNESS_TASK_RUN: "untrusted-parent-value" },
    packageRoot: path.resolve(new URL("../../../", import.meta.url).pathname),
    runtimePrompt: "global runtime",
    taskRuntimePrompt: "stable task runtime",
    randomSessionIdFn: () => "fresh-task-parent",
    acquireParentLockFn: () => ({ ok: true, release() {} }),
    buildInvocationFn: (args) => { invocation = args; return { command: "unused", args: [], env: { ...args.env, PI_CODING_AGENT_DIR: path.join(f.root, ".pi/harness/runtime") } }; },
    materializeRuntimeFn() {},
    spawnSyncFn: () => ({ status: 0 }),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(invocation.argv, ["--mode", "json", "-p", "run task"]);
  assert.deepEqual(JSON.parse(invocation.env.PI_HARNESS_TASK_RUN), { cwd: f.root, sessionId: "fresh-task-parent" });
  assert.match(invocation.runtimePrompt, /"resumed": false/);
  assert.doesNotMatch(invocation.runtimePrompt, /global runtime/);
});

test("fresh task launcher leaves no claim when fallible preflight fails, so the same attempt can retry", (t) => {
  for (const stage of ["build", "materialize"]) {
    const f = fixture(t);
    const sessionId = `fresh-preflight-${stage}`;
    const stateDir = path.join(f.root, ".pi", "harness", "state", sessionId);
    const claim = `${f.grantPath}.claim`;
    const common = {
      cwd: f.root,
      env: {},
      packageRoot: path.resolve(new URL("../../../", import.meta.url).pathname),
      runtimePrompt: "global runtime",
      taskRuntimePrompt: "stable task runtime",
      randomSessionIdFn: () => sessionId,
      acquireParentLockFn: () => ({ ok: true, release() {} }),
      errorSink() {},
    };
    const failed = runPiHarnessCli(["--harness-task", f.grantPath, "-p", "run task"], {
      ...common,
      buildInvocationFn: (args) => {
        if (stage === "build") throw new Error("runtime resolution failed");
        return { command: "unused", args: [], env: { ...args.env, PI_CODING_AGENT_DIR: path.join(f.root, ".pi/harness/runtime") } };
      },
      materializeRuntimeFn: () => {
        if (stage === "materialize") throw new Error("runtime materialization failed");
      },
      spawnSyncFn: () => { throw new Error("must not spawn"); },
    });
    assert.equal(failed.exitCode, 1, stage);
    assert.equal(fs.existsSync(claim), false, `${stage}: claim must not precede preflight`);
    assert.equal(fs.existsSync(stateDir), false, `${stage}: gate state must not precede preflight`);

    const retried = runPiHarnessCli(["--harness-task", f.grantPath, "-p", "run task"], {
      ...common,
      buildInvocationFn: (args) => ({
        command: "unused",
        args: [],
        env: { ...args.env, PI_CODING_AGENT_DIR: path.join(f.root, ".pi/harness/runtime") },
      }),
      materializeRuntimeFn() {},
      spawnSyncFn: () => ({ status: 0 }),
    });
    assert.equal(retried.exitCode, 0, stage);
    assert.equal(fs.existsSync(claim), true, stage);
    assert.equal(fs.existsSync(path.join(stateDir, "gate-state.json")), true, stage);
  }
});

test("spawn failure rolls back only the pristine admission and permits a fresh retry", (t) => {
  const f = fixture(t);
  const sessionId = "fresh-spawn-failure";
  const stateDir = path.join(f.root, ".pi", "harness", "state", sessionId);
  const claim = `${f.grantPath}.claim`;
  const common = {
    cwd: f.root,
    env: {},
    packageRoot: path.resolve(new URL("../../../", import.meta.url).pathname),
    runtimePrompt: "global runtime",
    taskRuntimePrompt: "stable task runtime",
    randomSessionIdFn: () => sessionId,
    acquireParentLockFn: () => ({ ok: true, release() {} }),
    buildInvocationFn: (args) => ({
      command: "unused",
      args: [],
      env: { ...args.env, PI_CODING_AGENT_DIR: path.join(f.root, ".pi/harness/runtime") },
    }),
    materializeRuntimeFn() {},
    errorSink() {},
  };
  const failed = runPiHarnessCli(["--harness-task", f.grantPath, "-p", "run task"], {
    ...common,
    spawnSyncFn: () => ({ status: null, error: new Error("spawn unavailable") }),
  });
  assert.equal(failed.exitCode, 1);
  assert.equal(fs.existsSync(claim), false);
  assert.equal(fs.existsSync(stateDir), false);

  const retried = runPiHarnessCli(["--harness-task", f.grantPath, "-p", "run task"], {
    ...common,
    spawnSyncFn: () => ({ status: 0 }),
  });
  assert.equal(retried.exitCode, 0);
});

test("task extension accepts only the admitted parent and its exact native children", (t) => {
  const f = fixture(t);
  assert.equal(admitTaskRun(f.grantPath, { cwd: f.root, sessionId: "task-parent" }).ok, true);
  const previous = process.env.PI_HARNESS_TASK_RUN;
  process.env.PI_HARNESS_TASK_RUN = JSON.stringify({ cwd: f.root, sessionId: "task-parent" });
  t.after(() => { if (previous === undefined) delete process.env.PI_HARNESS_TASK_RUN; else process.env.PI_HARNESS_TASK_RUN = previous; });
  const hooks = new Map();
  harnessTaskRun({ on: (name, handler) => hooks.set(name, handler) });
  const context = (sessionId) => ({ cwd: f.root, sessionManager: { getSessionId: () => sessionId, getHeader: () => ({}) } });
  assert.equal(writePiChildIdentity(f.root, { parentSessionId: "task-parent", childSessionId: "native-child", role: "harness-adversary", callId: "review-call" }).ok, true);
  assert.equal(hooks.get("tool_call")({ toolName: "read", input: { path: "src/task-one.ts" } }, context("native-child")), undefined);
  assert.equal(hooks.get("tool_call")({ toolName: "read", input: { path: "src/task-one.ts" } }, context("foreign-child")).block, true);
  assert.equal(hooks.get("tool_call")({ toolName: "harness_tasks", input: { action: "dispatch", task_ids: ["task-two"] } }, context("task-parent")).block, true);
  assert.equal(hooks.get("before_agent_start")({}, context("native-child")), undefined);
});
