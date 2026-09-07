/**
 * Integration boundary for the harness-owned wrapper around pi-subagents.
 *
 * This intentionally loads the pinned SDK, the pinned native plugin and fauxProvider. It does
 * not load the delivery/model-routing gates: this file freezes foreground admission at the
 * extension boundary; those gates have their own suites.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createJiti } from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-static.mjs";

const BRIDGE_URL = new URL("../lib/pi-review-concurrency.mjs", import.meta.url);
const NATIVE_FACTORY_PATH = fileURLToPath(
  new URL("../../../node_modules/@gotgenes/pi-subagents/src/index.ts", import.meta.url),
);
const REVIEW_ROLES = ["harness-adversary", "harness-compliance", "harness-security"];

async function loadCreatePiReviewConcurrency() {
  if (existsSync(fileURLToPath(BRIDGE_URL))) {
    const implementation = await import(BRIDGE_URL.href);
    return implementation.createPiReviewConcurrency;
  }

  // Expected-RED fallback: run the pinned native factory unchanged. Native foreground calls
  // bypass maxConcurrent, so limit=1 observably reaches a peak above one without import noise.
  return () => ({ wrapNativeFactory: (nativeFactory) => nativeFactory });
}

async function loadNativeFactory() {
  const jiti = createJiti(import.meta.url, { moduleCache: true, tsconfigPaths: true });
  return jiti.import(NATIVE_FACTORY_PATH, { default: true });
}

function deferred() {
  return Promise.withResolvers();
}

function arrivalLedger() {
  const started = [];
  const waiters = [];
  return {
    started,
    record(id) {
      started.push(id);
      for (const waiter of waiters.splice(0)) {
        if (started.length >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
    },
    waitFor(count) {
      if (started.length >= count) return Promise.resolve();
      const ready = deferred();
      waiters.push({ count, resolve: ready.resolve });
      return ready.promise;
    },
  };
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
    : "";
}

function eventLoopTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function runIsolatedLimit(limit) {
  const childEnv = { ...process.env, PI_REVIEW_CONCURRENCY_TEST_LIMIT: String(limit) };
  delete childEnv.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    execFile(process.execPath, ["--test", fileURLToPath(import.meta.url)], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: "utf8",
      timeout: 20_000,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

async function observeRealForegroundLimit(t, maxParallelEyes) {
  const createPiReviewConcurrency = await loadCreatePiReviewConcurrency();
  const nativeFactory = await loadNativeFactory();
  const root = mkdtempSync(join(tmpdir(), `pi-review-limit-${maxParallelEyes}-`));
  const agentDir = join(root, "agent");
  const previous = { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR };
  process.chdir(root);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  mkdirSync(join(agentDir, "agents"), { recursive: true });
  for (const role of REVIEW_ROLES) {
    writeFileSync(join(agentDir, "agents", `${role}.md`), [
      "---",
      `description: synthetic ${role}`,
      "tools: read",
      "inherit_context: false",
      "---",
      "Return the requested synthetic review result.",
      "",
    ].join("\n"));
  }
  // maxConcurrent remains one on purpose: the new harness cap owns foreground admission.
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({
    maxConcurrent: 1,
    defaultMaxTurns: 8,
    graceTurns: 1,
  }));

  const gates = new Map(Array.from({ length: 4 }, (_, index) => [`job-${index + 1}`, deferred()]));
  const arrivals = arrivalLedger();
  const executeArrivals = arrivalLedger();
  const active = new Set();
  const activeExecutes = new Set();
  const bindings = [];
  let peak = 0;
  let executePeak = 0;
  const faux = fauxProvider();
  const requests = Array.from({ length: 4 }, (_, index) => {
    const job = `job-${index + 1}`;
    return fauxToolCall("subagent", {
      subagent_type: REVIEW_ROLES[index % REVIEW_ROLES.length],
      description: job,
      prompt: `[HARNESS_FINAL_REVIEW] Run synthetic ${job}`,
      max_turns: 8,
    }, { id: `call-${index + 1}` });
  });

  const respond = async (context) => {
    const text = context.messages.map(messageText).join("\n");
    const child = text.match(/Run synthetic (job-\d+)/)?.[1];
    if (child) {
      active.add(child);
      peak = Math.max(peak, active.size);
      arrivals.record(child);
      await gates.get(child).promise;
      active.delete(child);
      return fauxAssistantMessage(`${child}: PASS`);
    }

    const hasToolResults = context.messages.some((message) => message?.role === "toolResult");
    if (!hasToolResults) return fauxAssistantMessage(requests, { stopReason: "toolUse" });
    return fauxAssistantMessage("review batch joined");
  };
  faux.setResponses(Array.from({ length: 24 }, () => respond));

  const instrumentedNativeFactory = (pi) => nativeFactory({
    ...pi,
    registerTool(tool) {
      if (tool.name !== "subagent") return pi.registerTool(tool);
      pi.registerTool({
        ...tool,
        async execute(callId, ...args) {
          activeExecutes.add(callId);
          executePeak = Math.max(executePeak, activeExecutes.size);
          executeArrivals.record(callId);
          try {
            return await tool.execute(callId, ...args);
          } finally {
            activeExecutes.delete(callId);
          }
        },
      });
    },
  });
  const bridge = createPiReviewConcurrency({
    maxParallelEyes,
    bindChildSession: (binding) => { bindings.push(binding); return { ok: true }; },
  });
  assert.equal(typeof bridge?.wrapNativeFactory, "function", "bridge must wrap an injected pinned factory");
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [bridge.wrapNativeFactory(instrumentedNativeFactory)],
  });

  let session;
  let promptRun;
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const parentSessionManager = SessionManager.inMemory(root);
    const parentSessionId = parentSessionManager.getSessionId();
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      resourceLoader: loader,
      modelRuntime: runtime,
      model: faux.getModel(),
      sessionManager: parentSessionManager,
      settingsManager: SettingsManager.inMemory(),
    }));
    await session.bindExtensions({});

    promptRun = session.prompt("Run the synthetic review batch.", { expandPromptTemplates: false });
    await executeArrivals.waitFor(maxParallelEyes);
    await arrivals.waitFor(maxParallelEyes);
    await eventLoopTurn();
    const activeBeforeRelease = activeExecutes.size;

    while (arrivals.started.length < gates.size) {
      const nextActive = [...active][0];
      assert.ok(nextActive, "an admitted review must remain active while later reviews are queued");
      const expectedStarts = arrivals.started.length + 1;
      gates.get(nextActive).resolve();
      await arrivals.waitFor(expectedStarts);
      await eventLoopTurn();
    }
    for (const job of active) gates.get(job).resolve();
    await promptRun;

    const results = session.messages.filter((message) => message.role === "toolResult");
    return {
      activeBeforeRelease,
      peak: executePeak,
      providerPeak: peak,
      parentSessionId,
      bindings,
      statuses: results.map((result) => result.details?.status),
      callIds: results.map((result) => result.toolCallId).sort(),
    };
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await promptRun?.catch(() => {});
    if (session?.extensionRunner) await session.extensionRunner.emit({ type: "session_shutdown" });
    session?.dispose();
    process.chdir(previous.cwd);
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    rmSync(root, { recursive: true, force: true });
  }
}

const isolatedLimit = Number(process.env.PI_REVIEW_CONCURRENCY_TEST_LIMIT);

if (Number.isInteger(isolatedLimit)) {
  test(`real pinned runtime caps foreground reviews at ${isolatedLimit}`, { timeout: 20_000 }, async (t) => {
    const observed = await observeRealForegroundLimit(t, isolatedLimit);
    assert.equal(
      observed.activeBeforeRelease,
      isolatedLimit,
      `limit ${isolatedLimit} must hold excess native foreground calls in the bridge`,
    );
    assert.equal(observed.peak, isolatedLimit, `limit ${isolatedLimit} must be the runtime peak, not advisory configuration`);
    assert.deepEqual(observed.callIds, ["call-1", "call-2", "call-3", "call-4"]);
    assert.deepEqual(observed.statuses, ["completed", "completed", "completed", "completed"]);
    const sortedBindings = observed.bindings.toSorted((left, right) => left.toolCallId.localeCompare(right.toolCallId));
    assert.deepEqual(
      sortedBindings.map(({ toolCallId, subagentType, parentSessionId }) => ({ toolCallId, subagentType, parentSessionId })),
      [
        { toolCallId: "call-1", subagentType: "harness-adversary", parentSessionId: observed.parentSessionId },
        { toolCallId: "call-2", subagentType: "harness-compliance", parentSessionId: observed.parentSessionId },
        { toolCallId: "call-3", subagentType: "harness-security", parentSessionId: observed.parentSessionId },
        { toolCallId: "call-4", subagentType: "harness-adversary", parentSessionId: observed.parentSessionId },
      ],
      "each native child must bind to the exact originating call and canonical review role",
    );
    assert.equal(new Set(sortedBindings.map((binding) => binding.childSessionId)).size, 4, "every child session binding is unique");
    assert.ok(sortedBindings.every((binding) => typeof binding.childSessionId === "string" && binding.childSessionId.length > 0));
  });
} else {
  test("regression: the real foreground path enforces maxParallelEyes at 1, 2 and 3", { timeout: 60_000 }, async (t) => {
    for (const limit of [1, 2, 3]) {
      await t.test(`isolated pinned runtime at limit ${limit}`, async () => {
        const child = await runIsolatedLimit(limit);
        const output = `${child.stdout}\n${child.stderr}`.trim();
        assert.equal(child.error, null, output || child.error?.message);
      });
    }
  });
}
