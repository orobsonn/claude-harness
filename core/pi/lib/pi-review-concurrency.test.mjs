import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyPiReviewDispatch } from "./pi-review-concurrency.mjs";

const IMPLEMENTATION_URL = new URL("./pi-review-concurrency.mjs", import.meta.url);

async function loadCreatePiReviewConcurrency() {
  if (existsSync(fileURLToPath(IMPLEMENTATION_URL))) {
    const implementation = await import(IMPLEMENTATION_URL.href);
    return implementation.createPiReviewConcurrency;
  }

  // Expected-RED fallback: exercise the native extension exactly as it behaves before the
  // harness bridge exists. This keeps a missing production file from becoming the failure.
  return () => ({ wrapNativeFactory: (nativeFactory) => nativeFactory });
}

const createPiReviewConcurrency = await loadCreatePiReviewConcurrency();

test("task adversary classification requires the context marker as its exact prefix", () => {
  const context = '[HARNESS_TASK_CONTEXT]{"task_id":"task-one"}[/HARNESS_TASK_CONTEXT]';
  assert.deepEqual(classifyPiReviewDispatch("harness-adversary", context + "\nReview implementation."), { phase: "task", taskId: "task-one" });
  for (const prefix of ["Quoted example: ", "\n", "[HARNESS_TASK_REVIEW]\n", "[HARNESS_SPEC_REVIEW]\n"]) {
    assert.equal(classifyPiReviewDispatch("harness-adversary", prefix + context), null, prefix);
  }
  assert.deepEqual(classifyPiReviewDispatch("harness-adversary", "[HARNESS_FINAL_REVIEW]\n" + context), { phase: "final" });
});

function deferred() {
  return Promise.withResolvers();
}

function startLedger() {
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

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  const busHandlers = new Map();
  const forwarded = [];
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: {
      on(event, handler) {
        const list = busHandlers.get(event) ?? [];
        list.push(handler);
        busHandlers.set(event, list);
      },
      emit(event, payload) {
        forwarded.push({ event, payload });
        // The real Pi bus catches subscriber errors. A binding failure registered as an
        // ordinary subscriber therefore cannot stop the child; the bridge must intercept
        // synchronously before forwarding to this bus.
        for (const handler of busHandlers.get(event) ?? []) {
          try { handler(payload); } catch { /* native bus behavior */ }
        }
      },
    },
  };
  return { pi, tools, handlers, forwarded };
}

function installBridge(options, nativeFactory) {
  const harness = fakePi();
  const bridge = createPiReviewConcurrency(options);
  assert.equal(typeof bridge?.wrapNativeFactory, "function", "bridge must expose wrapNativeFactory(nativeFactory)");
  const extensionResult = bridge.wrapNativeFactory(nativeFactory)(harness.pi);
  return { ...harness, extensionResult };
}

function dispatch(tool, callId, subagentType, signal = new AbortController().signal, prompt = `[HARNESS_FINAL_REVIEW] ${callId}`) {
  return tool.execute(
    callId,
    { subagent_type: subagentType, prompt, description: callId },
    signal,
    undefined,
    {},
  );
}

async function emitHooks(handlers, eventName, event) {
  for (const handler of handlers.get(eventName) ?? []) {
    const result = await handler(event, {});
    if (result?.block === true) return result;
  }
  return undefined;
}

async function prepareToolCall(handlers, event) {
  await emitHooks(handlers, "tool_execution_start", {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args: event.input,
  });
  return emitHooks(handlers, "tool_call", event);
}

async function finishToolCall(handlers, event, { isError = false } = {}) {
  await emitHooks(handlers, "tool_execution_end", {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: { content: [] },
    isError,
  });
}

