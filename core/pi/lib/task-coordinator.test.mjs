import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  executeTaskAction,
  taskScopesOverlap,
  decideTaskCoordinatorEdit,
} from "./task-coordinator.mjs";
import { hashTaskArtifact } from "./task-run.mjs";
import { taskRegistryPath } from "./task-contract.mjs";
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const write = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
};
const strategy = {
  hand_tiers: { low: "test/model", medium: "test/model", high: "test/model" },
  ...Object.fromEntries(
    [
      "planner",
      "plan-reviewer",
      "compliance",
      "adversary",
      "security",
      "shipper",
      "harvester",
    ].map((k) => [k, "test/model"]),
  ),
};
const task = (id, depends_on = []) => ({
  id,
  depends_on,
  severity: "medium",
  scope_paths: [`src/${id}.mjs`],
  criterion_refs: ["ac-1"],
  locked_tests: [
    {
      id: `${id}-test`,
      path: `tests/${id}.test.mjs`,
      assertion: "Given input When invoked Then output is correct",
    },
  ],
});
function fixture(t, tasks = [task("a"), task("b"), task("c", ["a"])]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-coordinator-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-b", "feature/test");
  git(dir, "config", "user.email", "fixture@example.test");
  git(dir, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(dir, "base.txt"), "base");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const plans = path.join(dir, ".pi/harness/plans/feature");
  fs.mkdirSync(plans, { recursive: true });
  const plan = {
    feature_id: "feature",
    kind: "full",
    mode: "full",
    model_strategy: strategy,
    tasks,
  };
  write(path.join(plans, "execution-plan.json"), plan);
  fs.writeFileSync(path.join(plans, "spec.md"), "Fixture spec");
  const spec_sha256 = hashTaskArtifact(path.join(plans, "spec.md"));
  const plan_sha256 = hashTaskArtifact(path.join(plans, "execution-plan.json"));
  const state = {
    session_id: "parent",
    feature_id: "feature",
    mode: "FULL",
    task_pipeline_version: 1,
    spec_status: "adversary-reviewed",
    reviewed_spec_sha256: spec_sha256,
    adversary_spec_sha256: spec_sha256,
    adversary_fired: true,
    plan_review_evidence: {
      written_by: "host-subagent-completion",
      parent_session_id: "parent",
      feature_id: "feature",
      role: "harness-plan-reviewer",
      dispatch_call_id: "plan-call",
      child_session_id: "plan-child",
      agent_id: "plan-agent",
      status: "completed",
      plan_sha256,
      spec_sha256,
      verdict: "APPROVE",
    },
  };
  write(path.join(dir, ".pi/harness/state/parent/gate-state.json"), state);
  const context = { projectRoot: dir, sessionId: "parent" };
  let launches = 0;
  const deps = {
    captureRuntime: (launcher) => ({
      ok: true,
      runtime: { launcher_path: launcher, sha256: "a".repeat(64) },
    }),
    verifyRuntime: () => ({ ok: true }),
    readIntegrated: () => ({ ok: true }),
    startProcess: async (o) => {
      launches++;
      return {
        run_id: o.runId,
        pid: 1000 + launches,
        events_path: path.join(o.jobDir, "events.jsonl"),
        process_path: path.join(o.jobDir, "process.json"),
        result_path: path.join(o.jobDir, "result.json"),
      };
    },
    readProcess: () => ({
      ok: true,
      running: false,
      terminal: true,
      result: { exitCode: 0, timedOut: false },
    }),
    inspectRun: (entry) => ({
      ok: true,
      result: {
        child_head: git(entry.worktree, "rev-parse", "HEAD"),
        session_id: "local-session",
        attempt_id: entry.attempt_id,
        run_id: entry.launches.at(-1).run_id,
        changed_paths: [],
        frozen_blobs: {},
      },
    }),
  };
  return {
    dir,
    context,
    deps,
    state,
    plan,
    launches: () => launches,
    registry: () =>
      JSON.parse(fs.readFileSync(taskRegistryPath(dir, "parent"), "utf8")),
  };
}
test("scope overlap includes tests and fixtures, with component boundaries", () => {
  assert.equal(taskScopesOverlap(task("a"), task("b")), false);
  const b = task("b");
  b.locked_tests[0].fixture_paths = ["tests/a.test.mjs"];
  assert.equal(taskScopesOverlap(task("a"), b), true);
  assert.throws(
    () => taskScopesOverlap({ ...task("a"), scope_paths: ["../escape"] }, b),
    /scope/,
  );
});
test("batch preflight is atomic; dispatch is durable and idempotent; dependencies wait", async (t) => {
  const f = fixture(t);
  assert.equal(
    (
      await executeTaskAction(
        { action: "dispatch", task_ids: ["a", "c"] },
        f.context,
        f.deps,
      )
    ).ok,
    false,
  );
  assert.equal(f.launches(), 0);
  const dispatched = await executeTaskAction(
    { action: "dispatch", task_ids: ["a", "b"] },
    f.context,
    f.deps,
  );
  assert.equal(dispatched.ok, true, dispatched.reason);
  assert.equal(f.launches(), 2);
  assert.equal(
    (
      await executeTaskAction(
        { action: "dispatch", task_ids: ["a"] },
        f.context,
        f.deps,
      )
    ).ok,
    true,
  );
  assert.equal(f.launches(), 2);
  const observed = await executeTaskAction(
    { action: "status" },
    f.context,
    f.deps,
  );
  assert.equal(observed.ok, true);
  assert.equal(f.registry().tasks.a.status, "ready");
});
test("integration rejects wrong HEAD and preserves ancestry using a merge journal", async (t) => {
  const f = fixture(t);
  await executeTaskAction(
    { action: "dispatch", task_ids: ["a"] },
    f.context,
    f.deps,
  );
  const entry = f.registry().tasks.a;
  fs.mkdirSync(path.join(entry.worktree, "src"));
  fs.writeFileSync(path.join(entry.worktree, "src/a.mjs"), "export const a=1;");
  git(entry.worktree, "add", "src/a.mjs");
  git(entry.worktree, "commit", "-qm", "implement a");
  await executeTaskAction({ action: "status" }, f.context, f.deps);
  const head = git(entry.worktree, "rev-parse", "HEAD");
  assert.equal(
    (
      await executeTaskAction(
        {
          action: "integrate",
          task_id: "a",
          attempt_id: entry.attempt_id,
          expected_head: "a".repeat(40),
        },
        f.context,
        f.deps,
      )
    ).ok,
    false,
  );
  const integrated = await executeTaskAction(
    {
      action: "integrate",
      task_id: "a",
      attempt_id: entry.attempt_id,
      expected_head: head,
    },
    f.context,
    f.deps,
  );
  assert.equal(integrated.ok, true, integrated.reason);
  assert.equal(f.registry().tasks.a.integration.child_head, head);
  git(f.dir, "merge-base", "--is-ancestor", head, "HEAD");
  assert.equal(
    git(f.dir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length,
    3,
  );
  assert.equal(
    (
      await executeTaskAction(
        { action: "dispatch", task_ids: ["c"] },
        f.context,
        f.deps,
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await executeTaskAction(
        { action: "resume", task_id: "a", attempt_id: entry.attempt_id },
        f.context,
        f.deps,
      )
    ).ok,
    false,
  );
});
test("same-attempt resume requires terminal groups and invalidates old return before launch", async (t) => {
  const f = fixture(t);
  await executeTaskAction(
    { action: "dispatch", task_ids: ["a"] },
    f.context,
    f.deps,
  );
  const entry = f.registry().tasks.a;
  write(`${entry.grant_path}.claim`, { session_id: "local-session" });
  const busy = {
    ...f.deps,
    readProcess: () => ({ ok: true, running: true, terminal: false }),
  };
  assert.equal(
    (
      await executeTaskAction(
        { action: "resume", task_id: "a", attempt_id: entry.attempt_id },
        f.context,
        busy,
      )
    ).ok,
    false,
  );
  const resumed = await executeTaskAction(
    {
      action: "resume",
      task_id: "a",
      attempt_id: entry.attempt_id,
      instruction: "Fix the missing capture.",
    },
    f.context,
    f.deps,
  );
  assert.equal(resumed.ok, true, resumed.reason);
  assert.equal(f.registry().tasks.a.attempt_id, entry.attempt_id);
  assert.equal(f.registry().tasks.a.launches.length, 2);
  assert.equal(f.registry().tasks.a.result, null);
});
test("changed approval or local-task identity cannot dispatch", async (t) => {
  const f = fixture(t);
  assert.equal(
    (
      await executeTaskAction(
        { action: "dispatch", task_ids: ["a"] },
        { ...f.context, isChild: true },
        f.deps,
      )
    ).ok,
    false,
  );
  fs.appendFileSync(
    path.join(f.dir, ".pi/harness/plans/feature/execution-plan.json"),
    " ",
  );
  assert.equal(
    (
      await executeTaskAction(
        { action: "dispatch", task_ids: ["a"] },
        f.context,
        f.deps,
      )
    ).ok,
    false,
  );
  assert.equal(f.launches(), 0);
});

test("active task grants freeze parent planning, but task observation remains available", async (t) => {
  const f = fixture(t);
  assert.equal(
    decideTaskCoordinatorEdit({ toolName: "harness_spec_write" }, f.context),
    null,
  );
  await executeTaskAction(
    { action: "dispatch", task_ids: ["a"] },
    f.context,
    f.deps,
  );
  assert.equal(
    decideTaskCoordinatorEdit({ toolName: "harness_spec_write" }, f.context)
      .block,
    true,
  );
  assert.equal(
    decideTaskCoordinatorEdit(
      {
        toolName: "subagent",
        input: { subagent_type: "harness-plan-reviewer" },
      },
      f.context,
    ).block,
    true,
  );
  assert.equal(
    decideTaskCoordinatorEdit(
      { toolName: "harness_tasks", input: { action: "status" } },
      f.context,
    ),
    null,
  );
});

test("restart reconciles a completed exact merge whose receipt write was interrupted", async (t) => {
  const f = fixture(t);
  await executeTaskAction(
    { action: "dispatch", task_ids: ["a"] },
    f.context,
    f.deps,
  );
  let entry = f.registry().tasks.a;
  fs.mkdirSync(path.join(entry.worktree, "src"));
  fs.writeFileSync(path.join(entry.worktree, "src/a.mjs"), "export const a=2;");
  git(entry.worktree, "add", "src/a.mjs");
  git(entry.worktree, "commit", "-qm", "implement a");
  await executeTaskAction({ action: "status" }, f.context, f.deps);
  const registry = f.registry();
  entry = registry.tasks.a;
  const parent = git(f.dir, "rev-parse", "HEAD");
  const child = entry.result.child_head;
  const { hashTaskReceipt } = await import("./task-contract.mjs");
  registry.integration_intent = {
    task_id: "a",
    attempt_id: entry.attempt_id,
    parent_head: parent,
    child_head: child,
    tree: git(f.dir, "merge-tree", "--write-tree", parent, child),
    result_sha256: hashTaskReceipt(entry.result),
  };
  write(taskRegistryPath(f.dir, "parent"), registry);
  git(f.dir, "merge", "--no-ff", "-m", "interrupted task merge", child);
  const recovered = await executeTaskAction(
    { action: "status" },
    f.context,
    f.deps,
  );
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(f.registry().tasks.a.status, "integrated");
  assert.equal(
    f.registry().tasks.a.integration.integrated_head,
    git(f.dir, "rev-parse", "HEAD"),
  );
  assert.equal(f.registry().integration_intent, undefined);
  assert.equal(f.launches(), 1);
});
test("merge conflicts are detected before touching the parent tree or writing an integration receipt", async (t) => {
  const f = fixture(t);
  await executeTaskAction(
    { action: "dispatch", task_ids: ["a"] },
    f.context,
    f.deps,
  );
  const entry = f.registry().tasks.a;
  for (const [dir, value] of [
    [entry.worktree, "task"],
    [f.dir, "parent"],
  ]) {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/a.mjs"), value);
    git(dir, "add", "src/a.mjs");
    git(dir, "commit", "-qm", value);
  }
  const parent = git(f.dir, "rev-parse", "HEAD");
  const result = await executeTaskAction(
    {
      action: "integrate",
      task_id: "a",
      attempt_id: entry.attempt_id,
      expected_head: git(entry.worktree, "rev-parse", "HEAD"),
    },
    f.context,
    f.deps,
  );
  assert.equal(result.ok, false);
  assert.equal(git(f.dir, "rev-parse", "HEAD"), parent);
  assert.equal(git(f.dir, "diff", "--name-only"), "");
  assert.equal(f.registry().tasks.a.integration, null);
});

test("correction of an integrated dependency keeps historical receipts and blocks new work until reintegration", async (t) => {
  const f = fixture(t);
  const integrate = async (id) => {
    const entry = f.registry().tasks[id];
    fs.mkdirSync(path.join(entry.worktree, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(entry.worktree, `src/${id}.mjs`),
      `export const ${id}=1;`,
    );
    git(entry.worktree, "add", `src/${id}.mjs`);
    git(entry.worktree, "commit", "-qm", `implement ${id}`);
    const result = await executeTaskAction(
      {
        action: "integrate",
        task_id: id,
        attempt_id: entry.attempt_id,
        expected_head: git(entry.worktree, "rev-parse", "HEAD"),
      },
      f.context,
      f.deps,
    );
    assert.equal(result.ok, true, result.reason);
  };
  await executeTaskAction(
    { action: "dispatch", task_ids: ["a"] },
    f.context,
    f.deps,
  );
  await integrate("a");
  await executeTaskAction(
    { action: "dispatch", task_ids: ["c"] },
    f.context,
    f.deps,
  );
  await integrate("c");
  const prior = f.registry();
  const a = prior.tasks.a;
  write(`${a.grant_path}.claim`, { session_id: "same-local-parent" });
  const resumed = await executeTaskAction(
    {
      action: "resume",
      task_id: "a",
      attempt_id: a.attempt_id,
      instruction: "Fix finding on a.",
    },
    f.context,
    f.deps,
  );
  assert.equal(resumed.ok, true, resumed.reason);
  assert.equal(f.registry().correction_barrier.task_id, "a");
  assert.deepEqual(f.registry().tasks.c.integration, prior.tasks.c.integration);
  assert.deepEqual(
    f.registry().tasks.a.result_history[a.integration.result_sha256],
    a.result,
  );
  assert.equal(
    (
      await executeTaskAction(
        { action: "dispatch", task_ids: ["b"] },
        f.context,
        f.deps,
      )
    ).ok,
    false,
  );
  fs.writeFileSync(path.join(a.worktree, "src/a.mjs"), "export const a=2;");
  git(a.worktree, "add", "src/a.mjs");
  git(a.worktree, "commit", "-qm", "correct a");
  const done = await executeTaskAction(
    {
      action: "integrate",
      task_id: "a",
      attempt_id: a.attempt_id,
      expected_head: git(a.worktree, "rev-parse", "HEAD"),
    },
    f.context,
    f.deps,
  );
  assert.equal(done.ok, true, done.reason);
  assert.equal(f.registry().correction_barrier, undefined);
  assert.deepEqual(f.registry().tasks.c.integration, prior.tasks.c.integration);
  assert.equal(
    fs.readFileSync(path.join(f.dir, "src/a.mjs"), "utf8"),
    "export const a=2;",
  );
});

test("a failing merge hook preserves the intent and exact interrupted merge is safely aborted on observation", async (t) => {
  const f = fixture(t);
  await executeTaskAction(
    { action: "dispatch", task_ids: ["a"] },
    f.context,
    f.deps,
  );
  const entry = f.registry().tasks.a;
  fs.mkdirSync(path.join(entry.worktree, "src"));
  fs.writeFileSync(path.join(entry.worktree, "src/a.mjs"), "export const a=3;");
  git(entry.worktree, "add", "src/a.mjs");
  git(entry.worktree, "commit", "-qm", "implement a");
  const hook = path.join(f.dir, ".git/hooks/pre-merge-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const before = git(f.dir, "rev-parse", "HEAD");
  const merged = await executeTaskAction(
    {
      action: "integrate",
      task_id: "a",
      attempt_id: entry.attempt_id,
      expected_head: git(entry.worktree, "rev-parse", "HEAD"),
    },
    f.context,
    f.deps,
  );
  assert.equal(merged.ok, false);
  assert.ok(f.registry().integration_intent);
  assert.equal(git(f.dir, "rev-parse", "HEAD"), before);
  const observed = await executeTaskAction(
    { action: "status" },
    f.context,
    f.deps,
  );
  assert.equal(observed.ok, true, observed.reason);
  assert.equal(f.registry().integration_intent, undefined);
  assert.equal(git(f.dir, "diff", "--name-only"), "");
  assert.throws(() => git(f.dir, "rev-parse", "--verify", "MERGE_HEAD"));
});
