/** Host coordination only: admission, durable task handles and exact integration. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isSafeSessionId,
  isSafeTaskId,
  isSafeFeatureId,
} from "../../shared/lib/feature-id.mjs";
import { validatePlan } from "../../shared/lib/validate-plan.mjs";
import {
  acquireLock,
  LOCK_STALE_MS,
  releaseLock,
  loadPiGateStateFromDisk,
  withGateStateLock,
} from "./pi-gate-state.mjs";
import { readPiSpecApproval } from "./spec-approval.mjs";
import { capturePlanReviewInput } from "./task-run.mjs";
import { captureTaskContext } from "./task-context.mjs";
import { resolveOrcaTaskBackend } from "./task-orca.mjs";
import {
  TASK_PIPELINE_VERSION,
  hashTaskReceipt,
  taskAdmissionPath,
  taskRegistryPath,
  unsupportedTaskScopePattern,
} from "./task-contract.mjs";
import {
  captureTaskRuntime,
  verifyTaskRuntime,
  resolveTaskRuntimeLauncher,
} from "./task-runtime-assets.mjs";
import {
  startTaskProcess,
  readTaskProcess,
  writeTaskJson,
  taskProcessIdentity,
} from "./task-process.mjs";

export const MAX_PARALLEL_TASKS = 3;
const TASK_LAUNCHER = fileURLToPath(
  new URL("../bin/pi-harness.mjs", import.meta.url),
);
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
const fail = (reason) => ({ ok: false, reason: `[harness_tasks] ${reason}` });
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const isAncestor = (root, a, b) => {
  try {
    git(root, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const volatile = (name) =>
  /^\.pi\/harness\/(?:state|runtime|sessions|plans)\//.test(name) ||
  name.startsWith("node_modules/") ||
  /^\.pi\/\.harness-version-check-cache(?:\.tmp)?$/.test(name);
function requireClean(root) {
  const changes = [
    ...git(root, "diff", "--name-only", "--").split("\n"),
    ...git(root, "diff", "--cached", "--name-only", "--").split("\n"),
  ].filter(Boolean);
  const untracked = git(
    root,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .split("\0")
    .filter(Boolean);
  if ([...changes, ...untracked].some((name) => !volatile(name)))
    throw new Error(
      "parent worktree must be clean before task admission or integration",
    );
}
function scopeOf(task) {
  const entries = [
    ...task.scope_paths,
    ...(task.locked_tests ?? []).flatMap((test) => [
      test.path,
      ...(test.fixture_paths ?? []),
    ]),
  ];
  return entries.map((entry) => {
    if (
      typeof entry !== "string" ||
      !entry ||
      path.posix.isAbsolute(entry) ||
      entry.includes("\\") ||
      entry.includes("\0") ||
      entry.split("/").includes("..")
    )
      throw new Error("task scope must use safe repo-relative paths");
    if (unsupportedTaskScopePattern(entry))
      throw new Error(
        `task scope ${JSON.stringify(entry)} uses unsupported glob syntax; use an explicit file or directory path`,
      );
    const normalized = path.posix.normalize(entry).replace(/\/$/, "");
    if (normalized === ".") return "";
    return normalized;
  });
}
export function taskScopesOverlap(a, b) {
  return scopeOf(a).some((left) =>
    scopeOf(b).some(
      (right) =>
        !left ||
        !right ||
        left === right ||
        left.startsWith(`${right}/`) ||
        right.startsWith(`${left}/`),
    ),
  );
}
function admission(context) {
  const root = fs.realpathSync(context.projectRoot);
  if (context.isChild || !isSafeSessionId(context.sessionId))
    throw new Error("only the current global parent may coordinate tasks");
  const loaded = loadPiGateStateFromDisk(root, {
    sessionId: context.sessionId,
  });
  const state = loaded.state;
  if (
    !loaded.ok ||
    state?.session_id !== context.sessionId ||
    state.task_run ||
    state.task_pipeline_version !== TASK_PIPELINE_VERSION ||
    !isSafeFeatureId(state.feature_id)
  )
    throw new Error("classified LIGHT/FULL task-pipeline parent required");
  return {
    root,
    state,
    featureId: state.feature_id,
    sessionId: context.sessionId,
  };
}
function approvedPlan(owner) {
  if (["suspended-inline", "reconciling"].includes(owner.state.ceremony_status))
    throw new Error("ceremony is suspended or reconciling");
  const input = {
    projectRoot: owner.root,
    sessionId: owner.sessionId,
    featureId: owner.featureId,
  };
  const spec = readPiSpecApproval(input);
  if (!spec.ok) throw new Error(spec.reason);
  const captured = capturePlanReviewInput(input);
  if (!captured.ok) throw new Error(captured.reason);
  const receipt = owner.state.plan_review_evidence;
  if (
    receipt?.written_by !== "host-subagent-completion" ||
    receipt.parent_session_id !== owner.sessionId ||
    receipt.feature_id !== owner.featureId ||
    receipt.role !== "harness-plan-reviewer" ||
    receipt.status !== "completed" ||
    receipt.verdict !== "APPROVE" ||
    !receipt.dispatch_call_id ||
    !receipt.child_session_id ||
    !receipt.agent_id ||
    receipt.plan_sha256 !== captured.snapshot.plan_sha256 ||
    receipt.spec_sha256 !== captured.snapshot.spec_sha256
  )
    throw new Error(
      'host-confirmed APPROVE for the current plan and spec required; dispatch a fresh foreground harness-plan-reviewer against the current artifacts and require exactly one canonical JSON report, for example {"verdict":"APPROVE","findings":[]}; plaintext APPROVE is not a receipt',
    );
  const directory = path.join(owner.root, ".pi/harness/plans", owner.featureId);
  const plan = read(path.join(directory, "execution-plan.json"));
  const valid = validatePlan(plan, {
    expect: "full",
    expectedModelStrategy: plan.model_strategy,
  });
  if (!valid.ok || plan.feature_id !== owner.featureId)
    throw new Error(
      `invalid canonical plan: ${(valid.errors ?? []).join("; ")}`,
    );
  for (const task of plan.tasks) {
    scopeOf(task);
    if (!Array.isArray(task.depends_on))
      throw new Error(`task ${task.id} must declare depends_on`);
  }
  return { plan, directory, ...captured.snapshot, receipt };
}
function summary(entry) {
  return {
    task_id: entry.task_id,
    attempt_id: entry.attempt_id,
    status: entry.status,
    worktree: entry.worktree,
    session_id: entry.result?.session_id,
    child_head: entry.result?.child_head,
    ...(entry.orca ? { orca: entry.orca } : {}),
    ...(entry.result?.context_return ? { context_return: entry.result.context_return } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    launches: entry.launches.map((launch) => ({
      run_id: launch.run_id,
      pid: launch.pid,
      events_path: launch.events_path,
      ...(launch.orca ? { orca: launch.orca } : {}),
    })),
    ...(entry.integration ? { integration: entry.integration } : {}),
  };
}
function requireFrozen(root, tree, results) {
  for (const result of results)
    for (const [file, expected] of Object.entries(result?.frozen_blobs ?? {})) {
      const actual = execFileSync("git", ["show", `${tree}:${file}`], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (hash(actual) !== expected)
        throw new Error(`integration would change frozen test ${file}`);
    }
}
function receiptFor(entry, head) {
  return {
    version: 1,
    written_by: "host-task-integration",
    parent_session_id: entry.parent_session_id,
    feature_id: entry.feature_id,
    task_id: entry.task_id,
    attempt_id: entry.attempt_id,
    parent_root: entry.parent_root,
    worktree: entry.worktree,
    session_id: entry.result.session_id,
    plan_sha256: entry.plan_sha256,
    spec_sha256: entry.spec_sha256,
    base_sha: entry.base_sha,
    child_head: entry.result.child_head,
    integrated_head: head,
    result_sha256: hashTaskReceipt(entry.result),
  };
}
function reconcileMerge(owner, registry, persist) {
  const intent = registry.integration_intent;
  if (!intent) return;
  const entry = registry.tasks[intent.task_id];
  if (
    !entry ||
    entry.attempt_id !== intent.attempt_id ||
    hashTaskReceipt(entry.result) !== intent.result_sha256
  )
    throw new Error("integration journal identity mismatch");
  const current = git(owner.root, "rev-parse", "HEAD");
  if (current === intent.parent_head) {
    let merging;
    try {
      merging = git(owner.root, "rev-parse", "--verify", "MERGE_HEAD");
    } catch {}
    if (merging) {
      if (
        merging !== intent.child_head ||
        git(owner.root, "write-tree") !== intent.tree ||
        git(owner.root, "diff", "--name-only") ||
        git(owner.root, "ls-files", "--others", "--exclude-standard", "-z")
          .split("\0")
          .filter(Boolean)
          .some((name) => !volatile(name))
      )
        throw new Error(
          "interrupted merge has additional changes; preserve the journal and reconcile this worktree",
        );
      git(owner.root, "merge", "--abort");
    }
    requireClean(owner.root);
    delete registry.integration_intent;
    persist();
    return;
  }
  const parents = git(owner.root, "rev-list", "--parents", "-n", "1", current)
    .split(" ")
    .slice(1);
  if (
    parents.length !== 2 ||
    parents[0] !== intent.parent_head ||
    parents[1] !== intent.child_head ||
    git(owner.root, "rev-parse", `${current}^{tree}`) !== intent.tree
  )
    throw new Error(
      "integration journal needs reconciliation: current HEAD differs from the reserved merge",
    );
  requireClean(owner.root);
  entry.integration = receiptFor(entry, current);
  entry.status = "integrated";
  delete entry.reason;
  delete registry.integration_intent;
  if (registry.correction_barrier?.task_id === entry.task_id)
    delete registry.correction_barrier;
  persist();
}
function invalidateAggregate(owner, registry, persist) {
  const reset = withGateStateLock(
    path.join(
      owner.root,
      ".pi/harness/state",
      owner.sessionId,
      "gate-state.json",
    ),
    (state) => {
      const next = { ...state };
      for (const key of [
        "final_review_done",
        "demo_done",
        "final_review_evidence",
      ])
        delete next[key];
      return next;
    },
  );
  if (!reset.ok)
    throw new Error(
      "could not invalidate aggregate approval before task correction",
    );
  if (registry.correction_barrier.aggregate_invalidated !== true) {
    registry.correction_barrier.aggregate_invalidated = true;
    persist();
  }
}
async function prepareWorktree(entry, artifacts, deps, persist) {
  if (deps.orcaBackend) await deps.orcaBackend.prepareWorktree(entry, persist);
  if (!fs.existsSync(entry.worktree))
    if (deps.orcaBackend) throw new Error("reserved Orca worktree is missing");
    else git(
      entry.parent_root,
      "worktree",
      "add",
      "-b",
      entry.branch,
      entry.worktree,
      entry.base_sha,
    );
  if (
    git(entry.worktree, "branch", "--show-current") !== entry.branch ||
    !isAncestor(entry.worktree, entry.base_sha, "HEAD")
  )
    throw new Error("reserved task worktree changed identity");
  const target = path.join(
    entry.worktree,
    ".pi/harness/plans",
    entry.feature_id,
  );
  fs.mkdirSync(target, { recursive: true });
  for (const name of ["execution-plan.json", "spec.md"])
    fs.copyFileSync(
      path.join(artifacts.directory, name),
      path.join(target, name),
    );
  // Dependencies are copied, not symlinked: test/build caches stay local to each task.
  const modules = path.join(entry.parent_root, "node_modules");
  if (
    fs.existsSync(modules) &&
    !fs.existsSync(path.join(entry.worktree, "node_modules"))
  )
    fs.cpSync(modules, path.join(entry.worktree, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  const runtime = path.join(entry.parent_root, ".pi/harness/runtime");
  for (const name of ["settings.json", "subagents.json", "harness.json"]) {
    const source = path.join(runtime, name);
    const destination = path.join(entry.worktree, ".pi/harness/runtime", name);
    if (fs.existsSync(source) && !fs.existsSync(destination)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }
  if (!fs.existsSync(entry.grant_path))
    writeTaskJson(entry.grant_path, entry.grant);
  if (!entry.runtime) {
    const resolved = deps.resolveRuntime({
      parentRoot: entry.parent_root,
      worktree: entry.worktree,
      runtimeRoot: path.join(
        path.dirname(
          taskRegistryPath(entry.parent_root, entry.parent_session_id),
        ),
        "runtime",
      ),
      baseSha: entry.runtime_base_sha,
      sourceLauncher: TASK_LAUNCHER,
    });
    if (!resolved.ok) throw new Error(resolved.reason);
    const captured = deps.captureRuntime(resolved.launcherPath);
    if (!captured.ok) throw new Error(captured.reason);
    entry.runtime = captured.runtime;
  }
  const checkedRuntime = deps.verifyRuntime(entry.runtime);
  if (!checkedRuntime.ok) throw new Error(checkedRuntime.reason);
}
async function launchTask(entry, context, persist, deps, instruction) {
  const runId = randomUUID();
  const jobDir = path.join(entry.job_dir, runId);
  // An admitted attempt keeps its transport: older pinned runtimes have no TUI event sink.
  const presentation = entry.launches.length
    ? (entry.launches[0].presentation ?? "json")
    : (deps.orcaBackend ? "tui" : "json");
  const launch = {
    run_id: runId,
    pid: null,
    presentation,
    ...(deps.orcaBackend ? { terminal_mode: true } : {}),
    runtime: entry.runtime,
    creator_pid: process.pid,
    creator_start_ticks: taskProcessIdentity(process.pid)?.start,
    worker_path: fileURLToPath(
      new URL("../bin/pi-task-worker.mjs", import.meta.url),
    ),
    descriptor_path: path.join(jobDir, "job.json"),
    events_path: path.join(jobDir, "events.jsonl"),
    process_path: path.join(jobDir, "process.json"),
    result_path: path.join(jobDir, "result.json"),
  };
  let localSession;
  if (fs.existsSync(`${entry.grant_path}.claim`))
    localSession = read(`${entry.grant_path}.claim`).session_id;
  if (localSession !== undefined && !isSafeSessionId(localSession))
    throw new Error("task session claim is invalid");
  const prompt =
    instruction ||
    "Execute the admitted task using the task pipeline. Complete the native TDD, applicable reviewers and current capture. Return only after the task is ready for host integration.";
  const args = [
    entry.runtime.launcher_path,
    ...(localSession
      ? ["--harness-resume", localSession]
      : ["--harness-task", entry.grant_path]),
    ...(presentation === "tui" ? ["--no-approve"] : ["--mode", "json", "-p"]),
    ...(context.thinkingLevel ? ["--thinking", context.thinkingLevel] : []),
    ...(context.model?.provider && context.model?.id
      ? ["--provider", context.model.provider, "--model", context.model.id]
      : []),
    prompt,
  ];
  entry.launches.push(launch);
  entry.status = "running";
  entry.result = null;
  entry.integration = null;
  delete entry.reason;
  persist();
  try {
    const handle = await deps.startProcess({
      jobDir,
      runId,
      cwd: entry.worktree,
      command: process.execPath,
      args,
      presentation,
      runtime: entry.runtime,
      ...(deps.orcaBackend ? {
        launchTerminal: (input) => deps.orcaBackend.launchTerminal({ ...input, worktreeId: entry.orca.worktree_id, instanceId: entry.orca.instance_id, title: `${entry.task_id} · ${localSession ? "resume" : "implementação"}` }),
      } : {}),
    });
    Object.assign(launch, handle);
    persist();
  } catch (error) {
    if (error.task_launch) Object.assign(launch, error.task_launch);
    if (error.before_spawn === true)
      launch.start_failure = {
        written_by: "host-task-launch",
        reason: error.message,
        at: new Date().toISOString(),
      };
    entry.status = "blocked";
    entry.reason = `task launch failed: ${error.message}`;
    persist();
    throw error;
  }
}
function descendants(plan, taskId) {
  const ids = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of plan.tasks)
      if (!ids.has(task.id) && task.depends_on.some((id) => ids.has(id))) {
        ids.add(task.id);
        changed = true;
      }
  }
  ids.delete(taskId);
  return [...ids];
}

/** Tool context supplies the native parent identity; parameters cannot choose paths or sessions. */
export async function executeTaskAction(params, context = {}, injected = {}) {
  let lock;
  let registryPath;
  try {
    const owner = admission(context);
    if (
      !params ||
      !["dispatch", "status", "integrate", "resume"].includes(params.action)
    )
      throw new Error("unknown task action");
    const allowed = {
      dispatch: ["action", "task_ids", "task_contexts"],
      status: ["action", "task_id"],
      integrate: ["action", "task_id", "attempt_id", "expected_head"],
      resume: ["action", "task_id", "attempt_id", "instruction"],
    }[params.action];
    if (Object.keys(params).some((key) => !allowed.includes(key)))
      throw new Error("unexpected task parameters");
    if (params.task_id !== undefined && !isSafeTaskId(params.task_id))
      throw new Error("safe task_id required");
    registryPath = taskRegistryPath(owner.root, owner.sessionId);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    lock = acquireLock(registryPath, { timeoutMs: 5, staleMs: LOCK_STALE_MS });
    if (!lock.ok)
      throw new Error(
        "task coordinator busy; observe or retry the same action",
      );
    let registry = fs.existsSync(registryPath) ? read(registryPath) : null;
    if (
      registry &&
      (registry.version !== 1 ||
        registry.parent_session_id !== owner.sessionId ||
        registry.feature_id !== owner.featureId ||
        !registry.tasks)
    )
      throw new Error("task registry identity mismatch");
    const persist = () => {
      registry.revision = (registry.revision ?? 0) + 1;
      writeTaskJson(registryPath, registry);
    };
    const deps = {
      startProcess: startTaskProcess,
      readProcess: readTaskProcess,
      captureRuntime: captureTaskRuntime,
      resolveRuntime: resolveTaskRuntimeLauncher,
      verifyRuntime: verifyTaskRuntime,
      resolveOrca: resolveOrcaTaskBackend,
      ...injected,
    };
    deps.inspectRun ??= (entry) =>
      import("./task-receipts.mjs").then((module) =>
        module.inspectTaskRun(entry),
      );
    deps.readIntegrated ??= (input) =>
      import("./task-receipts.mjs").then((module) =>
        module.readIntegratedTaskEvidence(input),
      );
    if (registry?.correction_barrier)
      invalidateAggregate(owner, registry, persist);
    if (registry) reconcileMerge(owner, registry, persist);
    if (params.action === "status") {
      if (!registry)
        return { ok: true, tasks: [], max_parallel_tasks: MAX_PARALLEL_TASKS };
      const entries = params.task_id
        ? [registry.tasks[params.task_id]]
        : Object.values(registry.tasks);
      if (entries.some((entry) => !entry)) throw new Error("unknown task");
      for (const entry of entries) {
        if (entry.status === "integrated") continue;
        if (entry.launches.length === 0) {
          entry.status = "blocked";
          entry.reason = "reserved task has not started; resume this attempt";
          continue;
        }
        const lifecycle = entry.launches.map(deps.readProcess);
        if (lifecycle.some((state) => !state.terminal)) {
          entry.status = "running";
          entry.reason = lifecycle.find((state) => !state.ok)?.reason;
          continue;
        }
        const inspected = await deps.inspectRun(entry);
        if (inspected.ok) {
          entry.result = inspected.result;
          entry.status = "ready";
          delete entry.reason;
        } else {
          entry.status = "blocked";
          entry.reason = inspected.reason;
        }
      }
      persist();
      return {
        ok: true,
        tasks: entries.map(summary),
        max_parallel_tasks: MAX_PARALLEL_TASKS,
      };
    }
    const artifacts = approvedPlan(owner);
    if (!registry) {
      registry = {
        version: 1,
        parent_session_id: owner.sessionId,
        feature_id: owner.featureId,
        plan_sha256: artifacts.plan_sha256,
        spec_sha256: artifacts.spec_sha256,
        tasks: {},
      };
    }
    if (
      registry.plan_sha256 !== artifacts.plan_sha256 ||
      registry.spec_sha256 !== artifacts.spec_sha256
    )
      throw new Error(
        "canonical plan/spec changed after task admission; reconcile the plan before dispatch",
      );
    if (["dispatch", "resume"].includes(params.action) && (context.orca || registry.orca_parent)) {
      if (!context.orca?.worktreeId)
        throw new Error("resume this global parent in its Orca workspace before launching task work");
      deps.orcaBackend = await deps.resolveOrca({ projectRoot: owner.root, ...context.orca });
      if (registry.orca_parent &&
          hashTaskReceipt(registry.orca_parent) !== hashTaskReceipt(deps.orcaBackend.parent))
        throw new Error("Orca global workspace identity changed");
      registry.orca_parent ??= deps.orcaBackend.parent;
    }
    if (
      registry.correction_barrier &&
      (params.action === "dispatch" ||
        params.task_id !== registry.correction_barrier.task_id)
    )
      throw new Error(
        `Correction of ${registry.correction_barrier.task_id} must be integrated before other task changes`,
      );
    if (params.action === "dispatch") {
      if (
        !Array.isArray(params.task_ids) ||
        params.task_ids.length === 0 ||
        params.task_ids.length > MAX_PARALLEL_TASKS ||
        new Set(params.task_ids).size !== params.task_ids.length ||
        params.task_ids.some((id) => !isSafeTaskId(id))
      )
        throw new Error(
          `dispatch requires one to ${MAX_PARALLEL_TASKS} distinct safe task_ids`,
        );
      const requested = params.task_ids.map((id) =>
        artifacts.plan.tasks.find((task) => task.id === id),
      );
      if (requested.some((task) => !task)) throw new Error("unknown task");
      const contexts = new Map();
      if (params.task_contexts !== undefined) {
        if (!Array.isArray(params.task_contexts) || params.task_contexts.length > requested.length)
          throw new Error("task_contexts must contain at most one curated brief per requested task");
        for (const item of params.task_contexts) {
          if (!item || Object.keys(item).some((key) => !["task_id", "content"].includes(key)) ||
              !params.task_ids.includes(item.task_id) || contexts.has(item.task_id))
            throw new Error("each task context must identify one requested task exactly once");
          const snapshot = captureTaskContext({ projectRoot: owner.root, sessionId: owner.sessionId, taskId: item.task_id, content: item.content });
          const existing = registry.tasks[item.task_id];
          if (existing && existing.grant.context_handoff?.content_sha256 !== snapshot.content_sha256)
            throw new Error("admitted task context is immutable; use bounded resume feedback for corrections");
          contexts.set(item.task_id, snapshot);
        }
      }
      const fresh = requested.filter((task) => !registry.tasks[task.id]);
      if (!fresh.length)
        return {
          ok: true,
          tasks: requested.map((task) => summary(registry.tasks[task.id])),
        };
      requireClean(owner.root);
      const base = git(owner.root, "rev-parse", "HEAD");
      registry.runtime_base_sha ??= base;
      const outstanding = Object.values(registry.tasks).filter(
        (entry) => entry.status !== "integrated",
      );
      if (
        outstanding.filter((entry) =>
          ["running", "preparing"].includes(entry.status),
        ).length +
          fresh.length >
        MAX_PARALLEL_TASKS
      )
        throw new Error(
          "parallel task limit reached; observe existing handles",
        );
      for (const task of fresh) {
        for (const depId of task.depends_on) {
          const dep = registry.tasks[depId];
          if (
            dep?.status !== "integrated" ||
            !isAncestor(owner.root, dep.integration?.integrated_head, base)
          )
            throw new Error(
              `dependency ${depId} must be integrated before ${task.id}`,
            );
          const checked = await deps.readIntegrated({
            projectRoot: owner.root,
            sessionId: owner.sessionId,
            featureId: owner.featureId,
            taskId: depId,
            headSha: base,
          });
          if (!checked.ok) throw new Error(checked.reason);
        }
        const conflicts = [
          ...outstanding.map((entry) =>
            artifacts.plan.tasks.find((item) => item.id === entry.task_id),
          ),
          ...fresh.filter((item) => item.id !== task.id),
        ];
        if (conflicts.some((other) => taskScopesOverlap(task, other)))
          throw new Error(
            `task ${task.id} overlaps another unintegrated task, test or fixture`,
          );
      }
      for (const task of fresh) {
        const attemptId = randomUUID();
        const worktree = path.join(
          path.dirname(registryPath),
          "worktrees",
          attemptId,
        );
        const branch = `harness/task-${task.id}-${attemptId}`;
        const grant = {
          version: 1,
          kind: "task-run",
          parent_session_id: owner.sessionId,
          parent_root: owner.root,
          attempt_id: attemptId,
          feature_id: owner.featureId,
          task_id: task.id,
          cwd: worktree,
          branch,
          base_sha: base,
          plan_sha256: artifacts.plan_sha256,
          spec_sha256: artifacts.spec_sha256,
          ...(contexts.has(task.id) ? { context_handoff: contexts.get(task.id) } : {}),
          origin: {
            kind: "parent-approved-plan",
            plan_review_call_id: artifacts.receipt.dispatch_call_id,
          },
          dependencies: task.depends_on.map((task_id) => {
            const receipt = registry.tasks[task_id].integration;
            return {
              task_id,
              child_head: receipt.child_head,
              integrated_head: receipt.integrated_head,
              receipt_sha256: hashTaskReceipt(receipt),
              receipt,
            };
          }),
        };
        registry.tasks[task.id] = {
          task_id: task.id,
          attempt_id: attemptId,
          parent_session_id: owner.sessionId,
          parent_root: owner.root,
          feature_id: owner.featureId,
          plan_sha256: artifacts.plan_sha256,
          spec_sha256: artifacts.spec_sha256,
          base_sha: base,
          runtime_base_sha: registry.runtime_base_sha,
          worktree,
          branch,
          grant_path: taskAdmissionPath(worktree, attemptId),
          grant,
          job_dir: path.join(path.dirname(registryPath), "jobs", attemptId),
          status: "preparing",
          launches: [],
          result: null,
          integration: null,
        };
      }
      persist();
      for (const task of fresh) {
        const entry = registry.tasks[task.id];
        try {
          await prepareWorktree(entry, artifacts, deps, persist);
          await launchTask(entry, context, persist, deps);
        } catch (error) {
          entry.status = "blocked";
          entry.reason = error.message;
          persist();
        }
      }
      return {
        ok: true,
        tasks: requested.map((task) => summary(registry.tasks[task.id])),
      };
    }
    const entry = registry.tasks[params.task_id];
    if (!entry || params.attempt_id !== entry.attempt_id)
      throw new Error("exact current task and attempt required");
    if (params.action === "resume") {
      if (
        params.instruction !== undefined &&
        (typeof params.instruction !== "string" ||
          !params.instruction.trim() ||
          params.instruction.length > 16000)
      )
        throw new Error(
          "resume instruction must contain at most 16000 characters",
        );
      if (entry.launches.some((launch) => !deps.readProcess(launch).terminal))
        throw new Error("task process group must terminate before resume");
      const affected = descendants(artifacts.plan, entry.task_id).filter(
        (id) => registry.tasks[id],
      );
      const pending = affected.filter(
        (id) => registry.tasks[id].status !== "integrated",
      );
      if (pending.length)
        throw new Error(
          `integrate admitted dependents (${pending.join(", ")}) before correcting this task`,
        );
      if (entry.integration) {
        entry.integration_history ??= [];
        entry.integration_history.push(entry.integration);
        entry.result_history ??= {};
        entry.result_history[entry.integration.result_sha256] = entry.result;
        registry.correction_barrier = {
          task_id: entry.task_id,
          attempt_id: entry.attempt_id,
          aggregate_invalidated: false,
        };
        entry.integration = null;
        entry.result = null;
        entry.status = "blocked";
        persist();
        invalidateAggregate(owner, registry, persist);
      }
      await prepareWorktree(entry, artifacts, deps, persist);
      await launchTask(entry, context, persist, deps, params.instruction);
      return { ok: true, tasks: [summary(entry)] };
    }
    if (!/^[a-f0-9]{40}$/.test(params.expected_head ?? ""))
      throw new Error("exact expected_head commit required");
    if (entry.status === "integrated") {
      if (entry.integration.child_head !== params.expected_head)
        throw new Error("integrated task HEAD differs from expected_head");
      return { ok: true, tasks: [summary(entry)] };
    }
    const checkedRuntime = deps.verifyRuntime(entry.runtime);
    if (!checkedRuntime.ok) throw new Error(checkedRuntime.reason);
    const inspected = await deps.inspectRun(entry);
    if (!inspected.ok) throw new Error(inspected.reason);
    if (inspected.result.child_head !== params.expected_head)
      throw new Error("verified task HEAD differs from expected_head");
    entry.result = inspected.result;
    requireClean(owner.root);
    const parentHead = git(owner.root, "rev-parse", "HEAD");
    if (!isAncestor(owner.root, entry.base_sha, parentHead))
      throw new Error("task base is no longer an ancestor of parent HEAD");
    const tree = git(
      owner.root,
      "merge-tree",
      "--write-tree",
      parentHead,
      params.expected_head,
    ).split("\n")[0];
    requireFrozen(owner.root, tree, [
      entry.result,
      ...Object.values(registry.tasks)
        .filter((item) => item.status === "integrated")
        .map((item) => item.result),
    ]);
    registry.integration_intent = {
      task_id: entry.task_id,
      attempt_id: entry.attempt_id,
      parent_head: parentHead,
      child_head: params.expected_head,
      tree,
      result_sha256: hashTaskReceipt(entry.result),
    };
    persist();
    git(
      owner.root,
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      `Integrate harness task ${entry.task_id} (${entry.attempt_id})`,
      params.expected_head,
    );
    reconcileMerge(owner, registry, persist);
    return { ok: true, tasks: [summary(entry)] };
  } catch (error) {
    return fail(error.message);
  } finally {
    if (lock?.ok) releaseLock(registryPath, lock.token);
  }
}

