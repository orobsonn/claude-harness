import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executePiCeremonyAction } from "./ceremony-mode.mjs";

const SESSION = "ses-inline-transition";
const FEATURE = "inline-transition";
const MODEL_STRATEGY = {
  hand_tiers: { low: "openai/luna", medium: "openai/terra", high: "openai/terra" },
  planner: "openai/sol",
  "plan-reviewer": "openai/astra",
  compliance: "openai/terra",
  adversary: "openai/sol",
  security: "openai/sol",
  shipper: "openai/luna",
  harvester: "openai/luna",
};

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ceremony-mode-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "pi-test@example.invalid"]);
  git(root, ["config", "user.name", "Pi Test"]);
  write(root, ".gitignore", ".pi/harness/state/\n");
  write(root, "src/a.mjs", "export const a = 1;\n");
  write(root, "src/b.mjs", "export const b = 1;\n");
  write(root, "tests/a.test.mjs", "// frozen a\n");
  write(root, "tests/b.test.mjs", "// frozen b\n");
  const tasks = ["a", "b"].map((name) => ({
    id: `task-${name}`,
    title: `Implement ${name}`,
    description: `Implement ${name}.`,
    depends_on: [],
    severity: "medium",
    complexity: "medium",
    scope_paths: [`src/${name}.mjs`],
    criterion_refs: [`#ac-${name}`],
    locked_tests: [{
      id: `lt-${name}`,
      path: `tests/${name}.test.mjs`,
      assertion: `Given ${name}, When delivered, Then ${name} works`,
    }],
    resolved_judgments: { scope: "fixed" },
    adversarial: { enabled: false, focus: [] },
  }));
  const plan = {
    feature_id: FEATURE,
    mode: "full",
    model_strategy: MODEL_STRATEGY,
    final_review: { compliance: true, adversary: true },
    demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] },
    tasks,
  };
  write(root, `.pi/harness/plans/${FEATURE}/execution-plan.json`, JSON.stringify(plan, null, 2));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  const initialHead = git(root, ["rev-parse", "HEAD"]);
  const state = {
    session_id: SESSION,
    feature_id: FEATURE,
    classified: true,
    mode: "FULL",
    peak_mode: "FULL",
    spec_status: "adversary-reviewed",
    spec_sha256: "a".repeat(64),
    plan_verdict: "APPROVE",
    fidelity_pass: [`${FEATURE}/task-a@fidelity-a`, `${FEATURE}/task-b@fidelity-b`],
    hand_finished: [`${FEATURE}/task-a`, `${FEATURE}/task-b`],
    capture_verified: [`${FEATURE}/task-a@capture-a`, `${FEATURE}/task-b@capture-b`],
    hand_quarantine: [`${FEATURE}/task-z`],
    regate_pending: [`${FEATURE}/task-z`],
    historical_receipts: [{ kind: "existing", id: "receipt-1" }],
    task_adversary_evidence: {
      [`${FEATURE}/task-a`]: { status: "completed", reviewed_head_sha: initialHead },
      [`${FEATURE}/task-b`]: { status: "completed", reviewed_head_sha: initialHead },
    },
    final_review_evidence: { adversary: { status: "completed" }, compliance: { status: "completed" } },
    final_review_done: true,
    demo_done: true,
  };
  write(root, `.pi/harness/state/${SESSION}/gate-state.json`, JSON.stringify(state, null, 2));
  return {
    root,
    statePath: path.join(root, ".pi", "harness", "state", SESSION, "gate-state.json"),
    initialHead,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function readState(f) {
  return JSON.parse(fs.readFileSync(f.statePath, "utf8"));
}

function writeState(f, state) {
  fs.writeFileSync(f.statePath, JSON.stringify(state, null, 2), "utf8");
}

function invoke(f, action, overrides = {}) {
  return executePiCeremonyAction(
    { action },
    {
      projectRoot: f.root,
      sessionId: SESSION,
      isChild: false,
      isHeadless: false,
      hasActiveDispatch: false,
      ...overrides,
    },
  );
}

test("same-session parent can suspend and resume ceremony without losing canonical state", () => {
  const f = fixture();
  try {
    const suspended = invoke(f, "suspend-inline");
    assert.equal(suspended.ok, true, suspended.reason);
    assert.equal(suspended.ceremonyStatus, "suspended-inline");
    const during = readState(f);
    assert.equal(during.ceremony_status, "suspended-inline");
    assert.equal(during.inline_baseline.head_sha, f.initialHead);
    assert.deepEqual(during.inline_baseline.worktree_baseline, { version: 1, entries: [] });

    const resumed = invoke(f, "resume-ceremony");
    assert.deepEqual(resumed, { ok: true, ceremonyStatus: "active", changedPaths: [] });
    const after = readState(f);
    assert.equal(after.ceremony_status, "active");
    assert.equal(after.inline_baseline, undefined);
    assert.equal(after.inline_changed_paths, undefined);
    assert.equal(after.mode, "FULL");
    assert.equal(after.peak_mode, "FULL");
    assert.equal(after.spec_status, "adversary-reviewed");
    assert.equal(after.plan_verdict, "APPROVE");
    assert.deepEqual(after.historical_receipts, [{ kind: "existing", id: "receipt-1" }]);
  } finally {
    f.close();
  }
});

test("child and headless sessions cannot suspend the active ceremony", () => {
  for (const context of [{ isChild: true }, { isHeadless: true }]) {
    const f = fixture();
    try {
      const result = invoke(f, "suspend-inline", context);
      assert.equal(result.ok, false);
      assert.match(result.reason, /parent interactive local session required/);
      assert.equal(readState(f).ceremony_status, undefined);
    } finally {
      f.close();
    }
  }
});

test("a headless parent can only resume a ceremony previously suspended by the local TUI", () => {
  const f = fixture();
  try {
    assert.equal(invoke(f, "suspend-inline").ceremonyStatus, "suspended-inline");
    const resumed = invoke(f, "resume-ceremony", { isHeadless: true });
    assert.deepEqual(resumed, { ok: true, ceremonyStatus: "active", changedPaths: [] });
  } finally {
    f.close();
  }
});

test("suspend fails closed when runtime dispatch context is live or uncertain", () => {
  for (const hasActiveDispatch of [true, undefined]) {
    const f = fixture();
    try {
      const result = invoke(f, "suspend-inline", { hasActiveDispatch });
      assert.equal(result.ok, false);
      assert.match(result.reason, /active dispatch state must be authoritatively empty/);
    } finally {
      f.close();
    }
  }
});

test("suspend refuses any durable dispatch record on disk", () => {
  const f = fixture();
  try {
    write(f.root, `.pi/harness/state/${SESSION}/dispatch-records/opaque.json`, "{}");
    const result = invoke(f, "suspend-inline");
    assert.equal(result.ok, false);
    assert.match(result.reason, /active dispatch record exists/);
  } finally {
    f.close();
  }
});

test("a dirty file that was already dirty at suspension and stayed unchanged is ignored", () => {
  const f = fixture();
  try {
    write(f.root, "notes.local", "already dirty\n");
    assert.equal(invoke(f, "suspend-inline").ok, true);
    const resumed = invoke(f, "resume-ceremony");
    assert.deepEqual(resumed, { ok: true, ceremonyStatus: "active", changedPaths: [] });
  } finally {
    f.close();
  }
});

test("a dirty inline edit is detected even when HEAD does not move", () => {
  const f = fixture();
  try {
    assert.equal(invoke(f, "suspend-inline").ok, true);
    write(f.root, "src/a.mjs", "export const a = 2;\n");
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), f.initialHead);
    const resumed = invoke(f, "resume-ceremony");
    assert.equal(resumed.ok, true, resumed.reason);
    assert.equal(resumed.ceremonyStatus, "reconciling");
    assert.deepEqual(resumed.changedPaths, ["src/a.mjs"]);
    assert.deepEqual(resumed.affectedTasks, ["task-a"]);
  } finally {
    f.close();
  }
});

