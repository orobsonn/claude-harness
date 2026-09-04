/**
 * @description Hand-records e dispatch-records da lane Pi, com raiz própria `.pi/harness/state/`
 * (espelho 1:1 de `.opencode/plans/.state/` da lane OC). Só o CAMINHO muda: toda a validação de
 * identidade é reusada por import da lane OC — validateOcCaptureEligibleHandRecord e
 * isCaptureEligibleHandRecord para hand-records, normalizeProjectPath e
 * resolveFixModeScopeAuthority para dispatch-records — e as reason strings, o digest sha256 do
 * dispatch_call_id, o formato dos registros e o comportamento fail-closed são IDÊNTICOS aos de
 * core/opencode/lib/hand-records.mjs e core/opencode/lib/dispatch-scope.mjs.
 *
 * Motivo da existência: aquelas duas libs hardcodam '.opencode/plans/.state' (hand-records.mjs:131,157;
 * dispatch-scope.mjs:85,252,364,415) e resolvem o plano estável por path-helpers.mjs, que só conhece
 * `.claude`/`.opencode`. Na lane Pi todo caminho passa por core/pi/lib/pi-paths.mjs. Os helpers
 * privados copiados daqui (inside/nearestExistingPath/canonicalTarget/readJson/writeJsonAtomic/
 * validDispatchRecord/mutateExactRecord) não são exportados pela lane OC — não há como importá-los.
 *
 * Papéis: o vocabulário do Pi é 'harness-executor'/'harness-sniper'/'harness-test-author'; toda
 * checagem de papel passa antes por toOcRole (core/pi/lib/pi-adapter-map.mjs), como manda o adaptador.
 * Toda escrita é atômica (tmp + rename). Nenhuma função lança.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isSafeFeatureId, isSafeSessionId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { isCaptureEligibleHandRecord } from "../../shared/lib/real-file-capture-rail.mjs";
import { validatePlan } from "../../shared/lib/validate-plan.mjs";
import { validateOcCaptureEligibleHandRecord } from "../../opencode/lib/hand-records.mjs";
import { normalizeProjectPath, resolveFixModeScopeAuthority } from "../../opencode/lib/dispatch-scope.mjs";
import { snapshotWorktreeBaseline } from "../../opencode/lib/worktree-baseline.mjs";
import { acquireLock, releaseLock } from "./pi-gate-state.mjs";
import { isExecutorRole, isSniperRole, isTestAuthorRole, toOcRole } from "./pi-adapter-map.mjs";
import {
  piDispatchRecordDir,
  piExecutionPlanPath,
  piGateStatePath,
  piHandRecordPath,
  piStateRoot,
} from "./pi-paths.mjs";

/** Reuso direto: puras/host-agnósticas, sem contraparte Pi necessária. */
export { normalizeProjectPath, resolveFixModeScopeAuthority };

/* ------------------------------------------------------------------ *
 * Helpers de caminho — cópia dos privados de dispatch-scope.mjs        *
 * ------------------------------------------------------------------ */

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

/** @description Papel que escreve código/teste, no vocabulário do Pi ou da lane OC. @param {unknown} role */
function writingHand(role) {
  const bare = toOcRole(role);
  return isExecutorRole(bare) || isSniperRole(bare) || isTestAuthorRole(bare);
}

/** @description True quando os dois papéis são da mesma família de mão escritora. @param {unknown} left @param {unknown} right */
function sameWritingHandFamily(left, right) {
  const a = toOcRole(left);
  const b = toOcRole(right);
  return (isExecutorRole(a) && isExecutorRole(b)) ||
    (isSniperRole(a) && isSniperRole(b)) ||
    (isTestAuthorRole(a) && isTestAuthorRole(b));
}

/* ------------------------------------------------------------------ *
 * Hand-records                                                        *
 * ------------------------------------------------------------------ */

