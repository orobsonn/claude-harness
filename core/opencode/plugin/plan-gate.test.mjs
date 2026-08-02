/**
 * @description Locked tests for plan-gate wire (plan-gate-wire).
 * executor/sniper require full plan at planDir; Explore skips plan require.
 */
import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { planGateTestApi } from "./plan-gate.ts"

const { createPlanGateHooks } = planGateTestApi
import { readPlannerArtifact, writeBoundPlanSnapshot } from "../lib/planner-artifact.mjs"

const SESSION = "ses_planGateTest01"
const FEATURE = "feat-plan-gate"

function sealGateState(gateState) {
  return { session_id: SESSION, ...gateState }
}

const GOLDEN_FULL = {
  feature_id: FEATURE,
  kind: "full",
  mode: "full",
  model_strategy: {
    hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
    planner: "openai/gpt-5.6-sol", "plan-reviewer": "openai/gpt-5.6-sol", compliance: "openai/gpt-5.6-terra",
    adversary: "openai/gpt-5.6-sol", security: "openai/gpt-5.6-sol", shipper: "openai/gpt-5.6-luna", harvester: "openai/gpt-5.6-luna",
  },
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
 * @returns {{ statePath: string, stateBytes: Buffer }}
 */
function seedUsableBoundProject(root) {
  seedProject(root, { feature_id: FEATURE }, GOLDEN_FULL)
  const artifact = readPlannerArtifact(root, SESSION, FEATURE)
  const snapshot = writeBoundPlanSnapshot(root, SESSION, artifact)
  assert.equal(snapshot.ok, true)
  const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json")
  fs.writeFileSync(statePath, JSON.stringify(sealGateState({
    feature_id: FEATURE,
    planner_status: "usable",
    planner_plan_binding: {
      session_id: SESSION,
      feature_id: FEATURE,
      semantic_hash: artifact.semanticHash,
      file_hash: artifact.fileHash,
      fingerprint: artifact.fingerprint,
      snapshot_path: snapshot.relativePath,
      snapshot_hash: artifact.semanticHash,
      snapshot_file_hash: snapshot.snapshot.fileHash,
    },
  })), "utf8")
  return { statePath, stateBytes: fs.readFileSync(statePath) }
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
    })
    // Operator/fix-mode case: no planner attempt ran for this session — no
    // planner_status/planner_plan_binding on gate-state. Absent binding -> skip fail-open.
    await assert.doesNotReject(() => runHook(root, "executor-high"))
  })
})

test("lt-pg-stub-no-binding: sniper + stub plan file with no binding is still permitted [#ac-1.1]", async () => {
  await withTempRoot(async (root) => {
    seedProject(
      root,
      { feature_id: FEATURE },
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
    })
    await assert.doesNotReject(() => runHook(root, "Explore"))
  })
})

test("lt-pg-valid: executor + valid full plan does not plan-gate deny", async () => {
  await withTempRoot(async (root) => {
    seedProject(
      root,
      { feature_id: FEATURE },
      GOLDEN_FULL,
    )
    const artifact = readPlannerArtifact(root, SESSION, FEATURE)
    const snapshot = writeBoundPlanSnapshot(root, SESSION, artifact)
    assert.equal(snapshot.ok, true)
    const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json")
    fs.writeFileSync(statePath, JSON.stringify(sealGateState({
      feature_id: FEATURE,
      planner_status: "usable",
      planner_plan_binding: {
        session_id: SESSION,
        feature_id: FEATURE,
        semantic_hash: artifact.semanticHash,
        file_hash: artifact.fileHash,
        fingerprint: artifact.fingerprint,
        snapshot_path: snapshot.relativePath,
        snapshot_hash: artifact.semanticHash,
        snapshot_file_hash: snapshot.snapshot.fileHash,
      },
    })))
    await assert.doesNotReject(() => runHook(root, "executor-low"))
  })
})