test("a committed inline edit is detected from the suspension HEAD", () => {
  const f = fixture();
  try {
    assert.equal(invoke(f, "suspend-inline").ok, true);
    write(f.root, "src/b.mjs", "export const b = 2;\n");
    git(f.root, ["add", "src/b.mjs"]);
    git(f.root, ["commit", "-qm", "inline edit"]);
    const resumed = invoke(f, "resume-ceremony");
    assert.equal(resumed.ok, true, resumed.reason);
    assert.equal(resumed.ceremonyStatus, "reconciling");
    assert.deepEqual(resumed.changedPaths, ["src/b.mjs"]);
    assert.deepEqual(resumed.affectedTasks, ["task-b"]);
  } finally {
    f.close();
  }
});

test("production-only changes preserve task proof, add regate, and clear only aggregate completion", () => {
  const f = fixture();
  try {
    assert.equal(invoke(f, "suspend-inline").ok, true);
    write(f.root, "src/a.mjs", "export const a = 3;\n");
    const resumed = invoke(f, "resume-ceremony");
    assert.equal(resumed.ok, true, resumed.reason);
    const state = readState(f);
    assert.equal(state.ceremony_status, "reconciling");
    assert.deepEqual(state.inline_changed_paths, ["src/a.mjs"]);
    assert.deepEqual(state.regate_pending, [`${FEATURE}/task-z`, `${FEATURE}/task-a`]);
    assert.deepEqual(state.fidelity_pass, [`${FEATURE}/task-a@fidelity-a`, `${FEATURE}/task-b@fidelity-b`]);
    assert.deepEqual(state.hand_finished, [`${FEATURE}/task-a`, `${FEATURE}/task-b`]);
    assert.deepEqual(state.capture_verified, [`${FEATURE}/task-a@capture-a`, `${FEATURE}/task-b@capture-b`]);
    assert.deepEqual(state.hand_quarantine, [`${FEATURE}/task-z`]);
    assert.deepEqual(state.historical_receipts, [{ kind: "existing", id: "receipt-1" }]);
    assert.deepEqual(state.task_adversary_evidence, {
      [`${FEATURE}/task-b`]: { status: "completed", reviewed_head_sha: f.initialHead },
    });
    assert.equal(state.final_review_evidence, undefined);
    assert.equal(state.final_review_done, undefined);
    assert.equal(state.demo_done, undefined);
  } finally {
    f.close();
  }
});

