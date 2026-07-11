/**
 * @description Frozen oracle for the setup-vps wizard. Every seam injected — ZERO real prompts/fs/
 * git/install-crons. Proves: inference from cwd + git remote (Enter accepts defaults), the STABLE
 * engine resolution (local clone, else auto-clone — never the npx cache), and that the bot token
 * NEVER reaches stdout or the install-crons args.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  telegramGuide,
  parseGitRemote,
  buildInstallArgs,
  upsertTokenLine,
  runSetupVps,
} from "./setup-vps.mjs";
import { parseCliArgs } from "./cli.mjs";

const TOKEN = "123456789:AAH-SECRET-BOT-TOKEN-value";

// All-Enter for the inferred fields (home/projectRoot/project/owner/repo/stateDir/worktreeRoot),
// then the Telegram values. Order matches runSetupVps's prompts.
const INFER = ["", "", "", "", "", "", "", TOKEN, "-1003044689525", "613", ""];

function harness(opts = {}) {
  const {
    answers = INFER,
    localEngineDir = "/srv/claude-harness",
    stableEngineDir = "/home/op/.claude/harness-core",
    gitRemote = () => "git@github.com:orobsonn/myproject.git",
    cwd = "/srv/myproject",
    exists,
    cloneEngine,
  } = opts;
  const queue = [...answers];
  const outLines = [];
  const devVarsWrites = [];
  const installCalls = [];
  const cloneCalls = [];
  const deps = {
    ask: async () => queue.shift(),
    out: (t) => outLines.push(t),
    env: { HOME: "/home/op" },
    cwd,
    gitRemote,
    localEngineDir,
    stableEngineDir,
    cloneEngine: cloneEngine ?? ((dir) => cloneCalls.push(dir)),
    // default: only the local engine's install-crons exists.
    exists: exists ?? ((p) => localEngineDir != null && p.startsWith(localEngineDir)),
    readFileSafe: () => "ANTHROPIC_AUTH_TOKEN=x\n",
    writeDevVars: (p, content) => devVarsWrites.push({ p, content }),
    ensureDir: () => {},
    devVarsPathFor: (h) => `${h}/.claude/.dev.vars`,
    runInstall: (scriptPath, args) => installCalls.push({ scriptPath, args }),
  };
  return { deps, outLines, devVarsWrites, installCalls, cloneCalls };
}

test("telegramGuide explains how to obtain token / chat_id / thread_id", () => {
  const g = telegramGuide();
  assert.match(g, /@BotFather/);
  assert.match(g, /\/newbot/);
  assert.match(g, /getUpdates/);
  assert.match(g, /chat_id/);
  assert.match(g, /message_thread_id/);
});

test("parseGitRemote handles ssh, https, .git and trailing slash", () => {
  assert.deepEqual(parseGitRemote("git@github.com:orobsonn/myproject.git"), { owner: "orobsonn", repo: "myproject" });
  assert.deepEqual(parseGitRemote("https://github.com/orobsonn/myproject.git"), { owner: "orobsonn", repo: "myproject" });
  assert.deepEqual(parseGitRemote("https://github.com/orobsonn/myproject"), { owner: "orobsonn", repo: "myproject" });
  assert.deepEqual(parseGitRemote("https://github.com/orobsonn/myproject/"), { owner: "orobsonn", repo: "myproject" });
  assert.deepEqual(parseGitRemote(""), { owner: "", repo: "" });
});

test("buildInstallArgs produces the install-crons argv and NEVER includes the token", () => {
  const args = buildInstallArgs({
    project: "p", owner: "o", repo: "r", projectRoot: "/pr", stateDir: "/s",
    worktreeRoot: "/w", homeDir: "/h", chatId: -100, threadId: 613, heartbeat: true,
  });
  assert.equal(args[0], "install");
  assert.equal(args[args.indexOf("--chat-id") + 1], "-100");
  assert.equal(args[args.indexOf("--heartbeat") + 1], "true");
  assert.ok(!args.some((a) => /AAH-SECRET|TELEGRAM_BOT_TOKEN/.test(a)), "token must never be an install-crons arg");
  const noThread = buildInstallArgs({ project: "p", owner: "o", repo: "r", projectRoot: "/pr", stateDir: "/s", worktreeRoot: "/w", homeDir: "/h", chatId: -100, heartbeat: false });
  assert.equal(noThread.includes("--thread-id"), false);
});

test("upsertTokenLine appends when absent, replaces when present, preserves other lines", () => {
  assert.equal(upsertTokenLine("", "tok"), "TELEGRAM_BOT_TOKEN=tok\n");
  assert.equal(upsertTokenLine("A=1\n", "tok"), "A=1\nTELEGRAM_BOT_TOKEN=tok\n");
  assert.equal(upsertTokenLine("A=1\nTELEGRAM_BOT_TOKEN=old\nB=2", "new"), "A=1\nTELEGRAM_BOT_TOKEN=new\nB=2");
  assert.equal(upsertTokenLine("export TELEGRAM_BOT_TOKEN=old\n", "new"), "TELEGRAM_BOT_TOKEN=new\n");
});

test("runSetupVps INFERS project/owner/repo/paths from cwd + git remote (operator just presses Enter)", async () => {
  const { deps, installCalls, cloneCalls } = harness();
  const r = await runSetupVps(deps);

  assert.equal(r.project, "myproject");
  assert.equal(cloneCalls.length, 0, "a valid local engine must NOT trigger a clone");
  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0].scriptPath, "/srv/claude-harness/core/vps/install-crons.mjs", "runs the local clone's install-crons");
  const args = installCalls[0].args;
  assert.equal(args[args.indexOf("--project") + 1], "myproject", "project inferred from cwd basename");
  assert.equal(args[args.indexOf("--owner") + 1], "orobsonn", "owner inferred from git remote");
  assert.equal(args[args.indexOf("--repo") + 1], "myproject", "repo inferred from git remote");
  assert.equal(args[args.indexOf("--project-root") + 1], "/srv/myproject", "project-root inferred from cwd");
  assert.equal(args[args.indexOf("--state-dir") + 1], "/srv/myproject/.claude/state");
  assert.equal(args[args.indexOf("--worktree-root") + 1], "/home/op/.claude/harness-worktrees");
  assert.equal(args[args.indexOf("--home-dir") + 1], "/home/op");
  assert.equal(args[args.indexOf("--chat-id") + 1], "-1003044689525");
});

test("runSetupVps: an explicit answer overrides the inferred default", async () => {
  const answers = ["", "/custom/project", "custom-slug", "acme", "custom-repo", "", "", TOKEN, "-100", "", "n"];
  const { deps, installCalls } = harness({ answers });
  await runSetupVps(deps);
  const args = installCalls[0].args;
  assert.equal(args[args.indexOf("--project-root") + 1], "/custom/project");
  assert.equal(args[args.indexOf("--project") + 1], "custom-slug");
  assert.equal(args[args.indexOf("--owner") + 1], "acme");
  assert.equal(args[args.indexOf("--repo") + 1], "custom-repo");
  assert.equal(args[args.indexOf("--state-dir") + 1], "/custom/project/.claude/state", "state-dir default follows the overridden project-root");
  assert.equal(args.includes("--thread-id"), false, "empty thread-id omits the flag");
  assert.equal(args[args.indexOf("--heartbeat") + 1], "false", "'n' turns heartbeat off");
});

test("runSetupVps: npx case (no local engine) auto-clones to the stable dir and runs from THERE", async () => {
  let cloned = false;
  const stable = "/home/op/.claude/harness-core";
  const { deps, installCalls, cloneCalls } = harness({
    localEngineDir: null,
    exists: (p) => p.startsWith(stable) && cloned, // stable engine exists only after the clone
    cloneEngine: (dir) => {
      cloned = true;
      cloneCalls.push?.(dir);
    },
  });
  // capture cloneCalls via the closure above
  const clones = [];
  deps.cloneEngine = (dir) => {
    cloned = true;
    clones.push(dir);
  };
  await runSetupVps(deps);
  assert.deepEqual(clones, [stable], "the engine is cloned once into the stable dir");
  assert.equal(installCalls[0].scriptPath, `${stable}/core/vps/install-crons.mjs`, "runs from the stable clone, never the npx cache");
});

test("runSetupVps: the bot TOKEN never appears in any stdout/out line (secret hygiene)", async () => {
  const { deps, outLines, devVarsWrites } = harness();
  await runSetupVps(deps);
  assert.doesNotMatch(outLines.join("\n"), /AAH-SECRET-BOT-TOKEN/, "token must never be printed");
  assert.match(devVarsWrites[0].content, /TELEGRAM_BOT_TOKEN=123456789:AAH-SECRET-BOT-TOKEN-value/, "token IS written to .dev.vars");
  assert.match(devVarsWrites[0].content, /ANTHROPIC_AUTH_TOKEN=x/, "existing lines preserved");
});

test("runSetupVps: a missing token fails fast without installing", async () => {
  const answers = ["", "", "", "", "", "", "", "", "-100", "", ""]; // empty token
  const { deps, installCalls } = harness({ answers });
  await assert.rejects(() => runSetupVps(deps), /token/);
  assert.equal(installCalls.length, 0);
});

test("parseCliArgs passes the command through raw (init alias resolved by the dispatcher)", () => {
  assert.equal(parseCliArgs(["node", "cli", "init"]).command, "init");
  assert.equal(parseCliArgs(["node", "cli", "setup-local"]).command, "setup-local");
  assert.equal(parseCliArgs(["node", "cli", "setup-vps"]).command, "setup-vps");
});
