/** @description Resolve an official child Task identity to exactly one durable parent-call record. */

import { bindChildSession, readBoundDispatchForChild, readDispatchRecord } from "../../lib/dispatch-scope.mjs";
import { isExecutorRole, isSniperRole, isTestAuthorRole } from "../../lib/roles.mjs";
import { isTaskTool } from "../../lib/task-dispatch-identity.mjs";

function data(response) {
  return response && typeof response === "object" && "data" in response ? response.data : response;
}

function writingRole(role) {
  return isExecutorRole(role) || isSniperRole(role) || isTestAuthorRole(role);
}

function sameFamily(left, right) {
  return (isExecutorRole(left) && isExecutorRole(right)) || (isSniperRole(left) && isSniperRole(right)) || (isTestAuthorRole(left) && isTestAuthorRole(right));
}

/** @description SDK adapter with injectable official session/message shapes. */
export function sdkIdentityReader(client, directory) {
  return {
    async getSession(sessionId) {
      if (typeof client?.session?.get !== "function") throw new Error("client.session.get unavailable");
      return data(await client.session.get({ path: { id: sessionId }, query: { directory } }));
    },
    async getMessages(sessionId) {
      if (typeof client?.session?.messages !== "function") throw new Error("client.session.messages unavailable");
      return data(await client.session.messages({ path: { id: sessionId }, query: { directory } }));
    },
  };
}

function toolRole(messages, sessionId, callId, toolName) {
  const matches = [];
  for (const bundle of Array.isArray(messages) ? messages : []) {
    const info = bundle?.info;
    for (const part of Array.isArray(bundle?.parts) ? bundle.parts : []) {
      if (part?.type === "tool" && part.callID === callId) matches.push({ info, part });
    }
  }
  if (matches.length !== 1) return { ok: false, conflict: true, reason: "tool call identity must match exactly one official part" };
  const { info, part } = matches[0];
  const role = typeof info?.agent === "string" ? info.agent : info?.mode;
  if (info?.role !== "assistant" || info?.sessionID !== sessionId || part?.sessionID !== sessionId || part?.messageID !== info?.id || typeof info?.parentID !== "string" || (toolName && String(part?.tool).toLowerCase() !== String(toolName).toLowerCase())) return { ok: false, conflict: true, reason: "official tool/session metadata conflicts" };
  const parents = messages.filter((bundle) => bundle?.info?.id === info.parentID && bundle?.info?.role === "user" && bundle?.info?.sessionID === sessionId);
  if (parents.length !== 1 || !writingRole(parents[0].info.agent) || !writingRole(role) || !sameFamily(parents[0].info.agent, role)) return { ok: false, conflict: true, reason: "official writing-hand message relationship conflicts" };
  return { ok: true, role: parents[0].info.agent };
}

function parentTask(messages, parentSessionId, childSessionId, role) {
  const matches = [];
  for (const bundle of Array.isArray(messages) ? messages : []) {
    const info = bundle?.info;
    for (const part of Array.isArray(bundle?.parts) ? bundle.parts : []) {
      const taskRole = part?.state?.input?.subagent_type;
      if (info?.role === "assistant" && info?.sessionID === parentSessionId && part?.type === "tool" && isTaskTool(part?.tool) && part?.sessionID === parentSessionId && part?.messageID === info?.id && part?.state?.status === "running" && part?.state?.metadata?.sessionId === childSessionId && typeof part?.callID === "string" && writingRole(taskRole)) matches.push({ callId: part.callID, role: taskRole });
    }
  }
  if (matches.length !== 1) return { ok: false, conflict: true, reason: "official parent Task metadata must match exactly one writing call" };
  if (!sameFamily(role, matches[0].role)) return { ok: false, conflict: true, reason: "child role conflicts with parent Task role" };
  return { ok: true, ...matches[0] };
}

