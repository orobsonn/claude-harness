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
 *
 * RESUME-MODE (branch-existence probe): dispatch is also handed an injected `branchExists(branch)`
 * seam (a plain predicate, independent of the spawn fake so its result is deterministic even when
 * `failCommands` makes every `git` spawn throw). When the branch already exists, `git worktree add`
 * must check it out WITHOUT `-b`, and the pre-registration failure-recovery path must NEVER run
 * `git branch -D <branch>` against it — deleting the branch of an already-existing (possibly
 * PR-carrying) branch would destroy work. When the branch does not exist, the original fresh `-b`
 * path is unchanged. Every existing test above exercises the fresh path implicitly via
 * `baseOpts`'s default `branchExists: () => false`.
 *
 * FRESH-BASE FETCH (fresh/orphan branch only): before `git worktree add` runs for a branch that
 * does not (yet) exist, dispatch must run `git fetch origin main` in `projectRoot`, and the
 * worktree-add's start-point must be the literal `origin/main` — so a fresh branch's tip is
 * always built on an up-to-date base rather than whatever stale commit `projectRoot`'s checked-out
 * ref happened to be at. The RESUME path (branch already exists) never fetches and never carries
 * a start-point argument. The fetch also carries a spawn timeout: it is the only synchronous
 * network I/O performed while the run-lock is held and before any tmux session exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, cpSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { dispatch, prepareOpencodeDataHome, seedOpencodeRootConfig } from "./cron-a-dispatch.mjs";

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
    calls.push({ command, args, env: spawnOpts.env, stdin: spawnOpts.stdin, cwd: spawnOpts.cwd, timeout: spawnOpts.timeout });
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
  branchExists = () => false,
  hasOpenPr = () => true,
  freeMem = () => Number.POSITIVE_INFINITY,
  memGuardBytes,
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
    freeMem,
    memGuardBytes,
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
  // The composed session command is ALWAYS the last arg of `tmux new-session ... <sessionCommand>`;
  // matching a bare "claude" substring is unreliable (it hits a tmpdir path containing "claude", and
  // never matches the opencode `opencode run` runner). The last arg is runtime- and path-agnostic.
  return tmuxCall.args.at(-1);
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

    const git42 = fake42.calls.find((c) => c.command === "git" && c.args[0] === "worktree");
    assert.ok(git42, "dispatch must invoke git");
    assert.deepEqual(git42.args.slice(0, 2), ["worktree", "add"], "must run `git worktree add`");
    const path42 = git42.args[2];
    assert.notEqual(path42, projectRoot, "the worktree path must differ from the project's primary working tree");
    assert.equal(git42.args[3], "-b");
    assert.equal(git42.args[4], "harness/42");

    const fake43 = makeFakeSpawn();
    dispatch({ number: 43, body: "hi" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake43.spawn }));

    const git43 = fake43.calls.find((c) => c.command === "git" && c.args[0] === "worktree");
    assert.ok(git43);
    assert.equal(git43.args[4], "harness/43");
    assert.notEqual(git43.args[2], path42, "two different issues must get distinct worktree paths");
  } finally {
    cleanup();
  }
});

test("dispatch: drops the ephemeral .claude/plans/ from the copied worktree harness, keeping skills/ and memory/ (P11)", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    // projectRoot .claude: a STALE plan dir (a past feature's history the physical `cp -a` would drag
    // in), plus skills/ and memory/ that MUST survive (the shipper commits memory back).
    mkdirSync(join(projectRoot, ".claude", "plans", "old-feature"), { recursive: true });
    writeFileSync(join(projectRoot, ".claude", "plans", "old-feature", "execution-plan.json"), '{"tasks":[1,2,3]}');
    mkdirSync(join(projectRoot, ".claude", "skills"), { recursive: true });
    writeFileSync(join(projectRoot, ".claude", "skills", "keep.md"), "skill");
    mkdirSync(join(projectRoot, ".claude", "memory"), { recursive: true });
    writeFileSync(join(projectRoot, ".claude", "memory", "MEMORY.md"), "mem");

    // Spawn seam that REALLY runs the fs ops the P11 fix depends on: `git worktree add` creates the
    // worktree path, `cp -a` copies .claude into it. Everything else is a no-op.
    const calls = [];
    const spawn = (command, args = []) => {
      calls.push({ command, args });
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        mkdirSync(args[2], { recursive: true });
        plantMonorepoOcPlugins(args[2]);
      } else if (command === "cp") {
        cpSync(args[1], args[2], { recursive: true });
      }
      return { ok: true };
    };

    dispatch({ number: 77, body: "b" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn }));

    const claudeDst = calls.find((c) => c.command === "cp").args[2];
    assert.ok(!existsSync(join(claudeDst, "plans")), "the ephemeral plans/ must be dropped from the worktree");
    assert.ok(existsSync(join(claudeDst, "skills", "keep.md")), "skills/ must survive the copy");
    assert.ok(existsSync(join(claudeDst, "memory", "MEMORY.md")), "memory/ must survive (the shipper commits it back)");
  } finally {
    cleanup();
  }
});

