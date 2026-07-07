/**
 * @description Contract tests for engine-update.mjs — the VPS blue/green engine auto-updater. The
 * engine (the harness code the crontab runs, at `<engineDir>/core/vps/run-cron-*.mjs`) is a symlink
 * `~/.claude/harness-core` -> `~/.claude/harness-core-versions/<sha>`. When main advances (after an
 * autonomous merge), performEngineUpdate prepares the new sha in a NEW version dir and flips the
 * symlink ATOMICALLY — never mutating the dir a running cron already resolved its imports from, so
 * no lock is needed and no process ever sees a half-updated tree.
 *
 * Every git/fs side-effect is an injected seam so this suite is fully hermetic — ZERO real git,
 * ZERO real fs. Pinned surface:
 *   needsUpdate(activeSha, remoteSha) -> boolean
 *   versionsToPrune(versions, activeSha, keep) -> version[]  (never includes activeSha)
 *   performEngineUpdate(deps) -> {updated:boolean, reason?, from?, to?}
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { needsUpdate, versionsToPrune, performEngineUpdate } from "./engine-update.mjs";

test("needsUpdate: true only when both shas are present AND differ", () => {
  assert.equal(needsUpdate("aaa", "bbb"), true, "different shas → update");
  assert.equal(needsUpdate("aaa", "aaa"), false, "same sha → no update");
  assert.equal(needsUpdate("", "bbb"), false, "missing active sha → no update (fail-closed, never churn on unknown state)");
  assert.equal(needsUpdate("aaa", ""), false, "missing remote sha → no update (a failed ls-remote must not trigger a churn)");
  assert.equal(needsUpdate(null, null), false, "both missing → no update");
});

test("versionsToPrune: keeps the active version + the (keep-1) most-recent by mtime, prunes the rest, NEVER the active one", () => {
  const versions = [
    { sha: "active", mtimeMs: 100, path: "/v/active" },
    { sha: "new2", mtimeMs: 500, path: "/v/new2" },
    { sha: "new1", mtimeMs: 400, path: "/v/new1" },
    { sha: "old1", mtimeMs: 200, path: "/v/old1" },
    { sha: "old2", mtimeMs: 300, path: "/v/old2" },
  ];
  const pruned = versionsToPrune(versions, "active", 3);
  const prunedShas = pruned.map((v) => v.sha).sort();
  // keep=3 → active is always kept; among the rest keep the 2 most-recent (new2@500, new1@400); prune old1,old2.
  assert.deepEqual(prunedShas, ["old1", "old2"], "prunes the oldest non-active versions beyond the keep window");
  assert.ok(!pruned.some((v) => v.sha === "active"), "the active version is NEVER pruned even if it is old");
});

test("versionsToPrune: active version that is also the oldest is still never pruned (keep beats mtime for the active)", () => {
  const versions = [
    { sha: "active", mtimeMs: 1, path: "/v/active" }, // oldest by mtime, but active
    { sha: "b", mtimeMs: 10, path: "/v/b" },
    { sha: "c", mtimeMs: 20, path: "/v/c" },
    { sha: "d", mtimeMs: 30, path: "/v/d" },
  ];
  const pruned = versionsToPrune(versions, "active", 2);
  // keep=2 → active + 1 most-recent (d@30). Prune b, c. active survives despite being oldest.
  assert.deepEqual(pruned.map((v) => v.sha).sort(), ["b", "c"]);
});

test("versionsToPrune: a version younger than the grace window is NEVER pruned even if it is outside the keep window (protects a version a long cron may still import)", () => {
  const now = 10_000;
  const versions = [
    { sha: "active", mtimeMs: 9_000, path: "/v/active" },
    { sha: "recent-but-old-active", mtimeMs: 9_500, path: "/v/recent" }, // 500ms old — within a 2000ms grace
    { sha: "ancient", mtimeMs: 1_000, path: "/v/ancient" }, // 9000ms old — beyond grace
  ];
  const pruned = versionsToPrune(versions, "active", 1, { now, minAgeMs: 2_000 });
  // keep=1 → only active is kept by the keep window; "recent" is spared by the grace; "ancient" prunes.
  assert.deepEqual(pruned.map((v) => v.sha), ["ancient"], "grace spares the recently-created version; only the ancient one prunes");
});

test("versionsToPrune: nothing to prune when total <= keep", () => {
  const versions = [
    { sha: "active", mtimeMs: 100, path: "/v/active" },
    { sha: "x", mtimeMs: 200, path: "/v/x" },
  ];
  assert.deepEqual(versionsToPrune(versions, "active", 3), [], "fewer versions than the keep window → prune nothing");
});

/** @description Builds a fully-injected seam set for performEngineUpdate, recording every side-effect. */
function makeDeps(overrides = {}) {
  const calls = { prepareVersion: [], activate: [], pruneVersion: [] };
  const deps = {
    isManaged: () => true,
    getActiveSha: () => "aaa",
    getRemoteSha: () => "bbb",
    prepareVersion: (sha) => {
      calls.prepareVersion.push(sha);
      return `/versions/${sha}`;
    },
    activate: (path) => {
      calls.activate.push(path);
    },
    listVersions: () => [
      { sha: "aaa", mtimeMs: 100, path: "/versions/aaa" },
      { sha: "bbb", mtimeMs: 200, path: "/versions/bbb" },
    ],
    pruneVersion: (path) => {
      calls.pruneVersion.push(path);
    },
    keep: 3,
    ...overrides,
  };
  return { deps, calls };
}