test("support shares at most three reader slots and never becomes a review or overlaps a writer", { timeout: 5000 }, async t => {
  const ledger = startLedger();
  const finishes = new Map(["s1", "s2", "s3", "s4", "writer"].map(id => [id, deferred()]));
  t.after(() => { for (const d of finishes.values()) d.resolve(); });
  const { tools } = installBridge({ maxParallelEyes: 3 }, pi => pi.registerTool({
    name: "subagent", async execute(id) { ledger.record(id); await finishes.get(id).promise; return { content: [] }; },
  }));
  const tool = tools.get("subagent");
  assert.equal(classifyPiReviewDispatch("harness-support", "[HARNESS_FINAL_REVIEW]"), null);
  const runs = ["s1", "s2", "s3", "s4"].map(id => dispatch(tool, id, "harness-support"));
  runs.push(dispatch(tool, "writer", "harness-executor"));
  await ledger.waitFor(3);
  assert.deepEqual(ledger.started, ["s1", "s2", "s3"]);
  finishes.get("s1").resolve(); await ledger.waitFor(4);
  assert.equal(ledger.started.at(-1), "s4");
  for (const id of ["s2", "s3", "s4"]) finishes.get(id).resolve();
  await ledger.waitFor(5); assert.equal(ledger.started.at(-1), "writer");
  finishes.get("writer").resolve(); await Promise.all(runs);
});

test("regression: reviews share bounded slots while a queued non-review stays FIFO and exclusive", { timeout: 5_000 }, async (t) => {
  const ledger = startLedger();
  const finishes = new Map(["r1", "r2", "r3", "writer", "r4"].map((id) => [id, deferred()]));
  t.after(() => { for (const finish of finishes.values()) finish.resolve(); });

  const nativeFactory = (pi) => pi.registerTool({
    name: "subagent",
    async execute(callId) {
      ledger.record(callId);
      await finishes.get(callId).promise;
      return { content: [{ type: "text", text: callId }] };
    },
  });
  const { tools } = installBridge({ maxParallelEyes: 2 }, nativeFactory);
  const tool = tools.get("subagent");

  const runs = [
    dispatch(tool, "r1", "harness-adversary"),
    dispatch(tool, "r2", "harness-compliance"),
    dispatch(tool, "r3", "harness-security"),
    dispatch(tool, "writer", "harness-executor"),
    dispatch(tool, "r4", "harness-adversary"),
  ];

  await ledger.waitFor(2);
  assert.deepEqual(ledger.started, ["r1", "r2"], "only the two admitted readers may start");

  finishes.get("r1").resolve();
  await ledger.waitFor(3);
  assert.deepEqual(ledger.started, ["r1", "r2", "r3"], "the earlier queued reader gets the freed slot");

  finishes.get("r2").resolve();
  await Promise.resolve();
  assert.deepEqual(ledger.started, ["r1", "r2", "r3"], "exclusive work cannot overlap the remaining reader");

  finishes.get("r3").resolve();
  await ledger.waitFor(4);
  assert.deepEqual(ledger.started, ["r1", "r2", "r3", "writer"], "the queued writer starts before later readers");

  finishes.get("writer").resolve();
  await ledger.waitFor(5);
  assert.deepEqual(ledger.started, ["r1", "r2", "r3", "writer", "r4"]);
  finishes.get("r4").resolve();
  await Promise.all(runs);
});

test("spec adversary and test fidelity remain exclusive even though their roles also perform final reviews", { timeout: 5_000 }, async (t) => {
  for (const [role, prompt] of [
    ["harness-adversary", "Review the specification before implementation."],
    ["harness-test-reviewer", '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT] Validate test fidelity.'],
    ["harness-security", "Review the proposed security architecture."],
  ]) {
    const ledger = startLedger();
    const finishes = new Map(["review", "serial", "later"].map((id) => [id, deferred()]));
    t.after(() => { for (const finish of finishes.values()) finish.resolve(); });
    const { tools } = installBridge({ maxParallelEyes: 3 }, (pi) => pi.registerTool({
      name: "subagent",
      async execute(callId) { ledger.record(callId); await finishes.get(callId).promise; return {}; },
    }));
    const tool = tools.get("subagent");
    const runs = [
      dispatch(tool, "review", "harness-adversary"),
      dispatch(tool, "serial", role, undefined, prompt),
      dispatch(tool, "later", "harness-security"),
    ];
    assert.deepEqual(ledger.started, ["review"], `${role} outside task/final review must wait exclusively`);
    finishes.get("review").resolve();
    await ledger.waitFor(2);
    assert.deepEqual(ledger.started, ["review", "serial"]);
    finishes.get("serial").resolve();
    await ledger.waitFor(3);
    finishes.get("later").resolve();
    await Promise.all(runs);
  }
});