test("dispatch: when runtime=opencode, copies .opencode and drops ephemeral plans/ (mirror of P11)", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    plantMonorepoOcPlugins(projectRoot);
    mkdirSync(join(projectRoot, ".opencode", "plans", "old-feature"), { recursive: true });
    writeFileSync(join(projectRoot, ".opencode", "plans", "old-feature", "execution-plan.json"), '{"tasks":[1]}');
    mkdirSync(join(projectRoot, ".opencode", "plugin"), { recursive: true });
    writeFileSync(join(projectRoot, ".opencode", "plugin", "keep.ts"), "plugin");

    const calls = [];
    const spawn = (command, args = []) => {
      calls.push({ command, args });
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        mkdirSync(args[2], { recursive: true });
      } else if (command === "cp") {
        cpSync(args[1], args[2], { recursive: true });
      }
      return { ok: true };
    };

    dispatch(
      { number: 78, body: "b" },
      { ...baseOpts({ projectRoot, worktreeRoot, stateDir, spawn }), runtime: "opencode" }
    );

    const ocCp = calls.find((c) => c.command === "cp" && String(c.args[1]).endsWith(".opencode"));
    assert.ok(ocCp, "runtime=opencode must cp -a .opencode into the worktree when src exists");
    const ocDst = ocCp.args[2];
    assert.ok(!existsSync(join(ocDst, "plans")), "the ephemeral .opencode/plans/ must be dropped from the worktree");
    // Materialize from monorepo overwrites framework-owned plugin/ with entry-gate etc.; keep.ts
    // is non-framework. After materialize, critical runtime must exist.
    assert.ok(
      existsSync(join(ocDst, "skills", "triaging-requests", "SKILL.md")),
      "materialize must plant skills after cp -a stub"
    );
  } finally {
    cleanup();
  }
});

