import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { executeTaskAction, waitForTasks } from "./task-coordinator.mjs";
import { hashTaskReceipt } from "../../../shared/lib/task-contract.mjs";
import { createTaskProject, defaultTasks, git, planTask } from "./__fixtures__/task-fixture.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Parent project + host seams: launches are recorded, processes are terminal, inspection is scripted. */
function fixture(t, { tasks = defaultTasks(), mode = "full" } = {}) {
  const project = createTaskProject(t, { tasks, mode });
  const state = { launches: [], running: new Set(), inspect: new Map() };
  const context = { projectRoot: project.root, sessionId: project.sessionId };
  const deps = {
    claudeBin: process.execPath,
    limits: { maxParallel: 3, timeoutMs: 60_000 },
    captureRuntime: (root) => ({ version: 1, root, launcher_path: "/launcher.mjs", files: 1, sha256: "a".repeat(64) }),
    verifyRuntime: () => ({ ok: true }),
    readIntegrated: () => ({ ok: true }),
    startProcess: async (options) => {
      state.launches.push(options);
      return {
        run_id: options.runId, pid: 4242, events_path: path.join(options.jobDir, "events.jsonl"),
        process_path: path.join(options.jobDir, "process.json"), result_path: path.join(options.jobDir, "result.json"),
      };
    },
    readProcess: (launch) => state.running.has(launch.run_id)
      ? { ok: true, running: true, terminal: false }
      : { ok: true, running: false, terminal: true, result: { exitCode: 0, timedOut: false, signal: null } },
    inspectRun: (entry) => {
      const scripted = state.inspect.get(entry.task_id);
      if (scripted) return scripted(entry);
      return { ok: true, result: resultFor(entry) };
    },
  };
  const run = (params, extra = {}) => executeTaskAction(params, context, { ...deps, ...extra });
  const registry = () => JSON.parse(fs.readFileSync(path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json"), "utf8"));
  return { project, state, deps, run, registry, context };
}

/** A minimal inspection receipt for the entry's current worktree HEAD. */
function resultFor(entry, extra = {}) {
  const head = git(entry.worktree, "rev-parse", "HEAD");
  return {
    version: 1, written_by: "host-task-inspection", parent_session_id: entry.parent_session_id, feature_id: entry.feature_id,
    task_id: entry.task_id, attempt_id: entry.attempt_id, parent_root: entry.parent_root, worktree: entry.worktree,
    session_id: "55555555-5555-4555-8555-555555555555", plan_sha256: entry.plan_sha256, spec_sha256: entry.spec_sha256,
    base_sha: entry.base_sha, scope_base_sha: entry.base_sha, reconciliation_sha256: null, child_head: head,
    changed_paths: [], freeze_sha: null, frozen_blobs: {}, context_return: null, ...extra,
  };
}

/** Commit `files` in a lane worktree, as its hands would. */
function laneCommit(worktree, files, message = "feat: work") {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    fs.writeFileSync(path.join(worktree, file), content);
  }
  git(worktree, "add", "-A", "--", ...Object.keys(files));
  git(worktree, "commit", "-qm", message);
  return git(worktree, "rev-parse", "HEAD");
}

test("a batch with an unmet dependency fails before any effect", async (t) => {
  const f = fixture(t);
  const result = await f.run({ action: "dispatch", task_ids: ["task-a", "task-c"] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /dependency task-a must be integrated before task-c/);
  assert.equal(f.state.launches.length, 0);
  assert.equal(fs.existsSync(path.join(f.project.root, ".claude/plans/.state", f.project.sessionId, "task-runs/index.json")), false, "no registry");
  assert.equal(fs.existsSync(path.join(f.project.root, ".claude/plans/.state", f.project.sessionId, "task-runs/worktrees")), false, "no worktree");
  assert.deepEqual(git(f.project.root, "branch", "--list", "harness/*"), "", "no branch");
});

test("dispatch reserves readable worktrees and branches, launches once and is idempotent", async (t) => {
  const f = fixture(t);
  const first = await f.run({ action: "dispatch", task_ids: ["task-a", "task-b"] });
  assert.equal(first.ok, true, first.reason);
  assert.equal(f.state.launches.length, 2);
  const registry = f.registry();
  const a = registry.tasks["task-a"];
  assert.equal(path.basename(a.worktree), "task-1-implementar-modulo-a");
  assert.match(a.branch, /^harness\/task-task-a-[0-9a-f-]{36}$/);
  assert.equal(git(a.worktree, "branch", "--show-current"), a.branch);
  assert.equal(a.base_sha, registry.tasks["task-b"].base_sha, "one base for the batch");
  assert.equal(fs.existsSync(path.join(a.worktree, ".claude/plans/demo-feature/execution-plan.json")), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(a.grant_path, "utf8")), a.grant);
  assert.equal(a.grant.mode, "FULL");
  const launch = f.state.launches[0];
  assert.equal(launch.trackDescendants, true);
  assert.deepEqual(launch.args.slice(0, 3), ["/launcher.mjs", "--grant", a.grant_path]);
  assert.ok(!launch.args.includes("--resume"), "a fresh attempt is admitted, not resumed");
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "sonnet");
  const again = await f.run({ action: "dispatch", task_ids: ["task-a"] });
  assert.equal(again.ok, true);
  assert.equal(f.state.launches.length, 2, "redispatch never relaunches");
  assert.equal(again.tasks[0].attempt_id, a.attempt_id);
});

