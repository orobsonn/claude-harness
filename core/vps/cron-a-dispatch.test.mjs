/**
 * @description Contract tests for cron-a-dispatch.mjs — the VPS cron harness's dispatch phase.
 * dispatch() is handed an issue already picked + relabeled `harness:in-progress` by
 * cron-a-select, and an already-HELD run-lock holder (pid + acquire_ts, no tmux_session_id
 * yet — cron-a-select's acquire() ran, dispatch never re-acquires).
 *
 * CORRECTED CONTRACT (this file replaces a frozen test that modeled unreal spawn plumbing — an
 * adversary proved the old assertions forced a broken real implementation):
 *   - `claude -p` is NEVER a separate foreground `spawn("claude", ...)` call. It runs INSIDE a
 *     DETACHED tmux session (`tmux new-session -d -s <name> ... <command>`) — a real
 *     `spawnSync` ignores `stdin`, and a detached tmux session has no stdin to feed it. The
 *     claude invocation lives entirely inside the composed shell command string handed to the
 *     `tmux` spawn.
 *   - The issue body is delivered by writing it to a file and redirecting that file into
 *     `claude -p`'s stdin from WITHIN the tmux command string (`< <bodyfile>`) — never
 *     interpolated into any argv or command string, so shell metacharacters in the body can
 *     never be interpreted.
 *   - Real `tmux` returns no session id. dispatch itself GENERATES a deterministic,
 *     project-scoped session NAME (e.g. `harness-<project>-<issue>`), passes it as the
 *     `tmux new-session -s <name>` argument, and registers that SAME name via
 *     `runLock.register(name, opts)` — never a spawn-result field.
 *
 * Every seam dispatch needs — the child-process spawn, the run-lock register/release, the
 * scoped-env builder, `gh`, and the per-issue attempt counter — is INJECTED as a fake so these
 * tests are fully hermetic: no real git/tmux/claude/gh process is ever spawned, and no real
 * filesystem lock/counter state is touched (temp dirs exist only to hand dispatch
 * realistic-looking paths and to let a real implementation actually write/read the body file).
 *
 * The single `spawn(command, args, spawnOpts)` fake records every invocation as
 * `{ command, args, env, stdin, cwd }` into a shared `calls` log — this is how dispatch's
 * *composition* (argv, env, the tmux session command STRING, command ordering) is asserted as
 * an observable, without ever running a real subprocess. `failCommands` makes the fake throw
 * for a given command, driving the pre-registration spawn-failure path (run-lock release +
 * harness:ready relabel, no retry-attempt consumed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "./cron-a-dispatch.mjs";

/** @description Fresh temp projectRoot/worktreeRoot/stateDir for one test, plus cleanup. */
function makeTempDirs() {
  const root = mkdtempSync(join(tmpdir(), "cron-a-dispatch-"));
  const projectRoot = join(root, "project");
  const worktreeRoot = join(root, "worktrees");
  const stateDir = join(root, "state");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { projectRoot, worktreeRoot, stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @description Fake spawn/exec seam. Records every invocation as
 * `{ command, args, env, stdin, cwd }`. Throws for any command listed in `failCommands`
 * (simulating e.g. `git worktree add` or the tmux spawn failing). Real `tmux`/`git` return no
 * usable payload dispatch could depend on, so this fake returns only `{ ok: true }` — there is
 * deliberately no `sessionId` field to hand back; the session NAME must come from dispatch itself.
 */
function makeFakeSpawn({ failCommands = [] } = {}) {
  const calls = [];
  function spawn(command, args = [], spawnOpts = {}) {
    calls.push({ command, args, env: spawnOpts.env, stdin: spawnOpts.stdin, cwd: spawnOpts.cwd });
    if (failCommands.includes(command)) {
      throw new Error(`fake spawn: ${command} failed`);
    }
    return { ok: true };
  }
  return { spawn, calls };
}

/**
 * @description Fake run-lock seam mirroring run-lock.mjs's register(tmuxId, opts) /
 * release(opts) contract. `holder()` exposes the in-memory "persisted" record so tests can
 * assert register() actually attached the dispatch-generated session name onto the
 * already-held holder — never a fresh acquire (this fake deliberately has no `acquire`).
 */
function makeFakeRunLock(initialHolder) {
  let holder = { ...initialHolder };
  const registerCalls = [];
  const releaseCalls = [];
  return {
    holder: () => holder,
    register(tmuxId, opts) {
      registerCalls.push({ tmuxId, opts });
      holder = { ...holder, tmux_session_id: tmuxId };
    },
    release(opts) {
      releaseCalls.push(opts);
      holder = null;
    },
    registerCalls,
    releaseCalls,
  };
}

/** @description Fake gh seam. Records each `gh` argv (e.g. `["issue","edit",...]`). */
function makeFakeGh() {
  const calls = [];
  function gh(args) {
    calls.push(args);
    return { ok: true };
  }
  return { gh, calls };
}

/**
 * @description Fake per-issue attempt counter seam mirroring cron-state.mjs's
 * increment(issue, opts) / read(issue, opts) contract, backed by an in-memory map instead of
 * the filesystem.
 */
function makeFakeCounter(initial = {}) {
  const counts = { ...initial };
  return {
    increment(issueNumber, _opts) {
      counts[issueNumber] = (counts[issueNumber] ?? 0) + 1;
    },
    read(issueNumber, _opts) {
      return counts[issueNumber] ?? 0;
    },
  };
}

/** @description Assembles a full dispatch() opts object from defaults + per-test overrides. */
function baseOpts({
  projectRoot,
  worktreeRoot,
  stateDir,
  project = "demo-project",
  spawn = makeFakeSpawn().spawn,
  runLock = makeFakeRunLock({ pid: 111, acquire_ts: 1000 }),
  gh = makeFakeGh().gh,
  counter = makeFakeCounter(),
  buildScopedEnv = () => ({ PATH: "/usr/bin", OLLAMA_HAND_TOKEN: "oll-token" }),
  lock = { acquireTs: 1000 },
}) {
  return {
    project,
    projectRoot,
    worktreeRoot,
    stateDir,
    lock,
    spawn,
    runLock,
    gh,
    counter,
    buildScopedEnv,
  };
}

/** @description Locates the `tmux new-session` spawn call in a fake's recorded calls. */
function findTmuxCall(calls) {
  return calls.find((c) => c.command === "tmux");
}

/** @description Extracts the `-s <name>` argument from a recorded `tmux new-session` call. */
function tmuxSessionName(tmuxCall) {
  const idx = tmuxCall.args.indexOf("-s");
  return idx === -1 ? undefined : tmuxCall.args[idx + 1];
}

/** @description The composed session-command string is the one string arg mentioning claude. */
function sessionCommandOf(tmuxCall) {
  return tmuxCall.args.find((a) => typeof a === "string" && a.includes("claude"));
}

/**
 * @description Pulls the path after a stdin redirect (`< <path>` or `< '<path>'`) out of a
 * composed shell command string, unquoting a single-quoted path if present.
 */
function extractRedirectPath(sessionCommand) {
  const quoted = sessionCommand.match(/<\s*'((?:[^'\\]|\\.)*)'/);
  if (quoted) return quoted[1].replace(/\\'/g, "'");
  const bare = sessionCommand.match(/<\s*(\S+)/);
  return bare ? bare[1] : undefined;
}

test("dispatch: creates the git worktree at a path distinct from the project root on branch harness/<n>; a second issue gets a distinct branch and path", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake42 = makeFakeSpawn();
    dispatch({ number: 42, body: "hi" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake42.spawn }));

    const git42 = fake42.calls.find((c) => c.command === "git");
    assert.ok(git42, "dispatch must invoke git");
    assert.deepEqual(git42.args.slice(0, 2), ["worktree", "add"], "must run `git worktree add`");
    const path42 = git42.args[2];
    assert.notEqual(path42, projectRoot, "the worktree path must differ from the project's primary working tree");
    assert.equal(git42.args[3], "-b");
    assert.equal(git42.args[4], "harness/42");

    const fake43 = makeFakeSpawn();
    dispatch({ number: 43, body: "hi" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake43.spawn }));

    const git43 = fake43.calls.find((c) => c.command === "git");
    assert.ok(git43);
    assert.equal(git43.args[4], "harness/43");
    assert.notEqual(git43.args[2], path42, "two different issues must get distinct worktree paths");
  } finally {
    cleanup();
  }
});

