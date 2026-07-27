/**
 * @description Structural mid-run obs for hand roles (executor/sniper/test-author).
 * before: task-executing (n/total from plan when possible)
 * after: hand-ran
 * The Task before/after boundary also owns writing-hand active_dispatch claims — best-effort:
 * a missing marker/session identity or a rejected claim never denies dispatch, it shadow-records
 * (logs) and continues. Evidence writes (hand-record, capture_verified) do not require claim
 * success — they only need a resolvable task_id/feature_id on the terminal writing-hand result.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";

const PREFIX = "[obs-hand]";

/**
 * @description Build before+after hooks for hand observability.
 */
export async function createObsHandHooks(
  dir?: string,
  deps: { client?: any } = {},
): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after" | "event">> {
  const {
    isHandRole,
    extractTaskIds,
    resolveHookArgs,
    eventForTaskExecuting,
    eventForHandRan,
    obsAppend,
    dedupeByType,
    taskIndexFromPlan,
    planDirForRun,
  } = await import("./lib/obs-emit.mjs");
  const { parseTaskDispatchIdentity } = await import("./lib/task-dispatch-identity.mjs");
  const { isExecutorRole, isSniperRole, isTestAuthorRole } = await import("./lib/roles.mjs");
  const { appendTerminalScopeDiagnostic, bindChildSession, claimActiveDispatch, finishActiveDispatch, getChildSessionBinding, getProcessChildBinding, markDispatchBindingPending, reconcileCleanupPending, reconcilePendingChildBindingByChild } = await import("./lib/dispatch-scope.mjs");
  const { sdkIdentityReader } = await import("./lib/scope-runtime-identity.mjs");
  const {
    writeHandRecord,
    parseHandStatusFromOutput,
    buildTaskHandRecord,
  } = await import("./lib/hand-records.mjs");
  const { defaultHeadSha } = await import("./lib/mark-gate.mjs");
  const {
    gitTouchedPaths,
    resolveOcHandOutcome,
    hostStampOcHandCapture,
  } = await import("./lib/host-hand-capture.mjs");
  const {
    isRegateArmingSniperRole,
    isRegateArmingOutcome,
    armRegatePending,
  } = await import("./lib/regate-arm.mjs");
  const { isTaskTool } = await import("./lib/dual-enforcement.mjs");
  const cwd = typeof dir === "string" && dir ? dir : process.cwd();
  const { registerScopeComponent } = await import("./lib/scope-runtime-composition.mjs");
  registerScopeComponent(cwd, "obs-hand");
  const claims = new Map<string, string>();
  /** Dedupe terminal hand-record writes per parent call. */
  const writtenRecords = new Set<string>();
  /** Dedupe host regate-pending auto-arm per parent call. */
  const armedRegate = new Set<string>();
  const reader = sdkIdentityReader(deps.client, cwd);

  const writingHand = (role: unknown) =>
    isExecutorRole(role) || isSniperRole(role) || isTestAuthorRole(role);
  const claimKey = (sessionId: string, callId: string) => `${sessionId}\u0000${callId}`;

  function resolveFeatureId(sessionId: string | null, ids: ReturnType<typeof extractTaskIds>): string {
    if (ids.featureId) return ids.featureId;
    if (!sessionId) return "";
    try {
      const state = JSON.parse(
        readFileSync(join(cwd, ".opencode", "plans", ".state", sessionId, "gate-state.json"), "utf8"),
      );
      return typeof state?.feature_id === "string" ? state.feature_id : "";
    } catch {
      return "";
    }
  }

  /**
   * @description Persist Task-path hand-record once per call. Fail-open on write errors.
   * After sniper-high/medium DONE, host-arms sealed regate_pending (belt under skill mark).
   */
  function maybeWriteTaskHandRecord(input: any, output: any, ids: ReturnType<typeof extractTaskIds>) {
    try {
      if (!writingHand(ids.role)) return;
      const sessionId = typeof input?.sessionID === "string" ? input.sessionID : "";
      const callId = typeof input?.callID === "string" ? input.callID : "";
      const taskId = ids.taskId;
      if (!sessionId || !taskId) return;
      const featureId = resolveFeatureId(sessionId, ids);
      if (!featureId) return;
      const writeKey = `${sessionId}\u0000${callId}\u0000${taskId}`;
      if (writtenRecords.has(writeKey)) return;
      writtenRecords.add(writeKey);
      const outputText = String(output?.output ?? output?.content ?? output?.result ?? "");
      const parsed = parseHandStatusFromOutput(outputText);
      // OC-native: in-session Task hands (not CC spawn) — git evidence promotes BLOCKED→DONE
      // and host stamps hand_finished + capture_verified so parent can ship without CC capture-hand.
      const touched = gitTouchedPaths(cwd);
      const outcome = resolveOcHandOutcome(parsed, touched);
      const freeze = defaultHeadSha(cwd);
      hostStampOcHandCapture({
        projectRoot: cwd,
        sessionId,
        featureId,
        taskId,
        role: typeof ids.role === "string" ? ids.role : "",
        outcome,
        touchedPaths: touched,
        freezeCommitSha: freeze,
      });
      maybeArmRegatePending({ sessionId, callId, featureId, taskId, role: ids.role, outcome });
    } catch {
      /* fail-open: never break cleanup */
    }
  }

  /**
   * @description Host auto-arm regate_pending after sniper-high/medium hand DONE.
   * Fail-open: never throws into after-hook cleanup path.
   */
  function maybeArmRegatePending(args: {
    sessionId: string;
    callId: string;
    featureId: string;
    taskId: string;
    role: string;
    outcome: string;
  }) {
    try {
      if (!isRegateArmingSniperRole(args.role) || !isRegateArmingOutcome(args.outcome)) return;
      const armKey = `${args.sessionId}\u0000${args.callId}\u0000${args.taskId}`;
      if (armedRegate.has(armKey)) return;
      armedRegate.add(armKey);
      armRegatePending({
        projectRoot: cwd,
        sessionId: args.sessionId,
        featureId: args.featureId,
        taskId: args.taskId,
      });
    } catch {
      /* fail-open */
    }
  }

  function cleanup(sessionId: unknown, callId: unknown) {
    if (typeof sessionId !== "string" || typeof callId !== "string") return { ok: true };
    const key = claimKey(sessionId, callId);
    const token = claims.get(key);
    if (!token) return { ok: true };
    const finished = finishActiveDispatch(cwd, { sessionId, callId, token });
    if (finished.ok) claims.delete(key);
    return finished;
  }

  function preservePendingBinding(sessionId: unknown, callId: unknown, childSessionId: unknown, jobId: unknown) {
    if (typeof sessionId !== "string" || typeof callId !== "string") return { ok: false, reason: "pending dispatch identity missing" };
    const token = claims.get(claimKey(sessionId, callId));
    if (!token) return { ok: false, reason: "pending dispatch capability missing" };
    return markDispatchBindingPending(cwd, { sessionId, callId, token, childSessionId, jobId });
  }

  function emitTaskExecuting(sessionId: string | null, ids: ReturnType<typeof extractTaskIds>) {
    try {
      if (!ids.taskId) return;
      let featureId = ids.featureId;
      if (!featureId && sessionId) {
        try {
          const state = JSON.parse(readFileSync(join(cwd, ".opencode", "plans", ".state", sessionId, "gate-state.json"), "utf8"));
          featureId = typeof state?.feature_id === "string" ? state.feature_id : "";
        } catch {
          /* fail-open observability */
        }
      }
      let nTotal: { n: number; total: number } | null = null;
      if (sessionId && featureId) {
        const planPath = join(
          planDirForRun(cwd, sessionId, featureId) || "",
          "execution-plan.json",
        );
        if (planPath && existsSync(planPath)) {
          nTotal = taskIndexFromPlan(planPath, ids.taskId);
        }
      }
      // Fallback: still emit n=1 total=1 only if we have task id? Prefer skip without plan index.
      if (!nTotal) return;
      const ev = eventForTaskExecuting(nTotal);
      if (ev) obsAppend(ev, { dedupe: dedupeByType });
    } catch {
      /* fail-open */
    }
  }

  async function cleanupChild(childSessionId: unknown) {
    if (typeof childSessionId !== "string" || !childSessionId) return { ok: true };
    let processBinding = getProcessChildBinding(cwd, childSessionId);
    if (!processBinding) {
      // Happy path: child id was recorded on binding_pending — verify without SDK.
      const fromPending = reconcilePendingChildBindingByChild(cwd, childSessionId);
      if (fromPending.ok) {
        processBinding = getProcessChildBinding(cwd, childSessionId);
      } else {
        // No writing-hand claim/pending for this child → eye/parent/explore idle.
        // Do NOT call SDK or emit unbound diagnostics (N1 false-positive spam).
        return { ok: true };
      }
    }
    const verifiedBinding = processBinding ?? getProcessChildBinding(cwd, childSessionId);
    const bound = getChildSessionBinding(cwd, childSessionId, verifiedBinding?.parentSessionId);
    if (!bound.ok) {
      const recorded = appendTerminalScopeDiagnostic(cwd, childSessionId, bound.reason);
      return { ok: false, reason: recorded.ok ? bound.reason : recorded.reason };
    }
    const finished = finishActiveDispatch(cwd, {
      sessionId: bound.binding.parentSessionId,
      callId: bound.binding.callId,
      token: bound.binding.token,
    });
    if (finished.ok) claims.delete(claimKey(bound.binding.parentSessionId, bound.binding.callId));
    return finished;
  }

  return {
    "tool.execute.before": async (input: any, output: any) => {
      if (!isTaskTool(input?.tool)) return;
      const args = resolveHookArgs(input, output);
      const ids = extractTaskIds(args);
      if (!isHandRole(ids.role)) return;
      const sessionId = typeof input?.sessionID === "string" ? input.sessionID : null;
      const callId = typeof input?.callID === "string" ? input.callID : null;
      if (writingHand(ids.role)) {
        const prompt = typeof args?.prompt === "string" ? args.prompt : "";
        const marker = parseTaskDispatchIdentity(prompt);
        // The active-dispatch claim is best-effort observability, not a gate: plan-gate no
        // longer requires the prompt marker (#ac-2.1), and a rejected claim must not deny the
        // dispatch (#ac-2.2) — it downgrades to a shadow-record (logged, not persisted) while
        // evidence writes in the after-hook (hand-record, capture_verified) still happen
        // unconditionally on the terminal writing-hand result.
        if (!sessionId || !callId) {
          console.warn(`${PREFIX} writing-hand dispatch shadow-record: runtime sessionID/callID unavailable, active-dispatch claim skipped`);
        } else {
          const reconciled = reconcileCleanupPending(cwd, sessionId);
          if (!reconciled.ok) {
            console.warn(`${PREFIX} writing-hand dispatch shadow-record: cleanup_pending unresolved (${reconciled.reason}), active-dispatch claim skipped`);
          } else {
            const key = claimKey(sessionId, callId);
            const token = claims.get(key) ?? crypto.randomUUID();
            const claimed = claimActiveDispatch(cwd, {
              sessionId,
              callId,
              role: ids.role,
              // Marker no longer required (#ac-2.1): ids.taskId already prefers the marker when
              // present (extractTaskIds), so this is identical with a marker and only changes
              // the markerless case — without it, taskId is always empty and the claim always
              // fails, meaning active_dispatch never arms for a markerless dispatch. That claim
              // is what plan-write-gate reads to scope writes and allowlist bash for the hand
              // (decideScopeRail / bashTool branches) — a markerless writing-hand would otherwise
              // run with no scope rail and unrestricted bash.
              taskId: marker.ok ? marker.taskId : ids.taskId,
              token,
            });
            if (!claimed.ok) {
              console.warn(`${PREFIX} writing-hand dispatch shadow-record: active-dispatch claim rejected (${claimed.reason})`);
            } else {
              // Authoritative token is whatever the disk claim holds (idempotent re-entry
              // from a second plugin instance may return a different instance's token).
              const authoritative =
                typeof claimed.claim?.claim_token === "string" && claimed.claim.claim_token
                  ? claimed.claim.claim_token
                  : token;
              claims.set(key, authoritative);
            }
          }
        }
      }
      try {
        emitTaskExecuting(sessionId, ids);
      } catch {
        /* fail-open */
      }
    },
    "tool.execute.after": async (input: any, output: any) => {
      const metadata = output?.metadata;
      const outputText = String(output?.output ?? output?.content ?? output?.result ?? "");
      const backgroundRunning = metadata?.background === true && /<task\b[^>]*\bstate=["']running["']/i.test(outputText);
      const childSessionId = typeof metadata?.sessionId === "string" ? metadata.sessionId : outputText.match(/<task\b[^>]*\bid=["']([^"']+)["']/i)?.[1] ?? "";
      const jobId = metadata?.jobId ?? metadata?.taskId ?? metadata?.id;
      const terminal = !backgroundRunning;
      try {
        if (!isTaskTool(input?.tool)) return;
        const args = resolveHookArgs(input, output);
        const ids = extractTaskIds(args);
        // Hand-record is parent-call attestation — write BEFORE child-binding checks.
        // Headless often lacks SDK child binding (scope-terminal unbound); that must not
        // skip the DONE record or capture-verified becomes impossible.
        if (terminal && isHandRole(ids.role) && writingHand(ids.role)) {
          maybeWriteTaskHandRecord(input, output, ids);
        }
        const parentSessionId =
          typeof metadata?.parentSessionId === "string" && metadata.parentSessionId
            ? metadata.parentSessionId
            : typeof input?.sessionID === "string"
              ? input.sessionID
              : "";
        // Foreground Tasks also expose child id in metadata — mark pending so cleanup
        // can finish without SDK parent lookup (OC default is sync/foreground).
        if (
          writingHand(ids.role) &&
          childSessionId &&
          typeof input?.sessionID === "string" &&
          typeof input?.callID === "string"
        ) {
          const key = claimKey(input.sessionID, input.callID);
          const token = claims.get(key);
          if (token) {
            markDispatchBindingPending(cwd, {
              sessionId: input.sessionID,
              callId: input.callID,
              token,
              childSessionId,
              jobId: typeof jobId === "string" ? jobId : undefined,
            });
            if (parentSessionId) {
              bindChildSession(cwd, {
                parentSessionId,
                childSessionId,
                role: ids.role,
              });
            }
          }
        }
        if (childSessionId) {
          const bound = getChildSessionBinding(cwd, childSessionId, parentSessionId);
          if (!bound.ok || bound.binding.callId !== input?.callID || parentSessionId !== input?.sessionID) {
            const reason = bound.ok
              ? "Task result child binding does not match parent call"
              : bound.reason || "child binding unavailable";
            // Background still needs binding_pending via catch. Terminal: hand-record already
            // written — do not throw (headless often lacks SDK child binding).
            if (backgroundRunning) {
              throw new Error(`${PREFIX} ${reason}`);
            }
          }
        } else if (backgroundRunning) {
          throw new Error(`${PREFIX} running background Task result has no child identity`);
        }
        if (!isHandRole(ids.role)) return;
        // No structured task_id → skip hand-ran (avoid task:"unknown" spam).
        if (!ids.taskId) return;
        const ev = eventForHandRan({
          task: ids.taskId,
          model: ids.model || ids.role,
        });
        if (ev) obsAppend(ev, { dedupe: dedupeByType });
      } catch (error) {
        if (backgroundRunning) {
          const sessionIdForClaim = input?.sessionID;
          const callIdForClaim = input?.callID;
          // par_atômico: a before-hook shadow-record (no claim registered) must not turn into
          // an after-hook deny for the same dispatch — only a dispatch that actually holds a
          // claim is required to successfully preserve its pending child binding.
          const hasClaim =
            typeof sessionIdForClaim === "string" &&
            typeof callIdForClaim === "string" &&
            claims.has(claimKey(sessionIdForClaim, callIdForClaim));
          const pending = preservePendingBinding(sessionIdForClaim, callIdForClaim, childSessionId, jobId);
          if (!pending.ok) {
            if (hasClaim) throw new Error(`${PREFIX} ${pending.reason}`);
            console.warn(`${PREFIX} background dispatch shadow-record: pending binding preserve skipped (${pending.reason})`);
          }
        }
      } finally {
        if (terminal) {
          const finished = cleanup(input?.sessionID, input?.callID);
          if (finished && !finished.ok) throw new Error(`${PREFIX} ${finished.reason}`);
        }
      }
    },
    event: async ({ event }: any) => {
      if (event?.type === "message.updated") {
        const info = event?.properties?.info;
        if (info?.role !== "user" || !writingHand(info?.agent) || typeof info?.sessionID !== "string") return;
        let session;
        try { session = await reader.getSession(info.sessionID); } catch { return; }
        if (typeof session?.parentID === "string") {
          const bound = bindChildSession(cwd, { parentSessionId: session.parentID, childSessionId: info.sessionID, role: info.agent });
          if (!bound.ok) throw new Error(`${PREFIX} ${bound.reason}`);
        }
        return;
      }
      if (event?.type === "session.idle" || event?.type === "session.error") {
        const sessionId = event?.properties?.sessionID;
        const finished = await cleanupChild(sessionId);
        if (finished && !finished.ok && !/not bound/.test(String(finished.reason))) throw new Error(`${PREFIX} ${finished.reason}`);
        return;
      }
      const part = event?.properties?.part ?? event?.part;
      if (event?.type !== "message.part.updated" || part?.type !== "tool" || !isTaskTool(part?.tool) || part?.state?.status !== "error") return;
      const finished = cleanup(part.sessionID, part.callID);
      if (finished && !finished.ok) throw new Error(`${PREFIX} ${finished.reason}`);
    },
  };
}

export const obsHand: Plugin = async ({ directory, client }: any) =>
  createObsHandHooks(typeof directory === "string" ? directory : undefined, { client });

/** @description OC load contract. */
export default obsHand;
