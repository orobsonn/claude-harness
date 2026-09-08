/**
 * @description Identidade de sessão FILHA na lane Pi — o equivalente ao sinal que o SDK do
 * OpenCode entrega de graça (`session.agent === 'planner'`) e que o Pi 0.84.4 NÃO tem: o
 * `SessionHeader` da filha carrega só `parentSession` (dist/core/session-manager.d.ts), nunca o
 * nome do agente.
 *
 * O sinal existe, mas do lado do PAI: o pi-subagents publica no barramento de eventos do Pi
 * `subagents:child:session-created` com `{sessionId, parentSessionId}`, SÍNCRONO e ANTES de
 * ligar as extensões da filha (node_modules/@gotgenes/pi-subagents/src/lifecycle/child-lifecycle.ts
 * e create-subagent-session.ts). O adaptador do entry-gate, que já sabe qual papel está sendo
 * despachado (args da tool `subagent` do turno em voo), grava aqui esse par — papel ↔ sessão
 * filha — num arquivo do harness. A filha depois lê a PRÓPRIA identidade por `sessionId`.
 *
 * Por que um registro separado do dispatch-record: o dispatch-record só existe para mão que
 * escreve (executor/sniper/test-author) e seu escopo é derivado do plano estável — um planner,
 * cujo trabalho é justamente CRIAR o plano, nunca poderia ter um. Sem este registro a autoridade
 * de autoria do plano canônico na lane Pi ficava insatisfazível: `resolvePiPlannerIdentity`
 * negava toda escrita em `.pi/harness/plans/<feature>/execution-plan.json`, para sempre.
 *
 * O modelo nunca escreve estes arquivos: eles ficam sob `.pi/harness/state/`, negado a Write/Edit
 * pelo plan-write-gate e à fricção literal de Bash pelo mesmo rail.
 *
 * Escrita atômica (tmp + rename, 0600). Nenhuma função lança.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isSafeSessionId } from "../vendor/shared/lib/feature-id.mjs";
import { isRuntimeRole } from "./roles.mjs";
import { piStateRoot } from "./pi-paths.mjs";

/** @description True quando candidate está dentro de root (sem traversal). @param {string} root @param {string} candidate */
function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** @description Sobe até o primeiro ancestral existente do candidato; null quando nenhum existe. @param {string} candidate */
function nearestExistingPath(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

/** @description Canonicaliza o alvo sob a raiz real, rejeitando fuga por symlink. @param {string} realRoot @param {string} candidate @param {string} reason */
function canonicalTarget(realRoot, candidate, reason) {
  const existing = nearestExistingPath(candidate);
  if (!existing) return { ok: false, reason };
  let realExisting;
  try { realExisting = fs.realpathSync(existing); } catch { return { ok: false, reason }; }
  if (!inside(realRoot, realExisting)) return { ok: false, reason };
  const canonical = path.resolve(realExisting, path.relative(existing, candidate));
  if (!inside(realRoot, canonical)) return { ok: false, reason };
  return { ok: true, path: canonical };
}

/** @description Nome de arquivo do registro: sha256 do sessionId da filha. @param {string} childSessionId */
function childDigest(childSessionId) {
  return `${crypto.createHash("sha256").update(childSessionId).digest("hex")}.json`;
}

/**
 * @description Caminho exato do registro de identidade da filha:
 * `.pi/harness/state/<parentSessionId>/child-identity/<sha256(childSessionId)>.json`.
 * @param {string} projectRoot
 * @param {unknown} parentSessionId
 * @param {unknown} childSessionId
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function piChildIdentityPath(projectRoot, parentSessionId, childSessionId) {
  if (!isSafeSessionId(parentSessionId) || !isSafeSessionId(childSessionId)) {
    return { ok: false, reason: "exact parent and child session required" };
  }
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "project root unreadable" }; }
  const stateRoot = piStateRoot(realRoot);
  if (!stateRoot.ok) return { ok: false, reason: "project root unreadable" };
  return canonicalTarget(
    realRoot,
    path.join(stateRoot.path, parentSessionId, "child-identity", childDigest(childSessionId)),
    "child identity path escapes project root",
  );
}

/** @description Valida o schema completo de um registro de identidade. @param {unknown} record */
function validIdentityRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const { parent_session_id: parent, child_session_id: child, dispatch_call_id: callId, role, created_at: createdAt } = record;
  if (![parent, child, callId, role, createdAt].every((value) => typeof value === "string" && value.length > 0)) return false;
  if (!isSafeSessionId(parent) || !isSafeSessionId(child) || parent === child) return false;
  if (!isRuntimeRole(role)) return false;
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && new Date(created).toISOString() === createdAt;
}

/**
 * @description Grava o par papel ↔ sessão filha desta chamada de dispatch. Reescrever com o MESMO
 * conteúdo é idempotente; um registro divergente já no lugar é conflito (nunca sobrescreve).
 * @param {string} projectRoot
 * @param {{ parentSessionId?: unknown, childSessionId?: unknown, role?: unknown, callId?: unknown, now?: number }} args
 * @returns {{ ok: true, record: object, path: string } | { ok: false, reason: string, conflict?: boolean }}
 */
