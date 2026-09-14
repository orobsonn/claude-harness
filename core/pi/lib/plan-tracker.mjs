const SCHEMA_VERSION = 1;
const MAX_TASKS = 20;
const MAX_TITLE_LENGTH = 120;
const MAX_TASK_TITLE_LENGTH = 160;
const MAX_NOTE_LENGTH = 240;
const TASK_STATUSES = new Set(["pending", "in_progress", "completed", "blocked"]);
const VALIDATION_STATUSES = new Set(["pending", "running", "passed", "failed"]);

function clone(snapshot) {
  return snapshot ? structuredClone(snapshot) : undefined;
}

function text(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength
    ? value.trim()
    : undefined;
}

function validTask(task) {
  return task
    && typeof task.id === "string"
    && /^t\d+$/.test(task.id)
    && text(task.title, MAX_TASK_TITLE_LENGTH)
    && TASK_STATUSES.has(task.status)
    && (task.status !== "blocked" || text(task.note, MAX_NOTE_LENGTH))
    && (task.validationStatus === undefined || VALIDATION_STATUSES.has(task.validationStatus));
}

export function isPlanSnapshot(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !text(value.planId, 80)) return false;
  if (!Number.isInteger(value.revision) || value.revision < 1) return false;
  if (!text(value.title, MAX_TITLE_LENGTH) || !Array.isArray(value.tasks)) return false;
  if (value.tasks.length < 1 || value.tasks.length > MAX_TASKS || !value.tasks.every(validTask)) return false;
  const ids = new Set(value.tasks.map((task) => task.id));
  return ids.size === value.tasks.length;
}

function rejected(snapshot, error) {
  return { ok: false, error, snapshot: clone(snapshot) };
}

export function applyPlanAction(snapshot, action, { now = Date.now } = {}) {
  if (!action || typeof action !== "object") return rejected(snapshot, "invalid-action");

  if (action.action === "record") {
    if (snapshot && action.replace !== true) return rejected(snapshot, "replace-required");
    const title = text(action.title, MAX_TITLE_LENGTH);
    if (!title || !Array.isArray(action.tasks) || action.tasks.length < 1 || action.tasks.length > MAX_TASKS) {
      return rejected(snapshot, "invalid-plan");
    }
    const tasks = action.tasks.map((task) => {
      if (typeof task === "string") {
        const title = text(task, MAX_TASK_TITLE_LENGTH);
        return title ? { title } : undefined;
      }
      const title = text(task?.title, MAX_TASK_TITLE_LENGTH);
      if (!title || (task.validation !== undefined && typeof task.validation !== "boolean")) return undefined;
      return { title, validation: task.validation === true };
    });
    if (tasks.some((task) => !task)) return rejected(snapshot, "invalid-task");
    return {
      ok: true,
      snapshot: {
        schemaVersion: SCHEMA_VERSION,
        planId: `plan-${now().toString(36)}`,
        revision: 1,
        title,
        tasks: tasks.map((task, index) => ({
          id: `t${index + 1}`,
          title: task.title,
          status: "pending",
          ...(task.validation ? { validationStatus: "pending" } : {}),
        })),
      },
    };
  }

  if ((action.action !== "update" && action.action !== "validate") || !snapshot || !isPlanSnapshot(snapshot)) {
    return rejected(snapshot, "missing-plan");
  }
  if (action.planId !== snapshot.planId) return rejected(snapshot, "stale-plan");
  if (action.revision !== snapshot.revision) return rejected(snapshot, "stale-revision");
  const index = snapshot.tasks.findIndex((task) => task.id === action.taskId);
  if (index === -1) return rejected(snapshot, "unknown-task");

  if (action.action === "validate") {
    if (!VALIDATION_STATUSES.has(action.validationStatus)) return rejected(snapshot, "invalid-validation-status");
    if (snapshot.tasks[index].validationStatus === undefined) return rejected(snapshot, "validation-not-required");
    if (snapshot.tasks[index].status !== "completed") return rejected(snapshot, "validation-requires-completed-task");
    if (snapshot.tasks[index].validationStatus === "passed" && action.validationStatus !== "passed") {
      return rejected(snapshot, "passed-validation-immutable");
    }
    const note = action.validationStatus === "failed" ? text(action.note, MAX_NOTE_LENGTH) : undefined;
    if (action.validationStatus === "failed" && !note) return rejected(snapshot, "failed-validation-requires-note");
    const next = clone(snapshot);
    next.revision += 1;
    next.tasks[index] = {
      ...next.tasks[index],
      validationStatus: action.validationStatus,
      ...(note ? { validationNote: note } : {}),
    };
    if (!note) delete next.tasks[index].validationNote;
    return { ok: true, snapshot: next };
  }

  if (!TASK_STATUSES.has(action.status)) return rejected(snapshot, "invalid-status");
  if (snapshot.tasks[index].status === "completed" && !["completed", "in_progress"].includes(action.status)) {
    return rejected(snapshot, "completed-task-immutable");
  }
  const note = action.status === "blocked" ? text(action.note, MAX_NOTE_LENGTH) : undefined;
  if (action.status === "blocked" && !note) return rejected(snapshot, "blocked-requires-note");

  const next = clone(snapshot);
  next.revision += 1;
  const resumed = snapshot.tasks[index].status === "completed" && action.status === "in_progress";
  next.tasks[index] = {
    ...next.tasks[index],
    status: action.status,
    ...(resumed && next.tasks[index].validationStatus !== undefined ? { validationStatus: "pending" } : {}),
    ...(note ? { note } : {}),
  };
  if (!note) delete next.tasks[index].note;
  if (resumed) delete next.tasks[index].validationNote;
  return { ok: true, snapshot: next };
}