/**
 * @description Grava o hand-record em `.pi/harness/state/hand-records/<featureId>/<sessionId>/<taskId>.json`.
 * Escrita atômica (tmp + rename). Nunca lança; mesmas reason strings de writeHandRecord (lane OC).
 * @param {{
 *   roots: { projectRoot: string, sessionId: string, featureId: string },
 *   taskId: string,
 *   record: object,
 *   mkdir?: (p: string) => void,
 *   writeFile?: (p: string, data: string) => void,
 *   rename?: (from: string, to: string) => void,
 *   rm?: (p: string) => void,
 * }} args
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function writePiHandRecord({
  roots,
  taskId,
  record,
  mkdir = (p) => fs.mkdirSync(p, { recursive: true }),
  writeFile = (p, data) => fs.writeFileSync(p, data, "utf8"),
  rename = (from, to) => fs.renameSync(from, to),
  rm = (p) => fs.rmSync(p, { force: true }),
} = {}) {
  let temporary = "";
  try {
    const resolved = piHandRecordPath(roots, taskId);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    mkdir(path.dirname(resolved.path));
    temporary = `${resolved.path}.${process.pid}.tmp`;
    writeFile(temporary, JSON.stringify(record, null, 2));
    rename(temporary, resolved.path);
    return { ok: true, path: resolved.path };
  } catch (err) {
    if (temporary) {
      try { rm(temporary); } catch { /* ignore */ }
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "writePiHandRecord failed",
    };
  }
}

/**
 * @description Raiz de hand-records da feature sob a raiz de estado do Pi; null quando insegura.
 * @param {string} projectRoot
 * @param {string} featureId
 * @returns {string | null}
 */
function piFeatureHandRecordsDir(projectRoot, featureId) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return null;
  if (!isSafeFeatureId(featureId)) return null;
  const root = path.resolve(projectRoot);
  const stateRoot = piStateRoot(root);
  if (!stateRoot.ok) return null;
  const dir = path.resolve(stateRoot.path, "hand-records", featureId);
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return dir;
}

/**
 * @description Lê um hand-record JSON; null em qualquer erro ou valor não-objeto.
 * @param {string} filePath
 * @returns {object | null}
 */
function readRecordFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @description Varre todos os subdiretórios de sessão sob hand-records/<featureId> e devolve
 * todo task record encontrado. Template: `.pi/harness/state/hand-records/<featureId>/<sessionId>/<taskId>.json`.
 * featureId inseguro → []; diretório ausente → []; nunca lança. Registros capture-eligible passam
 * por validateOcCaptureEligibleHandRecord (import da lane OC) e ganham `identityError` quando mentem.
 * @param {string} projectRoot
 * @param {string} featureId
 * @returns {Array<{ taskId: string, sessionId: string, record: object, identityError?: string }>}
 */
