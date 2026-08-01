/** @description Locked tests for T5 gates MVP: entry, lock RMW, fidelity, plan-full, loop counters. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
  isSafeSessionIdSegment,
  loadGateStateFromDisk,
} from "./gate-state.mjs";
import { decideEntryTask, throwIfDenied, hasFidelityPass } from "./entry-decide.mjs";
import { bareRole, isDeliveryRole, isExecutorRole, isPlannerRole, isSniperRole } from "./roles.mjs";

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

test("entry-gate normalizes namespaced canonical review roles and still requires ceremony", () => {
  assert.equal(bareRole("@harness/adversary-family-1"), "adversary-family-1");
  assert.equal(isDeliveryRole("@harness/adversary-family-1"), true);
  const decision = decideEntryTask({
    subagentType: "@harness/adversary-family-1",
    gateState: {},
  });
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /ceremony missing/i);
});

test("retired planner fallback aliases are neither delivery nor planner roles", () => {
  for (const role of ["planner-fallback", "@harness/planner-fallback", "harness:planner-fallback", "planner-fallback.md"]) {
    assert.equal(isDeliveryRole(role), false, role);
    assert.equal(isPlannerRole(role), false, role);
  }
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

test("bareRole is case-insensitive — Executor-High is delivery/executor", () => {
  assert.equal(bareRole("Executor-High"), "executor-high");
  assert.equal(bareRole("harness:Executor-High"), "executor-high");
  assert.equal(bareRole("SNIPER-HIGH"), "sniper-high");
  assert.equal(isDeliveryRole("Executor-High"), true);
  assert.equal(isExecutorRole("Executor-High"), true);
  assert.equal(isSniperRole("Sniper-Medium"), true);
  assert.equal(isExecutorRole("Sniper-High"), false);
});

// Superseded by issue #485 (oc-cc-gate1-gate3-fidelity, docs/OC-CC-PARITY-REPORT.md T14): the
// sniper is now EXEMPT from the fidelity rail, mirroring Claude Code entry-gate.mjs (which never
// blocks the sniper on fidelity — it is the post-gate fixer, dispatched precisely because
// something already went wrong, and must not wait on the fidelity-pass its own fix may produce).
test("t5-fidelity: sniper is EXEMPT from fidelity-pass regardless of gate-state", () => {
  const baseState = {
    mode: "LIGHT",
    classified: true,
    triaged: true,
    feature_id: "feat-x",
    fidelity_pass: [],
  };

  const sniperOk = decideEntryTask({
    subagentType: "sniper-high",
    gateState: baseState,
    featureId: "feat-x",
    taskId: "task-1",
  });
  assert.equal(sniperOk.decision, "allow");
  assert.match(sniperOk.reason, /sniper-fidelity-exempt/);
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

// ---------------------------------------------------------------------------
// lt- quick/no-ceremony backstop for four roles (compliance etc)
// The former "+ executor carve-out" locked here (PR #299/#305) is REMOVED by issue #485
// (oc-cc-gate1-gate3-fidelity, docs/OC-CC-PARITY-REPORT.md Gate 1 / roadmap item 14): Claude
// Code's triage-mode gate has no per-role exemption, so QUICK/no-ceremony now denies EVERY
// delivery role — executor and sniper included — not just the four eyes. See
// lt-quick-no-ceremony-denies-executor-too below.
// ---------------------------------------------------------------------------

test("lt-quick-no-ceremony-four-roles-matrix: QUICK/quick/no-ceremony + classified → compliance/security/harvester/shipper all deny", () => {
  const modes = ["QUICK", "quick", "no-ceremony"];
  const roles = ["compliance", "security", "harvester", "shipper"];
  for (const mode of modes) {
    for (const role of roles) {
      const d = decideEntryTask({
        subagentType: role,
        gateState: { mode, classified: true },
      });
      assert.equal(d.decision, "deny");
    }
  }
});

test("lt-full-four-roles-allow: FULL/full + classified → the four roles allow", () => {
  const modes = ["FULL", "full"];
  const roles = ["compliance", "security", "harvester", "shipper"];
  for (const mode of modes) {
    for (const role of roles) {
      const d = decideEntryTask({
        subagentType: role,
        gateState: { mode, classified: true },
      });
      assert.equal(d.decision, "allow");
    }
  }
});

test("lt-ceremony-missing-still-deny: empty gateState + compliance → deny with ceremony-missing reason (existing behavior preserved)", () => {
  const d = decideEntryTask({
    subagentType: "compliance",
    gateState: {},
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /ceremony missing/);
});

test("lt-quick-no-ceremony-denies-executor-too: QUICK + classified + fidelity_pass still denies executor-medium (#485 — no per-role exemption, CC parity)", () => {
  const d = decideEntryTask({
    subagentType: "executor-medium",
    gateState: {
      mode: "QUICK",
      classified: true,
      fidelity_pass: ["feat/t1"],
    },
    featureId: "feat",
    taskId: "t1",
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /LIGHT or FULL/);
});

// ---------------------------------------------------------------------------
// loadGateStateFromDisk / isSafeSessionIdSegment (moved from dual-enforcement #580)
// ---------------------------------------------------------------------------

test("isSafeSessionIdSegment accepts OC session ids and rejects traversal", () => {
  assert.equal(isSafeSessionIdSegment("ses_testDual123"), true);
  assert.equal(isSafeSessionIdSegment("../evil"), false);
  assert.equal(isSafeSessionIdSegment("a/b"), false);
  assert.equal(isSafeSessionIdSegment(""), false);
});

test("loadGateStateFromDisk reads real files under project root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-state-disk-"));
  try {
    const sessionId = "ses_testDual123";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        dual_status: "primary_only_failopen",
        plan_verdict: "APPROVE",
        feature_id: "oc-port-phase-2",
      }),
      "utf8",
    );

    const gsScan = loadGateStateFromDisk(root, {});
    assert.equal(gsScan.ok, false, "missing sessionId must fail-closed");

    const gs = loadGateStateFromDisk(root, { sessionId });
    assert.equal(gs.ok, true, !gs.ok ? String(gs.reason) : "session ok");
    if (gs.ok) {
      assert.equal(
        /** @type {{ dual_status: string }} */ (gs.state).dual_status,
        "primary_only_failopen",
      );
    }

    const missing = loadGateStateFromDisk(root, {
      sessionId: "ses_doesNotExist999",
    });
    // Missing file = empty ceremony state (not infra unreadable)
    assert.equal(missing.ok, true);
    assert.deepEqual(missing.state, {});
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on some FS
    }
  }
});

