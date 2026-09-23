import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

import { ensurePiRuntime, resolveVerifiedPiRuntime } from "./pi-runtime-cache.mjs";

const RUNTIME_ASSETS = fileURLToPath(new URL("../runtime-deps/", import.meta.url));
const OVERLAY_SOURCE = fileURLToPath(new URL("./pi-auth-path-patch.mjs", import.meta.url));
const CACHE_MODULE = new URL("./pi-runtime-cache.mjs", import.meta.url).href;

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-cache-"));
  const assetsDir = join(root, "assets");
  mkdirSync(assetsDir);
  writeFileSync(join(assetsDir, "package.json"), JSON.stringify({
    name: "@test/pi-runtime",
    version: "1.0.0",
    private: true,
    dependencies: {
      "@earendil-works/pi-coding-agent": "0.87.1",
      "@gotgenes/pi-subagents": "21.7.4",
    },
  }));
  writeFileSync(join(assetsDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  const overlayPath = join(root, "overlay.mjs");
  writeFileSync(overlayPath, "// test overlay\n");
  return { root, assetsDir, overlayPath, cacheRoot: join(root, "cache") };
}

function runEnsureInChild(root, cacheRoot) {
  const runner = join(root, `ensure-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(runner, [
    `import { ensurePiRuntime } from ${JSON.stringify(CACHE_MODULE)};`,
    "const result = ensurePiRuntime({ cacheRoot: process.argv[2], assetsDir: process.argv[3] });",
    "process.stdout.write(JSON.stringify(result));",
    "process.exitCode = result.ok ? 0 : 1;",
  ].join("\n"));
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [runner, cacheRoot, RUNTIME_ASSETS], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectChild);
    child.on("close", (code) => resolveChild({ code, stdout, stderr }));
  });
}

function expectedGeneration(assetsDir, overlayPath) {
  return createHash("sha256").update(JSON.stringify({
    packageSha256: createHash("sha256").update(readFileSync(join(assetsDir, "package.json"))).digest("hex"),
    lockSha256: createHash("sha256").update(readFileSync(join(assetsDir, "package-lock.json"))).digest("hex"),
    overlaySha256: createHash("sha256").update(readFileSync(overlayPath)).digest("hex"),
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules,
  })).digest("hex");
}

test("resolve never falls back to project or global packages when its generation is absent", () => {
  const fixture = fixtureRoot();
  try {
    const result = resolveVerifiedPiRuntime(fixture);

    assert.deepEqual(result, { ok: false, reason: "runtime-cache-missing" });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ensure provisions a verified Pi runtime in an isolated cache and a later hit never invokes npm", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-cold-"));
  const cacheRoot = join(root, "cache");
  const rejectingNpm = join(root, "npm-must-not-run");
  writeFileSync(rejectingNpm, "#!/bin/sh\nexit 23\n");
  chmodSync(rejectingNpm, 0o700);
  try {
    const cold = ensurePiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS });
    assert.equal(cold.ok, true, cold.ok ? "" : cold.reason);
    assert.equal(cold.paths.piCli.startsWith(cacheRoot), true);
    assert.equal(cold.paths.piPackage.startsWith(cacheRoot), true);
    assert.equal(cold.paths.subagentsExtension.startsWith(cacheRoot), true);
    assert.equal(cold.paths.subagentsPackage.startsWith(cacheRoot), true);

    const hit = ensurePiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS, npmPath: rejectingNpm });
    assert.deepEqual(hit, cold);

    const piBin = join(cold.cacheDir, "node_modules", ".bin", "pi");
    const originalPiBinTarget = readlinkSync(piBin);
    unlinkSync(piBin);
    symlinkSync("/dev/null", piBin);
    const escaping = resolveVerifiedPiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS });
    assert.equal(escaping.ok, false);
    assert.match(escaping.reason, /^runtime-cache-invalid:escaping-symlink:node_modules\/\.bin\/pi$/);
    unlinkSync(piBin);
    symlinkSync(originalPiBinTarget, piBin);

    appendFileSync(cold.paths.piCli, "\n// tampered\n");
    const corrupted = resolveVerifiedPiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS });
    assert.equal(corrupted.ok, false);
    assert.match(corrupted.reason, /^runtime-cache-invalid:tree-integrity$/);

    const repaired = ensurePiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS });
    assert.equal(repaired.ok, true, repaired.ok ? "" : repaired.reason);
    assert.deepEqual(resolveVerifiedPiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS }), repaired);
    assert.equal(
      readdirSync(join(cacheRoot, "generations")).some((name) => name.startsWith(`${repaired.generation}.invalid-`)),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old lock without an owner record is quarantined before a bounded provisioning attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-ownerless-stale-lock-"));
  const cacheRoot = join(root, "cache");
  const failingNpm = join(root, "failing-npm");
  const generation = expectedGeneration(RUNTIME_ASSETS, OVERLAY_SOURCE);
  const lockDir = join(cacheRoot, ".locks", `${generation}.lock`);
  writeFileSync(failingNpm, "#!/bin/sh\nexit 43\n");
  chmodSync(failingNpm, 0o700);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  utimesSync(lockDir, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  try {
    const result = ensurePiRuntime({
      cacheRoot,
      assetsDir: RUNTIME_ASSETS,
      npmPath: failingNpm,
      lockWaitMs: 100,
      staleLockMs: 1,
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /^runtime-npm-failed:exit-43$/);
    assert.equal(readdirSync(join(cacheRoot, ".locks")).some((name) => name.startsWith(`${generation}.lock.stale-`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recent lock without an owner record is never claimed before its stale threshold", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-ownerless-recent-lock-"));
  const cacheRoot = join(root, "cache");
  const generation = expectedGeneration(RUNTIME_ASSETS, OVERLAY_SOURCE);
  const lockDir = join(cacheRoot, ".locks", `${generation}.lock`);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  try {
    const result = ensurePiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS, lockWaitMs: 100, staleLockMs: 10_000 });

    assert.deepEqual(result, { ok: false, reason: "runtime-lock-timeout" });
    assert.equal(readdirSync(join(cacheRoot, ".locks")).includes(`${generation}.lock`), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed old owner record is treated as stale instead of throwing from lock recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-malformed-owner-lock-"));
  const cacheRoot = join(root, "cache");
  const failingNpm = join(root, "failing-npm");
  const generation = expectedGeneration(RUNTIME_ASSETS, OVERLAY_SOURCE);
  const lockDir = join(cacheRoot, ".locks", `${generation}.lock`);
  writeFileSync(failingNpm, "#!/bin/sh\nexit 44\n");
  chmodSync(failingNpm, 0o700);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(lockDir, "owner.json"), "null");
  utimesSync(lockDir, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  try {
    const result = ensurePiRuntime({
      cacheRoot,
      assetsDir: RUNTIME_ASSETS,
      npmPath: failingNpm,
      lockWaitMs: 100,
      staleLockMs: 1,
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /^runtime-npm-failed:exit-44$/);
    assert.equal(readdirSync(join(cacheRoot, ".locks")).some((name) => name.startsWith(`${generation}.lock.stale-`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead stale lock is quarantined so a bounded provisioning attempt can continue", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-stale-lock-"));
  const cacheRoot = join(root, "cache");
  const failingNpm = join(root, "failing-npm");
  const generation = expectedGeneration(RUNTIME_ASSETS, OVERLAY_SOURCE);
  const lockDir = join(cacheRoot, ".locks", `${generation}.lock`);
  writeFileSync(failingNpm, "#!/bin/sh\nexit 42\n");
  chmodSync(failingNpm, 0o700);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
    token: "abandoned",
    host: hostname(),
    pid: 999_999_999,
    createdAt: Date.now(),
  }));
  try {
    const result = ensurePiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS, npmPath: failingNpm, lockWaitMs: 100 });

    assert.equal(result.ok, false);
    assert.match(result.reason, /^runtime-npm-failed:exit-42$/);
    assert.equal(readdirSync(join(cacheRoot, ".locks")).some((name) => name === `${generation}.lock`), false);
    assert.equal(readdirSync(join(cacheRoot, ".locks")).some((name) => name.startsWith(`${generation}.lock.stale-`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent cold installers publish one complete generation and both resolve it", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-concurrent-"));
  const cacheRoot = join(root, "cache");
  try {
    const [first, second] = await Promise.all([
      runEnsureInChild(root, cacheRoot),
      runEnsureInChild(root, cacheRoot),
    ]);

    assert.equal(first.code, 0, first.stderr || first.stdout);
    assert.equal(second.code, 0, second.stderr || second.stdout);
    const firstResult = JSON.parse(first.stdout);
    const secondResult = JSON.parse(second.stdout);
    assert.equal(firstResult.ok, true);
    assert.deepEqual(secondResult, firstResult);
    assert.deepEqual(
      readdirSync(join(cacheRoot, "generations")).filter((name) => !name.startsWith(".staging-")),
      [firstResult.generation],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve rejects a cache generation when the compatibility overlay source changes", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-overlay-key-"));
  const cacheRoot = join(root, "cache");
  const changedOverlay = join(root, "changed-overlay.mjs");
  writeFileSync(changedOverlay, `${readFileSync(OVERLAY_SOURCE, "utf8")}\n// test-only generation change\n`);
  try {
    const provisioned = ensurePiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS });
    assert.equal(provisioned.ok, true, provisioned.ok ? "" : provisioned.reason);

    assert.deepEqual(
      resolveVerifiedPiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS, overlayPath: changedOverlay }),
      { ok: false, reason: "runtime-cache-missing" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed npm install publishes no generation and cleans its private staging directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-npm-failure-"));
  const cacheRoot = join(root, "cache");
  const failingNpm = join(root, "failing-npm");
  writeFileSync(failingNpm, "#!/bin/sh\nexit 41\n");
  chmodSync(failingNpm, 0o700);
  try {
    const result = ensurePiRuntime({ cacheRoot, assetsDir: RUNTIME_ASSETS, npmPath: failingNpm });

    assert.equal(result.ok, false);
    assert.match(result.reason, /^runtime-npm-failed:exit-41$/);
    assert.deepEqual(readdirSync(join(cacheRoot, "generations")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed asset copy cleans the private staging directory before returning a diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-copy-failure-"));
  const cacheRoot = join(root, "cache");
  try {
    const result = ensurePiRuntime({
      cacheRoot,
      assetsDir: RUNTIME_ASSETS,
      copyFile(source, destination) {
        if (source.endsWith("package-lock.json")) throw new Error("copy-failed");
        copyFileSync(source, destination);
      },
    });

    assert.deepEqual(result, { ok: false, reason: "runtime-provision-failed:copy-failed" });
    assert.deepEqual(readdirSync(join(cacheRoot, "generations")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock owner write failure is returned without leaving an ownerless lock", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-lock-owner-failure-"));
  const cacheRoot = join(root, "cache");
  try {
    const result = ensurePiRuntime({
      cacheRoot,
      assetsDir: RUNTIME_ASSETS,
      writeLockOwner() {
        throw new Error("owner-write-failed");
      },
    });

    assert.deepEqual(result, { ok: false, reason: "runtime-lock-error:owner-write-failed" });
    assert.deepEqual(readdirSync(join(cacheRoot, ".locks")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
