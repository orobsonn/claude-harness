/**
 * @description Test fixture for parallel task lanes: a real git parent repo with an approved
 * parallel plan, a classified parent session and host plan-review evidence recorded through the
 * real hook. Never used at runtime.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { handle as recordPlanReview } from "../../task-plan-review.mjs";

export const PARENT_SESSION = "11111111-1111-4111-8111-111111111111";
export const FEATURE = "demo-feature";

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function planTask(id, scope, extra = {}) {
  return {
    id,
    spec: `implement ${id}`,
    severity: "low",
    complexity: "low",
    scope_paths: scope,
    resolved_judgments: { k: "v" },
    criterion_refs: ["#ac-1.1"],
    locked_tests: [{ test_path: `test/${id}.test.mjs`, assertion: `Given ${id} When run Then ok` }],
    adversarial: { enabled: false },
    depends_on: [],
    ...extra,
  };
}

export function defaultTasks() {
  return [
    planTask("task-a", ["src/a"], { title: "Implementar módulo A" }),
    planTask("task-b", ["src/b"], { title: "Implementar módulo B" }),
    planTask("task-c", ["src/c"], { title: "Usar A em C", depends_on: ["task-a"] }),
  ];
}

export function parallelPlan(tasks = defaultTasks(), mode = "full") {
  return {
    version: "1.0",
    feature_id: FEATURE,
    created_at: "2026-10-11T00:00:00Z",
    mode,
    execution: { parallel: true },
    model_strategy: {
      hand_tiers: { low: "haiku", medium: "sonnet", high: "sonnet" },
      planner: "opus",
      "plan-reviewer": "opus",
      compliance: "sonnet",
      adversary: "opus",
      security: "opus",
      shipper: "sonnet",
      harvester: "sonnet",
    },
    tasks,
    final_review: { compliance: true, adversary: true },
    demo: { type: "markdown", scenarios_from_refs: ["#uj-1"] },
  };
}

/** Records plan-review evidence through the real hook (Pre + Post with a canonical report). */
export function approvePlan(root, { sessionId = PARENT_SESSION, toolUseId = "toolu_plan_review", verdict = "APPROVE" } = {}) {
  const base = {
    session_id: sessionId, cwd: root, tool_name: "Agent", tool_use_id: toolUseId,
    tool_input: { subagent_type: "plan-reviewer", prompt: "review", model: "opus" },
  };
  recordPlanReview({ ...base, hook_event_name: "PreToolUse" }, { root });
  return recordPlanReview({
    ...base,
    hook_event_name: "PostToolUse",
    tool_response: {
      status: "completed", agentId: "a0plan", agentType: "plan-reviewer",
      content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify({ verdict, findings: [] })}\n\`\`\`` }],
    },
  }, { root });
}

/**
 * A parent repo with `.claude/` committed (hooks are vendored there in real consumers; tests
 * symlink nothing — lanes in tests use the core hooks directly).
 */
export function createTaskProject(t, { tasks = defaultTasks(), mode = "full", triageMode = "FULL", approve = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-task-parent-")));
  t.after(() => {
    try { git(root, "worktree", "prune"); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  fs.writeFileSync(path.join(root, ".gitignore"), ".claude/plans/\nnode_modules/\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "README.md"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "switch", "-qc", `feat/${FEATURE}`);
  const featureDir = path.join(root, ".claude/plans", FEATURE);
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "execution-plan.json"), `${JSON.stringify(parallelPlan(tasks, mode), null, 2)}\n`);
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\n#ac-1.1 works\n");
  const stateDir = path.join(root, ".claude/plans/.state", PARENT_SESSION);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "triage.json"), JSON.stringify({ session_id: PARENT_SESSION, mode: triageMode, feature_id: FEATURE }));
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ feature_id: FEATURE }));
  if (approve) approvePlan(root);
  return { root, sessionId: PARENT_SESSION, featureId: FEATURE, plan: parallelPlan(tasks, mode) };
}

/**
 * Reserve a lane exactly as the coordinator does (worktree + branch at HEAD, plan/spec copies and
 * the immutable grant), without launching anything. Returns the grant and its path.
 */
export function reserveLane(project, taskId, { attemptId = "22222222-2222-4222-8222-222222222222", dependencies = [] } = {}) {
  const { root, sessionId, featureId } = project;
  const base = git(root, "rev-parse", "HEAD");
  const worktree = path.join(root, ".claude/plans/.state", sessionId, "task-runs/worktrees", `lane-${taskId}`);
  const branch = `harness/task-${taskId}-${attemptId}`;
  git(root, "worktree", "add", "-q", "-b", branch, worktree, base);
  const realWorktree = fs.realpathSync(worktree);
  const featureDir = path.join(realWorktree, ".claude/plans", featureId);
  fs.mkdirSync(featureDir, { recursive: true });
  for (const name of ["execution-plan.json", "spec.md"]) {
    fs.copyFileSync(path.join(root, ".claude/plans", featureId, name), path.join(featureDir, name));
  }
  const plan = JSON.parse(fs.readFileSync(path.join(featureDir, "execution-plan.json"), "utf8"));
  const sha = (file) => execFileSync("sha256sum", [file], { encoding: "utf8" }).split(" ")[0];
  const evidence = JSON.parse(fs.readFileSync(path.join(root, ".claude/plans/.state", sessionId, "plan-review-evidence.json"), "utf8"));
  const grant = {
    version: 1,
    kind: "task-run",
    parent_session_id: sessionId,
    parent_root: root,
    attempt_id: attemptId,
    feature_id: featureId,
    task_id: taskId,
    cwd: realWorktree,
    branch,
    base_sha: base,
    mode: plan.mode.toUpperCase(),
    plan_sha256: sha(path.join(featureDir, "execution-plan.json")),
    spec_sha256: sha(path.join(featureDir, "spec.md")),
    origin: { kind: "parent-approved-plan", plan_review_call_id: evidence.dispatch_call_id },
    dependencies,
  };
  const grantPath = path.join(realWorktree, ".claude/plans/.state/task-admission", `${attemptId}.json`);
  fs.mkdirSync(path.dirname(grantPath), { recursive: true });
  fs.writeFileSync(grantPath, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });
  return { worktree: realWorktree, grant, grantPath, branch, base };
}