test("prepareOpencodeDataHome: fresh empty dir + auth only (never copies opencode.db)", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-data-prep-"));
  try {
    const homeDir = join(root, "home");
    const stateDir = join(root, "state");
    mkdirSync(join(homeDir, ".local", "share", "opencode"), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(homeDir, ".local", "share", "opencode", "auth.json"), '{"x":1}');
    writeFileSync(join(homeDir, ".local", "share", "opencode", "opencode.db"), "FAT-DB-MUST-NOT-COPY");
    const dataHome = prepareOpencodeDataHome({ stateDir, issueNumber: 275, homeDir });
    assert.equal(dataHome, join(stateDir, "oc-data-275"));
    assert.ok(existsSync(join(dataHome, "opencode", "auth.json")), "auth.json must be seeded");
    assert.equal(readFileSync(join(dataHome, "opencode", "auth.json"), "utf8"), '{"x":1}');
    assert.ok(!existsSync(join(dataHome, "opencode", "opencode.db")), "fat interactive DB must never be copied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



/**
 * @description Minimal complete monorepo OC runtime under root/core/opencode so
 * materializeOpencodeRuntime / seedOpencodeRootConfig can fail-closed-pass.
 * @param {string} root
 */
function plantMonorepoOcPlugins(root) {
  const oc = join(root, "core", "opencode");
  const dir = join(oc, "plugin");
  mkdirSync(dir, { recursive: true });
  for (const name of [
    "entry-gate.ts",
    "marker-authority.ts",
    "plan-gate.ts",
    "planner-recovery.ts",
    "plan-write-gate.ts",
    "reinject-state.ts",
    "version-check.ts",
    "obs-plan-write.ts",
    "obs-eye.ts",
    "obs-hand.ts",
    "agent-idle-nudge.ts",
    "autonomy-controller.ts",
  ]) {
    writeFileSync(join(dir, name), `// stub ${name}\n`, "utf8");
  }
  for (const skill of ["triaging-requests", "orchestrating-delivery", "brainstorming"]) {
    const d = join(oc, "skills", skill);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `# ${skill}\n`, "utf8");
  }
  mkdirSync(join(oc, "tools"), { recursive: true });
  writeFileSync(join(oc, "tools", "classify.ts"), "// classify\n", "utf8");
  mkdirSync(join(oc, "agents"), { recursive: true });
  writeFileSync(join(oc, "agents", "build.md"), "# build\n", "utf8");
  const libDir = join(oc, "lib");
  mkdirSync(libDir, { recursive: true });
  for (const name of [
    "gate-state.mjs",
    "entry-decide.mjs",
    "dispatch-scope.mjs",
    "hand-records.mjs",
    "planner-state.mjs",
    "obs-emit.mjs",
    "plan-hash.mjs",
    "planner-artifact.mjs",
    "roles.mjs",
    "task-dispatch-identity.mjs",
  ]) {
    writeFileSync(join(libDir, name), `// stub ${name}\n`, "utf8");
  }
  const sharedLib = join(root, "core", "shared", "lib");
  mkdirSync(sharedLib, { recursive: true });
  writeFileSync(join(sharedLib, "path-helpers.mjs"), "export const x = 1;\n", "utf8");
}

test("seedOpencodeRootConfig: copies opencode.json + AGENTS.md from projectRoot (permissions vendored)", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-seed-"));
  try {
    const projectRoot = join(root, "proj");
    const worktree = join(root, "wt");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    plantMonorepoOcPlugins(projectRoot);
    writeFileSync(join(projectRoot, "opencode.json"), JSON.stringify({ permission: { external_directory: "allow", bash: { "*": "allow" } } }));
    writeFileSync(join(projectRoot, "AGENTS.md"), "# agents");
    const r = seedOpencodeRootConfig(worktree, projectRoot);
    assert.deepEqual(r.copied.sort(), ["AGENTS.md", "opencode.json"]);
    assert.equal(r.wroteExample, false);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.external_directory, "allow");
    assert.equal(cfg.permission.bash["*"], "allow");
    assert.equal(readFileSync(join(worktree, "AGENTS.md"), "utf8"), "# agents");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: falls back to opencode.json.example when root config missing", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-seed-ex-"));
  try {
    const projectRoot = join(root, "proj");
    const worktree = join(root, "wt");
    mkdirSync(worktree, { recursive: true });
    plantMonorepoOcPlugins(projectRoot);
    writeFileSync(
      join(projectRoot, "core", "opencode", "opencode.json.example"),
      JSON.stringify({ permission: { external_directory: "allow" } })
    );
    const r = seedOpencodeRootConfig(worktree, projectRoot);
    assert.equal(r.wroteExample, true);
    assert.ok(existsSync(join(worktree, "opencode.json")));
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.external_directory, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * @description Last-match-wins resolver over an OC `permission.bash` map, mirroring the REAL
 * OpenCode permission engine (`Permission.evaluate` resolves with `Array.prototype.findLast` —
 * confirmed by reading the installed `opencode` binary's minified source; see
 * cron-a-dispatch-seed.test.mjs for the fuller doc comment on the same helper).
 * @param {Record<string,string>} bashMap
 * @param {string} command
 * @returns {string}
 */
function resolveBash(bashMap, command) {
  const entries = Object.entries(bashMap).filter(([pattern]) => pattern !== "*");
  for (let i = entries.length - 1; i >= 0; i--) {
    const [pattern, action] = entries[i];
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (new RegExp(`^${escaped}$`).test(command)) return action;
  }
  return bashMap["*"];
}

test("seedOpencodeRootConfig: git push --force-with-lease survives the union merge from a realistic project source config while raw --force stays denied (#ac-2.1/#ac-2.2/#ac-2.3)", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-seed-force-lease-"));
  try {
    const projectRoot = join(root, "proj");
    const worktree = join(root, "wt");
    mkdirSync(worktree, { recursive: true });
    plantMonorepoOcPlugins(projectRoot);
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "allow",
          external_directory: "allow",
          bash: {
            "*": "ask",
            "git push": "allow",
            // The lease allow MUST be ordered AFTER the broad --force/-f denies it collides
            // with: OpenCode's engine resolves permission.bash with findLast (last-match-wins),
            // not "most specific rule wins" — placing it first would have the broader deny win.
            "git push --force*": "deny",
            "git push * --force*": "deny",
            "git push -f*": "deny",
            "git push * -f*": "deny",
            "git reset --hard*": "deny",
            "git clean -f*": "deny",
            "git push --force-with-lease*": "allow",
            "git push * --force-with-lease*": "allow",
          },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    // The worktree seed always forces question back to 'deny' — the local project source's
    // 'allow' is intentionally NOT propagated here (#ac-1.2, worktree-only override).
    assert.equal(cfg.permission.question, "deny");
    assert.equal(
      resolveBash(cfg.permission.bash, "git push --force-with-lease origin minha-branch"),
      "allow",
      "git push --force-with-lease must survive the seed's deny-union merge as an allow",
    );
    assert.equal(
      resolveBash(cfg.permission.bash, "git push --force origin main"),
      "deny",
      "git push --force (raw) must stay denied after the seed's deny-union merge",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch: runtime=opencode injects XDG_DATA_HOME + HARNESS_OC_DATA_HOME into the env-file", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const homeDir = join(stateDir, "fake-home");
    mkdirSync(join(homeDir, ".local", "share", "opencode"), { recursive: true });
    writeFileSync(join(homeDir, ".local", "share", "opencode", "auth.json"), "{}");
    mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
    plantMonorepoOcPlugins(projectRoot);

    // Spawn seam that REALLY materializes the worktree path (mkdirSync on `git worktree add`) so
    // seedOpencodeRootConfig has a real destination dir to write into — dispatch now aborts BEFORE
    // spawning tmux when the worktree does not actually exist on disk (HIGH security fix: never
    // spawn a headless session without the hardened permission config successfully seeded).
    const calls = [];
    const spawn = (command, args = [], spawnOpts = {}) => {
      calls.push({ command, args, env: spawnOpts.env, stdin: spawnOpts.stdin, cwd: spawnOpts.cwd });
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        mkdirSync(args[2], { recursive: true });
      } else if (command === "cp") {
        cpSync(args[1], args[2], { recursive: true });
      }
      return { ok: true };
    };

    dispatch(
      { number: 275, body: "b" },
      { ...baseOpts({ projectRoot, worktreeRoot, stateDir, spawn }), runtime: "opencode", homeDir }
    );

    const expected = join(stateDir, "oc-data-275");
    assert.ok(existsSync(join(expected, "opencode", "auth.json")), "oc-data dir must exist after dispatch");
    // env-file is cleaned only on exit; during dispatch it is still on disk until session ends —
    // but spawn failure paths may remove it. Prefer asserting via the env handed to tmux spawn.
    const tmux = findTmuxCall(calls);
    assert.ok(tmux, "tmux must be spawned");
    const envFromSpawn = tmux.env || {};
    // spawn may receive env via spawnOpts; also the session command sources the env-file.
    // Fall back to reading any remaining issue-*-env-*.env under stateDir.
    let envBody = "";
    if (envFromSpawn.XDG_DATA_HOME) {
      assert.equal(envFromSpawn.XDG_DATA_HOME, expected);
      assert.equal(envFromSpawn.HARNESS_OC_DATA_HOME, expected);
    } else {
      const envFiles = readdirSync(stateDir).filter((n) => n.startsWith("issue-275-env-"));
      assert.ok(envFiles.length >= 1, "env-file must exist after successful dispatch");
      envBody = readFileSync(join(stateDir, envFiles[0]), "utf8");
      assert.ok(envBody.includes(`XDG_DATA_HOME='${expected}'`) || envBody.includes(`XDG_DATA_HOME=${expected}`), envBody);
      assert.ok(envBody.includes("HARNESS_OC_DATA_HOME="), "HARNESS_OC_DATA_HOME must be set for exit cleanup");
    }
  } finally {
    cleanup();
  }
});

test("dispatch: the composed tmux session command is shell-syntax-valid despite TRIGGER_PROMPT containing single quotes (P10 — no early-close / # comment truncation)", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    dispatch({ number: 92, body: "b" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));
    const sessionCommand = sessionCommandOf(findTmuxCall(fake.calls));
    assert.ok(sessionCommand, "a tmux session command must exist");
    // The `claude -p` invocation must survive — the old bug let a single quote in the TRIGGER close
    // the printf string early and a `#` (from "Closes #<issue>") comment out the rest of the pipe.
    assert.ok(sessionCommand.includes("claude -p"), "the claude -p invocation must not be swallowed");
    // Syntax-check the WHOLE command without executing it. `sh -n` returns non-zero on the broken
    // quoting; it passes only when the single quotes are properly escaped.
    const res = spawnSync("sh", ["-n", "-c", sessionCommand], { encoding: "utf8" });
    assert.equal(res.status, 0, `composed session command must be shell-syntax-valid; sh -n said: ${res.stderr}`);
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

    const gitCall = fake.calls.find((c) => c.command === "git" && c.args[0] === "worktree");
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

test("dispatch: branch harness/<n> EXISTS and carries an OPEN PR → resume it (worktree add WITHOUT -b), never deleted", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, branchExists: () => true, hasOpenPr: () => true })
    );

    const gitCall = fake.calls.find(
      (c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "add"
    );
    assert.ok(gitCall, "dispatch must run `git worktree add` when resuming a branch with an open PR");
    assert.deepEqual(
      gitCall.args,
      ["worktree", "add", gitCall.args[2], "harness/42"],
      "resuming a branch with an open PR must check it out with exactly `worktree add <path> harness/42` — no -b flag"
    );
    const branchDelete = fake.calls.find(
      (c) => c.command === "git" && c.args[0] === "branch" && c.args[1] === "-D"
    );
    assert.equal(branchDelete, undefined, "a branch carrying an open PR must NEVER be deleted (would orphan the PR)");
  } finally {
    cleanup();
  }
});

