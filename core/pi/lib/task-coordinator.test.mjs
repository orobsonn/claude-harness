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
  assert.equal(taskScopesOverlap(
    { ...task("slug"), scope_paths: ["src/app/[slug]/page.mjs"] },
    { ...task("id"), scope_paths: ["src/app/[id]/page.mjs"] },
  ), false, "Next.js bracket segments are literal paths");
});

test("dispatch rejects unsupported scope globs before creating a registry, worktree or job", async (t) => {
  const cases = [
    ["scope_paths", (candidate) => { candidate.scope_paths = ["src/**/*.mjs"]; }],
    ["locked test", (candidate) => { candidate.locked_tests[0].path = "tests/a?.test.mjs"; }],
    ["fixture", (candidate) => { candidate.locked_tests[0].fixture_paths = ["fixtures/{one,two}.json"]; }],
    ["brace range", (candidate) => { candidate.scope_paths = ["src/file-{1..3}.mjs"]; }],
  ];
  for (const [label, mutate] of cases) {
    const candidate = task("a");
    mutate(candidate);
    const f = fixture(t, [candidate]);
    const result = await executeTaskAction({ action: "dispatch", task_ids: ["a"] }, f.context, f.deps);
    assert.equal(result.ok, false, label);
    assert.match(result.reason, /unsupported glob syntax/, label);
    assert.equal(f.launches(), 0, label);
    assert.equal(fs.existsSync(taskRegistryPath(f.dir, "parent")), false, label);
    const taskRuns = path.dirname(taskRegistryPath(f.dir, "parent"));
    assert.equal(fs.existsSync(path.join(taskRuns, "worktrees")), false, label);
    assert.equal(fs.existsSync(path.join(taskRuns, "jobs")), false, label);
    assert.equal(git(f.dir, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1, label);
  }
});

test("dispatch accepts literal bracket and non-expanding brace path names", async (t) => {
  const candidate = task("a");
  candidate.scope_paths = ["src/app/[slug]/page.mjs", "src/schema/{version}/entry.mjs"];
  const f = fixture(t, [candidate]);
  const result = await executeTaskAction({ action: "dispatch", task_ids: ["a"] }, f.context, f.deps);
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.launches(), 1);
});

test("dispatch snapshots only each selected task's curated context and preserves it across retries", async (t) => {
  const f = fixture(t);
  const context = "Verified APP migration constraint; revalidate against the plan.";
  const result = await executeTaskAction({ action: "dispatch", task_ids: ["a", "b"], task_contexts: [{ task_id: "a", content: context }] }, f.context, f.deps);
  assert.equal(result.ok, true, result.reason);
  const registry = f.registry();
  assert.equal(registry.tasks.a.grant.context_handoff.content, context);
  assert.equal(registry.tasks.a.grant.context_handoff.parent_session_id, "parent");
  assert.equal(registry.tasks.b.grant.context_handoff, undefined);
  const changed = await executeTaskAction({ action: "dispatch", task_ids: ["a"], task_contexts: [{ task_id: "a", content: "replacement" }] }, f.context, f.deps);
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /immutable/);
  assert.equal(f.launches(), 2);
});

test("context validation precedes every admission side effect", async (t) => {
  const f = fixture(t);
  for (const task_contexts of [
    [{ task_id: "b", content: "wrong target" }],
    [{ task_id: "a", content: "á".repeat(1025) }],
    [{ task_id: "a", content: "one" }, { task_id: "a", content: "two" }],
  ]) {
    const result = await executeTaskAction({ action: "dispatch", task_ids: ["a"], task_contexts }, f.context, f.deps);
    assert.equal(result.ok, false);
    assert.equal(f.launches(), 0);
    assert.equal(fs.existsSync(taskRegistryPath(f.dir, "parent")), false);
  }
});

