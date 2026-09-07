/** @description Host-owned evidence for Pi task and final review completions. */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { withGateStateLock } from "../../opencode/lib/gate-state.mjs";
import { validateReviewReport } from "../../shared/lib/review-report-schema.mjs";
import { isSafeFeatureId, isSafeSessionId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { piExecutionPlanPath, piGateStatePath, piSpecPath } from "./pi-paths.mjs";
import { isPiReviewSecretPath } from "./policy.mjs";
import { isParallelReviewRole } from "./roles.mjs";

const HEX_256 = /^[0-9a-f]{64}$/;

function stable(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item,
  );
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function splitZero(value) {
  return String(value).split("\0").filter(Boolean);
}

/** Secrets and volatile host state are rejected by path before any worktree bytes are read. */
function excluded(root, relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const parts = lower.split("/");
  const base = parts.at(-1) ?? "";
  return isPiReviewSecretPath(path.resolve(root, relativePath)) || parts.includes("node_modules") ||
    lower.startsWith(".pi/harness/state/") ||
    lower.startsWith(".pi/harness/runtime/") ||
    lower.startsWith(".pi/harness/sessions/") ||
    lower.startsWith(".pi/agent/") ||
    base === ".env" || base.startsWith(".env.") || base === ".dev.vars" ||
    base === "credentials" || base === "credentials.json" || base === "auth.json";
}

function treeEntries(root) {
  const entries = [];
  for (const record of splitZero(git(root, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]))) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const relativePath = record.slice(tab + 1);
    if (excluded(root, relativePath)) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    entries.push({ path: relativePath, mode, type, oid });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function indexEntries(root) {
  const entries = [];
  for (const record of splitZero(git(root, ["ls-files", "--stage", "-z"]))) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const relativePath = record.slice(tab + 1);
    if (excluded(root, relativePath)) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    entries.push({ path: relativePath, mode, oid, stage });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Reject redirected directory ancestry before opening a repository input. */
function regularAncestors(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("review input must stay inside the canonical project root");
  }
  let directory = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    directory = path.join(directory, part);
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("review input has non-regular or symlink directory ancestry");
  }
}

function readRegularFile(file) {
  // O_NONBLOCK avoids hanging if an input is replaced by a FIFO before open.
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile()) throw new Error("review input must be a regular file");
    const bytes = fs.readFileSync(descriptor);
    return { bytes, mode: info.mode & 0o111 ? "100755" : "100644" };
  } finally {
    fs.closeSync(descriptor);
  }
}

function regularFile(file) {
  const { bytes, mode } = readRegularFile(file);
  return { size: bytes.length, sha256: digest(bytes), mode };
}

function worktreeEntry(root, relativePath, tracked) {
  if (excluded(root, relativePath)) return null;
  const absolute = path.join(root, relativePath);
  try {
    regularAncestors(root, absolute);
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink()) {
      const bytes = fs.readlinkSync(absolute, { encoding: "buffer" });
      return { path: relativePath, tracked, kind: "symlink", mode: "120000", size: bytes.length, sha256: digest(bytes) };
    }
    if (!info.isFile()) throw new Error("review input must be a regular file or symlink");
    return { path: relativePath, tracked, kind: "file", ...regularFile(absolute) };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: relativePath, tracked, kind: "missing" };
    throw error;
  }
}

function canonicalFile(root, file) {
  try {
    regularAncestors(root, file);
    if (!fs.lstatSync(file).isFile()) throw new Error("canonical review evidence must be a regular non-symlink file");
    return { present: true, ...regularFile(file) };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    throw error;
  }
}

/** Read review requirements from the same regular canonical plan that the snapshot identifies. */
export function readPiReviewPlan({ projectRoot, featureId, expectedSha256 } = {}) {
  try {
    const root = fs.realpathSync(projectRoot);
    const resolved = piExecutionPlanPath({ projectRoot: root, featureId });
    if (!resolved.ok) return resolved;
    regularAncestors(root, resolved.path);
    const { bytes } = readRegularFile(resolved.path);
    const sha256 = digest(bytes);
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) return { ok: false, reason: "canonical review plan changed after snapshot" };
    const plan = JSON.parse(bytes.toString("utf8"));
    if (!plan || Array.isArray(plan) || plan.feature_id !== featureId || !Array.isArray(plan.tasks)) {
      return { ok: false, reason: "canonical review plan identity invalid" };
    }
    if (plan.final_review?.security !== undefined && typeof plan.final_review.security !== "boolean") {
      return { ok: false, reason: "final_review.security must be a boolean when present" };
    }
    return { ok: true, plan, sha256 };
  } catch {
    return { ok: false, reason: "canonical review plan must be a readable regular file" };
  }
}

