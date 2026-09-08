/**
 * @description Preflight estreito para reabrir a mesma cerimônia Pi.
 * Não cria sessão, não migra state e não escolhe fase por conta própria: apenas
 * prova que o transcript, a worktree, a spec, o plano e o gate pertencem ao
 * mesmo pai antes de o launcher abrir o JSONL existente.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { hostname as localHostname } from "node:os";
import path from "node:path";

import { isSafeFeatureId, isSafeSessionId } from "../vendor/shared/lib/feature-id.mjs";
import { validatePlan } from "../vendor/shared/lib/validate-plan.mjs";
import { compareAndDeleteLock } from "./pi-gate-state.mjs";
import { piExecutionPlanPath, piGateStatePath, piSpecPath, piStateRoot } from "./pi-paths.mjs";
import { readTaskRunBinding } from "./task-run.mjs";
import { hasSuccessfulAdversaryCompletion } from "./marker-authority.mjs";

const MAX_FILE_BYTES = 1024 * 1024;
const RECOVERABLE_MODES = new Set(["LIGHT", "FULL"]);
// A retomada não pode aceitar a estratégia declarada pelo próprio plano: ela
// precisa conferir contra a rota canônica que este runtime Pi materializa.
// Assim, trocar o modelo no JSON salvo não converte um plano inválido em válido.
const CURRENT_PI_MODEL_STRATEGY = Object.freeze({
  hand_tiers: Object.freeze({
    low: "openai-codex/gpt-5.6-luna",
    medium: "openai-codex/gpt-5.6-terra",
    high: "openai-codex/gpt-5.6-terra",
  }),
  planner: "openai-codex/gpt-5.6-sol",
  "plan-reviewer": "openai-codex/gpt-6-astra",
  compliance: "openai-codex/gpt-5.6-terra",
  adversary: "openai-codex/gpt-5.6-sol",
  security: "openai-codex/gpt-5.6-sol",
  shipper: "openai-codex/gpt-5.6-luna",
  harvester: "openai-codex/gpt-5.6-luna",
});
// Compatibilidade de retomada é estreita: somente o snapshot imediatamente
// anterior, completo e imutável, pode reabrir para ser reconciliado.
const LEGACY_PI_MODEL_STRATEGY = Object.freeze({
  hand_tiers: Object.freeze({
    low: "openai-codex/gpt-5.6-luna",
    medium: "openai-codex/gpt-5.6-terra",
    high: "openai-codex/gpt-5.6-terra",
  }),
  planner: "openai-codex/gpt-5.6-sol",
  "plan-reviewer": "openai-codex/gpt-5.6-sol",
  compliance: "openai-codex/gpt-5.6-terra",
  adversary: "openai-codex/gpt-5.6-sol",
  security: "openai-codex/gpt-5.6-sol",
  shipper: "openai-codex/gpt-5.6-luna",
  harvester: "openai-codex/gpt-5.6-luna",
});

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Reads an existing regular file below root without crossing symlinks. */
function readOwnedFile(root, file) {
  try {
    const resolved = path.resolve(file);
    if (!isInside(root, resolved)) return { ok: false, reason: "resume path outside worktree" };
    const relative = path.relative(root, resolved);
    let cursor = root;
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) return { ok: false, reason: "resume symlink rejected" };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES || fs.realpathSync(resolved) !== resolved) {
      return { ok: false, reason: "resume file invalid" };
    }
    return { ok: true, path: resolved, text: fs.readFileSync(resolved, "utf8") };
  } catch (error) {
    return { ok: false, reason: "resume file missing",
      ...(error?.code === "ENOENT" && error.path === path.resolve(file) ? { absent: true } : {}),
    };
  }
}

/** The transcript may be large; only its small, immutable first header is needed. */
function readOwnedSessionHeader(root, file) {
  let descriptor;
  try {
    const resolved = path.resolve(file);
    if (!isInside(root, resolved)) return { ok: false, reason: "resume path outside worktree" };
    const relative = path.relative(root, resolved);
    let cursor = root;
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) return { ok: false, reason: "resume symlink rejected" };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0 || fs.realpathSync(resolved) !== resolved) return { ok: false, reason: "resume file invalid" };
    descriptor = fs.openSync(resolved, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytes).split("\n", 1)[0];
    return { ok: true, path: resolved, firstLine };
  } catch {
    return { ok: false, reason: "resume file missing" };
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function parseJson(text, reason) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, value } : { ok: false, reason };
  } catch {
    return { ok: false, reason };
  }
}

