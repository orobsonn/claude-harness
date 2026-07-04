/**
 * @description Frozen oracle for the setup-vps wizard. Every seam injected — ZERO real prompts/fs/
 * install-crons — and a dedicated assertion proves the bot token NEVER reaches stdout/logs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  telegramGuide,
  buildInstallArgs,
  upsertTokenLine,
  runSetupVps,
} from "./setup-vps.mjs";
import { parseCliArgs } from "./cli.mjs";

const TOKEN = "123456789:AAH-SECRET-BOT-TOKEN-value";

const ANSWERS = [
  "/home/op", // 0 home dir
  "meu-app", // 1 project
  "orobsonn", // 2 owner
  "meu-app", // 3 repo
  "/srv/meu-app", // 4 project-root
  "", // 5 state-dir (accept default)
  "/srv/worktrees", // 6 worktree-root
  "/srv/claude-harness", // 7 harness-dir (stable clone)
  TOKEN, // 8 token
  "-1003044689525", // 9 chat-id
  "613", // 10 thread-id
  "", // 11 heartbeat (empty → default YES)
];

function harness(answers = ANSWERS, opts = {}) {
  const queue = [...answers];
  const outLines = [];
  const devVarsWrites = [];
  const installCalls = [];
  const deps = {
    ask: async () => queue.shift(),
    out: (t) => outLines.push(t),
    env: { HOME: "/home/op" },
    readFileSafe: () => "ANTHROPIC_AUTH_TOKEN=x\n",
    writeDevVars: (p, content) => devVarsWrites.push({ p, content }),
    ensureDir: () => {},
    exists: opts.exists ?? (() => true),
    devVarsPathFor: (home) => `${home}/.claude/.dev.vars`,
    runInstall: (scriptPath, args) => installCalls.push({ scriptPath, args }),
  };
  return { deps, outLines, devVarsWrites, installCalls };
}

test("telegramGuide explains how to obtain token / chat_id / thread_id", () => {
  const g = telegramGuide();
  assert.match(g, /@BotFather/);
  assert.match(g, /\/newbot/);
  assert.match(g, /getUpdates/);
  assert.match(g, /chat_id/);
  assert.match(g, /message_thread_id/);
});

test("buildInstallArgs produces the install-crons argv and NEVER includes the token", () => {
  const args = buildInstallArgs({
    project: "p", owner: "o", repo: "r", projectRoot: "/pr", stateDir: "/pr/.claude/state",
    worktreeRoot: "/w", homeDir: "/h", chatId: -100, threadId: 613, heartbeat: true,
  });
  assert.equal(args[0], "install");
  assert.equal(args[args.indexOf("--chat-id") + 1], "-100");
  assert.equal(args[args.indexOf("--thread-id") + 1], "613");
  assert.equal(args[args.indexOf("--heartbeat") + 1], "true");
  assert.ok(!args.some((a) => /AAH-SECRET|TELEGRAM_BOT_TOKEN/.test(a)), "the token must never be an install-crons arg");

  const noThread = buildInstallArgs({
    project: "p", owner: "o", repo: "r", projectRoot: "/pr", stateDir: "/s",
    worktreeRoot: "/w", homeDir: "/h", chatId: -100, threadId: undefined, heartbeat: false,
  });
  assert.equal(noThread.includes("--thread-id"), false, "empty thread id → flag omitted");
  assert.equal(noThread[noThread.indexOf("--heartbeat") + 1], "false");
});

test("upsertTokenLine appends when absent, replaces when present, preserves other lines", () => {
  assert.equal(upsertTokenLine("", "tok"), "TELEGRAM_BOT_TOKEN=tok\n");
  assert.equal(upsertTokenLine("A=1\n", "tok"), "A=1\nTELEGRAM_BOT_TOKEN=tok\n");
  assert.equal(upsertTokenLine("A=1\nTELEGRAM_BOT_TOKEN=old\nB=2", "new"), "A=1\nTELEGRAM_BOT_TOKEN=new\nB=2");
  assert.equal(upsertTokenLine("export TELEGRAM_BOT_TOKEN=old\n", "new"), "TELEGRAM_BOT_TOKEN=new\n");
});

test("runSetupVps: collects answers, writes token to .dev.vars, calls install-crons with the right args", async () => {
  const { deps, devVarsWrites, installCalls } = harness();
  const result = await runSetupVps(deps);

  assert.equal(result.project, "meu-app");
  assert.equal(devVarsWrites.length, 1);
  assert.equal(devVarsWrites[0].p, "/home/op/.claude/.dev.vars");
  assert.match(devVarsWrites[0].content, /TELEGRAM_BOT_TOKEN=123456789:AAH-SECRET-BOT-TOKEN-value/);
  assert.match(devVarsWrites[0].content, /ANTHROPIC_AUTH_TOKEN=x/, "existing lines preserved");

  assert.equal(installCalls.length, 1);
  assert.equal(
    installCalls[0].scriptPath,
    "/srv/claude-harness/core/vps/install-crons.mjs",
    "install-crons must run from the STABLE harness clone, not the npx cache",
  );
  const args = installCalls[0].args;
  assert.equal(args[args.indexOf("--project") + 1], "meu-app");
  assert.equal(args[args.indexOf("--state-dir") + 1], "/srv/meu-app/.claude/state", "empty state-dir → derived default");
  assert.equal(args[args.indexOf("--chat-id") + 1], "-1003044689525");
  assert.equal(args[args.indexOf("--thread-id") + 1], "613");
  assert.equal(args[args.indexOf("--heartbeat") + 1], "true", "empty heartbeat answer → default ON");
});

test("runSetupVps: a missing harness clone aborts BEFORE writing the token or installing", async () => {
  const { deps, devVarsWrites, installCalls } = harness(ANSWERS, { exists: () => false });
  await assert.rejects(() => runSetupVps(deps), /não encontrei|clone/i);
  assert.equal(devVarsWrites.length, 0, "no token written when the harness clone is missing");
  assert.equal(installCalls.length, 0, "no install attempted");
});

test("runSetupVps: the bot TOKEN never appears in any stdout/out line (secret hygiene)", async () => {
  const { deps, outLines } = harness();
  await runSetupVps(deps);
  const serialized = outLines.join("\n");
  assert.doesNotMatch(serialized, /AAH-SECRET-BOT-TOKEN/, "the token must never be printed to stdout");
  assert.match(serialized, /Token salvo/, "only a value-free confirmation is printed");
});

test("runSetupVps: 'n' at the heartbeat prompt turns it OFF; empty thread-id omits the flag", async () => {
  const answers = [...ANSWERS];
  answers[10] = ""; // thread-id empty
  answers[11] = "n"; // heartbeat off
  const { deps, installCalls } = harness(answers);
  await runSetupVps(deps);
  const args = installCalls[0].args;
  assert.equal(args.includes("--thread-id"), false);
  assert.equal(args[args.indexOf("--heartbeat") + 1], "false");
});

test("runSetupVps: a missing required field fails fast without calling install-crons", async () => {
  const answers = [...ANSWERS];
  answers[1] = ""; // project empty → required throws
  const { deps, installCalls, devVarsWrites } = harness(answers);
  await assert.rejects(() => runSetupVps(deps), /project/);
  assert.equal(installCalls.length, 0, "no install on a failed wizard");
  assert.equal(devVarsWrites.length, 0, "no token written on a failed wizard");
});

test("parseCliArgs passes the command through raw (init alias resolved by the dispatcher)", () => {
  assert.equal(parseCliArgs(["node", "cli", "init"]).command, "init");
  assert.equal(parseCliArgs(["node", "cli", "setup-local"]).command, "setup-local");
  assert.equal(parseCliArgs(["node", "cli", "setup-vps"]).command, "setup-vps");
});
