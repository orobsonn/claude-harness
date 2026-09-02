/**
 * @description Testes travados do ADAPTADOR Pi do entry-gate (as decisões em si vivem em
 * core/pi/lib/entry-gate.test.mjs). Cobrem só a tradução de eventos do Pi, que é onde a lane
 * OC não tem contraparte:
 *  - `tool_call` devolve `{block:true, reason}` com o texto EXATO do Decision.reason;
 *  - o advisory (nunca bloqueante) sai em `details.bash_advisory` no `tool_result` — espelho do
 *    canal `output.metadata.bash_advisory` da lane OC (ctx.sessionManager do Pi é
 *    ReadonlySessionManager e NÃO expõe appendCustomMessageEntry);
 *  - `tool_execution_end` do Pi NÃO carrega args (ToolExecutionEndEvent =
 *    {toolCallId,toolName,result,isError}), então o fato terminal da mão só é gravado porque os
 *    args são memorizados em `tool_execution_start` — este teste é o que prova essa costura.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import harnessEntryGate from "./harness-entry-gate.ts";
import { readPiChildIdentity } from "../lib/pi-child-identity.mjs";
import { claimPiDispatchForRuntime, readPiDispatchRecord } from "../lib/pi-state-records.mjs";

/** @description Fake do barramento de eventos do Pi (pi.events), por canal. */
function fakeEvents() {
  const channels = new Map();
  return {
    bus: {
      on: (channel, fn) => {
        channels.set(channel, fn);
        return () => channels.delete(channel);
      },
      emit: (channel, data) => channels.get(channel)?.(data),
    },
    emit: (channel, data) => channels.get(channel)?.(data),
  };
}

/** @description Registra a extensão contra um fake de ExtensionAPI e devolve os handlers. */
function handlers(events = fakeEvents()) {
  const registered = new Map();
  registered.set("__events", events);
  harnessEntryGate({ on: (name, fn) => registered.set(name, fn), events: events.bus });
  for (const name of ["session_start", "tool_execution_start", "tool_call", "tool_result", "tool_execution_end"]) {
    assert.equal(typeof registered.get(name), "function", `faltou registrar ${name}`);
  }
  return registered;
}

const SESSION = "ses-pi-adapter";
const FEATURE = "feat-pi-adapter";

/** @description ctx do Pi: sessionId do sessionManager e sessão filha por header.parentSession. */
function ctxOf(cwd, { child = false } = {}) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => SESSION,
      getHeader: () => (child ? { parentSession: "ses-pi-parent" } : {}),
    },
  };
}

const MODEL_STRATEGY = {
  hand_tiers: { low: "openai/luna", medium: "openai/luna", high: "openai/terra" },
  planner: "openai/planner",
  "plan-reviewer": "openai/reviewer",
  compliance: "openai/compliance",
  adversary: "openai/adversary",
  security: "openai/security",
  shipper: "openai/shipper",
  harvester: "openai/harvester",
};

