import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import test, { before, after } from "node:test";

import { buildPiHarnessInvocation, resolvePiDependencyPaths, verifyPiHarness } from "./bin/pi-harness.mjs";
import { ensurePiRuntime } from "./lib/pi-runtime-cache.mjs";
import { vendorPi } from "../claude-code/skills/initializing-projects/references/vendor-core.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const TEST_CACHE = mkdtempSync(join(tmpdir(), "pi-integration-cache-"));
const previousCacheHome = process.env.XDG_CACHE_HOME;
before(() => {
  process.env.XDG_CACHE_HOME = TEST_CACHE;
  const runtime = ensurePiRuntime();
  assert.equal(runtime.ok, true, runtime.reason);
});
after(() => {
  if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = previousCacheHome;
  rmSync(TEST_CACHE, { recursive: true, force: true });
});
// Mantidos no pacote para uma reintrodução deliberada, mas inativos até que `run_hand` receba a
// mesma identidade in-process e o mesmo escopo do `subagent` nativo.
const INACTIVE_COMPONENTS = new Set([
  "core/pi/extensions/harness-run-hand.ts",
  "core/pi/lib/run-hand.mjs",
]);

test("pinned Pi fails on a disappeared exact transcript instead of creating a replacement", () => {
  assert.equal(verifyPiHarness(ROOT).ok, true);
  const directory = mkdtempSync(join(tmpdir(), "pi-exact-resume-"));
  const sessionDir = join(directory, "sessions");
  const missing = join(sessionDir, "removed.jsonl");
  try {
    const result = spawnSync(process.execPath, [
      resolvePiDependencyPaths(ROOT).piCli,
      "--no-extensions", "--no-skills", "--no-context-files",
      "--session", missing, "--session-dir", sessionDir, "--mode", "json", "-p", "unused",
    ], {
      cwd: directory,
      env: {
        PATH: process.env.PATH, HOME: directory,
        PI_CODING_AGENT_DIR: join(directory, "runtime"),
        PI_CODING_AGENT_AUTH_PATH: join(directory, "auth.json"),
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
        PI_HARNESS_RESUME: JSON.stringify({ file: missing, id: "expected-parent", cwd: directory }),
      },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /harness resume session/i);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /creating a new session/);
    let sessions = [];
    try { sessions = readdirSync(sessionDir); } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.equal(sessions.filter((name) => name.endsWith(".jsonl")).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resume snapshot rejects changed identity and keeps native child creation", async () => {
  assert.equal(verifyPiHarness(ROOT).ok, true);
  const { SessionManager } = await import(pathToFileURL(join(resolvePiDependencyPaths(ROOT).piPackage, "..", "dist/core/session-manager.js")).href);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-resume-snapshot-")));
  const file = join(directory, "parent.jsonl");
  const previous = process.env.PI_HARNESS_RESUME;
  const header = { type: "session", version: 3, id: "parent-id", cwd: directory, timestamp: new Date().toISOString() };
  const original = `${JSON.stringify(header)}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: header.timestamp, message: { role: "user", content: "existing history" } })}\n`;
  process.env.PI_HARNESS_RESUME = JSON.stringify({ file, id: header.id, cwd: directory });
  try {
    for (const content of ["", "not-json\n", JSON.stringify({ type: "message" }), JSON.stringify({ ...header, id: "wrong" }), JSON.stringify({ ...header, cwd: ROOT })]) {
      writeFileSync(file, content);
      assert.throws(() => SessionManager.open(file, directory), /Harness resume session/);
      assert.equal(readFileSync(file, "utf8"), content, "invalid recovery must not rewrite history");
    }
    writeFileSync(file, original);
    const parent = SessionManager.open(file, directory);
    assert.equal(parent.getSessionId(), header.id);
    assert.equal(parent.getEntries().length, 1);
    parent.appendCustomEntry("resume-test", { preserved: true });
    assert.ok(readFileSync(file, "utf8").startsWith(original));
    assert.match(readFileSync(file, "utf8"), /resume-test/);

    // A complete last JSON entry is legal even without its trailing newline.
    // Resuming must keep that entry separate from the next append.
    writeFileSync(file, original.trimEnd());
    const noFinalNewline = SessionManager.open(file, directory);
    noFinalNewline.appendCustomEntry("resume-newline-check", { ok: true });
    const resumedLines = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(resumedLines.length, 3);
    assert.equal(resumedLines[1].message.content, "existing history");
    assert.equal(resumedLines[2].customType, "resume-newline-check");
    writeFileSync(file, JSON.stringify({ ...header, id: "replaced-after-preflight" }));
    assert.throws(() => parent._setSessionFile(file, [header]), /Harness resume session/, "cached header cannot override current disk identity");
    writeFileSync(file, original);
    const alias = join(directory, "alias");
    symlinkSync(directory, alias);
    process.env.PI_HARNESS_RESUME = JSON.stringify({ file: join(alias, "parent.jsonl"), id: header.id, cwd: directory });
    assert.throws(() => SessionManager.open(join(alias, "parent.jsonl"), directory), /Harness resume session/);
    process.env.PI_HARNESS_RESUME = JSON.stringify({ file, id: header.id, cwd: directory });
    const child = SessionManager.open(join(directory, "child.jsonl"), directory);
    assert.notEqual(child.getSessionId(), header.id);
    rmSync(file);
    symlinkSync(join(directory, "child.jsonl"), file);
    assert.throws(() => SessionManager.open(file, directory), /Harness resume session/);
    rmSync(file);
    delete process.env.PI_HARNESS_RESUME;
    assert.doesNotThrow(() => SessionManager.open(file, directory), "ordinary Pi still allows a new explicit path");
  } finally {
    if (previous === undefined) delete process.env.PI_HARNESS_RESUME;
    else process.env.PI_HARNESS_RESUME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preflight verifies the pinned Pi runtime and all canonical role assets", () => {
  assert.deepEqual(verifyPiHarness(ROOT), {
    ok: true,
    runtimeVersion: "0.87.1",
    subagentsVersion: "21.7.4",
    roles: 11,
  });
});

test("preflight rejects altered cached code without repairing it during a run", () => {
  const deps = resolvePiDependencyPaths(ROOT);
  const file = join(deps.piPackage, "..", "dist/config.js");
  const before = readFileSync(file, "utf8");
  const altered = `${before}\n// controlled corruption in isolated test cache\n`;
  try {
    writeFileSync(file, altered);
    const checked = verifyPiHarness(ROOT);
    assert.equal(checked.ok, false, "execution must not accept a corrupted shared runtime");
    assert.equal(readFileSync(file, "utf8"), altered, "only an explicit lifecycle operation may repair/provision runtime");
  } finally { writeFileSync(file, before); }
});

test("launcher offers a provider-free preflight for the Orca terminal", () => {
  const result = spawnSync(process.execPath, ["core/pi/bin/pi-harness.mjs", "--verify"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    runtimeVersion: "0.87.1",
    subagentsVersion: "21.7.4",
    roles: 11,
  });
});

test("published bin entry executes through its npm symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-bin-test-"));
  const launcher = join(directory, "pi-harness");
  try {
    symlinkSync(resolve(ROOT, "core/pi/bin/pi-harness.mjs"), launcher);
    const result = spawnSync(process.execPath, [launcher, "--verify"], {
      cwd: ROOT,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      runtimeVersion: "0.87.1",
      subagentsVersion: "21.7.4",
      roles: 11,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi runtime's Node requirement is reflected by the published package", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.engines.node, ">=22.19.0");
});

test("regression: package metadata and source launcher select the harness bridge exactly once", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const declared = manifest.pi.extensions.map((extension) => resolve(ROOT, extension));
  const bridge = resolve(ROOT, "core/pi/extensions/harness-subagents.ts");
  const dependencies = resolvePiDependencyPaths(ROOT);
  const loaded = buildPiHarnessInvocation({ root: ROOT, argv: [], env: {}, dependencyPaths: dependencies }).args
    .filter((argument, index, args) => args[index - 1] === "-e");

  assert.equal(declared.filter((extension) => extension === bridge).length, 1, "package.pi.extensions must expose one bridge");
  assert.equal(declared.includes(resolve(ROOT, "node_modules/@gotgenes/pi-subagents/src/index.ts")), false);
  assert.equal(loaded.filter((extension) => extension === bridge).length, 1, "source launcher must load one bridge");
  assert.equal(loaded.includes(dependencies.subagentsExtension), false, "source launcher must not load the native factory beside it");
});

test("regression: fresh official Pi vendor ships the bridge closure and its verified launcher uses it", async (t) => {
  const target = realpathSync(mkdtempSync(join(tmpdir(), "pi-review-vendor-")));
  t.after(() => rmSync(target, { recursive: true, force: true }));

  vendorPi({
    coreDir: resolve(ROOT, "core"),
    targetDir: target,
    version: "test-review-bridge",
    stampDate: "2026-09-07T00:00:00.000Z",
  });

  const harnessRoot = join(target, ".pi/harness");
  for (const relativePath of [
    "extensions/harness-subagents.ts",
    "lib/pi-review-concurrency.mjs",
    "lib/plan-analysis.mjs",
    "runtime-defaults/harness.json",
    "vendor/shared/lib/review-report-schema.mjs",
  ]) {
    assert.equal(existsSync(join(harnessRoot, relativePath)), true, `fresh vendor omitted ${relativePath}`);
  }

  const vendoredLauncher = await import(`${pathToFileURL(join(harnessRoot, "bin/pi-harness.mjs")).href}?test=${Date.now()}`);
  for (const role of ['harness-planner', 'harness-plan-reviewer']) {
    assert.match(readFileSync(join(harnessRoot, 'runtime-defaults/agents', `${role}.md`), 'utf8'), /tools:.*harness_plan_analysis/);
  }
  const analyzer = await import(pathToFileURL(join(harnessRoot, 'lib/plan-analysis.mjs')).href);
  assert.equal(analyzer.analyzePiPlan({ root: target, featureId: 'absent' }).reason, 'plan missing');
  assert.deepEqual(vendoredLauncher.verifyPiHarness(harnessRoot), {
    ok: true,
    runtimeVersion: "0.87.1",
    subagentsVersion: "21.7.4",
    roles: 11,
  });

  const dependencies = vendoredLauncher.resolvePiDependencyPaths(harnessRoot);
  const invocation = vendoredLauncher.buildPiHarnessInvocation({ root: harnessRoot, argv: [], env: {}, dependencyPaths: dependencies });
  const loaded = invocation.args.filter((argument, index, args) => args[index - 1] === "-e");
  const bridge = join(harnessRoot, "extensions/harness-subagents.ts");
  assert.equal(loaded.filter((extension) => extension === bridge).length, 1);
  assert.equal(loaded.includes(dependencies.subagentsExtension), false);
});



test("nenhum gate fica de fora do launcher: toda extensão do pacote é carregada", () => {
  const declared = new Set(
    readdirSync(resolve(ROOT, "core/pi/extensions"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `core/pi/extensions/${name}`),
  );
  const invocation = buildPiHarnessInvocation({ root: ROOT, argv: [], env: {} });
  const loaded = new Set(
    invocation.args
      .filter((arg, index) => invocation.args[index - 1] === "-e")
      .map((path) => path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path),
  );

  for (const extension of declared) {
    if (INACTIVE_COMPONENTS.has(extension)) {
      assert.equal(loaded.has(extension), false, `${extension} só pode voltar com identidade e escopo in-process`);
      continue;
    }
    assert.equal(loaded.has(extension), true, `${extension} não é carregada pelo launcher`);
  }
});

test("preflight nomeia a primeira peça ausente em vez de subir um harness sem gate", () => {
  const empty = mkdtempSync(join(tmpdir(), "pi-harness-empty-root-"));
  try {
    const result = verifyPiHarness(empty);
    assert.equal(result.ok, false);
    assert.match(result.reason, /^missing:/);
    assert.match(result.reason, /harness-policy\.ts$/, "policy é a primeira extensão exigida");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("o preflight cobre cada lib do porte", () => {
  // O preflight para na PRIMEIRA ausência, então a garantia útil é de lista: toda lib .mjs do
  // pacote (fora de teste) precisa estar exigida pelo launcher, ou some sem barulho no vendor.
  const launcher = readFileSync(resolve(ROOT, "core/pi/bin/pi-harness.mjs"), "utf8");
  for (const name of readdirSync(resolve(ROOT, "core/pi/lib"))) {
    if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
    if (INACTIVE_COMPONENTS.has(`core/pi/lib/${name}`)) continue;
    assert.match(launcher, new RegExp(`core/pi/lib/${name.replace(".", "\\.")}`), `${name} não é exigida pelo preflight`);
  }
});
