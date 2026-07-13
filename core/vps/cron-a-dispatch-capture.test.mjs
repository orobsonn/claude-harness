/**
 * @description Pins dispatch()'s deterministic per-issue output-log capture (issue-<n>-output.log)
 * for cron-a-dispatch.mjs. dispatch() pre-creates a deterministic log file
 * `stateDir/issue-<n>-output.log` (mode 0600) via an injectable seam
 * `precreateLog(logPath) -> logPath|null` (default real behavior: writeFileSync then chmodSync
 * 0o600; returns null on failure). composeSessionCommand redirects ONLY the `claude -p` combined
 * output to that log (`> '<log>' 2>&1`), captures `ec=$?` immediately after, and passes the log
 * path as the 5th positional arg and `"$ec"` as the 6th to the chained
 * `node .../cron-a-exit.mjs <issue> <worktree> <body> <env> <log> "$ec"` invocation. When
 * precreateLog returns null or throws, dispatch composes the byte-identical LEGACY command (no
 * redirect, exactly 4 args to cron-a-exit.mjs). The same redirect+arg parity holds in fix-mode
 * (composeFixModeSessionCommand).
 *
 * The harness below mirrors cron-a-dispatch.test.mjs's hermetic seams (fake spawn/runLock/gh/
 * counter, real temp dirs) so dispatch runs fully hermetically here too — no real git/tmux/
 * claude/gh process is ever spawned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { dispatch } from "./cron-a-dispatch.mjs";

/** @description Fresh temp projectRoot/worktreeRoot/stateDir for one test, plus cleanup. */
function makeTempDirs() {
  const root = mkdtempSync(join(tmpdir(), "cron-a-dispatch-capture-"));
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
 * `{ command, args, env, stdin, cwd }`. Throws for any command listed in `failCommands`.
 */
function makeFakeSpawn({ failCommands = [] } = {}) {
  const calls = [];
  function spawn(command, args = [], spawnOpts = {}) {
    calls.push({ command, args, env: spawnOpts.env, stdin: spawnOpts.stdin, cwd: spawnOpts.cwd, timeout: spawnOpts.timeout });
    if (failCommands.includes(command)) {
      throw new Error(`fake spawn: ${command} failed`);
    }
    return { ok: true };
  }
  return { spawn, calls };
}

/** @description Fake run-lock seam mirroring run-lock.mjs's register(tmuxId, opts) / release(opts). */
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

/** @description Fake gh seam. Records each `gh` argv. */
function makeFakeGh() {
  const calls = [];
  function gh(args) {
    calls.push(args);
    return { ok: true };
  }
  return { gh, calls };
}

/** @description Fake per-issue attempt counter seam, backed by an in-memory map. */
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

/**
 * @description Real-behavior default for the precreateLog seam: writeFileSync then chmodSync
 * 0o600, returning the path on success or null on any failure — mirrors the production default
 * dispatch() falls back to when no `precreateLog` override is injected.
 * @param {string} logPath
 * @returns {string|null}
 */
function defaultPrecreateLog(logPath) {
  try {
    writeFileSync(logPath, "", { encoding: "utf8", mode: 0o600 });
    chmodSync(logPath, 0o600);
    return logPath;
  } catch {
    return null;
  }
}

/** @description The deterministic output-log path dispatch() must pre-create for a given issue. */
function logPathFor(stateDir, issueNumber = 42) {
  return join(stateDir, `issue-${issueNumber}-output.log`);
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
  branchExists = () => false,
  hasOpenPr = () => true,
  prHeadSha,
  precreateLog = defaultPrecreateLog,
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
    branchExists,
    hasOpenPr,
    prHeadSha,
    precreateLog,
  };
}

/** @description Locates the `tmux new-session` spawn call in a fake's recorded calls. */
function findTmuxCall(calls) {
  return calls.find((c) => c.command === "tmux");
}

/** @description The composed session-command string is the one string arg mentioning claude. */
function sessionCommandOf(tmuxCall) {
  return tmuxCall.args.find((a) => typeof a === "string" && a.includes("claude"));
}

/**
 * @description Extracts the path from a `> '<path>' 2>&1` (or unquoted `> <path> 2>&1`) redirect
 * inside a composed session command string, unquoting a single-quoted path if present.
 */
function extractLogRedirectPath(sessionCommand) {
  const quoted = sessionCommand.match(/>\s*'((?:[^'\\]|\\.)*)'\s*2>&1/);
  if (quoted) return quoted[1].replace(/\\'/g, "'");
  const bare = sessionCommand.match(/>\s*(\S+)\s*2>&1/);
  return bare ? bare[1] : undefined;
}