test("the parallel limit applies per batch and to running tasks; a host env may only lower it", async (t) => {
  const tasks = ["a", "b", "d", "e"].map((id) => planTask(`task-${id}`, [`src/${id}`]));
  const f = fixture(t, { tasks });
  assert.match((await f.run({ action: "dispatch", task_ids: tasks.map((task) => task.id) })).reason, /one to 3 distinct/);
  assert.equal((await f.run({ action: "dispatch", task_ids: ["task-a", "task-b", "task-d"] })).ok, true);
  for (const entry of Object.values(f.registry().tasks)) for (const launch of entry.launches) f.state.running.add(launch.run_id);
  await f.run({ action: "status" });
  assert.match((await f.run({ action: "dispatch", task_ids: ["task-e"] })).reason, /parallel task limit reached/);
  const lowered = fixture(t, { tasks });
  assert.match((await lowered.run({ action: "dispatch", task_ids: ["task-a", "task-b"] }, { limits: { maxParallel: 1, timeoutMs: 1 } })).reason, /one to 1 distinct/);
});

test("a dirty parent refuses dispatch; harness volatiles do not count", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.project.root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(f.project.root, "node_modules", "x.js"), "");
  fs.writeFileSync(path.join(f.project.root, "stray.txt"), "x");
  assert.match((await f.run({ action: "dispatch", task_ids: ["task-a"] })).reason, /parent worktree must be clean[^]*stray\.txt/);
  fs.rmSync(path.join(f.project.root, "stray.txt"));
  assert.equal((await f.run({ action: "dispatch", task_ids: ["task-a"] })).ok, true);
});

test("task contexts are bounded, exact, inside the batch and immutable", async (t) => {
  const f = fixture(t);
  for (const [label, task_contexts, pattern] of [
    ["outside batch", [{ task_id: "task-b", content: "x" }], /identify one requested task/],
    ["duplicate", [{ task_id: "task-a", content: "x" }, { task_id: "task-a", content: "y" }], /at most one|exactly once/],
    ["extra key", [{ task_id: "task-a", content: "x", extra: 1 }], /identify one requested task/],
    ["too large", [{ task_id: "task-a", content: "é".repeat(1025) }], /2048 UTF-8 bytes/],
  ]) {
    assert.match((await f.run({ action: "dispatch", task_ids: ["task-a"], task_contexts })).reason, pattern, label);
  }
  assert.equal((await f.run({ action: "dispatch", task_ids: ["task-a"], task_contexts: [{ task_id: "task-a", content: "é".repeat(1024) }] })).ok, true);
  assert.equal(f.registry().tasks["task-a"].grant.context_handoff.content, "é".repeat(1024));
  assert.match((await f.run({ action: "dispatch", task_ids: ["task-a"], task_contexts: [{ task_id: "task-a", content: "changed" }] })).reason, /immutable/);
  assert.equal((await f.run({ action: "dispatch", task_ids: ["task-a"], task_contexts: [{ task_id: "task-a", content: "é".repeat(1024) }] })).ok, true, "the same brief is an idempotent retry");
});