test("copied dependency executables keep relative symlinks inside their own task", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, "node_modules/.bin"), { recursive: true });
  fs.mkdirSync(path.join(f.dir, "node_modules/fixture-runner"));
  fs.writeFileSync(path.join(f.dir, "node_modules/fixture-runner/run.mjs"), "export default true;");
  fs.symlinkSync("../fixture-runner/run.mjs", path.join(f.dir, "node_modules/.bin/runner"));
  const result = await executeTaskAction({ action: "dispatch", task_ids: ["a"] }, f.context, f.deps);
  assert.equal(result.ok, true, result.reason);
  const worktree = result.tasks[0].worktree;
  const executable = path.join(worktree, "node_modules/.bin/runner");
  assert.equal(fs.readlinkSync(executable), "../fixture-runner/run.mjs");
  assert.equal(fs.realpathSync(executable), path.join(worktree, "node_modules/fixture-runner/run.mjs"));
});

test("Orca parent pins placement and every launch receives the terminal adapter", async (t) => {
  const f = fixture(t);
  const context = { ...f.context, orca: { worktreeId: "parent-orca" } };
  let placements = 0;
  let terminals = 0;
  const originalStart = f.deps.startProcess;
  const starts = [];
  const deps = { ...f.deps,
    resolveOrca: async (input) => {
      assert.equal(input.worktreeId, "parent-orca");
      return {
        parent: { worktree_id: "parent-orca", instance_id: "parent-generation", repo_id: "repo", path: f.dir },
        prepareWorktree: async (entry, persist) => {
          placements++;
          if (!fs.existsSync(entry.worktree))
            git(f.dir, "worktree", "add", "-b", entry.branch, entry.worktree, entry.base_sha);
          entry.orca = { worktree_id: `task-${entry.task_id}`, instance_id: "task-generation" };
          persist();
        },
        launchTerminal: async () => { terminals++; return { terminal_handle: "term-a", surface: "visible" }; },
      };
    },
    startProcess: async (input) => {
      starts.push(input);
      return { ...await originalStart(input), orca: await input.launchTerminal({ command: "node", args: [], cwd: input.cwd }) };
    },
  };
  const result = await executeTaskAction({ action: "dispatch", task_ids: ["a"] }, context, deps);
  assert.equal(result.ok, true, result.reason);
  assert.equal(placements, 1);
  assert.equal(terminals, 1);
  assert.equal(result.tasks[0].launches[0].orca.surface, "visible");
  assert.equal(f.registry().orca_parent.worktree_id, "parent-orca");
  assert.equal(starts[0].presentation, "tui");
  assert.equal(starts[0].args.includes("--no-approve"), true);
  assert.equal(starts[0].args.includes("--mode"), false);
  assert.equal(starts[0].args.includes("-p"), false);
  assert.equal(f.registry().tasks.a.launches[0].presentation, "tui");
  const status = await executeTaskAction({ action: "status" }, f.context, f.deps);
  assert.equal(status.ok, true, status.reason);
  const fallback = await executeTaskAction({ action: "dispatch", task_ids: ["b"] }, f.context, f.deps);
  assert.equal(fallback.ok, false);
  assert.match(fallback.reason, /Orca workspace/);
  assert.equal(f.launches(), 1);
  const entry = f.registry().tasks.a;
  write(`${entry.grant_path}.claim`, { session_id: "local-session" });
  const resume = () => executeTaskAction({ action: "resume", task_id: "a", attempt_id: entry.attempt_id }, context, deps);
  const resumedTui = await resume();
  assert.equal(resumedTui.ok, true, resumedTui.reason);
  assert.equal(starts[1].presentation, "tui");
  assert.equal(starts[1].args.includes("--harness-resume"), true);
  // Launch histories created before TUI must retain JSON for their pinned runtime.
  const legacy = f.registry();
  for (const launch of legacy.tasks.a.launches) delete launch.presentation;
  write(taskRegistryPath(f.dir, "parent"), legacy);
  const resumedLegacy = await resume();
  assert.equal(resumedLegacy.ok, true, resumedLegacy.reason);
  assert.equal(starts[2].presentation, "json");
  assert.equal(starts[2].args.includes("--no-approve"), false);
  assert.deepEqual(starts[2].args.slice(3, 6), ["--mode", "json", "-p"]);
});

