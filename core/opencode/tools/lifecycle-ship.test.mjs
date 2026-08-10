/** @description Contract for the lifecycle-only commit selector. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoPreexistingManagedTrackedPath,
  assertLifecycleOnly,
  decideLifecyclePreparation,
  legacyTrackedOwnership,
  selectOwnedPaths,
  selectLifecyclePaths,
} from "./lifecycle-ship.mjs";

const toolPath = fileURLToPath(new URL("./lifecycle-ship.mjs", import.meta.url));

test("selectLifecyclePaths keeps framework cargo and leaves product work plus run ephemera out", () => {
  const selected = selectLifecyclePaths([
    ".opencode/agents/harness-config.md",
    ".opencode/shared/lib/feature-id.mjs",
    ".opencode/.harness-version",
    "opencode.json",
    "AGENTS.md",
    "opencode.harness.json",
    ".opencode/plans/session-feature/plan.json",
    ".opencode/plans/.state/session.json",
    ".dev.vars",
    "src/product.ts",
  ]);

  assert.deepEqual(selected, [
    ".opencode/agents/harness-config.md",
    ".opencode/shared/lib/feature-id.mjs",
    ".opencode/.harness-version",
    "opencode.json",
    "AGENTS.md",
  ]);
});

test("snapshot rejects a pre-existing tracked change in harness-owned cargo", () => {
  assert.throws(
    () => assertNoPreexistingManagedTrackedPath([".opencode/plugin/local-change.ts", "src/product.ts"]),
    /pre-existing tracked change/i,
  );
});

test("selectOwnedPaths excludes a local plugin that is absent from the vendor manifest", () => {
  assert.deepEqual(
    selectOwnedPaths([".opencode/plugin/entry-gate.ts", ".opencode/plugin/local-plugin.ts"], new Set([".opencode/plugin/entry-gate.ts"])),
    [".opencode/plugin/entry-gate.ts"],
  );
});

test("legacy snapshot ownership admits only tracked legacy harness paths", () => {
  assert.deepEqual(
    [...legacyTrackedOwnership([".opencode/plugin/entry-gate.ts", ".opencode/plans/local.json", "src/product.ts"])],
    [".opencode/plugin/entry-gate.ts"],
  );
});

test("assertLifecycleOnly refuses an existing branch that contains product work", () => {
  assert.throws(
    () => assertLifecycleOnly([".opencode/tools/classify.ts", "src/product.ts"]),
    /outside the lifecycle ownership set/i,
  );
});

test("a product feature branch can carry an uncommitted lifecycle update to the default branch", () => {
  assert.deepEqual(
    decideLifecyclePreparation(["src/product.ts"], [".opencode/tools/classify.ts", "src/draft.ts"]),
    { action: "commit", paths: [".opencode/tools/classify.ts"] },
  );
});

test("CLI executes its argument guard when called through a relative shell path", () => {
  const result = spawnSync(process.execPath, ["core/opencode/tools/lifecycle-ship.mjs", "prepare", "product-delivery"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported lifecycle operation|usage:/i);
});

test("vendored CLI executes its argument guard when called through an absolute path", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-ship-vendored-"));
  const vendored = join(root, ".opencode", "tools", "lifecycle-ship.mjs");
  mkdirSync(join(root, ".opencode", "tools"), { recursive: true });
  cpSync(toolPath, vendored);

  const result = spawnSync(process.execPath, [vendored, "prepare", "product-delivery"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported lifecycle operation|usage:/i);
});

test("automatic adoption commits only vendor paths and preserves staged product work", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-adopt-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const project = join(root, "project");
  const git = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const mustGit = (cwd, args) => {
    const result = git(cwd, args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  try {
    assert.equal(spawnSync("git", ["init", "--bare", "--initial-branch=main", remote]).status, 0);
    assert.equal(spawnSync("git", ["init", "--initial-branch=main", seed]).status, 0);
    mustGit(seed, ["config", "user.email", "test@example.com"]);
    mustGit(seed, ["config", "user.name", "Test"]);
    mkdirSync(join(seed, ".opencode"), { recursive: true });
    mkdirSync(join(seed, "src"), { recursive: true });
    writeFileSync(join(seed, ".opencode", ".harness-owned-files.json"), JSON.stringify({
      version: 1,
      files: [".opencode/harness.md", "opencode.json"],
    }));
    writeFileSync(join(seed, ".opencode", "harness.md"), "before\n");
    writeFileSync(join(seed, "opencode.json"), "{}\n");
    writeFileSync(join(seed, "src", "product.js"), "base\n");
    mustGit(seed, ["add", "."]);
    mustGit(seed, ["commit", "-m", "base"]);
    mustGit(seed, ["remote", "add", "origin", remote]);
    mustGit(seed, ["push", "-u", "origin", "main"]);
    assert.equal(spawnSync("git", ["clone", remote, project]).status, 0);
    mustGit(project, ["config", "user.email", "test@example.com"]);
    mustGit(project, ["config", "user.name", "Test"]);

    writeFileSync(join(project, ".opencode", "harness.md"), "vendored\n");
    writeFileSync(join(project, "opencode.json"), '{"harness":true}\n');
    writeFileSync(join(project, "src", "product.js"), "operator work\n");
    mustGit(project, ["add", "src/product.js"]);
    mkdirSync(join(project, ".opencode", "plans"), { recursive: true });
    writeFileSync(join(project, ".opencode", "plans", "local.json"), "{}\n");

    const adopted = spawnSync(process.execPath, [toolPath, "adopt", "updating-harness"], {
      cwd: project,
      encoding: "utf8",
    });
    assert.equal(adopted.status, 0, adopted.stderr);
    assert.deepEqual(
      mustGit(project, ["show", "--format=", "--name-only", "HEAD"]).trim().split("\n"),
      [".opencode/harness.md", "opencode.json"],
    );
    assert.equal(mustGit(project, ["diff", "--cached", "--name-only"]).trim(), "src/product.js");
    assert.equal(existsSync(join(project, ".opencode", "plans", "local.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic adoption unions exact OpenCode and Claude manifests without staging local cargo", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-adopt-both-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const project = join(root, "project");
  const git = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const mustGit = (cwd, args) => {
    const result = git(cwd, args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  try {
    assert.equal(spawnSync("git", ["init", "--bare", "--initial-branch=main", remote]).status, 0);
    assert.equal(spawnSync("git", ["init", "--initial-branch=main", seed]).status, 0);
    mustGit(seed, ["config", "user.email", "test@example.com"]);
    mustGit(seed, ["config", "user.name", "Test"]);
    mkdirSync(join(seed, ".opencode"), { recursive: true });
    mkdirSync(join(seed, ".claude"), { recursive: true });
    mkdirSync(join(seed, "src"), { recursive: true });
    writeFileSync(join(seed, ".opencode", ".harness-owned-files.json"), JSON.stringify({
      version: 1,
      files: [".opencode/harness.md"],
    }));
    writeFileSync(join(seed, ".claude", ".harness-owned-files.json"), JSON.stringify({
      version: 1,
      files: [".claude/agents/harness-config.md"],
    }));
    mkdirSync(join(seed, ".claude", "agents"), { recursive: true });
    writeFileSync(join(seed, ".opencode", "harness.md"), "before\n");
    writeFileSync(join(seed, ".claude", "agents", "harness-config.md"), "before\n");
    writeFileSync(join(seed, "src", "product.js"), "base\n");
    mustGit(seed, ["add", "."]);
    mustGit(seed, ["commit", "-m", "base"]);
    mustGit(seed, ["remote", "add", "origin", remote]);
    mustGit(seed, ["push", "-u", "origin", "main"]);
    assert.equal(spawnSync("git", ["clone", remote, project]).status, 0);
    mustGit(project, ["config", "user.email", "test@example.com"]);
    mustGit(project, ["config", "user.name", "Test"]);

    writeFileSync(join(project, ".opencode", "harness.md"), "vendored OC\n");
    writeFileSync(join(project, ".claude", "agents", "harness-config.md"), "vendored CC\n");
    writeFileSync(join(project, "src", "product.js"), "operator work\n");
    mkdirSync(join(project, ".claude", "plans"), { recursive: true });
    writeFileSync(join(project, ".claude", "plans", "local.json"), "{}\n");
    mustGit(project, ["add", "src/product.js"]);

    const adopted = spawnSync(process.execPath, [toolPath, "adopt", "updating-harness"], {
      cwd: project,
      encoding: "utf8",
    });
    assert.equal(adopted.status, 0, adopted.stderr);
    assert.deepEqual(
      mustGit(project, ["show", "--format=", "--name-only", "HEAD"]).trim().split("\n"),
      [".claude/agents/harness-config.md", ".opencode/harness.md"],
    );
    assert.equal(mustGit(project, ["diff", "--cached", "--name-only"]).trim(), "src/product.js");
    assert.equal(existsSync(join(project, ".claude", "plans", "local.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