test("dispatch: claude runs INSIDE the tmux session command string (-p, --permission-mode auto, never --dangerously-skip-permissions) — no separate claude spawn exists", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    dispatch({ number: 42, body: "hello" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    const claudeSpawn = fake.calls.find((c) => c.command === "claude");
    assert.equal(
      claudeSpawn,
      undefined,
      "dispatch must never spawn a separate foreground `claude` process — a detached tmux session has no stdin to feed it"
    );

    const tmuxCall = findTmuxCall(fake.calls);
    assert.ok(tmuxCall, "dispatch must spawn `tmux new-session`");
    const sessionCommand = sessionCommandOf(tmuxCall);
    assert.ok(sessionCommand, "the tmux argv must carry a composed session command string invoking claude");
    assert.ok(sessionCommand.includes("claude"), "the session command must invoke claude");
    assert.ok(sessionCommand.includes("-p"), "the session command must include -p");
    assert.ok(sessionCommand.includes("--permission-mode auto"), "the session command must include --permission-mode auto");
    assert.equal(
      sessionCommand.includes("--dangerously-skip-permissions"),
      false,
      "the session command must never include --dangerously-skip-permissions"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: the env handed to the tmux new-session spawn (inherited by the session) has no CLAUDE_CODE_REMOTE and carries OLLAMA_HAND_TOKEN", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    const scopedEnv = { PATH: "/usr/bin", HOME: "/home/robson", OLLAMA_HAND_TOKEN: "oll-secret" };
    dispatch(
      { number: 42, body: "hello" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, buildScopedEnv: () => ({ ...scopedEnv }) })
    );

    const tmuxCall = findTmuxCall(fake.calls);
    assert.ok(tmuxCall);
    assert.equal(
      "CLAUDE_CODE_REMOTE" in (tmuxCall.env ?? {}),
      false,
      "CLAUDE_CODE_REMOTE must be absent from the tmux spawn's env for a headless-local dispatch"
    );
    assert.equal(
      tmuxCall.env.OLLAMA_HAND_TOKEN,
      "oll-secret",
      "OLLAMA_HAND_TOKEN must reach the tmux spawn's env so cheap Ollama hands stay reachable inside the session"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: a shell-metacharacter-laden issue body is delivered via a written file + stdin redirect inside the tmux command, never via any argv or command string", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const body = "before `whoami` and $(touch /tmp/pwned) after";
    const fake = makeFakeSpawn();
    dispatch({ number: 99, body }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    for (const call of fake.calls) {
      for (const arg of call.args ?? []) {
        assert.equal(
          typeof arg === "string" && arg.includes(body),
          false,
          `spawned argv for ${call.command} must never contain the raw issue body`
        );
      }
    }

    const tmuxCall = findTmuxCall(fake.calls);
    assert.ok(tmuxCall, "dispatch must spawn the tmux session");
    const sessionCommand = sessionCommandOf(tmuxCall);
    assert.ok(sessionCommand, "the tmux argv must carry a composed session command string");
    assert.equal(
      sessionCommand.includes(body),
      false,
      "the tmux session command STRING itself must never contain any substring of the raw issue body"
    );

    const bodyFilePath = extractRedirectPath(sessionCommand);
    assert.ok(bodyFilePath, "the session command must redirect stdin from a body file (`< <bodyfilepath>`)");
    assert.ok(existsSync(bodyFilePath), "dispatch must actually have written the body file to disk");
    const written = readFileSync(bodyFilePath, "utf8");
    assert.equal(written, body, "the written body file must be byte-identical to the issue body — proving delivery");

    assert.equal(
      existsSync("/tmp/pwned"),
      false,
      "the shell metacharacter payload must never be interpreted since the body never reaches a command/argv"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: no recorded invocation runs wrangler deploy/publish or a project deploy script", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    dispatch({ number: 42, body: "hello" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    for (const call of fake.calls) {
      const joined = [call.command, ...(call.args ?? [])].join(" ");
      assert.equal(joined.includes("wrangler deploy"), false, "no invocation may run wrangler deploy");
      assert.equal(joined.includes("wrangler publish"), false, "no invocation may run wrangler publish");
      assert.equal(/\bdeploy\b/i.test(call.command ?? ""), false, "no invocation's command may itself be a deploy script");
    }
  } finally {
    cleanup();
  }
});

test("dispatch: raises the per-issue attempt counter by exactly 1 on a successful spawn, twice in a row", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const counter = makeFakeCounter();
    const fake = makeFakeSpawn();
    const opts = baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, counter });

    assert.equal(counter.read(42, { stateDir }), 0);

    dispatch({ number: 42, body: "hello" }, opts);
    assert.equal(counter.read(42, { stateDir }), 1, "a successful spawn must raise the counter by exactly 1");

    dispatch({ number: 42, body: "hello again" }, opts);
    assert.equal(counter.read(42, { stateDir }), 2, "a second successful spawn must raise the counter to 2");
  } finally {
    cleanup();
  }
});

