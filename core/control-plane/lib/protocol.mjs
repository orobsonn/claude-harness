import fs from "node:fs";
import path from "node:path";

import {
  appendJsonLine,
  assertPlainObject,
  assertPrivateDirectory,
  assertSafeId,
  atomicWriteJson,
  canonicalJson,
  ensurePrivateDirectory,
  readJsonLines,
  readPrivateJson,
  rejectSensitiveFields,
  sha256Json,
  withLock,
} from "./storage.mjs";

export const BRIDGE_SCHEMA = "harness.control.bridge.v1";
export const EVENT_SCHEMA = "harness.control.event.v1";
export const INBOX_SCHEMA = "harness.control.inbox.v1";
export const CONTROL_PROTOCOL = 1;

const EVENT_TYPES = new Set([
  "session.started",
  "session.stopped",
  "decision.opened",
  "decision.response-received",
  "decision.applied",
  "delivery.blocked",
  "delivery.failed",
  "delivery.milestone",
  "result.pr-available",
  "result.completed",
]);
const BRIDGE_KEYS = new Set([
  "schema", "protocol", "project_id", "delivery_id", "binding_token", "generation",
  "session_id", "cwd", "worktree_id", "created_at", "session_claimed_at",
  "inbox_source_generations", "resumed_at",
]);
const EVENT_KEYS = new Set([
  "schema", "type", "event_id", "project_id", "delivery_id", "session_id",
  "generation", "payload", "sequence", "occurred_at", "content_sha256",
]);
const INBOX_KEYS = new Set([
  "schema", "message_id", "origin", "project_id", "delivery_id", "session_id",
  "generation", "decision_id", "revision", "answer", "created_at", "sent_at",
]);

function exactPayloadKeys(payload, allowed, type) {
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${type} payload has unknown fields: ${unknown.join(", ")}`);
}

function boundedText(value, label, max, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} must be nonempty and at most ${max} characters`);
  }
}

function validateEventPayload(bridge, type, payload) {
  if (type === "session.started") {
    exactPayloadKeys(payload, ["cwd", "worktree_id"], type);
    if (payload.cwd !== bridge.cwd || payload.worktree_id !== bridge.worktree_id) {
      throw new Error("session.started payload does not match bridge identity");
    }
    return;
  }
  if (type === "session.stopped") {
    exactPayloadKeys(payload, ["completion"], type);
    if (payload.completion !== "not-implied") throw new Error("session.stopped cannot imply completion");
    return;
  }
  if (type === "decision.opened") {
    exactPayloadKeys(payload, ["decision_id", "revision", "summary", "options", "recommendation"], type);
    boundedText(payload.summary, "decision summary", 4000);
    if (!Array.isArray(payload.options) || payload.options.length < 1 || payload.options.length > 8 ||
        payload.options.some((option) => typeof option !== "string" || !option.trim() || option.length > 1000)) {
      throw new Error("decision options must contain 1..8 bounded strings");
    }
    if (payload.recommendation !== null) {
      boundedText(payload.recommendation, "decision recommendation", 2000, { optional: true });
    }
    return;
  }
  if (type === "decision.response-received") {
    exactPayloadKeys(payload, ["message_id", "decision_id", "revision"], type);
    return;
  }
  if (type === "decision.applied") {
    exactPayloadKeys(payload, ["message_id", "decision_id", "revision", "evidence"], type);
    boundedText(payload.evidence, "decision evidence", 1024);
    return;
  }
  if (["delivery.blocked", "delivery.failed", "delivery.milestone"].includes(type)) {
    exactPayloadKeys(payload, ["detail", "evidence"], type);
    boundedText(payload.detail, `${type} detail`, 4000);
    boundedText(payload.evidence, `${type} evidence`, 1024, { optional: true });
    return;
  }
  if (type === "result.pr-available") {
    exactPayloadKeys(payload, ["url", "draft", "head_sha", "evidence"], type);
    boundedText(payload.url, "PR url", 2048);
    if (typeof payload.draft !== "boolean" || !/^[0-9a-f]{40}$/i.test(payload.head_sha ?? "")) {
      throw new Error("PR payload requires draft boolean and 40-character head sha");
    }
    boundedText(payload.evidence, "PR evidence", 1024);
    return;
  }
  if (type === "result.completed") {
    exactPayloadKeys(payload, ["detail", "evidence"], type);
    boundedText(payload.detail, "completion detail", 4000);
    boundedText(payload.evidence, "completion evidence", 1024);
  }
}

