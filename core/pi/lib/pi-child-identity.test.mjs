import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  piChildIdentityPath,
  readPiChildIdentity,
  removePiChildIdentity,
  writePiChildIdentity,
} from "./pi-child-identity.mjs";

const PARENT = "ses_parent01";
const CHILD = "ses_child001";

/** @description Cria uma raiz de projeto temporária já canonicalizada (macOS: /tmp é symlink). */
function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-identity-"));
  const root = fs.realpathSync(dir);
  fs.mkdirSync(path.join(root, ".pi/harness/state"), { recursive: true });
  return root;
}

test("grava e recupera o papel da sessão filha pelo sessionId dela", () => {
  const root = makeRoot();
  const written = writePiChildIdentity(root, {
    parentSessionId: PARENT,
    childSessionId: CHILD,
    role: "harness-planner",
    callId: "call-1",
  });
  assert.equal(written.ok, true);
  assert.equal(
    written.path,
    piChildIdentityPath(root, PARENT, CHILD).path,
    "o caminho gravado é o caminho canônico da filha",
  );

  const read = readPiChildIdentity(root, CHILD);
  assert.equal(read.ok, true);
  assert.equal(read.record.role, "harness-planner");
  assert.equal(read.record.parent_session_id, PARENT);
  assert.equal(read.record.dispatch_call_id, "call-1");
});

test("regravar o mesmo dispatch é idempotente e um papel divergente é conflito", () => {
  const root = makeRoot();
  const args = { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-executor", callId: "call-1" };
  assert.equal(writePiChildIdentity(root, args).ok, true);
  assert.equal(writePiChildIdentity(root, args).ok, true);

  const hijack = writePiChildIdentity(root, { ...args, role: "harness-planner" });
  assert.equal(hijack.ok, false);
  assert.equal(hijack.conflict, true);
  assert.equal(readPiChildIdentity(root, CHILD).record.role, "harness-executor");
});

test("identidade rejeita papel não canônico, sessão insegura e pai igual à filha", () => {
  const root = makeRoot();
  for (const args of [
    { parentSessionId: PARENT, childSessionId: CHILD, role: "planner", callId: "c" },
    { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-unknown", callId: "c" },
    { parentSessionId: PARENT, childSessionId: "../escape", role: "harness-planner", callId: "c" },
    { parentSessionId: "a/b", childSessionId: CHILD, role: "harness-planner", callId: "c" },
    { parentSessionId: PARENT, childSessionId: PARENT, role: "harness-planner", callId: "c" },
    { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-planner", callId: "" },
  ]) {
    assert.equal(writePiChildIdentity(root, args).ok, false, JSON.stringify(args));
  }
  assert.equal(readPiChildIdentity(root, CHILD).absent, true);
});

test("filha sem registro é ausente, e ausência nunca vira conflito", () => {
  const root = makeRoot();
  const read = readPiChildIdentity(root, CHILD);
  assert.equal(read.ok, false);
  assert.equal(read.absent, true);
  assert.notEqual(read.conflict, true);
});

test("dois pais reivindicando a mesma filha é conflito fail-closed", () => {
  const root = makeRoot();
  assert.equal(
    writePiChildIdentity(root, { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-planner", callId: "c1" }).ok,
    true,
  );
  const other = "ses_parent02";
  const forged = piChildIdentityPath(root, other, CHILD);
  fs.mkdirSync(path.dirname(forged.path), { recursive: true });
  fs.writeFileSync(
    forged.path,
    JSON.stringify({
      parent_session_id: other,
      child_session_id: CHILD,
      dispatch_call_id: "c2",
      role: "harness-executor",
      created_at: new Date(0).toISOString(),
    }),
  );

  const read = readPiChildIdentity(root, CHILD);
  assert.equal(read.ok, false);
  assert.equal(read.conflict, true);
});

test("nome de arquivo que não é o sha256 da filha nunca é adotado", () => {
  const root = makeRoot();
  const dir = path.join(root, ".pi/harness/state", PARENT, "child-identity");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "deadbeef.json"),
    JSON.stringify({
      parent_session_id: PARENT,
      child_session_id: CHILD,
      dispatch_call_id: "c",
      role: "harness-planner",
      created_at: new Date(0).toISOString(),
    }),
  );

  assert.equal(readPiChildIdentity(root, CHILD).absent, true);
});

test("registro cujo parent_session_id discorda do diretório é conflito", () => {
  const root = makeRoot();
  const resolved = piChildIdentityPath(root, PARENT, CHILD);
  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  fs.writeFileSync(
    resolved.path,
    JSON.stringify({
      parent_session_id: "ses_parent99",
      child_session_id: CHILD,
      dispatch_call_id: "c",
      role: "harness-planner",
      created_at: new Date(0).toISOString(),
    }),
  );

  assert.equal(readPiChildIdentity(root, CHILD).conflict, true);
});

test("JSON corrompido é conflito, nunca ausência silenciosa", () => {
  const root = makeRoot();
  const resolved = piChildIdentityPath(root, PARENT, CHILD);
  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  fs.writeFileSync(resolved.path, "{ not json");

  const read = readPiChildIdentity(root, CHILD);
  assert.equal(read.ok, false);
  assert.equal(read.conflict, true);
});

test("remoção apaga só o registro exato e é idempotente", () => {
  const root = makeRoot();
  writePiChildIdentity(root, { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-sniper", callId: "c" });

  assert.deepEqual(removePiChildIdentity(root, { parentSessionId: PARENT, childSessionId: CHILD }), { ok: true, removed: true });
  assert.deepEqual(removePiChildIdentity(root, { parentSessionId: PARENT, childSessionId: CHILD }), { ok: true, removed: false });
  assert.equal(readPiChildIdentity(root, CHILD).absent, true);
});

test("raiz de projeto ilegível nunca lança", () => {
  const missing = path.join(os.tmpdir(), "pi-child-identity-absent-root");
  assert.equal(writePiChildIdentity(missing, { parentSessionId: PARENT, childSessionId: CHILD, role: "harness-planner", callId: "c" }).ok, false);
  assert.equal(readPiChildIdentity(missing, CHILD).ok, false);
});
