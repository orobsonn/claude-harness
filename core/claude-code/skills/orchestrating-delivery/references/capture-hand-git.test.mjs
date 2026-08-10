/**
 * @description Integration tests for the ONE seam the hermetic suite cannot cover: `realGit`.
 * `capture-hand.test.mjs` injects a `fakeGit` whose `hashObject` never fails and never sees a
 * directory entry, so the pre-existing-untracked subtraction is only ever exercised against a
 * perfect adapter. Every false-positive in issue #362 lived precisely in that blind spot: the
 * REAL `git hash-object` aborts the WHOLE batch (exit 128) on a single unreadable path, and the
 * adapter turned that into an empty map — which `subtractUnchanged` reads as "subtract nothing",
 * misattributing every pre-existing untracked file to the hand.
 *
 * These tests therefore build REAL git repos in a tmp dir and drive `realGit` against them. They
 * are slower than the hermetic suite by design; that cost is the point.
 *
 * On the home dotfiles (.bashrc, .zshrc, .idea, .mcp.json ...) run #159 accused and could not
 * explain — they were NOT invented by the sweep, and this is the evidence (#ac-2.2). They exist in
 * the worktree as bind mounts of /dev/null, stubbed by the sandbox:
 *
 *   $ findmnt -T .bashrc
 *   TARGET    SOURCE      FSTYPE    OPTIONS
 *   .../.bashrc  udev[/null]  devtmpfs  ro,nosuid,nodev,...
 *   $ git ls-files --others --exclude-standard   # lists .bashrc, .zshrc, .idea, .mcp.json, ...
 *   $ git hash-object .bashrc
 *   fatal: could not open '.bashrc' for reading: Permission denied   # exit 128
 *
 * The issue looked for them in the operator's HOME (where .zshrc indeed does not exist) rather than
 * in the worktree, which is why the trail went cold. They are listed as ordinary untracked files
 * (so they were accused directly) AND they are unhashable (so they zeroed the batch and got the
 * other 24 paths accused too). The trigger is NOT reproduced literally here: a bind mount needs
 * privileges CI does not have, and a plain `mknod` char device is NOT a faithful stand-in — git
 * omits it from `ls-files --others` entirely, so it never reaches `hash-object`. The FAILURE CLASS
 * — a path git lists but cannot open — is what matters to this code, and the broken symlink below
 * exercises exactly that, through the same branch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { OUTCOME } from "./dispatch-hand.mjs";
import { captureResult, MAIN_WORKTREE_SNAPSHOT_PATH_LIMIT, realGit, snapshotMainWorktree, UNHASHABLE } from "./capture-hand.mjs";

/** @description Runs git in `cwd`, throwing on failure (test-only helper). */
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** @description Writes `content` to `cwd/rel`, creating parent dirs. */
function write(cwd, rel, content) {
  const full = join(cwd, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return full;
}

/**
 * @description Builds a real repo mirroring the run #159 tree: the harness's own paperwork
 * (descriptor, brief, gate-state, a PRIOR attempt's run-record) untracked under `.claude/plans/`,
 * gitignored local runtime state under `.wrangler/`, and the frozen test. Returns the repo dir and
 * its HEAD sha. Registers its own cleanup.
 */
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "capture-hand-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  write(dir, ".gitignore", ".wrangler/\n");
  write(dir, "migrations/.keep", "");
  write(dir, "test/frozen.test.mjs", "// frozen\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);

  // The harness's own paperwork — written BEFORE the hand is spawned, untracked and NOT gitignored
  // (the consuming project's .gitignore covers .wrangler/ but not .claude/plans/).
  write(dir, ".claude/plans/soundtracks-library/run/descriptor-task-1.json", '{"task_id":"task-1"}');
  write(dir, ".claude/plans/soundtracks-library/run/brief-task-1.txt", "do the thing");
  write(dir, ".claude/plans/.state/sess-1/gate-state.json", '{"markers":[]}');
  write(dir, ".claude/plans/.state/hand-records/soundtracks-library/task-1.json", '{"attempt":1}');
  // Local runtime state — gitignored, so it only surfaces via the no-exclude escape sweep.
  write(dir, ".wrangler/state/v3/d1/db.sqlite", "binary-ish");
  write(dir, ".wrangler/tmp/dev-1/bundle.js", "junk");

  return { dir, head: git(dir, ["rev-parse", "HEAD"]).trim() };
}

/** @description The dispatch of run #159: a single allowed write, scoped to migrations/. */
function dispatch159() {
  return {
    model: "qwen2.5-coder:7b",
    scope_paths: ["migrations/0030_soundtracks.sql"],
    allowed_writes: ["migrations/0030_soundtracks.sql"],
    frozen_paths: ["test/frozen.test.mjs"],
  };
}

function args159(dir, head, preUntracked, overrides = {}) {
  return {
    dispatch: dispatch159(),
    child: { exitCode: 0, stdout: "done", stderr: "" },
    freezeCommitSha: head,
    testPath: "test/frozen.test.mjs",
    git: realGit(dir),
    testRunner: () => ({ stdout: "# tests 3\n", stderr: "", exitCode: 0 }),
    token: "fake-token-for-tests",
    preUntracked,
    ...overrides,
  };
}

test("#470: a child worktree changing the primary tree is captured as an explicit violation", (t) => {
  const { dir, head } = makeRepo(t);
  const child = `${dir}-child`;
  t.after(() => rmSync(child, { recursive: true, force: true }));
  git(dir, ["worktree", "add", "-qb", "capture-child", child]);

  const mainSnapshot = snapshotMainWorktree(child);
  assert.ok(mainSnapshot, "precondition: a distinct primary worktree is discovered canonically");

  write(child, "migrations/0030_soundtracks.sql", "-- child change");
  const mainPath = "main\nworktree-write.js";
  write(dir, mainPath, "// forbidden main-tree write");
  const result = captureResult(args159(child, head, new Map(), { mainWorktreeSnapshot: mainSnapshot }));

  assert.equal(result.outcome.status, OUTCOME.FAILED);
  assert.deepEqual(result.outcome.mainWorktreeViolations, [mainPath], "NUL porcelain parsing preserves newline pathnames");
});

test("#470: unchanged primary-tree dirt is subtracted, while the child worktree still captures normally", (t) => {
  const { dir, head } = makeRepo(t);
  const child = `${dir}-child`;
  t.after(() => rmSync(child, { recursive: true, force: true }));
  git(dir, ["worktree", "add", "-qb", "capture-child-clean", child]);
  write(dir, "operator-notes.txt", "pre-existing operator dirt");

  const mainSnapshot = snapshotMainWorktree(child);
  assert.ok(mainSnapshot, "precondition: a complete baseline exists");
  write(child, "migrations/0030_soundtracks.sql", "-- child change");
  const result = captureResult(args159(child, head, new Map(), { mainWorktreeSnapshot: mainSnapshot }));

  assert.equal(result.outcome.status, OUTCOME.DONE);
  assert.deepEqual(result.outcome.mainWorktreeViolations, []);
});

test("#470: modifying pre-existing primary-tree dirt remains a violation", (t) => {
  const { dir, head } = makeRepo(t);
  const child = `${dir}-child`;
  t.after(() => rmSync(child, { recursive: true, force: true }));
  git(dir, ["worktree", "add", "-qb", "capture-child-dirty", child]);
  write(dir, "operator-notes.txt", "before");

  const mainSnapshot = snapshotMainWorktree(child);
  write(dir, "operator-notes.txt", "changed during hand");
  write(child, "migrations/0030_soundtracks.sql", "-- child change");
  const result = captureResult(args159(child, head, new Map(), { mainWorktreeSnapshot: mainSnapshot }));

  assert.equal(result.outcome.status, OUTCOME.FAILED);
  assert.deepEqual(result.outcome.mainWorktreeViolations, ["operator-notes.txt"]);
});

test("#470: an oversized primary-tree baseline disables only the optional probe", (t) => {
  const { dir } = makeRepo(t);
  const child = `${dir}-child`;
  t.after(() => rmSync(child, { recursive: true, force: true }));
  git(dir, ["worktree", "add", "-qb", "capture-child-overflow", child]);
  for (let i = 0; i <= MAIN_WORKTREE_SNAPSHOT_PATH_LIMIT; i += 1) {
    write(dir, `operator-dirt/${i}.txt`, "pre-existing");
  }

  assert.equal(snapshotMainWorktree(child), null, "incomplete baseline must not sample or accuse");
});

test("#470: post-spawn probe overflow degrades without inventing a main-tree violation", (t) => {
  const { dir, head } = makeRepo(t);
  const child = `${dir}-child`;
  t.after(() => rmSync(child, { recursive: true, force: true }));
  git(dir, ["worktree", "add", "-qb", "capture-child-post-overflow", child]);
  const mainSnapshot = snapshotMainWorktree(child);
  assert.ok(mainSnapshot, "precondition: the pre-spawn baseline is complete");

  for (let i = 0; i <= MAIN_WORKTREE_SNAPSHOT_PATH_LIMIT; i += 1) {
    write(dir, `during-run-dirt/${i}.txt`, "outside probe limit");
  }
  write(child, "migrations/0030_soundtracks.sql", "-- child change");
  const result = captureResult(args159(child, head, new Map(), { mainWorktreeSnapshot: mainSnapshot }));

  assert.equal(result.outcome.status, OUTCOME.DONE);
  assert.deepEqual(result.outcome.mainWorktreeViolations, []);
});

test("#470: an unreadable primary-tree entry disables the sidecar instead of becoming a stable fingerprint", (t) => {
  const { dir } = makeRepo(t);
  const child = `${dir}-child`;
  t.after(() => rmSync(child, { recursive: true, force: true }));
  git(dir, ["worktree", "add", "-qb", "capture-child-unhashable", child]);
  symlinkSync("/nowhere/does/not/exist", join(dir, "unreadable-main.link"));

  assert.equal(snapshotMainWorktree(child), null);
});

test("#470: chmod of pre-existing tracked dirt changes the fingerprint and fails the capture", (t) => {
  const { dir, head } = makeRepo(t);
  const child = `${dir}-child`;
  t.after(() => rmSync(child, { recursive: true, force: true }));
  git(dir, ["worktree", "add", "-qb", "capture-child-mode", child]);
  write(dir, ".gitignore", ".wrangler/\n# operator edit\n");
  const mainSnapshot = snapshotMainWorktree(child);
  assert.ok(mainSnapshot);

  chmodSync(join(dir, ".gitignore"), 0o755);
  write(child, "migrations/0030_soundtracks.sql", "-- child change");
  const result = captureResult(args159(child, head, new Map(), { mainWorktreeSnapshot: mainSnapshot }));

  assert.equal(result.outcome.status, OUTCOME.FAILED);
  assert.deepEqual(result.outcome.mainWorktreeViolations, [".gitignore"]);
});

test("#470: primary worktree equal to cwd disables the optional probe", (t) => {
  const { dir } = makeRepo(t);
  assert.equal(snapshotMainWorktree(dir), null);
});

// ---- 1. realGit().hashObject survives an unreadable path (the #362 root cause) ----

test("realGit().hashObject: one unreadable path does not zero the whole map", (t) => {
  const { dir } = makeRepo(t);
  symlinkSync("/nowhere/does/not/exist", join(dir, "broken.link"));
  const g = realGit(dir);
  const paths = g.lsFilesAllOthers();
  assert.ok(paths.includes("broken.link"), "precondition: the broken symlink is listed");

  const map = g.hashObject(paths);

  // Before the fix this was 0 for the WHOLE run: `git hash-object a b c` exits 128 on the first
  // unreadable path and the adapter's catch returned an empty map.
  assert.equal(map.size, paths.length, "every listed path gets an entry, hashable or not");
  assert.match(map.get(".claude/plans/.state/sess-1/gate-state.json"), /^[0-9a-f]{40}$/);
});

test("realGit().hashObject: a collapsed nested-repo directory entry does not zero the map", (t) => {
  const { dir } = makeRepo(t);
  // `git ls-files --others` does not descend into a nested repo — it emits the DIRECTORY. The
  // harness's own `.claude/worktrees/<name>` is exactly such a nested worktree, so on every fleet
  // run `git hash-object` was handed a directory and aborted ("Unable to hash <dir>/").
  git(dir, ["worktree", "add", "-q", ".claude/worktrees/harness-1", "-b", "wt1"]);
  const g = realGit(dir);
  const paths = g.lsFilesAllOthers();
  assert.ok(
    paths.includes(".claude/worktrees/harness-1/"),
    "precondition: the nested worktree collapses to a directory entry"
  );

  const map = g.hashObject(paths);

  assert.equal(map.size, paths.length, "the directory entry is recorded, not fatal to the batch");
  assert.match(map.get(".wrangler/tmp/dev-1/bundle.js"), /^[0-9a-f]{40}$/);

  // KNOWN LIMIT, asserted so it is explicit rather than assumed: git does not descend into a nested
  // repo, so a file written INSIDE one is invisible to this capture — with or without this fix (the
  // listing, not the hashing, is what stops at the boundary). Anything a hand could write there is
  // outside the sweep's reach; that gap predates #362 and needs its own change to close.
  writeFileSync(join(dir, ".claude/worktrees/harness-1/evil.js"), "// payload", "utf8");
  assert.deepEqual(
    g.lsFilesAllOthers().filter((p) => p.includes("harness-1")),
    [".claude/worktrees/harness-1/"],
    "the nested worktree's CONTENTS never surface — only the collapsed directory entry"
  );
});

test("realGit().hashObject: a path that vanishes mid-batch only loses itself", (t) => {
  const { dir } = makeRepo(t);
  const g = realGit(dir);
  const paths = [...g.lsFilesAllOthers(), "ghost/gone.txt"];

  const map = g.hashObject(paths);

  assert.match(map.get(".claude/plans/soundtracks-library/run/brief-task-1.txt"), /^[0-9a-f]{40}$/);
  assert.ok(map.has("ghost/gone.txt"), "the vanished path is recorded as unhashable, not dropped");
});

// ---- 2. #ac-1.1 / #ac-2.1 — the run #159 false positive, reproduced end to end ----

test("#159 repro: hand writes ONLY its allowed_writes → no scope violations, not FAILED", (t) => {
  const { dir, head } = makeRepo(t);
  // An unreadable path in the tree is what poisoned the snapshot. `.wrangler/tmp` churns exactly
  // like this; the environment's /dev/null dotfiles (.bashrc, .zshrc — char devices `git
  // hash-object` cannot open) are the other real-world instance.
  symlinkSync("/nowhere/does/not/exist", join(dir, ".wrangler/tmp/sock.link"));

  // Pre-spawn snapshot, exactly as spawn-hand's defaultSnapshotUntracked takes it.
  const preUntracked = realGit(dir).hashObject(realGit(dir).lsFilesAllOthers());

  // The hand does its job: writes its ONE allowed write, and nothing else.
  write(dir, "migrations/0030_soundtracks.sql", "CREATE TABLE soundtracks (id INTEGER);");

  const result = captureResult(args159(dir, head, preUntracked));

  assert.deepEqual(result.outcome.scopeViolations, [], "the harness's own paperwork is not the hand's work");
  assert.deepEqual(result.child.touchedPaths, ["migrations/0030_soundtracks.sql"]);
  assert.equal(result.outcome.status, OUTCOME.DONE);
});

// ---- 3. #ac-1.2 / #ac-1.3 — the security control keeps full strength ----

test("#ac-1.2: a NEW out-of-scope write is still accused (subtraction never blinds the control)", (t) => {
  const { dir, head } = makeRepo(t);
  symlinkSync("/nowhere/does/not/exist", join(dir, ".wrangler/tmp/sock.link"));
  const preUntracked = realGit(dir).hashObject(realGit(dir).lsFilesAllOthers());

  write(dir, "migrations/0030_soundtracks.sql", "CREATE TABLE soundtracks (id INTEGER);");
  write(dir, "src/evil.ts", "// out of scope");

  const result = captureResult(args159(dir, head, preUntracked));

  assert.deepEqual(result.outcome.scopeViolations, ["src/evil.ts"]);
  assert.equal(result.outcome.status, OUTCOME.FAILED);
});

test("#ac-1.2: the hand REPLACING an unhashable path with real content is accused", (t) => {
  const { dir, head } = makeRepo(t);
  symlinkSync("/nowhere/does/not/exist", join(dir, ".wrangler/tmp/sock.link"));
  const preUntracked = realGit(dir).hashObject(realGit(dir).lsFilesAllOthers());
  assert.equal(preUntracked.get(".wrangler/tmp/sock.link"), UNHASHABLE, "precondition: unhashable");

  write(dir, "migrations/0030_soundtracks.sql", "CREATE TABLE soundtracks (id INTEGER);");
  // The branch that keeps the sentinel honest: an unhashable path the hand REPLACES with real
  // content hashes to a sha ≠ UNHASHABLE → kept → accused. Without this rail, "simplifying"
  // hashObject's catch to skip the path instead of recording it still passes every other test
  // here, while silently turning this into a false NEGATIVE (an omitted path reads as pre-existing
  // only if something else drops it — and the drop is what a scope control must never do quietly).
  rmSync(join(dir, ".wrangler/tmp/sock.link"));
  write(dir, ".wrangler/tmp/sock.link", "// hand replaced an unhashable path with real content");

  const result = captureResult(args159(dir, head, preUntracked));

  assert.deepEqual(result.outcome.scopeViolations, [".wrangler/tmp/sock.link"]);
  assert.equal(result.outcome.status, OUTCOME.FAILED);
});

test("#ac-1.3: a FORGED hand-record for a task never dispatched is still accused", (t) => {
  const { dir, head } = makeRepo(t);
  const preUntracked = realGit(dir).hashObject(realGit(dir).lsFilesAllOthers());

  write(dir, "migrations/0030_soundtracks.sql", "CREATE TABLE soundtracks (id INTEGER);");
  // The escalation a blanket `.claude/plans/**` exclusion would enable: the hand mints a record for
  // a task that was never dispatched, which the entry-gate's capture rail would read as evidence
  // (gate-lib.mjs::listHandRecordsForFeature accepts every .json in the directory). The capture is
  // the control that catches this — it must keep accusing it.
  write(
    dir,
    ".claude/plans/.state/hand-records/soundtracks-library/task-99.json",
    '{"outcome":{"status":"DONE","scopeViolations":[]},"capturedVerifiedAt":"2026-07-16T00:00:00Z"}'
  );

  const result = captureResult(args159(dir, head, preUntracked));

  assert.deepEqual(result.outcome.scopeViolations, [
    ".claude/plans/.state/hand-records/soundtracks-library/task-99.json",
  ]);
  assert.equal(result.outcome.status, OUTCOME.FAILED);
});

test("#ac-1.3: TAMPERING with pre-existing paperwork is still accused (hash changed)", (t) => {
  const { dir, head } = makeRepo(t);
  const preUntracked = realGit(dir).hashObject(realGit(dir).lsFilesAllOthers());

  write(dir, "migrations/0030_soundtracks.sql", "CREATE TABLE soundtracks (id INTEGER);");
  // Same path as the pre-existing gate-state, but rewritten by the hand → hash differs → kept.
  write(dir, ".claude/plans/.state/sess-1/gate-state.json", '{"markers":["regate-passed"]}');

  const result = captureResult(args159(dir, head, preUntracked));

  assert.deepEqual(result.outcome.scopeViolations, [".claude/plans/.state/sess-1/gate-state.json"]);
  assert.equal(result.outcome.status, OUTCOME.FAILED);
});

// ---- 4. #ac-1.4 — the gitignore-escape sweep stays alive ----

test("#ac-1.4: a NEW gitignored out-of-scope write (dist/) is still accused", (t) => {
  const { dir, head } = makeRepo(t);
  write(dir, ".gitignore", ".wrangler/\ndist/\n");
  git(dir, ["add", ".gitignore"]);
  git(dir, ["commit", "-qm", "ignore dist"]);
  const head2 = git(dir, ["rev-parse", "HEAD"]).trim();
  const preUntracked = realGit(dir).hashObject(realGit(dir).lsFilesAllOthers());

  write(dir, "migrations/0030_soundtracks.sql", "CREATE TABLE soundtracks (id INTEGER);");
  write(dir, "dist/sneak.js", "// gitignored escape");

  const result = captureResult(args159(dir, head2, preUntracked));

  assert.deepEqual(result.outcome.scopeViolations, ["dist/sneak.js"]);
  assert.equal(result.outcome.status, OUTCOME.FAILED);
});

// ---- 5. the gitignore-escape sweep must survive a repo with dependencies installed ----

/**
 * @description Regression for the ENOBUFS that made `captureResult` unusable in any project with
 * `node_modules/` on disk. `lsFilesAllOthers` omits `--exclude-standard` on purpose, so git streams
 * every ignored path; node's 1MB default `maxBuffer` kills the call before `excludeNodeModules` —
 * which filters the RETURNED array — ever runs. The fix belongs in the adapter, not the filter.
 * The repo below emits ~1.1MB of listing from 3000 long ignored paths, just over that ceiling.
 */
test("realGit: lsFilesAllOthers survives a listing larger than node's default maxBuffer", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "capture-hand-maxbuffer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  write(dir, ".gitignore", "node_modules/\n");

  const longDir = "d".repeat(180);
  const base = join(dir, "node_modules", longDir);
  mkdirSync(base, { recursive: true });
  for (let i = 0; i < 3000; i += 1) {
    writeFileSync(join(base, `${String(i).padStart(6, "0")}${"f".repeat(180)}.js`), "x", "utf8");
  }

  // Guard the fixture itself: without this the test would pass on a listing that never reached
  // the ceiling, and the regression it pins would go unnoticed.
  const raw = execFileSync("git", ["ls-files", "--others"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.ok(raw.length > 1024 * 1024, `fixture must exceed the 1MB default, got ${raw.length} bytes`);

  // The adapter drops node_modules/ from the RETURNED array — the point is that it gets there at
  // all instead of dying with ENOBUFS inside execFileSync.
  assert.deepEqual(realGit(dir).lsFilesAllOthers(), [".gitignore"]);
});
