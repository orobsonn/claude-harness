/**
 * @description Same-session local inline escape hatch for the Pi ceremony.
 * The transition is host-owned and durable, but deliberately small: one baseline,
 * one changed-path set, and task impact derived from the canonical plan.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { validatePlan } from "../../shared/lib/validate-plan.mjs";
import {
  isValidWorktreeBaseline,
  listGitTouchedPaths,
  pathsChangedSinceBaseline,
  snapshotWorktreeBaseline,
} from "../../opencode/lib/worktree-baseline.mjs";
import { withGateStateLock } from "./pi-gate-state.mjs";
import { normalizeProjectPath } from "./pi-state-records.mjs";
import {
  piDispatchRecordDir,
  piExecutionPlanPath,
  piGateStatePath,
} from "./pi-paths.mjs";

const ACTIVE = "active";
const SUSPENDED = "suspended-inline";
const RECONCILING = "reconciling";
const VALID_STATUS = new Set([ACTIVE, SUSPENDED, RECONCILING]);

function deny(reason) {
  return { ok: false, reason };
}

function runGit(projectRoot, args, encoding = "utf8") {
  try {
    return {
      ok: true,
      output: execFileSync("git", args, {
        cwd: projectRoot,
        encoding,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }),
    };
  } catch {
    return { ok: false, reason: "git state unavailable" };
  }
}

function currentHead(projectRoot) {
  const result = runGit(projectRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!result.ok) return result;
  const sha = String(result.output).trim();
  return /^[a-f0-9]{40,64}$/i.test(sha)
    ? { ok: true, sha }
    : { ok: false, reason: "git HEAD unavailable" };
}

function nulPaths(output) {
  return Buffer.from(output ?? "").toString("utf8").split("\0").filter(Boolean);
}

function committedPaths(projectRoot, oldHead, newHead) {
  if (!/^[a-f0-9]{40,64}$/i.test(oldHead) || !/^[a-f0-9]{40,64}$/i.test(newHead)) {
    return { ok: false, reason: "inline baseline HEAD invalid" };
  }
  const result = runGit(
    projectRoot,
    ["diff", "--name-only", "-z", "--no-renames", oldHead, newHead, "--"],
    "buffer",
  );
  return result.ok
    ? { ok: true, paths: nulPaths(result.output) }
    : { ok: false, reason: "inline commit delta unavailable" };
}

function hostOwnedPath(relativePath) {
  return relativePath.startsWith(".pi/harness/state/") ||
    relativePath.startsWith(".pi/harness/runtime/");
}

function activeDispatchRecords(projectRoot, sessionId) {
  const resolved = piDispatchRecordDir({ projectRoot, parentSessionId: sessionId });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  try {
    const stat = fs.lstatSync(resolved.path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { ok: false, reason: "active dispatch records unavailable" };
    }
    const entries = fs.readdirSync(resolved.path);
    return entries.length === 0
      ? { ok: true, active: false }
      : { ok: true, active: true };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { ok: true, active: false };
    }
    return { ok: false, reason: "active dispatch records unavailable" };
  }
}

function pathMatches(candidate, declared) {
  if (typeof declared !== "string" || !declared) return false;
  const normalized = declared.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "." || candidate === normalized || candidate.startsWith(`${normalized}/`);
}

function qualifiedTask(featureId, taskId) {
  return `${featureId}/${taskId}`;
}

function markerBelongsToTask(entry, featureId, taskId) {
  const prefix = qualifiedTask(featureId, taskId);
  return typeof entry === "string" && (entry === prefix || entry.startsWith(`${prefix}@`));
}

function removeTaskMarkers(value, featureId, taskIds) {
  const ids = new Set(taskIds);
  return (Array.isArray(value) ? value : []).filter((entry) => {
    for (const taskId of ids) {
      if (markerBelongsToTask(entry, featureId, taskId)) return false;
    }
    return true;
  });
}

function addRegatePending(value, featureId, taskIds) {
  const result = Array.isArray(value) ? [...value] : [];
  for (const taskId of taskIds) {
    const entry = qualifiedTask(featureId, taskId);
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

function removeTaskEvidence(value, featureId, taskIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const next = { ...value };
  for (const taskId of taskIds) delete next[qualifiedTask(featureId, taskId)];
  return next;
}

function readCanonicalPlan(projectRoot, featureId) {
  const resolved = piExecutionPlanPath({ projectRoot, featureId });
  if (!resolved.ok) return resolved;
  try {
    const plan = JSON.parse(fs.readFileSync(resolved.path, "utf8"));
    if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.feature_id !== featureId) {
      return { ok: false, reason: "canonical plan feature mismatch" };
    }
    const validation = validatePlan(plan, {
      expect: "full",
      expectedModelStrategy: plan.model_strategy,
    });
    if (!validation.ok) return { ok: false, reason: "canonical plan invalid" };
    return { ok: true, plan };
  } catch {
    return { ok: false, reason: "canonical plan unavailable" };
  }
}

function impactForPaths(projectRoot, featureId, changedPaths) {
  const loaded = readCanonicalPlan(projectRoot, featureId);
  if (!loaded.ok) {
    return {
      affectedTaskIds: [],
      productionChangedTaskIds: [],
      testChangedTaskIds: [],
      unknownPaths: [...changedPaths],
      planReason: loaded.reason,
    };
  }

  const affected = [];
  const production = [];
  const tests = [];
  const ownedPaths = new Set();
  for (const task of loaded.plan.tasks) {
    const scopePaths = [];
    for (const declared of Array.isArray(task.scope_paths) ? task.scope_paths : []) {
      const normalized = normalizeProjectPath(projectRoot, declared);
      if (!normalized.ok) {
        return {
          affectedTaskIds: [], productionChangedTaskIds: [], testChangedTaskIds: [],
          unknownPaths: [...changedPaths], planReason: "canonical plan scope invalid",
        };
      }
      scopePaths.push(normalized.path);
    }
    const frozenPaths = [];
    for (const lockedTest of Array.isArray(task.locked_tests) ? task.locked_tests : []) {
      const declaredPaths = [
        lockedTest?.path,
        ...(Array.isArray(lockedTest?.fixture_paths) ? lockedTest.fixture_paths : []),
      ];
      for (const declared of declaredPaths) {
        const normalized = normalizeProjectPath(projectRoot, declared);
        if (!normalized.ok) {
          return {
            affectedTaskIds: [], productionChangedTaskIds: [], testChangedTaskIds: [],
            unknownPaths: [...changedPaths], planReason: "canonical locked test scope invalid",
          };
        }
        frozenPaths.push(normalized.path);
      }
    }
    let productionHit = false;
    let testHit = false;
    for (const changedPath of changedPaths) {
      const hitsTest = frozenPaths.some((declared) => pathMatches(changedPath, declared));
      const hitsScope = scopePaths.some((declared) => pathMatches(changedPath, declared));
      if (hitsTest || hitsScope) ownedPaths.add(changedPath);
      if (hitsTest) testHit = true;
      else if (hitsScope) productionHit = true;
    }
    if (productionHit || testHit) affected.push(task.id);
    if (productionHit) production.push(task.id);
    if (testHit) tests.push(task.id);
  }
  return {
    affectedTaskIds: affected,
    productionChangedTaskIds: production,
    testChangedTaskIds: tests,
    unknownPaths: changedPaths.filter((changedPath) => !ownedPaths.has(changedPath)),
  };
}

function reconciliationState(previous, projectRoot, changedPaths) {
  const impact = impactForPaths(projectRoot, previous.feature_id, changedPaths);
  const prior = previous.inline_reconciliation &&
    typeof previous.inline_reconciliation === "object" &&
    !Array.isArray(previous.inline_reconciliation)
    ? previous.inline_reconciliation
    : {};
  const priorArmed = Array.isArray(prior.armed_task_ids) ? prior.armed_task_ids : [];
  const priorInvalidatedTests = Array.isArray(prior.invalidated_test_task_ids)
    ? prior.invalidated_test_task_ids
    : [];
  const newlyAffected = impact.affectedTaskIds.filter((taskId) => !priorArmed.includes(taskId));
  const newlyChangedTests = impact.testChangedTaskIds.filter(
    (taskId) => !priorInvalidatedTests.includes(taskId),
  );
  const armedTaskIds = [...new Set([...priorArmed, ...impact.affectedTaskIds])];
  const invalidatedTestTaskIds = [
    ...new Set([...priorInvalidatedTests, ...impact.testChangedTaskIds]),
  ];
  const next = {
    ...previous,
    ceremony_status: RECONCILING,
    inline_changed_paths: [...changedPaths],
    inline_reconciliation: {
      affected_task_ids: impact.affectedTaskIds,
      production_changed_task_ids: impact.productionChangedTaskIds,
      test_changed_task_ids: impact.testChangedTaskIds,
      unknown_paths: impact.unknownPaths,
      armed_task_ids: armedTaskIds,
      invalidated_test_task_ids: invalidatedTestTaskIds,
      ...(impact.planReason ? { plan_reason: impact.planReason } : {}),
    },
    regate_pending: addRegatePending(previous.regate_pending, previous.feature_id, newlyAffected),
    regate_passed: removeTaskMarkers(previous.regate_passed, previous.feature_id, newlyAffected),
    fidelity_pass: removeTaskMarkers(previous.fidelity_pass, previous.feature_id, newlyChangedTests),
    task_adversary_evidence: removeTaskEvidence(
      previous.task_adversary_evidence,
      previous.feature_id,
      newlyAffected,
    ),
  };
  delete next.inline_baseline;
  delete next.final_review_evidence;
  delete next.final_review_done;
  delete next.demo_done;
  return { next, impact };
}

function activeState(previous) {
  const next = { ...previous, ceremony_status: ACTIVE };
  delete next.inline_baseline;
  delete next.inline_changed_paths;
  delete next.inline_reconciliation;
  return next;
}

/**
 * @description Suspend or resume one Pi parent ceremony in the same local interactive session.
 * Never creates a session and never treats the model's request as delivery completion.
 */
