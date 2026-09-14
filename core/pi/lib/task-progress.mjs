/** Informational projection of canonical task identities and native receipts. */
import fs from "node:fs";
import path from "node:path";
import { loadPiGateStateFromDisk } from "./pi-gate-state.mjs";
import { readTaskPlanAuthority } from "./task-plan-recovery.mjs";
import { readTaskProcess } from "./task-process.mjs";
import { hashTaskReceipt } from "./task-contract.mjs";

function read(root, file) {
  const target = path.join(root, file);
  if (!fs.existsSync(target)) return null;
  if (fs.realpathSync(target) !== target || !fs.statSync(target).isFile() || fs.statSync(target).size > 4 * 1024 * 1024) throw new Error("Unsafe task progress state");
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

/** This is historical task progress, not authorization to ship the current tree. */
function integrated(entry, registry) {
  const receipt = entry.integration, result = entry.result;
  return receipt?.written_by === "host-task-integration" && result?.written_by === "host-task-inspection" &&
    receipt.result_sha256 === hashTaskReceipt(result) && receipt.child_head === result.child_head &&
    [receipt, result].every(r => r.parent_session_id === registry.parent_session_id && r.feature_id === registry.feature_id &&
      r.task_id === entry.task_id && r.attempt_id === entry.attempt_id && r.plan_sha256 === registry.plan_sha256 && r.spec_sha256 === registry.spec_sha256);
}

export function projectTaskProgress(plan, registry, { readProcess = readTaskProcess } = {}) {
  return plan.tasks.map(task => {
    const base = { canonicalTaskId: task.id, title: task.title.slice(0, 160), status: "pending", validationStatus: "pending" };
    const entry = registry?.tasks?.[task.id];
    if (!entry) return base;
    if (entry.task_id !== task.id || entry.parent_session_id !== registry.parent_session_id || entry.feature_id !== registry.feature_id)
      return { ...base, status: "blocked", note: "Identidade da tarefa inconsistente." };
    if (entry.status === "integrated") return integrated(entry, registry)
      ? { ...base, status: "completed", validationStatus: "passed" }
      : { ...base, status: "blocked", note: "Recibo de integração inconsistente; confira o estado da tarefa." };
    if (entry.status === "blocked") return { ...base, status: "blocked", note: String(entry.reason || "Tarefa bloqueada; consulte o diagnóstico.").slice(0, 240) };
    if (entry.status === "ready") return { ...base, status: "in_progress", activity: "awaiting_integration" };
    if (entry.status === "running") {
      const launch = entry.launches?.at(-1);
      if (!launch) return { ...base, status: "blocked", note: "Lançamento não registrado." };
      const process = readProcess(launch);
      if (process.terminal) return { ...base, status: "in_progress", activity: "awaiting_inspection" };
      if (!process.ok) return { ...base, status: "blocked", note: "Não foi possível confirmar o processo; consulte o estado da tarefa." };
      return { ...base, status: "in_progress" };
    }
    return base;
  });
}

export function readCanonicalTaskProgress(projectRoot, sessionId, dependencies = {}) {
  try {
    const loaded = loadPiGateStateFromDisk(projectRoot, { sessionId });
    const state = loaded.state;
    if (!loaded.ok || state?.session_id !== sessionId || state.task_pipeline_version !== 1 || state.task_run) return null;
    const approval = state.plan_review_evidence;
    const authority = (dependencies.readAuthority ?? readTaskPlanAuthority)({ projectRoot, sessionId, featureId: state.feature_id,
      planSha256: approval?.plan_sha256, specSha256: state.spec_sha256 });
    const registry = read(projectRoot, `.pi/harness/state/${sessionId}/task-runs/index.json`);
    if (registry && (registry.parent_session_id !== sessionId || registry.feature_id !== state.feature_id)) return null;
    return { featureId: state.feature_id, tasks: projectTaskProgress(authority.plan, registry, dependencies) };
  } catch { return null; }
}

/** Rebuild from explicit canonical IDs; never infer correspondence from titles or tN. */
export function reconcileTaskProgress(snapshot, progress) {
  if (!progress?.tasks?.length || progress.tasks.length > 20) return snapshot;
  const next = { schemaVersion: 1, planId: snapshot?.planId ?? `canonical-${hashTaskReceipt({ feature: progress.featureId }).slice(0, 24)}`,
    revision: snapshot?.revision ?? 1, title: snapshot?.title ?? `Entrega ${progress.featureId}`.slice(0, 120),
    tasks: progress.tasks.map((task, i) => ({ id: `t${i + 1}`, ...task })) };
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return snapshot;
  if (snapshot) next.revision++;
  return next;
}
