import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ControlPlane, CONTROL_CAPABILITIES } from "./lib/control-plane.mjs";
import {
  appendBridgeEvent,
  claimBridgeSession,
  consumeInbox,
  listBridgeEvents,
  markDecisionApplied,
  prepareBridgeResume,
  readBridge,
} from "./lib/protocol.mjs";

const AUTHORIZATION = "explicit-current-turn";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeJson(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function makeConsumer(root, version = "v9.9.9") {
  fs.mkdirSync(path.join(root, ".pi", "harness"), { recursive: true });
  writeJson(path.join(root, ".pi", "harness", "control-capabilities.json"), CONTROL_CAPABILITIES);
  fs.writeFileSync(path.join(root, ".pi", "harness", "pi-harness.mjs"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(path.join(root, ".pi", ".harness-version"), `${version}\n`, "utf8");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function currentProcessStartToken() {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

function makeRunningParent(root, sessionId = "external-session") {
  const harness = path.join(root, ".pi", "harness");
  writeJson(path.join(harness, "state", "parent-orchestrator.lock"), {
    pid: process.pid,
    process_start_ticks: currentProcessStartToken(),
    session_id: sessionId,
  });
  writeJson(path.join(harness, "state", sessionId, "gate-state.json"), {
    session_id: sessionId,
    feature_id: "existing-feature",
    mode: "FULL",
    spec_status: "adversary-reviewed",
    final_review_done: false,
  });
  fs.mkdirSync(path.join(harness, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(harness, "sessions", `2026-01-01_${sessionId}.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root })}\n`, "utf8");
}

class FakeExternal {
  constructor(options = {}) {
    this.issues = options.issues ?? [];
    this.issueStates = options.issueStates ?? {};
    this.worktrees = [];
    this.terminals = [];
    this.crontab = options.crontab ?? "";
    this.automations = options.automations ?? [];
    this.repos = options.repos ?? [];
    this.worktreePath = options.worktreePath;
    this.calls = [];
    this.previousExited = false;
    this.tuiIdle = false;
    this.loseWorktreeResponse = options.loseWorktreeResponse ?? false;
    this.loseTerminalResponse = options.loseTerminalResponse ?? false;
    this.initialWorktrees = structuredClone(options.worktrees ?? []);
    this.worktrees.push(...this.initialWorktrees);
    this.remote = options.remote ?? "git@github.com:owner/repo.git";
    this.remotes = options.remotes ?? {};
    this.orcaRepoPath = options.orcaRepoPath;
    this.orcaRepoPaths = options.orcaRepoPaths ?? {};
    this.headSha = options.headSha ?? "a".repeat(40);
  }
  async text(command, args) {
    this.calls.push(["text", command, args]);
    if (command === process.execPath && args.includes("--verify")) return JSON.stringify({ ok: true, runtimeVersion: "0.86.1" });
    throw new Error(`unexpected text command: ${command}`);
  }
  async gh(args) {
    this.calls.push(["gh", ...args]);
    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      const issue = this.issues.find((entry) => entry.number === number);
      return { ...(issue ?? {}), state: this.issueStates[number] ?? (issue ? "OPEN" : "UNKNOWN") };
    }
    if (args[0] === "pr" && args[1] === "view") {
      return { url: args[2], isDraft: true, headRefOid: "a".repeat(40), state: "OPEN" };
    }
    return structuredClone(this.issues);
  }
  async git(args) {
    this.calls.push(["git", ...args]);
    if (args.includes("get-url")) return this.remotes[args[1]] ?? this.remote;
    if (args.includes("--git-common-dir")) return "/fixture/common.git";
    if (args.at(-1) === "HEAD") return this.headSha;
    if (String(args.at(-1)).startsWith("origin/")) return "a".repeat(40);
    if (args.includes("--show-current")) return "harness-1";
    return "";
  }
  async crontabRead() {
    this.calls.push(["crontab-read"]);
    return this.crontab;
  }
  async crontabWrite(text) {
    this.calls.push(["crontab-write", text]);
    this.crontab = text;
  }
  async orca(args) {
    this.calls.push(["orca", ...args]);
    const key = args.slice(0, 2).join(" ");
    if (key === "repo show") {
      const selector = args[args.indexOf("--repo") + 1];
      if (String(selector).startsWith("path:")) {
        const selectedPath = String(selector).slice("path:".length);
        const match = Object.entries(this.orcaRepoPaths).find(([, candidate]) => candidate === selectedPath);
        return { repo: { id: match?.[0] ?? "orca-repo", path: selectedPath } };
      }
      const id = String(selector).replace(/^id:/, "");
      return { repo: { id, path: this.orcaRepoPaths[id] ?? this.orcaRepoPath } };
    }
    if (key === "repo list") return { repos: structuredClone(this.repos) };
    if (key === "automations list") return { automations: structuredClone(this.automations) };
    if (key === "automations edit") {
      const item = this.automations.find((entry) => entry.id === args[2]);
      if (!item) throw new Error("automation missing");
      item.enabled = true;
      return { automation: item };
    }
    if (key === "worktree list") return { worktrees: structuredClone(this.worktrees), truncated: false };
    if (key === "worktree create") {
      const marker = args[args.indexOf("--comment") + 1];
      const worktree = { id: "orca-repo::delivery", instanceId: "instance-1", repoId: "orca-repo", path: this.worktreePath, comment: marker };
      this.worktrees.push(worktree);
      if (this.loseWorktreeResponse) {
        this.loseWorktreeResponse = false;
        throw new Error("transport lost after worktree creation");
      }
      return { worktree };
    }
    if (key === "terminal list") return { terminals: structuredClone(this.terminals), truncated: false };
    if (key === "terminal create") {
      const title = args[args.indexOf("--title") + 1];
      const terminal = { handle: `term-${this.terminals.length + 1}`, worktreeId: "orca-repo::delivery", title, surface: "visible" };
      this.terminals.push(terminal);
      if (this.loseTerminalResponse) {
        this.loseTerminalResponse = false;
        throw new Error("transport lost after terminal creation");
      }
      return { terminal };
    }
    if (key === "terminal send") return { sent: true };
    if (key === "terminal show") {
      const handle = args[args.indexOf("--terminal") + 1];
      return { terminal: structuredClone(this.terminals.find((entry) => entry.handle === handle)) };
    }
    if (key === "terminal wait") {
      const condition = args[args.indexOf("--for") + 1];
      const satisfied = condition === "exit" ? this.previousExited : condition === "tui-idle" ? this.tuiIdle : false;
      if (!satisfied) {
        const error = new Error("timeout");
        error.code = "timeout";
        throw error;
      }
      return { wait: { satisfied: true, condition } };
    }
    throw new Error(`unexpected Orca command: ${args.join(" ")}`);
  }
}

function issue(number, title, extra = {}) {
  const { labels = [], ...rest } = extra;
  return {
    number, title, body: "", createdAt: `2026-01-${String(number).padStart(2, "0")}T00:00:00Z`,
    labels: [{ name: "harness:ready" }, ...labels], url: `https://example.test/issues/${number}`, ...rest,
  };
}

function writeSelectorConfig(file, repo, overrides = {}) {
  writeJson(file, {
    project: "Project X", ghRepo: "owner/repo", orcaRepoId: "orca-repo",
    clonePath: repo, baseBranch: "main", globalMaxWorking: 1, prompt: "Implement issue",
    ...overrides,
  });
}

async function setupControl(options = {}) {
  const root = tempDir("control-plane-test");
  const home = path.join(root, "home");
  const repo = makeConsumer(path.join(root, "repo"));
  const worktree = makeConsumer(path.join(root, "worktree"));
  const external = new FakeExternal({ issues: options.issues ?? [issue(1, "First")], issueStates: options.issueStates, worktreePath: worktree, crontab: options.crontab, automations: options.automations, worktrees: options.worktrees });
  external.orcaRepoPath = repo;
  external.loseWorktreeResponse = options.loseWorktreeResponse ?? false;
  external.loseTerminalResponse = options.loseTerminalResponse ?? false;
  let control;
  const sleep = async () => {
    const deliveryRoot = path.join(home, "deliveries");
    if (!fs.existsSync(deliveryRoot)) return;
    for (const entry of fs.readdirSync(deliveryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(deliveryRoot, entry.name);
      const bridgeFile = path.join(dir, "bridge.json");
      if (!fs.existsSync(bridgeFile)) continue;
      const bridge = readBridge(dir);
      if (listBridgeEvents(dir).some((event) => event.type === "session.started" && event.generation === bridge.generation)) continue;
      await claimBridgeSession(dir, { cwd: worktree, sessionId: "session-real" });
    }
  };
  control = new ControlPlane({ home, external, sleep, startWaitMs: 200 });
  await control.registerProject({
    name: "Project X", aliases: ["x"], repo_path: repo, gh_repo: "owner/repo",
    orca_repo_id: "orca-repo", base_branch: "main", setup: "skip", automation: options.automation ?? null,
  });
  return { root, home, repo, worktree, external, control };
}

test("Given a project question, recommendation is durable and causes no dispatch", async () => {
  const { control, external, home } = await setupControl({ issues: [issue(2, "Older"), issue(1, "High", { labels: [{ name: "p1" }] })] });
  const result = await control.recommendIssue("x");
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.issue.number, 1);
  const issueList = external.calls.find((call) => call[0] === "gh" && call[1] === "issue" && call[2] === "list");
  assert.deepEqual(issueList.slice(issueList.indexOf("--label"), issueList.indexOf("--label") + 2), ["--label", "harness:ready"]);
  assert.equal(fs.readdirSync(path.join(home, "deliveries")).length, 0);
  assert.equal(external.calls.some((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create"), false);
  const restarted = new ControlPlane({ home, external, sleep: async () => {}, startWaitMs: 1 });
  assert.equal(restarted.portfolio("x").recommendations[0].recommendation_id, result.recommendation.recommendation_id);
});

test("Repeated recommendation reuses one binding and a new choice supersedes the old one", async () => {
  const { control, external, home } = await setupControl({ issues: [issue(1, "First")] });
  const first = await control.recommendIssue("x");
  const repeated = await control.recommendIssue("x");
  assert.equal(repeated.replay, true);
  assert.equal(repeated.recommendation.recommendation_id, first.recommendation.recommendation_id);
  assert.equal(fs.readdirSync(path.join(home, "recommendations")).length, 1);

  external.issues = [issue(2, "Second")];
  const replacement = await control.recommendIssue("x");
  assert.notEqual(replacement.recommendation.recommendation_id, first.recommendation.recommendation_id);
  assert.equal(control.portfolio("x").recommendations.length, 1);
  assert.equal(control.portfolio("x").recommendations[0].issue.number, 2);
  await assert.rejects(
    () => control.startDelivery(first.recommendation.recommendation_id, AUTHORIZATION),
    /recommendation is not current: superseded/,
  );
});

test("Recommendation excludes an issue already linked to an Orca worktree", async () => {
  const { control } = await setupControl({
    issues: [issue(1, "Already running"), issue(2, "Available")],
    worktrees: [{ id: "existing", repoId: "orca-repo", linkedIssue: { number: 1 }, status: "working" }],
  });
  const result = await control.recommendIssue("x");
  assert.equal(result.recommendation.issue.number, 2);
});

test("A preexisting parent is tracked durably without creating or restarting anything", async () => {
  const { control, external, root, repo, home } = await setupControl();
  const existing = makeConsumer(path.join(root, "existing-parent"));
  makeRunningParent(existing);
  const worktreeId = `orca-repo::${existing}`;
  external.worktrees.push({
    id: worktreeId,
    instanceId: "existing-instance",
    repoId: "orca-repo",
    path: existing,
    branch: "refs/heads/harness-existing-feature",
    isMainWorktree: false,
    parentWorktreeId: null,
    linkedIssue: 7,
    linkedWorkItem: { title: "Existing feature", url: "https://example.test/issues/7" },
  });
  external.terminals.push({
    handle: "term-existing",
    worktreeId,
    worktreePath: existing,
    title: "Pi",
    connected: true,
    orphaned: false,
  });

  const found = await control.discoverRuns("x");
  assert.equal(found.ok, true);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].session_id, "external-session");
  const tracked = await control.trackRun("x", found.candidates[0].candidate_id);
  assert.equal(tracked.ok, true);
  assert.equal(tracked.outcome, "tracked");
  assert.equal(tracked.delivery.state, "running");
  assert.equal(tracked.delivery.tracking.mode, "external-readonly");
  assert.equal(tracked.delivery.tracking.bridge, "unavailable-preexisting-session");
  assert.equal(tracked.delivery.progress.state, "unavailable");
  assert.equal(external.calls.some((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create"), false);
  assert.equal(external.calls.some((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "create"), false);

  const sent = await control.sendTrackedRunMessage({
    delivery_id: tracked.delivery.delivery_id,
    message: "Continue verificando a tarefa atual e reporte o resultado.",
    authorization: AUTHORIZATION,
  });
  assert.equal(sent.state, "sent");
  assert.equal(sent.applied, false);
  const sentReplay = await control.sendTrackedRunMessage({
    delivery_id: tracked.delivery.delivery_id,
    message: "Continue verificando a tarefa atual e reporte o resultado.",
    authorization: AUTHORIZATION,
  });
  assert.equal(sentReplay.replay, true);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "send").length, 1);

  const replay = await control.trackRun("x", found.candidates[0].candidate_id);
  assert.equal(replay.replay, true);

  external.terminals[0].connected = false;
  external.terminals.push({
    handle: "term-resumed", worktreeId, worktreePath: existing, title: "Pi resumed",
    connected: true, orphaned: false,
  });
  const resumedCandidate = (await control.discoverRuns("x")).candidates.find((item) =>
    item.terminal.handle === "term-resumed");
  const rebound = await control.trackRun("x", resumedCandidate.candidate_id);
  assert.equal(rebound.ok, true);
  assert.equal(rebound.outcome, "terminal-rebound");
  assert.equal(rebound.replay, false);
  assert.equal(rebound.delivery.delivery_id, tracked.delivery.delivery_id);
  assert.equal(rebound.delivery.session_id, "external-session");
  assert.equal(rebound.delivery.generation, 2);
  assert.equal(rebound.delivery.terminal.handle, "term-resumed");
  assert.equal(control.portfolio("x").deliveries.length, 1);

  const restarted = new ControlPlane({ home, external, sleep: async () => {}, startWaitMs: 1 });
  assert.equal(restarted.portfolio("x").deliveries[0].session_id, "external-session");
  assert.equal((await restarted.resumeDelivery({
    delivery_id: tracked.delivery.delivery_id,
    authorization: AUTHORIZATION,
  })).reason, "tracked-run-is-observation-only");
  assert.equal((await restarted.answerDecision({
    delivery_id: tracked.delivery.delivery_id,
    decision_id: "decision-one",
    revision: 1,
    answer: "yes",
    authorization: AUTHORIZATION,
  })).reason, "tracked-run-has-no-control-bridge");
  assert.equal(repo.endsWith("repo"), true);
});

test("The silent supervisor reports exit of the exact tracked terminal without bridge polling", async () => {
  const { control, external, root } = await setupControl();
  const existing = makeConsumer(path.join(root, "existing-parent"));
  makeRunningParent(existing, "external-session-two");
  const worktreeId = `orca-repo::${existing}`;
  external.worktrees.push({
    id: worktreeId, instanceId: "existing-instance", repoId: "orca-repo", path: existing,
    isMainWorktree: false, parentWorktreeId: null, linkedIssue: 8,
  });
  external.terminals.push({
    handle: "term-existing", worktreeId, worktreePath: existing, title: "Pi", connected: true, orphaned: false,
  });
  const candidate = (await control.discoverRuns("x")).candidates[0];
  const tracked = await control.trackRun("x", candidate.candidate_id);
  assert.equal(await control.nextNotification(), null);
  external.terminals[0].lastOutputAt = 12345;
  external.tuiIdle = true;
  const childSessionId = "child-session-active";
  const childFile = path.join(
    existing, ".pi", "harness", "state", "external-session-two", "child-identity",
    `${createHash("sha256").update(childSessionId).digest("hex")}.json`,
  );
  writeJson(childFile, {
    parent_session_id: "external-session-two",
    child_session_id: childSessionId,
    dispatch_call_id: "call-active-reviewer",
    role: "harness-plan-reviewer",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  const active = control.portfolio("x").deliveries[0].tracking.activity;
  assert.equal(active.state, "child-running");
  assert.equal(active.active_children[0].role, "harness-plan-reviewer");
  assert.equal(await control.nextNotification(), null);
  fs.unlinkSync(childFile);
  const processPath = path.join(existing, ".pi", "harness", "state", "external-session-two", "task-runs", "jobs", "attempt-active", "run-active", "process.json");
  const resultPath = path.join(path.dirname(processPath), "result.json");
  const descriptorPath = path.join(path.dirname(processPath), "job.json");
  const workerPath = path.join(existing, ".pi", "harness", "bin", "pi-task-worker.mjs");
  const registryPath = path.join(existing, ".pi", "harness", "state", "external-session-two", "task-runs", "index.json");
  writeJson(processPath, {
    version: 1,
    run_id: "run-active",
    pid: process.pid,
    process_start_ticks: currentProcessStartToken(),
    started_at: "2026-01-01T00:00:01.000Z",
  });
  const registry = {
    version: 1,
    parent_session_id: "external-session-two",
    feature_id: "existing-feature",
    tasks: {
      "task-active": {
        task_id: "task-active",
        parent_session_id: "external-session-two",
        status: "running",
        launches: [{
          run_id: "run-active",
          process_path: processPath,
          result_path: resultPath,
          descriptor_path: descriptorPath,
          worker_path: workerPath,
          orca: { terminal_handle: "term-task-active" },
        }],
      },
    },
  };
  writeJson(registryPath, registry);
  const canonicalProgress = {
    featureId: "existing-feature",
    tasks: [
      { canonicalTaskId: "task-complete", title: "Preparar contrato", status: "completed", validationStatus: "passed" },
      { canonicalTaskId: "task-active", title: "Implementar fluxo", status: "in_progress", validationStatus: "pending" },
    ],
  };
  control.readTaskProgress = () => canonicalProgress;
  const taskActive = control.portfolio("x").deliveries[0].tracking.activity;
  assert.equal(taskActive.state, "child-running");
  assert.equal(taskActive.active_children[0].role, "harness-task-worker");
  assert.equal(taskActive.active_children[0].task_id, "task-active");
  const taskProgress = control.portfolio("x").deliveries[0].progress;
  assert.deepEqual({ completed: taskProgress.completed_tasks, total: taskProgress.total_tasks, phase: taskProgress.phase },
    { completed: 1, total: 2, phase: "tasks" });
  assert.deepEqual(taskProgress.tasks.map(({ task_id, title, status }) => ({ task_id, title, status })), [
    { task_id: "task-complete", title: "Preparar contrato", status: "completed" },
    { task_id: "task-active", title: "Implementar fluxo", status: "in_progress" },
  ]);
  assert.equal(await control.nextNotification(), null);
  registry.tasks["task-active"].status = "integrated";
  writeJson(registryPath, registry);
  canonicalProgress.tasks[1] = { ...canonicalProgress.tasks[1], status: "completed", validationStatus: "passed" };
  assert.equal(control.portfolio("x").deliveries[0].progress.phase, "final-review");
  const gatePath = path.join(existing, ".pi", "harness", "state", "external-session-two", "gate-state.json");
  const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
  writeJson(gatePath, { ...gate, final_review_done: true });
  assert.equal(control.portfolio("x").deliveries[0].progress.phase, "shipping");
  external.terminals[0].preview = "Thinking...\n── ⠹ Working ─────────────────";
  assert.equal(await control.nextNotification(), null);
  external.terminals[0].preview = "Preciso de uma decisão do operador antes de continuar.";
  control.sleep = async () => writeJson(childFile, {
    parent_session_id: "external-session-two",
    child_session_id: childSessionId,
    dispatch_call_id: "call-active-reviewer",
    role: "harness-plan-reviewer",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(await control.nextNotification(), null, "a child created during confirmation suppresses stale attention");
  fs.unlinkSync(childFile);
  control.sleep = async () => { external.terminals[0].lastOutputAt += 1; };
  assert.equal(await control.nextNotification(), null, "new terminal output during confirmation is progress, not attention");
  control.sleep = async () => {};
  const attention = await control.nextNotification();
  assert.equal(attention.kind, "terminal-idle");
  assert.equal(attention.type, "session.attention-needed");
  assert.match(attention.content_fingerprint, /^[0-9a-f]{64}$/);
  await control.acknowledgeNotification(attention);
  external.terminals[0].lastOutputAt = 67890;
  assert.equal(await control.nextNotification(), null);
  const waited = await control.waitForChange({
    delivery_id: tracked.delivery.delivery_id,
    timeout_ms: 3_600_000,
  });
  assert.equal(waited.outcome, "timeout");
  const waitCall = external.calls.filter((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "wait").at(-1);
  assert.equal(waitCall[waitCall.indexOf("--timeout-ms") + 1], "30000");
  external.previousExited = true;
  const notification = await control.nextNotification();
  assert.equal(notification.kind, "terminal-exit");
  assert.equal(notification.terminal_handle, "term-existing");
  assert.equal(control.portfolio("x").deliveries[0].state, "interrupted");
  await control.acknowledgeNotification(notification);
  assert.equal(await control.nextNotification(), null);
  assert.equal(tracked.delivery.session_id, "external-session-two");
});

test("Recommendation uses the canonical harness-deps owner and skips open dependencies", async () => {
  const { control } = await setupControl({
    issues: [
      issue(1, "Open prerequisite"),
      issue(2, "Blocked dependent", { body: "```harness-deps\n#1\n```", labels: [{ name: "p0" }] }),
      issue(3, "Ready"),
    ],
  });
  const result = await control.recommendIssue("x");
  assert.equal(result.recommendation.issue.number, 1);
});

test("Recommendation accepts a canonical dependency only after GitHub proves it closed", async () => {
  const { control, external } = await setupControl({
    issues: [
      issue(2, "Ready dependent", { body: "```harness-deps\n#1\n```", labels: [{ name: "p0" }] }),
      issue(3, "Fallback"),
    ],
    issueStates: { 1: "CLOSED" },
  });
  const result = await control.recommendIssue("x");
  assert.equal(result.recommendation.issue.number, 2);
  assert.equal(external.calls.some((call) => call[0] === "gh" && call[1] === "issue" && call[2] === "view" && call[3] === "1"), true);
});

test("Given an exact recommendation, start binds one issue, worktree, terminal and real session idempotently", async () => {
  const { control, external } = await setupControl();
  const recommendation = (await control.recommendIssue("Project X")).recommendation;
  await assert.rejects(() => control.startDelivery(recommendation.recommendation_id), /explicit current-turn operator authorization/);
  assert.equal(external.calls.some((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create"), false);
  const first = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const second = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  assert.equal(first.ok, true);
  assert.equal(first.replay, false);
  assert.equal(first.delivery.issue.number, recommendation.issue.number);
  assert.equal(first.delivery.session_id, "session-real");
  assert.equal(first.delivery.worktree.id, "orca-repo::delivery");
  assert.match(first.delivery.terminal.handle, /^term-/);
  assert.equal(second.delivery.delivery_id, first.delivery.delivery_id);
  assert.equal(second.replay, true);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create").length, 1);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "create").length, 1);
  const terminalCreate = external.calls.find((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "create");
  const worktreeCreate = external.calls.find((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create");
  assert.deepEqual(worktreeCreate.slice(worktreeCreate.indexOf("--name"), worktreeCreate.indexOf("--name") + 2), ["--name", `harness-${recommendation.issue.number}`]);
  const command = terminalCreate[terminalCreate.indexOf("--command") + 1];
  assert.match(command, /\.pi\/harness\/pi-harness\.mjs/);
  assert.doesNotMatch(command, /(?:^|\s)pi(?:\s|$)/);
});

test("Start revalidates the recommended issue before reserving a delivery", async () => {
  const { control, external, home } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  external.issues[0].labels = [{ name: "harness:in-progress" }];

  const result = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "issue-not-ready");
  assert.deepEqual(fs.readdirSync(path.join(home, "deliveries")), []);
});

test("Start revalidates dependencies after recommendation and before reservation", async () => {
  const { control, external, home } = await setupControl({
    issues: [issue(2, "Dependent", { body: "```harness-deps\n#1\n```", labels: [{ name: "p0" }] })],
    issueStates: { 1: "CLOSED" },
  });
  const recommendation = (await control.recommendIssue("x")).recommendation;
  assert.equal(recommendation.issue.number, 2);
  external.issueStates[1] = "OPEN";

  const result = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "issue-dependency-not-closed");
  assert.equal(result.dependency, 1);
  assert.deepEqual(fs.readdirSync(path.join(home, "deliveries")), []);
});

test("Start refuses a worktree linked after recommendation without creating another", async () => {
  const { control, external, home } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  external.worktrees.push({ id: "other", repoId: "orca-repo", linkedIssue: { number: 1 }, comment: "someone-else" });

  const result = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "issue-already-in-execution");
  assert.deepEqual(fs.readdirSync(path.join(home, "deliveries")), []);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create").length, 0);
});

test("Lost Orca responses reconcile by unique markers and never duplicate resources", async () => {
  const worktreeLoss = await setupControl({ loseWorktreeResponse: true });
  const rec1 = (await worktreeLoss.control.recommendIssue("x")).recommendation;
  const uncertainWorktree = await worktreeLoss.control.startDelivery(rec1.recommendation_id, AUTHORIZATION);
  assert.equal(uncertainWorktree.reason, "worktree-creation-unresolved");
  const recoveredWorktree = await worktreeLoss.control.startDelivery(rec1.recommendation_id, AUTHORIZATION);
  assert.equal(recoveredWorktree.ok, true);
  assert.equal(worktreeLoss.external.calls.filter((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create").length, 1);

  const terminalLoss = await setupControl({ loseTerminalResponse: true });
  const rec2 = (await terminalLoss.control.recommendIssue("x")).recommendation;
  const uncertainTerminal = await terminalLoss.control.startDelivery(rec2.recommendation_id, AUTHORIZATION);
  assert.equal(uncertainTerminal.reason, "terminal-creation-unresolved");
  const recoveredTerminal = await terminalLoss.control.startDelivery(rec2.recommendation_id, AUTHORIZATION);
  assert.equal(recoveredTerminal.ok, true);
  assert.equal(terminalLoss.external.calls.filter((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "create").length, 1);
});

test("Delivery replay repairs a recommendation receipt lost after reservation", async () => {
  const { control, external } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const file = path.join(control.home, "recommendations", `${recommendation.recommendation_id}.json`);
  const torn = control.recommendation(recommendation.recommendation_id);
  torn.state = "recommended";
  delete torn.delivery_id;
  delete torn.consumed_at;
  fs.writeFileSync(file, `${JSON.stringify(torn, null, 2)}\n`, "utf8");

  const replay = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const repaired = control.recommendation(recommendation.recommendation_id);
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.delivery.delivery_id, started.delivery.delivery_id);
  assert.equal(repaired.state, "consumed");
  assert.equal(repaired.delivery_id, started.delivery.delivery_id);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create").length, 1);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "create").length, 1);
});

test("An interrupted delivery is reported and resumes the exact session without another delivery or worktree", async () => {
  const { control, external, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const dir = control.deliveryDir(started.delivery.delivery_id);
  await appendBridgeEvent(dir, { cwd: worktree, sessionId: "session-real", type: "session.stopped", eventId: "stopped-g1", payload: { completion: "not-implied" } });
  assert.equal(control.portfolio("x").deliveries[0].state, "interrupted");
  external.previousExited = true;
  const resumed = await control.resumeDelivery({ delivery_id: started.delivery.delivery_id, authorization: "explicit-current-turn" });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.delivery.session_id, "session-real");
  assert.equal(resumed.delivery.generation, 2);
  assert.equal(readBridge(dir).generation, 2);
  await assert.rejects(() => appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", generation: 1,
    type: "session.stopped", eventId: "late-old-generation", payload: { completion: "not-implied" },
  }), /generation mismatch/);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create").length, 1);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "create").length, 2);
  const lastCreate = external.calls.filter((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "create").at(-1);
  assert.match(lastCreate[lastCreate.indexOf("--command") + 1], /--harness-resume/);
  assert.match(lastCreate[lastCreate.indexOf("--command") + 1], /session-real/);
});

test("Resume reconciles a bridge generation committed before the delivery record", async () => {
  const { control, external, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const deliveryId = started.delivery.delivery_id;
  const dir = control.deliveryDir(deliveryId);
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "session.stopped", eventId: "stopped-before-resume-crash",
    payload: { completion: "not-implied" },
  });
  external.previousExited = true;
  await prepareBridgeResume(dir, { sessionId: "session-real", nextGeneration: 2 });
  assert.equal(control.readDelivery(deliveryId).generation, 1);
  assert.equal(readBridge(dir).generation, 2);

  const recovered = await control.resumeDelivery({ delivery_id: deliveryId, authorization: AUTHORIZATION });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.delivery.generation, 2);
  assert.equal(recovered.delivery.session_id, "session-real");
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "create").length, 2);
});

test("Repeated resume reconciles a lost Orca terminal response without another parent", async () => {
  const { control, external, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const deliveryId = started.delivery.delivery_id;
  await appendBridgeEvent(control.deliveryDir(deliveryId), {
    cwd: worktree, sessionId: "session-real", type: "session.stopped", eventId: "stopped-before-lost-resume-terminal",
    payload: { completion: "not-implied" },
  });
  external.previousExited = true;
  external.loseTerminalResponse = true;

  const uncertain = await control.resumeDelivery({ delivery_id: deliveryId, authorization: AUTHORIZATION });
  assert.equal(uncertain.ok, false);
  assert.equal(uncertain.reason, "terminal-creation-unresolved");
  assert.equal(control.readDelivery(deliveryId).resume_pending, true);

  const recovered = await control.resumeDelivery({ delivery_id: deliveryId, authorization: AUTHORIZATION });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.delivery.generation, 2);
  assert.equal(recovered.delivery.session_id, "session-real");
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create").length, 1);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "create").length, 2);
});

test("Exact-session resume preserves a pending decision response and rings the new terminal", async () => {
  const { control, external, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const deliveryId = started.delivery.delivery_id;
  const dir = control.deliveryDir(deliveryId);
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "decision.opened", eventId: "decision-resume-r1",
    payload: { decision_id: "resume-choice", revision: 1, summary: "Choose", options: ["A", "B"] },
  });
  const answer = await control.answerDecision({
    delivery_id: deliveryId, decision_id: "resume-choice", revision: 1,
    answer: "A", authorization: "explicit-current-turn",
  });
  assert.equal(answer.state, "sent");
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "session.stopped", eventId: "stopped-with-pending-answer",
    payload: { completion: "not-implied" },
  });
  external.previousExited = true;

  const resumed = await control.resumeDelivery({ delivery_id: deliveryId, authorization: "explicit-current-turn" });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.inbox_wakeup, "sent");
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "terminal" && call[2] === "send").length, 2);
  const messages = await consumeInbox(dir, { cwd: worktree, sessionId: "session-real", generation: 2 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].decision_id, "resume-choice");
  await markDecisionApplied(dir, {
    cwd: worktree, sessionId: "session-real", generation: 2,
    messageId: answer.message_id, decisionId: "resume-choice", revision: 1, evidence: "gate-state:resume-choice",
  });
  assert.equal(control.portfolio("x").deliveries[0].decisions[0].state, "applied");
});

test("Silent supervision reports a terminal exit as interruption without inferring child completion", async () => {
  const { control, external } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const lastSequence = listBridgeEvents(control.deliveryDir(started.delivery.delivery_id)).at(-1).sequence;
  external.previousExited = true;
  const observed = await control.waitForChange({
    delivery_id: started.delivery.delivery_id, after_sequence: lastSequence, timeout_ms: 100,
  });
  assert.equal(observed.outcome, "terminal-exited");
  assert.equal(observed.delivery.state, "interrupted");
  assert.match(observed.consequence, /child completion is unknown/);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create").length, 1);
});

test("Silent supervision keeps watching events after an early terminal timeout", async () => {
  const { control, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const dir = control.deliveryDir(started.delivery.delivery_id);
  const lastSequence = listBridgeEvents(dir).at(-1).sequence;
  let emitted = false;
  control.sleep = async () => {
    if (emitted) return;
    emitted = true;
    await appendBridgeEvent(dir, {
      cwd: worktree, sessionId: "session-real", type: "delivery.milestone",
      eventId: "milestone-after-terminal-timeout", payload: { detail: "still running" },
    });
  };

  const observed = await control.waitForChange({
    delivery_id: started.delivery.delivery_id, after_sequence: lastSequence, timeout_ms: 100,
  });
  assert.equal(observed.outcome, "changed");
  assert.equal(observed.event.event_id, "milestone-after-terminal-timeout");
});

test("Silent host supervision wakes once for a material event and restores its durable cursor", async () => {
  const { control, home, external, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  assert.equal(await control.nextNotification(), null);
  await appendBridgeEvent(control.deliveryDir(started.delivery.delivery_id), {
    cwd: worktree, sessionId: "session-real", type: "decision.opened", eventId: "notify-decision-r1",
    payload: { decision_id: "notify-decision", revision: 1, summary: "Choose", options: ["A", "B"] },
  });

  const notification = await control.nextNotification();
  assert.equal(notification.type, "decision.opened");
  assert.equal(notification.delivery_id, started.delivery.delivery_id);
  await control.acknowledgeNotification(notification);
  const restarted = new ControlPlane({ home, external, sleep: async () => {}, startWaitMs: 1 });
  assert.equal(await restarted.nextNotification(), null);
});

test("Silent host supervision reports an abrupt parent exit once without inferring child completion", async () => {
  const { control, external, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  assert.equal(await control.nextNotification(), null);
  external.previousExited = true;

  const notification = await control.nextNotification();
  assert.equal(notification.type, "session.interrupted");
  assert.equal(control.portfolio("x").deliveries[0].state, "interrupted");
  await control.acknowledgeNotification(notification);
  await appendBridgeEvent(control.deliveryDir(started.delivery.delivery_id), {
    cwd: worktree, sessionId: "session-real", type: "session.stopped", eventId: "late-stop-after-orca-exit",
    payload: { completion: "not-implied" },
  });
  assert.equal(await control.nextNotification(), null);
});

test("Decision answer is bound to exact revision and sent, received and applied remain distinct", async () => {
  const { control, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const deliveryId = started.delivery.delivery_id;
  const dir = control.deliveryDir(deliveryId);
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "decision.opened", eventId: "decision-d1-r1",
    payload: { decision_id: "d1", revision: 1, summary: "Choose format", options: ["A", "B"], recommendation: "A" },
  });
  assert.equal(control.readDelivery(deliveryId).session_id, "session-real");
  assert.equal(control.portfolio("x").deliveries[0].decisions[0].session_id, "session-real");
  const sent = await control.answerDecision({ delivery_id: deliveryId, decision_id: "d1", revision: 1, answer: "A", authorization: "explicit-current-turn" });
  assert.equal(sent.state, "sent", JSON.stringify(sent));
  assert.equal(control.portfolio("x").deliveries[0].decisions[0].state, "sent");
  const messages = await consumeInbox(dir, { cwd: worktree, sessionId: "session-real" });
  assert.equal(messages.length, 1);
  assert.equal(control.portfolio("x").deliveries[0].decisions[0].state, "received");
  await markDecisionApplied(dir, { cwd: worktree, sessionId: "session-real", messageId: sent.message_id, decisionId: "d1", revision: 1, evidence: ".pi/harness/state/gate.json#decision-d1" });
  assert.equal(control.portfolio("x").deliveries[0].decisions[0].state, "applied");

  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "decision.opened", eventId: "decision-d1-r2",
    payload: { decision_id: "d1", revision: 2, summary: "Revised choice", options: ["C", "D"], recommendation: "C" },
  });
  const stale = await control.answerDecision({ delivery_id: deliveryId, decision_id: "d1", revision: 1, answer: "A", authorization: "explicit-current-turn" });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "decision-not-open-at-revision");
  await assert.rejects(() => appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "decision.opened", eventId: "decision-d1-r2-divergent",
    payload: { decision_id: "d1", revision: 2, summary: "Changed without revision", options: ["E", "F"] },
  }), /decision revision must advance exactly/);
});

test("A newly revised decision never receives an answer sent to the prior revision", async () => {
  const { control, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const deliveryId = started.delivery.delivery_id;
  const dir = control.deliveryDir(deliveryId);
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "decision.opened", eventId: "race-decision-r1",
    payload: { decision_id: "race-decision", revision: 1, summary: "Original", options: ["A", "B"] },
  });
  const oldAnswer = await control.answerDecision({
    delivery_id: deliveryId, decision_id: "race-decision", revision: 1,
    answer: "A", authorization: AUTHORIZATION,
  });
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "decision.opened", eventId: "race-decision-r2",
    payload: { decision_id: "race-decision", revision: 2, summary: "Revised", options: ["C", "D"] },
  });

  assert.deepEqual(await consumeInbox(dir, { cwd: worktree, sessionId: "session-real", generation: 1 }), []);
  assert.equal(control.portfolio("x").deliveries[0].decisions[0].revision, 2);
  assert.equal(control.portfolio("x").deliveries[0].decisions[0].state, "open");
  await assert.rejects(() => markDecisionApplied(dir, {
    cwd: worktree, sessionId: "session-real", generation: 1,
    messageId: oldAnswer.message_id, decisionId: "race-decision", revision: 1, evidence: "must-not-apply",
  }));
});

test("Decision traffic cannot mask a failed lifecycle state during reconstruction", async () => {
  const { control, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const dir = control.deliveryDir(started.delivery.delivery_id);
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "delivery.failed", eventId: "failure-before-decision",
    payload: { detail: "parent needs recovery", evidence: "gate-state:failure" },
  });
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "decision.opened", eventId: "failure-decision-r1",
    payload: { decision_id: "failure-decision", revision: 1, summary: "Choose recovery", options: ["resume", "stop"] },
  });

  const projected = control.portfolio("x").deliveries[0];
  assert.equal(projected.state, "failed");
  assert.equal(projected.decisions[0].state, "open");
});

