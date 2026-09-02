import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildPiHarnessInvocation,
  harnessStateDir,
  materializeRuntime,
  resolvePiDependencyPaths,
} from "./pi-harness.mjs";

const DEPENDENCIES = {
  piCli: "/npx/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  piPackage: "/npx/node_modules/@earendil-works/pi-coding-agent/package.json",
  subagentsExtension: "/npx/node_modules/@gotgenes/pi-subagents/src/index.ts",
  subagentsPackage: "/npx/node_modules/@gotgenes/pi-subagents/package.json",
};

/** @description Extensões carregadas, na ordem de `-e`. */
function loadedExtensions(args) {
  const loaded = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-e") loaded.push(args[i + 1]);
  return loaded;
}

test("launcher resolves Pi dependencies hoisted by npx when the Git package has no nested node_modules", () => {
  const resolved = resolvePiDependencyPaths(
    "/package",
    (specifier) => `/npx/node_modules/${specifier}/dist/index.js`,
    (packageName) => `/npx/node_modules/${packageName}`,
  );

  assert.deepEqual(resolved, DEPENDENCIES);
});

test("launcher disables discovered project resources and loads only the harness package", () => {
  const root = "/package";
  const invocation = buildPiHarnessInvocation({
    root,
    argv: ["-p", "triage issue"],
    env: {},
    dependencyPaths: DEPENDENCIES,
  });

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[0], DEPENDENCIES.piCli);
  assert.deepEqual(invocation.args.slice(1, 4), ["--no-extensions", "--no-skills", "--no-context-files"]);
  const skillFlag = invocation.args.indexOf("--skill");
  assert.deepEqual(invocation.args.slice(skillFlag, skillFlag + 2), ["--skill", join(root, "core/codex/skills")]);
  assert.deepEqual(invocation.args.slice(-2), ["-p", "triage issue"]);
  assert.equal(invocation.env.PI_CODING_AGENT_DIR, resolve(process.cwd(), ".pi/harness/runtime"));
});

test("every ported gate is loaded, policy first and the UI tracker last", () => {
  const root = "/package";
  const loaded = loadedExtensions(
    buildPiHarnessInvocation({ root, argv: [], env: {}, dependencyPaths: DEPENDENCIES }).args,
  );

  assert.deepEqual(loaded, [
    join(root, "core/pi/extensions/harness-policy.ts"),
    join(root, "core/pi/extensions/harness-bootstrap.ts"),
    DEPENDENCIES.subagentsExtension,
    join(root, "core/pi/extensions/harness-dispatch.ts"),
    join(root, "core/pi/extensions/harness-entry-gate.ts"),
    join(root, "core/pi/extensions/harness-plan-gate.ts"),
    join(root, "core/pi/extensions/harness-plan-write-gate.ts"),
    join(root, "core/pi/extensions/harness-marker.ts"),
    join(root, "core/pi/extensions/harness-classify.ts"),
    join(root, "core/pi/extensions/harness-lavish-gate.ts"),
    join(root, "core/pi/extensions/harness-run-hand.ts"),
    join(root, "core/pi/extensions/harness-obs.ts"),
    join(root, "core/pi/extensions/harness-idle-nudge.ts"),
    join(root, "core/pi/extensions/harness-reinject-state.ts"),
    join(root, "core/pi/extensions/harness-version-check.ts"),
    join(root, "core/pi/extensions/harness-context-files.ts"),
    join(root, "core/pi/extensions/harness-plan-tracker.ts"),
  ]);
});

test("the dispatch rails load after pi-subagents registers the subagent tool", () => {
  const loaded = loadedExtensions(
    buildPiHarnessInvocation({ root: "/package", argv: [], env: {}, dependencyPaths: DEPENDENCIES }).args,
  );
  const subagents = loaded.indexOf(DEPENDENCIES.subagentsExtension);

  assert.ok(subagents > 0, "pi-subagents is not the first extension");
  for (const rel of ["harness-dispatch.ts", "harness-entry-gate.ts", "harness-plan-gate.ts"]) {
    assert.ok(
      loaded.findIndex((path) => path.endsWith(rel)) > subagents,
      `${rel} must load after pi-subagents`,
    );
  }
});

test("launcher never injects a provider default of its own", () => {
  const invocation = buildPiHarnessInvocation({
    root: "/package",
    argv: [],
    env: { PATH: "/usr/bin" },
    dependencyPaths: DEPENDENCIES,
  });

  assert.equal(invocation.args.includes("--model"), false);
  assert.equal(
    Object.keys(invocation.env).some((key) => key.startsWith("ANTHROPIC_")),
    false,
  );
});

test("launcher replaces inherited agent state instead of accepting it", () => {
  const invocation = buildPiHarnessInvocation({
    root: "/package",
    argv: [],
    env: { PI_CODING_AGENT_DIR: "/untrusted", KEEP_ME: "yes" },
    dependencyPaths: DEPENDENCIES,
  });

  assert.equal(invocation.env.PI_CODING_AGENT_DIR, resolve(process.cwd(), ".pi/harness/runtime"));
  assert.equal(invocation.env.KEEP_ME, "yes");
});

test("runtime defaults are materialized locally without copying authentication", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-runtime-test-"));
  const runtimeDir = join(directory, "runtime");
  materializeRuntime(process.cwd(), runtimeDir);

  assert.equal(existsSync(join(runtimeDir, "subagents.json")), true);
  assert.equal(existsSync(join(runtimeDir, "agents/harness-planner.md")), true);
  assert.equal(existsSync(join(runtimeDir, "auth.json")), false);
  const settings = JSON.parse(readFileSync(join(runtimeDir, "settings.json"), "utf8"));
  assert.match(settings.defaultModel, /^openai-codex\//);
});

test("the harness state root exists before the first gate reads it", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-state-test-"));
  const runtimeDir = join(directory, ".pi/harness/runtime");
  materializeRuntime(process.cwd(), runtimeDir);

  assert.equal(harnessStateDir(runtimeDir), join(directory, ".pi/harness/state"));
  assert.equal(existsSync(join(directory, ".pi/harness/state")), true);
});
