/** @description Admission and authority rails for one delegated Pi task parent. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { isSafeSessionId, isSafeTaskId, isSafeFeatureId } from "../vendor/shared/lib/feature-id.mjs";
import { parseReviewReportText, validateReviewReport } from "../vendor/shared/lib/review-report-schema.mjs";
import { validatePlan } from "../vendor/shared/lib/validate-plan.mjs";
import { parseTaskDispatchIdentity } from "../vendor/opencode/lib/task-dispatch-identity.mjs";
import { piSubagentArgs } from "./pi-adapter-map.mjs";
import { piDispatchRoute } from "./dispatch-rail.mjs";
import { readPiSpecApproval } from "./spec-approval.mjs";
import { validateTaskContextHandoff } from "./task-context.mjs";
import {
  TASK_PIPELINE_VERSION,
  TASK_RUN_ENV,
  hashTaskReceipt,
  stableTaskJson,
  taskAdmissionPath,
  taskRegistryPath,
  unsupportedTaskScopePattern,
} from "./task-contract.mjs";

export { TASK_PIPELINE_VERSION, TASK_RUN_ENV } from "./task-contract.mjs";

const TASK_ROLES = new Set([
  "harness-test-author",
  "harness-executor",
  "harness-sniper",
  "harness-compliance",
  "harness-adversary",
  "harness-security",
]);
const TASK_WRITING_ROLES = new Set(["harness-test-author", "harness-executor", "harness-sniper"]);
const TASK_MARKERS = new Set(["fidelity", "hand-finished", "capture-verified", "regate-pending", "regate-passed"]);
const HEX_40 = /^[a-f0-9]{40}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const fail = (reason) => ({ ok: false, reason: `[task-run] ${reason}` });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const hashTaskArtifact = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Read a bounded regular file through canonical directory ancestry. */
function readArtifact(file, ownerRoot = path.dirname(file)) {
  const absolute = path.resolve(file);
  const root = fs.realpathSync(ownerRoot);
  if (!inside(root, absolute)) throw new Error("artifact path escapes its owner root");
  let cursor = root;
  const relative = path.relative(root, absolute);
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const info = fs.lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error("artifact symlink rejected");
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES || fs.realpathSync(absolute) !== absolute) {
    throw new Error("artifact must be a bounded regular file");
  }
  return fs.readFileSync(absolute, "utf8");
}

function planAndSpec(root, featureId) {
  const directory = path.join(root, ".pi", "harness", "plans", featureId);
  const planPath = path.join(directory, "execution-plan.json");
  const specPath = path.join(directory, "spec.md");
  const planText = readArtifact(planPath, root);
  const specText = readArtifact(specPath, root);
  return {
    planPath,
    specPath,
    planText,
    specText,
    planSha256: createHash("sha256").update(planText).digest("hex"),
    specSha256: createHash("sha256").update(specText).digest("hex"),
    plan: JSON.parse(planText),
  };
}

function validPlanApproval(receipt, grant) {
  return receipt && typeof receipt === "object" && !Array.isArray(receipt) &&
    receipt.written_by === "host-subagent-completion" &&
    receipt.parent_session_id === grant.parent_session_id &&
    receipt.feature_id === grant.feature_id &&
    receipt.role === "harness-plan-reviewer" &&
    receipt.dispatch_call_id === grant.origin.plan_review_call_id &&
    typeof receipt.child_session_id === "string" && receipt.child_session_id.length > 0 &&
    typeof receipt.agent_id === "string" && receipt.agent_id.length > 0 &&
    receipt.status === "completed" && receipt.plan_sha256 === grant.plan_sha256 &&
    receipt.spec_sha256 === grant.spec_sha256 && receipt.verdict === "APPROVE";
}

function validateDependencyReceipt(receipt, expected, grant) {
  return receipt && typeof receipt === "object" && !Array.isArray(receipt) &&
    receipt.version === TASK_PIPELINE_VERSION && receipt.written_by === "host-task-integration" &&
    receipt.parent_session_id === grant.parent_session_id && receipt.feature_id === grant.feature_id &&
    receipt.task_id === expected.task_id && receipt.parent_root === grant.parent_root &&
    receipt.plan_sha256 === grant.plan_sha256 && receipt.spec_sha256 === grant.spec_sha256 &&
    receipt.child_head === expected.child_head && receipt.integrated_head === expected.integrated_head &&
    HEX_40.test(receipt.base_sha ?? "") && HEX_40.test(receipt.child_head ?? "") &&
    HEX_40.test(receipt.integrated_head ?? "") && HEX_64.test(receipt.result_sha256 ?? "") &&
    isSafeSessionId(receipt.session_id) && isSafeSessionId(receipt.attempt_id) &&
    typeof receipt.worktree === "string" && receipt.worktree.length > 0;
}