test("Event replay is idempotent, divergent content conflicts, and sensitive fields are refused", async () => {
  const { control, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const dir = control.deliveryDir(started.delivery.delivery_id);
  const event = { cwd: worktree, sessionId: "session-real", type: "delivery.milestone", eventId: "milestone-1", payload: { detail: "tests green" } };
  assert.equal((await appendBridgeEvent(dir, event)).replay, false);
  assert.equal((await appendBridgeEvent(dir, event)).replay, true);
  await assert.rejects(() => appendBridgeEvent(dir, { ...event, payload: { detail: "different" } }), /event id conflict/);
  await assert.rejects(() => appendBridgeEvent(dir, { ...event, eventId: "secret-event", payload: { api_key: "not-allowed" } }), /sensitive field rejected/);
  await assert.rejects(() => appendBridgeEvent(dir, {
    ...event, eventId: "embedded-secret-event",
    payload: { detail: `provider failed with ghp_${"x".repeat(24)}` },
  }), /credential-like text rejected/);
  await assert.rejects(() => appendBridgeEvent(dir, {
    ...event, eventId: "raw-context-event",
    payload: { detail: "bounded summary", context_dump: "raw project context" },
  }), /unknown fields/);
});

test("Bridge event appends refuse a symlink sink before writing outside private state", async () => {
  const { control, worktree, root } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const dir = control.deliveryDir(started.delivery.delivery_id);
  const events = path.join(dir, "events.jsonl");
  const outside = path.join(root, "outside-events.jsonl");
  const original = fs.readFileSync(events, "utf8");
  fs.writeFileSync(outside, original, { mode: 0o600 });
  fs.unlinkSync(events);
  fs.symlinkSync(outside, events);
  await assert.rejects(() => appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "delivery.milestone",
    eventId: "must-not-escape", payload: { detail: "no escape" },
  }));
  assert.equal(fs.readFileSync(outside, "utf8"), original);
});

