import fs from "node:fs";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  appendBridgeEvent,
  claimBridgeSession,
  consumeInbox,
  markDecisionApplied,
  readBridge,
} from "../../control-plane/lib/protocol.mjs";
import { isChildSession, piSessionId } from "../lib/pi-adapter-map.mjs";

const bindingDir = process.env.HARNESS_CONTROL_BINDING;
// The extension retains the path in its closure. Removing it from the process
// environment keeps product shell calls and descendant agents from inheriting
// the private control-plane location.
delete process.env.HARNESS_CONTROL_BINDING;

function result(value: any, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
    ...(isError ? { isError: true } : {}),
  };
}

function verifiedCompletionEvidence(cwd: string, sessionId: string) {
  const root = fs.realpathSync(cwd);
  const relative = path.join(".pi", "harness", "state", sessionId, "gate-state.json");
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    const info = fs.lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error("completed evidence path may not contain symlinks");
  }
  const info = fs.statSync(cursor);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("completed evidence must be a small regular gate-state file");
  const state = JSON.parse(fs.readFileSync(cursor, "utf8"));
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      state.session_id !== sessionId || state.final_review_done !== true) {
    throw new Error("completed requires host-owned final_review_done for this exact session");
  }
  return `${relative}#final_review_done`;
}

/** Optional bridge owned by the general-agent control plane. It is inert unless
 * the trusted launcher environment names a pre-created private binding. */