function historicalResults(entry) {
  if (Array.isArray(entry?.result_history)) return entry.result_history;
  if (entry?.result_history && typeof entry.result_history === "object") return Object.values(entry.result_history);
  return [];
}

function validateDependencies({ task, grant, parentRoot, allowHistoricalDeps = false }) {
  const dependencies = Array.isArray(grant.dependencies) ? grant.dependencies : null;
  if (!dependencies) throw new Error("dependency receipts array required");
  const expectedIds = [...task.depends_on].sort();
  const actualIds = dependencies.map((entry) => entry?.task_id).sort();
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index]) || new Set(actualIds).size !== actualIds.length) {
    throw new Error("dependency receipts must exactly match task depends_on");
  }
  if (dependencies.length === 0) return;
  const registryPath = taskRegistryPath(parentRoot, grant.parent_session_id);
  const registry = JSON.parse(readArtifact(registryPath, parentRoot));
  if (registry.version !== TASK_PIPELINE_VERSION || registry.parent_session_id !== grant.parent_session_id ||
      registry.feature_id !== grant.feature_id || registry.plan_sha256 !== grant.plan_sha256 || registry.spec_sha256 !== grant.spec_sha256) {
    throw new Error("parent task registry identity mismatch");
  }
  for (const dependency of dependencies) {
    if (!dependency || !isSafeTaskId(dependency.task_id) || !HEX_40.test(dependency.child_head ?? "") ||
        !HEX_40.test(dependency.integrated_head ?? "") || !HEX_64.test(dependency.receipt_sha256 ?? "") ||
        !validateDependencyReceipt(dependency.receipt, dependency, grant) ||
        hashTaskReceipt(dependency.receipt) !== dependency.receipt_sha256) {
      throw new Error(`invalid integration receipt for dependency ${String(dependency?.task_id ?? "")}`);
    }
    const current = registry.tasks?.[dependency.task_id];
    const integrations = [current?.integration, ...(allowHistoricalDeps && Array.isArray(current?.integration_history) ? current.integration_history : [])]
      .filter(Boolean);
    const matchingIntegration = integrations.some((receipt) =>
      hashTaskReceipt(receipt) === dependency.receipt_sha256 && stableTaskJson(receipt) === stableTaskJson(dependency.receipt));
    const results = [current?.result, ...(allowHistoricalDeps ? historicalResults(current) : [])].filter(Boolean);
    const matchingResult = results.some((result) => hashTaskReceipt(result) === dependency.receipt.result_sha256);
    if (current?.status !== "integrated" || !matchingIntegration || !matchingResult) {
      throw new Error(`dependency ${dependency.task_id} is not integrated in the current parent registry`);
    }
    git(parentRoot, "merge-base", "--is-ancestor", dependency.child_head, dependency.integrated_head);
    git(parentRoot, "merge-base", "--is-ancestor", dependency.integrated_head, grant.base_sha);
    git(parentRoot, "merge-base", "--is-ancestor", dependency.integrated_head, "HEAD");
  }
}