test("dispatch: releases the run-lock and relabels harness:in-progress -> harness:ready when the worktree/tmux spawn fails before registration", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn({ failCommands: ["git"] });
    const runLock = makeFakeRunLock({ pid: 111, acquire_ts: 5000 });
    const gh = makeFakeGh();
    const opts = baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, runLock, gh: gh.gh });

    try {
      dispatch({ number: 42, body: "hello" }, opts);
    } catch {
      // A spawn-failure path may legitimately surface as a thrown error after cleanup runs —
      // either way, the observables below are what this test pins.
    }

    assert.equal(runLock.releaseCalls.length, 1, "a pre-registration spawn failure must release the run-lock exactly once");
    assert.equal(runLock.registerCalls.length, 0, "register() must never be called when spawn failed before registration");

    const relabelCall = gh.calls.find(
      (args) => args.includes("--add-label") && args[args.indexOf("--add-label") + 1] === "harness:ready"
    );
    assert.ok(relabelCall, "dispatch must relabel the issue back to harness:ready on spawn failure");
    assert.ok(relabelCall.includes("harness:in-progress"), "the relabel must move the issue off harness:in-progress");
  } finally {
    cleanup();
  }
});

test("dispatch: a pre-registration spawn failure does not consume a retry attempt (counter left unchanged)", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const counter = makeFakeCounter();
    const fake = makeFakeSpawn({ failCommands: ["git"] });
    const runLock = makeFakeRunLock({ pid: 111, acquire_ts: 5000 });
    const gh = makeFakeGh();
    const opts = baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, runLock, gh: gh.gh, counter });

    assert.equal(counter.read(42, { stateDir }), 0);

    try {
      dispatch({ number: 42, body: "hello" }, opts);
    } catch {
      // Failure path may or may not rethrow after cleanup; the counter invariant below is what matters.
    }

    assert.ok(fake.calls.length > 0, "dispatch must have actually attempted the spawn before failing");
    assert.equal(counter.read(42, { stateDir }), 0, "a spawn failure before registration must not consume a retry attempt");
  } finally {
    cleanup();
  }
});

