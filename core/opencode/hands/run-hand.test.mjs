/**
 * @description Locked tests for OC cheap-hand adapter (T7): worktree policy, quarantine,
 * CONFIG_ERROR, preUntracked restore, session-scoped run-record, shared mode-all agents.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OUTCOME,
  spawnAgentName,
  validateSpawnAgent,
  buildOpencodeRunArgs,
  cleanupWorktreeAfterNonDone,
  applyWorktreePolicy,
  captureHandResult,
  buildHandRunRecord,
  writeHandRecord,
  loadAndValidateSpawnAgent,
  runHand,
  VACUOUS_GREEN_EXIT,
  isExecutorHandRole,
  defaultHasFidelityPass,
} from "./run-hand.mjs";
import { mergeGateState } from "../lib/gate-state.mjs";
import { semanticPlanHash } from "../lib/planner-artifact.mjs";

function seedBoundTask(root, sessionId, featureId, taskId, scopePaths = ["src/"]) {
  const plan = {
    feature_id: featureId,
    kind: "full",
    mode: "full",
    tasks: [{
      id: taskId,
      severity: "medium",
      complexity: "medium",
      scope_paths: scopePaths,
      criterion_refs: ["#ac-1"],
      locked_tests: [{ id: "lt-1", path: "tests/foo.test.mjs", assertion: "Given foo, When run, Then ok" }],
    }],
  };
  const hash = semanticPlanHash(plan);
  const stateDir = join(root, ".opencode", "plans", ".state", sessionId);
  const snapshotRel = `.opencode/plans/.state/${sessionId}/bound-plans/${hash}.json`;
  mkdirSync(join(stateDir, "bound-plans"), { recursive: true });
  writeFileSync(join(root, snapshotRel), JSON.stringify(plan));
  writeFileSync(join(stateDir, "gate-state.json"), JSON.stringify({
    session_id: sessionId,
    feature_id: featureId,
    planner_status: "usable",
    delivery_status: "ready",
    planner_plan_binding: { session_id: sessionId, feature_id: featureId, snapshot_path: snapshotRel, snapshot_hash: hash },
  }));
}

const ALL_HAND_FM = `---
description: "test spawn"
mode: all
model: openai/gpt-5.6-terra
tools:
  task: false
permission:
  edit: allow
---
# body
`;

const SUBAGENT_FM = `---
description: "subagent hand"
mode: subagent
model: openai/gpt-5.6-terra
tools:
  task: false
---
# body
`;

const ALL_WITH_TASK_TRUE = `---
mode: all
model: openai/gpt-5.6-terra
tools:
  task: true
---
# body
`;

// ---- t7-shared-hand-agent ----

test("t7-shared-hand-agent: adapter uses the role itself, accepts mode all, and refuses subagent mode", () => {
  assert.equal(spawnAgentName("executor-high"), "executor-high");
  assert.equal(spawnAgentName("test-author"), "test-author");

  const ok = validateSpawnAgent(ALL_HAND_FM, "executor-high");
  assert.equal(ok.ok, true);
  assert.equal(ok.model, "openai/gpt-5.6-terra");

  const sub = validateSpawnAgent(SUBAGENT_FM, "executor-high");
  assert.equal(sub.ok, false);
  assert.equal(sub.outcome, OUTCOME.CONFIG_ERROR);
  assert.match(sub.reason, /subagent/i);

  const taskTrue = validateSpawnAgent(ALL_WITH_TASK_TRUE, "executor-high");
  assert.equal(taskTrue.ok, false);
  assert.match(taskTrue.reason, /tools\.task/);

  const dir = mkdtempSync(join(tmpdir(), "t7-agents-"));
  try {
    writeFileSync(join(dir, "executor-high.md"), SUBAGENT_FM);
    const refuseSubagent = loadAndValidateSpawnAgent(dir, "executor-high");
    assert.equal(refuseSubagent.ok, false);
    assert.match(refuseSubagent.reason, /subagent/i);

    writeFileSync(join(dir, "executor-high.md"), ALL_HAND_FM);
    const acceptAll = loadAndValidateSpawnAgent(dir, "executor-high");
    assert.equal(acceptAll.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const args = buildOpencodeRunArgs({
    projectDir: "/proj",
    agent: "executor-high",
    model: "ollama-cloud/kimi-k2.7-code",
    title: "hand:feat:task-1",
    prompt: "implement",
  });
  assert.ok(args.includes("--agent"));
  assert.ok(args.includes("executor-high"));
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
    "--model",
    "ollama-cloud/kimi-k2.7-code",
  ]);
  assert.ok(args.includes("--format"));
  assert.ok(args.includes("json"));
  // token never in argv
  assert.ok(!args.some((a) => /token|secret|auth/i.test(a)));
});

// ---- helpers for worktree tests ----

function makeCleanupCtx(over = {}) {
  const deleted = [];
  const written = [];
  const state = {
    untracked: new Set(over.postUntracked ?? ["hand-new.ts", "pre-existing.txt"]),
    files: new Map(over.files ?? [["pre-existing.txt", Buffer.from("original")]]),
    resetOk: over.resetOk !== false,
    resetCalls: [],
  };

  const preUntracked = new Set(over.preUntracked ?? ["pre-existing.txt"]);
  const preUntrackedContents = new Map(
    over.preUntrackedContents ?? [
      ["pre-existing.txt", { hash: "h-original", bytes: Buffer.from("original") }],
    ]
  );

  return {
    state,
    deleted,
    written,
    ctx: {
      freezeCommitSha: "freezeabc",
      preUntracked,
      preUntrackedContents,
      projectRoot: "/proj",
      gitResetHard: (sha) => {
        state.resetCalls.push(sha);
        return state.resetOk
          ? { ok: true }
          : { ok: false, reason: "reset impossible" };
      },
      lsUntracked: () => [...state.untracked],
      removePath: (rel) => {
        deleted.push(rel);
        state.untracked.delete(rel);
        state.files.delete(rel);
        return { ok: true };
      },
      writePath: (rel, bytes) => {
        written.push({ rel, bytes });
        state.untracked.add(rel);
        state.files.set(rel, bytes);
        return { ok: true };
      },
      hashFile: (abs) => {
        // abs may be /proj/pre-existing.txt
        const rel = abs.replace(/^\/proj\//, "").replace(/^\//, "");
        const key = state.files.has(rel)
          ? rel
          : [...state.files.keys()].find((k) => abs.endsWith(k));
        if (!key || !state.files.has(key)) return null;
        const buf = state.files.get(key);
        // simulate hash: use content string
        return buf.toString() === "original" ? "h-original" : `h-${buf.toString()}`;
      },
      isDirtyVsFreeze: () => state.untracked.size > 0 || state.files.size > 0,
    },
  };
}

// ---- t7-failed-reset ----

test("t7-failed-reset: FAILED and NOT_DONE reset worktree and remove hand-created untracked via set-difference", () => {
  for (const outcome of [OUTCOME.FAILED, OUTCOME.NOT_DONE]) {
    const { ctx, deleted, state } = makeCleanupCtx({
      preUntracked: ["pre-existing.txt"],
      postUntracked: ["pre-existing.txt", "hand-created.ts", "also-hand.md"],
      files: [
        ["pre-existing.txt", Buffer.from("original")],
        ["hand-created.ts", Buffer.from("x")],
        ["also-hand.md", Buffer.from("y")],
      ],
    });
    // After "hand", untracked includes hand-created
    state.untracked = new Set(["pre-existing.txt", "hand-created.ts", "also-hand.md"]);

    const policy = applyWorktreePolicy(outcome, ctx);
    assert.equal(policy.kept, false, outcome);
    assert.equal(policy.cleaned, true, outcome);
    assert.equal(policy.hand_quarantine, false, outcome);
    assert.deepEqual(state.resetCalls, ["freezeabc"]);
    assert.ok(deleted.includes("hand-created.ts"), `${outcome} deletes hand-created`);
    assert.ok(deleted.includes("also-hand.md"), `${outcome} deletes also-hand`);
    assert.ok(!deleted.includes("pre-existing.txt"), `${outcome} keeps pre-existing path`);
  }
});

// ---- t7-pre-untracked ----

test("t7-pre-untracked: preUntrackedContents restored after non-DONE cleanup", () => {
  const { ctx, written, state } = makeCleanupCtx({
    preUntracked: ["pre-existing.txt"],
    preUntrackedContents: [
      ["pre-existing.txt", { hash: "h-original", bytes: Buffer.from("original") }],
    ],
    files: [["pre-existing.txt", Buffer.from("TAMPERED")]],
  });
  state.untracked = new Set(["pre-existing.txt", "hand-new.ts"]);
  state.files.set("hand-new.ts", Buffer.from("new"));

  const cleaned = cleanupWorktreeAfterNonDone(ctx);
  assert.equal(cleaned.ok, true);
  // hand-new deleted
  assert.ok(!state.untracked.has("hand-new.ts"));
  // pre-existing restored
  const restore = written.find((w) => w.rel === "pre-existing.txt");
  assert.ok(restore, "must restore pre-existing.txt");
  assert.equal(restore.bytes.toString(), "original");
});

test("t7-pre-untracked: hand-deleted pre-existing untracked is recreated from snapshot", () => {
  const { ctx, written, state } = makeCleanupCtx({
    preUntracked: ["pre-existing.txt"],
    preUntrackedContents: [
      ["pre-existing.txt", { hash: "h-original", bytes: Buffer.from("original") }],
    ],
    files: [], // hand deleted it
  });
  state.untracked = new Set(["hand-only.ts"]);
  state.files.set("hand-only.ts", Buffer.from("x"));

  const cleaned = cleanupWorktreeAfterNonDone(ctx);
  assert.equal(cleaned.ok, true);
  const restore = written.find((w) => w.rel === "pre-existing.txt");
  assert.ok(restore);
  assert.equal(restore.bytes.toString(), "original");
});

// ---- t7-quarantine ----

test("t7-quarantine: CAPTURE_ERROR quarantines worktree per contract (reset if possible else hand_quarantine flag)", () => {
  // Reset possible → cleaned, no quarantine flag needed after success
  const okCase = makeCleanupCtx({
    postUntracked: ["hand-x.ts"],
    files: [["hand-x.ts", Buffer.from("x")]],
  });
  okCase.state.untracked = new Set(["hand-x.ts"]);
  const p1 = applyWorktreePolicy(OUTCOME.CAPTURE_ERROR, okCase.ctx);
  assert.equal(p1.cleaned, true);
  assert.equal(p1.hand_quarantine, false);
  assert.deepEqual(okCase.state.resetCalls, ["freezeabc"]);

  // Reset impossible → hand_quarantine true
  const bad = makeCleanupCtx({ resetOk: false });
  bad.state.untracked = new Set(["hand-x.ts"]);
  const p2 = applyWorktreePolicy(OUTCOME.CAPTURE_ERROR, bad.ctx);
  assert.equal(p2.hand_quarantine, true);
  assert.equal(p2.cleaned, false);
  assert.match(p2.reason ?? "", /reset/i);
});

// ---- t7-config-error ----

test("t7-config-error: CONFIG_ERROR resets dirty tree vs freeze; never DONE", () => {
  assert.notEqual(OUTCOME.CONFIG_ERROR, OUTCOME.DONE);

  const dirty = makeCleanupCtx();
  dirty.state.untracked = new Set(["pre-existing.txt", "maybe-hand.ts"]);
  dirty.state.files.set("maybe-hand.ts", Buffer.from("z"));
  const p = applyWorktreePolicy(OUTCOME.CONFIG_ERROR, {
    ...dirty.ctx,
    isDirtyVsFreeze: () => true,
  });
  assert.equal(p.kept, false);
  assert.equal(p.cleaned, true);
  assert.deepEqual(dirty.state.resetCalls, ["freezeabc"]);

  // Clean tree: no reset required
  const clean = makeCleanupCtx();
  const pClean = applyWorktreePolicy(OUTCOME.CONFIG_ERROR, {
    ...clean.ctx,
    isDirtyVsFreeze: () => false,
  });
  assert.equal(pClean.cleaned, false);
  assert.deepEqual(clean.state.resetCalls, []);
});

// ---- t7-record ----

test("t7-record: run-record written on disk at session-scoped path by adapter code", () => {
  const root = mkdtempSync(join(tmpdir(), "t7-record-"));
  try {
    const record = buildHandRunRecord({
      featureId: "oc-port-phase-1",
      taskId: "task-1",
      sessionId: "ses_abc123",
      freezeCommitSha: "deadbeef",
      outcome: OUTCOME.FAILED,
      touchedPaths: ["src/a.ts"],
      details: {
        scopeViolations: [],
        frozenViolations: [],
        reasons: ["locked tests exited 1"],
      },
      agent: "executor-medium",
    });
    assert.equal(record.writtenBy, "run-hand-adapter");
    assert.equal(record.featureId, "oc-port-phase-1");
    assert.equal(record.taskId, "task-1");
    assert.equal(record.sessionId, "ses_abc123");
    assert.equal(record.freezeCommitSha, "deadbeef");
    assert.equal(record.outcome, OUTCOME.FAILED);

    const w = writeHandRecord({
      roots: {
        projectRoot: root,
        runtime: "opencode",
        sessionId: "ses_abc123",
        featureId: "oc-port-phase-1",
      },
      taskId: "task-1",
      record,
    });
    assert.equal(w.ok, true);
    assert.ok(
      w.path.endsWith(
        join(
          ".opencode",
          "plans",
          ".state",
          "hand-records",
          "oc-port-phase-1",
          "ses_abc123",
          "task-1.json"
        )
      ),
      `session-scoped path: ${w.path}`
    );
    assert.ok(existsSync(w.path));
    const disk = JSON.parse(readFileSync(w.path, "utf8"));
    assert.equal(disk.writtenBy, "run-hand-adapter");
    assert.equal(disk.outcome, OUTCOME.FAILED);
    assert.equal(disk.sessionId, "ses_abc123");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- capturedVerifiedAt stamp (DONE only) ----

test("buildHandRunRecord: DONE must NOT set capturedVerifiedAt (mark-gate only)", () => {
  const record = buildHandRunRecord({
    featureId: "feat",
    taskId: "task-6",
    sessionId: "ses_1",
    freezeCommitSha: "abc",
    outcome: OUTCOME.DONE,
    agent: "executor-medium",
  });
  assert.equal(record.capturedVerifiedAt, undefined);
  assert.equal("capturedVerifiedAt" in record, false);
});

test("buildHandRunRecord: non-DONE outcomes never stamp capturedVerifiedAt", () => {
  for (const outcome of [
    OUTCOME.FAILED,
    OUTCOME.NOT_DONE,
    OUTCOME.CAPTURE_ERROR,
    OUTCOME.CONFIG_ERROR,
  ]) {
    const record = buildHandRunRecord({
      featureId: "feat",
      taskId: "task-6",
      sessionId: "ses_1",
      freezeCommitSha: "abc",
      outcome,
      agent: "executor-medium",
    });
    assert.equal(
      record.capturedVerifiedAt,
      undefined,
      `outcome ${outcome} must not set capturedVerifiedAt`
    );
    assert.equal("capturedVerifiedAt" in record, false);
  }
});

// ---- captureHandResult integration with pure oracle ----

test("captureHandResult: DONE never from child exit 0 alone; needs independent capture", async () => {
  const git = {
    headSha: () => "freeze1",
    diffNameOnly: () => [],
    lsFilesOthers: () => [],
  };
  // empty tree + exit 0 → NOT_DONE
  const r = captureHandResult({
    dispatch: {
      scope_paths: ["src/"],
      frozen_paths: [],
      allowed_writes: ["src/"],
    },
    child: { exitCode: 0, stdout: "DONE all good", stderr: "" },
    freezeCommitSha: "freeze1",
    testPath: "t.mjs",
    no_tests: true,
    git,
  });
  assert.equal(r.ok, true);
  assert.notEqual(r.outcome, OUTCOME.DONE);
  assert.equal(r.outcome, OUTCOME.NOT_DONE);
});

test("captureHandResult: green scope + no_tests + touched → DONE", () => {
  const git = {
    headSha: () => "freeze1",
    diffNameOnly: () => ["src/a.ts"],
    lsFilesOthers: () => [],
  };
  const r = captureHandResult({
    dispatch: {
      scope_paths: ["src/"],
      frozen_paths: [],
      allowed_writes: ["src/"],
    },
    child: { exitCode: 99, stdout: "whatever", stderr: "" }, // exit ignored
    freezeCommitSha: "freeze1",
    no_tests: true,
    git,
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, OUTCOME.DONE);
});

test("captureHandResult: HEAD diverge → CAPTURE_ERROR", () => {
  const git = {
    headSha: () => "other",
    diffNameOnly: () => [],
    lsFilesOthers: () => [],
  };
  const r = captureHandResult({
    dispatch: { scope_paths: ["src/"], frozen_paths: [], allowed_writes: ["src/"] },
    child: { exitCode: 0 },
    freezeCommitSha: "freeze1",
    no_tests: true,
    git,
  });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, OUTCOME.CAPTURE_ERROR);
  assert.equal(r.criticalException, true);
});

test("captureHandResult: vacuous green forces non-zero locked exit → FAILED", () => {
  const git = {
    headSha: () => "freeze1",
    diffNameOnly: () => ["src/a.ts"],
    lsFilesOthers: () => [],
  };
  const r = captureHandResult({
    dispatch: {
      scope_paths: ["src/"],
      frozen_paths: ["src/a.test.mjs"],
      allowed_writes: ["src/a.ts"],
    },
    child: { exitCode: 0 },
    freezeCommitSha: "freeze1",
    testPath: "src/a.test.mjs",
    no_tests: false,
    git,
    testRunner: () => ({ stdout: "# tests 0\n", stderr: "", exitCode: 0 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, OUTCOME.FAILED);
  assert.equal(r.child.lockedTestExitCode, VACUOUS_GREEN_EXIT);
});

// ---- runHand end-to-end with fakes ----

test("runHand: FAILED path resets and writes a session-scoped record with the shared agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "t7-runhand-"));
  try {
    seedBoundTask(root, "ses_run1", "feat-x", "task-1");
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "executor-medium.md"), ALL_HAND_FM);

    const deleted = [];
    let resetSha = null;
    // Pre-spawn: clean untracked. Post-spawn (after spawn returns): hand-created untracked.
    let phase = "pre";
    const untrackedByPhase = {
      pre: [],
      post: ["outside/evil.ts"],
    };

    const result = await runHand(
      {
        feature_id: "feat-x",
        task_id: "task-1",
        session_id: "ses_run1",
        project_root: root,
        freeze_commit_sha: "freeze99",
        role: "executor-medium",
        no_tests: true,
        scope_paths: ["src/"],
        frozen_paths: [],
        allowed_writes: ["src/"],
        brief: "do work",
      },
      {
        agentsDir,
        checkFidelityPass: () => true,
        spawn: async ({ agent, model }) => {
          assert.equal(agent, "executor-medium");
          assert.equal(model, "openai/gpt-5.6-terra");
          const active = JSON.parse(readFileSync(join(root, ".opencode", "plans", ".state", "ses_run1", "gate-state.json"), "utf8")).active_dispatch;
          assert.equal(active.session_id, "ses_run1");
          assert.equal(active.feature_id, "feat-x");
          assert.equal(active.task_id, "task-1");
          assert.deepEqual(active.scope_paths, ["src"]);
          phase = "post";
          return {
            exitCode: 0,
            stdout: "I am DONE",
            stderr: "",
          };
        },
        git: {
          headSha: () => "freeze99",
          // hand wrote out of scope → FAILED
          diffNameOnly: () => ["outside/evil.ts"],
          lsFilesOthers: () => untrackedByPhase[phase] ?? [],
        },
        lsUntracked: () => untrackedByPhase[phase] ?? [],
        gitResetHard: (sha) => {
          resetSha = sha;
          return { ok: true };
        },
        removePath: (rel) => {
          deleted.push(rel);
          return { ok: true };
        },
        writePath: () => ({ ok: true }),
        isDirtyVsFreeze: () => true,
      }
    );

    assert.equal(result.outcome, OUTCOME.FAILED);
    assert.notEqual(result.outcome, OUTCOME.DONE);
    assert.equal(resetSha, "freeze99");
    assert.ok(deleted.includes("outside/evil.ts"));
    assert.ok(result.recordPath);
    assert.ok(
      result.recordPath.includes(join("hand-records", "feat-x", "ses_run1", "task-1.json"))
    );
    assert.equal(result.record.writtenBy, "run-hand-adapter");
    assert.equal(result.record.agent, "executor-medium");
    // process exit was 0 but outcome is FAILED — exit is not oracle
    assert.equal(result.processExitCode, 0);
    assert.equal(JSON.parse(readFileSync(join(root, ".opencode", "plans", ".state", "ses_run1", "gate-state.json"), "utf8")).active_dispatch, undefined);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHand: CAPTURE_ERROR sets quarantine when reset fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "t7-quar-"));
  try {
    seedBoundTask(root, "ses_q", "feat-q", "task-q");
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "executor-low.md"), ALL_HAND_FM);

    const result = await runHand(
      {
        feature_id: "feat-q",
        task_id: "task-q",
        session_id: "ses_q",
        project_root: root,
        freeze_commit_sha: "freeze1",
        role: "executor-low",
        no_tests: true,
        scope_paths: ["src/"],
        allowed_writes: ["src/"],
        brief: "x",
      },
      {
        agentsDir,
        checkFidelityPass: () => true,
        spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        git: {
          headSha: () => "DIVERGED",
          diffNameOnly: () => [],
          lsFilesOthers: () => [],
        },
        lsUntracked: () => ["partial.ts"],
        gitResetHard: () => ({ ok: false, reason: "reset impossible" }),
        removePath: () => ({ ok: true }),
        writePath: () => ({ ok: true }),
        isDirtyVsFreeze: () => true,
      }
    );

    assert.equal(result.outcome, OUTCOME.CAPTURE_ERROR);
    assert.equal(result.worktree.hand_quarantine, true);
    assert.equal(result.record.hand_quarantine, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHand: cleanup failure is verified and fails closed instead of returning hand outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "t7-cleanup-fail-"));
  try {
    seedBoundTask(root, "ses_cleanup", "feat-cleanup", "task-cleanup");
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "test-author.md"), ALL_HAND_FM);
    const result = await runHand({
      feature_id: "feat-cleanup",
      task_id: "task-cleanup",
      session_id: "ses_cleanup",
      project_root: root,
      freeze_commit_sha: "freeze1",
      role: "test-author",
      no_tests: true,
      brief: "x",
    }, {
      agentsDir,
      spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      finishDispatch: () => ({ ok: false, cleanup_pending: true, reason: "active_dispatch cleanup pending" }),
      lsUntracked: () => [],
      gitResetHard: () => ({ ok: true }),
      removePath: () => ({ ok: true }),
      writePath: () => ({ ok: true }),
      isDirtyVsFreeze: () => false,
    });
    assert.equal(result.outcome, OUTCOME.CONFIG_ERROR);
    assert.match(result.reason, /cleanup pending/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runHand: CONFIG_ERROR when freeze missing; never DONE", async () => {
  const result = await runHand(
    {
      feature_id: "feat-c",
      task_id: "task-c",
      session_id: "ses_c",
      project_root: "/tmp",
      role: "executor-low",
      brief: "x",
    },
    {
      spawn: async () => {
        throw new Error("no");
      },
    }
  );
  assert.equal(result.outcome, OUTCOME.CONFIG_ERROR);
  assert.notEqual(result.outcome, OUTCOME.DONE);
});

test("DONE keeps worktree (no reset)", () => {
  const { ctx, state } = makeCleanupCtx();
  const p = applyWorktreePolicy(OUTCOME.DONE, ctx);
  assert.equal(p.kept, true);
  assert.equal(p.cleaned, false);
  assert.deepEqual(state.resetCalls, []);
});

// ---- fidelity rail (executor blocked until stamp; test-author exempt) ----

test("isExecutorHandRole: executor tiers only; test-author and sniper exempt", () => {
  assert.equal(isExecutorHandRole("executor-low"), true);
  assert.equal(isExecutorHandRole("executor-medium"), true);
  assert.equal(isExecutorHandRole("executor-high"), true);
  assert.equal(isExecutorHandRole("executor-high-spawn"), true);
  assert.equal(isExecutorHandRole("test-author"), false);
  assert.equal(isExecutorHandRole("test-author-spawn"), false);
  assert.equal(isExecutorHandRole("sniper-high"), false);
});

test("runHand: executor without fidelity_pass → CONFIG_ERROR before spawn", async () => {
  let spawned = false;
  const result = await runHand(
    {
      feature_id: "feat-fid",
      task_id: "task-1",
      session_id: "ses_fid",
      project_root: "/tmp",
      freeze_commit_sha: "freeze1",
      role: "executor-medium",
      no_tests: true,
      brief: "x",
    },
    {
      checkFidelityPass: () => false,
      spawn: async () => {
        spawned = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }
  );
  assert.equal(result.outcome, OUTCOME.CONFIG_ERROR);
  assert.match(result.reason, /fidelity-pass missing/i);
  assert.equal(spawned, false, "must not spawn without fidelity-pass");
});

test("runHand: executor with fidelity_pass proceeds past fidelity gate", async () => {
  let spawned = false;
  const root = mkdtempSync(join(tmpdir(), "t7-fid-ok-"));
  try {
    seedBoundTask(root, "ses_fidok", "feat-fid", "task-ok");
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "executor-low.md"), ALL_HAND_FM);

    const result = await runHand(
      {
        feature_id: "feat-fid",
        task_id: "task-ok",
        session_id: "ses_fidok",
        project_root: root,
        freeze_commit_sha: "freeze1",
        role: "executor-low",
        no_tests: true,
        scope_paths: ["src/"],
        allowed_writes: ["src/"],
        brief: "x",
      },
      {
        agentsDir,
        checkFidelityPass: () => true,
        spawn: async () => {
          spawned = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        git: {
          headSha: () => "freeze1",
          diffNameOnly: () => [],
          lsFilesOthers: () => [],
        },
        lsUntracked: () => [],
        gitResetHard: () => ({ ok: true }),
        removePath: () => ({ ok: true }),
        writePath: () => ({ ok: true }),
        isDirtyVsFreeze: () => false,
      }
    );
    assert.equal(spawned, true);
    assert.notEqual(result.outcome, OUTCOME.CONFIG_ERROR);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHand: default vendored agent is authoritative for model and test-author stays fidelity-exempt", async () => {
  let spawned = false;
  const root = mkdtempSync(join(tmpdir(), "t7-fid-ta-"));
  try {
    seedBoundTask(root, "ses_fidta", "feat-fid", "task-ta");
    const agentsDir = join(root, ".opencode", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "test-author.md"), ALL_HAND_FM);

    const result = await runHand(
      {
        feature_id: "feat-fid",
        task_id: "task-ta",
        session_id: "ses_fidta",
        project_root: root,
        freeze_commit_sha: "freeze1",
        role: "test-author",
        model: "attacker/forged-model",
        no_tests: true,
        scope_paths: ["src/"],
        allowed_writes: ["src/"],
        brief: "write locked test",
      },
      {
        checkFidelityPass: () => {
          throw new Error("test-author must not consult fidelity-pass");
        },
        spawn: async ({ agent, model }) => {
          assert.equal(agent, "test-author");
          assert.equal(model, "openai/gpt-5.6-terra");
          spawned = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        git: {
          headSha: () => "freeze1",
          diffNameOnly: () => [],
          lsFilesOthers: () => [],
        },
        lsUntracked: () => [],
        gitResetHard: () => ({ ok: true }),
        removePath: () => ({ ok: true }),
        writePath: () => ({ ok: true }),
        isDirtyVsFreeze: () => false,
      }
    );
    assert.equal(spawned, true);
    assert.notEqual(result.outcome, OUTCOME.CONFIG_ERROR);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultHasFidelityPass: true after a host-authorized fidelity marker reaches disk", () => {
  const root = mkdtempSync(join(tmpdir(), "t7-fid-disk-"));
  const sessionId = "ses_fiddisk";
  try {
    assert.equal(
      defaultHasFidelityPass({
        projectRoot: root,
        sessionId,
        featureId: "feat-d",
        taskId: "task-d",
      }),
      false
    );

    const statePath = join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json");
    const stamped = mergeGateState(statePath, { fidelity_pass: ["feat-d/task-d@abc"] });
    assert.equal(stamped.ok, true, JSON.stringify(stamped));

    assert.equal(
      defaultHasFidelityPass({
        projectRoot: root,
        sessionId,
        featureId: "feat-d",
        taskId: "task-d",
      }),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
