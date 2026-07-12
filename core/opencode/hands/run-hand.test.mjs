/**
 * @description Locked tests for OC cheap-hand adapter (T7): worktree policy, quarantine,
 * CONFIG_ERROR, preUntracked restore, session-scoped run-record, mode-primary spawn only.
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
import { stampFidelityPass } from "../plugin/lib/mark-gate.mjs";

const PRIMARY_SPAWN_FM = `---
description: "test spawn"
mode: primary
model: xai/grok-4.5
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
model: xai/grok-4.5
tools:
  task: false
---
# body
`;

const PRIMARY_WITH_TASK_TRUE = `---
mode: primary
model: xai/grok-4.5
tools:
  task: true
---
# body
`;

// ---- t7-spawn-primary ----

test("t7-spawn-primary: adapter only uses agents with mode primary and tools.task false; refuses subagent-mode agent files", () => {
  assert.equal(spawnAgentName("executor-high"), "executor-high-spawn");
  assert.equal(spawnAgentName("executor-high-spawn"), "executor-high-spawn");
  assert.equal(spawnAgentName("test-author"), "test-author-spawn");

  const ok = validateSpawnAgent(PRIMARY_SPAWN_FM, "executor-high-spawn");
  assert.equal(ok.ok, true);

  const sub = validateSpawnAgent(SUBAGENT_FM, "executor-high");
  assert.equal(sub.ok, false);
  assert.equal(sub.outcome, OUTCOME.CONFIG_ERROR);
  assert.match(sub.reason, /subagent/i);

  const taskTrue = validateSpawnAgent(PRIMARY_WITH_TASK_TRUE, "executor-high-spawn");
  assert.equal(taskTrue.ok, false);
  assert.match(taskTrue.reason, /tools\.task/);

  const dir = mkdtempSync(join(tmpdir(), "t7-agents-"));
  try {
    writeFileSync(join(dir, "executor-high.md"), SUBAGENT_FM);
    writeFileSync(join(dir, "executor-high-spawn.md"), PRIMARY_SPAWN_FM);

    const refuseBare = loadAndValidateSpawnAgent(dir, "executor-high");
    assert.equal(refuseBare.ok, false);
    assert.match(refuseBare.reason, /refuse subagent|use executor-high-spawn/i);

    const acceptSpawn = loadAndValidateSpawnAgent(dir, "executor-high-spawn");
    assert.equal(acceptSpawn.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const args = buildOpencodeRunArgs({
    projectDir: "/proj",
    agent: "executor-high-spawn",
    title: "hand:feat:task-1",
    prompt: "implement",
  });
  assert.ok(args.includes("--agent"));
  assert.ok(args.includes("executor-high-spawn"));
  assert.ok(args.includes("--format"));
  assert.ok(args.includes("json"));
  // token never in argv
  assert.ok(!args.some((a) => /token|secret|OLLAMA|AUTH/i.test(a)));
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
      agent: "executor-medium-spawn",
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

test("runHand: FAILED path resets, writes session-scoped record, refuses subagent agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "t7-runhand-"));
  try {
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "executor-medium-spawn.md"), PRIMARY_SPAWN_FM);
    writeFileSync(join(agentsDir, "executor-medium.md"), SUBAGENT_FM);

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
        spawn: async () => {
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
    assert.equal(result.record.agent, "executor-medium-spawn");
    // process exit was 0 but outcome is FAILED — exit is not oracle
    assert.equal(result.processExitCode, 0);

    // Refuse bare subagent
    const refused = await runHand(
      {
        feature_id: "feat-x",
        task_id: "task-2",
        session_id: "ses_run1",
        project_root: root,
        freeze_commit_sha: "freeze99",
        role: "executor-medium",
        agent_file: "executor-medium",
        no_tests: true,
        scope_paths: ["src/"],
        brief: "x",
      },
      {
        agentsDir,
        checkFidelityPass: () => true,
        spawn: async () => {
          throw new Error("must not spawn");
        },
        git: {
          headSha: () => "freeze99",
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
    // loadAndValidateSpawnAgent with executor-medium-spawn still works; agent_file bare is checked
    // When agent_file is executor-medium (subagent), failConfig
    assert.equal(refused.outcome, OUTCOME.CONFIG_ERROR);
    assert.match(refused.reason, /refuse subagent|use executor-medium-spawn/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHand: CAPTURE_ERROR sets quarantine when reset fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "t7-quar-"));
  try {
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "executor-low-spawn.md"), PRIMARY_SPAWN_FM);

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
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "executor-low-spawn.md"), PRIMARY_SPAWN_FM);

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

test("runHand: test-author does not require fidelity_pass (producer exempt)", async () => {
  let spawned = false;
  const root = mkdtempSync(join(tmpdir(), "t7-fid-ta-"));
  try {
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "test-author-spawn.md"), PRIMARY_SPAWN_FM);

    const result = await runHand(
      {
        feature_id: "feat-fid",
        task_id: "task-ta",
        session_id: "ses_fidta",
        project_root: root,
        freeze_commit_sha: "freeze1",
        role: "test-author",
        no_tests: true,
        scope_paths: ["src/"],
        allowed_writes: ["src/"],
        brief: "write locked test",
      },
      {
        agentsDir,
        checkFidelityPass: () => {
          throw new Error("test-author must not consult fidelity-pass");
        },
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

test("defaultHasFidelityPass: true after stampFidelityPass on disk", () => {
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

    const stamped = stampFidelityPass({
      projectRoot: root,
      sessionId,
      featureId: "feat-d",
      taskId: "task-d",
      sha: "abc",
      headSha: () => null,
    });
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