export function writePiChildIdentity(projectRoot, { parentSessionId, childSessionId, role, callId, now = Date.now() } = {}) {
  const record = {
    parent_session_id: parentSessionId,
    child_session_id: childSessionId,
    dispatch_call_id: callId,
    role,
    created_at: new Date(now).toISOString(),
  };
  if (!validIdentityRecord(record)) return { ok: false, reason: "exact parent, child, call, and canonical role required" };
  const resolved = piChildIdentityPath(projectRoot, parentSessionId, childSessionId);
  if (!resolved.ok) return resolved;
  const current = readIdentityFile(resolved.path);
  if (current.ok) {
    const same = current.record.parent_session_id === record.parent_session_id &&
      current.record.child_session_id === record.child_session_id &&
      current.record.dispatch_call_id === record.dispatch_call_id &&
      current.record.role === record.role;
    return same
      ? { ok: true, record: current.record, path: resolved.path }
      : { ok: false, conflict: true, reason: "child session already bound to another dispatch identity" };
  }
  if (!current.absent) return { ok: false, conflict: true, reason: current.reason };
  const temp = `${resolved.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, resolved.path);
    return { ok: true, record, path: resolved.path };
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason: "child identity write failed" };
  }
}

/** @description Lê e valida um arquivo de identidade; distingue ausente de ilegível. @param {string} file */
function readIdentityFile(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { ok: false, absent: true, reason: "child identity absent" };
    return { ok: false, reason: "child identity unreadable" };
  }
  if (!validIdentityRecord(value)) return { ok: false, reason: "child identity schema conflict" };
  return { ok: true, record: value };
}

/**
 * @description Recupera a identidade DESTA sessão filha. Quando o pai é fornecido, resolve
 * diretamente o único registro possível; a assinatura legada de dois argumentos ainda varre os
 * diretórios de sessão-pai. Zero é ausente; mais de um registro válido para a mesma filha é conflito
 * (fail-closed). Nome de arquivo que não é o sha256 do childSessionId, ou registro cujo
 * `parent_session_id` discorda do diretório, é conflito — as mesmas defesas da varredura de
 * irmãos de core/pi/lib/pi-state-records.mjs.
 * @param {string} projectRoot
 * @param {unknown} childSessionId
 * @param {{ parentSessionId?: unknown } | undefined} options
 * @returns {{ ok: true, record: object, path: string } | { ok: false, reason: string, absent?: boolean, conflict?: boolean }}
 */
export function readPiChildIdentity(projectRoot, childSessionId, options) {
  if (!isSafeSessionId(childSessionId)) return { ok: false, reason: "exact child session required" };

  if (options !== undefined) {
    const parentSessionId = options?.parentSessionId;
    const resolved = piChildIdentityPath(projectRoot, parentSessionId, childSessionId);
    if (!resolved.ok) return resolved;
    const found = readIdentityFile(resolved.path);
    if (!found.ok) {
      return found.absent
        ? found
        : { ok: false, conflict: true, reason: found.reason };
    }
    if (found.record.parent_session_id !== parentSessionId || found.record.child_session_id !== childSessionId) {
      return { ok: false, conflict: true, reason: "child identity does not match exact parent and child" };
    }
    return { ok: true, record: found.record, path: resolved.path };
  }

  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "project root unreadable" }; }
  const stateRoot = piStateRoot(realRoot);
  if (!stateRoot.ok) return { ok: false, reason: "project root unreadable" };
  const expected = childDigest(childSessionId);
  let match = null;
  try {
    for (const session of fs.readdirSync(stateRoot.path, { withFileTypes: true })) {
      if (session.isSymbolicLink()) return { ok: false, conflict: true, reason: "child identity scan failed" };
      if (!session.isDirectory()) continue;
      const candidate = path.join(stateRoot.path, session.name, "child-identity", expected);
      let file;
      try { file = fs.realpathSync(candidate); } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") continue;
        return { ok: false, conflict: true, reason: "child identity scan failed" };
      }
      if (!inside(realRoot, file)) return { ok: false, conflict: true, reason: "child identity scan failed" };
      const found = readIdentityFile(file);
      if (!found.ok) return { ok: false, conflict: true, reason: "child identity scan failed" };
      if (found.record.child_session_id !== childSessionId || found.record.parent_session_id !== session.name) {
        return { ok: false, conflict: true, reason: "child identity scan failed" };
      }
      if (match) return { ok: false, conflict: true, reason: "multiple identities bind the same child session" };
      match = { record: found.record, path: file };
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { ok: false, absent: true, reason: "child identity absent" };
    return { ok: false, conflict: true, reason: "child identity scan failed" };
  }
  return match ? { ok: true, ...match } : { ok: false, absent: true, reason: "child identity absent" };
}

/**
 * @description Remove o registro exato quando o dispatch termina. Ausência não é erro.
 * @param {string} projectRoot
 * @param {{ parentSessionId?: unknown, childSessionId?: unknown }} args
 * @returns {{ ok: true, removed: boolean } | { ok: false, reason: string }}
 */
export function removePiChildIdentity(projectRoot, { parentSessionId, childSessionId } = {}) {
  const resolved = piChildIdentityPath(projectRoot, parentSessionId, childSessionId);
  if (!resolved.ok) return resolved;
  try {
    const existed = fs.existsSync(resolved.path);
    fs.rmSync(resolved.path, { force: true });
    return { ok: true, removed: existed };
  } catch {
    return { ok: false, reason: "child identity removal failed" };
  }
}

export default {
  piChildIdentityPath,
  readPiChildIdentity,
  removePiChildIdentity,
  writePiChildIdentity,
};
