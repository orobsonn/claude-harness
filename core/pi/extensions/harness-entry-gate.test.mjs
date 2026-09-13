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
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import harnessEntryGate from "./harness-entry-gate.ts";
import { readPiChildIdentity } from "../lib/pi-child-identity.mjs";
import { claimPiDispatchForRuntime, readPiDispatchRecord } from "../lib/pi-state-records.mjs";
import { writePiSpecDraft } from "../lib/spec-approval.mjs";
import { missingPiReviewRoles } from "../lib/pi-review-evidence.mjs";

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

const SUBAGENTS_SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");

function publishNativeRecord({ agentId, role, body, status = "completed", pendingQuestion }) {
  const previous = globalThis[SUBAGENTS_SERVICE_KEY];
  globalThis[SUBAGENTS_SERVICE_KEY] = {
    getRecord(id) {
      if (id !== agentId) return undefined;
      return {
        id: agentId, type: role, description: "review", status, isBackground: false,
        result: body, ...(pendingQuestion ? { pendingQuestion } : {}), toolUses: 1, turnCount: 1,
        startedAt: 1, completedAt: 2, lifetimeUsage: { input: 1, output: 1, cacheWrite: 0 }, compactionCount: 0,
      };
    },
  };
  return () => {
    if (previous === undefined) delete globalThis[SUBAGENTS_SERVICE_KEY];
    else globalThis[SUBAGENTS_SERVICE_KEY] = previous;
  };
}

function wrappedReviewResult(agentId, body, status = "completed") {
  return {
    content: [{ type: "text", text: `Agent completed in 1s (1 tool uses).\nAgent ID: ${agentId}\n\n${body}` }],
    details: { status, agentId },
  };
}

const SESSION = "ses-pi-adapter";
const FEATURE = "feat-pi-adapter";

/** @description ctx do Pi: sessionId do sessionManager e sessão filha por header.parentSession. */
function ctxOf(cwd, { child = false, sessionId = SESSION } = {}) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
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
  writePiSpecDraft({ content: "# Draft\n" }, { projectRoot: root, sessionId: SESSION });
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

for (const mode of ["FULL", "LIGHT"]) test(`tool_execution_end preserves capture but only arms implementation re-gate in FULL (${mode})`, () => {
  const f = fixture();
  try {
    const statePath = join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, mode }));
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
    assert.equal(Boolean(gateState.regate_pending?.includes(`${FEATURE}/task-1`)), mode === "FULL");
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

test("discussion adversary never binds delivery identity or mutates gate state", async () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    const args = { subagent_type: "harness-discussion-adversary", prompt: "critique", description: "discussion" };
    const before = readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8");
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-discussion", args });
    assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: "call-discussion", input: args }, ctxOf(f.root)), undefined);
    events.emit("subagents:child:session-created", { sessionId: CHILD_SESSION, parentSessionId: SESSION });
    assert.equal(readPiChildIdentity(f.root, CHILD_SESSION).absent, true);
    h.get("tool_execution_end")({ toolName: "subagent", toolCallId: "call-discussion", result: { details: { status: "completed", agentId: "discussion" } }, isError: false }, ctxOf(f.root));
    assert.equal(readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"), before);
  } finally { f.close(); }
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