/** Validate an immutable grant against its child artifacts and current parent-owned evidence. */
function inspectGrant(grantPath, cwd, { allowHistoricalDeps = false } = {}) {
  const root = fs.realpathSync(cwd);
  const absoluteGrant = path.resolve(grantPath);
  const raw = readArtifact(absoluteGrant, root);
  const grant = JSON.parse(raw);
  if (grant.version !== TASK_PIPELINE_VERSION || grant.kind !== "task-run") throw new Error("unsupported task grant");
  if (!isSafeSessionId(grant.parent_session_id) || !isSafeSessionId(grant.attempt_id) ||
      !isSafeTaskId(grant.task_id) || !isSafeFeatureId(grant.feature_id)) {
    throw new Error("exact parent, attempt, feature and task required");
  }
  if (grant.cwd !== root || absoluteGrant !== taskAdmissionPath(root, grant.attempt_id)) throw new Error("grant worktree/path mismatch");
  if (!HEX_40.test(grant.base_sha ?? "") || !HEX_64.test(grant.plan_sha256 ?? "") || !HEX_64.test(grant.spec_sha256 ?? "")) {
    throw new Error("exact artifact hashes required");
  }
  const parentRoot = fs.realpathSync(grant.parent_root);
  if (grant.parent_root !== parentRoot) throw new Error("canonical parent_root required");
  if (grant.origin?.kind !== "parent-approved-plan" || typeof grant.origin.plan_review_call_id !== "string" || !grant.origin.plan_review_call_id) {
    throw new Error("host-owned parent plan approval required");
  }
  if (grant.context_handoff !== undefined) {
    const context = validateTaskContextHandoff(grant.context_handoff, {
      parentSessionId: grant.parent_session_id,
      taskId: grant.task_id,
    });
    if (!context.ok) throw new Error(context.reason);
  }
  const artifacts = planAndSpec(root, grant.feature_id);
  if (artifacts.planSha256 !== grant.plan_sha256 || artifacts.specSha256 !== grant.spec_sha256) throw new Error("plan/spec hash mismatch");
  const valid = validatePlan(artifacts.plan, { expect: "full", expectedModelStrategy: artifacts.plan.model_strategy });
  if (!valid.ok) throw new Error(`invalid canonical plan: ${valid.errors.join("; ")}`);
  if (artifacts.plan.feature_id !== grant.feature_id || !["light", "full"].includes(artifacts.plan.mode)) throw new Error("plan identity mismatch");
  const task = artifacts.plan.tasks.find((candidate) => candidate.id === grant.task_id);
  if (!task) throw new Error("task missing from canonical plan");
  const taskScope = [
    ...task.scope_paths,
    ...(task.locked_tests ?? []).flatMap((test) => [
      test.path,
      ...(test.fixture_paths ?? []),
    ]),
  ];
  const unsupportedScope = taskScope.find(unsupportedTaskScopePattern);
  if (unsupportedScope !== undefined) {
    throw new Error(
      `task scope ${JSON.stringify(unsupportedScope)} uses unsupported glob syntax; use an explicit file or directory path`,
    );
  }

  const parentArtifacts = planAndSpec(parentRoot, grant.feature_id);
  if (parentArtifacts.planSha256 !== grant.plan_sha256 || parentArtifacts.specSha256 !== grant.spec_sha256) {
    throw new Error("parent canonical plan/spec changed after grant");
  }

  const parentStatePath = path.join(parentRoot, ".pi", "harness", "state", grant.parent_session_id, "gate-state.json");
  const parentState = JSON.parse(readArtifact(parentStatePath, parentRoot));
  if (parentState.session_id !== grant.parent_session_id || parentState.feature_id !== grant.feature_id ||
      parentState.task_pipeline_version !== TASK_PIPELINE_VERSION || !validPlanApproval(parentState.plan_review_evidence, grant)) {
    throw new Error("current host-owned plan approval does not match grant");
  }
  const sealedSpec = readPiSpecApproval({ projectRoot: parentRoot, sessionId: grant.parent_session_id, featureId: grant.feature_id });
  if (!sealedSpec.ok || sealedSpec.sha256 !== grant.spec_sha256) throw new Error("current parent spec approval does not match grant");
  validateDependencies({ task, grant, parentRoot, allowHistoricalDeps });

  const branch = git(root, "branch", "--show-current");
  if (typeof grant.branch !== "string" || branch !== grant.branch || /^(main|master)$/.test(branch)) throw new Error("exact task feature branch required");
  git(root, "merge-base", "--is-ancestor", grant.base_sha, "HEAD");
  return {
    grant,
    root,
    parentRoot,
    plan: artifacts.plan,
    task,
    planPath: artifacts.planPath,
    specPath: artifacts.specPath,
    grantPath: absoluteGrant,
    grantSha: createHash("sha256").update(raw).digest("hex"),
  };
}