/** @description Minimal monorepo plugin stubs for seedOpencodeRootConfig fail-closed check. */
function plantMonorepoOcPlugins(root) {
  const dir = join(root, "core", "opencode", "plugin");
  mkdirSync(dir, { recursive: true });
  for (const name of [
    "entry-gate.ts", "plan-gate.ts", "plan-write-gate.ts", "loop-guard.ts",
    "reinject-state.ts", "version-check.ts", "harvest-guard.ts", "obs-plan-write.ts",
    "obs-eye.ts", "obs-hand.ts", "agent-idle-nudge.ts",
  ]) {
    writeFileSync(join(dir, name), `// stub ${name}\n`, "utf8");
  }
}


test("dispatch: normal dispatch with a writable stateDir redirects claude -p's combined output to issue-42-output.log, composed BEFORE the chained cron-a-exit.mjs invocation", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    await dispatch({ number: 42, body: "hello" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    const tmuxCall = findTmuxCall(fake.calls);
    assert.ok(tmuxCall, "dispatch must spawn the tmux session");
    const sessionCommand = sessionCommandOf(tmuxCall);
    assert.ok(sessionCommand, "the tmux argv must carry a composed session command string");

    const logPath = logPathFor(stateDir);
    const redirectPath = extractLogRedirectPath(sessionCommand);
    assert.ok(redirectPath, "the session command must redirect claude's combined output via `> '<log>' 2>&1`");
    assert.ok(redirectPath.endsWith("issue-42-output.log"), "the redirected path must end with issue-42-output.log");
    assert.equal(redirectPath, logPath, "the redirected path must be the deterministic stateDir/issue-42-output.log path");

    const claudeIndex = sessionCommand.indexOf("claude -p");
    const redirectIndex = sessionCommand.indexOf("2>&1");
    const exitIndex = sessionCommand.indexOf("cron-a-exit.mjs");
    assert.notEqual(claudeIndex, -1, "the session command must invoke claude -p");
    assert.notEqual(redirectIndex, -1, "the session command must carry the 2>&1 redirect");
    assert.notEqual(exitIndex, -1, "the session command must invoke node .../cron-a-exit.mjs");
    assert.ok(claudeIndex < exitIndex, "cron-a-exit.mjs must be composed AFTER the claude -p invocation");
    assert.ok(redirectIndex < exitIndex, "the 2>&1 redirect must be composed BEFORE the chained cron-a-exit.mjs invocation");
  } finally {
    cleanup();
  }
});

test('dispatch: the composed normal command captures claude\'s exit status via ec=$? and hands the log path + "$ec" as the 5th/6th positional args to cron-a-exit.mjs', async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    await dispatch({ number: 42, body: "hello" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    const sessionCommand = sessionCommandOf(findTmuxCall(fake.calls));
    assert.ok(sessionCommand);
    assert.ok(sessionCommand.includes("ec=$?"), "the session command must capture claude's exit status via ec=$?");

    const exitIdx = sessionCommand.indexOf("cron-a-exit.mjs");
    assert.notEqual(exitIdx, -1, "the session command must invoke cron-a-exit.mjs");
    const trailing = sessionCommand.slice(exitIdx + "cron-a-exit.mjs".length);

    const logPath = logPathFor(stateDir);
    const logIdxInTrailing = trailing.indexOf(logPath);
    const ecIdxInTrailing = trailing.indexOf('"$ec"');
    assert.notEqual(logIdxInTrailing, -1, "the cron-a-exit.mjs invocation must carry the log path as a positional arg");
    assert.notEqual(ecIdxInTrailing, -1, 'the cron-a-exit.mjs invocation must carry "$ec" as a positional arg');
    assert.ok(logIdxInTrailing < ecIdxInTrailing, 'the log path must precede "$ec" in the cron-a-exit.mjs argv');
  } finally {
    cleanup();
  }
});