test("regression: shutdown cancels queued reviews without starting them and awaits the active execute settlement", { timeout: 5_000 }, async (t) => {
  const ledger = startLedger();
  const activeFinish = deferred();
  let activeSettled = false;
  let activeSignal;
  t.after(() => activeFinish.resolve());

  const nativeFactory = (pi) => pi.registerTool({
    name: "subagent",
    async execute(callId, _params, signal) {
      ledger.record(callId);
      if (callId === "active") {
        activeSignal = signal;
        await activeFinish.promise;
        activeSettled = true;
      }
      return {
        content: [{ type: "text", text: callId }],
        details: { status: "completed", agentId: `${callId}-agent` },
      };
    },
  });
  const { tools, handlers } = installBridge({ maxParallelEyes: 1 }, nativeFactory);
  const tool = tools.get("subagent");
  const active = dispatch(tool, "active", "harness-adversary");
  const queued = dispatch(tool, "queued", "harness-security");
  await ledger.waitFor(1);

  let shutdownSettled = false;
  const shutdown = Promise.all((handlers.get("session_shutdown") ?? []).map((handler) => handler()))
    .then(() => { shutdownSettled = true; });
  await Promise.resolve();
  const beforeActualSettle = { started: [...ledger.started], shutdownSettled, activeSettled };

  activeFinish.resolve();
  await shutdown;
  const [activeOutcome, queuedOutcome] = await Promise.allSettled([active, queued]);

  assert.deepEqual(beforeActualSettle.started, ["active"], "a queued review must never enter native execute after cancellation");
  assert.equal(beforeActualSettle.shutdownSettled, false, "shutdown cannot report completion while native execute is active");
  assert.equal(beforeActualSettle.activeSettled, false);
  assert.equal(activeSignal?.aborted, true, "shutdown must abort the signal delivered to native execute");
  assert.equal(activeSettled, true);
  assert.equal(ledger.started.includes("queued"), false);
  assert.equal(queuedOutcome.status, "rejected", "a cancelled queued review must reject its dispatch promise");
  if (queuedOutcome.status === "rejected") assert.match(String(queuedOutcome.reason), /cancel|abort|shutdown/i);
  assert.equal(
    activeOutcome.status === "fulfilled" && activeOutcome.value?.details?.status === "completed",
    false,
    "an execute that ignores abort cannot surface a healthy completion after shutdown",
  );
});