test("implementation eyes start after the selective commit and keep their one accepted receipt", async (t) => {
  for (const phase of ["task", "final"]) {
    await t.test(phase, async () => {
      const f = fixture();
      try {
        const git = (...args) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" }).trim();
        git("init", "-q");
        git("add", ".");
        git("-c", "user.name=Pi", "-c", "user.email=pi@example.test", "commit", "-qm", "fixture");
        const statePath = join(f.root, ".pi/harness/state", SESSION, "gate-state.json");
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        writeFileSync(statePath, JSON.stringify({ ...state, spec_status: "adversary-reviewed", adversary_fired: true }));
        mkdirSync(join(f.root, "src"));
        writeFileSync(join(f.root, "src/a.ts"), "export const value = 1;\n");
        const events = fakeEvents();
        const h = handlers(events);
        const ctx = ctxOf(f.root);
        h.get("session_start")({}, ctx);
        const role = "harness-adversary";
        const args = { subagent_type: role, prompt: phase === "task" ? BRIEF : "[HARNESS_FINAL_REVIEW] review", description: "review" };
        const blocked = await h.get("tool_call")({ toolName: "subagent", toolCallId: "premature", input: args }, ctx);
        assert.equal(blocked?.block, true, "deny before the expensive reviewer starts");
        assert.match(blocked.reason, /commit/i);
        assert.equal(readPiChildIdentity(f.root, CHILD_SESSION).absent, true);
        const noCallId = await h.get("tool_call")({ toolName: "subagent", input: args }, ctx);
        assert.equal(noCallId?.block, true);
        assert.match(noCallId.reason, /native tool call ID/i);
        const fidelity = { subagent_type: "harness-compliance", prompt: BRIEF + " Verify test fidelity before freeze." };
        assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: "fidelity", input: fidelity }, ctx), undefined, "test fidelity still reviews uncommitted tests");
        git("add", "--", "src/a.ts");
        assert.equal((await h.get("tool_call")({ toolName: "subagent", toolCallId: "only-staged", input: args }, ctx))?.block, true);
        git("-c", "user.name=Pi", "-c", "user.email=pi@example.test", "commit", "-qm", "implementation");
        assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: "review", input: args }, ctx), undefined);
        h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "review", args });
        const binding = { toolCallId: "review", subagentType: role, parentSessionId: SESSION, childSessionId: CHILD_SESSION };
        events.emit("harness:child-bind", binding);
        assert.deepEqual(binding.result, { ok: true });
        const body = '{"issues":[]}';
        const unpublish = publishNativeRecord({ agentId: "accepted-review", role, body });
        try {
          h.get("tool_execution_end")({ toolName: "subagent", toolCallId: "review", result: wrappedReviewResult("accepted-review", body), isError: false }, ctx);
        } finally { unpublish(); }
        const status = { projectRoot: f.root, sessionId: SESSION, featureId: FEATURE, phase, ...(phase === "task" ? { taskId: "task-1" } : {}), roles: [role] };
        assert.deepEqual(missingPiReviewRoles(status), [], "one review remains valid after completion and status reconciliation");
        writeFileSync(join(f.root, "src/a.ts"), "export const value = 2;\n");
        assert.deepEqual(missingPiReviewRoles(status), [role], "real content changes still invalidate the receipt");
      } finally { f.close(); }
    });
  }
});

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

