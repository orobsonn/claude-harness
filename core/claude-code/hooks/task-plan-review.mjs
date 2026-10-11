/**
 * @description PreToolUse(Agent) + PostToolUse(Agent) hook — host-owned plan approval evidence.
 *
 * The `plan-reviewed` mark is the orchestrator's own echo, so it can never authorize anything.
 * This hook records what the HOST observed instead: when a main-loop `Agent(plan-reviewer)` is
 * dispatched it captures the sha256 of the feature's execution-plan.json and spec.md
 * (`plan-review-inputs/<sha256(tool_use_id)>.json`); when that same call completes in the
 * foreground it parses the reviewer's single canonical JSON report and writes
 * `.claude/plans/.state/<session>/plan-review-evidence.json`:
 *
 *   {version:1, written_by:"host-subagent-completion", role:"plan-reviewer", status:"completed",
 *    verdict:"APPROVE"|"REVISE", feature_id, parent_session_id, dispatch_call_id, agent_id,
 *    plan_sha256, spec_sha256, findings_count, recorded_at}
 *
 * Evidence is written only when the plan and spec bytes are unchanged between dispatch and
 * completion. A REVISE (or an unparseable report) replaces an older APPROVE, so a stale approval
 * never outlives a later review. The parallel-task coordinator requires this file to match the
 * current plan/spec hashes before admitting any task. Separate file (not gate-state.json) because
 * entry-gate merges gate-state on the same PreToolUse(Agent) event and hooks run concurrently.
 *
 * Fail-open: never denies, exits 0 on any error.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { bareRole, isSafeFeatureId, isSafeSessionId } from "./lib/gate-lib.mjs";
import { writeTaskJson } from "../../shared/lib/task-process.mjs";
import {
  planFile,
  planReviewEvidenceFile,
  planReviewInputsDir,
  specFile,
  triageFile,
} from "./lib/task-paths.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** sha256 of a regular file, or null when absent/unreadable. */
export function fileDigest(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile()) return null;
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** Text of an Agent tool_response (content blocks or plain string). */
export function agentResponseText(response) {
  if (typeof response === "string") return response;
  const content = response?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("\n");
}

/** Every fenced ```json block that parses to an object. */
export function jsonBlocks(text) {
  const blocks = [];
  for (const match of String(text).matchAll(/```json[^\n]*\n([\s\S]*?)```/g)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) blocks.push(parsed);
    } catch {
      /* prose that merely looks like JSON is not a report */
    }
  }
  return blocks;
}