export function listPiHandRecordsForFeature(projectRoot, featureId) {
  try {
    const featureDir = piFeatureHandRecordsDir(projectRoot, featureId);
    if (!featureDir) return [];

    let sessionEntries;
    try {
      sessionEntries = fs.readdirSync(featureDir, { withFileTypes: true });
    } catch {
      return [];
    }

    /** @type {Array<{ taskId: string, sessionId: string, record: object, identityError?: string }>} */
    const results = [];

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionId = sessionEntry.name;
      const sessionDir = path.join(featureDir, sessionId);

      let taskEntries;
      try {
        taskEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const taskEntry of taskEntries) {
        if (!taskEntry.isFile()) continue;
        if (!taskEntry.name.endsWith(".json")) continue;
        const taskId = taskEntry.name.slice(0, -".json".length);
        if (!taskId) continue;
        const record = readRecordFile(path.join(sessionDir, taskEntry.name));
        if (record !== null) {
          const identity = isCaptureEligibleHandRecord(record)
            ? validateOcCaptureEligibleHandRecord(record, { featureId, taskId, sessionId })
            : { ok: true };
          results.push({
            taskId,
            sessionId,
            record,
            ...(!identity.ok ? { identityError: identity.reason } : {}),
          });
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Dispatch-records                                                    *
 * ------------------------------------------------------------------ */

/**
 * @description Devolve o único arquivo durável atribuído a uma chamada de dispatch do pai:
 * `.pi/harness/state/<parentSessionId>/dispatch-records/<sha256(dispatchCallId)>.json`.
 * Mesmo digest da lane OC. Nunca lança.
 * @param {string} projectRoot
 * @param {unknown} parentSessionId
 * @param {unknown} dispatchCallId
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function piDispatchRecordPath(projectRoot, parentSessionId, dispatchCallId) {
  if (!isSafeSessionId(parentSessionId) || typeof dispatchCallId !== "string" || !dispatchCallId) {
    return { ok: false, reason: "exact parent session and dispatch call required" };
  }
  const digest = crypto.createHash("sha256").update(dispatchCallId).digest("hex");
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "project root unreadable" }; }
  const dir = piDispatchRecordDir({ projectRoot: realRoot, parentSessionId });
  if (!dir.ok) return { ok: false, reason: "exact parent session and dispatch call required" };
  return canonicalTarget(realRoot, path.join(dir.path, `${digest}.json`), "dispatch record path escapes project root");
}

/** @description Lê JSON de dispatch-record; distingue ausente de ilegível. @param {string} file */
function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, value } : { ok: false, reason: "dispatch record invalid" };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { ok: false, absent: true, reason: "dispatch record absent" };
    return { ok: false, reason: "dispatch record unreadable" };
  }
}

/** @description Escreve JSON atomicamente (tmp exclusivo + rename), modo 0600. @param {string} target @param {object} body */
function writeJsonAtomic(target, body) {
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, target);
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

/** @description Lista de caminhos canônicos do projeto, sem duplicata. @param {string} projectRoot @param {unknown} value @param {boolean} requireNonempty */
function canonicalStringList(projectRoot, value, requireNonempty) {
  if (!Array.isArray(value) || (requireNonempty && value.length === 0)) return false;
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item) return false;
    const normalized = normalizeProjectPath(projectRoot, item);
    if (!normalized.ok || normalized.path !== item || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

/** @description Valida o schema completo de um dispatch-record. @param {string} projectRoot @param {unknown} record */
function validDispatchRecord(projectRoot, record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const required = [record.parent_session_id, record.dispatch_call_id, record.feature_id, record.task_id, record.role, record.plan_hash, record.claimed_at];
  if (!required.every((value) => typeof value === "string" && value.length > 0)) return false;
  if (!isSafeSessionId(record.parent_session_id) || !isSafeFeatureId(record.feature_id) || !isSafeTaskId(record.task_id) || !writingHand(record.role)) return false;
  if (!/^[0-9a-f]{64}$/.test(record.plan_hash)) return false;
  if (record.child_session_id !== null && !isSafeSessionId(record.child_session_id)) return false;
  const claimedAt = Date.parse(record.claimed_at);
  if (!Number.isFinite(claimedAt) || new Date(claimedAt).toISOString() !== record.claimed_at) return false;
  return canonicalStringList(projectRoot, record.scope_paths, true) &&
    canonicalStringList(projectRoot, record.allowed_writes, false) &&
    (record.frozen_paths === undefined || canonicalStringList(projectRoot, record.frozen_paths, false));
}

/** @description Read-modify-write do registro exato sob lock de posse. @param {string} recordPath @param {(current: object) => object} fn */
function mutateExactRecord(recordPath, fn) {
  const acquired = acquireLock(recordPath);
  if (!acquired.ok) return { ok: false, reason: acquired.reason };
  try {
    const current = readJson(recordPath);
    const next = fn(current);
    if (next?.ok === false) return next;
    if (next?.remove) {
      try { fs.rmSync(recordPath, { force: true }); return { ok: true, removed: true }; } catch { return { ok: false, reason: "dispatch record removal failed" }; }
    }
    if (!next || typeof next !== "object" || !next.record) return { ok: false, reason: "dispatch record mutation invalid" };
    return writeJsonAtomic(recordPath, next.record) ? { ok: true, record: next.record } : { ok: false, reason: "dispatch record write failed" };
  } finally {
    releaseLock(recordPath, acquired.token);
  }
}

/**
 * @description Lê exatamente um dispatch-record do Pi; nunca varre nem empresta o de um irmão.
 * @param {string} projectRoot
 * @param {{ parentSessionId?: string, callId?: string }} args
 * @returns {{ ok: true, record: object, path: string } | { ok: false, reason: string, absent?: boolean, conflict?: boolean }}
 */
export function readPiDispatchRecord(projectRoot, { parentSessionId, callId } = {}) {
  const resolved = piDispatchRecordPath(projectRoot, parentSessionId, callId);
  if (!resolved.ok) return resolved;
  const loaded = readJson(resolved.path);
  if (!loaded.ok) return loaded.absent ? loaded : { ...loaded, conflict: true };
  const record = loaded.value;
  if (!validDispatchRecord(projectRoot, record)) return { ok: false, conflict: true, reason: "dispatch record schema conflict" };
  if (record.parent_session_id !== parentSessionId || record.dispatch_call_id !== callId) return { ok: false, conflict: true, reason: "dispatch record identity conflict" };
  return { ok: true, record, path: resolved.path };
}

/**
 * @description Lê e valida estruturalmente uma task exata do plano estável da feature em
 * `.pi/harness/plans/<featureId>/execution-plan.json`. Mesmas reasons da lane OC.
 * @param {string} projectRoot
 * @param {string} featureId
 * @param {string} taskId
 */
function readPiCanonicalTask(projectRoot, featureId, taskId) {
  if (!isSafeFeatureId(featureId) || !isSafeTaskId(taskId)) return { ok: false, reason: "canonical feature or task identity invalid" };
  const resolved = piExecutionPlanPath({ projectRoot, featureId });
  if (!resolved.ok) return resolved;
  let bytes;
  let plan;
  try {
    bytes = fs.readFileSync(resolved.path);
    plan = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { ok: false, reason: error && typeof error === "object" && error.code === "ENOENT" ? "stable plan missing" : "stable plan unreadable" };
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.feature_id !== featureId) return { ok: false, reason: "stable plan feature mismatch" };
  let validation;
  try {
    validation = validatePlan(plan, { expect: "full", expectedModelStrategy: plan.model_strategy });
  } catch {
    return { ok: false, reason: "stable plan validation failed internally" };
  }
  if (!validation?.ok) return { ok: false, reason: `stable plan invalid: ${(validation?.errors ?? []).join("; ")}` };
  const matches = (Array.isArray(plan.tasks) ? plan.tasks : []).filter((task) => task && task.id === taskId);
  if (matches.length !== 1) return { ok: false, reason: "canonical task id missing or ambiguous in stable plan" };
  const planHash = crypto.createHash("sha256").update(bytes).digest("hex");
  return { ok: true, featureId, taskId, task: matches[0], planHash, planPath: resolved.path };
}

/**
 * @description Lê a única exceção de cerimônia que pertence à tarefa, depois de validar o plano
 * estável inteiro. O valor nunca vem do prompt/descriptor: só `no_tests:true` canônico com
 * `locked_tests: []` (validado por validatePlan) pode dispensar o produtor de teste.
 * @param {string} projectRoot
 * @param {string} featureId
 * @param {string} taskId
 * @returns {{ ok: true, noTests: boolean, planHash: string } | { ok: false, reason: string }}
 */
export function readPiCanonicalTaskPolicy(projectRoot, featureId, taskId) {
  const bound = readPiCanonicalTask(projectRoot, featureId, taskId);
  if (!bound.ok) return bound;
  return {
    ok: true,
    noTests: bound.task.no_tests === true,
    planHash: bound.planHash,
  };
}

/**
 * @description Deriva o escopo de uma mão escritora a partir do plano estável validado do Pi.
 * @param {string} projectRoot
 * @param {string} featureId
 * @param {string} taskId
 * @param {string} role
 */
export function canonicalPiDispatchFromPlan(projectRoot, featureId, taskId, role) {
  if (!writingHand(role)) return { ok: false, reason: "role is not a writing hand" };
  const bound = readPiCanonicalTask(projectRoot, featureId, taskId);
  if (!bound.ok) return bound;
  const scopePaths = [];
  for (const item of Array.isArray(bound.task.scope_paths) ? bound.task.scope_paths : []) {
    const normalized = normalizeProjectPath(projectRoot, item);
    if (!normalized.ok) return normalized;
    if (!scopePaths.includes(normalized.path)) scopePaths.push(normalized.path);
  }
  if (scopePaths.length === 0) return { ok: false, reason: "canonical task scope is empty" };
  const allowedWrites = [];
  for (const item of Array.isArray(bound.task.allowed_writes) ? bound.task.allowed_writes : []) {
    const normalized = normalizeProjectPath(projectRoot, item);
    if (!normalized.ok) return normalized;
    if (!allowedWrites.includes(normalized.path)) allowedWrites.push(normalized.path);
  }
  const frozenPaths = [];
  for (const lockedTest of Array.isArray(bound.task.locked_tests) ? bound.task.locked_tests : []) {
    const candidates = [lockedTest?.path, ...(Array.isArray(lockedTest?.fixture_paths) ? lockedTest.fixture_paths : [])];
    for (const item of candidates) {
      const normalized = normalizeProjectPath(projectRoot, item);
      if (!normalized.ok) return normalized;
      if (!frozenPaths.includes(normalized.path)) frozenPaths.push(normalized.path);
    }
  }
  if (isTestAuthorRole(toOcRole(role))) {
    if (frozenPaths.length === 0) return { ok: false, reason: "test-author requires canonical locked test paths" };
    return { ok: true, featureId: bound.featureId, taskId: bound.taskId, scopePaths: frozenPaths, allowedWrites: [], frozenPaths: [], planHash: bound.planHash };
  }
  return { ok: true, featureId: bound.featureId, taskId: bound.taskId, scopePaths, allowedWrites, frozenPaths, planHash: bound.planHash };
}

/** @description Carrega o gate-state canônico da sessão sob `.pi/harness/state/`. @param {string} projectRoot @param {string} sessionId */
function loadCanonicalPiState(projectRoot, sessionId) {
  const resolved = piGateStatePath({ projectRoot, sessionId });
  if (!resolved.ok) return resolved;
  const loaded = readJson(resolved.path);
  if (!loaded.ok) return { ok: false, reason: loaded.absent ? "gate-state missing" : "gate-state unreadable" };
  return { ok: true, state: loaded.value };
}

/** @description True quando os dois registros descrevem o mesmo dispatch (replay idêntico). @param {object} left @param {object} right */
function sameDispatch(left, right) {
  return left.parent_session_id === right.parent_session_id &&
    left.dispatch_call_id === right.dispatch_call_id &&
    left.feature_id === right.feature_id && left.task_id === right.task_id && left.role === right.role &&
    left.plan_hash === right.plan_hash && JSON.stringify(left.scope_paths) === JSON.stringify(right.scope_paths) &&
    JSON.stringify(left.allowed_writes) === JSON.stringify(right.allowed_writes) &&
    JSON.stringify(left.frozen_paths ?? []) === JSON.stringify(right.frozen_paths ?? []);
}

/** @description Lock de ciclo de vida da sessão: `.pi/harness/state/.session-lifecycle/<sessionId>`. @param {string} realRoot @param {string} sessionId */
function piLifecycleLockTarget(realRoot, sessionId) {
  const stateRoot = piStateRoot(realRoot);
  if (!stateRoot.ok) return { ok: false, reason: "project root unreadable" };
  return canonicalTarget(
    realRoot,
    path.join(stateRoot.path, ".session-lifecycle", sessionId),
    "dispatch lifecycle lock path escapes project root",
  );
}

/** @description Cria o registro imutável de escopo desta chamada exata, sob lock de ciclo de vida. */
function claimResolvedPiDispatch(projectRoot, { sessionId, callId, role, taskId, expectedPlanHash, now = Date.now(), lockOptions } = {}, resolveCanonical) {
  if (![sessionId, callId, role, taskId].every((value) => typeof value === "string" && value)) return { ok: false, reason: "runtime session, call, role, and task required" };
  if (!isSafeSessionId(sessionId) || !isSafeTaskId(taskId) || !writingHand(role)) return { ok: false, reason: "runtime session, task, or writing role invalid" };
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "project root unreadable" }; }
  const lifecycleTarget = piLifecycleLockTarget(realRoot, sessionId);
  if (!lifecycleTarget.ok) return lifecycleTarget;
  const lifecycle = acquireLock(lifecycleTarget.path, lockOptions);
  if (!lifecycle.ok) return lifecycle;
  try {
    const canonical = resolveCanonical(realRoot);
    if (!canonical.ok) return canonical;
    if (
      typeof expectedPlanHash === "string" && expectedPlanHash.length > 0 &&
      canonical.planHash !== expectedPlanHash
    ) {
      return { ok: false, reason: "canonical task changed since policy check" };
    }
    const worktreeBaseline = snapshotWorktreeBaseline(realRoot);
    const record = {
      parent_session_id: sessionId, dispatch_call_id: callId, child_session_id: null,
      feature_id: canonical.featureId, task_id: canonical.taskId, role,
      scope_paths: canonical.scopePaths, allowed_writes: canonical.allowedWrites,
      frozen_paths: canonical.frozenPaths ?? [],
      plan_hash: canonical.planHash, claimed_at: new Date(now).toISOString(),
      ...(worktreeBaseline?.entries?.length ? { worktree_baseline: worktreeBaseline } : {}),
    };
    const resolved = piDispatchRecordPath(realRoot, sessionId, callId);
    if (!resolved.ok) return resolved;
    const written = mutateExactRecord(resolved.path, (current) => {
      if (current.ok && !validDispatchRecord(realRoot, current.value)) return { ok: false, conflict: true, reason: "same dispatch call record schema conflict" };
      if (current.ok && sameDispatch(current.value, record)) return { record: current.value };
      if (current.ok) return { ok: false, conflict: true, reason: "same dispatch call replay conflicts with canonical scope" };
      if (!current.absent) return current;
      return { record };
    });
    return written.ok
      ? { ok: true, claim: written.record, ...(typeof canonical.reviewedSha === "string" ? { reviewedSha: canonical.reviewedSha } : {}) }
      : written;
  } finally {
    releaseLock(lifecycleTarget.path, lifecycle.token);
  }
}