/** Capture HEAD, index, worktree and canonical plan/spec as separate immutable digests. */
export function capturePiReviewInput({ projectRoot, sessionId, featureId, phase, taskId } = {}) {
  try {
    if (typeof projectRoot !== "string" || !projectRoot) return { ok: false, reason: "review projectRoot required" };
    if (!isSafeSessionId(sessionId)) return { ok: false, reason: "safe review sessionId required" };
    if (!isSafeFeatureId(featureId)) return { ok: false, reason: "safe review featureId required" };
    if (phase !== "task" && phase !== "final") return { ok: false, reason: "review phase must be task or final" };
    if (phase === "task" && !isSafeTaskId(taskId)) return { ok: false, reason: "safe task review taskId required" };
    projectRoot = fs.realpathSync(projectRoot);

    const planPath = piExecutionPlanPath({ projectRoot, featureId });
    const specPath = piSpecPath({ projectRoot, featureId });
    const head = String(git(projectRoot, ["rev-parse", "HEAD"])).trim();
    const headEntries = treeEntries(projectRoot);
    const index = indexEntries(projectRoot);
    if ([...headEntries, ...index].some((entry) => entry.mode === "160000")) {
      return { ok: false, reason: "review input capture does not support submodules (gitlinks)" };
    }
    const trackedPaths = new Set([...headEntries, ...index].map((entry) => entry.path));
    const untrackedPaths = splitZero(git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .filter((entry) => !excluded(projectRoot, entry));
    const worktree = [...trackedPaths].sort().map((entry) => worktreeEntry(projectRoot, entry, true)).filter(Boolean);
    const untracked = untrackedPaths.sort().map((entry) => worktreeEntry(projectRoot, entry, false)).filter(Boolean);
    const body = {
      version: 1,
      session_id: sessionId,
      feature_id: featureId,
      phase,
      ...(phase === "task" ? { task_id: taskId } : {}),
      head_sha: head,
      head: headEntries,
      index,
      worktree,
      untracked,
      canonical_plan: canonicalFile(projectRoot, planPath.path),
      canonical_spec: canonicalFile(projectRoot, specPath.path),
    };
    return { ok: true, snapshot: { ...body, input_digest: digest(stable(body)) } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? `review input capture failed: ${error.message}` : "review input capture failed" };
  }
}

function strictReport(text) {
  if (typeof text !== "string" || !text) return null;
  let source = text;
  const fence = text.match(/^```json\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fence) source = fence[1];
  else if (text.startsWith("```")) return null;
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Parse only the exact native completed agent record and its exact canonical wrapper body. */
export function parsePiReviewCompletion({ role, result, isError, nativeRecord, snapshotStart, snapshotEnd } = {}) {
  if (!isParallelReviewRole(role)) return { ok: false, reason: "unknown Pi review role" };
  if (isError === true) return { ok: false, reason: "native review execution failed" };
  if (!result || typeof result !== "object" || Array.isArray(result) || !result.details || result.details.status !== "completed") {
    return { ok: false, reason: "native review result is not completed" };
  }
  const agentId = result.details.agentId;
  if (typeof agentId !== "string" || !agentId) return { ok: false, reason: "native review agent identity missing" };
  if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text" || typeof result.content[0]?.text !== "string") {
    return { ok: false, reason: "native review wrapper missing" };
  }
  const wrapper = result.content[0].text.match(/^Agent completed in [^\r\n]+\r?\nAgent ID: ([^\r\n]+)\r?\n\r?\n([\s\S]*)$/);
  if (!wrapper || wrapper[1] !== agentId) return { ok: false, reason: "native review wrapper identity mismatch" };
  if (!nativeRecord || typeof nativeRecord !== "object" || Array.isArray(nativeRecord) ||
      nativeRecord.status !== "completed" || nativeRecord.id !== agentId || nativeRecord.type !== role ||
      nativeRecord.isBackground !== false || typeof nativeRecord.result !== "string" ||
      nativeRecord.pendingQuestion != null || typeof nativeRecord.completedAt !== "number") {
    return { ok: false, reason: "native review record is not a healthy matching completion" };
  }
  if (wrapper[2] !== nativeRecord.result) return { ok: false, reason: "native review wrapper body mismatch" };
  if (!snapshotStart || !snapshotEnd || !HEX_256.test(snapshotStart.input_digest ?? "") ||
      stable(snapshotStart) !== stable(snapshotEnd)) {
    return { ok: false, reason: "review input snapshot changed after dispatch" };
  }
  const report = strictReport(nativeRecord.result);
  if (!report) return { ok: false, reason: "review result is not one canonical JSON report" };
  const logicalRole = role.replace("harness-", "");
  const validated = validateReviewReport(logicalRole, report);
  if (!validated.ok) return { ok: false, reason: validated.reason };
  if (validated.report.issues.length !== 0) return { ok: false, reason: "review report contains issues" };
  const canonical = validated.report;
  return {
    ok: true,
    completion: {
      written_by: "host-subagent-completion",
      parent_session_id: snapshotStart.session_id,
      feature_id: snapshotStart.feature_id,
      phase: snapshotStart.phase,
      ...(snapshotStart.phase === "task" ? { task_id: snapshotStart.task_id } : {}),
      role,
      agent_id: agentId,
      status: "completed",
      reviewed_head_sha: snapshotStart.head_sha,
      input_digest: snapshotStart.input_digest,
      report: canonical,
      report_digest: digest(JSON.stringify(canonical)),
      accepted: true,
    },
  };
}

function validCompletion(completion) {
  if (!completion || typeof completion !== "object" || Array.isArray(completion) ||
      completion.written_by !== "host-subagent-completion" || !isParallelReviewRole(completion.role) ||
      completion.accepted !== true || completion.status !== "completed" ||
      !isSafeSessionId(completion.parent_session_id) || !isSafeFeatureId(completion.feature_id) ||
      !HEX_256.test(completion.input_digest ?? "") || !HEX_256.test(completion.report_digest ?? "") ||
      !HEX_256.test(completion.reviewed_head_sha ?? "") && !/^[0-9a-f]{40}$/.test(completion.reviewed_head_sha ?? "") ||
      typeof completion.agent_id !== "string" || !completion.agent_id) return false;
  if (completion.phase === "task" && !isSafeTaskId(completion.task_id)) return false;
  if (completion.phase !== "task" && completion.phase !== "final") return false;
  const validated = validateReviewReport(completion.role.replace("harness-", ""), completion.report);
  return validated.ok && validated.report.issues.length === 0 &&
    digest(JSON.stringify(validated.report)) === completion.report_digest;
}

function receiptKey(role) {
  return role.replace("harness-", "");
}

function findDispatchReceipt(value, dispatchCallId) {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value) && value.dispatch_call_id === dispatchCallId) return value;
  for (const child of Object.values(value)) {
    const found = findDispatchReceipt(child, dispatchCallId);
    if (found) return found;
  }
  return null;
}

