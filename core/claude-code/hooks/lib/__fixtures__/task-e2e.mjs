/**
 * @description End-to-end fixture for parallel task lanes: a consumer repo with the harness REALLY
 * vendored by vendor-core (committed `.claude/`), an approved parallel plan, a `claude` executable
 * that runs fake-claude.mjs with a scripted scenario, and lane-step builders that walk the real
 * pipeline (test-author → RED → fidelity → freeze → fidelity-pass → executor → commit → capture →
 * eyes). Everything below the CLI is production code: tasks.mjs, coordinator, worker, launcher,
 * hooks and inspection. Never used at runtime.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FEATURE, PARENT_SESSION, approvePlan, git, parallelPlan } from "./task-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../../../..");
const VENDOR_CORE = path.join(REPO_ROOT, "core/claude-code/skills/initializing-projects/references/vendor-core.mjs");
const FAKE_CLAUDE = path.join(HERE, "fake-claude.mjs");

export const marker = (taskId) => `[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]`;

/** Consumer project with the vendored harness committed and a classified, plan-approved parent. */
export function createVendoredTaskProject(t, { tasks, mode = "full", triageMode = "FULL" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-task-e2e-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "e2e@example.com");
  git(root, "config", "user.name", "e2e");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "consumer", type: "module", private: true }));
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  const vendored = spawnSync(process.execPath, [VENDOR_CORE, "--source", REPO_ROOT, "--target", root, "--runtime", "claude"], { encoding: "utf8" });
  if (vendored.status !== 0) throw new Error(`vendor failed: ${vendored.stderr}${vendored.stdout}`);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "chore: vendor claude harness");
  git(root, "switch", "-qc", `feat/${FEATURE}`);
  const plan = parallelPlan(tasks, mode);
  const featureDir = path.join(root, ".claude/plans", FEATURE);
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "execution-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  fs.writeFileSync(path.join(featureDir, "spec.md"), "# Spec\n\n#ac-1.1 works\n");
  const stateDir = path.join(root, ".claude/plans/.state", PARENT_SESSION);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "triage.json"), JSON.stringify({ session_id: PARENT_SESSION, mode: triageMode, feature_id: FEATURE }));
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ feature_id: FEATURE }));
  approvePlan(root);
  return { root, sessionId: PARENT_SESSION, featureId: FEATURE, plan };
}

/** An executable `claude` that runs the fake with `scenario` (keyed by task id). */
export function writeFakeClaude(project, scenario) {
  const dir = path.join(project.root, ".git", "fake-claude");
  fs.mkdirSync(dir, { recursive: true });
  const scenarioFile = path.join(dir, `scenario-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  const bin = path.join(dir, `claude-${path.basename(scenarioFile, ".json")}`);
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} --scenario ${JSON.stringify(scenarioFile)} "$@"\n`, { mode: 0o755 });
  return { bin, scenarioFile };
}

const testSource = (taskId, modulePath, expected) => `import { test } from "node:test";
import assert from "node:assert/strict";
test("${taskId} works", async () => {
  const mod = await import(new URL("../${modulePath}", import.meta.url));
  assert.equal(mod.value(), ${JSON.stringify(expected)});
});
`;

/**
 * Steps of a well-behaved lane: the full pipeline for one task.
 * Options let a scenario break exactly one rule.
 */
export function laneSteps({ task, featureId = FEATURE, mode = "FULL", value = `${task.id}-ok`, routes = { executor: "haiku", compliance: "sonnet" },
  skip = new Set(), extraBefore = [], extraAfter = [], productFiles, diary = `Learned while doing ${task.id}.\n` }) {
  const mark = (action, extra = "") => ({ bash: `node .claude/hooks/mark.mjs ${action} --feature-id ${featureId} --task-id ${task.id}${extra}` });
  const testPath = task.locked_tests[0]?.test_path;
  const module = `${task.scope_paths[0]}/index.mjs`;
  const files = productFiles ?? [{ path: module, content: `export const value = () => ${JSON.stringify(value)};\n` }];
  const steps = [...extraBefore];
  if (!task.no_tests) {
    if (!skip.has("author")) steps.push({ agent: { subagent_type: "test-author", model: "sonnet", prompt: `${marker(task.id)}\nTranscribe the locked assertions.`, writes: [{ path: testPath, content: testSource(task.id, module, value) }], report: "Teste escrito." } });
    steps.push({ bash: `node --test ${testPath}` });
    if (!skip.has("fidelity")) steps.push({ agent: { subagent_type: "compliance", model: routes.compliance, prompt: `[HARNESS_TASK_FIDELITY]\n${marker(task.id)}\nCheck fidelity.`, report: "Fidelidade conferida.\n## Veredito: pass" } });
    if (!skip.has("freeze")) steps.push({ bash: `git add ${testPath} && git commit -qm "test(${task.id}): freeze locked tests for ${task.id}"` });
    if (!skip.has("fidelity-pass")) steps.push(mark("fidelity-pass"));
  }
  steps.push(mark("active-scope", ` --role executor --scope-paths ${task.scope_paths.join(",")}`));
  if (!skip.has("executor")) steps.push({ agent: { subagent_type: "executor", model: routes.executor, prompt: `${marker(task.id)}\nImplement.`, writes: files, report: "## Status: DONE\n### Arquivos alterados\n- product" } });
  if (!task.no_tests) steps.push({ bash: `node --test ${testPath}` });
  if (!skip.has("commit")) steps.push({ bash: `git add ${files.map((file) => file.path).join(" ")} && git commit -qm "feat(${task.id}): implement"` });
  if (!skip.has("capture")) steps.push(mark("capture-verified"));
  if (mode === "FULL" && !skip.has("review")) {
    steps.push({ agent: { subagent_type: "compliance", model: routes.compliance, prompt: `${marker(task.id)}\nReview the diff against the ACs.`, report: "Tudo certo.\n## Veredito: pass" } });
  }
  steps.push(...extraAfter);
  if (diary !== null) steps.push({ write: { path: `.claude/plans/${featureId}/run/shared_context.md`, content: diary } });
  steps.push({ text: `Task ${task.id} ready.` });
  return steps;
}