/**
 * @description Reivindica atomicamente o escopo canônico do planner para esta chamada de dispatch.
 * @param {string} projectRoot
 * @param {{ sessionId?: string, callId?: string, role?: string, taskId?: string, expectedPlanHash?: string, now?: number, lockOptions?: object }} args
 */
export function claimActivePiDispatch(projectRoot, { sessionId, callId, role, taskId, expectedPlanHash, now = Date.now(), lockOptions } = {}) {
  return claimResolvedPiDispatch(projectRoot, { sessionId, callId, role, taskId, expectedPlanHash, now, lockOptions }, (realRoot) => {
    const loaded = loadCanonicalPiState(realRoot, sessionId);
    if (!loaded.ok) return loaded;
    if (loaded.state.session_id !== sessionId) return { ok: false, reason: "gate-state session identity mismatch" };
    if (loaded.state.classified !== true || !["LIGHT", "FULL"].includes(loaded.state.mode)) return { ok: false, reason: "classified LIGHT or FULL required" };
    if (!isSafeFeatureId(loaded.state.feature_id)) return { ok: false, reason: "gate-state feature identity invalid" };
    return canonicalPiDispatchFromPlan(realRoot, loaded.state.feature_id, taskId, role);
  });
}

/**
 * @description Reivindica o escopo do planner normalmente, ou o escopo revisado congelado pelo host
 * em fix mode (envelope HARNESS_FIX_MODE/HARNESS_FIX_SCOPE_JSON, lido por resolveFixModeScopeAuthority
 * importado da lane OC). Mesmas reasons e mesmo plan_hash 'fix-mode-v1' da lane OC.
 * @param {string} projectRoot
 * @param {{ sessionId?: string, callId?: string, role?: string, taskId?: string, featureId?: string, now?: number, lockOptions?: object }} args
 * @param {{ env?: object, isAncestorFn?: (sha: string) => boolean | null }} deps
 */