function loadExactSessionFile(root, sessionId) {
  const sessionsDir = path.join(root, ".pi", "harness", "sessions");
  try {
    if (fs.lstatSync(sessionsDir).isSymbolicLink() || fs.realpathSync(sessionsDir) !== sessionsDir) {
      return { ok: false, reason: "resume session directory invalid" };
    }
    const matches = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(`_${sessionId}.jsonl`))
      .map((entry) => path.join(sessionsDir, entry.name));
    if (matches.length === 0) return { ok: false, reason: "resume session file missing" };
    if (matches.length !== 1) return { ok: false, reason: "resume session file ambiguous" };
    const file = readOwnedSessionHeader(root, matches[0]);
    if (!file.ok) return file;
    const header = parseJson(file.firstLine, "resume session header invalid");
    if (!header.ok) return header;
    if (header.value.type !== "session" || header.value.id !== sessionId || typeof header.value.cwd !== "string") {
      return { ok: false, reason: "resume session identity mismatch" };
    }
    let headerRoot;
    try { headerRoot = fs.realpathSync(header.value.cwd); } catch { return { ok: false, reason: "resume session cwd missing" }; }
    if (headerRoot !== root) return { ok: false, reason: "resume session cwd mismatch" };
    return { ok: true, sessionFile: file.path };
  } catch {
    return { ok: false, reason: "resume session file missing" };
  }
}

function asStringArray(value, reason) {
  if (value == null) return { ok: true, value: [] };
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? { ok: true, value }
    : { ok: false, reason };
}

function inspectOwnedPath(root, file) {
  if (!isInside(root, file)) return { invalid: true };
  let cursor = root;
  let stat;
  for (const segment of path.relative(root, file).split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) return { invalid: true };
    } catch (error) { return error?.code === "ENOENT" ? { absent: true } : { invalid: true }; }
  }
  return { stat };
}

function hasPostPlanEvidence(root, statePath, state) {
  const fields = [
    "plan_review_evidence", "plan_verdict", "fidelity_pass", "hand_finished",
    "capture_verified", "regate_pending", "regate_passed", "task_review_evidence", "task_adversary_evidence",
    "final_review_evidence", "final_review_done", "demo_done",
  ];
  if (fields.some((key) => Object.hasOwn(state, key)) ||
      !inspectOwnedPath(root, path.join(path.dirname(statePath), "task-runs/index.json")).absent) return true;
  const handsPath = path.join(root, ".pi/harness/state/hand-records", state.feature_id, state.session_id);
  const hands = inspectOwnedPath(root, handsPath);
  if (hands.absent) return false;
  if (hands.invalid || !hands.stat?.isDirectory()) return true;
  try { return fs.readdirSync(handsPath).length > 0; } catch { return true; }
}

/**
 * @param {string} projectRoot
 * @param {string} sessionId
 */