export function executePiCeremonyAction(request, context = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return deny("ceremony action object required");
  }
  if (!["suspend-inline", "resume-ceremony"].includes(request.action)) {
    return deny("unknown ceremony action");
  }
  if (context.isChild !== false ||
    (request.action === "suspend-inline" && context.isHeadless !== false)) {
    return deny("parent interactive local session required");
  }

  let projectRoot;
  try {
    projectRoot = fs.realpathSync(context.projectRoot);
  } catch {
    return deny("project root unavailable");
  }
  const statePath = piGateStatePath({ projectRoot, sessionId: context.sessionId });
  if (!statePath.ok) return deny(statePath.reason);

  if (request.action === "suspend-inline" && context.hasActiveDispatch !== false) {
    return deny("active dispatch state must be authoritatively empty");
  }

  let response;
  const locked = withGateStateLock(statePath.path, (previous) => {
    if (previous.session_id !== context.sessionId || previous.classified !== true ||
      !["LIGHT", "FULL"].includes(previous.mode)) {
      return deny("active classified ceremony identity required");
    }
    const status = previous.ceremony_status ?? ACTIVE;
    if (!VALID_STATUS.has(status)) return deny("ceremony status invalid");

    if (request.action === "suspend-inline") {
      if (status !== ACTIVE) return deny("only an active ceremony can suspend inline");
      const dispatches = activeDispatchRecords(projectRoot, context.sessionId);
      if (!dispatches.ok) return dispatches;
      if (dispatches.active) return deny("active dispatch record exists");
      const head = currentHead(projectRoot);
      if (!head.ok) return head;
      const baseline = snapshotWorktreeBaseline(projectRoot);
      if (!baseline || !isValidWorktreeBaseline(baseline, projectRoot)) {
        return deny("worktree baseline unavailable");
      }
      response = { ok: true, ceremonyStatus: SUSPENDED };
      return {
        ...previous,
        ceremony_status: SUSPENDED,
        inline_baseline: { head_sha: head.sha, worktree_baseline: baseline },
      };
    }

    if (status === SUSPENDED) {
      const baseline = previous.inline_baseline;
      if (!baseline || typeof baseline !== "object" || Array.isArray(baseline) ||
        !isValidWorktreeBaseline(baseline.worktree_baseline, projectRoot)) {
        return deny("inline baseline invalid");
      }
      const touched = listGitTouchedPaths(projectRoot);
      if (!touched.ok) return deny("inline dirty delta unavailable");
      const head = currentHead(projectRoot);
      if (!head.ok) return head;
      const committed = committedPaths(projectRoot, baseline.head_sha, head.sha);
      if (!committed.ok) return committed;
      const changedPaths = [...new Set([
        ...pathsChangedSinceBaseline(projectRoot, baseline.worktree_baseline),
        ...committed.paths,
      ])].filter((candidate) => !hostOwnedPath(candidate)).sort();
      if (changedPaths.length === 0) {
        response = { ok: true, ceremonyStatus: ACTIVE, changedPaths: [] };
        return activeState(previous);
      }
      const reconciled = reconciliationState(previous, projectRoot, changedPaths);
      response = {
        ok: true,
        ceremonyStatus: RECONCILING,
        changedPaths,
        affectedTasks: reconciled.impact.affectedTaskIds,
        unknownPaths: reconciled.impact.unknownPaths,
        reason: reconciled.impact.unknownPaths.length > 0
          ? "planner must reconcile unknown path ownership"
          : "planner/reviewer reconciliation required before resuming ceremony",
      };
      return reconciled.next;
    }

    if (status === RECONCILING) {
      if (!Array.isArray(previous.inline_changed_paths) ||
        previous.inline_changed_paths.some((entry) => typeof entry !== "string" || !entry)) {
        return deny("inline reconciliation paths invalid");
      }
      const changedPaths = [...new Set(previous.inline_changed_paths)].sort();
      const reconciled = reconciliationState(previous, projectRoot, changedPaths);
      const canActivate = reconciled.impact.unknownPaths.length === 0;
      response = {
        ok: true,
        ceremonyStatus: canActivate ? ACTIVE : RECONCILING,
        changedPaths,
        affectedTasks: reconciled.impact.affectedTaskIds,
        unknownPaths: reconciled.impact.unknownPaths,
        ...(!canActivate ? { reason: "planner must reconcile unknown path ownership" } : {}),
      };
      return canActivate ? activeState(reconciled.next) : reconciled.next;
    }

    return deny("ceremony is not suspended or reconciling");
  });
  if (!locked.ok) return { ok: false, reason: locked.reason };
  return response ?? deny("ceremony transition produced no result");
}

export default { executePiCeremonyAction };