/** Persist one accepted receipt with the complete sibling reduction under the shared state lock. */
export function recordPiReviewReceipt({ projectRoot, sessionId, completion, binding } = {}) {
  if (!validCompletion(completion) || completion.parent_session_id !== sessionId) {
    return { ok: false, reason: "accepted matching review completion required" };
  }
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      typeof binding.dispatchCallId !== "string" || !binding.dispatchCallId ||
      typeof binding.childSessionId !== "string" || !binding.childSessionId ||
      typeof binding.agentId !== "string" || !binding.agentId || binding.agentId !== completion.agent_id) {
    return { ok: false, reason: "exact host review binding required" };
  }
  const statePath = piGateStatePath({ projectRoot, sessionId });
  if (!statePath.ok) return statePath;
  const receipt = {
    ...completion,
    dispatch_call_id: binding.dispatchCallId,
    child_session_id: binding.childSessionId,
  };
  const locked = withGateStateLock(statePath.path, (previous) => {
    if (previous.session_id !== sessionId || previous.feature_id !== completion.feature_id) {
      return { ok: false, reason: "gate-state review identity mismatch" };
    }
    const replay = findDispatchReceipt(previous, binding.dispatchCallId);
    if (replay) return stable(replay) === stable(receipt) ? previous : { ok: false, reason: "review dispatch replay binding mismatch" };
    const roleKey = receiptKey(completion.role);
    if (completion.phase === "final") {
      const siblings = previous.final_review_evidence && typeof previous.final_review_evidence === "object" && !Array.isArray(previous.final_review_evidence)
        ? previous.final_review_evidence : {};
      return { ...previous, final_review_evidence: { ...siblings, [roleKey]: receipt } };
    }
    const featureTask = `${completion.feature_id}/${completion.task_id}`;
    if (completion.role === "harness-adversary") {
      const legacy = previous.task_adversary_evidence && typeof previous.task_adversary_evidence === "object" && !Array.isArray(previous.task_adversary_evidence)
        ? previous.task_adversary_evidence : {};
      return { ...previous, task_adversary_evidence: { ...legacy, [featureTask]: receipt } };
    }
    const tasks = previous.task_review_evidence && typeof previous.task_review_evidence === "object" && !Array.isArray(previous.task_review_evidence)
      ? previous.task_review_evidence : {};
    const siblings = tasks[featureTask] && typeof tasks[featureTask] === "object" && !Array.isArray(tasks[featureTask]) ? tasks[featureTask] : {};
    return { ...previous, task_review_evidence: { ...tasks, [featureTask]: { ...siblings, [roleKey]: receipt } } };
  });
  return locked.ok ? { ok: true, receipt, state: locked.state } : locked;
}

