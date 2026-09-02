/** @description Testes de gate-state da lane Pi: espelha core/opencode/lib/gate-state.test.mjs
 * (seção loadGateStateFromDisk) para loadPiGateStateFromDisk, e cobre reuso de mergeGateState
 * sob lock gravando em `.pi/harness/state/<sessionId>/gate-state.json`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadPiGateStateFromDisk,
  mergeGateState,
  readGateState,
  isSafeSessionIdSegment,
} from "./pi-gate-state.mjs";

/**
 * @description Executa fn com um projectRoot temporário, garantindo limpeza mesmo em erro.
 * @param {(root: string) => void | Promise<void>} fn
 */
async function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gate-state-"));
  try {
    await fn(root);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors on some FS */
    }
  }
}

// ---------------------------------------------------------------------------
// loadPiGateStateFromDisk — ramos fail-open / fail-closed
// ---------------------------------------------------------------------------

test("loadPiGateStateFromDisk: arquivo ausente => ok:true, state:{}, path sob .pi/harness/state/", async () => {
  await withTempRoot((root) => {
    const sessionId = "ses_pi_missingfile01";
    const r = loadPiGateStateFromDisk(root, { sessionId });
    assert.equal(r.ok, true);
    assert.deepEqual(r.state, {});
    assert.match(r.path, /\.pi[/\\]harness[/\\]state[/\\]/);
    assert.match(r.path, new RegExp(sessionId));
  });
});

test("loadPiGateStateFromDisk: le arquivo real gravado sob .pi/harness/state/<sessionId>/gate-state.json", async () => {
  await withTempRoot((root) => {
    const sessionId = "ses_pi_testDual123";
    const stateDir = path.join(root, ".pi", "harness", "state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({ mode: "delivery", feature_id: "pi-port-phase-1", classified: true }),
      "utf8",
    );

    const r = loadPiGateStateFromDisk(root, { sessionId });
    assert.equal(r.ok, true, !r.ok ? String(r.reason) : "session ok");
    if (r.ok) {
      assert.equal(/** @type {{ mode: string }} */ (r.state).mode, "delivery");
    }
  });
});

test("loadPiGateStateFromDisk: JSON não-objeto => ok:false, reason com prefixo 'gate-state invalid JSON object'", async () => {
  await withTempRoot((root) => {
    const sessionId = "ses_pi_badjson01";
    const stateDir = path.join(root, ".pi", "harness", "state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify([1, 2, 3]), "utf8");

    const r = loadPiGateStateFromDisk(root, { sessionId });
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /^gate-state invalid JSON object at /);
  });
});

test("isSafeSessionIdSegment (reusado) aceita session id do Pi e rejeita traversal/separador", async () => {
  assert.equal(isSafeSessionIdSegment("ses_testDual123"), true);
  // UUID do Pi (ctx.sessionManager.getSessionId()) satisfaz SAFE_SESSION_ID.
  assert.equal(isSafeSessionIdSegment("0b9a1f6e-4c2d-4a17-9f31-2b8e5d7c1a44"), true);
  assert.equal(isSafeSessionIdSegment("../evil"), false);
  assert.equal(isSafeSessionIdSegment("a/b"), false);
  assert.equal(isSafeSessionIdSegment(""), false);
});