function controlHomeFromDeliveryDir(deliveryDir) {
  const home = path.dirname(path.dirname(deliveryDir));
  if (path.basename(path.dirname(deliveryDir)) !== "deliveries") throw new Error("bridge is not under control home deliveries");
  assertPrivateDirectory(home);
  assertPrivateDirectory(path.join(home, "locks"));
  return home;
}

function validateBridge(value, deliveryDir) {
  assertPlainObject(value, "bridge");
  const unknown = Object.keys(value).filter((key) => !BRIDGE_KEYS.has(key));
  if (unknown.length) throw new Error(`bridge has unknown fields: ${unknown.join(", ")}`);
  if (value.schema !== BRIDGE_SCHEMA || value.protocol !== CONTROL_PROTOCOL) throw new Error("bridge protocol incompatible");
  for (const [key, label] of [["project_id", "project"], ["delivery_id", "delivery"], ["binding_token", "binding token"]]) {
    assertSafeId(value[key], label);
  }
  if (!Number.isInteger(value.generation) || value.generation < 1) throw new Error("bridge generation invalid");
  if (value.inbox_source_generations !== undefined &&
      (!Array.isArray(value.inbox_source_generations) || value.inbox_source_generations.some((entry) =>
        !Number.isInteger(entry) || entry < 1 || entry >= value.generation))) {
    throw new Error("bridge inbox generation history invalid");
  }
  if (!path.isAbsolute(value.cwd)) throw new Error("bridge cwd must be absolute");
  if (typeof value.worktree_id !== "string" || !value.worktree_id.trim() || value.worktree_id.length > 4096) {
    throw new Error("bridge worktree identity invalid");
  }
  if (value.session_id !== null) assertSafeId(value.session_id, "session id");
  if (value.delivery_id !== path.basename(deliveryDir)) throw new Error("bridge delivery path mismatch");
  rejectSensitiveFields(value);
  return value;
}

function validateInboxMessage(message, bridge) {
  assertPlainObject(message, "inbox message");
  const unknown = Object.keys(message).filter((key) => !INBOX_KEYS.has(key));
  if (unknown.length) throw new Error(`inbox message has unknown fields: ${unknown.join(", ")}`);
  if (message.schema !== INBOX_SCHEMA || message.origin !== "operator" ||
      message.project_id !== bridge.project_id || message.delivery_id !== bridge.delivery_id ||
      message.session_id !== bridge.session_id || !Number.isInteger(message.generation) ||
      message.generation < 1 || message.generation > bridge.generation) {
    throw new Error("inbox message identity mismatch");
  }
  assertSafeId(message.message_id, "message id");
  assertSafeId(message.decision_id, "decision id");
  if (!Number.isInteger(message.revision) || message.revision < 1) throw new Error("decision revision invalid");
  if (typeof message.answer !== "string" || !message.answer.trim() || Buffer.byteLength(message.answer) > 16 * 1024) {
    throw new Error("answer must be nonempty and at most 16 KiB");
  }
  rejectSensitiveFields(message);
  return message;
}

export function readBridge(deliveryDir, { cwd, sessionId, generation } = {}) {
  const canonical = assertPrivateDirectory(deliveryDir);
  const bridge = validateBridge(readPrivateJson(path.join(canonical, "bridge.json")), canonical);
  if (cwd !== undefined && fs.realpathSync(cwd) !== bridge.cwd) throw new Error("bridge cwd mismatch");
  if (sessionId !== undefined && bridge.session_id !== null && bridge.session_id !== sessionId) throw new Error("bridge session mismatch");
  if (generation !== undefined && bridge.generation !== generation) throw new Error("bridge generation mismatch");
  return bridge;
}

function normalizedEventIdentity(bridge, input) {
  if (!EVENT_TYPES.has(input.type)) throw new Error(`unsupported control event: ${input.type}`);
  assertSafeId(input.event_id, "event id");
  assertPlainObject(input.payload ?? {}, "event payload");
  rejectSensitiveFields(input.payload ?? {});
  validateEventPayload(bridge, input.type, input.payload ?? {});
  return {
    type: input.type,
    event_id: input.event_id,
    project_id: bridge.project_id,
    delivery_id: bridge.delivery_id,
    session_id: bridge.session_id,
    generation: bridge.generation,
    payload: input.payload ?? {},
  };
}

