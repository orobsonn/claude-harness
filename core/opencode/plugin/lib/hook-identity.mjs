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

/** @description First present alias value wins — tolerant of disagreeing aliases (#484). */
function oneIdentity(values) {
  return { ok: true, value: values[0] ?? "" };
}

/** @description Resolve one identity dimension; the trusted tier always wins over untrusted. */
export function resolveIdentityAliases({
  trusted,
  untrusted,
  aliases,
  extraTrusted = [],
  extraUntrusted = [],
}) {
  const trustedResult = oneIdentity([...aliasValues(trusted, aliases), ...extraTrusted]);
  const untrustedResult = oneIdentity([...aliasValues(untrusted, aliases), ...extraUntrusted]);
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
    // subagent_type is the canonical role field the host stamps; it must win when a role
    // alias disagrees with a looser agent/agentType alias (#484).
    role: ["subagent_type", "subagentType", "subagent", "agent", "agentType", "agent_type"],
  };
  const result = {};
  for (const [label, aliases] of Object.entries(dimensions)) {
    const trustedTaskId =
      label === "taskId"
        ? aliasValues(input, ["task_id"]).filter((v) => TASK_ID.test(v))
        : [];
    // The brief embeds its task id in the prompt's HARNESS_TASK_CONTEXT marker — that is
    // the ONE thing a dispatcher cannot silently swap without also rewriting the prompt
    // text. Untrusted dispatch args (taskId/task) disagreeing with it is not "just another
    // alias divergence" (#484 tolerance does not cover this): it decouples the fidelity/
    // scope gates from what the hand was actually briefed to do, laundering the frozen-test
    // fidelity check. Fail closed here; a genuinely trusted envelope task_id (extraTrusted
    // above) still wins over both, unaffected by this check.
    if (label === "taskId" && TASK_ID.test(promptTaskId)) {
      const argsTaskId = aliasValues(toolArgs, aliases)[0];
      if (argsTaskId && argsTaskId !== promptTaskId) {
        return {
          ok: false,
          reason: `taskId dispatch args diverge from the brief's HARNESS_TASK_CONTEXT marker: ${argsTaskId} != ${promptTaskId}`,
        };
      }
    }
    const resolved = resolveIdentityAliases({
      trusted: input,
      untrusted: toolArgs,
      aliases,
      extraTrusted: trustedTaskId,
      extraUntrusted: label === "taskId" && TASK_ID.test(promptTaskId) ? [promptTaskId] : [],
    });
    result[label] = resolved.value;
    result[`${label}Source`] = resolved.source;
  }
  return { ok: true, ...result };
}

export default { resolveIdentityAliases, resolveHookIdentity };