/** Freeze the approved plan/spec while their task grants exist. Read-only host rail. */
export function decideTaskCoordinatorEdit(event, context = {}) {
  const planningMutation =
    ["classify", "harness_spec_write", "seal_spec_review"].includes(
      event?.toolName,
    ) ||
    (event?.toolName === "subagent" &&
      ["harness-planner", "harness-plan-reviewer"].includes(
        event?.input?.subagent_type,
      ));
  if (!planningMutation || context.isChild) return null;
  try {
    const loaded = loadPiGateStateFromDisk(context.projectRoot, {
      sessionId: context.sessionId,
    });
    if (
      !loaded.ok ||
      loaded.state?.task_pipeline_version !== 1 ||
      loaded.state.task_run
    )
      return null;
    const file = taskRegistryPath(context.projectRoot, context.sessionId);
    if (!fs.existsSync(file)) return null;
    const registry = read(file);
    if (!registry.tasks || Object.keys(registry.tasks).length > 0) {
      return {
        block: true,
        reason:
          "[harness_tasks] Plan and spec are fixed for this session after the first task admission, including completed tasks. Correct implementation within the approved plan via resume. A changed plan requires a new session and fresh approval; preserve the existing worktrees and evidence.",
      };
    }
    return null;
  } catch {
    return {
      block: true,
      reason:
        "[harness_tasks] Task registry cannot be read safely before changing the approved plan.",
    };
  }
}