test("loadGateStateFromDisk falls back to cwd when projectRoot empty", () => {
  const gate = loadGateStateFromDisk("", { sessionId: "ses_testfallback01" });
  assert.notEqual(gate.ok === false && gate.reason === "projectRoot missing", true);
  if (!gate.ok) {
    assert.equal(/projectRoot missing/.test(gate.reason), false);
  }
});

test("lt-load-missing-sessionid — loadGateStateFromDisk without sessionId / null / empty → ok===false, reason matches /sessionId/", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lt-missing-sid-"));
  try {
    const r1 = loadGateStateFromDisk(root);
    assert.equal(r1.ok, false);
    assert.match(String(r1.reason || ""), /sessionId/);

    const r2 = loadGateStateFromDisk(root, {});
    assert.equal(r2.ok, false);
    assert.match(String(r2.reason || ""), /sessionId/);

    const r3 = loadGateStateFromDisk(root, { sessionId: null });
    assert.equal(r3.ok, false);
    assert.match(String(r3.reason || ""), /sessionId/);

    const r4 = loadGateStateFromDisk(root, { sessionId: "" });
    assert.equal(r4.ok, false);
    assert.match(String(r4.reason || ""), /sessionId/);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
});

test("lt-load-unsafe-sessionid — unsafe sessionId like '../evil' → ok===false, reason matches /sessionId/", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lt-unsafe-sid-"));
  try {
    const r = loadGateStateFromDisk(root, { sessionId: "../evil" });
    assert.equal(r.ok, false);
    assert.match(String(r.reason || ""), /sessionId/);

    assert.equal(isSafeSessionIdSegment("../evil"), false);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
});

test("lt-load-missing-file-empty-ceremony — safe S1 no file → ok===true, state {}", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lt-missingfile-"));
  try {
    const S1 = "ses_safeNoFile123";
    // intentionally do not create dir or gate-state.json
    const r = loadGateStateFromDisk(root, { sessionId: S1 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.state, {});
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
});