test("regression: o binder interno liga três olhos concorrentes ao call exato e preserva os três recibos", async () => {
  const f = fixture();
  try {
    execFileSync("git", ["init", "-q"], { cwd: f.root });
    execFileSync("git", ["add", "."], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=Pi", "-c", "user.email=pi@example.test", "commit", "-q", "-m", "fixture"], { cwd: f.root });
    const statePath = join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, spec_status: "adversary-reviewed", adversary_fired: true }));

    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root));
    const dispatched = [
      ["harness-adversary", "call-parallel-adversary", "child-parallel-adversary", "agent-parallel-adversary"],
      ["harness-compliance", "call-parallel-compliance", "child-parallel-compliance", "agent-parallel-compliance"],
      ["harness-security", "call-parallel-security", "child-parallel-security", "agent-parallel-security"],
    ];
    for (const [role, callId] of dispatched) {
      const args = { subagent_type: role, prompt: "[HARNESS_FINAL_REVIEW] review the same aggregate input", description: role };
      h.get("tool_execution_start")({ toolName: "subagent", toolCallId: callId, args });
      assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: callId, input: args }, ctxOf(f.root)), undefined);
    }

    for (const [role, callId, childSessionId] of dispatched.toReversed()) {
      const request = { toolCallId: callId, subagentType: role, parentSessionId: SESSION, childSessionId };
      events.emit("harness:child-bind", request);
      assert.deepEqual(request.result, { ok: true }, `the adapter must synchronously acknowledge ${callId}`);
      const identity = readPiChildIdentity(f.root, childSessionId);
      assert.equal(identity.ok, true, identity.reason);
      assert.equal(identity.record.dispatch_call_id, callId);
      assert.equal(identity.record.role, role);
    }

    for (const [role, callId, _childSessionId, agentId] of dispatched.toReversed()) {
      const body = '{"issues":[]}';
      const unpublish = publishNativeRecord({ agentId, role, body });
      h.get("tool_execution_end")({
        toolName: "subagent",
        toolCallId: callId,
        result: wrappedReviewResult(agentId, body),
        isError: false,
      }, ctxOf(f.root));
      unpublish();
    }

    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim();
    assert.deepEqual(Object.keys(saved.final_review_evidence).sort(), ["adversary", "compliance", "security"]);
    const inputDigests = new Set();
    for (const [role, callId, childSessionId, agentId] of dispatched) {
      const receipt = saved.final_review_evidence[role.replace("harness-", "")];
      assert.equal(receipt.dispatch_call_id, callId);
      assert.equal(receipt.child_session_id, childSessionId);
      assert.equal(receipt.agent_id, agentId);
      assert.equal(receipt.role, role);
      assert.equal(receipt.accepted, true);
      assert.equal(receipt.reviewed_head_sha, head);
      assert.match(receipt.input_digest, /^[0-9a-f]{64}$/);
      inputDigests.add(receipt.input_digest);
    }
    assert.equal(inputDigests.size, 1, "all concurrent eyes must attest the same immutable snapshot");
  } finally {
    f.close();
  }
});

test("regression: binder interno nega call, papel ou parent divergente sem gravar identidade", () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({
      toolName: "subagent",
      toolCallId: "call-known",
      args: { subagent_type: "harness-adversary", prompt: "[HARNESS_FINAL_REVIEW] exact binding" },
    });

    const invalid = [
      { toolCallId: "call-unknown", subagentType: "harness-adversary", parentSessionId: SESSION, childSessionId: "child-unknown" },
      { toolCallId: "call-known", subagentType: "harness-compliance", parentSessionId: SESSION, childSessionId: "child-wrong-role" },
      { toolCallId: "call-known", subagentType: "harness-adversary", parentSessionId: "ses-wrong-parent", childSessionId: "child-wrong-parent" },
    ];
    for (const request of invalid) {
      events.emit("harness:child-bind", request);
      assert.equal(request.result?.ok, false, "an identity mismatch must receive an explicit negative acknowledgement");
      assert.equal(readPiChildIdentity(f.root, request.childSessionId).absent, true, "a rejected binding must leave no durable child identity");
    }
  } finally {
    f.close();
  }
});

test("regression: binder interno recusa review cujo snapshot mudou depois de tool_call", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "src"), { recursive: true });
    const productPath = join(f.root, "src", "product.ts");
    writeFileSync(productPath, "export const product = 'reviewed';\n");
    execFileSync("git", ["init", "-q"], { cwd: f.root });
    execFileSync("git", ["add", "."], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=Pi", "-c", "user.email=pi@example.test", "commit", "-q", "-m", "fixture"], { cwd: f.root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim();
    const statePath = join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, spec_status: "adversary-reviewed", adversary_fired: true }));

    const events = fakeEvents();
    const h = handlers(events);
    const args = {
      subagent_type: "harness-security",
      prompt: "[HARNESS_FINAL_REVIEW] review immutable input before admission",
      description: "security review",
    };
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-review-drift-before-bind", args });
    assert.equal(await h.get("tool_call")({
      toolName: "subagent",
      toolCallId: "call-review-drift-before-bind",
      input: args,
    }, ctxOf(f.root)), undefined);

    writeFileSync(productPath, "export const product = 'changed-before-child-start';\n");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim(), head);
    const request = {
      toolCallId: "call-review-drift-before-bind",
      subagentType: "harness-security",
      parentSessionId: SESSION,
      childSessionId: "child-review-drift-before-bind",
    };
    events.emit("harness:child-bind", request);

    assert.equal(request.result?.ok, false, "the child must not start against bytes that differ from its prepared review input");
    assert.equal(readPiChildIdentity(f.root, request.childSessionId).absent, true);
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

