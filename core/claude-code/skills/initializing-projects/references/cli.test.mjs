import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs, runInit, SOURCE_URL, isDirectCli, decideCodex, withCodexToggle, writeLifecycleSnapshot } from "./cli.mjs";

test("parseCliArgs", () => {
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init"]), {
    command: "init",
    withCodex: false,
    runtimeTarget: "claude",
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "bogus"]), {
    command: "bogus",
    withCodex: false,
    runtimeTarget: "claude",
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs"]), {
    command: undefined,
    withCodex: false,
    runtimeTarget: "claude",
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init", "--with-codex"]), {
    command: "init",
    withCodex: true,
    runtimeTarget: "claude",
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init", "--target", "opencode"]), {
    command: "init",
    withCodex: false,
    runtimeTarget: "opencode",
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init", "--target", "both"]), {
    command: "init",
    withCodex: false,
    runtimeTarget: "both",
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init", "--target", "claude"]), {
    command: "init",
    withCodex: false,
    runtimeTarget: "claude",
  });
  // A garbage --target must fail loud, not silently fall back to claude-only.
  assert.throws(() => parseCliArgs(["node", "cli.mjs", "init", "--target", "codex"]), /invalid --target/);
});

test("decideCodex: explicit flag wins without prompting", async () => {
  let asked = false;
  const ask = async () => { asked = true; return "n"; };
  assert.equal(await decideCodex({ withCodexFlag: true, isTTY: true, ask }), true);
  assert.equal(asked, false, "flag short-circuits the prompt");
});

test("decideCodex: non-TTY with no flag defaults OFF (safe default)", async () => {
  const ask = async () => assert.fail("must not prompt without a TTY");
  assert.equal(await decideCodex({ withCodexFlag: false, isTTY: false, ask }), false);
});

test("decideCodex: TTY prompt honors yes/no", async () => {
  assert.equal(await decideCodex({ withCodexFlag: false, isTTY: true, ask: async () => "y" }), true);
  assert.equal(await decideCodex({ withCodexFlag: false, isTTY: true, ask: async () => "yes" }), true);
  assert.equal(await decideCodex({ withCodexFlag: false, isTTY: true, ask: async () => "" }), false);
  assert.equal(await decideCodex({ withCodexFlag: false, isTTY: true, ask: async () => "nope" }), false);
});

test("withCodexToggle: sets env flag, preserves other keys, never mutates input", () => {
  const original = { permissions: { allow: ["x"] }, env: { FOO: "bar" } };
  const next = withCodexToggle(original);
  assert.equal(next.env.HARNESS_CODEX_ADVERSARY, "1");
  assert.equal(next.env.FOO, "bar", "existing env keys preserved");
  assert.deepEqual(next.permissions, { allow: ["x"] }, "unrelated keys preserved");
  assert.equal(original.env.HARNESS_CODEX_ADVERSARY, undefined, "input not mutated");
  assert.deepEqual(withCodexToggle(undefined), { env: { HARNESS_CODEX_ADVERSARY: "1" } });
});

test("SOURCE_URL is the baked slug", () => {
  assert.equal(SOURCE_URL, "https://github.com/orobsonn/claude-harness.git");
});

test("runInit delegates to vendor with resolved tag", () => {
  let calls = 0; let arg = null;
  const ret = runInit({
    cwd: "/tmp/target-proj",
    resolveTag: () => "v0.15.0",
    runVendor: (o) => { calls++; arg = o; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(arg, {
    source: "https://github.com/orobsonn/claude-harness.git",
    ref: "v0.15.0",
    target: "/tmp/target-proj",
    withCodex: false,
    runtimeTarget: "claude",
  });
  assert.equal(ret, "v0.15.0");
});

test("runInit throws when tag cannot be resolved and never vendors", () => {
  let calls = 0;
  assert.throws(() => runInit({
    cwd: "/tmp/target-proj",
    resolveTag: () => null,
    runVendor: () => { calls++; },
  }));
  assert.equal(calls, 0);
});

test("writeLifecycleSnapshot preserves the pre-vendor tracked and untracked baseline for an old project", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-snapshot-"));
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  try {
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "base"]);
    writeFileSync(join(root, "tracked.txt"), "changed\n");
    writeFileSync(join(root, "untracked.txt"), "local\n");

    assert.equal(writeLifecycleSnapshot(root, "updating-harness"), 2);
    const snapshot = JSON.parse(readFileSync(join(root, ".git", "harness-lifecycle-updating-harness.json"), "utf8"));
    assert.deepEqual(new Set(snapshot.paths), new Set(["tracked.txt", "untracked.txt"]));
    assert.throws(() => writeLifecycleSnapshot(root, "configuring-model-routing"), /only updating-harness/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isDirectCli resolves symlinks (npm bin is a symlink, not the real module path)", () => {
  const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  // direct real path -> true
  assert.equal(isDirectCli(cliPath), true);
  // a symlink pointing at the real module -> true (realpath resolves it)
  const dir = mkdtempSync(join(tmpdir(), "cli-link-"));
  try {
    const link = join(dir, "claude-harness");
    symlinkSync(cliPath, link);
    assert.equal(isDirectCli(link), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // an unrelated / nonexistent path -> false
  assert.equal(isDirectCli("/definitely/not/the/cli.mjs"), false);
});
