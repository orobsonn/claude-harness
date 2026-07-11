/** @description Locked tests for T5 gates MVP: entry, lock RMW, fidelity, plan-full, loop counters. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  acquireLock,
  releaseLock,
  mergeGateState,
  readGateState,
  writeGateStateAtomic,
  lockPathFor,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  withGateStateLock,
} from "./gate-state.mjs";
import { decideEntryTask, throwIfDenied, hasFidelityPass } from "./entry-decide.mjs";
import { decidePlanGate, throwIfPlanDenied } from "./plan-decide.mjs";
import { decideLoopGuard, nextLoopCount, throwIfLoopDenied } from "./loop-decide.mjs";
import { applyGateStatePatch } from "../../../shared/lib/gate-state-shape.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {(dir: string, statePath: string) => void | Promise<void>} fn
 */
async function withTempState(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t5-gate-"));
  const statePath = path.join(tmpDir, "plans", ".state", "ses_test", "gate-state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  try {
    await fn(tmpDir, statePath);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// t5-entry
// ---------------------------------------------------------------------------

test("t5-entry: entry-gate deny throws with [entry-gate] prefix when ceremony missing", () => {
  const d = decideEntryTask({
    subagentType: "planner",
    gateState: {}, // no mode, not classified
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /^\[entry-gate\]/);
  assert.throws(() => throwIfDenied(d), /\[entry-gate\]/);
});

test("entry-gate allows non-delivery roles without ceremony", () => {
  const d = decideEntryTask({ subagentType: "Explore", gateState: {} });
  assert.equal(d.decision, "allow");
});

// ---------------------------------------------------------------------------
// t5-concurrent
// ---------------------------------------------------------------------------

test("t5-concurrent: two concurrent writers under ownership-token lock do not drop markers", async () => {
  await withTempState(async (_dir, statePath) => {
    writeGateStateAtomic(statePath, { fidelity_pass: [], hand_finished: [] });

    const gateStateMod = path.join(__dirname, "gate-state.mjs");
    /** @param {Record<string, unknown>} patch */
    const runWorker = (patch) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
            import { mergeGateState } from ${JSON.stringify(gateStateMod)};
            const statePath = process.argv[1];
            const patch = JSON.parse(process.argv[2]);
            const r = mergeGateState(statePath, patch);
            if (!r.ok) {
              console.error(JSON.stringify(r));
              process.exit(1);
            }
            `,
            statePath,
            JSON.stringify(patch),
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr += d;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(undefined);
          else reject(new Error(stderr || `worker exit ${code}`));
        });
      });

    // True multi-process concurrency (not same-process Promise.all on sync RMW)
    await Promise.all([
      runWorker({ fidelity_pass: ["feat/t1"] }),
      runWorker({ hand_finished: ["feat/t1"] }),
      runWorker({ fidelity_pass: ["feat/t2"] }),
    ]);

    const final = readGateState(statePath);
    assert.ok(
      Array.isArray(final.fidelity_pass) && final.fidelity_pass.includes("feat/t1"),
      `fidelity_pass missing t1: ${JSON.stringify(final.fidelity_pass)}`,
    );
    assert.ok(
      Array.isArray(final.fidelity_pass) && final.fidelity_pass.includes("feat/t2"),
      `fidelity_pass missing t2: ${JSON.stringify(final.fidelity_pass)}`,
    );
    assert.ok(
      Array.isArray(final.hand_finished) && final.hand_finished.includes("feat/t1"),
      `hand_finished missing: ${JSON.stringify(final.hand_finished)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// t5-stale
// ---------------------------------------------------------------------------

test("t5-stale: stale lock recovery succeeds after lock_stale_seconds", async () => {
  await withTempState(async (_dir, statePath) => {
    const lockPath = lockPathFor(statePath);
    // Dead pid + old createdAt
    const staleBody = {
      token: "stale-token-aaaa-bbbb-cccc-ddddeeeeffff",
      pid: 999999001, // almost certainly not alive
      createdAt: new Date(Date.now() - LOCK_STALE_MS - 5_000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleBody), "utf8");

    const acquired = acquireLock(statePath, {
      timeoutMs: 2_000,
      staleMs: LOCK_STALE_MS,
    });
    assert.equal(acquired.ok, true, acquired.reason);
    assert.ok(acquired.token);
    const rel = releaseLock(statePath, acquired.token);
    assert.equal(rel.ok, true);
  });
});

// ---------------------------------------------------------------------------
// corrupt stale lock + two multi-process acquirers (exclusive rename claim)
// ---------------------------------------------------------------------------

test("corrupt stale lock: two concurrent acquirers — exclusive rename claim, both acquire without clobber", async () => {
  await withTempState(async (_dir, statePath) => {
    const lockPath = lockPathFor(statePath);
    // Unreadable/corrupt lock body with stale mtime
    fs.writeFileSync(lockPath, "CORRUPT-NOT-JSON{{{", "utf8");
    const old = new Date(Date.now() - LOCK_STALE_MS - 10_000);
    fs.utimesSync(lockPath, old, old);

    const gateStateMod = path.join(__dirname, "gate-state.mjs");
    /** @returns {Promise<{ ok: boolean, token?: string, mine?: boolean, stillMine?: boolean, reason?: string }>} */
    const runAcquirer = () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
            import { acquireLock, releaseLock, lockPathFor, readLockFile } from ${JSON.stringify(gateStateMod)};
            const statePath = process.argv[1];
            const r = acquireLock(statePath, { timeoutMs: 5000, staleMs: ${LOCK_STALE_MS} });
            if (!r.ok) {
              process.stdout.write(JSON.stringify({ ok: false, reason: r.reason }));
              process.exit(0);
            }
            const held = readLockFile(lockPathFor(statePath));
            const mine = !!(held && held.token === r.token);
            const end = Date.now() + 80;
            while (Date.now() < end) {
              /* hold so peer races reclaim/create */
            }
            const still = readLockFile(lockPathFor(statePath));
            const stillMine = !!(still && still.token === r.token);
            releaseLock(statePath, r.token);
            process.stdout.write(JSON.stringify({ ok: true, token: r.token, mine, stillMine }));
            `,
            statePath,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
          stdout += d;
        });
        child.stderr.on("data", (d) => {
          stderr += d;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(stderr || `worker exit ${code}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            reject(new Error(`bad stdout: ${stdout} stderr: ${stderr}`));
          }
        });
      });

    const [a, b] = await Promise.all([runAcquirer(), runAcquirer()]);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(a.mine, true, "holder must own lock after acquire");
    assert.equal(b.mine, true, "holder must own lock after acquire");
    assert.equal(a.stillMine, true, "lock must not be clobbered while held");
    assert.equal(b.stillMine, true, "lock must not be clobbered while held");
    assert.notEqual(a.token, b.token);
    assert.equal(fs.existsSync(lockPath), false, "lock released after both acquirers");
    const leftovers = fs
      .readdirSync(path.dirname(lockPath))
      .filter((f) => f.endsWith(".lock") || f.includes(".del"));
    assert.deepEqual(leftovers, [], `no orphan lock/tombstone: ${leftovers.join(",")}`);
  });
});

// ---------------------------------------------------------------------------
// t5-mismatch
// ---------------------------------------------------------------------------

test("t5-mismatch: release refuses mismatched ownership token", async () => {
  await withTempState(async (_dir, statePath) => {
    const acquired = acquireLock(statePath, { timeoutMs: 2_000 });
    assert.equal(acquired.ok, true);
    const bad = releaseLock(statePath, "wrong-token-not-matching");
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "token-mismatch");
    // Lock still held by real token
    assert.ok(fs.existsSync(lockPathFor(statePath)));
    const good = releaseLock(statePath, acquired.token);
    assert.equal(good.ok, true);
  });
});

// ---------------------------------------------------------------------------
// t5-timeout
// ---------------------------------------------------------------------------

test("t5-timeout: lock timeout deny when lock held beyond lock_timeout_ms", async () => {
  await withTempState(async (_dir, statePath) => {
    // Hold lock with live pid and fresh createdAt
    const lockPath = lockPathFor(statePath);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        token: "holder-token-1111-2222-3333-444455556666",
        pid: process.pid, // alive
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const acquired = acquireLock(statePath, {
      timeoutMs: 80,
      staleMs: LOCK_STALE_MS,
      sleepMs: (ms) => {
        const end = Date.now() + Math.min(ms, 15);
        while (Date.now() < end) {
          /* spin */
        }
      },
    });
    assert.equal(acquired.ok, false);
    assert.equal(acquired.decision, "deny");
    assert.equal(acquired.reason, "gate-state-lock-timeout");

    // cleanup
    fs.unlinkSync(lockPath);
  });
});

// ---------------------------------------------------------------------------
// t5-fidelity
// ---------------------------------------------------------------------------

test("t5-fidelity: test-author exempt from fidelity-pass; executor blocked until pass", () => {
  const baseState = {
    mode: "LIGHT",
    classified: true,
    triaged: true,
    feature_id: "feat-x",
    fidelity_pass: [],
  };

  const author = decideEntryTask({
    subagentType: "test-author",
    gateState: baseState,
    featureId: "feat-x",
    taskId: "task-1",
  });
  assert.equal(author.decision, "allow");
  assert.match(author.reason, /test-author-fidelity-exempt/);

  const execBlocked = decideEntryTask({
    subagentType: "executor-high",
    gateState: baseState,
    featureId: "feat-x",
    taskId: "task-1",
  });
  assert.equal(execBlocked.decision, "deny");
  assert.match(execBlocked.reason, /\[entry-gate\].*fidelity-pass/);

  const withPass = {
    ...baseState,
    fidelity_pass: ["feat-x/task-1"],
  };
  const execOk = decideEntryTask({
    subagentType: "executor",
    gateState: withPass,
    featureId: "feat-x",
    taskId: "task-1",
  });
  assert.equal(execOk.decision, "allow");

  assert.equal(hasFidelityPass(["feat-x/task-1@abc"], "feat-x", "task-1"), true);
  assert.equal(hasFidelityPass([], "feat-x", "task-1"), false);
});

// ---------------------------------------------------------------------------
// t5-plan-full
// ---------------------------------------------------------------------------

test("t5-plan-full: plan-gate denies stub kind or empty tasks with expect full", () => {
  const stub = decidePlanGate({
    plan: { kind: "stub", mode: "LIGHT", feature_id: "feat-a", tasks: [] },
    expect: "full",
  });
  assert.equal(stub.decision, "deny");
  assert.match(stub.reason, /\[plan-gate\]/);
  assert.throws(() => throwIfPlanDenied(stub), /\[plan-gate\]/);

  const empty = decidePlanGate({
    plan: { kind: "full", mode: "light", feature_id: "feat-a", tasks: [] },
    expect: "full",
  });
  assert.equal(empty.decision, "deny");
  assert.match(empty.reason, /\[plan-gate\]/);

  const missing = decidePlanGate({ plan: null, expect: "full" });
  assert.equal(missing.decision, "deny");
});

// ---------------------------------------------------------------------------
// t5-loop-inc
// ---------------------------------------------------------------------------

test("t5-loop-inc: plan-review and adversary loop counters increment in disk gate-state and survive a fresh read/process boundary", async () => {
  await withTempState(async (_dir, statePath) => {
    writeGateStateAtomic(statePath, {
      plan_review_count: 0,
      adversary_loop_count: 0,
    });

    // Increment plan-review
    const r1 = withGateStateLock(statePath, (prev) => {
      const step = nextLoopCount(prev, "plan-reviewer");
      const applied = applyGateStatePatch(prev, { [step.key]: step.next });
      return applied.state;
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.state.plan_review_count, 1);

    // Increment adversary
    const r2 = withGateStateLock(statePath, (prev) => {
      const step = nextLoopCount(prev, "adversary");
      const applied = applyGateStatePatch(prev, { [step.key]: step.next });
      return applied.state;
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.state.adversary_loop_count, 1);

    // Fresh read (simulates new process)
    const fresh = readGateState(statePath);
    assert.equal(fresh.plan_review_count, 1);
    assert.equal(fresh.adversary_loop_count, 1);

    // Survive process boundary via child process re-read
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { readGateState } from ${JSON.stringify(path.join(__dirname, "gate-state.mjs"))};
        const s = readGateState(${JSON.stringify(statePath)});
        if (s.plan_review_count !== 1 || s.adversary_loop_count !== 1) {
          console.error(JSON.stringify(s));
          process.exit(1);
        }
        `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });
});

// ---------------------------------------------------------------------------
// t5-loop-thresh
// ---------------------------------------------------------------------------

test("t5-loop-thresh: after configured warn threshold emits warn; after deny threshold denies further loop", () => {
  // warn at 2
  const w = decideLoopGuard({ subagentType: "plan-reviewer", count: 2 });
  assert.equal(w.decision, "warn");
  assert.match(w.reason, /\[loop-guard\].*warn/i);

  const wAdv = decideLoopGuard({ subagentType: "adversary", count: 2 });
  assert.equal(wAdv.decision, "warn");

  // deny at 4
  const d = decideLoopGuard({ subagentType: "plan-reviewer", count: 4 });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /\[loop-guard\].*deny/i);
  assert.throws(() => throwIfLoopDenied(d), /\[loop-guard\]/);

  const dAdv = decideLoopGuard({ subagentType: "adversary", count: 4 });
  assert.equal(dAdv.decision, "deny");

  // below warn
  const a = decideLoopGuard({ subagentType: "plan-reviewer", count: 1 });
  assert.equal(a.decision, "allow");
});

// ---------------------------------------------------------------------------
// Map-only regression: mergeGateState is disk-backed
// ---------------------------------------------------------------------------

test("gate-state is disk-backed (not Map-only): second process sees markers", async () => {
  await withTempState(async (_dir, statePath) => {
    const r = mergeGateState(statePath, {
      classified: true,
      fidelity_pass: ["f/t"],
    });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(statePath));
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(raw.classified, true);
    assert.deepEqual(raw.fidelity_pass, ["f/t"]);
  });
});