test("Restart reconstructs delivery and draft PR without merge authority", async () => {
  const { control, home, external, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  await appendBridgeEvent(control.deliveryDir(started.delivery.delivery_id), {
    cwd: worktree, sessionId: "session-real", type: "result.completed", eventId: "completed-before-pr",
    payload: { detail: "final review complete", evidence: ".pi/harness/state/session-real/gate-state.json#final_review_done" },
  });
  await appendBridgeEvent(control.deliveryDir(started.delivery.delivery_id), {
    cwd: worktree, sessionId: "session-real", type: "result.pr-available", eventId: "pr-1",
    payload: { url: "https://github.com/owner/repo/pull/1", draft: true, head_sha: "a".repeat(40), evidence: "gate-state:final" },
  });
  const restarted = new ControlPlane({ home, external, sleep: async () => {}, startWaitMs: 1 });
  assert.equal(restarted.portfolio("x").deliveries[0].state, "result-unverified");
  const restored = (await restarted.verifiedPortfolio("x")).deliveries[0];
  assert.equal(restored.state, "pr-available");
  assert.equal(restored.result.draft, true);
  assert.equal(external.calls.some((call) => call.join(" ").includes("merge")), false);
});

test("A reported PR is not exposed as available until GitHub postconditions match", async () => {
  const { control, external, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const dir = control.deliveryDir(started.delivery.delivery_id);
  const afterSequence = listBridgeEvents(dir).at(-1).sequence;
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "result.pr-available", eventId: "pr-mismatch",
    payload: { url: "https://github.com/owner/repo/pull/2", draft: true, head_sha: "a".repeat(40), evidence: "gate-state:final" },
  });
  const originalGh = external.gh.bind(external);
  external.gh = async (args) => args[0] === "pr"
    ? { url: args[2], isDraft: true, headRefOid: "b".repeat(40), state: "OPEN" }
    : originalGh(args);

  const observed = await control.waitForChange({
    delivery_id: started.delivery.delivery_id, after_sequence: afterSequence, timeout_ms: 100,
  });
  assert.equal(observed.ok, false);
  assert.equal(observed.reason, "pr-postcondition-mismatch");
  assert.equal(observed.event.payload, undefined);
  assert.equal(observed.delivery.state, "result-unverified");
  assert.equal(observed.delivery.result.url, undefined);
});