test("regression: out-of-order child creation keeps exact call identity and binding failure stops native continuation", { timeout: 5_000 }, async (t) => {
  const releases = new Map(["call-a", "call-b", "call-bad"].map((id) => [id, deferred()]));
  const entered = startLedger();
  const continued = [];
  const bindings = [];
  t.after(() => { for (const release of releases.values()) release.resolve(); });

  const nativeFactory = (pi) => pi.registerTool({
    name: "subagent",
    async execute(callId, params) {
      entered.record(callId);
      await releases.get(callId).promise;
      pi.events.emit("subagents:child:session-created", {
        sessionId: `child-${callId}`,
        parentSessionId: "parent-1",
      });
      continued.push(callId);
      return { content: [{ type: "text", text: params.subagent_type }] };
    },
  });
  const { tools, forwarded } = installBridge({
    maxParallelEyes: 3,
    bindChildSession(binding) {
      bindings.push(binding);
      if (binding.toolCallId === "call-bad") throw new Error("synthetic binding failure");
      return { ok: true };
    },
  }, nativeFactory);
  const tool = tools.get("subagent");

  const a = dispatch(tool, "call-a", "harness-adversary");
  const b = dispatch(tool, "call-b", "harness-compliance");
  await entered.waitFor(2);
  releases.get("call-b").resolve();
  await b;
  releases.get("call-a").resolve();
  await a;

  const bad = dispatch(tool, "call-bad", "harness-security");
  await entered.waitFor(3);
  releases.get("call-bad").resolve();
  const badOutcome = await Promise.allSettled([bad]);

  assert.deepEqual(bindings.slice(0, 2).map(({ toolCallId, subagentType, childSessionId }) => ({ toolCallId, subagentType, childSessionId })), [
    { toolCallId: "call-b", subagentType: "harness-compliance", childSessionId: "child-call-b" },
    { toolCallId: "call-a", subagentType: "harness-adversary", childSessionId: "child-call-a" },
  ]);
  assert.equal(badOutcome[0].status, "rejected", "binding failure must reject the owning dispatch");
  assert.equal(continued.includes("call-bad"), false, "native child continuation must not run after binding failure");
  assert.equal(
    forwarded.some(({ payload }) => payload?.sessionId === "child-call-bad"),
    false,
    "a failed binding must not be forwarded as child-created",
  );
});

test("child binding requires an affirmative synchronous result before native continuation", async () => {
  const cases = [
    ["negative", () => ({ ok: false, reason: "identity could not be persisted" })],
    ["missing acknowledgement", () => undefined],
    ["async acknowledgement", () => Promise.resolve({ ok: true })],
    ["async rejection", () => {
      const rejected = Promise.reject(new Error("synthetic async binding failure"));
      rejected.catch(() => {});
      return rejected;
    }],
  ];
  const observed = [];
  for (const [label, binder] of cases) {
    let continued = false;
    const { tools, forwarded } = installBridge({ maxParallelEyes: 1, bindChildSession: binder }, (pi) => {
      pi.registerTool({
        name: "subagent",
        async execute() {
          pi.events.emit("subagents:child:session-created", { sessionId: "child", parentSessionId: "parent" });
          continued = true;
          return { content: [{ type: "text", text: "native result" }] };
        },
      });
    });
    const [outcome] = await Promise.allSettled([dispatch(tools.get("subagent"), "call", "harness-adversary")]);
    observed.push({ label, rejected: outcome.status === "rejected", continued, forwarded: forwarded.length });
  }
  assert.deepEqual(observed, [
    { label: "negative", rejected: true, continued: false, forwarded: 0 },
    { label: "missing acknowledgement", rejected: true, continued: false, forwarded: 0 },
    { label: "async acknowledgement", rejected: true, continued: false, forwarded: 0 },
    { label: "async rejection", rejected: true, continued: false, forwarded: 0 },
  ]);
});

