/** @description Behavioral identity, replay, concurrency, and byte-neutral denial tests for marker authority. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validatePrivilegedMarkerSeals } from "./lib/marker-seal.mjs";

const stub = `
  const schemaValue = { describe() { return this }, optional() { return this } };
  export const tool = (definition) => definition;
  tool.schema = { string() { return Object.create(schemaValue) } };
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin/tool") {
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { default: MarkerAuthority } = await import("./marker-authority.ts");

function statePath(root, sessionID = "ses-authority") {
  return path.join(root, ".opencode", "plans", ".state", sessionID, "gate-state.json");
}

function seed(root) {
  const file = statePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = '{\n  "session_id": "ses-authority",\n  "feature_id": "feature-authority",\n  "classified": true\n}\n';
  fs.writeFileSync(file, bytes);
  return { file, bytes };
}

async function harness(root) {
  const hooks = await MarkerAuthority({ directory: root, worktree: root });
  return {
    before: hooks["tool.execute.before"],
    execute: hooks.tool.mark.execute,
  };
}

function context(sessionID = "ses-authority", callID = "call-authority") {
  return { sessionID, callID, messageID: "msg-authority", agent: "build", directory: "/ignored", worktree: "/ignored" };
}

test("real before-hook object identity authorizes one bound mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-ok-"));
  try {
    const { file } = seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
    const result = await execute(args, context());
    assert.equal(result.metadata.ok, true, result.output);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual({ ...state.brainstormed_binding, seal: undefined }, {
      session_id: "ses-authority",
      feature_id: "feature-authority",
      operation: "brainstormed",
      seal: undefined,
    });
    assert.equal(typeof state.brainstormed_binding.seal, "string");
    assert.equal(Array.isArray(state.marker_seals), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("another process authority can write bytes but cannot mint host-valid marker semantics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-process-"));
  try {
    const { file } = seed(root);
    const moduleUrl = pathToFileURL(path.resolve("core/opencode/plugin/marker-authority.ts")).href;
    const script = `
      const { registerHooks } = await import("node:module");
      const stub = ${JSON.stringify(stub)};
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === "@opencode-ai/plugin/tool") {
          return { url: \`data:text/javascript,\${encodeURIComponent(stub)}\`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      } });
      const { default: authority } = await import(${JSON.stringify(moduleUrl)});
      const hooks = await authority({ directory: process.argv[1], worktree: process.argv[1] });
      const args = { action: "brainstormed" };
      await hooks["tool.execute.before"](
        { tool: "mark", sessionID: "ses-authority", callID: "child-call" },
        { args },
      );
      const result = await hooks.tool.mark.execute(args, {
        sessionID: "ses-authority", callID: "child-call", messageID: "child-message",
        agent: "build", directory: process.argv[1], worktree: process.argv[1],
      });
      if (!result.metadata.ok) process.exit(2);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, root], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const childState = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(childState.brainstormed, true);
    assert.equal(validatePrivilegedMarkerSeals(childState, {
      sessionId: "ses-authority",
      featureId: "feature-authority",
    }).ok, false);

    seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "parent-call" }, { args });
    await execute(args, context("ses-authority", "parent-call"));
    const parentState = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(validatePrivilegedMarkerSeals(parentState, {
      sessionId: "ses-authority",
      featureId: "feature-authority",
    }).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct execute, structural clone, and mismatched runtime IDs fail byte-neutral", async () => {
  for (const variant of ["direct", "clone", "session", "call"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `marker-authority-${variant}-`));
    try {
      const { file, bytes } = seed(root);
      const { before, execute } = await harness(root);
      const args = { action: "brainstormed" };
      let invoked = args;
      let ctx = context();
      if (variant !== "direct") {
        await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
      }
      if (variant === "clone") invoked = { ...args };
      if (variant === "session") ctx = context("ses-foreign", "call-authority");
      if (variant === "call") ctx = context("ses-authority", "call-foreign");
      const result = await execute(invoked, ctx);
      assert.equal(result.metadata.ok, false, variant);
      assert.equal(fs.readFileSync(file, "utf8"), bytes, variant);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("authorization replay is consumed before mutation and cannot change bytes twice", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-replay-"));
  try {
    const { file } = seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
    const first = await execute(args, context());
    assert.equal(first.metadata.ok, true);
    const afterFirst = fs.readFileSync(file, "utf8");
    const replay = await execute(args, context());
    assert.equal(replay.metadata.ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), afterFirst);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed privileged mutation consumes authorization and remains byte-neutral", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-failure-"));
  try {
    const { file, bytes } = seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "dual", status: "not-an-enum" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
    const failed = await execute(args, context());
    assert.equal(failed.metadata.ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    const replay = await execute(args, context());
    assert.equal(replay.metadata.ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent duplicate before and execute attempts have one winner with no second mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-race-"));
  try {
    const { file, bytes } = seed(root);
    const { before, execute } = await harness(root);
    const args = { action: "brainstormed" };
    await before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args });
    await assert.rejects(
      () => before({ tool: "mark", sessionID: "ses-authority", callID: "call-authority" }, { args }),
      /already authorized/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    const [a, b] = await Promise.all([execute(args, context()), execute(args, context())]);
    assert.equal([a.metadata.ok, b.metadata.ok].filter(Boolean).length, 1);
    const after = fs.readFileSync(file, "utf8");
    assert.match(after, /brainstormed_binding/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