export function claimPiDispatchForRuntime(projectRoot, args = {}, { env = process.env, isAncestorFn } = {}) {
  const authority = resolveFixModeScopeAuthority(env);
  if (!authority.enabled) return claimActivePiDispatch(projectRoot, args);
  if (!authority.ok) return authority;
  const { sessionId, callId, role, taskId, featureId, now = Date.now(), lockOptions } = args;
  if (!isSniperRole(toOcRole(role))) return { ok: false, reason: "fix-mode dispatch requires sniper role" };
  if (!isSafeFeatureId(featureId)) return { ok: false, reason: "fix-mode feature invalid" };
  return claimResolvedPiDispatch(projectRoot, { sessionId, callId, role, taskId, now, lockOptions }, (realRoot) => {
    const loaded = loadCanonicalPiState(realRoot, sessionId);
    if (!loaded.ok) return loaded;
    const state = loaded.state;
    if (state.session_id !== sessionId || state.feature_id !== featureId) return { ok: false, reason: "fix-mode gate-state identity mismatch" };
    if (state.classified !== true || !["LIGHT", "FULL"].includes(state.mode)) return { ok: false, reason: "fix-mode classified LIGHT or FULL required" };
    let ancestor = null;
    try { ancestor = typeof isAncestorFn === "function" ? isAncestorFn(authority.reviewedSha) : null; } catch { ancestor = null; }
    if (ancestor !== true) return { ok: false, reason: "fix-mode reviewed sha is not an ancestor of HEAD" };
    const scopePaths = [];
    for (const item of authority.scopePaths) {
      const normalized = normalizeProjectPath(realRoot, item);
      if (!normalized.ok || normalized.path !== item) return { ok: false, reason: normalized.reason ?? "fix-mode scope is not canonical" };
      const absolute = path.join(realRoot, item);
      try {
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: "fix-mode scope must name exact files" };
      } catch (error) {
        if (!error || typeof error !== "object" || error.code !== "ENOENT") return { ok: false, reason: "fix-mode scope unreadable" };
      }
      scopePaths.push(item);
    }
    const planHash = crypto.createHash("sha256").update(JSON.stringify({
      authority: "fix-mode-v1", session_id: sessionId, feature_id: featureId,
      task_id: taskId, role, reviewed_sha: authority.reviewedSha, scope_paths: scopePaths,
    })).digest("hex");
    return { ok: true, featureId, taskId, scopePaths, allowedWrites: [], planHash, reviewedSha: authority.reviewedSha };
  });
}