test("status never launches, keeps diagnostics out of the registry and exposes context_return only when ready", async (t) => {
  const f = fixture(t);
  assert.deepEqual((await f.run({ action: "status" })).tasks, []);
  await f.run({ action: "dispatch", task_ids: ["task-a"] });
  const launches = f.state.launches.length;
  const contextReturn = { version: 1, kind: "task-context-return", session_id: "s", task_id: "task-a", head_sha: "a".repeat(40), content: "learned", sha256: sha256("learned") };
  f.state.inspect.set("task-a", () => ({ ok: false, reason: "[task-inspection] review negative", details: { review_findings: [{ role: "compliance", text: "PROBLEMA" }], context_return: contextReturn, secret_field: "dropped" } }));
  const blocked = await f.run({ action: "status" });
  assert.equal(blocked.tasks[0].status, "blocked");
  assert.equal(blocked.tasks[0].context_return, undefined, "never exposed while blocked");
  assert.deepEqual(blocked.diagnostics["task-a"].review_findings, [{ role: "compliance", text: "PROBLEMA" }]);
  assert.equal(blocked.diagnostics["task-a"].secret_field, undefined);
  assert.equal(JSON.stringify(f.registry()).includes("PROBLEMA"), false, "diagnostics are never persisted");
  assert.equal((await f.run({ action: "status", compact: true })).diagnostics["task-a"].context_return, undefined);
  f.state.inspect.set("task-a", (entry) => ({ ok: true, result: resultFor(entry, { context_return: contextReturn }) }));
  const ready = await f.run({ action: "status" });
  assert.equal(ready.tasks[0].status, "ready");
  assert.deepEqual(ready.tasks[0].context_return, contextReturn);
  assert.equal((await f.run({ action: "status", compact: true })).tasks[0].context_return, undefined, "compact omits it");
  assert.equal(f.state.launches.length, launches, "status never launches");
  assert.match((await f.run({ action: "status", task_id: "task-z" })).reason, /unknown task/);
});

test("strict fields per action", async (t) => {
  const f = fixture(t);
  for (const [params, pattern] of [
    [{ action: "nuke" }, /unknown task action/],
    [{ action: "dispatch", task_id: "task-a" }, /task_id is not valid for dispatch/],
    [{ action: "status", task_ids: ["task-a"] }, /task_ids is only valid for dispatch/],
    [{ action: "status", session_id: "x" }, /unexpected task parameters/],
    [{ action: "resume", task_id: "task-a", attempt_id: "x", worktree: "/tmp" }, /unexpected task parameters/],
    [{ action: "status", compact: "yes" }, /compact must be boolean/],
    [{ action: "status", task_id: "../x" }, /safe task_id/],
  ]) {
    assert.match((await f.run(params)).reason, pattern, JSON.stringify(params));
  }
});

test("a lane, an unclassified session or an unapproved plan cannot coordinate", async (t) => {
  const f = fixture(t);
  assert.match((await executeTaskAction({ action: "status" }, { ...f.context, isLane: true }, f.deps)).reason, /lane cannot coordinate/);
  assert.match((await executeTaskAction({ action: "status" }, { ...f.context, sessionId: "unknown-session" }, f.deps)).reason, /LIGHT\/FULL classified/);
  fs.appendFileSync(path.join(f.project.root, ".claude/plans/demo-feature/execution-plan.json"), "\n");
  assert.match((await f.run({ action: "dispatch", task_ids: ["task-a"] })).reason, /plan-reviewer APPROVE/);
});