test("A reported PR must belong to the exact delivery worktree HEAD", async () => {
  const { control, external, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const dir = control.deliveryDir(started.delivery.delivery_id);
  const afterSequence = listBridgeEvents(dir).at(-1).sequence;
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "result.pr-available", eventId: "wrong-worktree-head",
    payload: { url: "https://github.com/owner/repo/pull/8", draft: true, head_sha: "a".repeat(40), evidence: "gate-state:final" },
  });
  external.headSha = "b".repeat(40);
  const ghCallsBefore = external.calls.filter((call) => call[0] === "gh" && call[1] === "pr").length;

  const observed = await control.waitForChange({
    delivery_id: started.delivery.delivery_id, after_sequence: afterSequence, timeout_ms: 100,
  });
  assert.equal(observed.ok, false);
  assert.equal(observed.reason, "pr-worktree-head-mismatch");
  assert.equal(observed.delivery.state, "result-unverified");
  assert.equal(external.calls.filter((call) => call[0] === "gh" && call[1] === "pr").length, ghCallsBefore);
});

test("A reported PR from another project is rejected before any GitHub lookup", async () => {
  const { control, external, worktree } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const dir = control.deliveryDir(started.delivery.delivery_id);
  const afterSequence = listBridgeEvents(dir).at(-1).sequence;
  await appendBridgeEvent(dir, {
    cwd: worktree, sessionId: "session-real", type: "result.pr-available", eventId: "foreign-pr",
    payload: { url: "https://github.com/another/repo/pull/9", draft: true, head_sha: "a".repeat(40), evidence: "gate-state:final" },
  });
  const ghCallsBefore = external.calls.filter((call) => call[0] === "gh" && call[1] === "pr").length;
  const observed = await control.waitForChange({
    delivery_id: started.delivery.delivery_id, after_sequence: afterSequence, timeout_ms: 100,
  });
  assert.equal(observed.ok, false);
  assert.equal(observed.reason, "pr-project-mismatch");
  assert.equal(external.calls.filter((call) => call[0] === "gh" && call[1] === "pr").length, ghCallsBefore);
});

