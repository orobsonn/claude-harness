/**
 * @description Contract tests for run-cron-update.mjs — the VPS engine auto-update COMPOSITION ROOT
 * (fleet-level, ONE cron for the whole VPS, like the reaper, because the engine dir is shared by
 * every project's crons). A crontab invokes `node run-cron-update.mjs --config <engine-update.json>`.
 *
 * `runEngineUpdate(config, deps)` is the testable seam: `deps` defaults to real git/fs wiring but is
 * fully injectable, so this suite asserts the OBSERVABLE wiring — that performEngineUpdate is called
 * with seams bound to the config, and that a successful update notifies (non-critical) — with ZERO
 * real git, ZERO real fs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runEngineUpdate } from "./run-cron-update.mjs";

const CONFIG = {
  engineLink: "/home/h/.claude/harness-core",
  versionsDir: "/home/h/.claude/harness-core-versions",
  homeDir: "/home/h",
  keep: 3,
};

/** @description Records every call into `.calls`; optionally delegates to `impl`. */
function makeSpy(impl) {
  function fn(...args) {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  }
  fn.calls = [];
  return fn;
}

test("runEngineUpdate: calls performEngineUpdate with the config-bound seams (isManaged/getActiveSha/getRemoteSha/prepareVersion/activate/listVersions/pruneVersion/keep)", () => {
  const captured = { deps: null };
  const performEngineUpdate = makeSpy((deps) => {
    captured.deps = deps;
    return { updated: false, reason: "up-to-date" };
  });
  runEngineUpdate(CONFIG, { performEngineUpdate, notify: () => {} });

  assert.equal(performEngineUpdate.calls.length, 1, "performEngineUpdate must be called exactly once");
  const d = captured.deps;
  for (const seam of ["isManaged", "getActiveSha", "getRemoteSha", "prepareVersion", "activate", "listVersions", "pruneVersion"]) {
    assert.equal(typeof d[seam], "function", `seam ${seam} must be a bound function`);
  }
  assert.equal(d.keep, 3, "keep must be threaded from the config");
});

test("runEngineUpdate: an update notifies engine-updated with from/to (progress, non-critical)", () => {
  const notify = makeSpy();
  runEngineUpdate(CONFIG, {
    performEngineUpdate: () => ({ updated: true, from: "aaaaaaa", to: "bbbbbbb" }),
    notify,
  });
  const events = notify.calls.map(([e]) => e);
  const updated = events.find((e) => e.type === "engine-updated");
  assert.ok(updated, "a successful engine update must notify engine-updated");
  assert.equal(updated.from, "aaaaaaa");
  assert.equal(updated.to, "bbbbbbb");
});

test("runEngineUpdate: a no-op update (up-to-date / unmanaged) does NOT notify — silence when nothing changed", () => {
  const notify = makeSpy();
  runEngineUpdate(CONFIG, { performEngineUpdate: () => ({ updated: false, reason: "up-to-date" }), notify });
  assert.equal(notify.calls.length, 0, "an up-to-date pass must stay silent (no engine-updated spam every 15min)");

  const notify2 = makeSpy();
  runEngineUpdate(CONFIG, { performEngineUpdate: () => ({ updated: false, reason: "unmanaged-engine" }), notify: notify2 });
  assert.equal(notify2.calls.length, 0, "an unmanaged engine must stay silent");
});

test("runEngineUpdate: a thrown performEngineUpdate (clone/swap failure) notifies engine-update-failed and never throws out of the cron", () => {
  const notify = makeSpy();
  assert.doesNotThrow(() =>
    runEngineUpdate(CONFIG, {
      performEngineUpdate: () => {
        throw new Error("clone exploded");
      },
      notify,
    })
  );
  const failed = notify.calls.map(([e]) => e).find((e) => e.type === "engine-update-failed");
  assert.ok(failed, "a failed update must notify engine-update-failed so the stall is observable");
});