test("a recent registry lock is never stolen; a dead one older than 30 s is recovered", async (t) => {
  const f = fixture(t);
  const lock = path.join(f.project.root, ".claude/plans/.state", f.project.sessionId, "task-runs/index.json.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ token: "live", pid: process.pid, createdAt: new Date().toISOString() }));
  assert.match((await f.run({ action: "status" })).reason, /coordinator busy/);
  fs.writeFileSync(lock, JSON.stringify({ token: "dead", pid: 999_999_999, createdAt: "2000-01-01T00:00:00.000Z" }));
  assert.equal((await f.run({ action: "status" })).ok, true);
  assert.equal(fs.existsSync(lock), false);
});

test("wait returns changed when a running task ends, settled when nothing runs, timeout at the window and never kills on abort", async (t) => {
  const f = fixture(t);
  const wait = (params, extra) => waitForTasks({ action: "wait", ...params }, f.context, { ...f.deps, pollMs: 20, ...extra });
  assert.equal((await wait({})).wait, "settled");
  await f.run({ action: "dispatch", task_ids: ["task-a"] });
  const runId = f.registry().tasks["task-a"].launches[0].run_id;
  f.state.running.add(runId);
  setTimeout(() => f.state.running.delete(runId), 120);
  const changed = await wait({});
  assert.equal(changed.wait, "changed");
  assert.equal(changed.tasks[0].status, "ready");
  f.state.running.add(runId);
  await f.run({ action: "status" });
  let clock = 0;
  const timedOut = await wait({ timeout_seconds: 1 }, { now: () => (clock += 600) });
  assert.equal(timedOut.wait, "timeout");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const aborted = await wait({}, { signal: controller.signal });
  assert.equal(aborted.wait, "aborted");
  assert.equal(f.state.running.has(runId), true, "aborting wait never touches the task");
  assert.match((await wait({ timeout_seconds: 541 })).reason, /between 1 and 540/);
  assert.match((await wait({ timeout_seconds: 0 })).reason, /between 1 and 540/);
});

test("resume requires terminal processes, keeps the attempt and its claim session, and refuses unknown fields", async (t) => {
  const f = fixture(t);
  await f.run({ action: "dispatch", task_ids: ["task-a"] });
  const entry = f.registry().tasks["task-a"];
  f.state.running.add(entry.launches[0].run_id);
  assert.match((await f.run({ action: "resume", task_id: "task-a", attempt_id: entry.attempt_id })).reason, /still running/);
  f.state.running.clear();
  assert.match((await f.run({ action: "resume", task_id: "task-a", attempt_id: "other" })).reason, /exact current task and attempt/);
  assert.match((await f.run({ action: "resume", task_id: "task-a", attempt_id: entry.attempt_id, instruction: "x".repeat(16001) })).reason, /16000/);
  // Without a claim the attempt never got admitted: resume relaunches admission (no --resume).
  assert.equal((await f.run({ action: "resume", task_id: "task-a", attempt_id: entry.attempt_id })).ok, true);
  assert.ok(!f.state.launches.at(-1).args.includes("--resume"));
  fs.writeFileSync(`${entry.grant_path}.claim`, JSON.stringify({ session_id: "66666666-6666-4666-8666-666666666666", grant_sha256: "x" }));
  f.state.inspect.set("task-a", (current) => ({ ok: true, result: resultFor(current) }));
  await f.run({ action: "status" });
  assert.equal(f.registry().tasks["task-a"].status, "ready");
  const resumed = await f.run({ action: "resume", task_id: "task-a", attempt_id: entry.attempt_id, instruction: "fix the edge case" });
  assert.equal(resumed.ok, true, resumed.reason);
  const after = f.registry().tasks["task-a"];
  assert.equal(after.attempt_id, entry.attempt_id);
  assert.equal(after.worktree, entry.worktree);
  assert.deepEqual(after.grant, entry.grant);
  assert.equal(after.launches.length, 3);
  assert.equal(after.result, null, "result is cleared on relaunch");
  const args = f.state.launches.at(-1).args;
  assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "66666666-6666-4666-8666-666666666666"]);
  assert.equal(args.at(-1), "fix the edge case");
});

/** Dispatch one task, commit work in its lane and get it to ready with a scripted inspection. */
async function readyTask(f, taskId, files, { frozenBlobs = {}, freeze = null } = {}) {
  if (!f.registry || !fs.existsSync(path.join(f.project.root, ".claude/plans/.state", f.project.sessionId, "task-runs/index.json")) || !f.registry().tasks[taskId]) {
    const dispatched = await f.run({ action: "dispatch", task_ids: [taskId] });
    assert.equal(dispatched.ok, true, dispatched.reason);
  }
  const entry = f.registry().tasks[taskId];
  // The lane's own admission writes the claim; simulate it (the real launcher is covered elsewhere).
  if (!fs.existsSync(`${entry.grant_path}.claim`)) {
    fs.writeFileSync(`${entry.grant_path}.claim`, JSON.stringify({ session_id: "77777777-7777-4777-8777-777777777777", grant_sha256: "0".repeat(64) }));
  }
  const head = laneCommit(entry.worktree, files);
  f.state.inspect.set(taskId, (current) => ({ ok: true, result: resultFor(current, { frozen_blobs: frozenBlobs, freeze_sha: freeze ?? (Object.keys(frozenBlobs).length ? head : null) }) }));
  const status = await f.run({ action: "status", task_id: taskId });
  assert.equal(status.tasks[0].status, "ready", status.tasks[0].reason);
  return { entry: f.registry().tasks[taskId], head };
}