test("Existing cron activation is verified and repeated activation is a no-op without creating a scheduler", async () => {
  const config = path.join(tempDir("control-plane-cron"), "project-x.json");
  const cron = `# */5 * * * * node /opt/harness/core/orca/select-and-dispatch.mjs --config ${config}\n`;
  const { control, external, repo } = await setupControl({ automation: { kind: "crontab-selector", config_path: config }, crontab: cron });
  writeSelectorConfig(config, repo);
  await assert.rejects(() => control.enableAutomation("x"), /explicit current-turn operator authorization/);
  assert.equal(external.calls.filter((call) => call[0] === "crontab-write").length, 0);
  const activated = await control.enableAutomation("x", AUTHORIZATION);
  const repeated = await control.enableAutomation("x", AUTHORIZATION);
  assert.equal(activated.outcome, "activated");
  assert.equal(activated.verified, true);
  assert.equal(repeated.outcome, "already-active");
  assert.equal(external.calls.filter((call) => call[0] === "crontab-write").length, 1);
  assert.equal(external.calls.some((call) => call[0] === "orca" && call[1] === "automations" && call[2] === "create"), false);
});

test("An existing canonical selector is discovered and bound without a registration gate", async () => {
  const config = path.join(tempDir("control-plane-cron-discovery"), "project-x.json");
  const cron = `# */5 * * * * node select-and-dispatch.mjs --config ${config}\n`;
  const { control, external, repo } = await setupControl({ crontab: cron });
  writeSelectorConfig(config, repo);

  const status = await control.automationStatus("x");
  assert.equal(status.ok, true);
  assert.equal(status.discovered, true);
  assert.equal(status.producer.config_path, config);
  const activated = await control.enableAutomation("x", AUTHORIZATION);
  assert.equal(activated.outcome, "activated");
  assert.deepEqual(control.resolveProject("x").project.automation, { kind: "crontab-selector", config_path: config });
  assert.equal(external.calls.filter((call) => call[0] === "crontab-write").length, 1);
});

