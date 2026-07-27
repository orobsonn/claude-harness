/**
 * @description Locked tests for plan-gate wire (plan-gate-wire).
 * executor/sniper require full plan at planDir; Explore skips plan require.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createPlanGateHooks } from "./plan-gate.ts"
import { readPlannerArtifact, writeBoundPlanSnapshot } from "./lib/planner-artifact.mjs"
import { sealedMarkerRecord } from "./lib/marker-seal.mjs"

const SESSION = "ses_planGateTest01"
const FEATURE = "feat-plan-gate"

function sealGateState(gateState) {
  const state = { session_id: SESSION, ...gateState }
  const featureId = typeof state.feature_id === "string" ? state.feature_id : FEATURE
  const markerSeals = Array.isArray(state.marker_seals) ? [...state.marker_seals] : []
  if (typeof state.dual_status === "string") markerSeals.push(sealedMarkerRecord({ sessionId: SESSION, featureId, operation: "dual", payload: state.dual_status }))
  if (typeof state.plan_verdict === "string") markerSeals.push(sealedMarkerRecord({ sessionId: SESSION, featureId, operation: "plan_verdict", payload: state.plan_verdict }))
  if (state.brainstormed === true) markerSeals.push(sealedMarkerRecord({ sessionId: SESSION, featureId, operation: "brainstormed", payload: true }))
  if (state.adversary_fired === true) markerSeals.push(sealedMarkerRecord({ sessionId: SESSION, featureId, operation: "adversary_fired", payload: true }))
  state.marker_seals = markerSeals
  return state
}

const GOLDEN_FULL = {
  feature_id: FEATURE,
  kind: "full",
  mode: "full",
  tasks: [
    {
      id: "t0-skeleton",
      severity: "medium",
      complexity: "high",
      scope_paths: ["core/opencode/plugin/"],
      criterion_refs: ["#ac-1.5"],
      locked_tests: [{ id: "lt-1", path: "core/opencode/plugin/plan-gate.test.mjs", assertion: "Given plan, When gated, Then ok" }],
    },
  ],
}

/**
 * @param {(root: string) => void | Promise<void>} fn
 */
async function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-gate-"))
  try {
    await fn(root)
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} gateState
 * @param {unknown} [plan]
 */
function seedProject(root, gateState, plan) {
  const stateDir = path.join(root, ".opencode", "plans", ".state", SESSION)
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    path.join(stateDir, "gate-state.json"),
    JSON.stringify(sealGateState(gateState)),
    "utf8",
  )
  fs.mkdirSync(path.join(root, ".opencode"), { recursive: true })
  fs.writeFileSync(
    path.join(root, ".opencode", "harness.routing.json"),
    JSON.stringify({
      constraints: { requireDualOn: ["plan-reviewer", "adversary"] },
    }),
    "utf8",
  )
  if (plan !== undefined) {
    const planDirPath = path.join(
      root,
      ".opencode",
      "plans",
      `${SESSION}-${FEATURE}`,
    )
    fs.mkdirSync(planDirPath, { recursive: true })
    fs.writeFileSync(
      path.join(planDirPath, "execution-plan.json"),
      JSON.stringify(plan),
      "utf8",
    )
  }
}

/**
 * @param {string} root
 * @param {string} subagentType
 */
async function runHook(root, subagentType) {
  const hooks = await createPlanGateHooks(root)
  const taskLevel = /^(?:executor|sniper|test-author)/.test(subagentType)
  return hooks["tool.execute.before"](
    { tool: "task", sessionID: SESSION },
    { args: {
      description: `dispatch ${subagentType}`,
      prompt: taskLevel
        ? `[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]\nDo the task.`
        : "Review the bound plan.",
      subagent_type: subagentType,
    } },
  )
}

test("lt-pg-no-binding: executor + empty gate-state (no planner binding) is permitted [#ac-1.1]", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, {
      feature_id: FEATURE,
      dual_status: "both", plan_verdict: "APPROVE",
    })
    // Operator/fix-mode case: no planner ceremony ever ran for this session — no
    // planner_status/planner_plan_binding on gate-state. Absent binding -> skip fail-open.
    await assert.doesNotReject(() => runHook(root, "executor-high"))
  })
})

test("lt-pg-stub-no-binding: sniper + stub plan file with no binding is still permitted [#ac-1.1]", async () => {
  await withTempRoot(async (root) => {
    seedProject(
      root,
      { feature_id: FEATURE, dual_status: "both", plan_verdict: "APPROVE" },
      { kind: "stub", mode: "LIGHT", feature_id: FEATURE, tasks: [] },
    )
    // A raw/stub plan file sitting on disk without a planner_plan_binding is not enough
    // to trigger enforcement — only a real bound attempt is validated.
    await assert.doesNotReject(() => runHook(root, "sniper-medium"))
  })
})

test("lt-pg-explore: non-executor Explore skips plan require for missing plan", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, {
      feature_id: FEATURE,
      dual_status: "pending",
    })
    await assert.doesNotReject(() => runHook(root, "Explore"))
  })
})