export function recoverPiParentSession(projectRoot, sessionId) {
  if (!projectRoot || !isSafeSessionId(sessionId)) return { ok: false, reason: "resume session identity invalid" };
  let root;
  try { root = fs.realpathSync(projectRoot); } catch { return { ok: false, reason: "resume worktree missing" }; }

  const transcript = loadExactSessionFile(root, sessionId);
  if (!transcript.ok) return transcript;

  const statePath = piGateStatePath({ projectRoot: root, sessionId });
  if (!statePath.ok) return { ok: false, reason: "resume session identity invalid" };
  const stateFile = readOwnedFile(root, statePath.path);
  if (!stateFile.ok) return { ok: false, reason: "resume gate-state missing" };
  const parsedState = parseJson(stateFile.text, "resume gate-state invalid");
  if (!parsedState.ok) return parsedState;
  const state = parsedState.value;
  const stateMode = typeof state.mode === "string" ? state.mode.toUpperCase() : "";
  if (state.session_id !== sessionId || !isSafeFeatureId(state.feature_id) || !RECOVERABLE_MODES.has(stateMode)) {
    return { ok: false, reason: "resume gate-state identity mismatch" };
  }
  if (state.task_run) {
    const taskAdmission = readTaskRunBinding(root, sessionId);
    if (!taskAdmission.ok) return taskAdmission;
    if (state.classification_source !== "delegated-task" || stateMode !== taskAdmission.plan.mode.toUpperCase()) {
      return { ok: false, reason: "resume delegated task provenance mismatch" };
    }
    return {
      ok: true,
      root,
      sessionId,
      sessionFile: transcript.sessionFile,
      taskAdmission: { ...taskAdmission, resumed: true },
      context: "Resume only this exact delegated task parent and attempt. Preserve valid task evidence and resolve the incomplete item without restarting global ceremony or inventing approvals.",
    };
  }
  if (state.classified !== true || state.classification_source === "delegated-task") {
    return { ok: false, reason: "resume global classification invalid" };
  }
  const draft = state.spec_status === "draft";
  if (draft) {
    // A completed native review (or its consumed marker) is not the spec seal.
    // Reopening this conversation must leave the pending approval gates untouched.
    if ((state.brainstormed !== undefined && state.brainstormed !== false) || Object.hasOwn(state, "reviewed_spec_sha256") ||
        Object.hasOwn(state, "reviewed_at") ||
        (state.adversary_fired !== undefined && typeof state.adversary_fired !== "boolean") ||
        (state.adversary_fired === true && (state.adversary_spec_sha256 !== state.spec_sha256 ||
          state.adversary_completion_evidence?.spec_sha256 !== state.spec_sha256 ||
          !hasSuccessfulAdversaryCompletion(state, { sessionId, featureId: state.feature_id }))) ||
        (Object.hasOwn(state, "adversary_spec_sha256") && state.adversary_fired !== true)) {
      return { ok: false, reason: "resume draft state inconsistent" };
    }
  } else if (state.brainstormed !== true || state.adversary_fired !== true || state.spec_status !== "adversary-reviewed") {
    return { ok: false, reason: "resume spec review missing" };
  }
  if (typeof state.spec_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(state.spec_sha256) ||
      (!draft && (state.adversary_spec_sha256 !== state.spec_sha256 || state.reviewed_spec_sha256 !== state.spec_sha256))) {
    return { ok: false, reason: "resume spec seal invalid" };
  }

  const specPath = piSpecPath({ projectRoot: root, featureId: state.feature_id });
  const planPath = piExecutionPlanPath({ projectRoot: root, featureId: state.feature_id });
  if (!specPath.ok || !planPath.ok) return { ok: false, reason: "resume plan identity invalid" };
  const spec = readOwnedFile(root, specPath.path);
  if (!spec.ok) return { ok: false, reason: "resume spec missing" };
  if (sha256(spec.text) !== state.spec_sha256) return { ok: false, reason: "resume spec hash mismatch" };
  const planFile = readOwnedFile(root, planPath.path);
  if (!planFile.ok && (!planFile.absent || hasPostPlanEvidence(root, statePath.path, state))) {
    return { ok: false, reason: "resume plan missing" };
  }
  let legacyPlan;
  if (planFile.ok) {
    const parsedPlan = parseJson(planFile.text, "resume plan invalid");
    if (!parsedPlan.ok) return parsedPlan;
    const currentPlan = validatePlan(parsedPlan.value, {
      expect: "full",
      expectedModelStrategy: CURRENT_PI_MODEL_STRATEGY,
    });
    legacyPlan = currentPlan.ok ? null : validatePlan(parsedPlan.value, {
      expect: "full",
      expectedModelStrategy: LEGACY_PI_MODEL_STRATEGY,
    });
    if ((!currentPlan.ok && !legacyPlan?.ok) || parsedPlan.value.feature_id !== state.feature_id || String(parsedPlan.value.mode).toUpperCase() !== stateMode) {
      return { ok: false, reason: "resume plan invalid" };
    }
  }
  const finished = asStringArray(state.hand_finished, "resume hand state invalid");
  const pendingRegates = asStringArray(state.regate_pending, "resume hand state invalid");
  const passedRegates = asStringArray(state.regate_passed, "resume hand state invalid");
  if (!finished.ok || !pendingRegates.ok || !passedRegates.ok) return { ok: false, reason: "resume hand state invalid" };
  // Estrutura válida não prova aprovação do plan-reviewer; hand_finished não prova
  // captura ou review atual. Não forneça uma fase calculada de marcas parciais:
  // o pai reconcilia os artefatos com a conversa e os gates reais continuam ativos.
  const envelope = {
    schema: "harness.parent-recovery.v1", session_id: sessionId, feature_id: state.feature_id,
    stage: draft ? "draft" : planFile.ok ? "plan" : "pre-plan",
    spec_approval: "not_verified_by_recovery",
    ...(planFile.ok ? {
      canonical_plan_path: path.relative(root, planPath.path),
      canonical_plan_sha256: sha256(planFile.text),
    } : {}),
    plan_approval: "not_verified_by_recovery",
    spec_path: path.relative(root, specPath.path),
    gate_state_path: path.relative(root, statePath.path),
    session_file: path.relative(root, transcript.sessionFile),
    ...(draft ? {
      resume_guidance: "Continue the incomplete specification in this same conversation. Resolve requirements from their actual sources; recovery does not grant approval. Reconcile native review evidence and obtain the current spec seal before dispatching the planner or any implementation. Then have the planner reconcile any existing plan with the current specification and model route, and obtain its current review.",
    } : !planFile.ok ? {
      resume_guidance: "The current spec seal is intact and no canonical plan exists yet. Continue with the native planner and plan review. Recovery does not create a plan or approve implementation.",
    } : {}),
    ...(legacyPlan?.ok && !draft ? {
      model_route_status: "legacy-plan-reviewer-sol",
      model_route_reconciliation: "Dispatch the planner to change only model_strategy.plan-reviewer to Astra while preserving the sealed spec and tasks, revalidate the JSON, then have Astra review the new hash. Do not reuse plan approval or infer progress from the rewritten plan.",
    } : {}),
  };
  return {
    ok: true, root, sessionId, sessionFile: transcript.sessionFile, statePath: statePath.path,
    ...(planFile.ok ? { planPath: planPath.path } : {}), specPath: specPath.path,
    context: `<HARNESS_PARENT_RECOVERY>\n${JSON.stringify(envelope)}\n</HARNESS_PARENT_RECOVERY>`,
  };
}

