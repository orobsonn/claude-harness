import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, symlinkSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLifecycleClone, hasInstalledHarness, parseCliArgs, resolveCommand, runInit, runIsolatedLifecycleUpdate, syncCallerCheckout, syncCallerRuntimeOverlay, SOURCE_URL, isDirectCli, decideCodex, withCodexToggle } from "./cli.mjs";

const cliSource = readFileSync(fileURLToPath(new URL("./cli.mjs", import.meta.url)), "utf8");

test("parseCliArgs", () => {
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init"]), {
    command: "init",
    withCodex: false,
    runtimeTarget: "claude",
    releaseRef: undefined,
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "bogus"]), {
    command: "bogus",
    withCodex: false,
    runtimeTarget: "claude",
    releaseRef: undefined,
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs"]), {
    command: undefined,
    withCodex: false,
    runtimeTarget: "claude",
    releaseRef: undefined,
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init", "--with-codex"]), {
    command: "init",
    withCodex: true,
    runtimeTarget: "claude",
    releaseRef: undefined,
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init", "--target", "opencode"]), {
    command: "init",
    withCodex: false,
    runtimeTarget: "opencode",
    releaseRef: undefined,
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init", "--target", "codex"]), {
    command: "init",
    withCodex: false,
    runtimeTarget: "codex",
    releaseRef: undefined,
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init", "--target", "all"]), {
    command: "init",
    withCodex: false,
    runtimeTarget: "all",
    releaseRef: undefined,
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init", "--target", "both"]), {
    command: "init",
    withCodex: false,
    runtimeTarget: "both",
    releaseRef: undefined,
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init", "--target", "claude"]), {
    command: "init",
    withCodex: false,
    runtimeTarget: "claude",
    releaseRef: undefined,
  });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "lifecycle-update", "--target", "both", "--ref", "v0.55.44"]), {
    command: "lifecycle-update",
    withCodex: false,
    runtimeTarget: "both",
    releaseRef: "v0.55.44",
  });
  // A garbage --target must fail loud, not silently fall back to claude-only.
  assert.throws(() => parseCliArgs(["node", "cli.mjs", "init", "--target", "cluade"]), /invalid --target/);
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

