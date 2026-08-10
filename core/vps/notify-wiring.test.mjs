/**
 * @description Frozen oracle for the notify WIRING in the composition roots + pure logic returns.
 * Every seam is an injected fake — ZERO real network/fs/git/gh/tmux. Proves the additive structured
 * returns + the best-effort, fail-open notify translation at each root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCronA } from "./run-cron-a.mjs";
import { runCronB } from "./run-cron-b.mjs";
import { runReaper } from "./run-reaper.mjs";
import { dispatch } from "./cron-a-dispatch.mjs";
import { cronAExit, notifyExit, prLinksIssue, pickSessionPr } from "./cron-a-exit.mjs";
import { cronB } from "./cron-b.mjs";
import { reaper } from "./reaper.mjs";
import { validateInstallCoordinates, generateProjectConfig, reconcileFleet, runCli } from "./install-crons.mjs";

const BASE_CONFIG = {
  project: "demo",
  owner: "acme",
  repo: "demo-repo",
  projectRoot: "/srv/demo",
  stateDir: "/srv/demo/.claude/state",
  worktreeRoot: "/srv/worktrees",
  homeDir: "/home/harness",
};

// ---------------------------------------------------------------------------
// run-cron-a — #ac-5.1 / #ac-5.2 / #ac-5.3
// ---------------------------------------------------------------------------

test("#ac-5.1 runCronA notifies 'picked' on dispatched+issue via the injected notifier", () => {
  const events = [];
  runCronA(BASE_CONFIG, {
    cronASelect: () => ({ ok: true, dispatched: true, issue: { number: 42 } }),
    dispatch: () => ({ ok: true }),
    buildScopedEnvFromDisk: () => ({}),
    ghExec: () => ({ ok: true }),
    runLock: { acquire: () => ({ acquired: false }), release: () => {}, register: () => {} },
    spawn: () => {},
    counter: { increment: () => {}, read: () => 0 },
    notify: (e) => events.push(e),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "picked");
  assert.equal(events[0].issue, 42);
  assert.equal(events[0].project, "demo");
});

test("#ac-5.1 runCronA notifies 'dispatch-failed' when the wrapped dispatch returns {ok:false}, and suppresses 'picked'", () => {
  const events = [];
  // cronASelect fake invokes the dispatch seam (like the real one) then reports dispatched:true.
  const fakeSelect = (opts) => {
    opts.dispatch({ number: 7 }, { acquireTs: 1 });
    return { ok: true, dispatched: true, issue: { number: 7 } };
  };
  runCronA(BASE_CONFIG, {
    cronASelect: fakeSelect,
    dispatch: () => ({ ok: false }),
    buildScopedEnvFromDisk: () => ({}),
    ghExec: () => ({ ok: true }),
    runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {}, register: () => {} },
    spawn: () => {},
    counter: { increment: () => {}, read: () => 0 },
    notify: (e) => events.push(e),
  });
  const types = events.map((e) => e.type);
  assert.ok(types.includes("dispatch-failed"), "a failed dispatch must notify dispatch-failed");
  assert.ok(!types.includes("picked"), "a failed dispatch must NOT also notify picked");
});

test("#ac-5.1 a THROWING notifier never breaks runCronA (fail-open at the root)", () => {
  assert.doesNotThrow(() => {
    runCronA(BASE_CONFIG, {
      cronASelect: () => ({ ok: true, dispatched: true, issue: { number: 1 } }),
      dispatch: () => ({ ok: true }),
      buildScopedEnvFromDisk: () => ({}),
      ghExec: () => ({ ok: true }),
      runLock: { acquire: () => ({ acquired: false }), release: () => {}, register: () => {} },
      spawn: () => {},
      counter: { increment: () => {}, read: () => 0 },
      notify: () => {
        throw new Error("notifier exploded");
      },
    });
  });
});

test("#ac-5.2 runCronA notifies 'idle' on dispatched:false ONLY when heartbeat is on", () => {
  const withHb = [];
  runCronA(BASE_CONFIG, {
    cronASelect: () => ({ ok: true, dispatched: false }),
    dispatch: () => ({ ok: true }),
    buildScopedEnvFromDisk: () => ({}),
    ghExec: () => ({ ok: true }),
    runLock: { acquire: () => ({ acquired: false }), release: () => {}, register: () => {} },
    spawn: () => {},
    counter: { increment: () => {}, read: () => 0 },
    notify: (e) => withHb.push(e),
    heartbeat: true,
  });
  assert.deepEqual(withHb.map((e) => e.type), ["idle"]);

  const noHb = [];
  runCronA(BASE_CONFIG, {
    cronASelect: () => ({ ok: true, dispatched: false }),
    dispatch: () => ({ ok: true }),
    buildScopedEnvFromDisk: () => ({}),
    ghExec: () => ({ ok: true }),
    runLock: { acquire: () => ({ acquired: false }), release: () => {}, register: () => {} },
    spawn: () => {},
    counter: { increment: () => {}, read: () => 0 },
    notify: (e) => noHb.push(e),
    heartbeat: false,
  });
  assert.equal(noHb.length, 0, "explicit heartbeat:false → no idle notification");

  // Default ON: a config with a notify block but NO heartbeat key (and no injected deps.heartbeat)
  // → idle fires, because heartbeat defaults ON when notify is configured.
  const defaultOn = [];
  runCronA(
    { ...BASE_CONFIG, notify: { chatId: -100, threadId: 613 } },
    {
      cronASelect: () => ({ ok: true, dispatched: false }),
      dispatch: () => ({ ok: true }),
      buildScopedEnvFromDisk: () => ({}),
      ghExec: () => ({ ok: true }),
      runLock: { acquire: () => ({ acquired: false }), release: () => {}, register: () => {} },
      spawn: () => {},
      counter: { increment: () => {}, read: () => 0 },
      notify: (e) => defaultOn.push(e),
    }
  );
  assert.deepEqual(defaultOn.map((e) => e.type), ["idle"], "notify block without heartbeat key → idle ON by default");
});

// ---------------------------------------------------------------------------
// cron-a-dispatch — #ac-6.2 (env-file gets HARNESS_NOTIFY_*, never the token)
// ---------------------------------------------------------------------------

test("#ac-6.2 dispatch threads non-secret HARNESS_NOTIFY_* into the session env, never a token", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "notify-dispatch-"));
  try {
    const spawnCalls = [];
    const spawn = (command, args, spawnOpts = {}) => {
      spawnCalls.push({ command, args, env: spawnOpts.env });
    };
    dispatch(
      { number: 5, body: "issue body" },
      {
        project: "demo",
        projectRoot: stateDir,
        worktreeRoot: stateDir,
        stateDir,
        lock: { acquireTs: 1 },
        spawn,
        runLock: { register: () => {}, release: () => {} },
        gh: () => ({ ok: true }),
        counter: { increment: () => {} },
        buildScopedEnv: () => ({ OLLAMA_HAND_TOKEN: "x" }),
        freeMem: () => Number.POSITIVE_INFINITY,
        notify: { chatId: -1003044689525, threadId: 613 },
      }
    );
    const tmuxCall = spawnCalls.find((c) => c.command === "tmux");
    assert.ok(tmuxCall, "dispatch must spawn tmux");
    assert.equal(tmuxCall.env.HARNESS_NOTIFY_CHATID, "-1003044689525");
    assert.equal(tmuxCall.env.HARNESS_NOTIFY_THREADID, "613");
    assert.equal(tmuxCall.env.HARNESS_NOTIFY_PROJECT, "demo");
    // The Telegram token must NEVER be threaded through dispatch's env.
    for (const key of Object.keys(tmuxCall.env)) {
      assert.ok(!/TELEGRAM/i.test(key), `env key ${key} must not carry the Telegram token`);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-6.2 dispatch WITHOUT notify writes only HARNESS_NOTIFY_PROJECT (no chat/thread, never a token)", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "notify-dispatch-"));
  try {
    const spawnCalls = [];
    const spawn = (command, args, spawnOpts = {}) => spawnCalls.push({ command, env: spawnOpts.env });
    dispatch(
      { number: 5, body: "b" },
      {
        project: "demo",
        projectRoot: stateDir,
        worktreeRoot: stateDir,
        stateDir,
        lock: { acquireTs: 1 },
        spawn,
        runLock: { register: () => {}, release: () => {} },
        gh: () => ({ ok: true }),
        counter: { increment: () => {} },
        buildScopedEnv: () => ({ OLLAMA_HAND_TOKEN: "x" }),
        freeMem: () => Number.POSITIVE_INFINITY,
      }
    );
    const tmuxCall = spawnCalls.find((c) => c.command === "tmux");
    const notifyKeys = Object.keys(tmuxCall.env).filter((k) => k.startsWith("HARNESS_NOTIFY_")).sort();
    assert.deepEqual(notifyKeys, ["HARNESS_NOTIFY_PROJECT"], "no notify → only the project name (chat/thread come from .dev.vars); never a token");
    assert.equal(tmuxCall.env.HARNESS_NOTIFY_PROJECT, "demo");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cron-a-exit — #ac-6.1 (additive structured return per path)
// ---------------------------------------------------------------------------

function exitOpts(overrides = {}) {
  return {
    gh: () => ({ ok: true }),
    runLock: { release: () => {} },
    counter: { read: () => 0, reset: () => {}, increment: () => {} },
    prExists: () => false,
    blockingFinding: () => null,
    stateDir: "/srv/demo/.claude/state",
    acquireTs: 1,
    retryCeilingK: 2,
    ...overrides,
  };
}

test("#ac-6.1 cronAExit returns the additive structured outcome per path", () => {
  const done = cronAExit(42, "/wt", "/b", "/e", exitOpts({ prExists: () => true }));
  assert.equal(done.outcome, "done");
  assert.equal(done.issueNumber, 42);
  assert.equal(done.hadPr, true);

  const blocked = cronAExit(42, "/wt", "/b", "/e", exitOpts({ blockingFinding: () => "needs a decision" }));
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.finding, "needs a decision");

  const failed = cronAExit(42, "/wt", "/b", "/e", exitOpts({ counter: { read: () => 2, reset: () => {}, increment: () => {} } }));
  assert.equal(failed.outcome, "failed");

  const requeued = cronAExit(42, "/wt", "/b", "/e", exitOpts());
  assert.equal(requeued.outcome, "requeued");
});

// ---------------------------------------------------------------------------
// cron-a-exit notifyExit — #uj-1 session-done/blocked/failed translation (coverage gap)
// ---------------------------------------------------------------------------

function fakeNotifierFactory() {
  const events = [];
  const makeNotifier = () => ({ notify: (e) => events.push(e), drain: async () => {} });
  return { events, makeNotifier };
}

const NOTIFY_ENV = { HARNESS_NOTIFY_CHATID: "-100", HARNESS_NOTIFY_THREADID: "613", HARNESS_NOTIFY_PROJECT: "demo", HOME: "/h" };

test("notifyExit translates 'done' → session-done with the looked-up PR number + url", async () => {
  const { events, makeNotifier } = fakeNotifierFactory();
  await notifyExit(
    { outcome: "done", issueNumber: 42, finding: null },
    { env: NOTIFY_ENV, prLookup: () => ({ number: 9, url: "https://gh/pull/9" }), makeNotifier }
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "session-done");
  assert.equal(events[0].project, "demo");
  assert.equal(events[0].issue, 42);
  assert.equal(events[0].pr, 9);
  assert.equal(events[0].url, "https://gh/pull/9");
});

test("notifyExit translates blocked/failed, and stays silent on requeued or when unconfigured", async () => {
  const blocked = fakeNotifierFactory();
  await notifyExit({ outcome: "blocked", issueNumber: 7, finding: "needs a call" }, { env: NOTIFY_ENV, prLookup: () => null, makeNotifier: blocked.makeNotifier });
  assert.deepEqual(blocked.events.map((e) => [e.type, e.reason]), [["blocked", "needs a call"]]);

  const failed = fakeNotifierFactory();
  await notifyExit({ outcome: "failed", issueNumber: 7, finding: null }, { env: NOTIFY_ENV, prLookup: () => null, makeNotifier: failed.makeNotifier });
  assert.deepEqual(failed.events.map((e) => e.type), ["failed"]);

  const requeued = fakeNotifierFactory();
  await notifyExit({ outcome: "requeued", issueNumber: 7, finding: null }, { env: NOTIFY_ENV, prLookup: () => null, makeNotifier: requeued.makeNotifier });
  assert.deepEqual(requeued.events.map((e) => e.type), ["session-requeued"], "a requeue is reported too (run finished without a PR, retrying)");

  // No HARNESS_NOTIFY_CHATID → notify not configured → no-op (no makeNotifier call).
  let built = false;
  await notifyExit({ outcome: "done", issueNumber: 7, finding: null }, { env: { HOME: "/h" }, prLookup: () => null, makeNotifier: () => { built = true; return { notify: () => {}, drain: async () => {} }; } });
  assert.equal(built, false, "unconfigured session must not build a notifier");
});

test("notifyExit never rejects even if the notifier throws (fail-open exit handler)", async () => {
  let threw = false;
  try {
    await notifyExit(
      { outcome: "done", issueNumber: 1, finding: null },
      { env: NOTIFY_ENV, prLookup: () => { throw new Error("gh down"); }, makeNotifier: () => { throw new Error("boom"); } }
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "notifyExit must swallow all failures");
});

// ---------------------------------------------------------------------------
// cron-a-exit PR recognition — branch-mismatch fix (harness/<N> OR issue link)
// ---------------------------------------------------------------------------

test("prLinksIssue: matches GitHub closing/reference keywords for the issue", () => {
  assert.equal(prLinksIssue("...\nCloses #105", 105), true);
  assert.equal(prLinksIssue("Fixes #105 and more", 105), true);
  assert.equal(prLinksIssue("Refs #105", 105), true);
  assert.equal(prLinksIssue("Resolves #105", 105), true);
  assert.equal(prLinksIssue("mentions #1050 only", 105), false, "must not match #1050 for issue 105");
  assert.equal(prLinksIssue("no link here", 105), false);
});

test("pickSessionPr: prefers the harness/<N> branch, else an issue-linked PR (typed branch)", () => {
  const prs = [
    { number: 1, headRefName: "fix/other", url: "u1", body: "unrelated" },
    { number: 2, headRefName: "harness/105", url: "u2", body: "" },
  ];
  assert.deepEqual(pickSessionPr(prs, 105), { number: 2, url: "u2" }, "harness/105 branch wins");

  // No harness/<N> branch — the session delivered on a typed branch that links the issue.
  const typed = [{ number: 9, headRefName: "fix/cross-family-fail-fast-args", url: "u9", body: "fix ...\n\nCloses #105" }];
  assert.deepEqual(pickSessionPr(typed, 105), { number: 9, url: "u9" }, "issue-linked typed branch is recognized");

  assert.equal(pickSessionPr([{ number: 3, headRefName: "feat/x", body: "no link" }], 105), null);
  assert.equal(pickSessionPr(null, 105), null);
});

// ---------------------------------------------------------------------------
// cron-b — #ac-7.1 (additive per-PR outcome array)
// ---------------------------------------------------------------------------

test("#ac-7.1 cronB returns the additive per-PR outcome array (merged/blocked)", () => {
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return [
        { number: 10, headRefName: "harness/1", headSha: "s1", url: "https://gh/pull/10" },
        { number: 11, headRefName: "harness/2", headSha: "s2", url: "https://gh/pull/11" },
      ];
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (args.includes("statusCheckRollup")) {
        return { statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] };
      }
      const n = Number(args[2]);
      return { body: n === 10 ? "CLEAN" : "BLOCKED" };
    }
    return { ok: true };
  };
  const outcomes = cronB({
    gh,
    parseVerdictBlock: (body) => (body === "CLEAN" ? { status: "CLEAN" } : { status: "BLOCKED", finding: "sec issue" }),
    alreadyReviewed: () => false,
    recordReviewed: () => {},
    openRiskMarker: () => false,
    stateDir: "/s",
  });
  assert.ok(Array.isArray(outcomes));
  const merged = outcomes.find((o) => o.number === 10);
  const blocked = outcomes.find((o) => o.number === 11);
  assert.equal(merged.outcome, "merged");
  assert.equal(merged.url, "https://gh/pull/10");
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.finding, "sec issue");
});

test("#ac-7.1 runCronB notifies pr-merged/pr-blocked and tolerates a void cronB (frozen fake)", () => {
  const events = [];
  // void-returning cronB fake (predates the array return) must not break runCronB.
  assert.doesNotThrow(() => {
    runCronB(BASE_CONFIG, {
      cronB: () => {},
      getAuthenticatedGhUser: () => "bot",
      ghExec: () => ({ ok: true }),
      parseVerdictBlock: () => ({ status: "CLEAN" }),
      alreadyReviewed: () => false,
      recordReviewed: () => {},
      notify: (e) => events.push(e),
    });
  });

  const events2 = [];
  runCronB(BASE_CONFIG, {
    cronB: () => [
      { number: 10, headRefName: "harness/1", outcome: "merged", url: "u10" },
      { number: 11, headRefName: "harness/2", outcome: "blocked", finding: "x", url: "u11" },
    ],
    getAuthenticatedGhUser: () => "bot",
    ghExec: () => ({ ok: true }),
    parseVerdictBlock: () => ({ status: "CLEAN" }),
    alreadyReviewed: () => false,
    recordReviewed: () => {},
    notify: (e) => events2.push(e),
  });
  assert.deepEqual(events2.map((e) => e.type).sort(), ["pr-blocked", "pr-merged"]);
});

// ---------------------------------------------------------------------------
// reaper — #ac-7.2 (additive per-worktree action array)
// ---------------------------------------------------------------------------

test("#ac-7.2 reaper returns the additive per-worktree action array (orphan-cleaned)", () => {
  const worktrees = [
    {
      project: "demo",
      projectRoot: "/srv/demo",
      worktreePath: "/wt/1",
      branch: "harness/1",
      issueNumber: 1,
      stateDir: "/s",
      holder: null,
      lockDirAgeSeconds: 9999, // past grace → orphan
    },
  ];
  const actions = reaper({
    listWorktrees: () => worktrees,
    tmuxHasSession: () => false,
    kill: () => {},
    now: () => 100000,
    prExists: () => false,
    gh: () => ({ ok: true }),
    runLock: { release: () => {} },
    counter: { read: () => 0 },
    tmuxKillSession: () => {},
    gitWorktreeRemove: () => {},
    gitBranchDelete: () => {},
  });
  assert.ok(Array.isArray(actions));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "orphan-cleaned");
  assert.equal(actions[0].project, "demo");
  assert.equal(actions[0].issueNumber, 1);
});

test("#ac-7.2 runReaper maps reaper actions to notifications with the per-entry project prefix", () => {
  const events = [];
  runReaper(
    { ...BASE_CONFIG, projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir: "/s" }] },
    {
      reaper: () => [
        { project: "alpha", issueNumber: 3, action: "watchdog-killed" },
        { project: "beta", issueNumber: 4, action: "crash-recovered" },
        { project: "gamma", issueNumber: 5, action: "orphan-cleaned" },
      ],
      listWorktrees: () => [],
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      notify: (e) => events.push(e),
    }
  );
  assert.deepEqual(
    events.map((e) => [e.type, e.project]),
    [
      ["reaper-killed", "alpha"],
      ["reaper-recovered", "beta"],
      ["reaper-orphan-cleaned", "gamma"],
    ]
  );
});

// ---------------------------------------------------------------------------
// install-crons — #ac-8.1 / #ac-8.2 (notify passthrough, frozen generator untouched)
// ---------------------------------------------------------------------------

test("#ac-8.1 validateInstallCoordinates carries a valid notify block; generateProjectConfig stays exact-key", () => {
  const coords = validateInstallCoordinates({
    ...BASE_CONFIG,
    notify: { chatId: -1003044689525, threadId: 613, heartbeat: true },
  });
  assert.deepEqual(coords.notify, { chatId: -1003044689525, threadId: 613, heartbeat: true });

  // generateProjectConfig is frozen: notify must NOT leak into its output.
  const generated = generateProjectConfig(coords);
  assert.ok(!("notify" in generated), "generateProjectConfig must remain notify-free (frozen oracle)");

  // Invalid notify is rejected.
  assert.throws(() => validateInstallCoordinates({ ...BASE_CONFIG, notify: { chatId: "not-a-number" } }), /notify/);
  assert.throws(() => validateInstallCoordinates({ ...BASE_CONFIG, notify: { chatId: 1, threadId: "x" } }), /notify/);

  // Absent notify → coords carries none.
  const noNotify = validateInstallCoordinates({ ...BASE_CONFIG });
  assert.ok(!("notify" in noNotify));
});

test("#ac-8.2 reconcileFleet carries notify into the fleet base (null-seed + latest-installer)", () => {
  const coords = validateInstallCoordinates({ ...BASE_CONFIG, notify: { chatId: -100, threadId: 613 } });
  const seeded = reconcileFleet(null, [], coords);
  assert.deepEqual(seeded.notify, { chatId: -100, threadId: 613 });

  // Absent notify → fleet base has no notify key.
  const plain = reconcileFleet(null, [], validateInstallCoordinates({ ...BASE_CONFIG }));
  assert.ok(!("notify" in plain));
});

test("#ac-8.1 runCli install branch parses --chat-id/--thread-id/--heartbeat into inputs.notify", async () => {
  let captured;
  const argv = [
    "install", "--project", "demo", "--owner", "acme", "--repo", "demo-repo",
    "--project-root", "/srv/demo", "--state-dir", "/srv/demo/.claude/state",
    "--worktree-root", "/srv/worktrees", "--home-dir", "/home/harness",
    "--chat-id", "-1003044689525", "--thread-id", "613", "--heartbeat", "true",
  ];
  await runCli(argv, { installProject: (inputs) => { captured = inputs; }, isTTY: false });
  assert.deepEqual(captured.notify, { chatId: -1003044689525, threadId: 613, heartbeat: true });

  // --heartbeat false is honored (explicit opt-out).
  let capturedOff;
  const argvOff = [...argv.slice(0, 20), "--heartbeat", "false"];
  await runCli(argvOff, { installProject: (inputs) => { capturedOff = inputs; }, isTTY: false });
  assert.equal(capturedOff.notify.heartbeat, false);

  // --chat-id with NO --heartbeat flag, non-TTY → heartbeat defaults ON.
  let capturedDefault;
  const argvNoHb = argv.slice(0, 20); // through --thread-id 613, no --heartbeat
  await runCli(argvNoHb, { installProject: (inputs) => { capturedDefault = inputs; }, isTTY: false });
  assert.equal(capturedDefault.notify.heartbeat, true, "heartbeat is ON by default when unspecified");

  // On a TTY with no flag, the prompt decides (default YES on empty input).
  let capturedPrompt;
  await runCli(argvNoHb, { installProject: (inputs) => { capturedPrompt = inputs; }, isTTY: true, askHeartbeat: async () => "" });
  assert.equal(capturedPrompt.notify.heartbeat, true, "empty prompt answer keeps heartbeat ON");
  let capturedPromptNo;
  await runCli(argvNoHb, { installProject: (inputs) => { capturedPromptNo = inputs; }, isTTY: true, askHeartbeat: async () => "n" });
  assert.equal(capturedPromptNo.notify.heartbeat, false, "explicit 'n' at the prompt turns heartbeat OFF");

  // Without notify flags → no notify block (byte-identical CLI to today).
  let captured2;
  await runCli(argv.slice(0, 16), { installProject: (inputs) => { captured2 = inputs; }, isTTY: false });
  assert.ok(!("notify" in captured2), "no --chat-id → no notify block");
});