export { CURRENT_PI_MODEL_STRATEGY, LEGACY_PI_MODEL_STRATEGY };

function ensureLocalStateRoot(realRoot) {
  let cursor = realRoot;
  try {
    for (const segment of [".pi", "harness", "state"]) {
      cursor = path.join(cursor, segment);
      try {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          return { ok: false, reason: "parent worktree lock path invalid" };
        }
      } catch (error) {
        if (!error || typeof error !== "object" || error.code !== "ENOENT") {
          return { ok: false, reason: "parent worktree lock path invalid" };
        }
        fs.mkdirSync(cursor);
      }
    }
    return { ok: true, path: cursor };
  } catch {
    return { ok: false, reason: "parent worktree lock failed" };
  }
}

function validWorktreeLockOwner(owner) {
  return owner && typeof owner === "object" && !Array.isArray(owner) &&
    typeof owner.token === "string" && owner.token.length > 0 &&
    Number.isInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.process_start_ticks === "string" && owner.process_start_ticks.length > 0 &&
    typeof owner.hostname === "string" && owner.hostname.length > 0 &&
    typeof owner.createdAt === "string" && Number.isFinite(Date.parse(owner.createdAt)) &&
    (owner.session_id === null || isSafeSessionId(owner.session_id));
}

/** null proves ESRCH/ENOENT; undefined means the host could not determine identity. */
function parentProcessIdentity(pid) {
  if (process.platform === "linux") {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      if (!fields[0] || !fields[19]) return undefined;
      return { pid, state: fields[0], start: fields[19] };
    } catch (error) {
      return error?.code === "ENOENT" ? null : undefined;
    }
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return null;
    return undefined;
  }
  return undefined;
}