test("lt-pg-dispatch-identity: official Task shape derives feature from session and task from strict prompt marker", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, { feature_id: FEATURE }, GOLDEN_FULL)
    const artifact = readPlannerArtifact(root, SESSION, FEATURE)
    const snapshot = writeBoundPlanSnapshot(root, SESSION, artifact)
    const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json")
    fs.writeFileSync(statePath, JSON.stringify(sealGateState({
      feature_id: FEATURE,
      planner_status: "usable",
      planner_plan_binding: {
        session_id: SESSION,
        feature_id: FEATURE,
        semantic_hash: artifact.semanticHash,
        file_hash: artifact.fileHash,
        fingerprint: artifact.fingerprint,
        snapshot_path: snapshot.relativePath,
        snapshot_hash: artifact.semanticHash,
        snapshot_file_hash: snapshot.snapshot.fileHash,
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
    // Harness-only taskId alias still fails closed when it disagrees with the prompt's
    // HARNESS_TASK_CONTEXT marker (#484 adversary finding) — tolerance does not extend to
    // decoupling dispatch args from the brief the hand was actually given.
    await assert.rejects(() => dispatch(valid, { taskId: "missing-task" }), /taskId dispatch args diverge from the brief/)
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
    seedProject(root, { feature_id: FEATURE }, GOLDEN_FULL)
    // A plan file written outside the planner-binding flow (e.g. an older run, or hand-edited)
    // no longer fails closed — without a planner_plan_binding there is nothing to validate.
    await assert.doesNotReject(() => runHook(root, "plan-reviewer-family-1"))
  })
})

test("bound-plan prompt injection is idempotent across duplicate hook instances and rejects conflicts", async () => {
  await withTempRoot(async (root) => {
    seedUsableBoundProject(root)
    const firstHooks = await createPlanGateHooks(root)
    const secondHooks = await createPlanGateHooks(root)
    const input = { tool: "task", sessionID: SESSION }
    const output = {
      args: {
        description: "review",
        prompt: "Review the bound plan.",
        subagent_type: "plan-reviewer",
      },
    }

    await firstHooks["tool.execute.before"](input, output)
    const once = output.args.prompt
    assert.equal(once.split("[HARNESS_BOUND_PLAN sha256=").length - 1, 1)
    assert.equal(once.split("[/HARNESS_BOUND_PLAN]").length - 1, 1)

    await firstHooks["tool.execute.before"](input, output)
    assert.equal(output.args.prompt, once, "same hook instance duplicated the bound plan")
    await secondHooks["tool.execute.before"](input, output)
    assert.equal(output.args.prompt, once, "second hook instance duplicated the bound plan")

    const conflicting = {
      args: {
        description: "review",
        prompt: "Review.\n\n[HARNESS_BOUND_PLAN sha256=deadbeef]\n{}\n[/HARNESS_BOUND_PLAN]",
        subagent_type: "plan-reviewer",
      },
    }
    await assert.rejects(
      () => firstHooks["tool.execute.before"](input, conflicting),
      /conflicting bound-plan prompt marker/,
    )
  })
})

test("lt-pg-mismatch: bound plan snapshot diverging from disk artifact denies with mismatch reason [#ac-1.2]", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, { feature_id: FEATURE }, GOLDEN_FULL)
    const artifact = readPlannerArtifact(root, SESSION, FEATURE)
    const snapshot = writeBoundPlanSnapshot(root, SESSION, artifact)
    const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json")
    fs.writeFileSync(statePath, JSON.stringify(sealGateState({
      feature_id: FEATURE,
      planner_status: "usable",
      planner_plan_binding: {
        // Snapshot integrity (semantic hash/feature) matches the real artifact, so disk
        // reconciliation itself stays "usable" — the forged session_id below is caught by
        // plan-gate's own binding-vs-runtime-session check, not by reconciliation.
        session_id: "ses_foreign_binding",
        feature_id: FEATURE,
        snapshot_path: snapshot.relativePath,
        snapshot_hash: artifact.semanticHash,
        snapshot_file_hash: snapshot.snapshot.fileHash,
        semantic_hash: artifact.semanticHash,
        file_hash: artifact.fileHash,
        fingerprint: artifact.fingerprint,
      },
    })))
    await assert.rejects(() => runHook(root, "executor-low"), /does not match/)
  })
})

test("lt-pg-conflict-no-binding: conflicting featureId with no bound plan artifact still permits [#ac-1.3]", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, { feature_id: FEATURE })
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

test("lt-pg-invalid-object: present non-object gate-state denies every downstream role", async () => {
  for (const role of ["plan-reviewer-family-1", "test-author", "executor-low", "sniper-low"]) {
    await withTempRoot(async (root) => {
      const stateDir = path.join(root, ".opencode", "plans", ".state", SESSION)
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(path.join(stateDir, "gate-state.json"), "[]", "utf8")
      await assert.rejects(() => runHook(root, role), /gate-state-invalid-object/, role)
    })
  }
})