test("An annotated disabled selector is discovered and activated as one executable cron row", async () => {
  const config = path.join(tempDir("control-plane-cron-annotated"), "project-x.json");
  const cron = `# [ativo Project X 2026-09-22] */10 * * * * /usr/bin/flock -n /tmp/project-x.lock /usr/bin/env ORCA_BIN=/opt/orca/orca-linux.AppImage /usr/bin/node /opt/harness/project-x-select-and-dispatch.mjs --config ${config}\n`;
  const { control, external, repo } = await setupControl({ crontab: cron });
  writeSelectorConfig(config, repo);

  const status = await control.automationStatus("x");
  assert.equal(status.ok, true);
  assert.equal(status.producer.active, false);
  assert.equal(status.producer.config_path, config);
  const activated = await control.enableAutomation("x", AUTHORIZATION);
  assert.equal(activated.outcome, "activated");
  assert.equal(activated.verified, true);
  assert.match(external.crontab, /^\*\/10 \* \* \* \* \/usr\/bin\/flock/m);
  assert.doesNotMatch(external.crontab, /^\s*#\s*\[ativo Project X/m);
  assert.equal(external.crontab.match(/select-and-dispatch\.mjs/g)?.length, 1);
  assert.equal(external.calls.filter((call) => call[0] === "crontab-write").length, 1);
});

test("Automatic selector discovery refuses multiple candidates instead of choosing", async () => {
  const root = tempDir("control-plane-cron-discovery-ambiguous");
  const first = path.join(root, "first.json");
  const second = path.join(root, "second.json");
  const cron = `# */5 * * * * node select-and-dispatch.mjs --config ${first}\n# */7 * * * * node select-and-dispatch.mjs --config ${second}\n`;
  const { control, external, repo } = await setupControl({ crontab: cron });
  writeSelectorConfig(first, repo);
  writeSelectorConfig(second, repo);

  const result = await control.enableAutomation("x", AUTHORIZATION);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "existing-producer-ambiguous");
  assert.equal(control.resolveProject("x").project.automation, null);
  assert.equal(external.calls.filter((call) => call[0] === "crontab-write").length, 0);
});

test("Automatic selector discovery ignores lines that only mention the selector", async () => {
  const config = path.join(tempDir("control-plane-cron-false-positive"), "project-x.json");
  const cron = `# */5 * * * * echo node select-and-dispatch.mjs --config ${config}\n`;
  const { control, external, repo } = await setupControl({ crontab: cron });
  writeSelectorConfig(config, repo);

  const result = await control.enableAutomation("x", AUTHORIZATION);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-existing-automation-found");
  assert.equal(external.calls.filter((call) => call[0] === "crontab-write").length, 0);
});

test("Concurrent producer makes automation activation fail closed", async () => {
  const root = tempDir("control-plane-concurrent-producer");
  const config = path.join(root, "project-x.json");
  const other = path.join(root, "project-x-other.json");
  const cron = `# */5 * * * * node select-and-dispatch.mjs --config ${config}\n*/7 * * * * node select-and-dispatch.mjs --config ${other}\n`;
  const { control, repo } = await setupControl({ automation: { kind: "crontab-selector", config_path: config }, crontab: cron });
  writeSelectorConfig(config, repo);
  writeSelectorConfig(other, repo);
  const result = await control.enableAutomation("x", AUTHORIZATION);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "concurrent-producer-active");
});

test("Crontab activation refuses line drift between inventory and mutation", async () => {
  const config = path.join(tempDir("control-plane-cron-drift"), "project-x.json");
  const cron = `# */5 * * * * node select-and-dispatch.mjs --config ${config}\n`;
  const { control, external, repo } = await setupControl({
    automation: { kind: "crontab-selector", config_path: config }, crontab: cron,
  });
  writeSelectorConfig(config, repo);
  const originalRead = external.crontabRead.bind(external);
  let reads = 0;
  external.crontabRead = async () => {
    const value = await originalRead();
    reads += 1;
    return reads === 2 ? value.replace("*/5", "*/2") : value;
  };

  await assert.rejects(
    () => control.enableAutomation("x", AUTHORIZATION),
    /crontab producer changed before activation/,
  );
  assert.equal(external.calls.filter((call) => call[0] === "crontab-write").length, 0);
});

