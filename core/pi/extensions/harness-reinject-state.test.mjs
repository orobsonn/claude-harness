/**
 * @description Testes travados do adaptador Pi harness-reinject-state. A decisão pura mora em
 * `core/pi/lib/session-state.mjs` (testada lá); aqui trava-se o contrato de host que a lane OC
 * resolve num único hook (`experimental.session.compacting` + `output.context.push`) e que no Pi
 * precisa de três eventos: `session_before_compact` (só marca o pendente, NUNCA cancela nem
 * substitui o resumo), `session_compact` (envia o pendente) e `before_agent_start` (fallback de
 * uma única vez). Cobre ainda o descarte em `session_compact_failed` e o no-op em sessão filha.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import harnessReinjectState from "./harness-reinject-state.ts";

const SESSION = "ses-stable-recovery";
const FEATURE = "stable-recovery";

/** @description Registra a extensão contra um fake de ExtensionAPI e devolve hooks + espião de envio. */
function register({ sendMessage } = {}) {
  const handlers = {};
  const sent = [];
  const fakePi = {
    on(eventName, fn) {
      handlers[eventName] = fn;
    },
    async sendMessage(message, options) {
      sent.push({ message, options });
      if (sendMessage === "reject") throw new Error("envio recusado");
    },
  };
  harnessReinjectState(fakePi);
  for (const name of ["session_before_compact", "session_compact", "session_compact_failed", "before_agent_start"]) {
    assert.equal(typeof handlers[name], "function", `harness-reinject-state deve registrar ${name}`);
  }
  return { handlers, sent };
}

/** @description projectRoot temporário com gate-state válido desta sessão (sem plano no disco). */
function fixture({ state } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-reinject-ext-")));
  const statePath = path.join(root, ".pi", "harness", "state", SESSION, "gate-state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify(state ?? { session_id: SESSION, feature_id: FEATURE, mode: "FULL", classified: true }),
  );
  return { root, statePath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const ctxFor = (root, header = {}) => ({
  cwd: root,
  sessionManager: { getSessionId: () => SESSION, getHeader: () => header },
});

test("compactação bem-sucedida envia o envelope como nextTurn e não repete no fallback", async () => {
  const f = fixture();
  const { handlers, sent } = register();
  try {
    const ctx = ctxFor(f.root);
    // Nunca cancela nem substitui o resumo do modelo.
    assert.equal(await handlers.session_before_compact({ reason: "threshold" }, ctx), undefined);
    await handlers.session_compact({ reason: "threshold" }, ctx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.customType, "harness-recovery");
    assert.equal(sent[0].message.display, true);
    assert.deepEqual(sent[0].options, { deliverAs: "nextTurn" });
    assert.ok(sent[0].message.content.startsWith("<HARNESS_RECOVERY_JSON>\n"));
    assert.equal(JSON.parse(sent[0].message.content.split("\n")[1]).feature_id, FEATURE);
    // Já entregue: o fallback não pode injetar de novo.
    assert.equal(await handlers.before_agent_start({ prompt: "oi" }, ctx), undefined);
  } finally {
    f.cleanup();
  }
});

test("envio falho cai no fallback de before_agent_start — o MESMO texto, uma única vez", async () => {
  const f = fixture();
  const { handlers, sent } = register({ sendMessage: "reject" });
  try {
    const ctx = ctxFor(f.root);
    await handlers.session_before_compact({ reason: "manual" }, ctx);
    await handlers.session_compact({ reason: "manual" }, ctx);
    const injected = await handlers.before_agent_start({ prompt: "oi" }, ctx);
    assert.equal(injected.message.customType, "harness-recovery");
    assert.equal(injected.message.display, true);
    assert.equal(injected.message.content, sent[0].message.content);
    assert.equal(await handlers.before_agent_start({ prompt: "de novo" }, ctx), undefined);
  } finally {
    f.cleanup();
  }
});

test("compactação falha ou cancelada descarta o pendente — nada é reinjetado", async () => {
  const f = fixture();
  const { handlers } = register({ sendMessage: "reject" });
  try {
    const ctx = ctxFor(f.root);
    await handlers.session_before_compact({ reason: "overflow" }, ctx);
    await handlers.session_compact_failed({ reason: "overflow", aborted: true }, ctx);
    assert.equal(await handlers.before_agent_start({ prompt: "oi" }, ctx), undefined);
  } finally {
    f.cleanup();
  }
});

test("sessão filha é no-op: não arma, não envia e não consome o pendente do pai", async () => {
  const f = fixture();
  const { handlers, sent } = register({ sendMessage: "reject" });
  try {
    const parent = ctxFor(f.root);
    const child = ctxFor(f.root, { parentSession: "ses-pai" });

    // Filha sozinha não arma nada.
    await handlers.session_before_compact({ reason: "threshold" }, child);
    await handlers.session_compact({ reason: "threshold" }, child);
    assert.equal(sent.length, 0);
    assert.equal(await handlers.before_agent_start({ prompt: "oi" }, child), undefined);

    // Com o pendente do pai armado, os hooks da filha não podem roubá-lo nem limpá-lo.
    await handlers.session_before_compact({ reason: "threshold" }, parent);
    await handlers.session_compact({ reason: "threshold" }, parent);
    assert.equal(sent.length, 1);
    assert.equal(await handlers.before_agent_start({ prompt: "oi" }, child), undefined);
    await handlers.session_compact_failed({ reason: "threshold" }, child);
    const injected = await handlers.before_agent_start({ prompt: "oi" }, parent);
    assert.equal(injected.message.content, sent[0].message.content);
  } finally {
    f.cleanup();
  }
});

test("estado ausente ou de outra sessão não arma nada e nunca lança", async () => {
  for (const state of [null, { session_id: "ses-outra", feature_id: FEATURE, mode: "FULL" }]) {
    const f = state ? fixture({ state }) : { root: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-reinject-vazio-"))), cleanup() { fs.rmSync(this.root, { recursive: true, force: true }); } };
    const { handlers, sent } = register();
    try {
      const ctx = ctxFor(f.root);
      await handlers.session_before_compact({ reason: "threshold" }, ctx);
      await handlers.session_compact({ reason: "threshold" }, ctx);
      assert.equal(sent.length, 0);
      assert.equal(await handlers.before_agent_start({ prompt: "oi" }, ctx), undefined);
    } finally {
      f.cleanup();
    }
  }
});

test("contexto quebrado não derruba a compactação — fail-open", async () => {
  const { handlers, sent } = register();
  const broken = { cwd: undefined, sessionManager: { getSessionId() { throw new Error("sem sessão"); }, getHeader: () => ({}) } };
  await handlers.session_before_compact({ reason: "threshold" }, broken);
  await handlers.session_compact({ reason: "threshold" }, broken);
  assert.equal(sent.length, 0);
  assert.equal(await handlers.before_agent_start({ prompt: "oi" }, broken), undefined);
});