/**
 * Exclusividade operacional por worktree. Não é fronteira de segurança; serializa pais honestos
 * fresh/resume sobre a mesma implementação. sessionId é apenas diagnóstico, nunca a chave.
 * Resume exato pode substituir um lock órfão somente quando a identidade de início prova que o
 * processo antigo morreu ou o PID foi reutilizado. Fresh/foreign/live/indeterminado negam.
 */
export function acquirePiParentWorktreeLock(projectRoot, {
  sessionId = null,
  pid = process.pid,
  hostname = localHostname(),
  processIdentityFn = parentProcessIdentity,
} = {}) {
  if ((sessionId !== null && !isSafeSessionId(sessionId)) || !Number.isInteger(pid) || pid <= 0 ||
    typeof hostname !== "string" || !hostname) {
    return { ok: false, reason: "parent worktree lock identity invalid" };
  }
  let realRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch {
    return { ok: false, reason: "parent worktree lock path invalid" };
  }
  const expectedState = piStateRoot(realRoot);
  if (!expectedState.ok) return { ok: false, reason: "parent worktree lock path invalid" };
  const stateRoot = ensureLocalStateRoot(realRoot);
  if (!stateRoot.ok || stateRoot.path !== expectedState.path) return stateRoot;
  const lockPath = path.join(stateRoot.path, "parent-orchestrator.lock");
  const guardPath = `${lockPath}.guard`;
  const token = randomUUID();
  const identity = processIdentityFn(pid);
  if (!identity || identity.pid !== pid || typeof identity.start !== "string" || !identity.start || /^[ZX]/.test(identity.state ?? "")) {
    return { ok: false, reason: "parent worktree lock process identity unavailable" };
  }
  const owner = {
    token,
    pid,
    process_start_ticks: identity.start,
    hostname,
    session_id: sessionId,
    createdAt: new Date().toISOString(),
  };
  const release = () => compareAndDeleteLock(lockPath, token);
  const guardToken = randomUUID();

  try {
    fs.writeFileSync(guardPath, JSON.stringify({ token: guardToken, pid, createdAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    return { ok: false, reason: "parent orchestrator already active for worktree" };
  }

  try {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(owner), {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
      return { ok: true, path: lockPath, release };
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        return { ok: false, reason: "parent worktree lock failed" };
      }
    }

    let existing;
    try {
      if (fs.lstatSync(lockPath).isSymbolicLink()) {
        return { ok: false, reason: "parent worktree lock invalid" };
      }
      existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      return { ok: false, reason: "parent worktree lock invalid" };
    }
    if (!validWorktreeLockOwner(existing)) {
      return { ok: false, reason: "parent worktree lock invalid" };
    }
    const exactResume = sessionId !== null && existing.session_id === sessionId && existing.hostname === hostname;
    const priorIdentity = exactResume ? processIdentityFn(existing.pid) : null;
    const priorEnded = exactResume && (priorIdentity === null || (
      priorIdentity && (/^[ZX]/.test(priorIdentity.state ?? "") || priorIdentity.start !== existing.process_start_ticks)
    ));
    if (!priorEnded) return { ok: false, reason: "parent orchestrator already active for worktree" };
    if (!compareAndDeleteLock(lockPath, existing.token)) return { ok: false, reason: "parent worktree lock changed during resume" };
    try {
      fs.writeFileSync(lockPath, JSON.stringify(owner), { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { ok: true, path: lockPath, release, recovered: true };
    } catch {
      return { ok: false, reason: "parent worktree lock changed during resume" };
    }
  } finally {
    compareAndDeleteLock(guardPath, guardToken);
  }
}

/** @deprecated Compatibility alias; lock scope is the worktree, not the session. */
export function acquirePiParentSessionLock(projectRoot, sessionId, pid) {
  return acquirePiParentWorktreeLock(projectRoot, { sessionId, pid });
}