test("dispatch: branch harness/<n> EXISTS but has NO open PR (orphan from a died run) → delete it, then rebuild FRESH with -b (no stale resurrection)", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, branchExists: () => true, hasOpenPr: () => false })
    );

    const branchDelete = fake.calls.find(
      (c) => c.command === "git" && c.args[0] === "branch" && c.args[1] === "-D" && c.args[2] === "harness/42"
    );
    assert.ok(branchDelete, "an orphan branch (exists, no open PR) must be deleted before rebuilding");

    const addCall = fake.calls.find(
      (c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "add"
    );
    assert.ok(addCall, "dispatch must run `git worktree add`");
    assert.ok(addCall.args.includes("-b"), "an orphan branch must be rebuilt FRESH with -b, never resumed onto stale commits");
    assert.equal(addCall.args[addCall.args.indexOf("-b") + 1], "harness/42", "the fresh -b must target harness/42");
    // Ordering: the delete must precede the worktree-add rebuild.
    assert.ok(
      fake.calls.indexOf(branchDelete) < fake.calls.indexOf(addCall),
      "the orphan branch must be deleted BEFORE the fresh worktree add",
    );
  } finally {
    cleanup();
  }
});

test("dispatch: given branch harness/<n> EXISTS and the worktree prep then FAILS, recovery must NEVER invoke `git branch -D harness/<n>`", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn({ failCommands: ["git"] });
    const runLock = makeFakeRunLock({ pid: 111, acquire_ts: 5000 });
    const gh = makeFakeGh();
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fake.spawn,
      runLock,
      gh: gh.gh,
      branchExists: () => true,
    });

    try {
      dispatch({ number: 42, body: "hello" }, opts);
    } catch {
      // A spawn-failure path may legitimately surface as a thrown error after cleanup runs —
      // either way, the observable below is what this test pins.
    }

    const branchDeleteCall = fake.calls.find(
      (c) => c.command === "git" && c.args[0] === "branch" && c.args[1] === "-D" && c.args[2] === "harness/42"
    );
    assert.equal(
      branchDeleteCall,
      undefined,
      "an already-existing branch (e.g. one carrying an open PR) must never be deleted by the failure-recovery path"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: given branch harness/<n> does NOT exist (probe fails), the git worktree add argv includes -b harness/<n> (fresh path unchanged)", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, branchExists: () => false })
    );

    const gitCall = fake.calls.find(
      (c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "add"
    );
    assert.ok(gitCall, "dispatch must run `git worktree add` for a fresh branch");
    assert.ok(gitCall.args.includes("-b"), "a fresh (non-existent) branch must still be created with -b");
    assert.equal(
      gitCall.args[gitCall.args.indexOf("-b") + 1],
      "harness/42",
      "the -b flag must target harness/42, unchanged from the pre-resume-mode fresh path"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: a FRESH branch runs `git fetch origin main` in projectRoot BEFORE `git worktree add` (#ac-1.1)", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, branchExists: () => false })
    );

    const fetchIndex = fake.calls.findIndex(
      (c) => c.command === "git" && Array.isArray(c.args) && c.args[0] === "fetch"
    );
    assert.notEqual(fetchIndex, -1, "dispatch must run a `git fetch` spawn for a fresh branch");
    const fetchCall = fake.calls[fetchIndex];
    assert.deepEqual(fetchCall.args, ["fetch", "origin", "main"], "the fetch must be exactly `git fetch origin main`");
    assert.equal(fetchCall.cwd, projectRoot, "the fetch must run with cwd === projectRoot");

    const addIndex = fake.calls.findIndex(
      (c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "add"
    );
    assert.notEqual(addIndex, -1, "dispatch must run `git worktree add`");
    assert.ok(fetchIndex < addIndex, "the fetch must be recorded BEFORE the worktree-add call");
  } finally {
    cleanup();
  }
});

