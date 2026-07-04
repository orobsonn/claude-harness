/**
 * @description Contract tests for run-lock.mjs — the single-runner lock that guards the
 * VPS cron harness against a second concurrent launch. Every case feeds SYNTHETIC clocks,
 * pid-liveness probes (`kill`) and tmux-session probes (`tmuxHasSession`) to the pure
 * lock functions; no real process is spawned and no real tmux session is touched. Each
 * test uses a fresh temp state dir (mkdtemp under os.tmpdir()) and removes it afterward.
 *
 * Liveness precedence encoded here (see acquire()):
 *   - Not yet registered with a tmux id -> liveness is pid-based, but only reclaimed once
 *     the holder's acquire_ts is older than registration_grace_seconds (a holder inside
 *     the acquire->register window is never mistaken for dead).
 *   - Once registered with a tmux id -> liveness is tmux-based ONLY; the recorded pid is
 *     never consulted again (a live tmux session wins even over a dead/reused pid).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquire, register, release, readHolder } from "./run-lock.mjs";

/** @description Fake pid-liveness probe that always reports "alive" (never throws). */
function aliveKill() {}

/** @description Fake pid-liveness probe that always reports "dead" (throws ESRCH, like the real kill(pid,0) would). */
function deadKill() {
  const err = new Error("kill ESRCH");
  err.code = "ESRCH";
  throw err;
}

/** @description Makes a fresh temp dir for one test and returns a cleanup callback. */
function makeStateDir() {
  const dir = mkdtempSync(join(tmpdir(), "run-lock-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("acquire: first caller wins the fresh lock; the loser never overwrites the winner's holder record; register() later attaches the tmux id", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const now = () => 1_000;
    const tmuxHasSession = () => false;

    const winner = acquire({ stateDir, pid: 111, now, kill: aliveKill, tmuxHasSession });
    const loser = acquire({ stateDir, pid: 222, now, kill: aliveKill, tmuxHasSession });

    assert.equal(winner.acquired, true, "first caller must win the fresh lock");
    assert.equal(loser.acquired, false, "second caller must be rejected while the lock is held");

    const holderAfterAcquire = readHolder({ stateDir });
    assert.equal(holderAfterAcquire.pid, 111, "persisted holder must carry the winner's pid, not the loser's");
    assert.equal(typeof holderAfterAcquire.acquire_ts, "number", "persisted holder must carry an acquire_ts");
    assert.equal(
      "tmux_session_id" in holderAfterAcquire,
      false,
      "persisted holder must NOT carry a tmux_session_id before register() runs"
    );

    register("sess-1", { stateDir });
    const holderAfterRegister = readHolder({ stateDir });
    assert.equal(
      holderAfterRegister.tmux_session_id,
      "sess-1",
      "register() must attach the tmux id to the held holder record"
    );
    assert.equal(holderAfterRegister.pid, 111, "register() must not disturb the recorded pid");
  } finally {
    cleanup();
  }
});

test("acquire: reclaims a dead, never-registered holder; a registered holder with a live tmux session is never reclaimed and its pid is not consulted", () => {
  const dirA = makeStateDir();
  try {
    const now = () => 10_000;
    const tmuxHasSession = () => false;

    acquire({ stateDir: dirA.dir, pid: 111, now, kill: aliveKill, tmuxHasSession }); // holder never registers a tmux id

    const result = acquire({ stateDir: dirA.dir, pid: 222, now, kill: deadKill, tmuxHasSession });
    assert.equal(result.acquired, true, "a dead, unregistered holder must be reclaimed");
    assert.equal(result.reclaimedStale, true);
  } finally {
    dirA.cleanup();
  }

  const dirB = makeStateDir();
  try {
    const now = () => 10_000;
    const pidProbe = { consulted: false };
    const killThatWouldReportDead = (pid) => {
      pidProbe.consulted = true;
      const err = new Error("kill ESRCH");
      err.code = "ESRCH";
      throw err;
    };
    const tmuxHasSession = (id) => id === "sess-alive";

    acquire({ stateDir: dirB.dir, pid: 111, now, kill: aliveKill, tmuxHasSession });
    register("sess-alive", { stateDir: dirB.dir });
    const holderBefore = readHolder({ stateDir: dirB.dir });

    const result = acquire({ stateDir: dirB.dir, pid: 222, now, kill: killThatWouldReportDead, tmuxHasSession });

    assert.equal(result.acquired, false, "a registered holder with a live tmux session must never be reclaimed");
    assert.equal(
      pidProbe.consulted,
      false,
      "pid liveness must not be consulted once the holder is registered — the tmux probe alone decides"
    );
    const holderAfter = readHolder({ stateDir: dirB.dir });
    assert.deepEqual(holderAfter, holderBefore, "holder record must be unchanged when acquire() fails");
  } finally {
    dirB.cleanup();
  }
});