test("só a conclusão host-confirmada do adversary de spec cria a evidência que libera a próxima fase", () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({
      toolName: "subagent",
      toolCallId: "call-adversary",
      args: { subagent_type: "harness-adversary", prompt: "ataque", description: "adversary" },
    });
    events.emit("subagents:child:session-created", { sessionId: CHILD_SESSION, parentSessionId: SESSION });

    h.get("tool_execution_end")(
      {
        toolName: "subagent",
        toolCallId: "call-adversary",
        result: { content: [{ type: "text", text: "review" }], details: { status: "completed", agentId: "agent-adversary" } },
        isError: false,
      },
      ctxOf(f.root),
    );

    const state = JSON.parse(readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"));
    assert.deepEqual(state.adversary_completion_evidence, {
      written_by: "host-subagent-completion",
      parent_session_id: SESSION,
      feature_id: FEATURE,
      role: "harness-adversary",
      dispatch_call_id: "call-adversary",
      child_session_id: CHILD_SESSION,
      agent_id: "agent-adversary",
      status: "completed",
      spec_sha256: state.spec_sha256,
    });
  } finally {
    f.close();
  }
});

test("task review com prosa ambígua ou achado canônico substitui aprovação antiga sem aprovar", async (t) => {
  const finding = {
    description: "A revisão encontrou perda de recibo concorrente.", category: "race", severity: "high",
    scope: "core/pi/extensions/harness-entry-gate.ts", evidence: "o mapa é lido antes do lock",
    fix_hint: "mover a redução inteira para withGateStateLock",
  };
  for (const [label, slug, text, pendingQuestion] of [
    ["prosa positiva sem schema", "ambiguous-prose", "Tudo certo, aprovado.", undefined],
    ["relatório negativo", "negative-report", JSON.stringify({ issues: [finding] }), undefined],
    ["relatório positivo com pergunta pendente", "pending-question", '{"issues":[]}', "Devo revisar o arquivo restante?"],
  ]) {
    await t.test(label, async (st) => {
      const f = fixture();
      st.after(f.close);
      execFileSync("git", ["init", "-q"], { cwd: f.root });
      execFileSync("git", ["add", "."], { cwd: f.root });
      execFileSync("git", ["-c", "user.name=Pi", "-c", "user.email=pi@example.test", "commit", "-qm", "fixture"], { cwd: f.root });
      const events = fakeEvents();
      const h = handlers(events);
      const callId = `call-${slug}`;
      const args = {
        subagent_type: "harness-adversary",
        prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT] attack task',
        description: "task adversary",
      };
      h.get("session_start")({}, ctxOf(f.root));
      const priorPath = join(f.root, ".pi/harness/state", SESSION, "gate-state.json");
      const prior = JSON.parse(readFileSync(priorPath, "utf8"));
      writeFileSync(priorPath, JSON.stringify({ ...prior, task_adversary_evidence: {
        [FEATURE + "/task-1"]: { accepted: true, dispatch_call_id: "old-approved-review" },
      } }));
      h.get("tool_execution_start")({ toolName: "subagent", toolCallId: callId, args });
      assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: callId, input: args }, ctxOf(f.root)), undefined);
      events.emit("subagents:child:session-created", { sessionId: `${CHILD_SESSION}-${callId}`, parentSessionId: SESSION });
      const agentId = `agent-${callId}`;
      const unpublish = publishNativeRecord({ agentId, role: "harness-adversary", body: text, pendingQuestion });
      h.get("tool_execution_end")({
        toolName: "subagent", toolCallId: callId,
        result: wrappedReviewResult(agentId, text),
        isError: false,
      }, ctxOf(f.root));
      unpublish();
      const state = JSON.parse(readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"));
      assert.equal(state.task_adversary_evidence[FEATURE + "/task-1"].accepted, false, `${label} cannot reuse the old approval`);
      if (slug === "negative-report") assert.deepEqual(state.task_adversary_evidence[FEATURE + "/task-1"].report.issues, [finding]);
      assert.equal(state.adversary_completion_evidence, undefined, `${label} cannot be misclassified as an accepted spec review`);
    });
  }
});