test("dispatch: the tmux session command runs the graceful cron-a-exit handler after the claude -p invocation", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    dispatch({ number: 42, body: "hello" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    const gitCall = fake.calls.find((c) => c.command === "git");
    const worktreePath = gitCall.args[2];

    const tmuxCall = findTmuxCall(fake.calls);
    assert.ok(tmuxCall, "dispatch must spawn the tmux session");
    const sessionCommand = sessionCommandOf(tmuxCall);
    assert.ok(sessionCommand, "the tmux argv must carry a composed session command string");

    const claudeIndex = sessionCommand.indexOf("claude -p");
    // The exit handler is invoked as `node <abs>/cron-a-exit.mjs 42 <worktree> ...` — NOT a bare
    // `cron-a-exit` command, which is not on PATH and would fail command-not-found (leaving the run
    // orphaned instead of gracefully relabeled + cleaned).
    const exitIndex = sessionCommand.indexOf("cron-a-exit.mjs");
    assert.notEqual(claudeIndex, -1, "the session command must invoke claude -p");
    assert.notEqual(exitIndex, -1, "the session command must invoke node .../cron-a-exit.mjs");
    assert.ok(sessionCommand.includes("node "), "the exit handler must run via the node binary, not a bare command");
    assert.ok(sessionCommand.includes(`42 ${worktreePath} `), "the exit handler must receive the issue number + worktree path");
    assert.ok(claudeIndex < exitIndex, "cron-a-exit must be composed AFTER the claude -p invocation, so it fires on the session's own termination");
  } finally {
    cleanup();
  }
});