test("dispatch: the fresh-base `git fetch` carries a spawn timeout so a hung origin cannot block dispatch while the run-lock is held", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, branchExists: () => false })
    );

    const fetchCall = fake.calls.find((c) => c.command === "git" && c.args[0] === "fetch");
    assert.ok(fetchCall, "dispatch must run a `git fetch` spawn for a fresh branch");
    assert.equal(
      typeof fetchCall.timeout,
      "number",
      "the fetch must pass a numeric spawn timeout — spawnSync without one blocks forever on a hung origin"
    );
    assert.ok(fetchCall.timeout > 0, "the fetch timeout must be a positive wall-clock ceiling");
  } finally {
    cleanup();
  }
});

test("dispatch: a FRESH branch's `git worktree add` argv starts the new branch tip at origin/main (#ac-1.2)", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, branchExists: () => false })
    );

    const addCall = fake.calls.find(
      (c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "add"
    );
    assert.ok(addCall, "dispatch must run `git worktree add`");
    assert.deepEqual(
      addCall.args,
      ["worktree", "add", addCall.args[2], "-b", "harness/42", "origin/main"],
      "a fresh branch must be created with a start-point of literal origin/main"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: a RESUMED branch (exists, open PR) runs no `git fetch` and its `git worktree add` argv carries no start-point (#ac-1.3)", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, branchExists: () => true, hasOpenPr: () => true })
    );

    const fetchCall = fake.calls.find((c) => c.command === "git" && c.args[0] === "fetch");
    assert.equal(fetchCall, undefined, "a resumed branch must never run `git fetch`");

    const addCall = fake.calls.find(
      (c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "add"
    );
    assert.ok(addCall, "dispatch must run `git worktree add`");
    assert.deepEqual(
      addCall.args,
      ["worktree", "add", addCall.args[2], "harness/42"],
      "resuming an existing branch must check it out with no -b and no start-point"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: a FRESH branch whose `git fetch origin main` spawn throws never reaches `git worktree add`, releases via harness:ready relabel, skips register + attempt-counter, and resolves { ok: false } (#ac-1.4)", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const counter = makeFakeCounter();
    const fake = makeFakeSpawn({ failCommands: ["git"] });
    const runLock = makeFakeRunLock({ pid: 111, acquire_ts: 5000 });
    const gh = makeFakeGh();
    const opts = baseOpts({
      projectRoot,
      worktreeRoot,
      stateDir,
      spawn: fake.spawn,
      runLock,
      gh: gh.gh,
      counter,
      branchExists: () => false,
    });

    const result = await dispatch({ number: 42, body: "hello" }, opts);

    const worktreeAddCalls = fake.calls.filter(
      (c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "add"
    );
    assert.equal(
      worktreeAddCalls.length,
      0,
      "the fetch throwing must abort BEFORE `git worktree add` ever runs — no `git worktree add` call may be recorded"
    );
    assert.equal(runLock.registerCalls.length, 0, "register() must never be called when the fetch spawn fails");

    const relabelCall = gh.calls.find(
      (args) =>
        args.includes("--remove-label") &&
        args[args.indexOf("--remove-label") + 1] === "harness:in-progress" &&
        args.includes("--add-label") &&
        args[args.indexOf("--add-label") + 1] === "harness:ready"
    );
    assert.ok(
      relabelCall,
      "dispatch must relabel the issue --remove-label harness:in-progress --add-label harness:ready"
    );

    assert.equal(counter.read(42, { stateDir }), 0, "a fetch failure must not consume a retry attempt");
    assert.deepEqual(result, { ok: false, reason: "worktree-add" }, "dispatch must surface its stable failure reason");
  } finally {
    cleanup();
  }
});

test("mem-guard: below-threshold free memory aborts before any heavy spawn", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, freeMem: () => 524288000 })
    );

    assert.ok(
      !fake.calls.some((c) => c.command === "git" && c.args[0] === "worktree"),
      "a below-threshold memory guard must abort before any `git worktree` spawn"
    );
    assert.ok(
      !fake.calls.some((c) => c.command === "tmux"),
      "a below-threshold memory guard must abort before any `tmux` spawn"
    );
  } finally {
    cleanup();
  }
});