test("lt-pg-valid: executor + valid full plan does not plan-gate deny", async () => {
  await withTempRoot(async (root) => {
    seedProject(
      root,
      { feature_id: FEATURE, dual_status: "both", plan_verdict: "APPROVE" },
      GOLDEN_FULL,
    )
    const artifact = readPlannerArtifact(root, SESSION, FEATURE)
    const snapshot = writeBoundPlanSnapshot(root, SESSION, artifact)
    assert.equal(snapshot.ok, true)
    const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json")
    fs.writeFileSync(statePath, JSON.stringify(sealGateState({
      feature_id: FEATURE,
      dual_status: "both", plan_verdict: "APPROVE",
      planner_status: "usable",
      planner_plan_binding: {
        session_id: SESSION,
        feature_id: FEATURE,
        semantic_hash: artifact.semanticHash,
        file_hash: artifact.fileHash,
        fingerprint: artifact.fingerprint,
        snapshot_path: snapshot.relativePath,
        snapshot_hash: artifact.semanticHash,
      },
    })))
    await assert.doesNotReject(() => runHook(root, "executor-low"))
  })
})

test("lt-pg-dispatch-identity: official Task shape derives feature from session and task from strict prompt marker", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, { feature_id: FEATURE, dual_status: "both", plan_verdict: "APPROVE" }, GOLDEN_FULL)
    const artifact = readPlannerArtifact(root, SESSION, FEATURE)
    const snapshot = writeBoundPlanSnapshot(root, SESSION, artifact)
    const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json")
    fs.writeFileSync(statePath, JSON.stringify(sealGateState({
      feature_id: FEATURE,
      dual_status: "both", plan_verdict: "APPROVE",
      planner_status: "usable",
      planner_plan_binding: {
        session_id: SESSION,
        feature_id: FEATURE,
        semantic_hash: artifact.semanticHash,
        snapshot_path: snapshot.relativePath,
        snapshot_hash: artifact.semanticHash,
      },
    })))
    const hooks = await createPlanGateHooks(root)
    const dispatch = (prompt, extras = {}) => hooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION },
      { args: { description: "implement", prompt, subagent_type: "executor-low", ...extras } },
    )
    const valid = `[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]\nImplement.`
    await assert.doesNotReject(() => dispatch(valid))
    await assert.rejects(() => dispatch(valid, { feature_id: "foreign" }), /feature_id/)
    await assert.rejects(() => dispatch(`[HARNESS_TASK_CONTEXT]{"task_id":"missing-task"}[/HARNESS_TASK_CONTEXT]`), /task_id/)
    await assert.rejects(() => dispatch("Implement without marker."), /marker/)
    // Official Task.task_id / command are host resume fields — do not conflict with marker role/task.
    await assert.doesNotReject(() => dispatch(valid, {
      task_id: "official-host-resume-id",
      command: "resume-or-skill-command",
    }))
    // Harness-only taskId alias still conflicts with the prompt marker.
    await assert.rejects(() => dispatch(valid, { taskId: "missing-task" }), /conflict/)
    const review = (args) => hooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION },
      { args: { description: "review", prompt: "Review plan.", subagent_type: "plan-reviewer-family-1", ...args } },
    )
    await assert.rejects(() => review({ feature_id: "foreign" }), /feature_id/)
    await assert.rejects(() => review({ feature_id: FEATURE, taskId: "missing-task" }), /task_id/)
    await assert.doesNotReject(() => review({ command: "resume-or-skill-command", task_id: "official-host-resume-id" }))
    await assert.doesNotReject(() => review({}))
  })
})

test("lt-pg-legacy: structurally valid old plan without planner binding is permitted (fail-open) [#ac-1.1]", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, { feature_id: FEATURE, dual_status: "both", plan_verdict: "APPROVE" }, GOLDEN_FULL)
    // A plan file written outside the planner-binding flow (e.g. an older run, or hand-edited)
    // no longer fails closed — without a planner_plan_binding there is nothing to validate.
    await assert.doesNotReject(() => runHook(root, "plan-reviewer-family-1"))
  })
})

test("lt-pg-mismatch: bound plan snapshot diverging from disk artifact denies with mismatch reason [#ac-1.2]", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, { feature_id: FEATURE, dual_status: "both", plan_verdict: "APPROVE" }, GOLDEN_FULL)
    const artifact = readPlannerArtifact(root, SESSION, FEATURE)
    const snapshot = writeBoundPlanSnapshot(root, SESSION, artifact)
    const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json")
    fs.writeFileSync(statePath, JSON.stringify(sealGateState({
      feature_id: FEATURE,
      dual_status: "both", plan_verdict: "APPROVE",
      planner_status: "usable",
      planner_plan_binding: {
        // Snapshot integrity (semantic hash/feature) matches the real artifact, so disk
        // reconciliation itself stays "usable" — the forged session_id below is caught by
        // plan-gate's own binding-vs-runtime-session check, not by reconciliation.
        session_id: "ses_foreign_binding",
        feature_id: FEATURE,
        snapshot_path: snapshot.relativePath,
        snapshot_hash: artifact.semanticHash,
        semantic_hash: artifact.semanticHash,
      },
    })))
    await assert.rejects(() => runHook(root, "executor-low"), /does not match/)
  })
})

