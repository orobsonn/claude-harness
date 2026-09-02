/**
 * @description Testes travados do ADAPTADOR Pi do plan-write-gate (as decisões puras vivem em
 * core/pi/lib/plan-write-decide.test.mjs). O que só existe aqui é a costura de identidade: no
 * OpenCode a autoridade de autoria do plano vem do SDK (`session.agent === 'planner'`); no Pi ela
 * vem do registro durável de core/pi/lib/pi-child-identity.mjs, gravado pelo adaptador do
 * entry-gate. Estes casos provam que essa autoridade é SATISFAZÍVEL (um planner realmente
 * escreve o plano canônico) e que ela não vaza para nenhum outro alvo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import harnessPlanWriteGate from "./harness-plan-write-gate.ts";
import { piChildIdentityPath, writePiChildIdentity } from "../lib/pi-child-identity.mjs";

const PARENT = "ses-pi-parent";
const CHILD = "ses-pi-child";
const FEATURE = "feat-plan-write";

/** @description Registra a extensão e devolve o handler de `tool_call`. */
function toolCallHandler() {
  let handler;
  harnessPlanWriteGate({ on: (name, fn) => { if (name === "tool_call") handler = fn; } });
  assert.equal(typeof handler, "function");
  return handler;
}

/** @description Projeto temporário com a raiz de estado do harness já criada. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-plan-write-gate-")));
  mkdirSync(join(root, ".pi", "harness", "state"), { recursive: true });
  mkdirSync(join(root, ".pi", "harness", "plans", FEATURE), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** @description ctx do Pi; `child` liga o header parentSession que marca sessão filha. */
function ctxOf(cwd, { child = false } = {}) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => (child ? CHILD : PARENT),
      getHeader: () => (child ? { parentSession: PARENT } : {}),
    },
  };
}

const planPathOf = (root) => join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json");

test("filha com identidade de planner escreve o plano canônico", () => {
  const f = fixture();
  try {
    assert.equal(
      writePiChildIdentity(f.root, { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-planner", callId: "c1" }).ok,
      true,
    );
    const decision = toolCallHandler()(
      { toolName: "write", toolCallId: "w1", input: { path: planPathOf(f.root) } },
      ctxOf(f.root, { child: true }),
    );

    assert.equal(decision, undefined, "a autoridade de planner da lane Pi precisa ser satisfazível");
  } finally {
    f.close();
  }
});

test("a mesma identidade de planner não autoriza nenhum outro alvo", () => {
  const f = fixture();
  try {
    writePiChildIdentity(f.root, { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-planner", callId: "c1" });
    const decision = toolCallHandler()(
      { toolName: "write", toolCallId: "w2", input: { path: join(f.root, "src", "app.ts") } },
      ctxOf(f.root, { child: true }),
    );

    assert.equal(decision.block, true);
    assert.equal(
      decision.reason,
      "[plan-write-gate] Blocked: planner may author only canonical execution plans.",
    );
  } finally {
    f.close();
  }
});

test("sem identidade provada o plano canônico continua negado", () => {
  const f = fixture();
  try {
    const decision = toolCallHandler()(
      { toolName: "write", toolCallId: "w3", input: { path: planPathOf(f.root) } },
      ctxOf(f.root, { child: true }),
    );

    assert.equal(decision.block, true);
    assert.match(decision.reason, /^\[plan-write-gate\] Blocked: official planner identity required \(/);
  } finally {
    f.close();
  }
});

test("a sessão PAI nunca escreve o plano canônico, mesmo com um planner ligado", () => {
  const f = fixture();
  try {
    writePiChildIdentity(f.root, { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-planner", callId: "c1" });
    const decision = toolCallHandler()(
      { toolName: "write", toolCallId: "w4", input: { path: planPathOf(f.root) } },
      ctxOf(f.root),
    );

    assert.equal(decision.block, true);
    assert.match(decision.reason, /official planner identity required/);
  } finally {
    f.close();
  }
});

test("identidade ambígua é fail-closed com a frase do gate da lane OC", () => {
  const f = fixture();
  try {
    writePiChildIdentity(f.root, { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-planner", callId: "c1" });
    const other = "ses-pi-parent2";
    const forged = piChildIdentityPath(f.root, other, CHILD);
    mkdirSync(join(f.root, ".pi", "harness", "state", other, "child-identity"), { recursive: true });
    writeFileSync(
      forged.path,
      JSON.stringify({
        parent_session_id: other,
        child_session_id: CHILD,
        dispatch_call_id: "c2",
        role: "harness-executor",
        created_at: new Date(0).toISOString(),
      }),
    );

    const decision = toolCallHandler()(
      { toolName: "write", toolCallId: "w5", input: { path: join(f.root, "src", "app.ts") } },
      ctxOf(f.root, { child: true }),
    );

    assert.equal(decision.block, true);
    assert.match(decision.reason, /^\[plan-write-gate\] Blocked: trusted writing-hand identity conflicts \(/);
  } finally {
    f.close();
  }
});

test("escrita sem caminho parseável é negada com a frase do gate da OC", () => {
  const f = fixture();
  try {
    const decision = toolCallHandler()({ toolName: "write", toolCallId: "w6", input: {} }, ctxOf(f.root, { child: true }));

    assert.equal(decision.block, true);
    assert.equal(
      decision.reason,
      "[plan-write-gate] Blocked: official write/patch tool exposed no parseable target paths.",
    );
  } finally {
    f.close();
  }
});

test("bash roda só a fricção literal: muta estado do harness → deny; leitura → passa", () => {
  const f = fixture();
  try {
    const handler = toolCallHandler();
    const denied = handler(
      { toolName: "bash", toolCallId: "b1", input: { command: "echo x > .pi/harness/state/ses/gate-state.json" } },
      ctxOf(f.root),
    );
    assert.equal(denied.block, true);
    assert.match(denied.reason, /anti-forge rail/);

    assert.equal(
      handler({ toolName: "bash", toolCallId: "b2", input: { command: "cat .pi/harness/state/ses/gate-state.json" } }, ctxOf(f.root)),
      undefined,
    );
  } finally {
    f.close();
  }
});

test("gate-state.json nunca é escrito por write/edit, nem por uma filha com identidade", () => {
  const f = fixture();
  try {
    writePiChildIdentity(f.root, { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-executor", callId: "c1" });
    const decision = toolCallHandler()(
      { toolName: "write", toolCallId: "w7", input: { path: join(f.root, ".pi", "harness", "state", PARENT, "gate-state.json") } },
      ctxOf(f.root, { child: true }),
    );

    assert.equal(decision.block, true);
    assert.match(decision.reason, /written ONLY by harness markers/);
  } finally {
    f.close();
  }
});