test("an existing OpenCode installation uses the isolated update path", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-existing-harness-"));
  try {
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(join(root, ".opencode", ".harness-version"), "v0.55.39\n");

    assert.equal(hasInstalledHarness(root, "opencode"), true);
    assert.equal(hasInstalledHarness(root, "both"), true);
    assert.equal(hasInstalledHarness(root, "claude"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing Codex installation uses the isolated update path", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-existing-codex-harness-"));
  try {
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", ".harness-version"), "v0.59.1\n");

    assert.equal(hasInstalledHarness(root, "codex"), true);
    assert.equal(hasInstalledHarness(root, "all"), true);
    assert.equal(hasInstalledHarness(root, "opencode"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle update does not wait for GitHub Actions to materialize before requesting its merge", () => {
  const ship = cliSource.slice(
    cliSource.indexOf("function shipPreparedLifecycle"),
    cliSource.indexOf("export function runIsolatedLifecycleUpdate"),
  );

  assert.match(ship, /pulls\/\$\{pr\.number\}\/merge/);
  assert.doesNotMatch(ship, /actions\/workflows/);
  assert.doesNotMatch(ship, /\["pr", "checks"/);
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

test("lifecycle-snapshot is a compatibility no-op for old OpenCode skills", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-bootstrap-"));
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  try {
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "base"]);
    writeFileSync(join(root, "untracked.txt"), "local\n");

    const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [cliPath, "lifecycle-snapshot", "updating-harness"], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /compatibility preflight complete — run the pinned init command now\./i);
    assert.equal(existsSync(join(root, ".git", "harness-lifecycle-updating-harness.json")), false);
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

test("createLifecycleClone starts from origin main without changing a dirty caller checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-clone-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const caller = join(root, "caller");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  const gitOut = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    mkdirSync(join(seed, "src"), { recursive: true });
    writeFileSync(join(seed, "src", "product.js"), "base\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "base"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    execFileSync("git", ["clone", remote, caller], { stdio: "ignore" });

    writeFileSync(join(seed, "src", "remote.js"), "remote tip\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "remote advance"]);
    git(seed, ["push"]);

    writeFileSync(join(caller, "src", "product.js"), "operator work\n");
    git(caller, ["add", "src/product.js"]);
    const before = gitOut(caller, ["status", "--porcelain=v1"]);

    const lifecycle = createLifecycleClone(caller);

    assert.equal(lifecycle.defaultBranch, "main");
    assert.equal(
      gitOut(lifecycle.directory, ["rev-parse", "HEAD"]).trim(),
      gitOut(caller, ["rev-parse", "origin/main"]).trim(),
      "the isolated checkout starts from the fetched remote default tip",
    );
    assert.equal(gitOut(caller, ["status", "--porcelain=v1"]), before, "caller worktree and index are byte-for-byte untouched");
    assert.notEqual(
      resolve(lifecycle.directory, gitOut(lifecycle.directory, ["rev-parse", "--git-common-dir"]).trim()),
      resolve(caller, gitOut(caller, ["rev-parse", "--git-common-dir"]).trim()),
      "a clone has an independent Git database, unlike a linked worktree",
    );
    lifecycle.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncCallerCheckout fast-forwards active main and preserves staged product work", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-sync-main-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const caller = join(root, "caller");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  const gitOut = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    mkdirSync(join(seed, ".opencode"), { recursive: true });
    mkdirSync(join(seed, "src"), { recursive: true });
    writeFileSync(join(seed, ".opencode", ".harness-version"), "v1\n");
    writeFileSync(join(seed, "src", "product.js"), "base\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "base"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    execFileSync("git", ["clone", remote, caller], { stdio: "ignore" });

    writeFileSync(join(caller, "src", "product.js"), "operator work\n");
    git(caller, ["add", "src/product.js"]);
    const stagedBefore = gitOut(caller, ["diff", "--cached", "--", "src/product.js"]);
    writeFileSync(join(seed, ".opencode", ".harness-version"), "v2\n");
    git(seed, ["add", ".opencode/.harness-version"]);
    git(seed, ["commit", "-m", "harness update"]);
    git(seed, ["push"]);

    assert.deepEqual(syncCallerCheckout({ cwd: caller, defaultBranch: "main" }), { action: "synced" });
    assert.equal(readFileSync(join(caller, ".opencode", ".harness-version"), "utf8"), "v2\n");
    assert.equal(gitOut(caller, ["diff", "--cached", "--", "src/product.js"]), stagedBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncCallerCheckout never switches a feature branch to main", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-sync-branch-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const caller = join(root, "caller");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  const gitOut = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    writeFileSync(join(seed, "product.txt"), "base\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "base"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    execFileSync("git", ["clone", remote, caller], { stdio: "ignore" });
    git(caller, ["switch", "-c", "feature/operator-work"]);

    assert.deepEqual(
      syncCallerCheckout({ cwd: caller, defaultBranch: "main" }),
      { action: "skipped", reason: "active branch is not the default branch" },
    );
    assert.equal(gitOut(caller, ["branch", "--show-current"]).trim(), "feature/operator-work");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncCallerRuntimeOverlay refreshes only exact harness cargo in a feature checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-runtime-overlay-"));
  const caller = join(root, "caller");
  const source = join(root, "source");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  const gitOut = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  try {
    execFileSync("git", ["init", "--initial-branch=main", caller], { stdio: "ignore" });
    git(caller, ["config", "user.email", "test@example.com"]);
    git(caller, ["config", "user.name", "Test"]);
    mkdirSync(join(caller, ".opencode", "plugin"), { recursive: true });
    mkdirSync(join(caller, "src"), { recursive: true });
    writeFileSync(join(caller, ".opencode", ".harness-version"), "v1\n");
    writeFileSync(join(caller, ".opencode", "plugin", "official.ts"), "export const generation = 1\n");
    writeFileSync(join(caller, ".opencode", "plugin", "local.ts"), "export const local = true\n");
    writeFileSync(join(caller, "src", "product.js"), "operator work\n");
    git(caller, ["add", "."]);
    git(caller, ["commit", "-m", "base"]);
    git(caller, ["switch", "-c", "feature/operator-work"]);
    writeFileSync(join(caller, "src", "product.js"), "staged operator work\n");
    git(caller, ["add", "src/product.js"]);
    const stagedProduct = gitOut(caller, ["diff", "--cached", "--", "src/product.js"]);
    const headBefore = gitOut(caller, ["rev-parse", "HEAD"]).trim();

    mkdirSync(join(source, ".opencode", "plugin"), { recursive: true });
    writeFileSync(join(source, ".opencode", ".harness-version"), "v2\n");
    writeFileSync(join(source, ".opencode", "plugin", "official.ts"), "export const generation = 2\n");
    writeFileSync(join(source, ".opencode", ".harness-owned-files.json"), JSON.stringify({
      version: 1,
      files: [
        ".opencode/.harness-version",
        ".opencode/.harness-owned-files.json",
        ".opencode/plugin/official.ts",
      ],
      retired: [],
    }));

    assert.deepEqual(
      syncCallerRuntimeOverlay({ cwd: caller, sourceDirectory: source, runtimeTarget: "opencode" }),
      { action: "synced", paths: [".opencode/.harness-owned-files.json", ".opencode/.harness-version", ".opencode/plugin/official.ts"] },
    );
    assert.equal(readFileSync(join(caller, ".opencode", ".harness-version"), "utf8"), "v2\n");
    assert.equal(readFileSync(join(caller, ".opencode", "plugin", "official.ts"), "utf8"), "export const generation = 2\n");
    assert.equal(readFileSync(join(caller, ".opencode", "plugin", "local.ts"), "utf8"), "export const local = true\n");
    assert.equal(gitOut(caller, ["rev-parse", "HEAD"]).trim(), headBefore, "runtime refresh never moves the feature branch");
    assert.equal(gitOut(caller, ["diff", "--cached", "--", "src/product.js"]), stagedProduct, "product staging remains exact");
    assert.equal(gitOut(caller, ["status", "--porcelain=v1", "--", ".opencode/plugin/local.ts"]).trim(), "", "a local plugin is outside the runtime overlay");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncCallerRuntimeOverlay replaces divergent harness cargo while preserving product work", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-runtime-conflict-"));
  const caller = join(root, "caller");
  const source = join(root, "source");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  const gitOut = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  try {
    execFileSync("git", ["init", "--initial-branch=main", caller], { stdio: "ignore" });
    git(caller, ["config", "user.email", "test@example.com"]);
    git(caller, ["config", "user.name", "Test"]);
    mkdirSync(join(caller, ".opencode"), { recursive: true });
    mkdirSync(join(caller, "src"), { recursive: true });
    writeFileSync(join(caller, ".opencode", ".harness-version"), "v1-local-edit\n");
    writeFileSync(join(caller, "src", "product.js"), "base\n");
    git(caller, ["add", "."]);
    git(caller, ["commit", "-m", "base"]);
    writeFileSync(join(caller, ".opencode", ".harness-version"), "operator edit\n");
    writeFileSync(join(caller, "src", "product.js"), "staged product work\n");
    git(caller, ["add", "src/product.js"]);
    mkdirSync(join(caller, ".opencode", "plans"), { recursive: true });
    writeFileSync(join(caller, ".opencode", "plans", "active.json"), "local plan\n");
    const productStage = gitOut(caller, ["diff", "--cached", "--", "src/product.js"]);
    const headBefore = gitOut(caller, ["rev-parse", "HEAD"]).trim();

    mkdirSync(join(source, ".opencode"), { recursive: true });
    writeFileSync(join(source, ".opencode", ".harness-version"), "v2\n");
    writeFileSync(join(source, ".opencode", ".harness-owned-files.json"), JSON.stringify({
      version: 1,
      files: [".opencode/.harness-version", ".opencode/.harness-owned-files.json"],
      retired: [],
    }));

    assert.deepEqual(
      syncCallerRuntimeOverlay({ cwd: caller, sourceDirectory: source, runtimeTarget: "opencode" }),
      { action: "synced", paths: [".opencode/.harness-owned-files.json", ".opencode/.harness-version"] },
    );
    assert.equal(readFileSync(join(caller, ".opencode", ".harness-version"), "utf8"), "v2\n");
    assert.equal(readFileSync(join(caller, ".opencode", "plans", "active.json"), "utf8"), "local plan\n");
    assert.equal(gitOut(caller, ["diff", "--cached", "--", "src/product.js"]), productStage);
    assert.equal(gitOut(caller, ["rev-parse", "HEAD"]).trim(), headBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncCallerRuntimeOverlay reapplies the released runtime after a later owned-file edit", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-runtime-provenance-"));
  const caller = join(root, "caller");
  const source = join(root, "source");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  const writeSource = (version) => {
    mkdirSync(join(source, ".opencode"), { recursive: true });
    writeFileSync(join(source, ".opencode", ".harness-version"), `${version}\n`);
    writeFileSync(join(source, ".opencode", ".harness-owned-files.json"), JSON.stringify({
      version: 1,
      files: [".opencode/.harness-version", ".opencode/.harness-owned-files.json"],
      retired: [],
    }));
  };
  try {
    execFileSync("git", ["init", "--initial-branch=main", caller], { stdio: "ignore" });
    git(caller, ["config", "user.email", "test@example.com"]);
    git(caller, ["config", "user.name", "Test"]);
    mkdirSync(join(caller, ".opencode"), { recursive: true });
    writeFileSync(join(caller, ".opencode", ".harness-version"), "v1\n");
    git(caller, ["add", "."]);
    git(caller, ["commit", "-m", "base"]);
    git(caller, ["switch", "-c", "feature/operator-work"]);

    writeSource("v2");
    assert.equal(syncCallerRuntimeOverlay({ cwd: caller, sourceDirectory: source, runtimeTarget: "opencode" }).action, "synced");
    writeSource("v3");
    assert.equal(syncCallerRuntimeOverlay({ cwd: caller, sourceDirectory: source, runtimeTarget: "opencode" }).action, "synced");
    assert.equal(readFileSync(join(caller, ".opencode", ".harness-version"), "utf8"), "v3\n");

    writeFileSync(join(caller, ".opencode", ".harness-version"), "operator edit\n");
    writeSource("v4");
    assert.equal(syncCallerRuntimeOverlay({ cwd: caller, sourceDirectory: source, runtimeTarget: "opencode" }).action, "synced");
    assert.equal(readFileSync(join(caller, ".opencode", ".harness-version"), "utf8"), "v4\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncCallerRuntimeOverlay refuses a harness path behind a symbolic link", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-runtime-symlink-"));
  const caller = join(root, "caller");
  const source = join(root, "source");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  try {
    execFileSync("git", ["init", "--initial-branch=main", caller], { stdio: "ignore" });
    git(caller, ["config", "user.email", "test@example.com"]);
    git(caller, ["config", "user.name", "Test"]);
    mkdirSync(join(caller, "src"), { recursive: true });
    writeFileSync(join(caller, "src", ".harness-version"), "product file\n");
    symlinkSync("src", join(caller, ".opencode"));

    mkdirSync(join(source, ".opencode"), { recursive: true });
    writeFileSync(join(source, ".opencode", ".harness-version"), "v2\n");
    writeFileSync(join(source, ".opencode", ".harness-owned-files.json"), JSON.stringify({
      version: 1,
      files: [".opencode/.harness-version", ".opencode/.harness-owned-files.json"],
      retired: [],
    }));

    assert.throws(
      () => syncCallerRuntimeOverlay({ cwd: caller, sourceDirectory: source, runtimeTarget: "opencode" }),
      /symbolic link/i,
    );
    assert.equal(readFileSync(join(caller, "src", ".harness-version"), "utf8"), "product file\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runIsolatedLifecycleUpdate vendors in a clone then synchronizes active main", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-run-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const caller = join(root, "caller");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  const gitOut = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    mkdirSync(join(seed, "src"), { recursive: true });
    mkdirSync(join(seed, ".opencode"), { recursive: true });
    writeFileSync(join(seed, "src", "product.js"), "base\n");
    writeFileSync(join(seed, ".opencode", ".harness-version"), "v1\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "base"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    execFileSync("git", ["clone", remote, caller], { stdio: "ignore" });

    writeFileSync(join(caller, "src", "product.js"), "operator work\n");
    git(caller, ["add", "src/product.js"]);
    const before = gitOut(caller, ["status", "--porcelain=v1"]);
    writeFileSync(join(seed, ".opencode", ".harness-version"), "v2\n");
    git(seed, ["add", ".opencode/.harness-version"]);
    git(seed, ["commit", "-m", "remote harness update"]);
    git(seed, ["push"]);
    let vendorTarget = "";
    let shipTarget = "";
    const result = runIsolatedLifecycleUpdate({
      cwd: caller,
      ref: "v0.55.44",
      runtimeTarget: "opencode",
      snapshot: () => {},
      runVendor: ({ target, ref, runtimeTarget }) => {
        vendorTarget = target;
        assert.equal(ref, "v0.55.44");
        assert.equal(runtimeTarget, "opencode");
      },
      prepare: () => ({ action: "committed", branch: "chore/harness-lifecycle-test", paths: [".opencode/.harness-version"] }),
      ship: ({ directory, prepared }) => {
        shipTarget = directory;
        assert.equal(prepared.action, "committed");
        return { action: "merged", url: "https://example.test/pr/1" };
      },
    });

    assert.deepEqual(result, {
      action: "merged",
      url: "https://example.test/pr/1",
      callerSync: { action: "synced" },
      callerRuntimeSync: { action: "not-needed", paths: [] },
    });
    assert.equal(vendorTarget, shipTarget);
    assert.equal(existsSync(vendorTarget), false, "the temporary clone is always cleaned after the lifecycle run");
    assert.equal(readFileSync(join(caller, ".opencode", ".harness-version"), "utf8"), "v2\n");
    assert.equal(gitOut(caller, ["status", "--porcelain=v1"]), before, "caller product work remains untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runIsolatedLifecycleUpdate commits manifest-declared retired OpenCode files", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-retired-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const caller = join(root, "caller");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  const gitOut = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    mkdirSync(join(seed, ".opencode", "agents"), { recursive: true });
    writeFileSync(join(seed, ".opencode", ".harness-version"), "v1\n");
    writeFileSync(join(seed, ".opencode", "agents", "plan.md"), "---\nmode: primary\n---\n# Retired\n");
    writeFileSync(join(seed, ".opencode", "agents", "harness-config.md"), "---\nmode: primary\n---\n# Retired\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "base"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    execFileSync("git", ["clone", remote, caller], { stdio: "ignore" });
    git(caller, ["config", "user.email", "test@example.com"]);
    git(caller, ["config", "user.name", "Test"]);

    const result = runIsolatedLifecycleUpdate({
      cwd: caller,
      ref: "v2-test",
      runtimeTarget: "opencode",
      runVendor: ({ target }) => {
        rmSync(join(target, ".opencode", "agents", "plan.md"), { force: true });
        rmSync(join(target, ".opencode", "agents", "harness-config.md"), { force: true });
        writeFileSync(join(target, ".opencode", ".harness-version"), "v2\n");
        writeFileSync(join(target, ".opencode", ".harness-owned-files.json"), JSON.stringify({
          version: 1,
          files: [".opencode/.harness-version", ".opencode/.harness-owned-files.json"],
          retired: [".opencode/agents/plan.md", ".opencode/agents/harness-config.md"],
        }));
      },
      ship: ({ directory, prepared }) => {
        assert.equal(prepared.action, "committed");
        assert.deepEqual(prepared.paths, [
          ".opencode/.harness-owned-files.json",
          ".opencode/.harness-version",
          ".opencode/agents/harness-config.md",
          ".opencode/agents/plan.md",
        ]);
        const committed = gitOut(directory, ["show", "--format=", "--name-status", "HEAD"]);
        assert.match(committed, /D\s+\.opencode\/agents\/plan\.md/);
        assert.match(committed, /D\s+\.opencode\/agents\/harness-config\.md/);
        return prepared;
      },
    });

    assert.equal(result.action, "committed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runIsolatedLifecycleUpdate rejects retired paths that are still present or outside their runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-retired-guard-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const caller = join(root, "caller");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    mkdirSync(join(seed, ".opencode", "agents"), { recursive: true });
    writeFileSync(join(seed, ".opencode", "agents", "plan.md"), "old\n");
    writeFileSync(join(seed, "product.txt"), "product\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "base"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    execFileSync("git", ["clone", remote, caller], { stdio: "ignore" });

    assert.throws(
      () => runIsolatedLifecycleUpdate({
        cwd: caller,
        ref: "v2-test",
        runtimeTarget: "opencode",
        runVendor: ({ target }) => writeFileSync(join(target, ".opencode", ".harness-owned-files.json"), JSON.stringify({
          version: 1,
          files: [".opencode/.harness-owned-files.json"],
          retired: [".opencode/agents/plan.md"],
        })),
        ship: () => assert.fail("a present retired path must never reach PR shipping"),
      }),
      /still present after vendoring/i,
    );

    assert.throws(
      () => runIsolatedLifecycleUpdate({
        cwd: caller,
        ref: "v2-test",
        runtimeTarget: "opencode",
        runVendor: ({ target }) => writeFileSync(join(target, ".opencode", ".harness-owned-files.json"), JSON.stringify({
          version: 1,
          files: [".opencode/.harness-owned-files.json", ".opencode/agents/plan.md"],
          retired: [".opencode/agents/plan.md"],
        })),
        ship: () => assert.fail("an active-and-retired path must never reach PR shipping"),
      }),
      /both active and retired/i,
    );

    assert.throws(
      () => runIsolatedLifecycleUpdate({
        cwd: caller,
        ref: "v2-test",
        runtimeTarget: "opencode",
        runVendor: ({ target }) => {
          rmSync(join(target, "product.txt"));
          writeFileSync(join(target, ".opencode", ".harness-owned-files.json"), JSON.stringify({
            version: 1,
            files: [".opencode/.harness-owned-files.json"],
            retired: ["product.txt"],
          }));
        },
        ship: () => assert.fail("a cross-runtime retired path must never reach PR shipping"),
      }),
      /outside the expected runtime root/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runIsolatedLifecycleUpdate refreshes the runtime overlay when the caller is a feature branch", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-run-overlay-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const caller = join(root, "caller");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    writeFileSync(join(seed, "product.txt"), "base\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "base"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    execFileSync("git", ["clone", remote, caller], { stdio: "ignore" });
    let overlayInput = null;

    const result = runIsolatedLifecycleUpdate({
      cwd: caller,
      ref: "v0.55.53",
      runtimeTarget: "opencode",
      runVendor: () => {},
      prepare: () => ({ action: "committed", branch: "chore/harness-lifecycle-test", paths: [".opencode/.harness-version"] }),
      ship: () => ({ action: "merged", url: "https://example.test/pr/overlay" }),
      syncCaller: () => ({ action: "skipped", reason: "active branch is not the default branch" }),
      syncRuntime: (input) => {
        overlayInput = input;
        return { action: "synced", paths: [".opencode/.harness-version"] };
      },
    });

    assert.equal(overlayInput.cwd, caller);
    assert.equal(overlayInput.runtimeTarget, "opencode");
    assert.notEqual(overlayInput.sourceDirectory, caller, "the overlay copies from the verified lifecycle clone, never the caller");
    assert.deepEqual(result.callerRuntimeSync, { action: "synced", paths: [".opencode/.harness-version"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runIsolatedLifecycleUpdate prepares a Claude-only lifecycle commit from that runtime's exact manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-claude-only-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const caller = join(root, "caller");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  const gitOut = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    mkdirSync(join(seed, "src"), { recursive: true });
    writeFileSync(join(seed, "src", "product.js"), "base\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "base"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    execFileSync("git", ["clone", remote, caller], { stdio: "ignore" });
    git(caller, ["config", "user.email", "test@example.com"]);
    git(caller, ["config", "user.name", "Test"]);
    writeFileSync(join(caller, "src", "product.js"), "operator work\n");
    git(caller, ["add", "src/product.js"]);
    const before = gitOut(caller, ["status", "--porcelain=v1"]);

    const result = runIsolatedLifecycleUpdate({
      cwd: caller,
      ref: "v0.55.44",
      runtimeTarget: "claude",
      runVendor: ({ target }) => {
        mkdirSync(join(target, ".claude", "agents"), { recursive: true });
        writeFileSync(join(target, ".claude", "agents", "harness.md"), "vendor\n");
        writeFileSync(join(target, ".claude", ".harness-owned-files.json"), JSON.stringify({
          version: 1,
          files: [".claude/.harness-owned-files.json", ".claude/agents/harness.md"],
        }));
        writeFileSync(join(target, "MEMORY.md"), "operator memory is not lifecycle cargo\n");
      },
      ship: ({ directory, prepared }) => {
        assert.equal(prepared.action, "committed");
        assert.deepEqual(prepared.paths, [".claude/.harness-owned-files.json", ".claude/agents/harness.md"]);
        assert.deepEqual(
          gitOut(directory, ["show", "--format=", "--name-only", "HEAD"]).trim().split("\n").sort(),
          prepared.paths,
          "the exact Claude manifest, not an OpenCode helper or product path, determines the commit",
        );
        assert.equal(existsSync(join(directory, ".opencode")), false);
        assert.match(gitOut(directory, ["status", "--porcelain=v1"]), /\?\? MEMORY\.md/);
        return { action: "merged", url: "https://example.test/pr/claude" };
      },
    });

    assert.equal(result.action, "merged");
    assert.equal(gitOut(caller, ["status", "--porcelain=v1"]), before, "the caller's staged product work remains untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runIsolatedLifecycleUpdate rejects an ownership manifest path that escapes the clone", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-manifest-escape-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const caller = join(root, "caller");
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "ignore" });
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    writeFileSync(join(seed, "product.txt"), "base\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "base"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    execFileSync("git", ["clone", remote, caller], { stdio: "ignore" });

    assert.throws(
      () => runIsolatedLifecycleUpdate({
        cwd: caller,
        ref: "v0.55.44",
        runtimeTarget: "opencode",
        runVendor: ({ target }) => {
          mkdirSync(join(target, ".opencode"), { recursive: true });
          writeFileSync(join(target, ".opencode", ".harness-owned-files.json"), JSON.stringify({
            version: 1,
            files: ["../product.txt"],
          }));
        },
        ship: () => assert.fail("a malformed ownership manifest must never reach PR shipping"),
      }),
      /unsafe lifecycle ownership manifest path/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCommand keeps every historical spelling working — an alias is a promise, not a courtesy", () => {
  assert.equal(resolveCommand("init"), "setup-local", "years of docs say `init`");
  assert.equal(resolveCommand("setup-vps"), "setup-orca", "every playbook and every operator types `setup-vps`");
  assert.equal(resolveCommand("setup-orca"), "setup-orca");
  assert.equal(resolveCommand("setup-local"), "setup-local");
  assert.equal(resolveCommand("bogus"), "bogus", "an unknown command must stay unknown, not resolve to something runnable");
});

test("the usage text teaches the two commands an operator cannot guess: setup-orca and orca-doctor", () => {
  const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, "definitely-not-a-command"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npx claude-harness setup-orca/);
  assert.match(result.stderr, /alias: setup-vps/, "the old spelling must stay discoverable, not silently vanish");
  assert.match(result.stderr, /npx claude-harness orca-doctor/);
});
