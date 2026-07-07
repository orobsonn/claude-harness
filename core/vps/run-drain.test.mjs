/**
 * @description Tests for the dedicated drain-only cron (run-drain.mjs / mainDrain) and the shared
 * drain-with-lock helper (drain-lock.mjs / drainWithLock). The helper owns the `drain.lock`
 * acquire/stale-reclaim/release; mainDrain wires the real notifier into it. Fail-open throughout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, openSync, closeSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { drainWithLock } from "./drain-lock.mjs";
import { mainDrain } from "./run-drain.mjs";

function makeStateDir() {
  return mkdtempSync(join(tmpdir(), "run-drain-state-"));
}

test("drainWithLock: drains once with spacing, then releases the drain.lock", async () => {
  const stateDir = makeStateDir();
  const calls = [];
  await drainWithLock({ stateDir, homeDir: stateDir }, { drainOutbox: async (opts) => calls.push(opts) });

  assert.strictEqual(calls.length, 1, "drainOutbox is called exactly once");
  assert.strictEqual(calls[0].stateDir, stateDir);
  assert.ok(calls[0].sendDelayMs > 0, "sends are spaced");
  assert.ok(!existsSync(join(stateDir, "drain.lock")), "the lock is released after the drain");
});

test("drainWithLock: SKIPS the drain when a FRESH drain.lock is already held (no double-send)", async () => {
  const stateDir = makeStateDir();
  const fd = openSync(join(stateDir, "drain.lock"), "wx"); // a concurrent drain holds it
  try {
    let called = 0;
    await drainWithLock({ stateDir }, { drainOutbox: async () => { called += 1; } });
    assert.strictEqual(called, 0, "a fresh held lock makes this tick skip the drain");
    assert.ok(existsSync(join(stateDir, "drain.lock")), "the held lock is left in place for its holder");
  } finally {
    closeSync(fd);
  }
});

test("drainWithLock: RECLAIMS a stale drain.lock (old mtime) and drains", async () => {
  const stateDir = makeStateDir();
  const lockPath = join(stateDir, "drain.lock");
  closeSync(openSync(lockPath, "wx"));
  const stale = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago > 15-min TTL
  utimesSync(lockPath, stale, stale);

  let called = 0;
  await drainWithLock({ stateDir }, { drainOutbox: async () => { called += 1; } });
  assert.strictEqual(called, 1, "a stale lock is reclaimed and the drain runs");
});

test("drainWithLock: fail-open — a throwing drainOutbox never rejects and still releases the lock", async () => {
  const stateDir = makeStateDir();
  await assert.doesNotReject(
    drainWithLock({ stateDir }, { drainOutbox: async () => { throw new Error("boom"); } }),
  );
  assert.ok(!existsSync(join(stateDir, "drain.lock")), "the lock is released even when the drain throws");
});

test("mainDrain: a configured notifier drains once; an unconfigured one is a no-op", async () => {
  // configured: token + chatId present → notifier.enabled → drains
  const stateDir = makeStateDir();
  const homeDir = mkdtempSync(join(tmpdir(), "run-drain-home-"));
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  writeFileSync(join(homeDir, ".claude", ".dev.vars"), "TELEGRAM_BOT_TOKEN=fake\nTELEGRAM_CHAT_ID=999\n", "utf8");

  let drains = 0;
  await mainDrain({ project: "demo", stateDir, homeDir, notify: { chatId: 999 } }, { drainOutbox: async () => { drains += 1; } });
  assert.strictEqual(drains, 1, "a configured notifier drains once");

  // unconfigured: no token → notifier disabled → no-op
  const homeDir2 = mkdtempSync(join(tmpdir(), "run-drain-home2-"));
  mkdirSync(join(homeDir2, ".claude"), { recursive: true });
  writeFileSync(join(homeDir2, ".claude", ".dev.vars"), "", "utf8");

  let drains2 = 0;
  await mainDrain({ project: "demo", stateDir, homeDir: homeDir2 }, { drainOutbox: async () => { drains2 += 1; } });
  assert.strictEqual(drains2, 0, "an unconfigured notifier drains nothing");
});