test("performEngineUpdate: unmanaged engine (not a managed symlink) is a NO-OP fail-safe — never touches git/fs", () => {
  const { deps, calls } = makeDeps({ isManaged: () => false });
  const result = performEngineUpdate(deps);
  assert.deepEqual(result, { updated: false, reason: "unmanaged-engine" });
  assert.equal(calls.prepareVersion.length, 0, "an unmanaged engine must never prepare a version");
  assert.equal(calls.activate.length, 0, "an unmanaged engine must never swap the symlink");
});

test("performEngineUpdate: already up-to-date (active === remote) is a no-op, no prepare/activate", () => {
  const { deps, calls } = makeDeps({ getActiveSha: () => "same", getRemoteSha: () => "same" });
  const result = performEngineUpdate(deps);
  assert.deepEqual(result, { updated: false, reason: "up-to-date" });
  assert.equal(calls.prepareVersion.length, 0);
  assert.equal(calls.activate.length, 0);
});

test("performEngineUpdate: a failed remote sha lookup (empty) is a no-op — a flaky ls-remote never churns the engine", () => {
  const { deps, calls } = makeDeps({ getRemoteSha: () => "" });
  const result = performEngineUpdate(deps);
  assert.deepEqual(result, { updated: false, reason: "up-to-date" });
  assert.equal(calls.activate.length, 0, "no symlink swap on an unknown remote sha");
});

test("performEngineUpdate: main advanced → prepares the new sha, activates it, then prunes, returns {updated, from, to}", () => {
  const { deps, calls } = makeDeps();
  const result = performEngineUpdate(deps);
  assert.deepEqual(result, { updated: true, from: "aaa", to: "bbb" });
  assert.deepEqual(calls.prepareVersion, ["bbb"], "must prepare exactly the remote sha version");
  assert.deepEqual(calls.activate, ["/versions/bbb"], "must activate (swap symlink to) the freshly-prepared version");
});

test("performEngineUpdate: prepare happens BEFORE activate (never point the symlink at a dir that isn't ready)", () => {
  const order = [];
  const { deps } = makeDeps({
    prepareVersion: (sha) => {
      order.push("prepare");
      return `/versions/${sha}`;
    },
    activate: () => order.push("activate"),
    listVersions: () => [],
  });
  performEngineUpdate(deps);
  assert.deepEqual(order, ["prepare", "activate"], "activate must never precede prepare");
});

test("performEngineUpdate: if prepareVersion throws (clone failed), the symlink is NOT swapped — the old version stays live", () => {
  const { deps, calls } = makeDeps({
    prepareVersion: () => {
      throw new Error("clone failed");
    },
  });
  assert.throws(() => performEngineUpdate(deps), /clone failed/);
  assert.equal(calls.activate.length, 0, "a failed clone must never activate — the previous engine stays live");
});

test("performEngineUpdate: a pruneVersion that throws AFTER a successful activate never masks the update — still returns {updated:true} (the swap already happened)", () => {
  const { deps } = makeDeps({
    getActiveSha: () => "v0",
    getRemoteSha: () => "v1",
    keep: 1,
    listVersions: () => [
      { sha: "v0", mtimeMs: 100, path: "/versions/v0" },
      { sha: "v1", mtimeMs: 200, path: "/versions/v1" },
    ],
    pruneVersion: () => {
      throw new Error("EACCES removing old version");
    },
  });
  const result = performEngineUpdate(deps);
  assert.deepEqual(result, { updated: true, from: "v0", to: "v1" }, "a failed prune after activation must not turn a real update into a failure");
});

test("performEngineUpdate: after activating, prunes old versions keyed on the NEW active sha (keep window)", () => {
  const { deps, calls } = makeDeps({
    getActiveSha: () => "v0",
    getRemoteSha: () => "v3",
    keep: 2,
    listVersions: () => [
      { sha: "v0", mtimeMs: 100, path: "/versions/v0" },
      { sha: "v1", mtimeMs: 200, path: "/versions/v1" },
      { sha: "v3", mtimeMs: 400, path: "/versions/v3" },
    ],
  });
  performEngineUpdate(deps);
  // keep=2, new active is v3: keep v3 + the 1 most-recent other (v1@200); prune v0.
  assert.deepEqual(calls.pruneVersion, ["/versions/v0"], "prunes the oldest beyond the keep window after activation");
});