function durableBoundFallback(projectRoot, runtimeSessionId, reason) {
  const bound = readBoundDispatchForChild(projectRoot, runtimeSessionId);
  if (bound.ok) return {
    ok: true,
    parentSessionId: bound.parentSessionId,
    runtimeSessionId,
    callId: bound.callId,
    role: bound.record.role,
    record: bound.record,
    recoveredFromDurableBinding: true,
  };
  if (bound.conflict === true) return { ok: false, conflict: true, verifiedWritingHand: true, reason: bound.reason };
  return { ok: false, unavailable: true, reason };
}

/** @description Resolve SDK/CLI identity, recovering only a unique host-bound durable child record when SDK reads fail. */
export async function resolveScopeRuntimeIdentity(projectRoot, input, options = {}) {
  const runtimeSessionId = typeof input?.sessionID === "string" ? input.sessionID : typeof input?.sessionId === "string" ? input.sessionId : "";
  const runtimeCallId = typeof input?.callID === "string" ? input.callID : typeof input?.callId === "string" ? input.callId : "";
  if (!runtimeSessionId || !runtimeCallId) return { ok: false, unavailable: true, reason: "runtime sessionID/callID unavailable" };
  const reader = options.reader ?? sdkIdentityReader(options.client, projectRoot);
  let session;
  try {
    session = await reader.getSession(runtimeSessionId);
  } catch { return durableBoundFallback(projectRoot, runtimeSessionId, "official SDK metadata unavailable");
  }
  if (!session || session.id !== runtimeSessionId) return { ok: false, conflict: true, reason: "official session identity conflicts" };
  let parentSessionId = typeof session.parentID === "string" ? session.parentID : "";
  const hasAdapterParent = typeof options.adapterParentSessionId === "string" && options.adapterParentSessionId && typeof options.adapterCallId === "string" && options.adapterCallId;
  if (!parentSessionId && !hasAdapterParent) return { ok: false, notWritingSession: true, reason: "top-level session has no dispatch parent" };
  let childMessages;
  try {
    childMessages = await reader.getMessages(runtimeSessionId);
  } catch { return durableBoundFallback(projectRoot, runtimeSessionId, "official SDK metadata unavailable");
  }
  const role = toolRole(childMessages, runtimeSessionId, runtimeCallId, input?.tool);
  if (!role.ok) return role;
  let callId = "";
  let parentRole = "";
  if (parentSessionId) {
    let parentMessages;
    try { parentMessages = await reader.getMessages(parentSessionId); } catch { return durableBoundFallback(projectRoot, runtimeSessionId, "official parent Task metadata unavailable"); }
    const parent = parentTask(parentMessages, parentSessionId, runtimeSessionId, role.role);
    if (!parent.ok) return parent;
    callId = parent.callId;
    parentRole = parent.role;
    const bound = bindChildSession(projectRoot, { parentSessionId, childSessionId: runtimeSessionId, role: parentRole, callId });
    if (!bound.ok) return { ok: false, conflict: true, verifiedWritingHand: true, reason: bound.reason };
  } else if (hasAdapterParent) {
    parentSessionId = options.adapterParentSessionId;
    callId = options.adapterCallId;
    parentRole = role.role;
    const bound = bindChildSession(projectRoot, { parentSessionId, childSessionId: runtimeSessionId, role: role.role, callId });
    if (!bound.ok) return { ok: false, conflict: true, verifiedWritingHand: true, reason: bound.reason };
  }
  const exact = readDispatchRecord(projectRoot, { parentSessionId, callId });
  if (!exact.ok && exact.conflict === true) return { ok: false, conflict: true, verifiedWritingHand: true, reason: exact.reason };
  if (!exact.ok) return { ok: false, verifiedWritingHand: true, exactRecordMissing: true, reason: exact.reason };
  if (exact.record.child_session_id !== runtimeSessionId || !sameFamily(role.role, exact.record.role) || !sameFamily(parentRole, exact.record.role)) return { ok: false, conflict: true, verifiedWritingHand: true, reason: "official child/call/role contradicts dispatch record" };
  return { ok: true, parentSessionId, runtimeSessionId, callId, role: role.role, record: exact.record };
}

export default { resolveScopeRuntimeIdentity, sdkIdentityReader };