/** Run the VENDORED tasks CLI as the global parent would (identity = session env + cwd). */
export function tasksCli(project, action, params, { claudeBin, env = {}, timeout = 300_000 } = {}) {
  const run = spawnSync(process.execPath, [path.join(project.root, ".claude/hooks/tasks.mjs"), action, ...(params ? ["--json", JSON.stringify(params)] : [])], {
    cwd: project.root,
    encoding: "utf8",
    timeout,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_CODE_SESSION_ID: project.sessionId,
      ...(claudeBin ? { CLAUDE_HARNESS_CLAUDE_BIN: claudeBin } : {}),
      CLAUDE_HARNESS_TASK_WAIT_POLL_MS: "200",
      ...env,
    },
  });
  let output;
  try {
    output = JSON.parse(run.stdout);
  } catch {
    throw new Error(`tasks.mjs ${action} produced no JSON (exit ${run.status}): ${run.stdout}\n${run.stderr}`);
  }
  return output;
}

/** Spawn the CLI asynchronously (for abort/signal tests). */
export function tasksCliChild(project, action, params, env = {}) {
  return spawn(process.execPath, [path.join(project.root, ".claude/hooks/tasks.mjs"), action, ...(params ? ["--json", JSON.stringify(params)] : [])], {
    cwd: project.root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CODE_SESSION_ID: project.sessionId, CLAUDE_HARNESS_TASK_WAIT_POLL_MS: "200", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** wait until no task runs (bounded). */
export function waitSettled(project, claudeBin, attempts = 10) {
  let result;
  for (let index = 0; index < attempts; index += 1) {
    result = tasksCli(project, "wait", { timeout_seconds: 120 }, { claudeBin });
    if (!result.ok) return result;
    if (!result.tasks.some((task) => task.status === "running")) return result;
  }
  return result;
}

/** Async variant of tasksCli, so several projects can run their lanes concurrently. */
export function tasksCliAsync(project, action, params, { claudeBin, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = tasksCliChild(project, action, params, { ...(claudeBin ? { CLAUDE_HARNESS_CLAUDE_BIN: claudeBin } : {}), ...env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`tasks.mjs ${action} produced no JSON (exit ${code}): ${stdout}\n${stderr}`));
      }
    });
  });
}

export async function waitSettledAsync(project, claudeBin, attempts = 10) {
  let result;
  for (let index = 0; index < attempts; index += 1) {
    result = await tasksCliAsync(project, "wait", { timeout_seconds: 120 }, { claudeBin });
    if (!result.ok || !result.tasks.some((task) => task.status === "running")) return result;
  }
  return result;
}

/** Dispatch every scenario task of one project at once and return the settled status. */
export async function runScenarioProject(t, { tasks, mode = "full", lanes, prepare }) {
  const project = createVendoredTaskProject(t, { tasks, mode });
  if (prepare) prepare(project);
  const { bin } = writeFakeClaude(project, { tasks: Object.fromEntries(Object.entries(lanes).map(([id, launches]) => [id, { launches }])) });
  const dispatched = await tasksCliAsync(project, "dispatch", { task_ids: Object.keys(lanes) }, { claudeBin: bin });
  if (!dispatched.ok) throw new Error(dispatched.reason);
  const settled = await waitSettledAsync(project, bin);
  const status = await tasksCliAsync(project, "status", null, { claudeBin: bin });
  return { project, bin, dispatched, settled, status, byId: Object.fromEntries(status.tasks.map((task) => [task.task_id, task])) };
}