export function isCurrentPiReviewReceipt(receipt, { sessionId, featureId, role, phase, taskId, snapshot } = {}) {
  return validCompletion(receipt) && receipt.parent_session_id === sessionId && receipt.feature_id === featureId &&
    receipt.role === role && receipt.phase === phase && (phase !== "task" || receipt.task_id === taskId) &&
    receipt.reviewed_head_sha === snapshot?.head_sha && receipt.input_digest === snapshot?.input_digest &&
    typeof receipt.dispatch_call_id === "string" && receipt.dispatch_call_id.length > 0 &&
    typeof receipt.child_session_id === "string" && receipt.child_session_id.length > 0;
}

/** Validate the accepted canonical report and bind it to a freshly captured input digest. */
export function hasAcceptedPiReviewEvidence(receipt, snapshot) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt.accepted !== true ||
      !HEX_256.test(receipt.input_digest ?? "") || receipt.input_digest !== snapshot?.input_digest ||
      !HEX_256.test(receipt.report_digest ?? "") || !isParallelReviewRole(receipt.role)) return false;
  const validated = validateReviewReport(receipt.role.replace("harness-", ""), receipt.report);
  return validated.ok && validated.report.issues.length === 0 &&
    digest(JSON.stringify(validated.report)) === receipt.report_digest;
}

/** Return only roles without an accepted receipt over the exact current input. */
export function missingPiReviewRoles({ projectRoot, sessionId, featureId, phase, taskId, roles } = {}) {
  if (!Array.isArray(roles)) return [];
  const captured = capturePiReviewInput({ projectRoot, sessionId, featureId, phase, ...(phase === "task" ? { taskId } : {}) });
  if (!captured.ok) return [...roles];
  let state = {};
  try { state = JSON.parse(fs.readFileSync(piGateStatePath({ projectRoot, sessionId }).path, "utf8")); } catch { return [...roles]; }
  return roles.filter((role) => {
    const key = receiptKey(role);
    const receipt = phase === "final"
      ? state.final_review_evidence?.[key]
      : role === "harness-adversary"
        ? state.task_adversary_evidence?.[`${featureId}/${taskId}`]
        : state.task_review_evidence?.[`${featureId}/${taskId}`]?.[key];
    return !isCurrentPiReviewReceipt(receipt, { sessionId, featureId, role, phase, taskId, snapshot: captured.snapshot });
  });
}

export default { capturePiReviewInput, parsePiReviewCompletion, recordPiReviewReceipt, missingPiReviewRoles, isCurrentPiReviewReceipt, hasAcceptedPiReviewEvidence };