test("erro da filha adversária nunca vira evidência de conclusão", () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({
      toolName: "subagent",
      toolCallId: "call-timeout",
      args: { subagent_type: "harness-adversary", prompt: "ataque", description: "adversary" },
    });
    events.emit("subagents:child:session-created", { sessionId: CHILD_SESSION, parentSessionId: SESSION });
    h.get("tool_execution_end")(
      {
        toolName: "subagent",
        toolCallId: "call-timeout",
        result: { content: [{ type: "text", text: "Agent failed: WebSocket idle timeout after 300000ms" }], details: { status: "error", agentId: "agent-adversary" } },
        isError: false,
      },
      ctxOf(f.root),
    );

    const state = JSON.parse(readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"));
    assert.equal(state.adversary_completion_evidence, undefined);
  } finally {
    f.close();
  }
});

test("compliance de fidelity fora de task-review/final não entra no ledger de recibos", () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    const args = { subagent_type: "harness-compliance", prompt: "verifique fidelity-before-freeze", description: "fidelity" };
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-fidelity-compliance", args });
    events.emit("subagents:child:session-created", { sessionId: `${CHILD_SESSION}-fidelity`, parentSessionId: SESSION });
    const body = '{"issues":[]}';
    const unpublish = publishNativeRecord({ agentId: "agent-fidelity-compliance", role: "harness-compliance", body });
    h.get("tool_execution_end")({
      toolName: "subagent", toolCallId: "call-fidelity-compliance",
      result: wrappedReviewResult("agent-fidelity-compliance", body), isError: false,
    }, ctxOf(f.root));
    unpublish();
    const state = JSON.parse(readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"));
    assert.equal(state.final_review_evidence, undefined);
    assert.equal(state.task_adversary_evidence, undefined);
    assert.equal(state.task_review_evidence, undefined);
  } finally { f.close(); }
});

test("adversary de tarefa grava recibo host-owned preso ao marcador e ao HEAD", async () => {
  const f = fixture();
  try {
    execFileSync("git", ["init"], { cwd: f.root });
    execFileSync("git", ["add", "."], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=Pi", "-c", "user.email=pi@example.test", "commit", "-m", "fixture"], { cwd: f.root });
    const statePath = join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, spec_status: "adversary-reviewed", adversary_fired: true }));
    const events = fakeEvents();
    const h = handlers(events);
    const args = {
      subagent_type: "harness-adversary",
      prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT] attack task',
      description: "task adversary",
    };
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-task-adversary", args });
    assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: "call-task-adversary", input: args }, ctxOf(f.root)), undefined);
    events.emit("subagents:child:session-created", { sessionId: CHILD_SESSION, parentSessionId: SESSION });
    const taskBody = '{"issues":[]}';
    const unpublish = publishNativeRecord({ agentId: "agent-task-adversary", role: "harness-adversary", body: taskBody });
    h.get("tool_execution_end")({
      toolName: "subagent", toolCallId: "call-task-adversary",
      result: wrappedReviewResult("agent-task-adversary", taskBody), isError: false,
    }, ctxOf(f.root));
    unpublish();
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    const receipt = saved.task_adversary_evidence[`${FEATURE}/task-1`];
    assert.equal(receipt.written_by, "host-subagent-completion");
    assert.equal(receipt.parent_session_id, SESSION);
    assert.equal(receipt.feature_id, FEATURE);
    assert.equal(receipt.role, "harness-adversary");
    assert.equal(receipt.task_id, "task-1");
    assert.equal(receipt.dispatch_call_id, "call-task-adversary");
    assert.equal(receipt.child_session_id, CHILD_SESSION);
    assert.equal(receipt.agent_id, "agent-task-adversary");
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.accepted, true);
    assert.deepEqual(receipt.report, { issues: [] });
    assert.match(receipt.input_digest, /^[0-9a-f]{64}$/);
    assert.equal(receipt.reviewed_head_sha, execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim());
  } finally { f.close(); }
});