/** @description Varre os diretórios `dispatch-records` de cada sessão sob `.pi/harness/state/` procurando o registro que liga a sessão filha. */
function scanPiBoundChild(projectRoot, childSessionId, excludedPath = "") {
  if (!isSafeSessionId(childSessionId)) return { ok: false, conflict: true, reason: "child session identity invalid" };
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "dispatch sibling scan failed" }; }
  const stateRoot = piStateRoot(realRoot);
  if (!stateRoot.ok) return { ok: false, reason: "dispatch sibling scan failed" };
  const root = stateRoot.path;
  let match = null;
  try {
    for (const session of fs.readdirSync(root, { withFileTypes: true })) {
      if (session.isSymbolicLink()) return { ok: false, reason: "dispatch sibling scan failed" };
      if (!session.isDirectory()) continue;
      const records = path.join(root, session.name, "dispatch-records");
      let entries;
      try { entries = fs.readdirSync(records); } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") continue;
        return { ok: false, reason: "dispatch sibling scan failed" };
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        let file;
        try { file = fs.realpathSync(path.join(records, entry)); } catch { return { ok: false, reason: "dispatch sibling scan failed" }; }
        if (!inside(realRoot, file)) return { ok: false, reason: "dispatch sibling scan failed" };
        if (file === excludedPath) continue;
        const found = readJson(file);
        if (!found.ok) return { ok: false, conflict: true, reason: "dispatch sibling scan failed" };
        if (!validDispatchRecord(realRoot, found.value)) return { ok: false, conflict: true, reason: "dispatch sibling scan failed" };
        const expectedName = `${crypto.createHash("sha256").update(found.value.dispatch_call_id).digest("hex")}.json`;
        if (entry !== expectedName || found.value.parent_session_id !== session.name) return { ok: false, conflict: true, reason: "dispatch sibling scan failed" };
        if (found.value.child_session_id !== childSessionId) continue;
        if (match) return { ok: false, conflict: true, reason: "multiple durable dispatch records bind the same child session" };
        match = { record: found.value, path: file, parentSessionId: found.value.parent_session_id, callId: found.value.dispatch_call_id };
      }
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { ok: false, absent: true, reason: "bound child dispatch record absent" };
    return { ok: false, conflict: true, reason: "dispatch sibling scan failed" };
  }
  return match ? { ok: true, ...match } : { ok: false, absent: true, reason: "bound child dispatch record absent" };
}

