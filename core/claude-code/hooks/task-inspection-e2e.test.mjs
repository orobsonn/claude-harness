/**
 * @description Host inspection matrix, end to end: real vendored harness, real tasks CLI,
 * coordinator, worker, launcher, admission and hooks; only `claude` is the scripted fake. Each lane
 * breaks exactly one rule and the host must derive `blocked` (or `ready`) from native evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { git, planTask } from "./lib/__fixtures__/task-fixture.mjs";
import { createVendoredTaskProject, laneSteps, marker, runScenarioProject, tasksCli, waitSettled, writeFakeClaude } from "./lib/__fixtures__/task-e2e.mjs";

const FEATURE = "demo-feature";
const mark = (taskId, action, extra = "") => ({ bash: `node .claude/hooks/mark.mjs ${action} --feature-id ${FEATURE} --task-id ${taskId}${extra}` });
const tasksABD = () => [
  planTask("task-a", ["src/a"], { title: "Módulo A" }),
  planTask("task-b", ["src/b"], { title: "Módulo B" }),
  planTask("task-d", ["src/d"], { title: "Módulo D" }),
];
const byLabel = (steps, predicate) => steps.findIndex(predicate);

test("inspection matrix: the host derives ready/blocked from native evidence", { timeout: 600_000 }, async (t) => {
  const tasks = tasksABD();
  const [a, b, d] = tasks;

  // P1 — happy FULL · executor before the freeze · test-author after the fidelity.
  const executorBeforeFreeze = (() => {
    const steps = laneSteps({ task: b });
    const freeze = byLabel(steps, (s) => /freeze locked tests/.test(s.bash ?? ""));
    const stamp = byLabel(steps, (s) => /fidelity-pass/.test(s.bash ?? ""));
    const [freezeStep] = steps.splice(freeze, 1);
    // fidelity-pass now lands before the freeze; then the executor runs and only then the freeze commit.
    const executorAt = byLabel(steps, (s) => s.agent?.subagent_type === "executor");
    steps.splice(executorAt + 1, 0, freezeStep);
    assert.ok(stamp >= 0);
    return steps;
  })();
  const authorAfterFidelity = laneSteps({ task: d, extraAfter: [
    { agent: { subagent_type: "test-author", model: "sonnet", prompt: `${marker("task-d")}\nAdd one more assertion.`, writes: [{ path: "test/task-d.test.mjs", content: "import { test } from 'node:test';\ntest('more', () => {});\n" }], report: "ok" } },
    { bash: "git add test/task-d.test.mjs && git commit -qm 'test: more'" },
    mark("task-d", "capture-verified"),
    { agent: { subagent_type: "compliance", model: "sonnet", prompt: `${marker("task-d")}\nReview.`, report: "## Veredito: pass" } },
  ] });

  // P2 — out of scope · dirty worktree · last launch exits non-zero.
  const outOfScope = laneSteps({ task: a, extraAfter: [
    { bash: "mkdir -p src/zzz && echo x > src/zzz/out.mjs && git add src/zzz && git commit -qm 'chore: out of scope'" },
    mark("task-a", "capture-verified"),
    { agent: { subagent_type: "compliance", model: "sonnet", prompt: `${marker("task-a")}\nReview.`, report: "## Veredito: pass" } },
  ] });
  const dirty = laneSteps({ task: b, extraAfter: [{ bash: "echo stray > src/b/stray.txt" }] });

  // P3 — positive review before the executor · stale negative review · negative then fixed (sniper + re-gate).
  const reviewBeforeExecutor = (() => {
    const steps = laneSteps({ task: a, skip: new Set(["review"]) });
    const at = byLabel(steps, (s) => /active-scope/.test(s.bash ?? ""));
    steps.splice(at, 0, { agent: { subagent_type: "compliance", model: "sonnet", prompt: `${marker("task-a")}\nEarly review.`, report: "## Veredito: pass" } });
    return steps;
  })();
  const negativeReview = laneSteps({ task: b, skip: new Set(["review"]), extraAfter: [
    { agent: { subagent_type: "compliance", model: "sonnet", prompt: `${marker("task-b")}\nReview.`, report: "PROBLEMA: [high] wrong value\n## Veredito: fail" } },
  ] });
  const fixedAfterNegative = laneSteps({ task: d, skip: new Set(["review"]), extraAfter: [
    { agent: { subagent_type: "compliance", model: "sonnet", prompt: `${marker("task-d")}\nReview.`, report: "PROBLEMA: [high] edge\n## Veredito: fail" } },
    mark("task-d", "regate-pending"),
    mark("task-d", "active-scope", " --role sniper --scope-paths src/d"),
    { agent: { subagent_type: "sniper-high", model: "sonnet", prompt: `${marker("task-d")}\nFix the edge.`, writes: [{ path: "src/d/index.mjs", content: "export const value = () => \"task-d-ok\"; // edge fixed\n" }], report: "## Status: DONE" } },
    { bash: "git add src/d/index.mjs && git commit -qm 'fix(d): edge'" },
    mark("task-d", "capture-verified"),
    { agent: { subagent_type: "compliance", model: "sonnet", prompt: `${marker("task-d")}\nRe-review.`, report: "## Veredito: pass" } },
    mark("task-d", "regate-passed"),
  ] });

  // P4 — a gate-denied dispatch revokes nothing · a foreign producer marker · a no_tests task.
  const deniedAfter = laneSteps({ task: a, extraAfter: [
    { agent: { subagent_type: "executor", model: "opus", prompt: `${marker("task-a")}\nwrong route`, report: "## Status: DONE" } },
  ] });
  const foreignProducer = (() => {
    const steps = laneSteps({ task: b });
    const at = byLabel(steps, (s) => s.agent?.subagent_type === "executor");
    steps[at] = { agent: { ...steps[at].agent, prompt: `${marker("task-a")}\nImplement.` } };
    return steps;
  })();
  const noTestsTask = planTask("task-d", ["docs/d"], { title: "Docs D", no_tests: true, locked_tests: [] });
  const noTests = laneSteps({ task: noTestsTask, productFiles: [{ path: "docs/d/index.mjs", content: "export const value = () => 1;\n" }] });

  // P5 — a hand that reports DONE without producing any change.
  const doneWithoutChange = laneSteps({ task: a, mode: "LIGHT", productFiles: [], skip: new Set(["commit"]) });

  // P6 — the freeze modifies existing product.
  const freezeTouchesProduct = (() => {
    const steps = laneSteps({ task: a });
    const at = byLabel(steps, (s) => /freeze locked tests/.test(s.bash ?? ""));
    steps[at] = { bash: "echo '// tampered' >> src/a/existing.mjs && git add test/task-a.test.mjs src/a/existing.mjs && git commit -qm 'test(a): freeze locked tests for task-a'" };
    return steps;
  })();

  // P8 — two eyes: only the eye that found the problem re-reviews after the sniper (Pi parity);
  // the other keeps its ancestral positive. Without that re-review the task stays blocked.
  const adv = planTask("task-a", ["src/a"], { title: "Módulo A", adversarial: { enabled: true, focus: ["edge cases"] } });
  const advJson = (issues) => `\`\`\`json\n${JSON.stringify({ issues })}\n\`\`\``;
  const eyesThenFix = (reReview) => laneSteps({ task: adv, skip: new Set(["review"]), extraAfter: [
    { agent: { subagent_type: "compliance", model: "sonnet", prompt: `${marker("task-a")}\nReview.`, report: "## Veredito: pass" } },
    { agent: { subagent_type: "adversary", model: "sonnet", prompt: `${marker("task-a")}\nAttack.`, report: advJson([{ severity: "high", description: "ARMED · edge breaks" }]) } },
    mark("task-a", "regate-pending"),
    mark("task-a", "active-scope", " --role sniper --scope-paths src/a"),
    { agent: { subagent_type: "sniper-high", model: "sonnet", prompt: `${marker("task-a")}\nFix the edge.`, writes: [{ path: "src/a/index.mjs", content: "export const value = () => \"task-a-ok\"; // edge\n" }], report: "## Status: DONE" } },
    { bash: "git add src/a/index.mjs && git commit -qm 'fix(a): edge'" },
    mark("task-a", "capture-verified"),
    ...(reReview ? [{ agent: { subagent_type: "adversary", model: "sonnet", prompt: `${marker("task-a")}\nRe-attack.`, report: advJson([]) } }] : []),
    mark("task-a", "regate-passed"),
  ] });

  // P7 — dispatches that slipped past the lane gate (wrong model, foreign marker, final-review marker).
  const ungated = (agent) => laneSteps({ task: a, extraAfter: [{ agent: { report: "## Veredito: pass", ...agent, ungated: true } }] });
  const wrongRoute = ungated({ subagent_type: "compliance", model: "haiku", prompt: `${marker("task-a")}\nReview.` });
  const foreignMarker = ungated({ subagent_type: "compliance", model: "sonnet", prompt: `${marker("task-b")}\nReview.` });
  const finalReview = ungated({ subagent_type: "compliance", model: "sonnet", prompt: `[HARNESS_FINAL_REVIEW]\n${marker("task-a")}\nReview.` });

  const runs = await Promise.all([
    runScenarioProject(t, { tasks, lanes: { "task-a": [{ steps: laneSteps({ task: a }) }], "task-b": [{ steps: executorBeforeFreeze }], "task-d": [{ steps: authorAfterFidelity }] } }),
    runScenarioProject(t, { tasks, lanes: { "task-a": [{ steps: outOfScope }], "task-b": [{ steps: dirty }], "task-d": [{ steps: laneSteps({ task: d }), exit: 1 }] } }),
    runScenarioProject(t, { tasks, lanes: { "task-a": [{ steps: reviewBeforeExecutor }], "task-b": [{ steps: negativeReview }], "task-d": [{ steps: fixedAfterNegative }] } }),
    runScenarioProject(t, { tasks: [a, b, noTestsTask], lanes: { "task-a": [{ steps: deniedAfter }], "task-b": [{ steps: foreignProducer }], "task-d": [{ steps: noTests }] } }),
    runScenarioProject(t, { tasks: [a, b], mode: "light", lanes: { "task-a": [{ steps: laneSteps({ task: a, mode: "LIGHT" }) }], "task-b": [{ steps: doneWithoutChange.map((step) => JSON.parse(JSON.stringify(step).replaceAll("task-a", "task-b").replaceAll("src/a", "src/b"))) }] } }),
    runScenarioProject(t, { tasks: [a], lanes: { "task-a": [{ steps: freezeTouchesProduct }] }, prepare: (project) => {
      fs.mkdirSync(path.join(project.root, "src/a"), { recursive: true });
      fs.writeFileSync(path.join(project.root, "src/a/existing.mjs"), "export const existing = 1;\n");
      git(project.root, "add", "src/a/existing.mjs");
      git(project.root, "commit", "-qm", "existing product");
    } }),
  ]);
  const p7 = await Promise.all([wrongRoute, foreignMarker, finalReview].map((steps) =>
    runScenarioProject(t, { tasks: [a], lanes: { "task-a": [{ steps }] } })));
  runs.push(...p7);
  const p8 = await Promise.all([true, false].map((reReview) =>
    runScenarioProject(t, { tasks: [adv], lanes: { "task-a": [{ steps: eyesThenFix(reReview) }] } })));
  runs.push(...p8);
  const [p1, p2, p3, p4, p5, p6] = runs;
  const expectStatus = (run, taskId, status, pattern) => {
    const task = run.byId[taskId];
    assert.equal(task.status, status, `${taskId}: ${task.reason} ${JSON.stringify(run.status.diagnostics?.[taskId] ?? {}).slice(0, 600)}`);
    if (pattern) assert.match(task.reason, pattern, taskId);
  };

  expectStatus(p1, "task-a", "ready");
  assert.match(p1.byId["task-a"].context_return.content, /Learned while doing task-a/);
  expectStatus(p1, "task-b", "blocked", /writer ran between the fidelity pass and the freeze|lacks its fidelity-pass marker|must run after the latest fidelity freeze/);
  expectStatus(p1, "task-d", "blocked", /latest test-author work has no subsequent compliance fidelity review/);

  expectStatus(p2, "task-a", "blocked", /outside its canonical scope/);
  expectStatus(p2, "task-b", "blocked", /worktree must be clean/);
  assert.match(p2.status.diagnostics["task-b"].worktree_changes.text, /src\/b\/stray\.txt/);
  expectStatus(p2, "task-d", "blocked", /did not exit successfully/);
  assert.equal(p2.status.diagnostics["task-d"].launch_failure.exit_code, 1);

  expectStatus(p3, "task-a", "blocked", /a current compliance review is required/);
  expectStatus(p3, "task-b", "blocked", /current compliance review is negative/);
  assert.match(p3.status.diagnostics["task-b"].review_findings[0].text, /wrong value/);
  expectStatus(p3, "task-d", "ready");

  expectStatus(p4, "task-a", "ready");
  expectStatus(p4, "task-b", "blocked", /no successful executor or sniper completion/);
  expectStatus(p4, "task-d", "ready");

  expectStatus(p5, "task-a", "ready");
  assert.equal(fs.readFileSync(path.join(p5.byId["task-a"].worktree, "src/a/index.mjs"), "utf8").includes("task-a-ok"), true, "the executor's write really landed");
  expectStatus(p5, "task-b", "blocked", /no committed product change/);
  expectStatus(p6, "task-a", "blocked", /freeze commit may only add the locked tests/);

  for (const run of p7) expectStatus(run, "task-a", "blocked", /ran outside this task's marker or admitted routes/);
  expectStatus(p8[0], "task-a", "ready");
  expectStatus(p8[1], "task-a", "blocked", /the adversary found a problem, so it re-reviews the committed final HEAD/);

  // The parent never moved: inspection is read-only.
  for (const run of runs) assert.equal(git(run.project.root, "status", "--porcelain", "--untracked-files=no"), "");
});

test("a rename from outside the scope is a change outside the scope (no rename detection)", { timeout: 300_000 }, async (t) => {
  const [a] = tasksABD();
  const project = createVendoredTaskProject(t, { tasks: [a] });
  fs.mkdirSync(path.join(project.root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(project.root, "lib/outside.mjs"), "export const shared = 1;\n// owned by another team\n// do not move\n");
  git(project.root, "add", "lib/outside.mjs");
  git(project.root, "commit", "-qm", "chore: shared module");
  const steps = laneSteps({ task: a, skip: new Set(["commit"]) });
  steps.splice(byLabel(steps, (s) => s.bash?.includes("capture-verified")), 0,
    { bash: `git mv lib/outside.mjs src/a/moved.mjs && git add src/a/index.mjs && git commit -qm "feat(task-a): implement"` });
  const { bin } = writeFakeClaude(project, { tasks: { "task-a": { launches: [{ steps }] } } });
  assert.equal(tasksCli(project, "dispatch", { task_ids: ["task-a"] }, { claudeBin: bin }).ok, true);
  waitSettled(project, bin);
  const [task] = tasksCli(project, "status", {}, { claudeBin: bin }).tasks;
  assert.equal(task.status, "blocked", "the deleted source path is outside src/a");
  assert.ok(fs.existsSync(path.join(project.root, "lib/outside.mjs")), "nothing was integrated");
});

test("the host triage is the floor of a lane's mode: a light plan under a FULL triage still needs FULL reviews", { timeout: 300_000 }, async (t) => {
  const [a] = tasksABD();
  const project = createVendoredTaskProject(t, { tasks: [a], mode: "light", triageMode: "FULL" });
  const { bin } = writeFakeClaude(project, { tasks: { "task-a": { launches: [{ steps: laneSteps({ task: a, mode: "LIGHT" }) }] } } });
  const dispatched = tasksCli(project, "dispatch", { task_ids: ["task-a"] }, { claudeBin: bin });
  assert.equal(dispatched.ok, true, dispatched.reason);
  waitSettled(project, bin);
  const registry = JSON.parse(fs.readFileSync(path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json"), "utf8"));
  assert.equal(registry.tasks["task-a"].grant.mode, "FULL");
  const [task] = tasksCli(project, "status", {}, { claudeBin: bin }).tasks;
  assert.equal(task.status, "blocked", "a lane without the FULL eyes is not ready");
});

test("a host without the claude CLI refuses the dispatch before admitting anything (the session can re-plan serially)", { timeout: 120_000 }, async (t) => {
  const [a] = tasksABD();
  const project = createVendoredTaskProject(t, { tasks: [a] });
  const bare = fs.mkdtempSync(path.join(fs.realpathSync(project.lanes), "..", "bare-path-"));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(git, path.join(bare, "git"));
  const dispatched = tasksCli(project, "dispatch", { task_ids: ["task-a"] }, { env: { PATH: bare } });
  assert.equal(dispatched.ok, false);
  assert.match(dispatched.reason, /claude CLI was not found on PATH/);
  const registryFile = path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json");
  const tasks = fs.existsSync(registryFile) ? Object.keys(JSON.parse(fs.readFileSync(registryFile, "utf8")).tasks ?? {}) : [];
  assert.deepEqual(tasks, [], "nothing was admitted, so the parent gate does not pin the session");
});