test("olhos finais gravam recibos host-owned no HEAD agregado mesmo com verdict redundante", async () => {
  const f = fixture();
  try {
    execFileSync("git", ["init"], { cwd: f.root });
    execFileSync("git", ["add", "."], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=Pi", "-c", "user.email=pi@example.test", "commit", "-m", "fixture"], { cwd: f.root });
    const statePath = join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, spec_status: "adversary-reviewed", adversary_fired: true }));
    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root));
    for (const [role, callId, agentId] of [
      ["harness-adversary", "call-final-adversary", "agent-final-adversary"],
      ["harness-compliance", "call-final-compliance", "agent-final-compliance"],
    ]) {
      const args = { subagent_type: role, prompt: "[HARNESS_FINAL_REVIEW] review aggregate diff", description: "final review" };
      h.get("tool_execution_start")({ toolName: "subagent", toolCallId: callId, args });
      assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: callId, input: args }, ctxOf(f.root)), undefined);
      events.emit("subagents:child:session-created", { sessionId: `${CHILD_SESSION}-${callId}`, parentSessionId: SESSION });
      const body = '{"verdict":"APPROVE","issues":[]}';
      const unpublish = publishNativeRecord({ agentId, role, body });
      h.get("tool_execution_end")({
        toolName: "subagent", toolCallId: callId,
        result: wrappedReviewResult(agentId, body), isError: false,
      }, ctxOf(f.root));
      unpublish();
    }
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim();
    for (const [key, role, callId, agentId] of [
      ["adversary", "harness-adversary", "call-final-adversary", "agent-final-adversary"],
      ["compliance", "harness-compliance", "call-final-compliance", "agent-final-compliance"],
    ]) {
      const receipt = saved.final_review_evidence[key];
      assert.equal(receipt.written_by, "host-subagent-completion");
      assert.equal(receipt.parent_session_id, SESSION);
      assert.equal(receipt.feature_id, FEATURE);
      assert.equal(receipt.role, role);
      assert.equal(receipt.dispatch_call_id, callId);
      assert.equal(receipt.child_session_id, `${CHILD_SESSION}-${callId}`);
      assert.equal(receipt.agent_id, agentId);
      assert.equal(receipt.status, "completed");
      assert.equal(receipt.accepted, true);
      assert.deepEqual(receipt.report, { issues: [] });
      assert.match(receipt.input_digest, /^[0-9a-f]{64}$/);
      assert.match(receipt.report_digest, /^[0-9a-f]{64}$/);
      assert.equal(receipt.reviewed_head_sha, head);
    }
  } finally { f.close(); }
});

test("review que termina sem child admission não fica running nem aprova", async () => {
  const f = fixture();
  try {
    execFileSync("git", ["init", "-q"], { cwd: f.root });
    execFileSync("git", ["add", "."], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=Pi", "-c", "user.email=pi@example.test", "commit", "-qm", "fixture"], { cwd: f.root });
    const statePath = join(f.root, ".pi/harness/state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, spec_status: "adversary-reviewed", adversary_fired: true }));
    const h = handlers();
    const args = { subagent_type: "harness-adversary", prompt: "[HARNESS_FINAL_REVIEW] review aggregate diff", description: "final review" };
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "spawn-failed", args });
    assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: "spawn-failed", input: args }, ctxOf(f.root)), undefined);
    h.get("tool_execution_end")({ toolName: "subagent", toolCallId: "spawn-failed",
      result: { content: [{ type: "text", text: "child spawn failed" }] }, isError: true }, ctxOf(f.root));
    const receipt = JSON.parse(readFileSync(statePath, "utf8")).final_review_evidence.adversary;
    assert.equal(receipt.accepted, false);
    assert.equal(receipt.status, "invalid");
    assert.match(receipt.reason, /without an admitted child session/);
  } finally { f.close(); }
});