export default function harnessControlPlane(pi: ExtensionAPI) {
  if (!bindingDir) return;
  if (!bindingDir.startsWith("/")) throw new Error("HARNESS_CONTROL_BINDING must be absolute");

  let claimedSession: string | null = null;
  let claimedCwd: string | null = null;
  let claimedGeneration: number | null = null;

  pi.on("session_start", async (_event, ctx: any) => {
    if (isChildSession(ctx)) return;
    try {
      const sessionId = piSessionId(ctx);
      if (!sessionId || typeof ctx?.cwd !== "string") throw new Error("control bridge requires real parent session identity");
      const claim = await claimBridgeSession(bindingDir, { cwd: ctx.cwd, sessionId });
      claimedSession = sessionId;
      claimedCwd = ctx.cwd;
      claimedGeneration = claim.event.generation;
    } catch (error) {
      ctx?.ui?.notify?.(`[harness-control-plane] ${error instanceof Error ? error.message : String(error)}`, "error");
      ctx?.shutdown?.();
    }
  });

  pi.on("before_agent_start", (event: any, ctx: any) => {
    if (isChildSession(ctx) || !claimedSession || piSessionId(ctx) !== claimedSession) return;
    return { systemPrompt: `${event.systemPrompt}\n\nThis global parent is controlled through a narrow durable bridge. Keep all internal dispatch, review, testing and shipping inside the harness. Never claim that the operator approved something unless an inbox record with origin=operator, this exact session, decision id and revision says so. Use harness_control_bridge to open decisions, read the inbox, acknowledge application with evidence, and publish only material outcome events. A terminal exit is not delivery success, and a draft PR is an available result, never merge authority.` };
  });

  pi.on("session_shutdown", async () => {
    if (!claimedSession || !claimedCwd || claimedGeneration === null) return;
    try {
      const bridge = readBridge(bindingDir, { cwd: claimedCwd, sessionId: claimedSession, generation: claimedGeneration });
      await appendBridgeEvent(bindingDir, {
        cwd: claimedCwd,
        sessionId: claimedSession,
        generation: claimedGeneration,
        type: "session.stopped",
        eventId: `g${bridge.generation}-session-stopped`,
        payload: { completion: "not-implied" },
      });
    } catch {
      // Shutdown cannot recover a broken bridge. Absence of this event remains unknown.
    }
  });

  pi.on("tool_result", (event: any) => {
    if (event.toolName === "harness_control_bridge" && event.details?.ok === false) return { isError: true };
  });

  pi.registerTool({
    name: "harness_control_bridge",
    label: "Control plane bridge",
    description: "Global-parent-only durable bridge. Read operator messages from inbox; open versioned decisions; confirm an exact response was applied with evidence; or publish a material blocked/failed/milestone/PR/completed event. It never dispatches tasks, merges, deploys, cleans up, or grants operator authority.",
    parameters: Type.Object({
      action: Type.Union([
        "inbox", "decision-opened", "decision-applied", "blocked", "failed", "milestone", "pr-available", "completed",
      ].map((value) => Type.Literal(value))),
      event_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      decision_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
      summary: Type.Optional(Type.String({ maxLength: 4000 })),
      options: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { minItems: 1, maxItems: 8 })),
      recommendation: Type.Optional(Type.String({ maxLength: 2000 })),
      message_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      detail: Type.Optional(Type.String({ maxLength: 4000 })),
      url: Type.Optional(Type.String({ maxLength: 2048 })),
      draft: Type.Optional(Type.Boolean()),
      head_sha: Type.Optional(Type.String({ maxLength: 64 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_callId, input: any, _signal, _update, ctx: any) {
      try {
        if (isChildSession(ctx)) return result({ ok: false, reason: "control bridge is global-parent-only" }, true);
        const sessionId = piSessionId(ctx);
        if (!claimedSession || claimedGeneration === null || sessionId !== claimedSession || ctx.cwd !== claimedCwd) return result({ ok: false, reason: "control bridge parent identity mismatch" }, true);
        if (input.action === "inbox") {
          const messages = await consumeInbox(bindingDir, { cwd: ctx.cwd, sessionId, generation: claimedGeneration });
          return result({ ok: true, messages });
        }
        if (input.action === "decision-applied") {
          const applied = await markDecisionApplied(bindingDir, {
            cwd: ctx.cwd, sessionId, generation: claimedGeneration, messageId: input.message_id,
            decisionId: input.decision_id, revision: input.revision, evidence: input.evidence,
          });
          return result({ ok: true, event: applied.event, replay: applied.replay });
        }
        let type: string;
        let payload: any;
        if (input.action === "decision-opened") {
          if (!input.decision_id || !input.revision || !input.summary || !Array.isArray(input.options)) throw new Error("decision-opened requires id, revision, summary and options");
          type = "decision.opened";
          payload = { decision_id: input.decision_id, revision: input.revision, summary: input.summary, options: input.options, recommendation: input.recommendation ?? null };
        } else if (input.action === "pr-available") {
          if (!input.url || typeof input.draft !== "boolean" || !input.head_sha || !input.evidence) throw new Error("pr-available requires url, draft, head_sha and evidence");
          let parsedUrl: URL;
          try { parsedUrl = new URL(input.url); } catch { throw new Error("pr-available url must be absolute HTTPS"); }
          if (parsedUrl.protocol !== "https:" || !/^[0-9a-f]{40}$/i.test(input.head_sha)) {
            throw new Error("pr-available requires an HTTPS url and a 40-character Git head sha");
          }
          type = "result.pr-available";
          payload = { url: input.url, draft: input.draft, head_sha: input.head_sha, evidence: input.evidence };
        } else if (input.action === "completed") {
          type = "result.completed";
          payload = {
            detail: input.detail ?? "delivery completed",
            evidence: verifiedCompletionEvidence(ctx.cwd, sessionId),
          };
        } else {
          type = input.action === "blocked" ? "delivery.blocked" : input.action === "failed" ? "delivery.failed" : "delivery.milestone";
          if (!input.detail) throw new Error(`${input.action} requires detail`);
          payload = { detail: input.detail, ...(input.evidence ? { evidence: input.evidence } : {}) };
        }
        const eventId = input.event_id || (type === "decision.opened" ? `decision-${input.decision_id}-r${input.revision}` : undefined);
        if (!eventId) throw new Error("event_id required for this action");
        const appended = await appendBridgeEvent(bindingDir, { cwd: ctx.cwd, sessionId, generation: claimedGeneration, type, eventId, payload });
        return result({ ok: true, event: appended.event, replay: appended.replay });
      } catch (error) {
        return result({ ok: false, reason: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  });
}