test("Crontab activation matches the registered config path exactly", async () => {
  const registered = "/srv/project-x.json";
  const prefixCollision = "/srv/project-x.json.backup";
  const cron = `# */5 * * * * node select-and-dispatch.mjs --config ${prefixCollision}\n`;
  const { control, external } = await setupControl({
    automation: { kind: "crontab-selector", config_path: registered }, crontab: cron,
  });
  const result = await control.enableAutomation("x", AUTHORIZATION);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "registered-producer-missing");
  assert.equal(external.calls.filter((call) => call[0] === "crontab-write").length, 0);
});

test("Automation inventory never exposes raw scheduler commands or Orca records", async () => {
  const config = path.join(tempDir("control-plane-cron-redaction"), "project-x.json");
  const cron = `# */5 * * * * API_TOKEN=must-not-leak node select-and-dispatch.mjs --config ${config}\n`;
  const cronControl = await setupControl({ automation: { kind: "crontab-selector", config_path: config }, crontab: cron });
  writeSelectorConfig(config, cronControl.repo);
  assert.doesNotMatch(JSON.stringify(await cronControl.control.automationStatus("x")), /must-not-leak|API_TOKEN/);

  const orcaControl = await setupControl({
    automation: { kind: "orca", id: "existing-producer" },
    automations: [{ id: "existing-producer", runContext: { repoId: "orca-repo" }, enabled: true, credentials: "must-not-leak" }],
  });
  assert.doesNotMatch(JSON.stringify(await orcaControl.control.automationStatus("x")), /must-not-leak|credentials/);
});

test("A registered selector must prove its project identity before activation", async () => {
  const config = path.join(tempDir("control-plane-cron-identity"), "project-x.json");
  const cron = `# */5 * * * * node select-and-dispatch.mjs --config ${config}\n`;
  const { control, external, repo } = await setupControl({
    automation: { kind: "crontab-selector", config_path: config }, crontab: cron,
  });
  writeSelectorConfig(config, repo, { orcaRepoId: "another-repo" });
  const refused = await control.enableAutomation("x", AUTHORIZATION);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "registered-producer-target-mismatch");
  assert.equal(external.calls.filter((call) => call[0] === "crontab-write").length, 0);
});

test("An active Orca review automation for the repo is not mistaken for a delivery producer", async () => {
  const { control, external } = await setupControl({
    automations: [{
      id: "pr-reviewer", name: "Review harness pull requests",
      runContext: { repoId: "orca-repo" }, enabled: true,
    }],
  });
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const result = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  assert.equal(result.ok, true);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create").length, 1);
});

test("A registered Orca producer is bound to the project's real Orca repo identity", async () => {
  const valid = await setupControl({
    automation: { kind: "orca", id: "implementation-producer" },
    automations: [{ id: "implementation-producer", runContext: { repoId: "orca-repo" }, enabled: false }],
  });
  const activated = await valid.control.enableAutomation("x", AUTHORIZATION);
  assert.equal(activated.outcome, "activated");

  const mismatched = await setupControl({
    automation: { kind: "orca", id: "implementation-producer" },
    automations: [{ id: "implementation-producer", runContext: { repoId: "another-repo" }, enabled: false }],
  });
  const refused = await mismatched.control.enableAutomation("x", AUTHORIZATION);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "registered-producer-target-mismatch");
  assert.equal(mismatched.external.calls.some((call) => call[0] === "orca" && call[1] === "automations" && call[2] === "edit"), false);
});