test("acquire: dead launcher pid + live tmux session is the steady-state ALIVE case — never reclaimed, holder byte-unchanged", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const now = () => 20_000;
    const tmuxHasSession = (id) => id === "sess-42";

    acquire({ stateDir, pid: 111, now, kill: aliveKill, tmuxHasSession });
    register("sess-42", { stateDir });
    const holderBefore = readHolder({ stateDir });

    const result = acquire({ stateDir, pid: 222, now, kill: deadKill, tmuxHasSession });

    assert.equal(
      result.acquired,
      false,
      "dead recorded pid must not matter once a live tmux session corroborates the holder"
    );
    const holderAfter = readHolder({ stateDir });
    assert.deepEqual(holderAfter, holderBefore, "holder record must be byte-unchanged — never reclaimed");
  } finally {
    cleanup();
  }
});

test("acquire: registered holder whose tmux session is gone is reclaimed even if the recorded pid is alive (reused pid); live pid is not consulted", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const now = () => 30_000;
    acquire({ stateDir, pid: 111, now, kill: aliveKill, tmuxHasSession: () => true });
    register("sess-99", { stateDir });

    const pidProbe = { consulted: false };
    const killReportingAlive = (pid) => {
      pidProbe.consulted = true; // must never be reached — see assertion below
    };
    const tmuxSessionGone = () => false;

    const result = acquire({ stateDir, pid: 222, now, kill: killReportingAlive, tmuxHasSession: tmuxSessionGone });

    assert.equal(result.acquired, true, "a registered holder whose tmux session is gone must be reclaimed");
    assert.equal(result.reclaimedStale, true);
    assert.equal(
      pidProbe.consulted,
      false,
      "live pid must not be consulted once the registered tmux session is confirmed gone — pid reuse must not fool this"
    );
  } finally {
    cleanup();
  }
});

test("release: frees the lock only when the caller's acquire_ts matches the recorded holder's, and is idempotent when the lock is already absent", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const now = () => 5_000;
    const tmuxHasSession = () => false;

    const h2 = acquire({ stateDir, pid: 222, now, kill: aliveKill, tmuxHasSession });
    assert.equal(h2.acquired, true);

    const staleAcquireTsFromSupersededHolder = h2.acquireTs - 1; // simulates H1's acquire_ts != H2's
    release({ stateDir, acquireTs: staleAcquireTsFromSupersededHolder });

    const holderStillHeld = readHolder({ stateDir });
    assert.equal(holderStillHeld.pid, 222, "release() from a superseded acquire_ts must not free the lock");
    assert.equal(holderStillHeld.acquire_ts, h2.acquireTs, "recorded owner must remain H2");
  } finally {
    cleanup();
  }

  const { dir: absentDir, cleanup: cleanupAbsent } = makeStateDir();
  try {
    // absentDir holds no lock at all (fresh dir, acquire() never called) — this is the ENOENT case.
    assert.doesNotThrow(
      () => release({ stateDir: absentDir, acquireTs: 1 }),
      "release() against an already-absent lock must be idempotent, not throw"
    );
  } finally {
    cleanupAbsent();
  }
});

test("acquire: an unregistered holder still inside the registration grace window is not mistaken for dead", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    let clock = 1_000;
    const now = () => clock;
    const tmuxHasSession = () => false;
    const registration_grace_seconds = 120;

    const r1 = acquire({ stateDir, pid: 111, now, kill: aliveKill, tmuxHasSession, registration_grace_seconds });
    assert.equal(r1.acquired, true);

    clock = 1_000 + 60; // 60s elapsed — inside the 120s grace window
    const holderBefore = readHolder({ stateDir });

    const result = acquire({ stateDir, pid: 222, now, kill: aliveKill, tmuxHasSession, registration_grace_seconds });

    assert.equal(result.acquired, false, "an unregistered holder within grace must not be reclaimed");
    assert.equal(result.reclaimedStale, undefined);
    const holderAfter = readHolder({ stateDir });
    assert.deepEqual(holderAfter, holderBefore, "holder record must be unchanged");
  } finally {
    cleanup();
  }
});

test("acquire: an unregistered holder past the registration grace window is treated as a crashed pre-spawn and reclaimed", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    let clock = 1_000;
    const now = () => clock;
    const tmuxHasSession = () => false;
    const registration_grace_seconds = 120;

    const r1 = acquire({ stateDir, pid: 111, now, kill: aliveKill, tmuxHasSession, registration_grace_seconds });
    assert.equal(r1.acquired, true);

    clock = 1_000 + 121; // past the 120s grace window, still never registered

    const result = acquire({ stateDir, pid: 222, now, kill: aliveKill, tmuxHasSession, registration_grace_seconds });

    assert.equal(result.acquired, true, "past-grace unregistered holder must be treated as dead (crashed pre-spawn)");
    assert.equal(result.reclaimedStale, true);
  } finally {
    cleanup();
  }
});
