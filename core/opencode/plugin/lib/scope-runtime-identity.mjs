/** @description Resolve writing-hand parent authority and role from trusted OpenCode SDK metadata. */

import { bindAdapterSession, getChildSessionBinding } from "./dispatch-scope.mjs";
import { isExecutorRole, isSniperRole, isTestAuthorRole } from "./roles.mjs";

const resolvedCalls = new Map();

function rootCache(projectRoot) {
  let cache = resolvedCalls.get(projectRoot);
  if (!cache) {
    cache = new Map();
    resolvedCalls.set(projectRoot, cache);
  }
  return cache;
}

function callKey(sessionId, callId) {
  return `${sessionId}\0${callId}`;
}

function data(response) {
  return response && typeof response === "object" && "data" in response ? response.data : response;
}

function writingRole(role) {
  return isExecutorRole(role) || isSniperRole(role) || isTestAuthorRole(role);
}

/** @description SDK adapter with injectable seams for official session/message shapes. */
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

async function roleFromToolCall(reader, sessionId, callId, toolName) {
  if (typeof callId !== "string" || !callId) return { ok: false, reason: "runtime callID required for acting role" };
  try {
    const messages = await reader.getMessages(sessionId);
    if (!Array.isArray(messages)) return { ok: false, reason: "trusted session messages unavailable" };
    const matches = [];
    for (const bundle of messages) {
      const info = bundle?.info;
      const parts = Array.isArray(bundle?.parts) ? bundle.parts : [];
      for (const part of parts) {
        if (part?.type === "tool" && part.callID === callId) matches.push({ info, part });
      }
    }
    if (matches.length !== 1) return { ok: false, reason: `tool call identity must match exactly one part (found ${matches.length})` };
    const { info, part } = matches[0];
    if (info?.role !== "assistant" || info.sessionID !== sessionId || part.sessionID !== sessionId || part.messageID !== info.id || typeof info.parentID !== "string") {
      return { ok: false, reason: "tool part/message/session relationship conflicts" };
    }
    if (typeof toolName === "string" && toolName && String(part.tool).toLowerCase() !== toolName.toLowerCase()) {
      return { ok: false, reason: "tool part name conflicts with runtime hook" };
    }
    const parents = messages.filter((bundle) => bundle?.info?.id === info.parentID && bundle?.info?.role === "user" && bundle?.info?.sessionID === sessionId);
    if (parents.length !== 1 || !writingRole(parents[0].info.agent)) {
      return { ok: false, reason: "trusted user message writing-hand role missing" };
    }
    const assistantAgent = typeof info.agent === "string" ? info.agent : info.mode;
    if (!writingRole(assistantAgent)) return { ok: false, reason: "trusted assistant writing-hand role missing" };
    const sameAssistantFamily = (isExecutorRole(assistantAgent) && isExecutorRole(parents[0].info.agent)) ||
      (isSniperRole(assistantAgent) && isSniperRole(parents[0].info.agent)) ||
      (isTestAuthorRole(assistantAgent) && isTestAuthorRole(parents[0].info.agent));
    if (!sameAssistantFamily) return { ok: false, reason: "assistant/user role conflict" };
    return { ok: true, role: parents[0].info.agent };
  } catch {
    return { ok: false, reason: "trusted message metadata unavailable" };
  }
}

/** @description Invalidate one terminal tool call, or every cached call for a terminal session. */
export function invalidateScopeRuntimeIdentity(projectRoot, sessionId, callId) {
  const cache = resolvedCalls.get(projectRoot);
  if (!cache || typeof sessionId !== "string") return;
  if (typeof callId === "string" && callId) {
    cache.delete(callKey(sessionId, callId));
    return;
  }
  for (const key of cache.keys()) if (key.startsWith(`${sessionId}\0`)) cache.delete(key);
}

/** @description Resolve child->parent dispatch and canonical role without tool args/input.agent. */
export async function resolveScopeRuntimeIdentity(projectRoot, input, options = {}) {
  const runtimeSessionId = typeof input?.sessionID === "string" ? input.sessionID : typeof input?.sessionId === "string" ? input.sessionId : "";
  if (!runtimeSessionId) return { ok: false, reason: "runtime sessionID required" };
  const runtimeCallId = typeof input?.callID === "string" ? input.callID : typeof input?.callId === "string" ? input.callId : "";
  if (!runtimeCallId) return { ok: false, reason: "runtime callID required" };
  const cache = rootCache(projectRoot);
  const cached = cache.get(callKey(runtimeSessionId, runtimeCallId));
  if (cached) return cached;
  const reader = options.reader ?? sdkIdentityReader(options.client, projectRoot);
  let session;
  try { session = await reader.getSession(runtimeSessionId); } catch { return { ok: false, reason: "trusted session metadata unavailable" }; }
  if (!session || session.id !== runtimeSessionId) return { ok: false, reason: "trusted session identity mismatch" };
  const sessionContext = { runtimeSessionId, parentSessionId: typeof session.parentID === "string" ? session.parentID : "", boundRequired: typeof session.parentID === "string" && Boolean(session.parentID) };

  let bound;
  if (typeof session.parentID === "string" && session.parentID) {
    bound = getChildSessionBinding(projectRoot, runtimeSessionId, session.parentID);
  } else if (typeof options.adapterParentSessionId === "string" && typeof options.adapterToken === "string") {
    bound = bindAdapterSession(projectRoot, {
      parentSessionId: options.adapterParentSessionId,
      runtimeSessionId,
      token: options.adapterToken,
    });
  } else {
    return { ok: false, reason: "session is a verified top-level session without dispatch binding", notWritingSession: true, ...sessionContext };
  }
  if (!bound.ok) {
    // Child Task without writing-hand binding = eye/shipper/harvester/explore.
    // Do NOT force plan-write-gate identity fail-closed — only writing hands need bind.
    const sessionAgent = typeof session.agent === "string" ? session.agent : "";
    if (!writingRole(sessionAgent)) {
      return {
        ok: false,
        reason: bound.reason || "child session is not a writing-hand dispatch",
        notWritingSession: true,
        ...sessionContext,
      };
    }
    return { ...bound, ...sessionContext };
  }
  const role = await roleFromToolCall(reader, runtimeSessionId, runtimeCallId, input?.tool);
  if (!role.ok) return { ...role, ...sessionContext };
  if (!writingRole(bound.binding.role) || !writingRole(role.role)) return { ok: false, reason: "writing role identity missing" };
  const sameFamily = (isExecutorRole(bound.binding.role) && isExecutorRole(role.role)) ||
    (isSniperRole(bound.binding.role) && isSniperRole(role.role)) ||
    (isTestAuthorRole(bound.binding.role) && isTestAuthorRole(role.role));
  if (!sameFamily) return { ok: false, reason: "child role conflicts with parent dispatch" };
  const resolved = {
    ok: true,
    parentSessionId: bound.binding.parentSessionId,
    runtimeSessionId,
    callId: bound.binding.callId,
    token: bound.binding.token,
    role: role.role,
    adapter: bound.binding.adapter === true,
  };
  cache.set(callKey(runtimeSessionId, runtimeCallId), resolved);
  return resolved;
}

export default { invalidateScopeRuntimeIdentity, resolveScopeRuntimeIdentity, sdkIdentityReader };