test("dispatch: the composed normal command caps the raw output log's write side via `ulimit -f`, set BEFORE claude -p runs", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    await dispatch({ number: 42, body: "hello" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    const sessionCommand = sessionCommandOf(findTmuxCall(fake.calls));
    assert.ok(sessionCommand);

    const ulimitMatch = sessionCommand.match(/ulimit -f (\d+);/);
    assert.ok(ulimitMatch, "the session command must set a ulimit -f cap before redirecting claude -p's output");
    assert.ok(Number(ulimitMatch[1]) > 0, "the ulimit -f cap must be a positive block count");

    const ulimitIndex = sessionCommand.indexOf("ulimit -f");
    const claudeIndex = sessionCommand.indexOf("claude -p");
    assert.ok(
      ulimitIndex !== -1 && ulimitIndex < claudeIndex,
      "ulimit -f must be composed BEFORE the claude -p invocation it caps"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: stdin pipe targets the runner (not ulimit) so the prompt reaches claude/opencode", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    // Claude path (default)
    {
      const fake = makeFakeSpawn();
      await dispatch({ number: 42, body: "hello" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));
      const sessionCommand = sessionCommandOf(findTmuxCall(fake.calls));
      assert.ok(sessionCommand);
      assert.match(
        sessionCommand,
        /\}\s*\|\s*claude -p/,
        "the body/trigger pipe must feed claude -p directly (not ulimit)"
      );
      assert.equal(
        /\}\s*\|\s*ulimit/.test(sessionCommand),
        false,
        "ulimit must never sit between the pipe and the runner"
      );
    }
    // OpenCode path — same invariant; empty stdin was the production failure mode
    {
      // Custom spawn that REALLY materializes `git worktree add` as a real directory
      // (mkdirSync) so seedOpencodeRootConfig's writeFileSync into the worktree has a real
      // destination to land in, mirroring cron-a-dispatch.test.mjs's "seeds opencode.json
      // into the worktree on the real dispatch path" fixture.
      const calls = [];
      const spawn = (command, args = [], spawnOpts = {}) => {
        calls.push({ command, args, env: spawnOpts.env, stdin: spawnOpts.stdin, cwd: spawnOpts.cwd, timeout: spawnOpts.timeout });
        if (command === "git" && args[0] === "worktree" && args[1] === "add") {
          mkdirSync(args[2], { recursive: true });
          plantMonorepoOcPlugins(args[2]);
        }
        return { ok: true };
      };
      await dispatch(
        { number: 43, body: "hello oc" },
        { ...baseOpts({ projectRoot, worktreeRoot, stateDir, spawn }), runtime: "opencode" }
      );
      const sessionCommand = sessionCommandOf(findTmuxCall(calls));
      assert.ok(sessionCommand);
      assert.match(
        sessionCommand,
        /\}\s*\|\s*opencode run/,
        "the body/trigger pipe must feed opencode run directly (not ulimit)"
      );
      assert.equal(
        /\}\s*\|\s*ulimit/.test(sessionCommand),
        false,
        "ulimit must never sit between the pipe and the OC runner"
      );
    }
  } finally {
    cleanup();
  }
});

test("dispatch: an injected precreateLog seam that THROWS falls back to the legacy command with no ulimit -f cap (nothing to cap without a redirect)", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fake.spawn,
      precreateLog: () => {
        throw new Error("boom");
      },
    });
    await dispatch({ number: 42, body: "hello" }, opts);

    const sessionCommand = sessionCommandOf(findTmuxCall(fake.calls));
    assert.ok(sessionCommand);
    assert.equal(
      sessionCommand.includes("ulimit -f"),
      false,
      "the byte-identical legacy fallback must not set a ulimit -f cap (there is no redirected log to cap)"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: normal dispatch actually pre-creates stateDir/issue-42-output.log with mode 0600 before the tmux spawn runs", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    await dispatch({ number: 42, body: "hello" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    const logPath = logPathFor(stateDir);
    assert.ok(existsSync(logPath), "dispatch must have pre-created the deterministic output log file");
    const mode = statSync(logPath).mode & 0o777;
    assert.equal(mode, 0o600, "the pre-created log file must be owner-read-write-only (0600)");
  } finally {
    cleanup();
  }
});

test("dispatch: an injected precreateLog seam that THROWS falls back to the byte-identical legacy command (no redirect, no ec capture, single-quoted cron-a-exit.mjs path, exactly 4 positional args)", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fake.spawn,
      precreateLog: () => {
        throw new Error("boom");
      },
    });
    await dispatch({ number: 42, body: "hello" }, opts);

    const sessionCommand = sessionCommandOf(findTmuxCall(fake.calls));
    assert.ok(sessionCommand);
    assert.equal(
      sessionCommand.includes("2>&1"),
      false,
      "a throwing precreateLog must fall back to the legacy command with no output redirect"
    );
    assert.equal(
      sessionCommand.includes("ec=$?"),
      false,
      "a throwing precreateLog must fall back to the legacy command with no exit-status capture"
    );

    const gitCall = fake.calls.find((c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "add");
    assert.ok(gitCall, "dispatch must run git worktree add");
    const worktreePath = gitCall.args[2];

    assert.match(
      sessionCommand,
      /node '[^']*cron-a-exit\.mjs' 42 /,
      "the byte-identical legacy fallback must single-quote the cron-a-exit.mjs path (shellQuoteSingle), never interpolate it bare"
    );

    const quotedExitMatch = sessionCommand.match(/'([^']*cron-a-exit\.mjs)'/);
    assert.ok(quotedExitMatch, "the session command must invoke the single-quoted cron-a-exit.mjs path");
    const closingQuoteIdx = sessionCommand.indexOf(`${quotedExitMatch[1]}'`) + quotedExitMatch[1].length + 1;
    const trailing = sessionCommand.slice(closingQuoteIdx);

    const bodyFileMatch = sessionCommand.match(/cat < '([^']*)'/);
    const envFileMatch = sessionCommand.match(/\. '([^']*)'; set \+a;/);
    assert.ok(bodyFileMatch, "the session command must redirect the body file via cat < '<bodyfile>'");
    assert.ok(envFileMatch, "the session command must source the env file via . '<envfile>'");
    const bodyFile = bodyFileMatch[1];
    const envFile = envFileMatch[1];

    assert.equal(
      trailing,
      ` 42 ${worktreePath} ${bodyFile} ${envFile}`,
      "the legacy fallback must carry exactly the 4 positional args (issue, worktree, body, env) after the quoted cron-a-exit.mjs path"
    );
    assert.equal(trailing.includes("output.log"), false, "the legacy fallback must not carry the log path");
    assert.equal(trailing.includes('"$ec"'), false, "the legacy fallback must not carry the exit-status capture");
  } finally {
    cleanup();
  }
});