test("a known production delta leaves reconciling on first resume and returns active on retry without clearing pending gates", () => {
  const f = fixture();
  try {
    assert.equal(invoke(f, "suspend-inline").ok, true);
    write(f.root, "src/a.mjs", "export const a = 4;\n");
    assert.equal(invoke(f, "resume-ceremony").ceremonyStatus, "reconciling");

    const active = invoke(f, "resume-ceremony");
    assert.equal(active.ok, true, active.reason);
    assert.equal(active.ceremonyStatus, "active");
    const after = readState(f);
    assert.equal(after.inline_reconciliation, undefined);
    assert.equal(after.inline_changed_paths, undefined);
    assert.deepEqual(after.regate_pending, [`${FEATURE}/task-z`, `${FEATURE}/task-a`]);
    assert.deepEqual(after.hand_quarantine, [`${FEATURE}/task-z`]);
  } finally {
    f.close();
  }
});

test("changing one frozen test invalidates only that task fidelity and preserves other receipts", () => {
  const f = fixture();
  try {
    assert.equal(invoke(f, "suspend-inline").ok, true);
    write(f.root, "tests/a.test.mjs", "// changed frozen a\n");
    const resumed = invoke(f, "resume-ceremony");
    assert.equal(resumed.ok, true, resumed.reason);
    const state = readState(f);
    assert.deepEqual(state.fidelity_pass, [`${FEATURE}/task-b@fidelity-b`]);
    assert.deepEqual(state.hand_finished, [`${FEATURE}/task-a`, `${FEATURE}/task-b`]);
    assert.deepEqual(state.capture_verified, [`${FEATURE}/task-a@capture-a`, `${FEATURE}/task-b@capture-b`]);
    assert.deepEqual(state.regate_pending, [`${FEATURE}/task-z`, `${FEATURE}/task-a`]);
    assert.deepEqual(state.inline_reconciliation.test_changed_task_ids, ["task-a"]);
  } finally {
    f.close();
  }
});

test("frozen-test invalidation survives the reconciling-to-active retry for normal gates to resolve", () => {
  const f = fixture();
  try {
    assert.equal(invoke(f, "suspend-inline").ok, true);
    write(f.root, "tests/a.test.mjs", "// changed frozen a again\n");
    assert.equal(invoke(f, "resume-ceremony").ceremonyStatus, "reconciling");
    assert.equal(invoke(f, "resume-ceremony").ceremonyStatus, "active");
    const active = readState(f);
    assert.deepEqual(active.fidelity_pass, [`${FEATURE}/task-b@fidelity-b`]);
    assert.deepEqual(active.regate_pending, [`${FEATURE}/task-z`, `${FEATURE}/task-a`]);
  } finally {
    f.close();
  }
});

test("unknown ownership remains reconciling and explicitly requests planner reconciliation", () => {
  const f = fixture();
  try {
    assert.equal(invoke(f, "suspend-inline").ok, true);
    write(f.root, "unplanned/new.mjs", "export const surprise = true;\n");
    const resumed = invoke(f, "resume-ceremony");
    assert.equal(resumed.ok, true, resumed.reason);
    assert.equal(resumed.ceremonyStatus, "reconciling");
    assert.deepEqual(resumed.unknownPaths, ["unplanned/new.mjs"]);
    assert.match(resumed.reason, /planner must reconcile unknown path ownership/);
    assert.deepEqual(readState(f).inline_reconciliation.unknown_paths, ["unplanned/new.mjs"]);
  } finally {
    f.close();
  }
});

test("a planner can assign an unknown path and the newly discovered owner is armed exactly once", () => {
  const f = fixture();
  try {
    const seed = readState(f);
    seed.regate_passed = [`${FEATURE}/task-b@${f.initialHead}`];
    writeState(f, seed);
    assert.equal(invoke(f, "suspend-inline").ok, true);
    write(f.root, "unplanned/new.mjs", "export const surprise = 2;\n");
    assert.deepEqual(invoke(f, "resume-ceremony").unknownPaths, ["unplanned/new.mjs"]);

    const planPath = path.join(f.root, ".pi", "harness", "plans", FEATURE, "execution-plan.json");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    plan.tasks[1].scope_paths.push("unplanned/new.mjs");
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
    const assigned = invoke(f, "resume-ceremony");
    assert.equal(assigned.ceremonyStatus, "active");
    assert.deepEqual(assigned.unknownPaths, []);
    assert.deepEqual(assigned.affectedTasks, ["task-b"]);
    assert.deepEqual(readState(f).regate_passed, [], "the stale pre-inline regate is invalidated once");

    assert.deepEqual(readState(f).regate_pending, [`${FEATURE}/task-z`, `${FEATURE}/task-b`]);
  } finally {
    f.close();
  }
});