/** @description Projeto Pi real com plano estável, gate-state FULL e formulário de issue vendorizado. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-entry-gate-adapter-"));
  const plan = {
    feature_id: FEATURE,
    mode: "full",
    model_strategy: MODEL_STRATEGY,
    final_review: { compliance: true, adversary: true },
    demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] },
    tasks: [
      {
        id: "task-1",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [
          { id: "lt-1", path: "tests/a.test.mjs", assertion: "Given task, When complete, Then observable a" },
        ],
        title: "Implement task-1",
        description: "Implement task-1.",
        depends_on: [],
        severity: "medium",
        complexity: "medium",
        resolved_judgments: { scope: "fixed" },
        adversarial: { enabled: false, focus: [] },
      },
    ],
  };
  mkdirSync(join(root, ".pi", "harness", "plans", FEATURE), { recursive: true });
  writeFileSync(join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json"), JSON.stringify(plan));
  mkdirSync(join(root, ".pi", "harness", "state", SESSION), { recursive: true });
  writeFileSync(
    join(root, ".pi", "harness", "state", SESSION, "gate-state.json"),
    JSON.stringify({ session_id: SESSION, feature_id: FEATURE, classified: true, mode: "FULL" }),
  );
  mkdirSync(join(root, ".github", "ISSUE_TEMPLATE"), { recursive: true });
  writeFileSync(join(root, ".github", "ISSUE_TEMPLATE", "harness-task.yml"), "name: harness\n");
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

const BRIEF = '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT] implemente';

test("tool_call de bash devolve {block,reason} com o texto exato do rail #808", async () => {
  const f = fixture();
  try {
    const h = handlers();
    const out = await h.get("tool_call")(
      { toolName: "bash", toolCallId: "call-a", input: { command: 'gh issue create --title "x" --label harness:ready' } },
      ctxOf(f.root, { child: true }),
    );
    assert.equal(out.block, true);
    assert.match(out.reason, /^\[entry-gate\] Blocked: attaching `harness:ready`/);
  } finally {
    f.close();
  }
});

test("advisory não bloqueia e sai em details.bash_advisory no tool_result", async () => {
  const f = fixture();
  try {
    const h = handlers();
    const ctx = ctxOf(f.root, { child: true });
    const blocked = await h.get("tool_call")(
      { toolName: "bash", toolCallId: "call-b", input: { command: 'gh issue create --title "x"' } },
      ctx,
    );
    assert.equal(blocked, undefined, "advisory jamais bloqueia");

    const injected = h.get("tool_result")({ toolName: "bash", toolCallId: "call-b", details: { keep: 1 } });
    assert.equal(injected.details.keep, 1);
    assert.match(injected.details.bash_advisory, /harness ROUTINE session/);

    // consumido uma única vez: um segundo tool_result não reinjeta nada.
    assert.equal(h.get("tool_result")({ toolName: "bash", toolCallId: "call-b" }), undefined);
  } finally {
    f.close();
  }
});

test("tool_execution_end grava o fato terminal com os args memorizados em tool_execution_start", () => {
  const f = fixture();
  try {
    const h = handlers();
    h.get("session_start")({}, ctxOf(f.root));
    const claimed = claimPiDispatchForRuntime(
      f.root,
      { sessionId: SESSION, callId: "call-c", role: "harness-executor", taskId: "task-1", featureId: FEATURE },
      { env: {}, isAncestorFn: () => null },
    );
    assert.equal(claimed.ok, true, claimed.reason);

    const args = { subagent_type: "harness-executor", prompt: BRIEF, description: "task-1" };
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-c", args });
    h.get("tool_execution_end")(
      {
        toolName: "subagent",
        toolCallId: "call-c",
        // resultado ESTRUTURADO do Pi: String(result) daria "[object Object]" e o status
        // terminal nunca seria lido — piResultText é quem extrai o texto.
        result: [{ type: "text", text: "Status: DONE" }],
        isError: false,
      },
      ctxOf(f.root),
    );

    const record = JSON.parse(
      readFileSync(join(f.root, ".pi", "harness", "state", "hand-records", FEATURE, SESSION, "task-1.json"), "utf8"),
    );
    assert.equal(record.outcome, "DONE");
    assert.equal(record.producerCallId, "call-c");
    const gateState = JSON.parse(
      readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"),
    );
    assert.deepEqual(gateState.hand_finished, [`${FEATURE}/task-1`]);
  } finally {
    f.close();
  }
});

test("sem os args memorizados o fim de execução não tem papel nem task e nada é gravado", () => {
  const f = fixture();
  try {
    const h = handlers();
    h.get("session_start")({}, ctxOf(f.root));
    const claimed = claimPiDispatchForRuntime(
      f.root,
      { sessionId: SESSION, callId: "call-d", role: "harness-executor", taskId: "task-1", featureId: FEATURE },
      { env: {}, isAncestorFn: () => null },
    );
    assert.equal(claimed.ok, true, claimed.reason);

    h.get("tool_execution_end")(
      { toolName: "subagent", toolCallId: "call-d", result: [{ type: "text", text: "Status: DONE" }], isError: false },
      ctxOf(f.root),
    );

    const gateState = JSON.parse(
      readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"),
    );
    assert.equal(gateState.hand_finished, undefined);
  } finally {
    f.close();
  }
});

test("tool_call de subagent nega com a reason da peça state-records quando não há plano estável", () => {
  const f = fixture();
  try {
    const h = handlers();
    const out = h.get("tool_call")(
      {
        toolName: "subagent",
        toolCallId: "call-e",
        input: { subagent_type: "harness-executor", prompt: BRIEF, feature_id: "feat-inexistente" },
      },
      ctxOf(f.root),
    );
    return Promise.resolve(out).then((decision) => {
      assert.equal(decision.block, true);
      assert.match(decision.reason, /^\[entry-gate\] /);
    });
  } finally {
    f.close();
  }
});

test("dispatch que termina em erro remove o dispatch-record órfão (paridade com o handler `event` da OC)", () => {
  const f = fixture();
  try {
    const h = handlers();
    h.get("session_start")({}, ctxOf(f.root));
    const claimed = claimPiDispatchForRuntime(
      f.root,
      { sessionId: SESSION, callId: "call-f", role: "harness-executor", taskId: "task-1", featureId: FEATURE },
      { env: {}, isAncestorFn: () => null },
    );
    assert.equal(claimed.ok, true, claimed.reason);
    assert.equal(readPiDispatchRecord(f.root, { parentSessionId: SESSION, callId: "call-f" }).ok, true);

    const args = { subagent_type: "harness-executor", prompt: BRIEF, description: "task-1" };
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-f", args });
    h.get("tool_execution_end")(
      { toolName: "subagent", toolCallId: "call-f", result: "boom", isError: true },
      ctxOf(f.root),
    );

    assert.equal(readPiDispatchRecord(f.root, { parentSessionId: SESSION, callId: "call-f" }).ok, false);
    const gateState = JSON.parse(
      readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"),
    );
    assert.equal(gateState.hand_finished, undefined);
  } finally {
    f.close();
  }
});


const CHILD_SESSION = "ses-pi-child";

test("session-created liga a filha ao único dispatch em voo: identidade durável + binding do record", () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root));
    const claimed = claimPiDispatchForRuntime(
      f.root,
      { sessionId: SESSION, callId: "call-bind", role: "harness-executor", taskId: "task-1", featureId: FEATURE },
      { env: {}, isAncestorFn: () => null },
    );
    assert.equal(claimed.ok, true, claimed.reason);

    const args = { subagent_type: "harness-executor", prompt: BRIEF, description: "task-1" };
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-bind", args });
    events.emit("subagents:child:session-created", { sessionId: CHILD_SESSION, parentSessionId: SESSION });

    const identity = readPiChildIdentity(f.root, CHILD_SESSION);
    assert.equal(identity.ok, true, identity.reason);
    assert.equal(identity.record.role, "harness-executor");
    assert.equal(identity.record.dispatch_call_id, "call-bind");
    // O rail de escopo dentro da filha só arma com o record ligado a ela.
    const record = readPiDispatchRecord(f.root, { parentSessionId: SESSION, callId: "call-bind" });
    assert.equal(record.ok, true, record.reason);
    assert.equal(record.record.child_session_id, CHILD_SESSION);
  } finally {
    f.close();
  }
});

test("o papel de OLHO também recebe identidade durável — é o que torna o planner autoridade de plano", () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({
      toolName: "subagent",
      toolCallId: "call-plan",
      args: { subagent_type: "harness-planner", prompt: "planeje", description: "plan" },
    });
    events.emit("subagents:child:session-created", { sessionId: CHILD_SESSION, parentSessionId: SESSION });

    assert.equal(readPiChildIdentity(f.root, CHILD_SESSION).record.role, "harness-planner");
  } finally {
    f.close();
  }
});

test("com dois dispatches em voo a ligação seria ambígua: nada é gravado", () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-1", args: { subagent_type: "harness-planner" } });
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-2", args: { subagent_type: "harness-adversary" } });
    events.emit("subagents:child:session-created", { sessionId: CHILD_SESSION, parentSessionId: SESSION });

    assert.equal(readPiChildIdentity(f.root, CHILD_SESSION).absent, true);
  } finally {
    f.close();
  }
});

test("a instância que roda NA filha nunca liga ninguém, mesmo ouvindo o mesmo barramento", () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root, { child: true }));
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-x", args: { subagent_type: "harness-planner" } });
    events.emit("subagents:child:session-created", { sessionId: CHILD_SESSION, parentSessionId: SESSION });

    assert.equal(readPiChildIdentity(f.root, CHILD_SESSION).absent, true);
  } finally {
    f.close();
  }
});

test("o fim do dispatch retira a identidade da filha", () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({
      toolName: "subagent",
      toolCallId: "call-end",
      args: { subagent_type: "harness-planner", prompt: "planeje" },
    });
    events.emit("subagents:child:session-created", { sessionId: CHILD_SESSION, parentSessionId: SESSION });
    assert.equal(readPiChildIdentity(f.root, CHILD_SESSION).ok, true);

    h.get("tool_execution_end")(
      { toolName: "subagent", toolCallId: "call-end", result: "plano pronto", isError: false },
      ctxOf(f.root),
    );

    assert.equal(readPiChildIdentity(f.root, CHILD_SESSION).absent, true);
  } finally {
    f.close();
  }
});