test("mem-guard: below-threshold relabels the issue back to harness:ready", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const gh = makeFakeGh();
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, gh: gh.gh, freeMem: () => 524288000 })
    );

    const relabelCall = gh.calls.find(
      (args) => args.includes("--add-label") && args[args.indexOf("--add-label") + 1] === "harness:ready"
    );
    assert.ok(relabelCall, "dispatch must relabel the issue back to harness:ready on a below-threshold memory abort");
    assert.ok(relabelCall.includes("harness:in-progress"), "the relabel must move the issue off harness:in-progress");
  } finally {
    cleanup();
  }
});

test("mem-guard: below-threshold releases the run-lock once and never registers", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const runLock = makeFakeRunLock({ pid: 111, acquire_ts: 5000 });
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, runLock, freeMem: () => 524288000 })
    );

    assert.equal(runLock.releaseCalls.length, 1, "a below-threshold memory abort must release the run-lock exactly once");
    assert.equal(runLock.registerCalls.length, 0, "register() must never be called when the memory guard aborts");
  } finally {
    cleanup();
  }
});

test("mem-guard: below-threshold charges no retry attempt", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const counter = makeFakeCounter();
    assert.equal(counter.read(42, { stateDir }), 0);

    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, counter, freeMem: () => 524288000 })
    );

    assert.equal(counter.read(42, { stateDir }), 0, "a below-threshold memory abort must not consume a retry attempt");
  } finally {
    cleanup();
  }
});

