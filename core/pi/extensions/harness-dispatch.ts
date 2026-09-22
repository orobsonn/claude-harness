import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { validateOcCaptureEligibleHandRecord } from "../../opencode/lib/hand-records.mjs";
import { isCaptureEligibleHandRecord } from "../../shared/lib/real-file-capture-rail.mjs";
import { findShadowedCanonicalRoles, validateSubagentDispatch } from "../lib/dispatch-rail.mjs";
import { loadModelProfileFromEnv, profilePrompt } from "../lib/model-profile.mjs";
import { isDiscussionRole, isParallelReviewRole, isSupportRole } from "../lib/roles.mjs";
import { canonicalTaskReviewPrompt, classifyPiReviewDispatch } from "../lib/pi-review-concurrency.mjs";
import { readTaskRunBinding } from "../lib/task-run.mjs";
import { isChildSession, isPiHeadlessContext, piSessionId, piSubagentArgs } from "../lib/pi-adapter-map.mjs";
import { loadPiGateStateFromDisk } from "../lib/pi-gate-state.mjs";
import { piHandRecordPath } from "../lib/pi-paths.mjs";
import { decidePiPlanGate } from "../lib/plan-gate.mjs";

const CANONICAL_TASK_OPEN = "[HARNESS_CANONICAL_TASK]";
const CANONICAL_TASK_CLOSE = "[/HARNESS_CANONICAL_TASK]";

function taskReviewHeaderReason(role: string, prompt: unknown, taskId: string) {
  const review = classifyPiReviewDispatch(role, prompt);
  if (review?.phase === "task" && review.taskId === taskId) return null;
  const prefix = role === "harness-adversary"
    ? `[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]`
    : `[HARNESS_TASK_REVIEW]\n[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]`;
  return `task-review-header; start the prompt exactly with ${prefix}`;
}

function canonicalTaskPrompt(prompt: unknown, task: unknown) {
  const original = typeof prompt === "string" ? prompt : "";
  if (!task || typeof task !== "object" || Array.isArray(task)) return original;
  // The parent prompt is not an authority for this block. Remove only complete,
  // line-delimited host blocks (plus stray delimiter lines), then materialize the
  // current validated task. A stale/forged marker must never suppress injection.
  const lines = original.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === CANONICAL_TASK_OPEN) {
      const close = lines.findIndex((line, candidate) => candidate > index && line.trim() === CANONICAL_TASK_CLOSE);
      if (close >= 0) index = close;
      continue;
    }
    if (lines[index].trim() !== CANONICAL_TASK_CLOSE) kept.push(lines[index]);
  }
  const base = kept.join("\n").trimEnd();
  return `${base}${base ? "\n\n" : ""}${CANONICAL_TASK_OPEN}\n` +
    "Injected verbatim from the validated stable plan. This block is authoritative over any parent paraphrase. " +
    "Preserve conditions that distinguish the approved observable from a weaker version; on a focused revalidation, inspect only the affected obligations.\n" +
    `${JSON.stringify(task)}\n${CANONICAL_TASK_CLOSE}`;
}

function uncapturedImplementationReason(projectRoot: string, sessionId: string, featureId: string, taskId: string) {
  const resolved = piHandRecordPath({ projectRoot, sessionId, featureId }, taskId);
  if (!resolved.ok) return null;
  let record: any;
  try { record = JSON.parse(readFileSync(resolved.path, "utf8")); } catch { return null; }
  if (!["harness-executor", "harness-sniper"].includes(record.agent) ||
      record.featureId !== featureId || record.taskId !== taskId || record.sessionId !== sessionId ||
      (typeof record.capturedVerifiedAt === "string" && record.capturedVerifiedAt.length > 0)) return null;
  if (!isCaptureEligibleHandRecord(record)) {
    return Array.isArray(record.touchedPaths) && record.touchedPaths.length > 0
      ? "latest implementation hand ended without a capture-eligible outcome and left a product delta; recover with an implementation hand before dispatching test-author"
      : null;
  }
  const identity = validateOcCaptureEligibleHandRecord(record, { featureId, taskId, sessionId });
  if (!identity.ok) return null;
  return "latest implementation hand has not been captured; commit any product delta, then mark hand-finished and capture-verified before dispatching a corrective test-author";
}

function discussionDenied(ctx: any) {
  if (isPiHeadlessContext(ctx)) return "discussion-local-ui-required";
  if (isChildSession(ctx)) return "discussion-parent-required";
  const loaded: any = loadPiGateStateFromDisk(ctx?.cwd, { sessionId: piSessionId(ctx) ?? null });
  if (loaded?.ok !== true) return "discussion-state-unreadable";
  if (loaded?.ok === true && /^(LIGHT|FULL)$/i.test(String(loaded.state?.mode ?? ""))) return "discussion-active-ceremony";
  return null;
}