/** Read-only fresh-admission preflight. It validates every grant/input invariant but writes no claim or state. */
export function inspectTaskAdmission(grantPath, { cwd, sessionId }) {
  try {
    if (!isSafeSessionId(sessionId)) return fail("safe local session required");
    const info = inspectGrant(grantPath, cwd);
    if (git(info.root, "rev-parse", "HEAD") !== info.grant.base_sha) return fail("initial base mismatch");
    if (git(info.root, "diff", "--name-only", "HEAD")) return fail("initial product worktree is dirty");
    const untracked = git(info.root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
    if (untracked.some((entry) => !entry.startsWith(".pi/harness/"))) {
      return fail("initial untracked product inputs must be resolved before admission");
    }
    const stateDir = path.join(info.root, ".pi", "harness", "state", sessionId);
    if (fs.existsSync(stateDir)) return fail("local session state already exists");
    if (fs.existsSync(`${info.grantPath}.claim`)) return fail("task attempt already claimed");
    const binding = {
      grant_path: info.grantPath,
      grant_sha256: info.grantSha,
      parent_session_id: info.grant.parent_session_id,
      attempt_id: info.grant.attempt_id,
      task_id: info.grant.task_id,
    };
    return { ok: true, ...info, sessionId, binding };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Bind a fresh real task-parent session without manufacturing pipeline evidence. */
export function admitTaskRun(grantPath, { cwd, sessionId }) {
  let admission;
  let claimText;
  let stateFile;
  let stateText;
  let claimCreated = false;
  try {
    admission = inspectTaskAdmission(grantPath, { cwd, sessionId });
    if (!admission.ok) return admission;
    const stateDir = path.join(admission.root, ".pi", "harness", "state", sessionId);
    stateFile = path.join(stateDir, "gate-state.json");
    claimText = JSON.stringify({ session_id: sessionId, grant_sha256: admission.grantSha });
    stateText = `${JSON.stringify({
      session_id: sessionId,
      feature_id: admission.grant.feature_id,
      mode: admission.plan.mode.toUpperCase(),
      peak_mode: admission.plan.mode.toUpperCase(),
      classified: true,
      triaged: true,
      task_pipeline_version: TASK_PIPELINE_VERSION,
      classification_source: "delegated-task",
      task_run: admission.binding,
    }, null, 2)}\n`;
    fs.writeFileSync(`${admission.grantPath}.claim`, claimText, { flag: "wx", mode: 0o600 });
    claimCreated = true;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, stateText, { flag: "wx", mode: 0o600 });
    return admission;
  } catch (error) {
    // No provider can run inside admission. Roll back only bytes created by this exact call;
    // any divergent state is preserved for explicit recovery instead of being guessed away.
    try {
      if (stateFile && stateText && fs.existsSync(stateFile) && fs.readFileSync(stateFile, "utf8") === stateText) {
        fs.unlinkSync(stateFile);
        try { fs.rmdirSync(path.dirname(stateFile)); } catch { /* preserve non-empty/changed state */ }
      }
      if (claimCreated && admission?.grantPath && claimText && fs.readFileSync(`${admission.grantPath}.claim`, "utf8") === claimText) {
        fs.unlinkSync(`${admission.grantPath}.claim`);
      }
    } catch { /* preserve the original admission failure */ }
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Remove only a just-created, still-pristine admission after the host proves process spawn failed. */
export function rollbackTaskAdmission(admission) {
  try {
    if (!admission?.ok || !isSafeSessionId(admission.sessionId) || typeof admission.grantPath !== "string") return false;
    const stateDir = path.join(admission.root, ".pi", "harness", "state", admission.sessionId);
    const stateFile = path.join(stateDir, "gate-state.json");
    const claimFile = `${admission.grantPath}.claim`;
    const expectedClaim = JSON.stringify({ session_id: admission.sessionId, grant_sha256: admission.grantSha });
    const expectedState = `${JSON.stringify({
      session_id: admission.sessionId,
      feature_id: admission.grant.feature_id,
      mode: admission.plan.mode.toUpperCase(),
      peak_mode: admission.plan.mode.toUpperCase(),
      classified: true,
      triaged: true,
      task_pipeline_version: TASK_PIPELINE_VERSION,
      classification_source: "delegated-task",
      task_run: admission.binding,
    }, null, 2)}\n`;
    if (fs.readFileSync(claimFile, "utf8") !== expectedClaim || fs.readFileSync(stateFile, "utf8") !== expectedState) return false;
    if (fs.readdirSync(stateDir).some((name) => name !== "gate-state.json")) return false;
    const sessionsDir = path.join(admission.root, ".pi", "harness", "sessions");
    if (fs.existsSync(sessionsDir) && fs.readdirSync(sessionsDir).some((name) => name.endsWith(`_${admission.sessionId}.jsonl`))) return false;
    fs.unlinkSync(stateFile);
    fs.rmdirSync(stateDir);
    fs.unlinkSync(claimFile);
    return true;
  } catch {
    return false;
  }
}

/** Revalidate the admitted attempt at every authority boundary. */
export function readTaskRunBinding(cwd, sessionId) {
  try {
    if (!isSafeSessionId(sessionId)) return fail("safe local session required");
    const root = fs.realpathSync(cwd);
    const stateFile = path.join(root, ".pi", "harness", "state", sessionId, "gate-state.json");
    if (!fs.existsSync(stateFile)) return { ok: false, absent: true, reason: "task-run state absent" };
    const state = JSON.parse(readArtifact(stateFile, root));
    if (!state.task_run) return { ok: false, absent: true, reason: "ordinary parent" };
    if (state.session_id !== sessionId || state.task_pipeline_version !== TASK_PIPELINE_VERSION) return fail("local session mismatch");
    const info = inspectGrant(state.task_run.grant_path, root, { allowHistoricalDeps: true });
    if (info.grantSha !== state.task_run.grant_sha256) return fail("grant changed");
    const claim = JSON.parse(readArtifact(`${info.grantPath}.claim`, root));
    if (claim.session_id !== sessionId || claim.grant_sha256 !== info.grantSha) return fail("attempt claim mismatch");
    if (state.feature_id !== info.grant.feature_id || state.task_run.task_id !== info.grant.task_id ||
        state.task_run.attempt_id !== info.grant.attempt_id || state.task_run.parent_session_id !== info.grant.parent_session_id) {
      return fail("state/grant identity mismatch");
    }
    return { ok: true, ...info, sessionId, binding: state.task_run };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Prove that task HEAD is the single clean, test-only freeze commit after the test-author hand. */
export function validateTaskFidelityFreeze({ projectRoot, sessionId, taskId, testAuthorSha }, dependencies = {}) {
  try {
    if (!HEX_40.test(testAuthorSha ?? "")) return fail("test-author commit identity required before fidelity");
    const binding = (dependencies.readTaskRunBindingFn ?? readTaskRunBinding)(projectRoot, sessionId);
    if (!binding?.ok || binding.grant?.task_id !== taskId) return fail("current task-run binding required before fidelity");
    const frozen = [...new Set((Array.isArray(binding.task?.locked_tests) ? binding.task.locked_tests : []).flatMap((item) =>
      item && typeof item === "object"
        ? [item.path, ...(Array.isArray(item.fixture_paths) ? item.fixture_paths : [])]
        : [],
    ).filter((item) => typeof item === "string" && item))];
    if (frozen.length === 0) return fail("canonical locked tests required before fidelity");
    const gitFn = dependencies.gitFn ?? ((...args) => git(projectRoot, ...args));
    const commit = String(gitFn("rev-list", "--parents", "-n", "1", "HEAD")).trim().split(/\s+/);
    if (commit.length !== 2 || !HEX_40.test(commit[0] ?? "") || commit[1] !== testAuthorSha) {
      return fail("fidelity requires one linear freeze commit immediately after the test-author hand");
    }
    const status = String(gitFn(
      "status", "--porcelain", "--untracked-files=all", "--", ".",
      ":(exclude).pi/harness/", ":(exclude)node_modules/",
    )).trim();
    if (status) return fail("task worktree must be clean before fidelity");
    const changed = String(gitFn("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"))
      .split("\0").filter(Boolean);
    if (changed.length === 0 || changed.some((item) => !frozen.includes(item))) {
      return fail("fidelity freeze commit must change only canonical locked tests and fixtures");
    }
    return { ok: true, freezeSha: commit[0], frozenPaths: frozen };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Restrict the local parent and all inherited native children to one task. */
export function decideTaskRunTool(binding, event) {
  const deny = (reason) => ({ block: true, reason: `[task-run] ${reason}` });
  if (!binding?.ok) return deny(binding?.reason ?? "validated task binding required");
  const input = event?.input ?? {};
  const name = event?.toolName;
  if (["classify", "harness_spec_write", "seal_spec_review", "harness_plan", "harness_tasks", "run_hand"].includes(name)) {
    return deny("global ceremony and task coordination are owned by the global parent");
  }
  if (name === "subagent") {
    const args = piSubagentArgs(input);
    const marker = parseTaskDispatchIdentity(args.prompt);
    if (!TASK_ROLES.has(args.subagent_type)) return deny("role is outside task implementation");
    if (!marker.ok || marker.taskId !== binding.grant.task_id) return deny("dispatch must name the granted task, including reviews");
    if (String(args.prompt).includes("[HARNESS_FINAL_REVIEW]")) return deny("global review belongs to global parent");
  }
  if (name === "mark" && (!TASK_MARKERS.has(input.action) || input.task_id !== binding.grant.task_id)) {
    return deny("only markers of the granted task are permitted");
  }
  if (name === "harness_memory" && ["apply", "finalize"].includes(input.action)) {
    return deny("durable harvest and finalization belong to the global parent");
  }
  if (["bash", "powershell"].includes(name)) {
    const command = String(input.command ?? "");
    if (/\bgit\s+-/.test(command) || /(?:^|\s|\/)git\s+(?:push|pull|merge|rebase|tag)\b/.test(command) ||
        /\bgh\s+(?:pr|release|issue)\s+(?:create|merge|edit|close)\b/.test(command) ||
        /\b(?:npm|pnpm)\s+run\s+deploy\b/.test(command) || /\bwrangler\s+(?:deploy|publish)\b/.test(command)) {
      return deny("task run cannot deliver or integrate globally");
    }
  }
  return { block: false };
}

/** Build the task brief from a stable task-runtime source and the one assigned contract. */
export function taskRunPrompt(taskRuntime, admission) {
  if (typeof taskRuntime !== "string" || !taskRuntime.trim()) throw new Error("stable task runtime prompt required");
  const dispatchRoutes = Object.fromEntries([...TASK_ROLES].map((role) => {
    const resolved = piDispatchRoute(role, admission.task.complexity);
    if (!resolved.ok) throw new Error(`task dispatch route unavailable for ${role}`);
    const { ok: _ok, ...route } = resolved;
    return [role, TASK_WRITING_ROLES.has(role)
      ? { ...route, complexity: admission.task.complexity }
      : route];
  }));
  const contract = {
    feature_id: admission.grant.feature_id,
    task: admission.task,
    dependencies: admission.grant.dependencies,
    plan_sha256: admission.grant.plan_sha256,
    spec_sha256: admission.grant.spec_sha256,
    plan_path: admission.planPath,
    spec_path: admission.specPath,
    binding: admission.binding,
    dispatch_routes: dispatchRoutes,
    ...(admission.grant.context_handoff === undefined ? {} : { context_handoff: admission.grant.context_handoff }),
  };
  return `${taskRuntime.trim()}\n\n[HARNESS_TASK_RUN]\n${JSON.stringify({
    resumed: admission.resumed === true,
    contract,
  }, null, 2)}\n[/HARNESS_TASK_RUN]`;
}

/** Snapshot the exact plan/spec revision before a real plan-reviewer dispatch. */
export function capturePlanReviewInput({ projectRoot, sessionId, featureId }) {
  try {
    if (!isSafeSessionId(sessionId) || !isSafeFeatureId(featureId)) return fail("valid plan review identity required");
    const root = fs.realpathSync(projectRoot);
    const artifacts = planAndSpec(root, featureId);
    return { ok: true, snapshot: { session_id: sessionId, feature_id: featureId, plan_sha256: artifacts.planSha256, spec_sha256: artifacts.specSha256 } };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Accept only the exact native completion and a canonical APPROVE report over unchanged inputs. */
export function parsePlanReviewCompletion({ result, isError, nativeRecord, snapshotStart, snapshotEnd }) {
  if (isError === true || result?.details?.status !== "completed" || typeof result.details.agentId !== "string") return fail("plan review did not complete");
  const agentId = result.details.agentId;
  const text = Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === "text" ? result.content[0].text : "";
  const wrapper = typeof text === "string" ? text.match(/^Agent completed in [^\r\n]+\r?\nAgent ID: ([^\r\n]+)\r?\n\r?\n([\s\S]*)$/) : null;
  if (!wrapper || wrapper[1] !== agentId || !nativeRecord || nativeRecord.status !== "completed" ||
      nativeRecord.id !== agentId || nativeRecord.type !== "harness-plan-reviewer" || nativeRecord.isBackground !== false ||
      nativeRecord.pendingQuestion != null || typeof nativeRecord.completedAt !== "number" || nativeRecord.result !== wrapper[2]) {
    return fail("native plan review completion identity mismatch");
  }
  if (!snapshotStart || !snapshotEnd || JSON.stringify(snapshotStart) !== JSON.stringify(snapshotEnd)) return fail("plan/spec changed during review");
  const report = parseReviewReportText(nativeRecord.result);
  const valid = validateReviewReport("plan-reviewer", report);
  if (!valid.ok || valid.report.verdict !== "APPROVE") return fail("canonical plan-reviewer APPROVE required");
  return { ok: true, agentId, verdict: "APPROVE" };
}

export default {
  admitTaskRun,
  readTaskRunBinding,
  decideTaskRunTool,
  taskRunPrompt,
  capturePlanReviewInput,
  parsePlanReviewCompletion,
};