test("dispatch: the composed normal redirected session command is shell-syntax-valid (`sh -n`, P10 regression guard)", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    await dispatch({ number: 42, body: "hello" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    const sessionCommand = sessionCommandOf(findTmuxCall(fake.calls));
    assert.ok(sessionCommand);
    const res = spawnSync("sh", ["-n", "-c", sessionCommand], { encoding: "utf8" });
    assert.equal(res.status, 0, `the redirected session command must be shell-syntax-valid; sh -n said: ${res.stderr}`);
  } finally {
    cleanup();
  }
});

test('dispatch: fix-mode dispatch ALSO redirects claude -p\'s combined output to issue-42-output.log and carries the log path + "$ec" to cron-a-exit.mjs (parity with the normal path)', async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const sha = "a1b2c3d4e5f6";
    writeFileSync(
      join(stateDir, "fix-findings-42.json"),
      JSON.stringify({ changedFiles: ["src/foo.ts"], sha }),
      "utf8"
    );

    const fake = makeFakeSpawn();
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fake.spawn,
      branchExists: () => true,
      hasOpenPr: () => true,
      prHeadSha: () => sha,
    });
    await dispatch({ number: 42, body: "hello" }, opts);

    const sessionCommand = sessionCommandOf(findTmuxCall(fake.calls));
    assert.ok(sessionCommand, "the fix-mode dispatch must still compose a tmux session command");

    const logPath = logPathFor(stateDir);
    const redirectPath = extractLogRedirectPath(sessionCommand);
    assert.ok(redirectPath, "the fix-mode session command must also redirect claude's combined output via `> '<log>' 2>&1`");
    assert.equal(redirectPath, logPath, "the fix-mode redirect must target the same deterministic issue-42-output.log path");

    const exitIdx = sessionCommand.indexOf("cron-a-exit.mjs");
    assert.notEqual(exitIdx, -1, "the fix-mode session command must invoke cron-a-exit.mjs");
    const trailing = sessionCommand.slice(exitIdx + "cron-a-exit.mjs".length);
    const logIdxInTrailing = trailing.indexOf(logPath);
    const ecIdxInTrailing = trailing.indexOf('"$ec"');
    assert.notEqual(logIdxInTrailing, -1, "the fix-mode cron-a-exit.mjs invocation must carry the log path as a positional arg");
    assert.notEqual(ecIdxInTrailing, -1, 'the fix-mode cron-a-exit.mjs invocation must carry "$ec" as a positional arg');
    assert.ok(logIdxInTrailing < ecIdxInTrailing, 'the log path must precede "$ec" in the fix-mode cron-a-exit.mjs argv');
    assert.ok(
      sessionCommand.includes("ulimit -f") && sessionCommand.indexOf("ulimit -f") < sessionCommand.indexOf("claude -p"),
      "the fix-mode session command must also cap the raw log via ulimit -f before claude -p runs (parity with the normal path)"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: a pre-existing issue-42-output.log with a permissive mode is re-tightened to 0600 by precreateLog", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const logPath = logPathFor(stateDir);
    writeFileSync(logPath, "", { encoding: "utf8", mode: 0o644 });
    chmodSync(logPath, 0o644);

    const fake = makeFakeSpawn();
    await dispatch({ number: 42, body: "hello" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    const mode = statSync(logPath).mode & 0o777;
    assert.equal(mode, 0o600, "precreateLog must re-apply owner-only 0600 permissions even onto a pre-existing permissive log file");
  } finally {
    cleanup();
  }
});