function latestDecision(events, decisionId) {
  return events
    .filter((event) => event.type === "decision.opened" && event.payload?.decision_id === decisionId)
    .at(-1) ?? null;
}

function validateDecisionEvent(events, identity) {
  const payload = identity.payload;
  if (!identity.type.startsWith("decision.")) return;
  assertSafeId(payload.decision_id, "decision id");
  if (!Number.isInteger(payload.revision) || payload.revision < 1) throw new Error("decision revision invalid");
  const current = latestDecision(events, payload.decision_id);
  if (identity.type === "decision.opened") {
    if (typeof payload.summary !== "string" || !payload.summary.trim() ||
        !Array.isArray(payload.options) || payload.options.length < 1) {
      throw new Error("decision opening requires summary and options");
    }
    const expected = current ? current.payload.revision + 1 : 1;
    if (payload.revision !== expected) throw new Error(`decision revision must advance exactly to ${expected}`);
    return;
  }
  if (!current || current.payload.revision !== payload.revision) {
    throw new Error("decision response targets a stale or unknown revision");
  }
  assertSafeId(payload.message_id, "message id");
  if (identity.type === "decision.applied") {
    const received = events.find((event) => event.type === "decision.response-received" &&
      event.payload?.message_id === payload.message_id &&
      event.payload?.decision_id === payload.decision_id &&
      event.payload?.revision === payload.revision);
    if (!received) throw new Error("decision application requires the exact received response");
  }
}

function appendEventLocked(deliveryDir, bridge, input) {
  const eventsPath = path.join(deliveryDir, "events.jsonl");
  const events = readJsonLines(eventsPath);
  const identity = normalizedEventIdentity(bridge, input);
  const digest = sha256Json(identity);
  const existing = events.find((event) => event.event_id === input.event_id);
  if (existing) {
    if (existing.content_sha256 !== digest) throw new Error(`event id conflict: ${input.event_id}`);
    return { event: existing, replay: true };
  }
  validateDecisionEvent(events, identity);
  let previous = 0;
  for (const event of events) {
    if (!Number.isInteger(event.sequence) || event.sequence !== previous + 1) throw new Error("event sequence corrupt");
    previous = event.sequence;
  }
  const event = {
    schema: EVENT_SCHEMA,
    ...identity,
    sequence: previous + 1,
    occurred_at: new Date().toISOString(),
    content_sha256: digest,
  };
  appendJsonLine(eventsPath, event);
  return { event, replay: false };
}

export async function claimBridgeSession(deliveryDir, { cwd, sessionId }) {
  assertSafeId(sessionId, "session id");
  const home = controlHomeFromDeliveryDir(deliveryDir);
  return withLock(home, `bridge-${path.basename(deliveryDir)}`, async () => {
    const bridge = readBridge(deliveryDir, { cwd, sessionId });
    if (bridge.session_id === null) {
      bridge.session_id = sessionId;
      bridge.session_claimed_at = new Date().toISOString();
      atomicWriteJson(path.join(deliveryDir, "bridge.json"), bridge);
    }
    const current = readBridge(deliveryDir, { cwd, sessionId });
    return appendEventLocked(deliveryDir, current, {
      type: "session.started",
      event_id: `g${current.generation}-session-started`,
      payload: { cwd: current.cwd, worktree_id: current.worktree_id },
    });
  });
}

export async function appendBridgeEvent(deliveryDir, { cwd, sessionId, generation, type, eventId, payload = {} }) {
  assertSafeId(sessionId, "session id");
  const home = controlHomeFromDeliveryDir(deliveryDir);
  return withLock(home, `bridge-${path.basename(deliveryDir)}`, async () => {
    const bridge = readBridge(deliveryDir, { cwd, sessionId, generation });
    if (bridge.session_id !== sessionId) throw new Error("bridge session is not claimed by this parent");
    return appendEventLocked(deliveryDir, bridge, { type, event_id: eventId, payload });
  });
}

