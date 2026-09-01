import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildPiHarnessInvocation,
  materializeRuntime,
  resolvePiDependencyPaths,
} from "./pi-harness.mjs";

test("launcher resolves Pi dependencies hoisted by npx when the Git package has no nested node_modules", () => {
  const resolved = resolvePiDependencyPaths(
    "/package",
    (specifier) => `/npx/node_modules/${specifier}/dist/index.js`,
    (packageName) => `/npx/node_modules/${packageName}`,
  );

  assert.deepEqual(resolved, {
    piCli: "/npx/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    piPackage: "/npx/node_modules/@earendil-works/pi-coding-agent/package.json",
    subagentsExtension: "/npx/node_modules/@gotgenes/pi-subagents/src/index.ts",
    subagentsPackage: "/npx/node_modules/@gotgenes/pi-subagents/package.json",
  });
});

test("launcher disables discovered project resources and loads only the harness package", () => {
  const root = "/package";
  const invocation = buildPiHarnessInvocation({
    root,
    argv: ["-p", "triage issue"],
    env: {},
    dependencyPaths: {
      piCli: "/npx/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      piPackage: "/npx/node_modules/@earendil-works/pi-coding-agent/package.json",
      subagentsExtension: "/npx/node_modules/@gotgenes/pi-subagents/src/index.ts",
      subagentsPackage: "/npx/node_modules/@gotgenes/pi-subagents/package.json",
    },
  });

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(1, 4), ["--no-extensions", "--no-skills", "--no-context-files"]);
  assert.deepEqual(invocation.args.slice(4, 12), [
    "-e",
    join(root, "core/pi/extensions/harness-bootstrap.ts"),
    "-e",
    "/npx/node_modules/@gotgenes/pi-subagents/src/index.ts",
    "-e",
    join(root, "core/pi/extensions/harness-dispatch.ts"),
    "-e",
    join(root, "core/pi/extensions/harness-plan-tracker.ts"),
  ]);
  assert.deepEqual(invocation.args.slice(12, 14), ["--skill", join(root, "core/codex/skills")]);
  assert.deepEqual(invocation.args.slice(-2), ["-p", "triage issue"]);
  assert.equal(invocation.env.PI_CODING_AGENT_DIR, resolve(process.cwd(), ".pi/harness/runtime"));
});

test("launcher replaces inherited agent state instead of accepting it", () => {
  const invocation = buildPiHarnessInvocation({
    root: "/package",
    argv: [],
    env: { PI_CODING_AGENT_DIR: "/untrusted", KEEP_ME: "yes" },
    dependencyPaths: {
      piCli: "/npx/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      piPackage: "/npx/node_modules/@earendil-works/pi-coding-agent/package.json",
      subagentsExtension: "/npx/node_modules/@gotgenes/pi-subagents/src/index.ts",
      subagentsPackage: "/npx/node_modules/@gotgenes/pi-subagents/package.json",
    },
  });

  assert.equal(invocation.env.PI_CODING_AGENT_DIR, resolve(process.cwd(), ".pi/harness/runtime"));
  assert.equal(invocation.env.KEEP_ME, "yes");
});

test("runtime defaults are materialized locally without copying authentication", () => {
  const target = mkdtempSync(join(tmpdir(), "pi-harness-runtime-test-"));
  materializeRuntime(process.cwd(), target);

  assert.equal(existsSync(join(target, "subagents.json")), true);
  assert.equal(existsSync(join(target, "agents/harness-planner.md")), true);
  assert.equal(existsSync(join(target, "auth.json")), false);
});
