/** @description Resolve trusted runtime-envelope identity ahead of untrusted tool aliases. */

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function records(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value;
  const nested = record.input && typeof record.input === "object" && !Array.isArray(record.input)
    ? record.input
    : null;
  return nested ? [record, nested] : [record];
}

function aliasValues(source, aliases) {
  const values = [];
  for (const record of records(source)) {
    for (const alias of aliases) {
      const raw = record[alias];
      if (typeof raw === "string" && raw.trim().length > 0) values.push(raw.trim());
    }
  }
  return values;
}

function oneIdentity(label, values) {
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    return { ok: false, reason: `${label} identity aliases conflict (conflicts): ${distinct.join(" != ")}` };
  }
  return { ok: true, value: distinct[0] ?? "" };
}

/** @description Resolve one identity dimension; conflicts inside either trust tier fail closed. */
export function resolveIdentityAliases({
  label,
  trusted,
  untrusted,
  aliases,
  extraTrusted = [],
  extraUntrusted = [],
}) {
  const trustedResult = oneIdentity(label, [...aliasValues(trusted, aliases), ...extraTrusted]);
  if (!trustedResult.ok) return trustedResult;
  const untrustedResult = oneIdentity(label, [...aliasValues(untrusted, aliases), ...extraUntrusted]);
  if (!untrustedResult.ok) return untrustedResult;
  return {
    ok: true,
    value: trustedResult.value || untrustedResult.value,
    source: trustedResult.value ? "runtime-envelope" : untrustedResult.value ? "tool-input" : "missing",
  };
}

/**
 * @description Resolve all hook identities before a gate can progress or mutate arguments.
 * Official Task `command` / `task_id` are host resume fields — never harness role/plan-task.
 * Role: subagent_type + agent* aliases only. Plan task: runtime envelope + HARNESS_TASK_CONTEXT
 * (+ harness-only taskId/task aliases on tool args).
 */
export function resolveHookIdentity({ input, toolArgs, promptTaskId = "" } = {}) {
  const dimensions = {
    sessionId: ["sessionID", "sessionId", "session_id"],
    featureId: ["feature_id", "featureId", "feature"],
    // Do not read official Task.task_id from tool args (resume). Envelope may still stamp task_id.
    taskId: ["taskId", "task"],
    role: ["agent", "agentType", "agent_type", "subagent_type", "subagentType", "subagent"],
  };
  const result = {};
  for (const [label, aliases] of Object.entries(dimensions)) {
    const trustedTaskId =
      label === "taskId"
        ? aliasValues(input, ["task_id"]).filter((v) => TASK_ID.test(v))
        : [];
    const resolved = resolveIdentityAliases({
      label,
      trusted: input,
      untrusted: toolArgs,
      aliases,
      extraTrusted: trustedTaskId,
      extraUntrusted: label === "taskId" && TASK_ID.test(promptTaskId) ? [promptTaskId] : [],
    });
    if (!resolved.ok) return resolved;
    result[label] = resolved.value;
    result[`${label}Source`] = resolved.source;
  }
  return { ok: true, ...result };
}

export default { resolveIdentityAliases, resolveHookIdentity };
