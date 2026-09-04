/**
 * @description Testes travados do adaptador Pi harness-version-check — espelham os casos de
 * `createVersionCheck` em core/opencode/plugin/version-check.test.mjs no contrato do Pi:
 * `session_start` entrega a advertência por UM canal (`ctx.ui.notify` com UI, `console.warn`
 * sem UI), nunca bloqueia e é fail-open em toda falha. Sessão filha (subagente) fica muda.
 */
import test from "node:test";
import assert from "node:assert/strict";

import harnessVersionCheck from "./harness-version-check.ts";

/** @description Registra a extensão contra um fake de ExtensionAPI e devolve o handler session_start. */
function captureSessionStartHandler(deps) {
  let handler;
  const fakePi = {
    on(eventName, fn) {
      if (eventName === "session_start") handler = fn;
    },
  };
  harnessVersionCheck(fakePi, deps);
  assert.equal(typeof handler, "function", "a extensão precisa registrar session_start");
  return handler;
}

/** @description ctx mínimo do Pi: cwd, hasUI, ui.notify e sessionManager.getHeader(). */
function makeCtx({ cwd = "/project", hasUI = false, parentSession, notify } = {}) {
  return {
    cwd,
    hasUI,
    ui: { notify: notify ?? (() => {}) },
    sessionManager: { getHeader: () => (parentSession ? { parentSession } : {}) },
  };
}

const STALE_DEPS = {
  readLocalVersion: () => "v0.49.0",
  fetchRemoteTag: () => "v0.49.8",
  readCache: () => null,
  writeCache: () => {},
  nowMs: () => 0,
};

test("entrega a advertência de staleness por ui.notify('warning') quando há UI", async () => {
  const notified = [];
  const handler = captureSessionStartHandler(STALE_DEPS);
  await handler({ reason: "startup" }, makeCtx({ hasUI: true, notify: (m, level) => notified.push([m, level]) }));
  assert.equal(notified.length, 1);
  assert.match(notified[0][0], /v0\.49\.0.*v0\.49\.8/);
  assert.equal(notified[0][1], "warning");
});

test("sem UI (print/json) entrega por console.warn — e nunca pelos dois canais ao mesmo tempo", async () => {
  const notified = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const handler = captureSessionStartHandler(STALE_DEPS);
    await handler({ reason: "startup" }, makeCtx({ hasUI: false, notify: (m) => notified.push(m) }));
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(notified, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /v0\.49\.0.*v0\.49\.8/);
});

test("um notify que lança cai para console.warn — a advertência nunca some", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const handler = captureSessionStartHandler(STALE_DEPS);
    await handler({ reason: "startup" }, makeCtx({
      hasUI: true,
      notify: () => { throw new Error("canal de UI indisponível"); },
    }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /v0\.49\.0.*v0\.49\.8/);
});

test("fica em silêncio quando o carimbo já está atualizado", async () => {
  const notified = [];
  const handler = captureSessionStartHandler({ ...STALE_DEPS, readLocalVersion: () => "v0.49.8" });
  await handler({ reason: "startup" }, makeCtx({ hasUI: true, notify: (m) => notified.push(m) }));
  assert.deepEqual(notified, []);
});

test("nunca lança e nunca adverte quando gh/rede está indisponível", async () => {
  const notified = [];
  const handler = captureSessionStartHandler({ ...STALE_DEPS, fetchRemoteTag: () => null });
  await assert.doesNotReject(handler({ reason: "startup" }, makeCtx({ hasUI: true, notify: (m) => notified.push(m) })));
  assert.deepEqual(notified, []);
});

test("fica em silêncio quando não há carimbo vendorizado — e não chama fetch", async () => {
  const notified = [];
  let fetchCalls = 0;
  const handler = captureSessionStartHandler({
    readLocalVersion: () => null,
    fetchRemoteTag: () => { fetchCalls++; return "v0.49.8"; },
  });
  await handler({ reason: "startup" }, makeCtx({ hasUI: true, notify: (m) => notified.push(m) }));
  assert.deepEqual(notified, []);
  assert.equal(fetchCalls, 0);
});

test("sessão filha (subagente) fica muda — não lê carimbo nem adverte", async () => {
  const notified = [];
  let localReads = 0;
  const handler = captureSessionStartHandler({
    ...STALE_DEPS,
    readLocalVersion: () => { localReads++; return "v0.49.0"; },
  });
  await handler(
    { reason: "startup" },
    makeCtx({ hasUI: true, parentSession: "parent-uuid", notify: (m) => notified.push(m) }),
  );
  assert.deepEqual(notified, []);
  assert.equal(localReads, 0);
});

test("fail-open num ctx quebrado — session_start nunca rejeita nem bloqueia", async () => {
  const handler = captureSessionStartHandler(STALE_DEPS);
  await assert.doesNotReject(handler({ reason: "startup" }, {}));
  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await handler({ reason: "startup" }, makeCtx({ hasUI: false, notify: () => {} }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(result, undefined, "session_start é advisório: nunca devolve bloqueio");
});