test("mem-guard: below-threshold returns the {ok:false} recovery shape", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const result = await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, freeMem: () => 524288000 })
    );

    assert.deepEqual(result, { ok: false, reason: "mem-guard" }, "a below-threshold memory guard must surface its reason");
  } finally {
    cleanup();
  }
});

test("#468 dispatch records a short stable reason per failed attempt without changing recovery", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const first = await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, freeMem: () => 524288000 })
    );
    const failurePath = join(stateDir, "issue-42-dispatch-failure.json");
    const mem = JSON.parse(readFileSync(failurePath, "utf8"));
    assert.deepEqual(first, { ok: false, reason: "mem-guard" });
    assert.equal(mem.reason, "mem-guard");
    assert.match(mem.ts, /^\d{4}-\d{2}-\d{2}T/);

    const second = await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, buildScopedEnv: () => { throw new Error("secret path"); } })
    );
    const env = JSON.parse(readFileSync(failurePath, "utf8"));
    assert.deepEqual(second, { ok: false, reason: "env-build" });
    assert.equal(env.reason, "env-build", "raw exception text must never reach durable evidence");
  } finally {
    cleanup();
  }
});

test("#468 a successful dispatch clears stale failure evidence only after tmux starts", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const failurePath = join(stateDir, "issue-42-dispatch-failure.json");
    writeFileSync(failurePath, JSON.stringify({ reason: "mem-guard", ts: "old" }));
    const result = await dispatch({ number: 42, body: "hi" }, baseOpts({ projectRoot, worktreeRoot, stateDir }));
    assert.equal(result.ok, true);
    assert.equal(existsSync(failurePath), false, "a successful spawn must not leave stale failure evidence");
  } finally {
    cleanup();
  }
});

test("mem-guard: sufficient free memory spawns exactly as today (no regression)", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    const counter = makeFakeCounter();
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, counter, freeMem: () => 2147483648 })
    );

    assert.ok(
      fake.calls.some((c) => c.command === "git" && c.args[0] === "worktree"),
      "sufficient free memory must let dispatch reach `git worktree`"
    );
    assert.ok(
      fake.calls.some((c) => c.command === "tmux"),
      "sufficient free memory must let dispatch reach the `tmux` spawn"
    );
    assert.equal(counter.read(42, { stateDir }), 1, "a successful spawn must raise the counter by exactly 1");
  } finally {
    cleanup();
  }
});

test("mem-guard: a throwing memory reader fails open and proceeds to spawn", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    const counter = makeFakeCounter();
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({
        projectRoot,
        worktreeRoot,
        stateDir,
        spawn: fake.spawn,
        counter,
        freeMem: () => {
          throw new Error("reader boom");
        },
      })
    );

    assert.ok(
      fake.calls.some((c) => c.command === "git" && c.args[0] === "worktree"),
      "a throwing memory reader must fail open and let dispatch reach `git worktree`"
    );
    assert.ok(
      fake.calls.some((c) => c.command === "tmux"),
      "a throwing memory reader must fail open and let dispatch reach the `tmux` spawn"
    );
    assert.equal(
      counter.read(42, { stateDir }),
      1,
      "a fail-open memory reader must never abort dispatch (successful spawn still counted)"
    );
  } finally {
    cleanup();
  }
});

test("mem-guard: HARNESS_MEM_GUARD_BYTES env var is used as a fallback threshold when opts.memGuardBytes is absent", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, "HARNESS_MEM_GUARD_BYTES");
  const prevEnv = process.env.HARNESS_MEM_GUARD_BYTES;
  try {
    process.env.HARNESS_MEM_GUARD_BYTES = "2147483648"; // 2 GiB — above DEFAULT_MEM_GUARD_BYTES (768 MiB)
    const fake = makeFakeSpawn();
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn, freeMem: () => 1073741824 }) // 1 GiB free
    );

    assert.ok(
      !fake.calls.some((c) => c.command === "git" && c.args[0] === "worktree"),
      "an env-var threshold above free memory must abort before any `git worktree` spawn"
    );
    assert.ok(
      !fake.calls.some((c) => c.command === "tmux"),
      "an env-var threshold above free memory must abort before any `tmux` spawn"
    );
  } finally {
    if (hadEnv) process.env.HARNESS_MEM_GUARD_BYTES = prevEnv;
    else delete process.env.HARNESS_MEM_GUARD_BYTES;
    cleanup();
  }
});