test("A previously failed issue remains bound to its original delivery", async () => {
  const { control, external, worktree } = await setupControl({ issues: [issue(1, "First")] });
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  await appendBridgeEvent(control.deliveryDir(started.delivery.delivery_id), {
    cwd: worktree, sessionId: "session-real", type: "delivery.failed", eventId: "failure-1",
    payload: { detail: "needs operator recovery", evidence: "gate-state:failed" },
  });
  const next = await control.recommendIssue("x");
  assert.equal(next.recommendation, null);
  assert.equal(external.calls.filter((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create").length, 1);
});

test("Incompatible consumer is refused before recommendation or Orca mutation", async () => {
  const root = tempDir("control-plane-incompatible");
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const external = new FakeExternal({ issues: [issue(1, "Never dispatched")], worktreePath: repo });
  external.remote = "git@github.com:owner/broken.git";
  external.orcaRepoPath = repo;
  const control = new ControlPlane({ home, external, sleep: async () => {}, startWaitMs: 1 });
  await control.registerProject({ name: "Broken", repo_path: repo, gh_repo: "owner/broken", orca_repo_id: "orca-repo" });
  const result = await control.recommendIssue("Broken");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "consumer-incompatible");
  assert.equal(external.calls.some((call) => call[0] === "orca" && ["worktree", "terminal"].includes(call[1])), false);
});

test("A consumer that becomes incompatible is refused before delivery reservation", async () => {
  const { control, home, repo, external } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  fs.unlinkSync(path.join(repo, ".pi", "harness", "control-capabilities.json"));

  const result = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "consumer-incompatible");
  assert.match(result.diagnostic, /ENOENT/);
  assert.deepEqual(fs.readdirSync(path.join(home, "deliveries")), []);
  assert.equal(external.calls.some((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create"), false);
});

test("Project-scoped portfolio does not leak another project's delivery", async () => {
  const { control, root, external } = await setupControl();
  const repo2 = makeConsumer(path.join(root, "repo2"));
  external.remotes[repo2] = "git@github.com:owner/repo2.git";
  external.orcaRepoPaths["orca-repo-2"] = repo2;
  await control.registerProject({ name: "Project Y", aliases: ["y"], repo_path: repo2, gh_repo: "owner/repo2", orca_repo_id: "orca-repo-2" });
  const recommendation = (await control.recommendIssue("x")).recommendation;
  await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  assert.equal(control.portfolio("y").deliveries.length, 0);
  assert.equal(control.portfolio("x").deliveries.length, 1);
});

test("Project registration refuses a control home mixed into the consumer", async () => {
  const root = tempDir("control-plane-overlap");
  const repo = makeConsumer(path.join(root, "repo"));
  const home = path.join(repo, ".pi", "harness", "control-home");
  const control = new ControlPlane({ home, external: new FakeExternal(), sleep: async () => {} });
  await assert.rejects(() => control.registerProject({
    name: "Overlapped", repo_path: repo, gh_repo: "owner/repo", orca_repo_id: "orca-repo",
  }), /must not overlap/);
  assert.deepEqual(control.projects(), []);
});

test("Control home refuses broad or permissive existing directories without changing them", () => {
  const root = tempDir("control-plane-home-safety");
  const broad = path.join(root, "broad");
  fs.mkdirSync(broad, { mode: 0o700 });
  fs.writeFileSync(path.join(broad, "unrelated.txt"), "keep\n");
  assert.throws(() => new ControlPlane({ home: broad, external: new FakeExternal() }), /not dedicated/);
  assert.equal(fs.readFileSync(path.join(broad, "unrelated.txt"), "utf8"), "keep\n");

  const permissive = path.join(root, "permissive");
  fs.mkdirSync(permissive, { mode: 0o755 });
  assert.throws(() => new ControlPlane({ home: permissive, external: new FakeExternal() }), /permissions must be 0700/);
  assert.equal(fs.statSync(permissive).mode & 0o777, 0o755);
});

test("Project registration refuses a second identity for the same consumer", async () => {
  const { control, root } = await setupControl();
  const anotherRepo = makeConsumer(path.join(root, "another-repo"));
  for (const project of [
    { name: "Path alias", repo_path: path.join(root, "repo"), gh_repo: "other/path", orca_repo_id: "other-path" },
    { name: "GitHub alias", repo_path: anotherRepo, gh_repo: "OWNER/REPO", orca_repo_id: "other-github" },
    { name: "Orca alias", repo_path: anotherRepo, gh_repo: "other/orca", orca_repo_id: "orca-repo" },
  ]) {
    await assert.rejects(() => control.registerProject(project), /consumer identity is already registered/);
  }
  assert.equal(control.projects().length, 1);
});

test("Project registration proves GitHub and Orca identities before persisting", async () => {
  const root = tempDir("control-plane-project-identity");
  const repo = makeConsumer(path.join(root, "repo"));
  const other = makeConsumer(path.join(root, "other"));
  const home = path.join(root, "home");
  const external = new FakeExternal({
    remote: "https://github.com/wrong/repository.git",
    orcaRepoPath: repo,
    worktreePath: other,
  });
  const control = new ControlPlane({ home, external, sleep: async () => {}, startWaitMs: 1 });
  const project = {
    name: "Project X", aliases: ["x"], repo_path: repo, gh_repo: "owner/repo",
    orca_repo_id: "orca-repo", base_branch: "main", setup: "skip",
  };

  await assert.rejects(() => control.registerProject(project), /github-remote-mismatch/);
  assert.deepEqual(control.projects(), []);

  external.remote = "ssh://git@github.com/owner/repo.git";
  external.orcaRepoPath = other;
  await assert.rejects(() => control.registerProject(project), /orca-repo-path-mismatch/);
  assert.deepEqual(control.projects(), []);

  external.orcaRepoPath = repo;
  const registered = await control.registerProject(project);
  assert.equal(registered.ok, true);
});

test("Project registration discovers GitHub and Orca identity from name and local path", async () => {
  const root = tempDir("control-plane-project-discovery");
  const repo = makeConsumer(path.join(root, "repo"));
  const external = new FakeExternal({
    remote: "https://github.com/Owner/Repository.git",
    orcaRepoPath: repo,
    worktreePath: repo,
  });
  const control = new ControlPlane({ home: path.join(root, "home"), external, sleep: async () => {} });

  const result = await control.registerProject({ name: "Discovered project", repo_path: repo });
  assert.equal(result.ok, true);
  assert.equal(result.project.gh_repo, "Owner/Repository");
  assert.equal(result.project.orca_repo_id, "orca-repo");
  assert.equal(result.project.repo_path, repo);
  assert.equal(external.calls.some((call) => call[0] === "orca" && call[1] === "repo" && call[2] === "show" && call.includes(`path:${repo}`)), true);
});

test("Project discovery uses the Orca inventory without exposing repository metadata", async () => {
  const root = tempDir("control-plane-project-inventory");
  const home = path.join(root, "home");
  const vitalis = makeConsumer(path.join(root, "vitalis-teste"));
  const other = makeConsumer(path.join(root, "other"));
  const external = new FakeExternal({
    repos: [
      {
        id: "orca-vitalis", kind: "git", path: vitalis, displayName: "vitalis-teste",
        gitRemoteIdentity: {
          canonicalKey: "github.com/owner/vitalis-teste",
          remoteUrl: "https://token-must-not-leak@github.com/owner/vitalis-teste.git",
        },
        hookSettings: { scripts: { setup: "secret command" } },
      },
      { id: "orca-other", kind: "git", path: other, displayName: "another-project" },
    ],
  });
  const control = new ControlPlane({ home, external });
  const result = await control.discoverProjects("vitalis-teste");
  assert.equal(result.ok, true);
  assert.equal(result.match, "exact");
  assert.deepEqual(result.candidates, [{
    name: "vitalis-teste",
    repo_path: fs.realpathSync(vitalis),
    orca_repo_id: "orca-vitalis",
    gh_repo: "owner/vitalis-teste",
    registered: false,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /token-must-not-leak|secret command/);
  assert.deepEqual(external.calls, [["orca", "repo", "list"]]);
});

test("Project identity drift is refused before issue lookup, delivery reservation or automation mutation", async () => {
  const { control, external, home } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const issueCalls = external.calls.filter((call) => call[0] === "gh" && call[1] === "issue").length;
  external.remote = "git@github.com:other/repo.git";

  const recommend = await control.recommendIssue("x");
  assert.equal(recommend.ok, false);
  assert.equal(recommend.reason, "github-remote-mismatch");
  assert.equal(external.calls.filter((call) => call[0] === "gh" && call[1] === "issue").length, issueCalls);

  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  assert.equal(started.ok, false);
  assert.equal(started.reason, "github-remote-mismatch");
  assert.deepEqual(fs.readdirSync(path.join(home, "deliveries")), []);
  assert.equal(external.calls.some((call) => call[0] === "orca" && call[1] === "worktree" && call[2] === "create"), false);

  const automation = await control.enableAutomation("x", AUTHORIZATION);
  assert.equal(automation.ok, false);
  assert.equal(automation.reason, "github-remote-mismatch");
  assert.equal(external.calls.some((call) => call[0] === "crontab-write"), false);
});

test("Project registration rejects option-looking or traversal-shaped base branches", async () => {
  const root = tempDir("control-plane-branch-input");
  const home = path.join(root, "home");
  const control = new ControlPlane({ home, external: new FakeExternal(), sleep: async () => {} });
  for (const [index, baseBranch] of ["--upload-pack=evil", "main..evil", "feature/@{1}", "feature.lock"].entries()) {
    const repo = makeConsumer(path.join(root, `repo-${index}`));
    await assert.rejects(() => control.registerProject({
      name: `Unsafe ${index}`, repo_path: repo, gh_repo: `owner/repo-${index}`,
      orca_repo_id: `orca-repo-${index}`, base_branch: baseBranch,
    }), /base_branch is not a safe branch name/);
  }
  assert.deepEqual(control.projects(), []);
});

test("Existing deliveries pin the registered repository identity", async () => {
  const { control, repo } = await setupControl();
  const recommendation = (await control.recommendIssue("x")).recommendation;
  await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  await assert.rejects(() => control.registerProject({
    id: "project-x", name: "Project X", aliases: ["x"], repo_path: repo,
    gh_repo: "owner/other", orca_repo_id: "orca-repo", base_branch: "main", setup: "skip",
  }), /project identity is pinned/);
});

test("A pending recommendation pins the project identity used to create it", async () => {
  const { control, repo } = await setupControl();
  await control.recommendIssue("x");
  await assert.rejects(() => control.registerProject({
    id: "project-x", name: "Project X", aliases: ["x"], repo_path: repo,
    gh_repo: "owner/other", orca_repo_id: "orca-repo", base_branch: "main", setup: "skip",
  }), /project identity is pinned/);
});

test("Disabling the general agent preserves delivery state and refuses control mutations", async () => {
  const { control, home, repo, worktree, external } = await setupControl({ issues: [issue(1, "First"), issue(2, "Second")] });
  const recommendation = (await control.recommendIssue("x")).recommendation;
  const started = await control.startDelivery(recommendation.recommendation_id, AUTHORIZATION);
  const nextRecommendation = (await control.recommendIssue("x")).recommendation;
  assert.equal(nextRecommendation.issue.number, 2);
  await control.setEnabled(false);
  const restarted = new ControlPlane({ home, external, sleep: async () => {}, startWaitMs: 1 });
  assert.equal(restarted.portfolio("x").deliveries[0].delivery_id, started.delivery.delivery_id);
  assert.equal((await restarted.recommendIssue("x")).reason, "control-plane-disabled");
  assert.equal((await restarted.registerProject({
    id: "project-x", name: "Project X", aliases: ["x"], repo_path: repo,
    gh_repo: "owner/repo", orca_repo_id: "orca-repo", base_branch: "main", setup: "skip",
  })).reason, "control-plane-disabled");
  const refused = await restarted.startDelivery(nextRecommendation.recommendation_id, AUTHORIZATION);
  assert.equal(refused.reason, "control-plane-disabled");
  assert.equal((await restarted.enableAutomation("x", AUTHORIZATION)).reason, "control-plane-disabled");
  assert.equal((await restarted.waitForChange({ delivery_id: started.delivery.delivery_id, timeout_ms: 1 })).reason, "control-plane-disabled");
  await appendBridgeEvent(control.deliveryDir(started.delivery.delivery_id), {
    cwd: worktree, sessionId: "session-real", type: "result.pr-available", eventId: "pr-while-disabled",
    payload: { url: "https://github.com/owner/repo/pull/3", draft: true, head_sha: "a".repeat(40), evidence: "gate-state:final" },
  });
  const prCalls = external.calls.filter((call) => call[0] === "gh" && call[1] === "pr").length;
  assert.equal((await restarted.verifiedPortfolio("x")).deliveries[0].state, "result-unverified");
  assert.equal(external.calls.filter((call) => call[0] === "gh" && call[1] === "pr").length, prCalls);
  assert.equal(await restarted.nextNotification(), null);
  assert.equal(fs.existsSync(control.deliveryDir(started.delivery.delivery_id)), true);
  assert.equal((await restarted.consumerCapabilities(repo)).ok, true);
  assert.equal(fs.existsSync(path.join(repo, ".pi", "harness", "pi-harness.mjs")), true);
});