/**
 * @description Recupera exatamente uma chamada-pai ligada a uma sessão filha; zero é ausente, muitos é conflito.
 * @param {string} projectRoot
 * @param {string} childSessionId
 */
export function readPiBoundDispatchForChild(projectRoot, childSessionId) {
  return scanPiBoundChild(projectRoot, childSessionId);
}

/** @description True quando a filha já está ligada a OUTRO registro que não o desejado. */
function piChildBoundElsewhere(projectRoot, childSessionId, wantedPath) {
  const found = scanPiBoundChild(projectRoot, childSessionId, wantedPath);
  if (found.ok) return { ok: true, bound: true };
  if (found.absent) return { ok: true, bound: false };
  return found;
}

/** @description Lock por sessão filha: `.pi/harness/state/.dispatch-child-locks/<sha256(childSessionId)>`. */
function piChildLockTarget(projectRoot, childSessionId) {
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "project root unreadable" }; }
  const stateRoot = piStateRoot(realRoot);
  if (!stateRoot.ok) return { ok: false, reason: "project root unreadable" };
  const digest = crypto.createHash("sha256").update(childSessionId).digest("hex");
  return canonicalTarget(realRoot, path.join(stateRoot.path, ".dispatch-child-locks", digest), "dispatch child lock path escapes project root");
}