test("mudança unstaged durante o olho final invalida o recibo mesmo quando o HEAD não mudou", async () => {
  const f = fixture();
  try {
    execFileSync("git", ["init", "-q"], { cwd: f.root });
    mkdirSync(join(f.root, "src"), { recursive: true });
    writeFileSync(join(f.root, "src", "product.ts"), "export const value = 'before';\n");
    execFileSync("git", ["add", "."], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=Pi", "-c", "user.email=pi@example.test", "commit", "-q", "-m", "fixture"], { cwd: f.root });
    const statePath = join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, spec_status: "adversary-reviewed", adversary_fired: true }));
    const events = fakeEvents();
    const h = handlers(events);
    const args = { subagent_type: "harness-adversary", prompt: "[HARNESS_FINAL_REVIEW] review aggregate diff", description: "final review" };
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: "call-final-drift", args });
    assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: "call-final-drift", input: args }, ctxOf(f.root)), undefined);
    events.emit("subagents:child:session-created", { sessionId: `${CHILD_SESSION}-drift`, parentSessionId: SESSION });
    const reviewedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim();
    writeFileSync(join(f.root, "src", "product.ts"), "export const value = 'changed while reviewing';\n");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim(), reviewedHead);
    const driftBody = '{"issues":[]}';
    const unpublish = publishNativeRecord({ agentId: "agent-final-drift", role: "harness-adversary", body: driftBody });
    h.get("tool_execution_end")({
      toolName: "subagent", toolCallId: "call-final-drift",
      result: wrappedReviewResult("agent-final-drift", driftBody),
      isError: false,
    }, ctxOf(f.root));
    unpublish();
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(saved.final_review_evidence.adversary.accepted, false, "the adapter must compare the full review input, not HEAD alone");
    assert.equal(saved.final_review_evidence.adversary.status, "invalid");
    assert.match(saved.final_review_evidence.adversary.reason, /input|snapshot|changed/i);
  } finally { f.close(); }
});

test("shipper não pode escrever produto mesmo quando sua identidade de olho é conhecida", async () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({
      toolName: "subagent",
      toolCallId: "call-shipper",
      args: { subagent_type: "harness-shipper", prompt: "entregue", description: "ship" },
    });
    events.emit("subagents:child:session-created", { sessionId: CHILD_SESSION, parentSessionId: SESSION });

    const planWrite = await import("./harness-plan-write-gate.ts");
    const writes = new Map();
    planWrite.default({ on: (name, fn) => writes.set(name, fn) });
    const blocked = writes.get("tool_call")(
      { toolName: "write", input: { path: "src/product.ts", content: "unsafe" } },
      ctxOf(f.root, { child: true, sessionId: CHILD_SESSION }),
    );
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /shipper.*must not write product/i);
  } finally {
    f.close();
  }
});

