import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createJiti } from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-static.mjs";

const ENTRY = fileURLToPath(new URL("./harness-subagents.ts", import.meta.url));
const SOURCE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function fakePi() {
  const handlers = new Map();
  const pi = {
    tools: new Map(), handlers,
    events: { emit(name, data) {
      for (const handler of handlers.get(name) ?? []) handler(data);
      if (name === "harness:child-bind" && data.result === undefined) data.result = { ok: true };
    } },
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool) { this.tools.set(tool.name, tool); },
  };
  return pi;
}

test("production entrypoint resolves the monorepo root without an injected override", async () => {
  const module = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY);
  assert.equal(module.testApi.harnessRoot(), SOURCE_ROOT.replace(/\/$/, ""));
});

test("production entrypoint keeps a vendored harness root as its resource root", async (t) => {
  const module = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY);
  const root = mkdtempSync(join(tmpdir(), "pi-vendored-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vendored = join(root, ".pi", "harness");
  mkdirSync(join(vendored, "extensions"), { recursive: true });
  mkdirSync(join(root, "core", "pi", "extensions"), { recursive: true });
  assert.equal(module.testApi.resolveHarnessRoot(vendored), vendored);
});

test("native installs read the effective cap from the SDK agent directory, including manual serial fallback", async (t) => {
  const entry = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY, { default: true });
  const root = mkdtempSync(join(tmpdir(), "pi-native-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const cap of [3, 1]) {
    const agentDir = join(root, String(cap));
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "harness.json"), `${JSON.stringify({ maxParallelEyes: cap })}\n`);
    const pi = fakePi();
    await entry(pi, {
      root: SOURCE_ROOT,
      getAgentDir: () => agentDir,
      async loadNativeFactory() { return () => {}; },
    });
    const notifications = [];
    for (const handler of pi.handlers.get("session_start") ?? []) {
      handler({}, { hasUI: true, ui: { notify: (message) => notifications.push(message) } });
    }
    assert.deepEqual(notifications, [`Harness parallel reviewers: ${cap}`]);
  }
});

test("production entrypoint suppresses descendant native factories and keeps the parent service", async () => {
  const entry = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY, { default: true });
  const pi = fakePi();
  let nativeFactoryCalls = 0;
  const service = { identity: "parent" };
  const deps = {
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    maxParallelEyes: 3,
    async loadNativeFactory() {
      return (api) => {
        nativeFactoryCalls++;
        globalThis[Symbol.for("@gotgenes/pi-subagents:service")] = service;
        api.registerTool({
          name: "subagent",
          async execute() {
            await entry(api, deps);
            return "child alive";
          },
        });
      };
    },
  };

  await entry(pi, deps);
  const parentService = globalThis[Symbol.for("@gotgenes/pi-subagents:service")];
  for (let index = 0; index < 3; index++) {
    assert.equal(await pi.tools.get("subagent").execute(`call-${index}`, {
      subagent_type: "harness-adversary",
      prompt: "[HARNESS_FINAL_REVIEW] review",
    }), "child alive");
  }
  assert.equal(nativeFactoryCalls, 1);
  assert.equal(globalThis[Symbol.for("@gotgenes/pi-subagents:service")], parentService);
  delete globalThis[Symbol.for("@gotgenes/pi-subagents:service")];
});

test("production entrypoint rejects a missing child rail before child model work", async () => {
  const entry = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY, { default: true });
  const pi = fakePi();
  let childModelCalls = 0;
  await entry(pi, {
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    maxParallelEyes: 1,
    async loadNativeFactory() {
      return (api) => api.registerTool({
        name: "subagent",
        async execute() {
          api.events.emit("subagents:child:session-created", { sessionId: "child", parentSessionId: "parent" });
          api.events.emit("subagents:child:bound", {
            sessionId: "child", parentSessionId: "parent",
            extensions: { resolvedPaths: [], errors: [] },
            skills: { filePaths: [], diagnostics: [] },
          });
          childModelCalls++;
        },
      });
    },
  });

  await assert.rejects(
    pi.tools.get("subagent").execute("call", { subagent_type: "harness-adversary", prompt: "[HARNESS_FINAL_REVIEW] review" }),
    /child extension missing/i,
  );
  assert.equal(childModelCalls, 0);
});