test("lt-pg-invalid-session: structural gate-state path failures deny downstream roles", async () => {
  await withTempRoot(async (root) => {
    const hooks = await createPlanGateHooks(root)
    await assert.rejects(() => hooks["tool.execute.before"](
      { tool: "task", sessionID: "ses bad id" },
      { args: {
        description: "dispatch test-author",
        prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]\nWrite tests.`,
        subagent_type: "test-author",
      } },
    ), /invalid sessionId/)
  })
})

test("lt-pg-unreadable: illegible gate-state reconciliation logs and fails open [#ac-1.4]", async () => {
  await withTempRoot(async (root) => {
    const stateDir = path.join(root, ".opencode", "plans", ".state", SESSION)
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), "{", "utf8")
    const originalWarn = console.warn
    const warnings = []
    console.warn = (message) => warnings.push(message)
    try {
      await assert.doesNotReject(() => runHook(root, "test-author"))
    } finally {
      console.warn = originalWarn
    }
    assert.ok(
      warnings.some((w) => /planner-state-unreadable.*gate-state-unreadable/.test(w)),
      `expected a fail-open log, got: ${JSON.stringify(warnings)}`,
    )
  })
})

test("lt-pg-terminal-blocked: planner attempt ended plan_invalid with no binding still denies", async () => {
  await withTempRoot(async (root) => {
    // A real planner attempt that ran and terminated in a non-usable state never produces a
    // planner_plan_binding either — but this is not "no planner attempt ran" (the #ac-1.1 fail-open
    // case). A terminal planner state must still reject a downstream writing dispatch.
    // (lib/dispatch-scope.mjs:readCanonicalTaskFromSnapshot).
    seedProject(root, {
      feature_id: FEATURE,
      planner_status: "plan_invalid",
    })
    await assert.rejects(() => runHook(root, "executor-low"), /no usable binding/)
  })
})

test("planner lifecycle states without a binding deny every downstream writing role", async () => {
  for (const planner_status of ["running", "plan_pending_write", "usable"]) {
    await withTempRoot(async (root) => {
      seedProject(root, { feature_id: FEATURE, planner_status })
      await assert.rejects(() => runHook(root, "executor-low"), /no usable binding/, planner_status)
    })
  }
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

test("lt-pg-r10-not-owned: bound plan validation does not require ceremony facts", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, { feature_id: FEATURE }, GOLDEN_FULL)
    const artifact = readPlannerArtifact(root, SESSION, FEATURE)
    const snapshot = writeBoundPlanSnapshot(root, SESSION, artifact)
    const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json")
    fs.writeFileSync(statePath, JSON.stringify(sealGateState({
      session_id: SESSION,
      feature_id: FEATURE,
      planner_status: "usable",
      planner_plan_binding: {
        session_id: SESSION,
        feature_id: FEATURE,
        semantic_hash: artifact.semanticHash,
        file_hash: artifact.fileHash,
        fingerprint: artifact.fingerprint,
        snapshot_path: snapshot.relativePath,
        snapshot_hash: artifact.semanticHash,
        snapshot_file_hash: snapshot.snapshot.fileHash,
      },
    })))
    await assert.doesNotReject(() => runHook(root, "executor-low"))
  })
})

test("validator internals warn-open only after an intact bound snapshot, while invalid content and hashes deny", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, { feature_id: FEATURE }, GOLDEN_FULL)
    const artifact = readPlannerArtifact(root, SESSION, FEATURE)
    const snapshot = writeBoundPlanSnapshot(root, SESSION, artifact)
    const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json")
    const intactState = sealGateState({
      feature_id: FEATURE,
      planner_status: "usable",
      planner_plan_binding: {
        session_id: SESSION,
        feature_id: FEATURE,
        semantic_hash: artifact.semanticHash,
        file_hash: artifact.fileHash,
        fingerprint: artifact.fingerprint,
        snapshot_path: snapshot.relativePath,
        snapshot_hash: artifact.semanticHash,
        snapshot_file_hash: snapshot.snapshot.fileHash,
      },
    })
    fs.writeFileSync(statePath, JSON.stringify(intactState), "utf8")
    const stateBytesBeforeValidatorWarning = fs.readFileSync(statePath)

    const warnings = []
    const originalWarn = console.warn
    console.warn = (message) => warnings.push(message)
    try {
      const hooks = await createPlanGateHooks(root, {
        validatePlanFn: () => { throw new Error("validator seam") },
      })
      await assert.doesNotReject(() => hooks["tool.execute.before"](
        { tool: "task", sessionID: SESSION },
        { args: { subagent_type: "executor-low", prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]' } },
      ))
    } finally {
      console.warn = originalWarn
    }
    assert.ok(warnings.some((warning) => /validator failed internally/.test(warning)))
    assert.deepEqual(fs.readFileSync(statePath), stateBytesBeforeValidatorWarning)

    const malformedValidatorWarnings = []
    console.warn = (message) => malformedValidatorWarnings.push(message)
    try {
      const malformedHooks = await createPlanGateHooks(root, { validatePlanFn: () => null })
      await assert.doesNotReject(() => malformedHooks["tool.execute.before"](
        { tool: "task", sessionID: SESSION },
        { args: { subagent_type: "executor-low", prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]' } },
      ))
    } finally {
      console.warn = originalWarn
    }
    assert.ok(malformedValidatorWarnings.some((warning) => /validator failed internally/.test(warning)))
    assert.deepEqual(fs.readFileSync(statePath), stateBytesBeforeValidatorWarning)

    const invalidPlan = { ...GOLDEN_FULL, model_strategy: { ...GOLDEN_FULL.model_strategy, hand_tiers: { low: "gemma4" } } }
    seedProject(root, { feature_id: FEATURE }, invalidPlan)
    const invalidArtifact = readPlannerArtifact(root, SESSION, FEATURE)
    const invalidSnapshotBytes = fs.readFileSync(path.join(root, ".opencode", "plans", `${SESSION}-${FEATURE}`, "execution-plan.json"))
    const invalidSnapshotHash = crypto.createHash("sha256").update(invalidSnapshotBytes).digest("hex")
    const invalidSnapshotPath = path.join(root, ".opencode", "plans", ".state", SESSION, "bound-plans", `${invalidSnapshotHash}.json`)
    fs.mkdirSync(path.dirname(invalidSnapshotPath), { recursive: true })
    fs.writeFileSync(invalidSnapshotPath, invalidSnapshotBytes)
    fs.writeFileSync(statePath, JSON.stringify(sealGateState({
      feature_id: FEATURE,
      planner_status: "usable",
      planner_plan_binding: {
        session_id: SESSION,
        feature_id: FEATURE,
        semantic_hash: invalidArtifact.semanticHash,
        file_hash: invalidArtifact.fileHash,
        fingerprint: invalidArtifact.fingerprint,
        snapshot_path: path.relative(root, invalidSnapshotPath),
        snapshot_hash: invalidArtifact.semanticHash,
        snapshot_file_hash: invalidSnapshotHash,
      },
    })))
    const normalHooks = await createPlanGateHooks(root)
    await assert.rejects(() => normalHooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION },
      { args: { subagent_type: "executor-low", prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]' } },
    ))

    fs.writeFileSync(statePath, JSON.stringify({
      ...intactState,
      planner_plan_binding: { ...intactState.planner_plan_binding, snapshot_file_hash: "f".repeat(64) },
    }))
    const failingHooks = await createPlanGateHooks(root, { validatePlanFn: () => { throw new Error("validator seam") } })
    await assert.rejects(() => failingHooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION },
      { args: { subagent_type: "executor-low", prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]' } },
    ))
  })
})

test("snapshot validator failure stays warn-open when a contradictory third validation would deny", async () => {
  await withTempRoot(async (root) => {
    const { statePath, stateBytes } = seedUsableBoundProject(root)
    let validationCalls = 0
    const validatePlanFn = () => {
      validationCalls += 1
      if (validationCalls === 1) throw new Error("snapshot validator seam")
      if (validationCalls === 2) return { ok: true, errors: [] }
      return { ok: false, errors: ["contradictory late invalid result"] }
    }
    const warnings = []
    const originalWarn = console.warn
    console.warn = (message) => warnings.push(message)
    try {
      const hooks = await createPlanGateHooks(root, { validatePlanFn })
      await assert.doesNotReject(() => hooks["tool.execute.before"](
        { tool: "task", sessionID: SESSION },
        { args: { subagent_type: "executor-low", prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]' } },
      ))
    } finally {
      console.warn = originalWarn
    }
    assert.equal(validationCalls, 2, "the gate must not revalidate after reconciliation reports an internal failure")
    assert.ok(warnings.some((warning) => /validator failed internally/.test(warning)))
    assert.deepEqual(fs.readFileSync(statePath), stateBytes)
  })
})

test("snapshot validator failure emits a warning even when a contradictory third validation would allow", async () => {
  await withTempRoot(async (root) => {
    const { statePath, stateBytes } = seedUsableBoundProject(root)
    let validationCalls = 0
    const validatePlanFn = () => {
      validationCalls += 1
      if (validationCalls === 1) throw new Error("snapshot validator seam")
      return { ok: true, errors: [] }
    }
    const warnings = []
    const originalWarn = console.warn
    console.warn = (message) => warnings.push(message)
    try {
      const hooks = await createPlanGateHooks(root, { validatePlanFn })
      await assert.doesNotReject(() => hooks["tool.execute.before"](
        { tool: "task", sessionID: SESSION },
        { args: { subagent_type: "executor-low", prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t0-skeleton"}[/HARNESS_TASK_CONTEXT]' } },
      ))
    } finally {
      console.warn = originalWarn
    }
    assert.equal(validationCalls, 2, "the gate must honor the reconciler's validator result")
    assert.ok(warnings.some((warning) => /validator failed internally/.test(warning)))
    assert.deepEqual(fs.readFileSync(statePath), stateBytes)
  })
})