test("plan-reviewer APPROVE real grava recibo host-owned dos hashes observados no dispatch", async () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    const callId = "call-plan-review";
    const childSessionId = "ses-plan-review-child";
    const agentId = "agent-plan-review";
    const args = {
      subagent_type: "harness-plan-reviewer",
      prompt: "Review the exact canonical plan and return the schema.",
      description: "plan review",
    };
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: callId, args });
    assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: callId, input: args }, ctxOf(f.root)), undefined);
    events.emit("subagents:child:session-created", { sessionId: childSessionId, parentSessionId: SESSION });
    const body = '{"verdict":"APPROVE","findings":[]}';
    const unpublish = publishNativeRecord({ agentId, role: "harness-plan-reviewer", body });
    h.get("tool_execution_end")({
      toolName: "subagent",
      toolCallId: callId,
      result: wrappedReviewResult(agentId, body),
      isError: false,
    }, ctxOf(f.root));
    unpublish();

    const state = JSON.parse(readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"));
    assert.deepEqual(state.plan_review_evidence, {
      written_by: "host-subagent-completion",
      parent_session_id: SESSION,
      feature_id: FEATURE,
      role: "harness-plan-reviewer",
      dispatch_call_id: callId,
      child_session_id: childSessionId,
      agent_id: agentId,
      status: "completed",
      plan_sha256: createHash("sha256").update(readFileSync(join(f.root, ".pi", "harness", "plans", FEATURE, "execution-plan.json"))).digest("hex"),
      spec_sha256: createHash("sha256").update(readFileSync(join(f.root, ".pi", "harness", "plans", FEATURE, "spec.md"))).digest("hex"),
      verdict: "APPROVE",
    });
  } finally { f.close(); }
});

test("plan-reviewer não aprova quando plano muda durante a execução", async () => {
  const f = fixture();
  try {
    const events = fakeEvents();
    const h = handlers(events);
    const callId = "call-plan-review-drift";
    const args = { subagent_type: "harness-plan-reviewer", prompt: "Review exact plan.", description: "plan review" };
    h.get("session_start")({}, ctxOf(f.root));
    h.get("tool_execution_start")({ toolName: "subagent", toolCallId: callId, args });
    assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: callId, input: args }, ctxOf(f.root)), undefined);
    events.emit("subagents:child:session-created", { sessionId: "ses-plan-drift", parentSessionId: SESSION });
    writeFileSync(join(f.root, ".pi", "harness", "plans", FEATURE, "execution-plan.json"), `${readFileSync(join(f.root, ".pi", "harness", "plans", FEATURE, "execution-plan.json"), "utf8")}\n`);
    const body = '{"verdict":"APPROVE","findings":[]}';
    const unpublish = publishNativeRecord({ agentId: "agent-plan-drift", role: "harness-plan-reviewer", body });
    h.get("tool_execution_end")({
      toolName: "subagent", toolCallId: callId,
      result: wrappedReviewResult("agent-plan-drift", body), isError: false,
    }, ctxOf(f.root));
    unpublish();
    const state = JSON.parse(readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"));
    assert.equal(state.plan_review_evidence, null);
  } finally { f.close(); }
});

test("veredito textual do plan-reviewer não se transforma em recibo de aprovação", async (t) => {
  for (const body of ["## Verdict: APPROVE\n\nBlocking corrections: none", "APPROVE"]) {
    await t.test(body.split("\n")[0], async () => {
      const f = fixture();
      try {
        const events = fakeEvents();
        const h = handlers(events);
        const callId = "call-plan-review-text";
        const agentId = "agent-plan-review-text";
        const args = { subagent_type: "harness-plan-reviewer", prompt: "Review exact plan.", description: "plan review" };
        h.get("session_start")({}, ctxOf(f.root));
        h.get("tool_execution_start")({ toolName: "subagent", toolCallId: callId, args });
        assert.equal(await h.get("tool_call")({ toolName: "subagent", toolCallId: callId, input: args }, ctxOf(f.root)), undefined);
        events.emit("subagents:child:session-created", { sessionId: "ses-plan-review-text", parentSessionId: SESSION });
        const unpublish = publishNativeRecord({ agentId, role: "harness-plan-reviewer", body });
        try {
          h.get("tool_execution_end")({
            toolName: "subagent", toolCallId: callId,
            result: wrappedReviewResult(agentId, body), isError: false,
          }, ctxOf(f.root));
        } finally { unpublish(); }
        const state = JSON.parse(readFileSync(join(f.root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"));
        assert.equal(state.plan_review_evidence, null);
      } finally { f.close(); }
    });
  }
});