test("lt-pg-conflict-no-binding: conflicting featureId with no bound plan artifact still permits [#ac-1.3]", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, { feature_id: FEATURE, dual_status: "both", plan_verdict: "APPROVE" })
    const hooks = await createPlanGateHooks(root)
    // Trusted runtime envelope carries a feature_id that conflicts with gate-state's — with
    // no planner_plan_binding to conflict against, the dispatch is not denied for it.
    await assert.doesNotReject(() => hooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION, feature_id: "foreign" },
      { args: {
        description: "dispatch executor",
        prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]\nImplement.`,
        subagent_type: "executor-low",
      } },
    ))
  })
})

test("lt-pg-unreadable: illegible gate-state reconciliation logs and fails open [#ac-1.4]", async () => {
  await withTempRoot(async (root) => {
    const hooks = await createPlanGateHooks(root)
    const originalWarn = console.warn
    const warnings = []
    console.warn = (message) => warnings.push(message)
    try {
      // Unsafe sessionId (space) fails gateStatePath resolution inside
      // reconcilePlannerStateFromDisk -> reconciled.ok === false. test-author is not a
      // dual-enforcement delivery hand, so this exercises the plan-gate fail-open path in
      // isolation from dual-enforcement's own gate-state read.
      await assert.doesNotReject(() => hooks["tool.execute.before"](
        { tool: "task", sessionID: "ses bad id" },
        { args: {
          description: "dispatch test-author",
          prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]\nWrite tests.`,
          subagent_type: "test-author",
        } },
      ))
    } finally {
      console.warn = originalWarn
    }
    assert.ok(
      warnings.some((w) => /planner-state-unreadable/.test(w)),
      `expected a fail-open log, got: ${JSON.stringify(warnings)}`,
    )
  })
})

test("lt-pg-terminal-blocked: planner attempt ended plan_invalid with no binding still denies", async () => {
  await withTempRoot(async (root) => {
    // A real planner attempt that ran and terminated in a non-usable state never produces a
    // planner_plan_binding either — but this is NOT "no ceremony ran" (the #ac-1.1 fail-open
    // case). Mirrors the delivery_status === "delivery-blocked" invariant enforced elsewhere
    // (lib/dispatch-scope.mjs:readCanonicalTaskFromSnapshot).
    seedProject(root, {
      feature_id: FEATURE,
      dual_status: "both", plan_verdict: "APPROVE",
      planner_status: "plan_invalid",
      delivery_status: "delivery-blocked",
      planner_primary_attempts: 3,
    })
    await assert.rejects(() => runHook(root, "executor-low"), /non-usable state/)
  })
})

test("lt-pg-lock-contention: gate-state lock contention denies rather than fail-open", { timeout: 10_000 }, async () => {
  await withTempRoot(async (root) => {
    // A live-pid, fresh lock is never recovered as stale by acquireLock — reconciliation times
    // out (infra fault), which must keep denying rather than being swept into #ac-1.4's
    // fail-open (a squatted lock must never permanently disable plan validation).
    const stateDir = path.join(root, ".opencode", "plans", ".state", SESSION)
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json.lock"),
      JSON.stringify({ token: "squatter", pid: process.pid, createdAt: new Date().toISOString() }),
    )
    await assert.rejects(() => runHook(root, "test-author"), /gate-state contention/)
  })
})

test("lt-pg-ceremony-binding: bound plan cannot progress with foreign ceremony marker", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, { feature_id: FEATURE, dual_status: "both", plan_verdict: "APPROVE" }, GOLDEN_FULL)
    const artifact = readPlannerArtifact(root, SESSION, FEATURE)
    const snapshot = writeBoundPlanSnapshot(root, SESSION, artifact)
    const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json")
    fs.writeFileSync(statePath, JSON.stringify(sealGateState({
      session_id: SESSION,
      feature_id: FEATURE,
      brainstormed: true,
      ceremony_binding: {
        brainstormed: {
          session_id: "ses-foreign",
          feature_id: FEATURE,
          operation: "brainstormed",
          seal: sealedMarkerRecord({ sessionId: SESSION, featureId: FEATURE, operation: "brainstormed", payload: true }).seal,
        },
      },
      dual_status: "both", plan_verdict: "APPROVE",
      planner_status: "usable",
      planner_plan_binding: {
        session_id: SESSION,
        feature_id: FEATURE,
        snapshot_path: snapshot.relativePath,
        snapshot_hash: artifact.semanticHash,
      },
    })))
    await assert.rejects(() => runHook(root, "executor-low"), /ceremony|not bound/)
  })
})