export function listBridgeEvents(deliveryDir) {
  const bridge = readBridge(deliveryDir);
  let expected = 1;
  return readJsonLines(path.join(deliveryDir, "events.jsonl")).map((event) => {
    const unknown = Object.keys(event).filter((key) => !EVENT_KEYS.has(key));
    if (unknown.length) throw new Error(`bridge event has unknown fields: ${unknown.join(", ")}`);
    if (event.schema !== EVENT_SCHEMA || event.project_id !== bridge.project_id || event.delivery_id !== bridge.delivery_id ||
        event.session_id !== bridge.session_id || !Number.isInteger(event.generation) || event.generation < 1 ||
        event.generation > bridge.generation || !EVENT_TYPES.has(event.type) ||
        !Number.isInteger(event.sequence) || event.sequence !== expected++) throw new Error("bridge event identity or sequence mismatch");
    assertSafeId(event.event_id, "event id");
    assertPlainObject(event.payload, "event payload");
    rejectSensitiveFields(event.payload);
    validateEventPayload(bridge, event.type, event.payload);
    const identity = {
      type: event.type,
      event_id: event.event_id,
      project_id: event.project_id,
      delivery_id: event.delivery_id,
      session_id: event.session_id,
      generation: event.generation,
      payload: event.payload,
    };
    if (sha256Json(identity) !== event.content_sha256) throw new Error("bridge event content conflict");
    return event;
  });
}

export async function enqueueInboxMessage(deliveryDir, message) {
  const home = controlHomeFromDeliveryDir(deliveryDir);
  return withLock(home, `bridge-${path.basename(deliveryDir)}`, async () => {
    const bridge = readBridge(deliveryDir);
    assertPlainObject(message, "inbox message");
    assertSafeId(message.message_id, "message id");
    assertSafeId(message.decision_id, "decision id");
    if (!Number.isInteger(message.revision) || message.revision < 1) throw new Error("decision revision invalid");
    if (typeof message.answer !== "string" || !message.answer.trim() || Buffer.byteLength(message.answer) > 16 * 1024) {
      throw new Error("answer must be nonempty and at most 16 KiB");
    }
    const semantic = {
      schema: INBOX_SCHEMA,
      message_id: message.message_id,
      origin: "operator",
      project_id: bridge.project_id,
      delivery_id: bridge.delivery_id,
      session_id: bridge.session_id,
      generation: bridge.generation,
      decision_id: message.decision_id,
      revision: message.revision,
      answer: message.answer,
    };
    const record = { ...semantic, created_at: message.created_at ?? new Date().toISOString() };
    validateInboxMessage(record, bridge);
    const inbox = ensurePrivateDirectory(path.join(deliveryDir, "inbox"));
    ensurePrivateDirectory(path.join(inbox, "handled"));
    const pending = path.join(inbox, `${record.message_id}.json`);
    const handled = path.join(inbox, "handled", `${record.message_id}.json`);
    const existingPath = fs.existsSync(pending) ? pending : fs.existsSync(handled) ? handled : null;
    if (existingPath) {
      const existing = validateInboxMessage(readPrivateJson(existingPath), bridge);
      const { created_at: ignoredCreated, sent_at: ignoredSent, ...existingSemantic } = existing;
      if (canonicalJson(existingSemantic) !== canonicalJson(semantic)) throw new Error(`message id conflict: ${record.message_id}`);
      return { message: existing, replay: true, handled: existingPath === handled };
    }
    atomicWriteJson(pending, record);
    return { message: record, replay: false, handled: false };
  });
}

export async function markInboxSent(deliveryDir, messageId) {
  const home = controlHomeFromDeliveryDir(deliveryDir);
  return withLock(home, `bridge-${path.basename(deliveryDir)}`, async () => {
    assertSafeId(messageId, "message id");
    const bridge = readBridge(deliveryDir);
    const pending = path.join(deliveryDir, "inbox", `${messageId}.json`);
    const handled = path.join(deliveryDir, "inbox", "handled", `${messageId}.json`);
    const target = fs.existsSync(pending) ? pending : fs.existsSync(handled) ? handled : null;
    if (!target) throw new Error("inbox message missing");
    const message = validateInboxMessage(readPrivateJson(target), bridge);
    if (!message.sent_at) {
      message.sent_at = new Date().toISOString();
      atomicWriteJson(target, message);
    }
    return message;
  });
}