test("a recent partial registry lock remains owned instead of being reclaimed during its write", async (t) => {
  const f = fixture(t);
  const registry = taskRegistryPath(f.dir, "parent");
  const lock = `${registry}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, `{"token":"writer","pid":${process.pid}`);
  const recent = new Date(Date.now() - 1_000);
  fs.utimesSync(lock, recent, recent);
  const before = fs.readFileSync(lock, "utf8");

  const result = await executeTaskAction({ action: "status" }, f.context, f.deps);

  assert.equal(result.ok, false);
  assert.match(result.reason, /task coordinator busy/);
  assert.equal(fs.readFileSync(lock, "utf8"), before);
});

test("an old valid registry lock whose owner died is still recovered", async (t) => {
  const f = fixture(t);
  const registry = taskRegistryPath(f.dir, "parent");
  const lock = `${registry}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({
    token: "dead-owner",
    pid: 999_999_999,
    createdAt: "2000-01-01T00:00:00.000Z",
  }));

  const result = await executeTaskAction({ action: "status" }, f.context, f.deps);

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.tasks, []);
  assert.equal(fs.existsSync(lock), false);
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
test("blocked status returns fresh diagnostics without persisting or replaying them", async (t) => {
  const f = fixture(t);
  await executeTaskAction(
    { action: "dispatch", task_ids: ["a"] },
    f.context,
    f.deps,
  );
  const contextReturn = {
    summary: "The implementation review found one current blocker.",
    files: ["src/a.mjs"],
  };
  f.deps.inspectRun = () => ({
    ok: false,
    reason: "implementation review rejected the current HEAD",
    details: {
      context_return: contextReturn,
      review_findings: [{ severity: "high", finding: "Missing boundary check" }],
    },
  });

  const blocked = await executeTaskAction(
    { action: "status", task_id: "a" },
    f.context,
    f.deps,
  );
  assert.deepEqual(blocked.diagnostics, {
    a: {
      context_return: contextReturn,
      review_findings: [{ severity: "high", finding: "Missing boundary check" }],
    },
  });
  assert.equal(blocked.tasks[0].context_return, undefined);
  assert.equal(f.registry().tasks.a.result, null);
  assert.equal(f.registry().tasks.a.diagnostics, undefined);

  f.deps.inspectRun = () => ({ ok: false, reason: "receipt still incomplete" });
  const next = await executeTaskAction(
    { action: "status", task_id: "a" },
    f.context,
    f.deps,
  );
  assert.equal(next.diagnostics, undefined);
  assert.equal(next.tasks[0].context_return, undefined);
});
test("summary exposes durable context only for ready or integrated tasks", async (t) => {
  const f = fixture(t);
  const originalInspect = f.deps.inspectRun;
  f.deps.inspectRun = (entry) => {
    const inspected = originalInspect(entry);
    return {
      ...inspected,
      result: { ...inspected.result, context_return: { summary: "Current result" } },
    };
  };
  await executeTaskAction({ action: "dispatch", task_ids: ["a"] }, f.context, f.deps);
  const ready = await executeTaskAction({ action: "status", task_id: "a" }, f.context, f.deps);
  assert.deepEqual(ready.tasks[0].context_return, { summary: "Current result" });

  f.deps.readProcess = () => ({ ok: true, running: true, terminal: false });
  const running = await executeTaskAction({ action: "status", task_id: "a" }, f.context, f.deps);
  assert.equal(running.tasks[0].status, "running");
  assert.equal(running.tasks[0].context_return, undefined);
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
  const originalStart = f.deps.startProcess;
  f.deps.startProcess = async (input) => {
    assert.equal(input.presentation, "json");
    assert.deepEqual(input.args.slice(3, 6), ["--mode", "json", "-p"]);
    return originalStart(input);
  };
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
  assert.match(
    (
      await executeTaskAction(
        { action: "resume", task_id: "a", attempt_id: entry.attempt_id },
        f.context,
        busy,
      )
    ).reason,
    /task is still running; use status or wait to observe it before resume/,
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

test("missing plan-review receipt blocks launch and points to the foreground canonical report contract", async (t) => {
  const f = fixture(t);
  delete f.state.plan_review_evidence;
  f.state.plan_verdict = "APPROVE";
  const statePath = path.join(
    f.dir,
    ".pi/harness/state/parent/gate-state.json",
  );
  write(statePath, f.state);

  const result = await executeTaskAction(
    { action: "dispatch", task_ids: ["a"] },
    f.context,
    f.deps,
  );

  assert.equal(result.ok, false);
  assert.equal(f.launches(), 0);
  assert.equal(fs.existsSync(taskRegistryPath(f.dir, "parent")), false);
  assert.match(result.reason, /fresh foreground harness-plan-reviewer/);
  assert.match(
    result.reason,
    /canonical JSON report, for example \{"verdict":"APPROVE","findings":\[\]\}/,
  );
  assert.match(result.reason, /plaintext APPROVE is not a receipt/);
  const persistedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persistedState.plan_review_evidence, undefined);
  assert.equal(persistedState.plan_verdict, "APPROVE");
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

test("an admitted dependent can recover an upstream defect without integrating broken work", async (t) => {
  const f = fixture(t);
  const action = (params) => executeTaskAction(params, f.context, f.deps);
  const commit = (id, content) => {
    const e = f.registry().tasks[id];
    fs.mkdirSync(path.join(e.worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(e.worktree, `src/${id}.mjs`), content);
    git(e.worktree, "add", `src/${id}.mjs`);
    git(e.worktree, "commit", "-qm", `implement ${id}`);
    return git(e.worktree, "rev-parse", "HEAD");
  };
  const integrate = (id, head) => action({ action: "integrate", task_id: id,
    attempt_id: f.registry().tasks[id].attempt_id, expected_head: head });
  await action({ action: "dispatch", task_ids: ["a"] });
  assert.equal((await integrate("a", commit("a", "export const a=1;"))).ok, true);
  await action({ action: "dispatch", task_ids: ["c"] });
  const childHead = commit("c", "export const c=1;");
  const before = f.registry();
  const c = before.tasks.c;
  write(`${c.grant_path}.claim`, { session_id: "same-dependent-parent" });
  const grant = fs.readFileSync(c.grant_path, "utf8");
  const resume = await action({ action: "resume", task_id: "a", attempt_id: before.tasks.a.attempt_id });
  assert.equal(resume.ok, true, resume.reason);
  const retry = await action({ action: "resume", task_id: "a", attempt_id: before.tasks.a.attempt_id });
  assert.equal(retry.ok, true, retry.reason);
  assert.equal((await integrate("c", childHead)).ok, false, "dependent cannot integrate during upstream correction");
  assert.equal((await integrate("a", commit("a", "export const a=2;"))).ok, true);
  const correctedParent = git(f.dir, "rev-parse", "HEAD");
  assert.equal((await integrate("c", childHead)).ok, false, "old dependent result cannot integrate after correction");
  const resumed = await action({ action: "resume", task_id: "c", attempt_id: c.attempt_id });
  assert.equal(resumed.ok, true, resumed.reason);
  const recovered = f.registry().tasks.c;
  assert.equal(recovered.attempt_id, c.attempt_id);
  assert.equal(recovered.base_sha, c.base_sha);
  assert.equal(fs.readFileSync(c.grant_path, "utf8"), grant);
  assert.equal(fs.readFileSync(path.join(c.worktree, "src/a.mjs"), "utf8"), "export const a=2;");
  assert.equal(fs.readFileSync(path.join(c.worktree, "src/c.mjs"), "utf8"), "export const c=1;");
  git(c.worktree, "merge-base", "--is-ancestor", childHead, "HEAD");
  git(c.worktree, "merge-base", "--is-ancestor", correctedParent, "HEAD");
  assert.equal((await integrate("c", git(c.worktree, "rev-parse", "HEAD"))).ok, true);
  assert.deepEqual(f.registry().tasks.a.integration_history, [before.tasks.a.integration]);
});

test("explicit resume of an integrated dependent reconciles corrected upstream on the host before launch", async (t) => {
  const f = await pendingCorrectionFixture(t);
  const head = git(f.c.worktree, "rev-parse", "HEAD");
  assert.equal((await f.action({ action: "integrate", task_id: "c", attempt_id: f.c.attempt_id, expected_head: head })).ok, true);
  const integrated = f.registry().tasks.c.integration;
  await f.correct();
  assert.deepEqual(f.registry().tasks.c.integration, integrated, "unrequested integrated tasks stay intact");
  const launches = f.launches();
  const start = f.deps.startProcess;
  let prompt;
  f.deps.startProcess = async (options) => {
    assert.equal(fs.readFileSync(path.join(f.c.worktree, "src/a.mjs"), "utf8"), "export const a=2;", "host must reconcile before the child can run");
    prompt = options.args.at(-1);
    return start(options);
  };
  const resumed = await f.resumeC();
  assert.equal(resumed.ok, true, resumed.reason);
  const entry = f.registry().tasks.c;
  assert.equal(entry.reconciliations.length, 1);
  assert.equal(entry.reconciliations[0].written_by, "host-task-reconciliation");
  assert.equal(entry.reconciliations[0].merged_head, git(f.c.worktree, "rev-parse", "HEAD"));
  assert.equal(f.launches(), launches + 1);
  assert.match(prompt, /host.*(?:merged|incorporated)/i);
  assert.doesNotMatch(prompt, /(?:run|execute|perform) git (?:merge|rebase|cherry-pick)/i);
  assert.doesNotMatch(prompt, /Dispatch an implementation hand to validate/i);
  assert.match(prompt, /compare.*HEAD.*capture.*producer/is);
  assert.match(prompt, /no product delta.*do not dispatch.*executor.*sniper/is);
});

async function pendingCorrectionFixture(t, { overlap = false } = {}) {
  const dependent = task("c", ["a"]);
  if (overlap) dependent.scope_paths.push("src/a.mjs");
  const f = fixture(t, [task("a"), task("b"), dependent]);
  const action = (params) => executeTaskAction(params, f.context, f.deps);
  await action({ action: "dispatch", task_ids: ["a"] });
  const a = f.registry().tasks.a;
  fs.mkdirSync(path.join(a.worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(a.worktree, "src/a.mjs"), "export const a=1;");
  git(a.worktree, "add", "src/a.mjs");
  git(a.worktree, "commit", "-qm", "implement a");
  await action({ action: "integrate", task_id: "a", attempt_id: a.attempt_id,
    expected_head: git(a.worktree, "rev-parse", "HEAD") });
  await action({ action: "dispatch", task_ids: ["c"] });
  const c = f.registry().tasks.c;
  write(`${c.grant_path}.claim`, { session_id: "dependent-parent" });
  fs.writeFileSync(path.join(c.worktree, "src/c.mjs"), "export const c=1;");
  git(c.worktree, "add", "src/c.mjs");
  git(c.worktree, "commit", "-qm", "implement c");
  const resumeA = () => action({ action: "resume", task_id: "a", attempt_id: a.attempt_id });
  const resumeC = () => action({ action: "resume", task_id: "c", attempt_id: c.attempt_id });
  const correct = async () => {
    const resumed = await resumeA();
    assert.equal(resumed.ok, true, resumed.reason);
    fs.writeFileSync(path.join(a.worktree, "src/a.mjs"), "export const a=2;");
    git(a.worktree, "add", "src/a.mjs");
    git(a.worktree, "commit", "-qm", "correct a");
    const result = await action({ action: "integrate", task_id: "a", attempt_id: a.attempt_id,
      expected_head: git(a.worktree, "rev-parse", "HEAD") });
    assert.equal(result.ok, true, result.reason);
  };
  return { ...f, a, c, action, resumeA, resumeC, correct };
}

test("upstream correction refuses active, dirty, unclaimed or switched dependents before mutating authority", async (t) => {
  for (const variant of ["active", "dirty", "unclaimed", "branch"]) {
    const f = await pendingCorrectionFixture(t);
    const before = f.registry();
    if (variant === "active") {
      const prior = f.deps.readProcess;
      f.deps.readProcess = (launch) => launch.pid === f.c.launches[0].pid ? { terminal: false } : prior(launch);
    }
    if (variant === "dirty") fs.writeFileSync(path.join(f.c.worktree, "src/c.mjs"), "uncommitted work");
    if (variant === "unclaimed") fs.unlinkSync(`${f.c.grant_path}.claim`);
    if (variant === "branch") git(f.c.worktree, "checkout", "-b", "different-branch");
    const result = await f.resumeA();
    assert.equal(result.ok, false, variant);
    assert.deepEqual(f.registry(), before, variant);
  }
});

test("pending recovery cannot be made ready by status and rejects concurrent child edits", async (t) => {
  const f = await pendingCorrectionFixture(t);
  await f.correct();
  const status = await f.action({ action: "status", task_id: "c" });
  assert.equal(status.tasks[0].status, "blocked");
  assert.match(status.tasks[0].reason, /reconciliation/);
  git(f.c.worktree, "commit", "--allow-empty", "-qm", "concurrent child edit");
  const launches = f.launches();
  const result = await f.resumeC();
  assert.equal(result.ok, false);
  assert.match(result.reason, /HEAD changed/);
  assert.equal(f.launches(), launches);
});

test("dependent recovery requires the corrected upstream receipt in the current parent ancestry", async (t) => {
  for (const variant of ["old receipt", "rewound parent"]) {
    const f = await pendingCorrectionFixture(t);
    await f.correct();
    if (variant === "old receipt") {
      const registry = f.registry();
      registry.tasks.a.integration = registry.tasks.a.integration_history[0];
      write(taskRegistryPath(f.dir, "parent"), registry);
    } else git(f.dir, "reset", "--hard", f.c.base_sha);
    const before = git(f.c.worktree, "rev-parse", "HEAD");
    const result = await f.resumeC();
    assert.equal(result.ok, false, variant);
    assert.match(result.reason, /corrected dependency/, variant);
    assert.equal(git(f.c.worktree, "rev-parse", "HEAD"), before);
  }
});

test("dependent merge conflicts preserve work and do not launch a task", async (t) => {
  const f = await pendingCorrectionFixture(t, { overlap: true });
  // A and C may own the same path when they are ordered by a dependency.
  fs.writeFileSync(path.join(f.c.worktree, "src/a.mjs"), "conflicting child change");
  git(f.c.worktree, "add", "src/a.mjs");
  git(f.c.worktree, "commit", "-qm", "conflicting work");
  const before = git(f.c.worktree, "rev-parse", "HEAD");
  await f.correct();
  const launches = f.launches();
  const result = await f.resumeC();
  assert.equal(result.ok, false);
  assert.match(result.reason, /merge-tree/);
  assert.equal(git(f.c.worktree, "rev-parse", "HEAD"), before);
  assert.equal(git(f.c.worktree, "status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(f.launches(), launches);
  assert.equal(f.registry().tasks.c.reconciliation_intent, undefined);
});

test("dependent reconciliation recovers failed commit hooks and a committed merge before journal completion", async (t) => {
  const f = await pendingCorrectionFixture(t);
  await f.correct();
  const hooks = path.join(f.dir, ".git", "hooks");
  const hook = path.join(hooks, "pre-merge-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const before = git(f.c.worktree, "rev-parse", "HEAD");
  const launches = f.launches();
  const failed = await f.resumeC();
  assert.equal(failed.ok, false);
  assert.ok(f.registry().tasks.c.reconciliation_intent);
  assert.equal(f.launches(), launches);
  const observed = await f.action({ action: "status", task_id: "c" });
  assert.equal(observed.ok, true, observed.reason);
  assert.equal(git(f.c.worktree, "rev-parse", "HEAD"), before);
  assert.equal(f.registry().tasks.c.reconciliation_intent, undefined);
  fs.unlinkSync(hook);
  // Simulate process death after Git commits but before the host finishes its journal.
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await f.resumeC();
  assert.ok(f.registry().tasks.c.reconciliation_intent);
  fs.unlinkSync(hook);
  git(f.c.worktree, "commit", "--no-edit");
  const recovered = await f.action({ action: "status", task_id: "c" });
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(f.registry().tasks.c.reconciliations.length, 1);
  assert.equal(f.registry().tasks.c.reconciliation_required, undefined);
  const resumed = await f.resumeC();
  assert.equal(resumed.ok, true, resumed.reason);
  assert.equal(f.registry().tasks.c.reconciliations.length, 1);
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