/** Exactly one canonical {verdict, findings[]} report, or null. */
export function parsePlanReviewReport(text) {
  const reports = jsonBlocks(text).filter((block) => Object.hasOwn(block, "verdict"));
  if (reports.length !== 1) return null;
  const [report] = reports;
  if (!["APPROVE", "REVISE"].includes(report.verdict) || !Array.isArray(report.findings)) return null;
  return report;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function featureFor(root, sessionId) {
  const triage = readJson(triageFile(root, sessionId));
  return isSafeFeatureId(triage?.feature_id) ? triage.feature_id : null;
}

const inputsPath = (root, sessionId, toolUseId) =>
  path.join(planReviewInputsDir(root, sessionId), `${sha256(String(toolUseId))}.json`);

/**
 * @param {object} payload - hook payload
 * @param {{ root?: string, now?: () => string }} [options]
 * @returns {{ action: string, evidence?: object }}
 */
export function handle(payload, { root = process.cwd(), now = () => new Date().toISOString() } = {}) {
  if (!payload || typeof payload !== "object" || payload.tool_name !== "Agent") return { action: "none" };
  if (Object.hasOwn(payload, "agent_id")) return { action: "none" };
  if (bareRole(payload.tool_input?.subagent_type) !== "plan-reviewer") return { action: "none" };
  const sessionId = payload.session_id;
  const toolUseId = payload.tool_use_id;
  if (!isSafeSessionId(sessionId) || typeof toolUseId !== "string" || !toolUseId) return { action: "none" };
  const featureId = featureFor(root, sessionId);
  if (!featureId) return { action: "none" };
  const digests = {
    plan_sha256: fileDigest(planFile(root, featureId)),
    spec_sha256: fileDigest(specFile(root, featureId)),
  };
  if (payload.hook_event_name === "PreToolUse") {
    writeTaskJson(inputsPath(root, sessionId, toolUseId), {
      version: 1, feature_id: featureId, dispatch_call_id: toolUseId, ...digests, captured_at: now(),
    });
    return { action: "captured" };
  }
  if (payload.hook_event_name !== "PostToolUse") return { action: "none" };
  const inputFile = inputsPath(root, sessionId, toolUseId);
  const input = readJson(inputFile);
  try { fs.rmSync(inputFile, { force: true }); } catch { /* best effort */ }
  const response = payload.tool_response;
  const report = parsePlanReviewReport(agentResponseText(response));
  const unchanged = input?.feature_id === featureId && input.dispatch_call_id === toolUseId &&
    input.plan_sha256 === digests.plan_sha256 && input.spec_sha256 === digests.spec_sha256 &&
    digests.plan_sha256 !== null && digests.spec_sha256 !== null;
  const completed = response?.status === "completed" && response?.isAsync !== true &&
    typeof response?.agentId === "string" && response.agentId.length > 0;
  const evidence = {
    version: 1,
    written_by: "host-subagent-completion",
    role: "plan-reviewer",
    status: completed && report && unchanged ? "completed" : "invalid",
    verdict: completed && report && unchanged ? report.verdict : "INVALID",
    feature_id: featureId,
    parent_session_id: sessionId,
    dispatch_call_id: toolUseId,
    agent_id: typeof response?.agentId === "string" ? response.agentId : null,
    ...digests,
    findings_count: report ? report.findings.length : null,
    reason: !completed ? "plan-reviewer did not complete in the foreground"
      : !report ? "plan-reviewer must return exactly one JSON report with verdict APPROVE|REVISE and findings[]"
        : !unchanged ? "plan or spec changed while the plan-reviewer ran (or was missing)" : null,
    recorded_at: now(),
  };
  writeTaskJson(planReviewEvidenceFile(root, sessionId), evidence);
  return { action: "recorded", evidence };
}

/**
 * Validates recorded evidence against the current artifacts: APPROVE, completed, same session and
 * feature, and the exact current plan/spec sha256.
 * @returns {{ ok: true, evidence: object } | { ok: false, reason: string }}
 */
export function readPlanApproval({ root, sessionId, featureId }) {
  const evidence = readJson(planReviewEvidenceFile(root, sessionId));
  const plan = fileDigest(planFile(root, featureId));
  const spec = fileDigest(specFile(root, featureId));
  if (!evidence || evidence.version !== 1 || evidence.written_by !== "host-subagent-completion" ||
      evidence.role !== "plan-reviewer" || evidence.status !== "completed" || evidence.verdict !== "APPROVE" ||
      evidence.parent_session_id !== sessionId || evidence.feature_id !== featureId ||
      typeof evidence.dispatch_call_id !== "string" || !evidence.dispatch_call_id ||
      typeof evidence.agent_id !== "string" || !evidence.agent_id ||
      !plan || !spec || evidence.plan_sha256 !== plan || evidence.spec_sha256 !== spec) {
    return {
      ok: false,
      reason: 'host-confirmed plan-reviewer APPROVE for the current execution-plan.json and spec.md required: dispatch a fresh foreground Agent(plan-reviewer) on the current artifacts; its report must contain exactly one ```json block {"verdict":"APPROVE","findings":[]}; a mark.mjs plan-reviewed echo is not evidence',
    };
  }
  return { ok: true, evidence, plan_sha256: plan, spec_sha256: spec };
}

function isDirectCli() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}

if (isDirectCli()) {
  try {
    handle(JSON.parse(fs.readFileSync(0, "utf8")));
  } catch {
    /* fail-open: evidence is simply not recorded */
  }
  process.exit(0);
}