test("integrate needs the exact attempt and HEAD and creates a two-parent --no-ff merge with a receipt", async (t) => {
  const f = fixture(t);
  const { entry, head } = await readyTask(f, "task-a", { "src/a/index.mjs": "export const a = 1;\n" });
  assert.match((await f.run({ action: "integrate", task_id: "task-a", attempt_id: "wrong", expected_head: head })).reason, /exact current task and attempt/);
  assert.match((await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: "b".repeat(40) })).reason, /differs from expected_head/);
  assert.match((await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: "short" })).reason, /exact expected_head/);
  // A newer branch tip never replaces the inspected HEAD.
  const before = git(f.project.root, "rev-parse", "HEAD");
  const newer = laneCommit(entry.worktree, { "src/a/extra.mjs": "x" });
  f.state.inspect.set("task-a", (current) => ({ ok: true, result: resultFor(current, { child_head: head }) }));
  assert.match((await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: newer })).reason, /verified task HEAD differs/);
  assert.equal(git(f.project.root, "rev-parse", "HEAD"), before, "parent untouched");
  f.state.inspect.delete("task-a");
  const integrated = await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: newer });
  assert.equal(integrated.ok, true, integrated.reason);
  const mergeHead = git(f.project.root, "rev-parse", "HEAD");
  assert.deepEqual(git(f.project.root, "rev-list", "--parents", "-n", "1", mergeHead).split(" ").slice(1), [before, newer]);
  assert.equal(git(f.project.root, "log", "-1", "--format=%s"), `Integrate harness task task-a (${entry.attempt_id})`);
  const receipt = f.registry().tasks["task-a"].integration;
  assert.equal(receipt.written_by, "host-task-integration");
  assert.equal(receipt.integrated_head, mergeHead);
  assert.equal(receipt.result_sha256, hashTaskReceipt(f.registry().tasks["task-a"].result));
  assert.equal(f.registry().integration_intent, undefined);
  assert.equal((await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: newer })).ok, true, "idempotent retry");
  assert.equal(git(f.project.root, "rev-parse", "HEAD"), mergeHead);
});

test("dependencies dispatch only after integration with a re-validated receipt", async (t) => {
  const f = fixture(t);
  const { entry, head } = await readyTask(f, "task-a", { "src/a/index.mjs": "1\n" });
  assert.match((await f.run({ action: "dispatch", task_ids: ["task-c"] })).reason, /dependency task-a must be integrated/);
  await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: head });
  assert.match((await f.run({ action: "dispatch", task_ids: ["task-c"] }, { readIntegrated: () => ({ ok: false, reason: "forged receipt" }) })).reason, /forged receipt/);
  const dispatched = await f.run({ action: "dispatch", task_ids: ["task-c"] });
  assert.equal(dispatched.ok, true, dispatched.reason);
  const grant = f.registry().tasks["task-c"].grant;
  assert.equal(grant.dependencies[0].task_id, "task-a");
  assert.equal(grant.dependencies[0].receipt_sha256, hashTaskReceipt(f.registry().tasks["task-a"].integration));
  assert.equal(grant.base_sha, git(f.project.root, "rev-parse", "HEAD"), "the dependent starts from the aggregate that contains its dependency");
});

test("a merge conflict is detected before the parent is touched", async (t) => {
  const f = fixture(t);
  const { entry, head } = await readyTask(f, "task-a", { "src/a/index.mjs": "task\n" });
  fs.mkdirSync(path.join(f.project.root, "src/a"), { recursive: true });
  fs.writeFileSync(path.join(f.project.root, "src/a/index.mjs"), "parent\n");
  git(f.project.root, "add", "src/a/index.mjs");
  git(f.project.root, "commit", "-qm", "parent edit");
  const before = git(f.project.root, "rev-parse", "HEAD");
  const result = await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: head });
  assert.match(result.reason, /merge conflicts in src\/a\/index\.mjs; use resume/);
  assert.equal(git(f.project.root, "rev-parse", "HEAD"), before);
  assert.equal(git(f.project.root, "status", "--porcelain", "--untracked-files=no"), "");
});

test("integration never changes a frozen test; it may only carry the parent's bytes (frozen_parent)", async (t) => {
  const f = fixture(t);
  const original = "test original\n";
  const { entry } = await readyTask(f, "task-a", { "test/task-a.test.mjs": original, "src/a/index.mjs": "1\n" }, { frozenBlobs: { "test/task-a.test.mjs": sha256(original) } });
  const tampered = laneCommit(entry.worktree, { "test/task-a.test.mjs": "weakened\n" });
  f.state.inspect.set("task-a", (current) => ({ ok: true, result: resultFor(current, { frozen_blobs: { "test/task-a.test.mjs": sha256(original) }, freeze_sha: tampered }) }));
  await f.run({ action: "status" });
  assert.match((await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: tampered })).reason, /would change frozen test test\/task-a\.test\.mjs/);

  const g = fixture(t);
  // The frozen test already exists at the base; the task freezes it unchanged.
  fs.mkdirSync(path.join(g.project.root, "test"), { recursive: true });
  fs.writeFileSync(path.join(g.project.root, "test/task-b.test.mjs"), original);
  git(g.project.root, "add", "test/task-b.test.mjs");
  git(g.project.root, "commit", "-qm", "existing locked test");
  const { entry: b, head: bHead } = await readyTask(g, "task-b", { "src/b/index.mjs": "1\n" }, { frozenBlobs: { "test/task-b.test.mjs": sha256(original) } });
  // The global parent changes that frozen test meanwhile (a base merge): the task may only carry the parent's bytes.
  fs.writeFileSync(path.join(g.project.root, "test/task-b.test.mjs"), "parent update\n");
  git(g.project.root, "add", "test/task-b.test.mjs");
  git(g.project.root, "commit", "-qm", "parent changes test");
  const parentHead = git(g.project.root, "rev-parse", "HEAD");
  const integrated = await g.run({ action: "integrate", task_id: "task-b", attempt_id: b.attempt_id, expected_head: bHead });
  assert.equal(integrated.ok, true, integrated.reason);
  const receipt = g.registry().tasks["task-b"].integration;
  assert.deepEqual(receipt.frozen_parent, { head_sha: parentHead, blobs: { "test/task-b.test.mjs": sha256("parent update\n") } });
  assert.equal(fs.readFileSync(path.join(g.project.root, "test/task-b.test.mjs"), "utf8"), "parent update\n");
});