export async function prepareBridgeResume(deliveryDir, { sessionId, nextGeneration }) {
  const home = controlHomeFromDeliveryDir(deliveryDir);
  return withLock(home, `bridge-${path.basename(deliveryDir)}`, async () => {
    const bridge = readBridge(deliveryDir, { sessionId });
    if (!Number.isInteger(nextGeneration) || nextGeneration !== bridge.generation + 1) {
      throw new Error("bridge resume generation must advance exactly once");
    }
    // The bridge atomically records which earlier generation's pending inbox
    // may be consumed after this exact-session resume. Messages themselves are
    // immutable, avoiding a multi-file transition that could tear on crash.
    const accepted = Array.isArray(bridge.inbox_source_generations)
      ? bridge.inbox_source_generations
      : [];
    if (accepted.some((value) => !Number.isInteger(value) || value < 1 || value >= nextGeneration)) {
      throw new Error("bridge inbox generation history invalid");
    }
    bridge.inbox_source_generations = [...new Set([...accepted, bridge.generation])];
    bridge.generation = nextGeneration;
    bridge.resumed_at = new Date().toISOString();
    atomicWriteJson(path.join(deliveryDir, "bridge.json"), bridge);
    return bridge;
  });
}

export function inboxMessages(deliveryDir) {
  const bridge = readBridge(deliveryDir);
  const inbox = path.join(deliveryDir, "inbox");
  const handled = path.join(inbox, "handled");
  const read = (dir, state) => fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ ...validateInboxMessage(readPrivateJson(path.join(dir, entry.name)), bridge), transport_state: state }));
  return [...read(inbox, "queued"), ...read(handled, "received")];
}

export async function consumeInbox(deliveryDir, { cwd, sessionId, generation }) {
  const home = controlHomeFromDeliveryDir(deliveryDir);
  return withLock(home, `bridge-${path.basename(deliveryDir)}`, async () => {
    const bridge = readBridge(deliveryDir, { cwd, sessionId, generation });
    if (bridge.session_id !== sessionId) throw new Error("bridge session is not claimed by this parent");
    const inbox = ensurePrivateDirectory(path.join(deliveryDir, "inbox"));
    const handled = ensurePrivateDirectory(path.join(inbox, "handled"));
    const messages = fs.readdirSync(inbox, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => validateInboxMessage(readPrivateJson(path.join(inbox, entry.name)), bridge))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const acceptedGenerations = new Set([bridge.generation, ...(bridge.inbox_source_generations ?? [])]);
    const accepted = [];
    for (const message of messages) {
      if (message.schema !== INBOX_SCHEMA || message.origin !== "operator" || message.project_id !== bridge.project_id ||
          message.delivery_id !== bridge.delivery_id || message.session_id !== bridge.session_id || !acceptedGenerations.has(message.generation)) {
        throw new Error("inbox message identity mismatch");
      }
      const currentDecision = latestDecision(readJsonLines(path.join(deliveryDir, "events.jsonl")), message.decision_id);
      // A reply belongs to the decision revision visible when it was sent. If
      // the parent revised the question before consuming it, retain the old
      // record for audit/recovery but never deliver it as an answer to the new
      // question.
      if (!currentDecision || currentDecision.payload.revision !== message.revision) continue;
      appendEventLocked(deliveryDir, bridge, {
        type: "decision.response-received",
        event_id: `received-${message.message_id}`,
        payload: { message_id: message.message_id, decision_id: message.decision_id, revision: message.revision },
      });
      fs.renameSync(path.join(inbox, `${message.message_id}.json`), path.join(handled, `${message.message_id}.json`));
      accepted.push(message);
    }
    return accepted;
  });
}

export async function markDecisionApplied(deliveryDir, { cwd, sessionId, generation, messageId, decisionId, revision, evidence }) {
  const home = controlHomeFromDeliveryDir(deliveryDir);
  return withLock(home, `bridge-${path.basename(deliveryDir)}`, async () => {
    const bridge = readBridge(deliveryDir, { cwd, sessionId, generation });
    assertSafeId(messageId, "message id");
    assertSafeId(decisionId, "decision id");
    if (!Number.isInteger(revision) || revision < 1) throw new Error("decision revision invalid");
    if (typeof evidence !== "string" || !evidence.trim() || evidence.length > 1024) throw new Error("decision evidence reference required");
    const handled = validateInboxMessage(
      readPrivateJson(path.join(deliveryDir, "inbox", "handled", `${messageId}.json`)), bridge,
    );
    const acceptedGenerations = new Set([bridge.generation, ...(bridge.inbox_source_generations ?? [])]);
    if (handled.session_id !== sessionId || !acceptedGenerations.has(handled.generation) || handled.decision_id !== decisionId || handled.revision !== revision) {
      throw new Error("decision application does not match the received response");
    }
    return appendEventLocked(deliveryDir, bridge, {
      type: "decision.applied",
      event_id: `applied-${messageId}`,
      payload: { message_id: messageId, decision_id: decisionId, revision, evidence },
    });
  });
}