/**
 * @description Liga a sessão filha SOMENTE à chamada-pai nomeada explicitamente; registros irmãos
 * nunca são candidatos. No Pi a filha é detectada por ctx.sessionManager.getHeader().parentSession.
 * @param {string} projectRoot
 * @param {{ parentSessionId?: string, childSessionId?: string, role?: string, callId?: string }} args
 */
export function bindPiChildSession(projectRoot, { parentSessionId, childSessionId, role, callId } = {}) {
  if (![parentSessionId, childSessionId, role, callId].every((value) => typeof value === "string" && value) || parentSessionId === childSessionId || !writingHand(role)) return { ok: false, reason: "exact parent, child, call, and writing role required" };
  const resolved = piDispatchRecordPath(projectRoot, parentSessionId, callId);
  if (!resolved.ok) return resolved;
  const childTarget = piChildLockTarget(projectRoot, childSessionId);
  if (!childTarget.ok) return childTarget;
  const acquired = acquireLock(childTarget.path);
  if (!acquired.ok) return { ok: false, reason: acquired.reason };
  try {
    const sibling = piChildBoundElsewhere(projectRoot, childSessionId, resolved.path);
    if (!sibling.ok) return sibling;
    if (sibling.bound) return { ok: false, reason: "child session already bound to another dispatch" };
    const updated = mutateExactRecord(resolved.path, (current) => {
      if (!current.ok) return current;
      const record = current.value;
      if (!validDispatchRecord(projectRoot, record)) return { ok: false, conflict: true, reason: "dispatch record schema conflict" };
      if (record.parent_session_id !== parentSessionId || record.dispatch_call_id !== callId || !sameWritingHandFamily(role, record.role)) return { ok: false, reason: "exact dispatch role or identity mismatch" };
      if (record.child_session_id != null && record.child_session_id !== childSessionId) return { ok: false, reason: "dispatch already bound to another child session" };
      if (record.child_session_id === childSessionId) return { record };
      return { record: { ...record, child_session_id: childSessionId } };
    });
    return updated.ok ? { ok: true, binding: { parentSessionId, childSessionId, callId, role } } : updated;
  } finally {
    releaseLock(childTarget.path, acquired.token);
  }
}

/**
 * @description Remove apenas o registro da chamada-pai exata, depois que seu dispatch termina.
 * @param {string} projectRoot
 * @param {{ sessionId?: string, callId?: string }} args
 */
export function removePiDispatchRecord(projectRoot, { sessionId, callId } = {}) {
  const resolved = piDispatchRecordPath(projectRoot, sessionId, callId);
  if (!resolved.ok) return resolved;
  const removed = mutateExactRecord(resolved.path, (current) => {
    if (current.absent) return { remove: true };
    if (!current.ok) return current;
    if (!validDispatchRecord(projectRoot, current.value)) return { ok: false, conflict: true, reason: "dispatch record schema conflict" };
    if (current.value.parent_session_id !== sessionId || current.value.dispatch_call_id !== callId) return { ok: false, reason: "exact dispatch record identity conflict" };
    return { remove: true };
  });
  return removed.ok ? { ok: true, removed: Boolean(removed.removed) } : removed;
}

export default {
  bindPiChildSession,
  canonicalPiDispatchFromPlan,
  claimActivePiDispatch,
  claimPiDispatchForRuntime,
  listPiHandRecordsForFeature,
  normalizeProjectPath,
  piDispatchRecordPath,
  readPiBoundDispatchForChild,
  readPiDispatchRecord,
  removePiDispatchRecord,
  resolveFixModeScopeAuthority,
  writePiHandRecord,
};