test("an already ancestral task HEAD integrates without a merge", async (t) => {
  const f = fixture(t);
  const { entry, head } = await readyTask(f, "task-a", { "src/a/index.mjs": "1\n" });
  git(f.project.root, "merge", "--no-ff", "--no-edit", "-m", "manual", head);
  const parentHead = git(f.project.root, "rev-parse", "HEAD");
  const result = await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: head });
  assert.equal(result.ok, true, result.reason);
  assert.equal(git(f.project.root, "rev-parse", "HEAD"), parentHead, "no new merge commit");
  const receipt = f.registry().tasks["task-a"].integration;
  assert.equal(receipt.integrated_head, parentHead);
  assert.equal(receipt.already_ancestral, true);
});

test("a crash between merge and receipt is completed by the next action", async (t) => {
  const f = fixture(t);
  const { entry, head } = await readyTask(f, "task-a", { "src/a/index.mjs": "1\n" });
  const parentHead = git(f.project.root, "rev-parse", "HEAD");
  const registryFile = path.join(f.project.root, ".claude/plans/.state", f.project.sessionId, "task-runs/index.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const tree = git(f.project.root, "merge-tree", "--write-tree", parentHead, head);
  registry.integration_intent = { task_id: "task-a", attempt_id: entry.attempt_id, parent_head: parentHead, child_head: head, tree, result_sha256: hashTaskReceipt(registry.tasks["task-a"].result) };
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  git(f.project.root, "merge", "--no-ff", "--no-edit", "-m", `Integrate harness task task-a (${entry.attempt_id})`, head);
  const status = await f.run({ action: "status" });
  assert.equal(status.ok, true, status.reason);
  assert.equal(status.tasks[0].status, "integrated");
  assert.equal(f.registry().tasks["task-a"].integration.integrated_head, git(f.project.root, "rev-parse", "HEAD"));
  assert.equal(f.registry().integration_intent, undefined);
});

test("a failing pre-merge-commit hook aborts only the exact journaled merge", async (t) => {
  const f = fixture(t);
  const { entry, head } = await readyTask(f, "task-a", { "src/a/index.mjs": "1\n" });
  const hook = path.join(f.project.root, ".git/hooks/pre-merge-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const before = git(f.project.root, "rev-parse", "HEAD");
  const failed = await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: head });
  assert.equal(failed.ok, false);
  assert.ok(f.registry().integration_intent, "the journal survives the failed merge");
  fs.rmSync(hook);
  const status = await f.run({ action: "status" });
  assert.equal(status.ok, true, status.reason);
  assert.equal(f.registry().integration_intent, undefined);
  assert.equal(git(f.project.root, "rev-parse", "HEAD"), before);
  let merging = true;
  try { git(f.project.root, "rev-parse", "--verify", "-q", "MERGE_HEAD"); } catch { merging = false; }
  assert.equal(merging, false, "the half-done merge was aborted");
  assert.equal((await f.run({ action: "integrate", task_id: "task-a", attempt_id: entry.attempt_id, expected_head: head })).ok, true);
});

async function integrateReady(f, taskId) {
  const entry = f.registry().tasks[taskId];
  const result = await f.run({ action: "integrate", task_id: taskId, attempt_id: entry.attempt_id, expected_head: entry.result.child_head });
  assert.equal(result.ok, true, result.reason);
  return f.registry().tasks[taskId];
}

