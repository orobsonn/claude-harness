import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { LOCK_STALE_MS, acquireLock, lockPathFor, readLockFile, releaseLock } from "./file-lock.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "task-runs", "index.json");
}
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("lock is exclusive, token-owned and released only by its owner", (t) => {
  const file = fixture(t);
  const first = acquireLock(file, { timeoutMs: 5 });
  assert.equal(first.ok, true);
  assert.equal(readLockFile(lockPathFor(file)).pid, process.pid);
  assert.equal(acquireLock(file, { timeoutMs: 5 }).ok, false);
  assert.deepEqual(releaseLock(file, "someone-else"), { ok: false, reason: "token-mismatch" });
  assert.deepEqual(releaseLock(file, first.token), { ok: true });
  assert.equal(fs.existsSync(lockPathFor(file)), false);
});

test("a recent lock is never stolen, even when its owner pid is dead", (t) => {
  const file = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(lockPathFor(file), JSON.stringify({ token: "old", pid: deadPid(), createdAt: new Date().toISOString() }));
  assert.equal(acquireLock(file, { timeoutMs: 5 }).ok, false);
  assert.equal(readLockFile(lockPathFor(file)).token, "old");
});

test("an old lock with a live owner is never stolen", (t) => {
  const file = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000).toISOString();
  fs.writeFileSync(lockPathFor(file), JSON.stringify({ token: "live", pid: process.pid, createdAt: old }));
  assert.equal(acquireLock(file, { timeoutMs: 5 }).ok, false);
});

test("a lock older than 30 s whose owner died is recovered", (t) => {
  const file = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.equal(LOCK_STALE_MS, 30_000);
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000).toISOString();
  fs.writeFileSync(lockPathFor(file), JSON.stringify({ token: "stale", pid: deadPid(), createdAt: old }));
  const acquired = acquireLock(file, { timeoutMs: 50 });
  assert.equal(acquired.ok, true);
  assert.notEqual(readLockFile(lockPathFor(file)).token, "stale");
  releaseLock(file, acquired.token);
});

test("a free lock is acquired even when the deadline passes before the first attempt", (t) => {
  const file = fixture(t);
  let calls = 0;
  // First call computes the deadline; every later call is already past it.
  const now = () => (calls++ === 0 ? 1_000 : 10_000);
  const acquired = acquireLock(file, { timeoutMs: 5, now });
  assert.equal(acquired.ok, true);
  releaseLock(file, acquired.token);
  const held = acquireLock(file, { timeoutMs: 5 });
  calls = 0;
  assert.equal(acquireLock(file, { timeoutMs: 5, now }).ok, false, "a held lock is still busy after one try");
  releaseLock(file, held.token);
});

test("a stale lock broken after the deadline is retried once instead of reported busy", (t) => {
  const file = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000).toISOString();
  fs.writeFileSync(lockPathFor(file), JSON.stringify({ token: "stale", pid: deadPid(), createdAt: old }));
  let calls = 0;
  const real = Date.now();
  // Deadline computed on the first call; afterwards time is far past it.
  const now = () => (calls++ === 0 ? real : real + 60_000);
  const acquired = acquireLock(file, { timeoutMs: 5, now });
  assert.equal(acquired.ok, true);
  releaseLock(file, acquired.token);
});