test("loadPiGateStateFromDisk: JSON malformado => reason com prefixo 'gate-state-unreadable' (paridade OC)", async () => {
  await withTempRoot((root) => {
    const sessionId = "ses_pi_malformed01";
    const stateDir = path.join(root, ".pi", "harness", "state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), "{ not json", "utf8");

    const r = loadPiGateStateFromDisk(root, { sessionId });
    assert.equal(r.ok, false);
    // OC captura o throw do JSON.parse no MESMO catch da leitura => 'gate-state-unreadable: <msg>'.
    assert.match(String(r.reason), /^gate-state-unreadable: /);
  });
});

test("loadPiGateStateFromDisk: projectRoot vazio cai para process.cwd() (nunca 'projectRoot missing')", async () => {
  const r = loadPiGateStateFromDisk("", { sessionId: "ses_pi_fallback01" });
  // Espelha o teste OC 'falls back to cwd when projectRoot empty': jamais reason de projectRoot.
  assert.equal(r.ok === false && /projectRoot/.test(String(r.reason)), false);
  assert.equal(r.ok, true);
  assert.match(String(r.path), /\.pi[/\\]harness[/\\]state[/\\]ses_pi_fallback01[/\\]gate-state\.json$/);

  const r2 = loadPiGateStateFromDisk(undefined, { sessionId: "ses_pi_fallback01" });
  assert.equal(r2.ok, true);
});

test("loadPiGateStateFromDisk: sessionId ausente/null/vazio => ok:false, reason contém 'sessionId'", async () => {
  await withTempRoot((root) => {
    const r1 = loadPiGateStateFromDisk(root);
    assert.equal(r1.ok, false);
    assert.match(String(r1.reason), /sessionId/);

    const r2 = loadPiGateStateFromDisk(root, {});
    assert.equal(r2.ok, false);
    assert.match(String(r2.reason), /sessionId/);

    const r3 = loadPiGateStateFromDisk(root, { sessionId: null });
    assert.equal(r3.ok, false);
    assert.match(String(r3.reason), /sessionId/);

    const r4 = loadPiGateStateFromDisk(root, { sessionId: "" });
    assert.equal(r4.ok, false);
    assert.match(String(r4.reason), /sessionId/);
  });
});

test("loadPiGateStateFromDisk: sessionId inseguro ('../evil') => ok:false, reason 'unsafe sessionId'", async () => {
  await withTempRoot((root) => {
    const r = loadPiGateStateFromDisk(root, { sessionId: "../evil" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unsafe sessionId");
    assert.equal(isSafeSessionIdSegment("../evil"), false);
  });
});

test("loadPiGateStateFromDisk: reason de leitura corrompida usa prefixo 'gate-state-unreadable'", async () => {
  await withTempRoot((root) => {
    const sessionId = "ses_pi_unreadable01";
    const stateDir = path.join(root, ".pi", "harness", "state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    const p = path.join(stateDir, "gate-state.json");
    // Diretório no lugar do arquivo força erro de leitura (EISDIR), nunca JSON inválido.
    fs.mkdirSync(p);

    const r = loadPiGateStateFromDisk(root, { sessionId });
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /^gate-state-unreadable/);
  });
});

// ---------------------------------------------------------------------------
// mergeGateState (reuso por import de core/opencode/lib/gate-state.mjs) sob raiz Pi
// ---------------------------------------------------------------------------

test("mergeGateState (reusado) grava sob .pi/harness/state/<sessionId>/gate-state.json com lock", async () => {
  await withTempRoot((root) => {
    const sessionId = "ses_pi_merge01";
    const statePath = path.join(root, ".pi", "harness", "state", sessionId, "gate-state.json");

    const first = mergeGateState(statePath, { mode: "delivery", classified: true });
    assert.equal(first.ok, true, first.ok ? "" : String(first.reason));
    assert.equal(readGateState(statePath).classified, true);

    const second = mergeGateState(statePath, { triaged: true });
    assert.equal(second.ok, true, second.ok ? "" : String(second.reason));
    const onDisk = readGateState(statePath);
    assert.equal(onDisk.mode, "delivery");
    assert.equal(onDisk.classified, true);
    assert.equal(onDisk.triaged, true);

    // dual_completed continua proibido (regra herdada de gate-state-shape, sem cópia).
    const rejected = mergeGateState(statePath, { dual_completed: true });
    assert.equal(rejected.ok, false);
    assert.match(String(rejected.reason), /dual_completed/);

    // Confirma que o arquivo de fato ficou fora de .opencode — raiz Pi isolada.
    assert.equal(fs.existsSync(path.join(root, ".opencode")), false);
  });
});