test("dispatch: generates a deterministic session NAME (not a spawn-result field) and registers that same name onto the already-held holder, never re-acquiring", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    // As if cron-a-select's acquire() already ran: pid + acquire_ts recorded, no tmux_session_id yet.
    const runLock = makeFakeRunLock({ pid: 222, acquire_ts: 9000 });
    const fake = makeFakeSpawn();
    const opts = baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, runLock, lock: { acquireTs: 9000 } });

    dispatch({ number: 42, body: "hello" }, opts);

    const tmuxCall = findTmuxCall(fake.calls);
    assert.ok(tmuxCall, "dispatch must spawn the tmux session");
    const sessionName = tmuxSessionName(tmuxCall);
    assert.ok(sessionName, "the `tmux new-session -s <name>` argument must carry a dispatch-generated name");

    assert.equal(runLock.registerCalls.length, 1, "dispatch must register the session name exactly once on successful spawn");
    assert.equal(
      runLock.registerCalls[0].tmuxId,
      sessionName,
      "register() must receive the SAME name dispatch passed to `tmux -s` — never a fake/real spawn-result field"
    );
    assert.equal(
      runLock.registerCalls[0].opts.acquireTs,
      9000,
      "register() must target the already-held holder by its acquireTs, never a fresh acquire"
    );
    assert.equal(
      runLock.holder().tmux_session_id,
      sessionName,
      "the persisted holder record must now carry the dispatch-generated session name"
    );
    assert.equal(
      typeof opts.runLock.acquire,
      "undefined",
      "dispatch is never handed an acquire() seam — it must not re-acquire the lock"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: two dispatches for the SAME issue number in DIFFERENT projects produce distinct tmux session names and distinct register() calls", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fakeA = makeFakeSpawn();
    const runLockA = makeFakeRunLock({ pid: 1, acquire_ts: 1000 });
    dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, project: "projA", spawn: fakeA.spawn, runLock: runLockA, lock: { acquireTs: 1000 } })
    );

    const fakeB = makeFakeSpawn();
    const runLockB = makeFakeRunLock({ pid: 2, acquire_ts: 2000 });
    dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, project: "projB", spawn: fakeB.spawn, runLock: runLockB, lock: { acquireTs: 2000 } })
    );

    const tmuxA = findTmuxCall(fakeA.calls);
    const tmuxB = findTmuxCall(fakeB.calls);
    assert.ok(tmuxA && tmuxB, "both dispatches must spawn a tmux session");

    const nameA = tmuxSessionName(tmuxA);
    const nameB = tmuxSessionName(tmuxB);
    assert.ok(nameA && nameB, "both tmux spawns must carry a generated -s <name>");
    assert.notEqual(
      nameA,
      nameB,
      "the same issue number in two different projects must never collide on the shared tmux server"
    );

    assert.equal(runLockA.registerCalls.length, 1);
    assert.equal(runLockB.registerCalls.length, 1);
    assert.equal(runLockA.registerCalls[0].tmuxId, nameA);
    assert.equal(runLockB.registerCalls[0].tmuxId, nameB);
    assert.notEqual(
      runLockA.registerCalls[0].tmuxId,
      runLockB.registerCalls[0].tmuxId,
      "register() must be called with each project's own distinct session name"
    );
  } finally {
    cleanup();
  }
});
