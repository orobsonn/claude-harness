import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { emitTaskExecuting } from "./descriptor-emitter.mjs";
import { createRun, appendEvent, readEvents } from "../../../../shared/lib/obs-outbox.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Dual-runtime: core/claude-code/skills/orchestrating-delivery/references → 5 up = repo root.
// Legacy flat core/skills/.../references was 4 up.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const EMITTER_CLI_RELATIVE =
  "core/claude-code/skills/orchestrating-delivery/references/descriptor-emitter.mjs";

/**
 * @description Writes a minimal fixture execution-plan.json under plansDir/<featureId>/. The
 * task key is `id` (not `task_id`) to match the real plan shape.
 */
function writeFixturePlan(plansDir, featureId, taskIds) {
  const featureDir = join(plansDir, featureId);
  mkdirSync(featureDir, { recursive: true });
  const plan = {
    version: "1.0",
    feature_id: featureId,
    mode: "light",
    // A descriptor exists only for the spawn-hand path, so the fixture pins the OLLAMA ladder —
    // a plan on the claude ladder dispatches with the Agent tool and emits no descriptor at all.
    model_strategy: { hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" } },
    tasks: taskIds.map((id) => ({ id })),
    final_review: {},
    demo: {},
  };
  writeFileSync(join(featureDir, "execution-plan.json"), JSON.stringify(plan), "utf8");
}

/**
 * @description Creates a fresh temp dir holding an isolated plansDir and stateDir, so each test
 * owns its own fixture tree and never leaks into another test.
 */
function setupTempDirs() {
  const root = mkdtempSync(join(tmpdir(), "de-te-"));
  const plansDir = join(root, "plans");
  const stateDir = join(root, "state");
  mkdirSync(plansDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, plansDir, stateDir };
}

/**
 * @description Arms HARNESS_OBSERVABILITY_RUN_PATH by creating a fresh obs-outbox run in
 * stateDir, and returns the resulting meta path.
 */
function armObs(stateDir) {
  const meta = createRun(
    { issueNumber: 1, project: "test-project", worktreePath: "/tmp/wt" },
    stateDir,
  );
  process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
  return meta;
}

/**
 * @description Restores HARNESS_OBSERVABILITY_RUN_PATH to its pre-test value (or unsets it),
 * preventing env leakage across tests.
 */
function restoreEnv(priorEnv) {
  if (priorEnv === undefined) {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  } else {
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = priorEnv;
  }
}

/** @description #ac-1.1 — n derives from the real 1-based index of taskId in tasks[].id. */
test("#ac-1.1 n derives from real tasks[].id index", (t) => {
  const { plansDir, stateDir } = setupTempDirs();
  const featureId = "feat-index";
  writeFixturePlan(plansDir, featureId, ["task-1", "task-2", "task-3"]);
  const priorEnv = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  const meta = armObs(stateDir);
  t.after(() => restoreEnv(priorEnv));

  emitTaskExecuting({ featureId, taskId: "task-2", plansDir });

  const events = readEvents(meta).filter((e) => e.type === "task-executing");
  assert.equal(events.length, 1);
  assert.equal(events[0].n, 2);
  assert.equal(events[0].total, 3);
});

/** @description #ac-1.1/F3 — a taskId absent from the plan emits nothing (no bogus {n:0}). */
test("#ac-1.1/F3 task not in plan emits nothing", (t) => {
  const { plansDir, stateDir } = setupTempDirs();
  const featureId = "feat-missing-task";
  writeFixturePlan(plansDir, featureId, ["task-1", "task-2", "task-3"]);
  const priorEnv = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  const meta = armObs(stateDir);
  t.after(() => restoreEnv(priorEnv));

  emitTaskExecuting({ featureId, taskId: "task-does-not-exist", plansDir });

  const events = readEvents(meta).filter((e) => e.type === "task-executing");
  assert.equal(events.length, 0);
});

/** @description F4 — repeated calls for the same (type,n) dedupe to a single event. */
test("F4 dedupe by (type,n)", (t) => {
  const { plansDir, stateDir } = setupTempDirs();
  const featureId = "feat-dedupe";
  writeFixturePlan(plansDir, featureId, ["task-1", "task-2", "task-3"]);
  const priorEnv = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  const meta = armObs(stateDir);
  t.after(() => restoreEnv(priorEnv));

  emitTaskExecuting({ featureId, taskId: "task-1", plansDir });
  emitTaskExecuting({ featureId, taskId: "task-1", plansDir });

  const events = readEvents(meta).filter((e) => e.type === "task-executing");
  assert.equal(events.length, 1);
  assert.equal(events[0].n, 1);
  assert.equal(events[0].total, 3);
});

/** @description #ac-1.5 — with HARNESS_OBSERVABILITY_RUN_PATH unset, emission is a no-op. */
test("#ac-1.5 no-op without obs", (t) => {
  const { plansDir, stateDir } = setupTempDirs();
  const featureId = "feat-no-obs";
  writeFixturePlan(plansDir, featureId, ["task-1", "task-2", "task-3"]);
  const priorEnv = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  t.after(() => restoreEnv(priorEnv));

  const calls = [];
  const appendFn = (...args) => {
    calls.push(args);
  };

  emitTaskExecuting({ featureId, taskId: "task-1", plansDir, appendFn });

  assert.equal(calls.length, 0);
  assert.deepEqual(readdirSync(stateDir), []);
});

/**
 * @description #ac-1.4 — fail-open: when the plan is missing, the descriptor-emitter CLI still
 * persists the descriptor and exits 0, swallowing the emission failure AFTER the descriptor write.
 */
/**
 * @description CONTRACT CHANGE (#361, supersedes the prior #ac-1.4 fail-open): the CLI used to
 * write a descriptor and exit 0 when the plan was missing, because the plan was only an
 * observability input. The hand model now resolves FROM the plan, so a missing plan leaves nothing
 * to resolve against — and guessing a model is precisely the failure #361 closes. The obs emission
 * itself still fails open (covered by "#ac-1.5 no-op without obs" and the emitTaskExecuting unit
 * tests); what changed is that dispatch itself now depends on the plan.
 */
test("#361: plan missing → CLI refuses (exit != 0), writes no descriptor, emits no event", (t) => {
  const { root, stateDir } = setupTempDirs();
  const featureId = `no-such-feature-${Date.now()}`;
  const priorEnv = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  const meta = armObs(stateDir);
  t.after(() => restoreEnv(priorEnv));

  const briefFile = join(root, "brief.md");
  writeFileSync(briefFile, "brief contents", "utf8");
  const lockedTestFile = join(root, "locked-test.mjs");
  writeFileSync(lockedTestFile, "// locked test fixture", "utf8");
  const manifestFile = join(root, "manifest.json");
  writeFileSync(manifestFile, JSON.stringify({ frozen_paths: [] }), "utf8");
  const outFile = join(root, "out.json");

  const result = spawnSync(
    "node",
    [
      EMITTER_CLI_RELATIVE,
      "--feature-id", featureId,
      "--task-id", "task-1",
      "--role", "executor",
      "--brief-file", briefFile,
      "--scope-paths", "a.mjs",
      "--locked-test", lockedTestFile,
      "--manifest", manifestFile,
      "--out", outFile,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, HARNESS_OBSERVABILITY_RUN_PATH: meta },
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0, "a dispatch with no resolvable model must not be emitted");
  assert.match(result.stderr, /execution plan/, "the refusal must name what is missing");
  assert.equal(existsSync(outFile), false, "no descriptor may be written");

  const events = readEvents(meta).filter((e) => e.type === "task-executing");
  assert.equal(events.length, 0);
});

/** @description #ac-1.3 — the task-executing event lands strictly between plan-reviewed and final-review-done. */
test("#ac-1.3 execution event fills the gap", (t) => {
  const { plansDir, stateDir } = setupTempDirs();
  const featureId = "feat-gap";
  writeFixturePlan(plansDir, featureId, ["task-1", "task-2", "task-3"]);
  const priorEnv = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  const meta = armObs(stateDir);
  t.after(() => restoreEnv(priorEnv));

  appendEvent(meta, { type: "plan-reviewed", verdict: "APPROVE" });
  emitTaskExecuting({ featureId, taskId: "task-1", plansDir });
  appendEvent(meta, { type: "final-review-done" });

  const events = readEvents(meta);
  const planReviewedIdx = events.findIndex((e) => e.type === "plan-reviewed");
  const taskExecutingIdx = events.findIndex((e) => e.type === "task-executing");
  const finalReviewIdx = events.findIndex((e) => e.type === "final-review-done");

  assert.ok(planReviewedIdx !== -1);
  assert.ok(taskExecutingIdx !== -1);
  assert.ok(finalReviewIdx !== -1);
  assert.ok(taskExecutingIdx > planReviewedIdx);
  assert.ok(taskExecutingIdx < finalReviewIdx);
});

/**
 * @description #ac-1.1 (CLI-level positive wiring) — spawned as a real subprocess against a real
 * `.claude/plans/<feature>/execution-plan.json` fixture, the descriptor-emitter CLI must itself
 * call emitTaskExecuting: it exits 0, persists the --out descriptor, and readEvents(meta) shows
 * exactly one task-executing event with the real 1-based index/total from the plan. This is what
 * makes the #ac-1.4 fail-open test meaningful — without this positive case, that test could pass
 * purely because the CLI never wires emitTaskExecuting at all, not because it fails open.
 */
test("#ac-1.1 CLI wiring: real subprocess emits task-executing from a real plan", (t) => {
  const { root, stateDir } = setupTempDirs();
  const featureId = `zz-de-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const realPlansDir = join(REPO_ROOT, ".claude", "plans");
  const featureDir = join(realPlansDir, featureId);
  const priorEnv = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  const meta = armObs(stateDir);
  t.after(() => {
    restoreEnv(priorEnv);
    rmSync(featureDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  writeFixturePlan(realPlansDir, featureId, ["task-1", "task-2"]);

  const briefFile = join(root, "brief.md");
  writeFileSync(briefFile, "brief contents", "utf8");
  const lockedTestFile = join(root, "locked-test.mjs");
  writeFileSync(lockedTestFile, "// locked test fixture", "utf8");
  const manifestFile = join(root, "manifest.json");
  writeFileSync(manifestFile, JSON.stringify({ frozen_paths: [] }), "utf8");
  const outFile = join(root, "out.json");

  const result = spawnSync(
    "node",
    [
      EMITTER_CLI_RELATIVE,
      "--feature-id", featureId,
      "--task-id", "task-2",
      "--role", "executor",
      "--brief-file", briefFile,
      "--scope-paths", "a.mjs",
      "--locked-test", lockedTestFile,
      "--manifest", manifestFile,
      "--out", outFile,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, HARNESS_OBSERVABILITY_RUN_PATH: meta },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.equal(existsSync(outFile), true);
  JSON.parse(readFileSync(outFile, "utf8"));

  const events = readEvents(meta).filter((e) => e.type === "task-executing");
  assert.equal(events.length, 1);
  assert.equal(events[0].n, 2);
  assert.equal(events[0].total, 2);
});