test("correcting an integrated task opens a barrier, archives its receipt and invalidates the aggregate", async (t) => {
  const f = fixture(t);
  await readyTask(f, "task-a", { "src/a/index.mjs": "1\n" });
  const a = await integrateReady(f, "task-a");
  const gateState = path.join(f.project.root, ".claude/plans/.state", f.project.sessionId, "gate-state.json");
  fs.writeFileSync(gateState, JSON.stringify({ feature_id: f.project.featureId, final_review_done: true, demo_done: true }));
  const resumed = await f.run({ action: "resume", task_id: "task-a", attempt_id: a.attempt_id, instruction: "fix the reviewer finding" });
  assert.equal(resumed.ok, true, resumed.reason);
  const registry = f.registry();
  assert.deepEqual(registry.correction_barrier, { task_id: "task-a", attempt_id: a.attempt_id, aggregate_invalidated: true });
  assert.equal(registry.tasks["task-a"].integration, null);
  assert.deepEqual(registry.tasks["task-a"].integration_history, [a.integration]);
  assert.ok(registry.tasks["task-a"].result_history[a.integration.result_sha256]);
  const state = JSON.parse(fs.readFileSync(gateState, "utf8"));
  assert.equal(state.final_review_done, undefined);
  assert.equal(state.demo_done, undefined);
  assert.match((await f.run({ action: "dispatch", task_ids: ["task-b"] })).reason, /correction barrier/);
  assert.equal((await f.run({ action: "status" })).ok, true, "observation stays allowed");
  // Reintegration of the corrected attempt closes the barrier.
  laneCommit(a.worktree, { "src/a/index.mjs": "2\n" }, "fix: a");
  await f.run({ action: "status" });
  const reintegrated = await integrateReady(f, "task-a");
  assert.notEqual(hashTaskReceipt(reintegrated.integration), hashTaskReceipt(a.integration));
  assert.equal(f.registry().correction_barrier, undefined);
  assert.equal((await f.run({ action: "dispatch", task_ids: ["task-b"] })).ok, true);
});

test("a pending dependent is reconciled by the host after its corrected dependency reintegrates", async (t) => {
  const f = fixture(t);
  await readyTask(f, "task-a", { "src/a/index.mjs": "1\n" });
  const a = await integrateReady(f, "task-a");
  await readyTask(f, "task-c", { "src/c/index.mjs": "c1\n" });
  const c = f.registry().tasks["task-c"];
  const cHead = c.result.child_head;
  assert.equal((await f.run({ action: "resume", task_id: "task-a", attempt_id: a.attempt_id, instruction: "correct a" })).ok, true);
  let registry = f.registry();
  assert.equal(registry.tasks["task-c"].status, "blocked");
  assert.deepEqual(Object.keys(registry.tasks["task-c"].reconciliation_required.upstreams), ["task-a"]);
  assert.match((await f.run({ action: "resume", task_id: "task-c", attempt_id: c.attempt_id })).reason, /correction barrier/);
  laneCommit(a.worktree, { "src/a/index.mjs": "2\n" }, "fix: a");
  await f.run({ action: "status", task_id: "task-a" });
  await integrateReady(f, "task-a");
  registry = f.registry();
  assert.match(registry.tasks["task-c"].reason ?? (await f.run({ action: "status", task_id: "task-c" })).tasks[0].reason, /requires reconciliation|being corrected/);
  const resumed = await f.run({ action: "resume", task_id: "task-c", attempt_id: c.attempt_id, instruction: "recapture after the dependency correction" });
  assert.equal(resumed.ok, true, resumed.reason);
  const after = f.registry().tasks["task-c"];
  assert.equal(after.reconciliation_required, undefined);
  const proof = after.reconciliations.at(-1);
  assert.equal(proof.written_by, "host-task-reconciliation");
  assert.equal(proof.pre_child_head, cHead);
  assert.equal(proof.upstreams[0].task_id, "task-a");
  const mergeParents = git(c.worktree, "rev-list", "--parents", "-n", "1", proof.merged_head).split(" ").slice(1);
  assert.deepEqual(mergeParents, [cHead, proof.parent_head]);
  assert.equal(fs.readFileSync(path.join(c.worktree, "src/a/index.mjs"), "utf8"), "2\n", "the corrected dependency is in the dependent worktree");
  assert.match(f.state.launches.at(-1).args.at(-1), /host merged a dependency correction/);
});