test("regression: the published service cannot spawn any harness runtime role around the guarded tool path", (t) => {
  const serviceKey = Symbol.for("@gotgenes/pi-subagents:service");
  const previous = globalThis[serviceKey];
  t.after(() => {
    if (previous === undefined) delete globalThis[serviceKey];
    else globalThis[serviceKey] = previous;
  });

  const spawnCalls = [];
  const service = {
    marker: "native-service",
    spawn(type, prompt, options) {
      spawnCalls.push({ receiver: this.marker, type, prompt, options });
      return `${this.marker}:${type}`;
    },
    getRecord(id) {
      return { id, receiver: this.marker };
    },
    abort(id) {
      return `${this.marker}:${id}`;
    },
  };
  const nativeForegroundManager = {
    calls: 0,
    spawn(type) {
      this.calls += 1;
      return `foreground:${type}`;
    },
  };
  const nativeCleanup = () => {
    if (globalThis[serviceKey] === service) delete globalThis[serviceKey];
  };
  const { extensionResult } = installBridge({ maxParallelEyes: 3 }, () => {
    globalThis[serviceKey] = service;
    return nativeCleanup;
  });

  assert.equal(globalThis[serviceKey], service, "the native service object identity must survive bridge installation");
  assert.equal(extensionResult, nativeCleanup, "the native extension lifecycle result must pass through unchanged");
  for (const role of [
    "harness-planner",
    "harness-test-reviewer",
    "harness-compliance",
    "harness-adversary",
    "harness-security",
    "harness-harvester",
    "harness-plan-reviewer",
    "harness-executor",
    "harness-sniper",
    "harness-shipper",
    "harness-test-author",
    "harness-discussion-adversary",
  ]) {
    assert.throws(
      () => service.spawn(role, "bypass the guarded subagent tool", { bypassQueue: true }),
      /harness|guard|tool|spawn|dispatch|blocked/i,
      `${role} must not bypass policy, identity binding or admission through service.spawn`,
    );
  }
  assert.deepEqual(spawnCalls, [], "rejected runtime roles must never reach the native service spawn");

  assert.equal(
    service.spawn("third-party-helper", "allowed", { foreground: false }),
    "native-service:third-party-helper",
    "non-harness service behavior remains available",
  );
  assert.deepEqual(spawnCalls, [{
    receiver: "native-service",
    type: "third-party-helper",
    prompt: "allowed",
    options: { foreground: false },
  }]);
  assert.deepEqual(service.getRecord("agent-1"), { id: "agent-1", receiver: "native-service" });
  assert.equal(service.abort("agent-1"), "native-service:agent-1", "other service methods retain their receiver");
  assert.equal(nativeForegroundManager.spawn("harness-adversary"), "foreground:harness-adversary");
  assert.equal(nativeForegroundManager.calls, 1, "the bridge must leave the native foreground manager path untouched");
});

test("regression: a prepared final review and a parent mutation cannot both acquire a lease in either order", { timeout: 5_000 }, async (t) => {
  for (const firstKind of ["review", "mutation"]) {
    await t.test(`${firstKind} prepared first`, async () => {
      const { handlers } = installBridge({ maxParallelEyes: 3 }, () => {});
      const review = {
        type: "tool_call",
        toolName: "subagent",
        toolCallId: `review-first-${firstKind}`,
        input: {
          subagent_type: "harness-adversary",
          prompt: "[HARNESS_FINAL_REVIEW] inspect the immutable aggregate input",
        },
      };
      const mutation = {
        type: "tool_call",
        toolName: "write",
        toolCallId: `write-second-${firstKind}`,
        input: { path: "src/product.ts", content: "changed" },
      };
      const [first, second] = firstKind === "review" ? [review, mutation] : [mutation, review];

      const firstResult = await prepareToolCall(handlers, first);
      const pending = Symbol("tool_call hook waited for execution");
      const secondResult = await Promise.race([
        prepareToolCall(handlers, second),
        new Promise((resolve) => setImmediate(() => resolve(pending))),
      ]);

      assert.equal(firstResult, undefined, "the first prepared lease must be admitted");
      assert.notEqual(secondResult, pending, "tool_call preparation must decide immediately instead of waiting on execution");
      assert.equal(secondResult?.block, true, "the conflicting call in the same prepared batch must be blocked");
      assert.match(secondResult?.reason ?? "", /review|mutation|concurr|exclusive|lease/i);

      // Pi emits tool_execution_end for a blocked prepared call before it starts the admitted
      // callbacks. Ending that blocked call must not release the first call's lease.
      await finishToolCall(handlers, second, { isError: true });
      const stillBlocked = await prepareToolCall(handlers, { ...second, toolCallId: `${second.toolCallId}-early-retry` });
      assert.equal(stillBlocked?.block, true, "a blocked sibling finishing cannot release the admitted sibling's lease");
      await finishToolCall(handlers, { ...second, toolCallId: `${second.toolCallId}-early-retry` }, { isError: true });

      await finishToolCall(handlers, first);
      const retry = { ...second, toolCallId: `${second.toolCallId}-after-release` };
      assert.equal(await prepareToolCall(handlers, retry), undefined, "the conflicting operation may retry after the exact owner ends");
      await finishToolCall(handlers, retry);
    });
  }
});