test("mem-guard: an explicit opts.memGuardBytes overrides a stricter HARNESS_MEM_GUARD_BYTES env var", async () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, "HARNESS_MEM_GUARD_BYTES");
  const prevEnv = process.env.HARNESS_MEM_GUARD_BYTES;
  try {
    process.env.HARNESS_MEM_GUARD_BYTES = "10737418240"; // 10 GiB — would abort on its own
    const fake = makeFakeSpawn();
    const counter = makeFakeCounter();
    await dispatch(
      { number: 42, body: "hi" },
      baseOpts({
        projectRoot,
        worktreeRoot,
        stateDir,
        spawn: fake.spawn,
        counter,
        freeMem: () => 1073741824, // 1 GiB free — below the env var, irrelevant once the guard is disabled
        memGuardBytes: 0, // explicit disable must win over the env var
      })
    );

    assert.ok(
      fake.calls.some((c) => c.command === "git" && c.args[0] === "worktree"),
      "opts.memGuardBytes must take precedence over HARNESS_MEM_GUARD_BYTES and let dispatch reach `git worktree`"
    );
    assert.ok(
      fake.calls.some((c) => c.command === "tmux"),
      "opts.memGuardBytes must take precedence over HARNESS_MEM_GUARD_BYTES and let dispatch reach the `tmux` spawn"
    );
    assert.equal(counter.read(42, { stateDir }), 1, "a successful spawn must raise the counter by exactly 1");
  } finally {
    if (hadEnv) process.env.HARNESS_MEM_GUARD_BYTES = prevEnv;
    else delete process.env.HARNESS_MEM_GUARD_BYTES;
    cleanup();
  }
});

test("dispatch: runtime=opencode seeds opencode.json into the worktree on the real dispatch path (seedOpencodeRootConfig runs inside dispatch, not only in isolation)", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    plantMonorepoOcPlugins(projectRoot);
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ permission: { external_directory: "allow", bash: { "*": "allow" } } })
    );

    // Spawn seam that REALLY runs the fs ops seedOpencodeRootConfig depends on: `git worktree add`
    // creates the worktree path (mkdirSync) so seedOpencodeRootConfig has a real destination dir to
    // copyFileSync into; `cp -a` copies `.opencode` when present. Everything else is a no-op.
    const calls = [];
    const spawn = (command, args = []) => {
      calls.push({ command, args });
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        mkdirSync(args[2], { recursive: true });
      } else if (command === "cp") {
        cpSync(args[1], args[2], { recursive: true });
      }
      return { ok: true };
    };

    dispatch(
      { number: 279, body: "b" },
      { ...baseOpts({ projectRoot, worktreeRoot, stateDir, spawn }), runtime: "opencode" }
    );

    const gitCall = calls.find((c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "add");
    assert.ok(gitCall, "dispatch must run `git worktree add`");
    const worktreePath = gitCall.args[2];
    assert.ok(
      existsSync(join(worktreePath, "opencode.json")),
      "seedOpencodeRootConfig must run on the real dispatch() path — opencode.json must exist in the worktree afterward, not only when seedOpencodeRootConfig is called in isolation"
    );
    assert.ok(
      existsSync(join(worktreePath, ".opencode", "skills", "triaging-requests", "SKILL.md")),
      "materialize must plant triaging-requests on the real dispatch path (#322)"
    );
  } finally {
    cleanup();
  }
});

test("dispatch: with the default runtime (claude, runtime !== 'opencode'), the tmux spawn env and the scoped env-file carry no XDG_DATA_HOME and no HARNESS_OC_DATA_HOME (Claude path stays byte-identical — no OpenCode isolation leak)", () => {
  const { projectRoot, worktreeRoot, stateDir, cleanup } = makeTempDirs();
  try {
    const fake = makeFakeSpawn();
    dispatch({ number: 314, body: "hi" }, baseOpts({ projectRoot, worktreeRoot, stateDir, spawn: fake.spawn }));

    const tmuxCall = findTmuxCall(fake.calls);
    assert.ok(tmuxCall, "dispatch must spawn the tmux session");
    assert.equal(
      "XDG_DATA_HOME" in (tmuxCall.env ?? {}),
      false,
      "the default (claude) runtime must never carry XDG_DATA_HOME into the tmux spawn's env"
    );
    assert.equal(
      "HARNESS_OC_DATA_HOME" in (tmuxCall.env ?? {}),
      false,
      "the default (claude) runtime must never carry HARNESS_OC_DATA_HOME into the tmux spawn's env"
    );

    const envFiles = readdirSync(stateDir).filter((n) => n.startsWith("issue-314-env-"));
    assert.ok(envFiles.length >= 1, "env-file must exist after a successful dispatch");
    const envBody = readFileSync(join(stateDir, envFiles[0]), "utf8");
    assert.equal(
      envBody.includes("XDG_DATA_HOME"),
      false,
      "the scoped env-file must contain no XDG_DATA_HOME key for the default (claude) runtime"
    );
    assert.equal(
      envBody.includes("HARNESS_OC_DATA_HOME"),
      false,
      "the scoped env-file must contain no HARNESS_OC_DATA_HOME key for the default (claude) runtime"
    );
  } finally {
    cleanup();
  }
});