test("an integration conflict is opened in the lane by the host and preserved across resumes", async (t) => {
  const f = fixture(t);
  const { entry: b, head } = await readyTask(f, "task-b", { "src/b/index.mjs": "task\n" });
  fs.mkdirSync(path.join(f.project.root, "src/b"), { recursive: true });
  fs.writeFileSync(path.join(f.project.root, "src/b/index.mjs"), "parent\n");
  git(f.project.root, "add", "src/b/index.mjs");
  git(f.project.root, "commit", "-qm", "parent edits b");
  assert.match((await f.run({ action: "integrate", task_id: "task-b", attempt_id: b.attempt_id, expected_head: head })).reason, /merge conflicts/);
  const first = await f.run({ action: "resume", task_id: "task-b", attempt_id: b.attempt_id, instruction: "resolve" });
  assert.equal(first.ok, true, first.reason);
  const parentHead = git(f.project.root, "rev-parse", "HEAD");
  assert.equal(git(b.worktree, "rev-parse", "MERGE_HEAD"), parentHead, "the host opened the merge in the lane");
  assert.match(f.state.launches.at(-1).args.at(-1), /already started the task merge[^]*src\/b\/index\.mjs/);
  const status = await f.run({ action: "status", task_id: "task-b" });
  assert.match(status.tasks[0].reason, /merge conflicts require resolution in the same task/);
  assert.equal((await f.run({ action: "resume", task_id: "task-b", attempt_id: b.attempt_id })).ok, true);
  assert.equal(git(b.worktree, "rev-parse", "MERGE_HEAD"), parentHead, "the open merge survives a second resume");
  assert.match(git(b.worktree, "diff", "--name-only", "--diff-filter=U"), /src\/b\/index\.mjs/);
});

test("an aggregate refresh needs the exact current parent HEAD and a concrete instruction", async (t) => {
  const f = fixture(t);
  await readyTask(f, "task-a", { "src/a/index.mjs": "1\n" });
  const a = await integrateReady(f, "task-a");
  await readyTask(f, "task-b", { "src/b/index.mjs": "1\n" });
  await integrateReady(f, "task-b");
  const aggregate = git(f.project.root, "rev-parse", "HEAD");
  assert.match((await f.run({ action: "resume", task_id: "task-a", attempt_id: a.attempt_id, reconcile_head: "c".repeat(40), instruction: "x" })).reason, /exact current committed aggregate HEAD/);
  assert.match((await f.run({ action: "resume", task_id: "task-a", attempt_id: a.attempt_id, reconcile_head: aggregate })).reason, /concrete correction instruction/);
  const refreshed = await f.run({ action: "resume", task_id: "task-a", attempt_id: a.attempt_id, reconcile_head: aggregate, instruction: "regenerate evidence on the aggregate" });
  assert.equal(refreshed.ok, true, refreshed.reason);
  const entry = f.registry().tasks["task-a"];
  const proof = entry.reconciliations.at(-1);
  assert.equal(proof.kind, "aggregate-refresh");
  assert.equal(proof.parent_head, aggregate);
  assert.equal(proof.source_integration_sha256, hashTaskReceipt(a.integration));
  assert.ok(fs.existsSync(path.join(a.worktree, "src/b/index.mjs")), "the aggregate (task-b) is merged into the lane");
  assert.equal(f.registry().correction_barrier.task_id, "task-a");
});

test("abandon-resume needs the explicit declaration and the exact unchanged HEAD, then restores the receipt", async (t) => {
  const f = fixture(t);
  await readyTask(f, "task-a", { "src/a/index.mjs": "1\n" });
  const a = await integrateReady(f, "task-a");
  await f.run({ action: "resume", task_id: "task-a", attempt_id: a.attempt_id, instruction: "maybe fix" });
  const head = git(a.worktree, "rev-parse", "HEAD");
  assert.match((await f.run({ action: "abandon-resume", task_id: "task-a", attempt_id: a.attempt_id, expected_head: head, reason: "no change needed" })).reason, /no_product_obligation/);
  assert.match((await f.run({ action: "abandon-resume", task_id: "task-a", attempt_id: a.attempt_id, expected_head: "d".repeat(40), no_product_obligation: true, reason: "x" })).reason, /exact unchanged task expected_head/);
  const abandoned = await f.run({ action: "abandon-resume", task_id: "task-a", attempt_id: a.attempt_id, expected_head: head, no_product_obligation: true, reason: "the finding was a false positive" });
  assert.equal(abandoned.ok, true, abandoned.reason);
  const entry = f.registry().tasks["task-a"];
  assert.equal(entry.status, "integrated");
  assert.deepEqual(entry.integration, a.integration);
  assert.equal(entry.abandoned_resumes[0].written_by, "host-task-resume-abandonment");
  assert.equal(f.registry().correction_barrier, undefined);
  assert.equal(entry.launches.length, 2, "no launch is removed");
});