export function restorePlanSnapshot(entries) {
  let snapshot;
  for (const entry of entries ?? []) {
    if (entry?.type === "custom" && entry.customType === "harness-plan-snapshot" && isPlanSnapshot(entry.data?.snapshot)) {
      snapshot = clone(entry.data.snapshot);
      continue;
    }
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult" || message.toolName !== "harness_plan") continue;
    const candidate = message.details?.snapshot;
    if (isPlanSnapshot(candidate)) snapshot = clone(candidate);
  }
  return snapshot;
}

export function formatPlanProgress(snapshot) {
  if (!snapshot || !isPlanSnapshot(snapshot)) return ["Sem plano ativo"];
  const completed = snapshot.tasks.filter((task) => task.status === "completed").length;
  const current = snapshot.tasks.filter((task) => task.status === "in_progress" && !task.activity);
  const waiting = snapshot.tasks.filter((task) => task.status === "in_progress" && task.activity);
  const blocked = snapshot.tasks.find((task) => task.status === "blocked");
  const implementation = blocked
    ? `Plano ${completed}/${snapshot.tasks.length} · bloqueado: ${blocked.title}`
    : current.length === 1
      ? `Plano ${completed}/${snapshot.tasks.length} · atual: ${current[0].title}`
      : current.length > 1
        ? `Plano ${completed}/${snapshot.tasks.length} · em andamento (${current.length}): ${current.map((task) => task.title).join(", ")}`
      : waiting.length
        ? `Plano ${completed}/${snapshot.tasks.length} · aguardando ${waiting.some(t => t.activity === "awaiting_inspection") ? "inspeção do resultado" : "integração"}: ${waiting.map(t => t.title).join(", ")}`
      : completed === snapshot.tasks.length
        ? `Plano ${completed}/${snapshot.tasks.length} · concluído`
        : `Plano ${completed}/${snapshot.tasks.length} · pendente`;
  const validationTasks = snapshot.tasks.filter((task) => task.validationStatus !== undefined);
  if (validationTasks.length === 0) return [implementation];
  const passed = validationTasks.filter((task) => task.validationStatus === "passed").length;
  const running = validationTasks.filter((task) => task.validationStatus === "running");
  const failed = validationTasks.find((task) => task.validationStatus === "failed");
  const validation = failed
    ? `Validação ${passed}/${validationTasks.length} · falhou: ${failed.title}`
    : running.length === 1
      ? `Validação ${passed}/${validationTasks.length} · atual: ${running[0].title}`
      : running.length > 1
        ? `Validação ${passed}/${validationTasks.length} · em andamento (${running.length}): ${running.map((task) => task.title).join(", ")}`
      : passed === validationTasks.length
        ? `Validação ${passed}/${validationTasks.length} · aprovada`
        : `Validação ${passed}/${validationTasks.length} · pendente`;
  return [implementation, validation];
}

const taskLabels = {
  pending: "pendente",
  in_progress: "em andamento",
  completed: "concluída",
  blocked: "bloqueada",
};

const validationLabels = {
  pending: "pendente",
  running: "em andamento",
  passed: "aprovada",
  failed: "falhou",
};

/** @description Returns the concise, model-readable ledger after every tracker mutation. */
export function formatPlanResult(snapshot) {
  if (!snapshot || !isPlanSnapshot(snapshot)) return "Sem plano ativo";
  return [
    ...formatPlanProgress(snapshot),
    `planId: ${snapshot.planId}`,
    `revision: ${snapshot.revision}`,
    ...snapshot.tasks.map((task) => [
      `${task.id}: ${task.title} · ${task.activity === "awaiting_inspection" ? "processo encerrado; aguardando inspeção" : task.activity === "awaiting_integration" ? "pronta para integrar" : taskLabels[task.status]}`,
      task.canonicalTaskId ? `task: ${task.canonicalTaskId}` : undefined,
      task.note,
      task.validationStatus === undefined ? undefined : `validação: ${validationLabels[task.validationStatus]}`,
    ].filter(Boolean).join(" · ")),
  ].join("\n");
}