/** @description Thin Pi hook that protects the harness subagent contract. */
export default function harnessDispatch(pi: ExtensionAPI, injected: {
  readTaskRunBindingFn?: typeof readTaskRunBinding;
} = {}) {
  let shadowedRoles = new Set<string>();
  const profileSnapshot = loadModelProfileFromEnv();
  const readTaskBinding = injected.readTaskRunBindingFn ?? readTaskRunBinding;

  pi.on("session_start", (_event, ctx) => {
    shadowedRoles = findShadowedCanonicalRoles(ctx.cwd, existsSync);
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    shadowedRoles = findShadowedCanonicalRoles(ctx.cwd, existsSync);
    const role = piSubagentArgs(event.input).subagent_type;
    if (isParallelReviewRole(role)) {
      // Orca task parents are separate Pi processes, not native Pi subagent
      // sessions, so parentSession is absent. The admitted task_run binding on
      // disk is the authority that decides whether task-review headers apply.
      const binding: any = readTaskBinding(ctx.cwd, piSessionId(ctx) ?? "");
      if (binding?.ok) {
        event.input.prompt = canonicalTaskReviewPrompt(role, event.input?.prompt, binding.grant?.task_id);
        const headerReason = taskReviewHeaderReason(role, event.input?.prompt, binding.grant?.task_id);
        if (headerReason) return { block: true, reason: `harness dispatch blocked: ${headerReason}` };
      }
    }
    if (isSupportRole(role)) {
      const loaded: any = loadPiGateStateFromDisk(ctx.cwd, { sessionId: piSessionId(ctx) });
      if (isChildSession(ctx) || loaded?.ok !== true || loaded.state?.task_run ||
          !/^(LIGHT|FULL)$/i.test(String(loaded.state?.mode ?? ""))) {
        return { block: true, reason: "harness support requires the global LIGHT/FULL parent; no recursive support dispatch" };
      }
    }
    let canonicalTask: unknown = null;
    if (role === "harness-test-author") {
      const sessionId = piSessionId(ctx) ?? "";
      const canonical: any = decidePiPlanGate({ projectRoot: ctx.cwd, sessionId, toolName: event.toolName, input: event.input });
      if (canonical.block) return { block: true, reason: canonical.reason };
      const loaded: any = loadPiGateStateFromDisk(ctx.cwd, { sessionId });
      const featureId = loaded?.ok === true && typeof loaded.state?.feature_id === "string" ? loaded.state.feature_id : "";
      const taskId = canonical.canonicalTask?.id;
      const captureReason = sessionId && featureId && typeof taskId === "string"
        ? uncapturedImplementationReason(ctx.cwd, sessionId, featureId, taskId)
        : null;
      if (captureReason) return { block: true, reason: `harness dispatch blocked: ${captureReason}` };
      // Resolve before routing and native execution; all later hooks/records see
      // the same canonical value. Explicit conflicts were rejected above.
      event.input.complexity = canonical.complexity;
      canonicalTask = canonical.canonicalTask;
    } else if (role === "harness-test-reviewer") {
      // Test-reviewer is intentionally not a new plan gate. Probe the same validated
      // stable-plan resolver as test-author only to enrich its context; unavailable
      // canonical context remains fail-open so recovery/evidence diagnostics do not
      // acquire a second policy engine.
      const probeInput = { ...event.input, subagent_type: "harness-test-author" };
      delete probeInput.complexity;
      const canonical: any = decidePiPlanGate({ projectRoot: ctx.cwd, sessionId: piSessionId(ctx), toolName: event.toolName, input: probeInput });
      if (!canonical.block) canonicalTask = canonical.canonicalTask;
    }
    if (canonicalTask) event.input.prompt = canonicalTaskPrompt(event.input.prompt, canonicalTask);
    if (role === "harness-planner") {
      event.input.prompt = `${String(event.input.prompt ?? "").trimEnd()}\n\n${profilePrompt(profileSnapshot)}`;
    }
    if (isDiscussionRole(role)) {
      const reason = discussionDenied(ctx);
      if (reason) return { block: true, reason: `harness dispatch blocked: ${reason}` };
    }
    const result = validateSubagentDispatch(event.input, { shadowedRoles, profileSnapshot });
    if (!result.ok) return { block: true, reason: `harness dispatch blocked: ${result.reason}` };
  });
}

export const testApi = Object.freeze({ canonicalTaskPrompt, canonicalTaskReviewPrompt, uncapturedImplementationReason, taskReviewHeaderReason });