test("regression: three prepared reviews share the reader lease while parent reads stay available and mutations stay out", async () => {
  const { handlers } = installBridge({ maxParallelEyes: 3 }, () => {});
  const reviews = ["adversary", "compliance", "security"].map((role) => ({
    type: "tool_call",
    toolName: "subagent",
    toolCallId: `review-${role}`,
    input: {
      subagent_type: `harness-${role}`,
      prompt: "[HARNESS_FINAL_REVIEW] inspect the same immutable aggregate input",
    },
  }));

  assert.deepEqual(
    await Promise.all(reviews.map((event) => prepareToolCall(handlers, event))),
    [undefined, undefined, undefined],
    "all three final-review roles may prepare together",
  );

  for (const toolName of ["read", "grep", "find", "ls", "get_result"]) {
    const read = { type: "tool_call", toolName, toolCallId: `read-${toolName}`, input: {} };
    assert.equal(await prepareToolCall(handlers, read), undefined, `${toolName} remains available to the parent during review`);
    await finishToolCall(handlers, read);
  }

  for (const action of ["status", "wait"]) {
    const observation = {type:"tool_call",toolName:"harness_tasks",toolCallId:`task-${action}`,input:{action}};
    assert.equal(await prepareToolCall(handlers,observation),undefined);
    await finishToolCall(handlers,observation);
  }

  for (const mutation of [
    { toolName: "write", input: { path: "src/a.ts", content: "changed" } },
    { toolName: "bash", input: { command: "git commit -m concurrent-change" } },
    { toolName: "mark", input: { action: "final-review" } },
    { toolName: "classify", input: { mode: "FULL" } },
    { toolName: "harness_tasks", input: { action: "integrate" } },
    { toolName: "harness_tasks", input: { action: "resume" } },
  ]) {
    const event = { type: "tool_call", toolCallId: `mutation-${mutation.toolName}`, ...mutation };
    const result = await prepareToolCall(handlers, event);
    assert.equal(result?.block, true, `${mutation.toolName} must not mutate parent or global state while reviews are active`);
    await finishToolCall(handlers, event, { isError: true });
  }

  await finishToolCall(handlers, reviews[0]);
  const earlyWrite = { type: "tool_call", toolName: "write", toolCallId: "write-after-one-eye", input: {} };
  assert.equal((await prepareToolCall(handlers, earlyWrite))?.block, true, "one completed eye cannot release the other readers");
  await finishToolCall(handlers, earlyWrite, { isError: true });

  await finishToolCall(handlers, reviews[1]);
  await finishToolCall(handlers, reviews[2]);
  const finalWrite = { ...earlyWrite, toolCallId: "write-after-all-eyes" };
  assert.equal(await prepareToolCall(handlers, finalWrite), undefined, "the mutation may retry after every reader ends");
  await finishToolCall(handlers, finalWrite);
});

test("regression: turn_end drops a prepared lease left behind by an aborted tool batch", async () => {
  const { handlers } = installBridge({ maxParallelEyes: 1 }, () => {});
  const review = {
    type: "tool_call",
    toolName: "subagent",
    toolCallId: "review-aborted-after-prepare",
    input: { subagent_type: "harness-security", prompt: "[HARNESS_FINAL_REVIEW] interrupted" },
  };
  assert.equal(await prepareToolCall(handlers, review), undefined);
  assert.ok((handlers.get("turn_end") ?? []).length > 0, "the bridge must clean prepared leases when a turn aborts before execution_end");

  await emitHooks(handlers, "turn_end", { type: "turn_end" });
  const retry = { type: "tool_call", toolName: "write", toolCallId: "write-after-aborted-turn", input: {} };
  assert.equal(await prepareToolCall(handlers, retry), undefined, "a later turn must not inherit the abandoned reader lease");
  await finishToolCall(handlers, retry);
});
