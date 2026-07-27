/**
 * @description Locked tests for obs-hand's writing-hand active_dispatch claim (#476).
 * The active-dispatch claim is best-effort observability, not a gate: a missing prompt
 * marker or a rejected claim must never deny dispatch (shadow-record instead), and the
 * terminal evidence writes (hand-record, capture_verified) must still happen unconditionally.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createObsHandHooks } from "./obs-hand.ts"
import { readPlannerArtifact, writeBoundPlanSnapshot } from "./lib/planner-artifact.mjs"

/**
 * @param {(root: string) => void | Promise<void>} fn
 */
async function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-hand-"))
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

/** @param {string} root */
function initGitRepo(root) {
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root })
  fs.writeFileSync(path.join(root, "README.md"), "seed\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: root })
}

/** @param {(message: unknown) => void} fn */
async function captureWarnings(fn) {
  const warnings = []
  const original = console.warn
  console.warn = (message) => warnings.push(message)
  try {
    await fn()
  } finally {
    console.warn = original
  }
  return warnings
}

test("lt-oh-marker-optional: writing-hand dispatch without a prompt marker is not denied [#ac-2.1]", async () => {
  await withTempRoot(async (root) => {
    const hooks = await createObsHandHooks(root)
    const input = { tool: "task", sessionID: "ses_obshand_marker", callID: "call-1" }
    const output = {
      args: {
        prompt: "Fix the reported bug.",
        subagent_type: "sniper-medium",
        feature_id: "feat-obshand",
      },
    }
    const warnings = await captureWarnings(() =>
      assert.doesNotReject(() => hooks["tool.execute.before"](input, output)),
    )
    assert.ok(
      warnings.some((w) => /shadow-record/.test(String(w))),
      `expected a shadow-record log, got: ${JSON.stringify(warnings)}`,
    )
  })
})

test("lt-oh-markerless-arms-rail: markerless dispatch with a fallback taskId still arms active_dispatch [#ac-2.1 scope rail]", async () => {
  await withTempRoot(async (root) => {
    const sessionId = "ses_obshand_rail"
    const featureId = "feat-obshand-rail"
    const taskId = "t0-skeleton"
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId)
    fs.mkdirSync(stateDir, { recursive: true })
    const plan = {
      feature_id: featureId,
      kind: "full",
      mode: "full",
      tasks: [
        {
          id: taskId,
          severity: "medium",
          complexity: "high",
          scope_paths: ["core/opencode/plugin/"],
          criterion_refs: ["#ac-1.5"],
          locked_tests: [{ id: "lt-1", path: "core/opencode/plugin/obs-hand.test.mjs", assertion: "Given plan, When gated, Then ok" }],
        },
      ],
    }
    const planDir = path.join(root, ".opencode", "plans", `${sessionId}-${featureId}`)
    fs.mkdirSync(planDir, { recursive: true })
    fs.writeFileSync(path.join(planDir, "execution-plan.json"), JSON.stringify(plan), "utf8")
    const artifact = readPlannerArtifact(root, sessionId, featureId)
    const snapshot = writeBoundPlanSnapshot(root, sessionId, artifact)
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        session_id: sessionId,
        feature_id: featureId,
        planner_status: "usable",
        planner_plan_binding: {
          session_id: sessionId,
          feature_id: featureId,
          snapshot_path: snapshot.relativePath,
          snapshot_hash: artifact.semanticHash,
          semantic_hash: artifact.semanticHash,
        },
      }),
      "utf8",
    )

    const hooks = await createObsHandHooks(root)
    const input = { tool: "task", sessionID: sessionId, callID: "call-rail" }
    const args = {
      // No [HARNESS_TASK_CONTEXT] marker — #ac-2.1 says this must not be required. The
      // canonical task_id still reaches the claim via extractTaskIds' task_id/taskId/task
      // fallback, so the active-dispatch claim (and the scope rail it arms) still succeeds.
      prompt: "Implement the change.",
      subagent_type: "executor-low",
      feature_id: featureId,
      task_id: taskId,
    }
    await assert.doesNotReject(() => hooks["tool.execute.before"](input, { args }))

    const gateState = JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"))
    assert.equal(gateState.active_dispatch?.task_id, taskId, "active_dispatch must be armed for the markerless dispatch")
    assert.ok(
      Array.isArray(gateState.active_dispatch?.scope_paths) && gateState.active_dispatch.scope_paths.length > 0,
      "active_dispatch must carry the canonical task's scope_paths (plan-write-gate's rail)",
    )
  })
})

test("lt-oh-background-shadow: background dispatch without a claim does not deny on missing child identity [par_atômico]", async () => {
  await withTempRoot(async (root) => {
    const hooks = await createObsHandHooks(root)
    const input = { tool: "task", sessionID: "ses_obshand_bg", callID: "call-bg" }
    const args = {
      prompt: "Fix it in the background.",
      subagent_type: "executor-low",
      feature_id: "feat-obshand-bg",
    }
    // No claim was ever registered for this pair (before-hook never ran for it in this test).
    // A background result with no child identity used to always throw here; without a claim to
    // preserve, denying it would resurrect exactly the deny the before-hook's shadow-record
    // just chose not to raise — the pair must move together (par_atômico).
    const warnings = await captureWarnings(() =>
      assert.doesNotReject(() => hooks["tool.execute.after"](input, {
        args,
        output: `<task state="running"></task>`,
        metadata: { background: true },
      })),
    )
    assert.ok(
      warnings.some((w) => /background dispatch shadow-record/.test(String(w))),
      `expected a background shadow-record log, got: ${JSON.stringify(warnings)}`,
    )
  })
})

test("lt-oh-claim-rejected: rejected active-dispatch claim shadow-records, does not deny, and evidence still writes [#ac-2.2]", async () => {
  await withTempRoot(async (root) => {
    initGitRepo(root)
    const sessionId = "ses_obshand_claim"
    const callId = "call-2"
    const taskId = "t1"
    const featureId = "feat-obshand"
    const hooks = await createObsHandHooks(root)
    const input = { tool: "task", sessionID: sessionId, callID: callId }
    const args = {
      prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]\nDo the work.`,
      subagent_type: "executor-low",
      feature_id: featureId,
    }

    // No gate-state.json seeded for this session -> claimActiveDispatch's own session-identity
    // check ("gate-state session identity mismatch") rejects the claim deterministically.
    const warnings = await captureWarnings(() =>
      assert.doesNotReject(() => hooks["tool.execute.before"](input, { args })),
    )
    assert.ok(
      warnings.some((w) => /shadow-record/.test(String(w)) && /claim rejected/.test(String(w))),
      `expected a claim-rejected shadow-record log, got: ${JSON.stringify(warnings)}`,
    )

    await hooks["tool.execute.after"](input, {
      args,
      output: "Status: DONE\nImplemented the change.",
      metadata: {},
    })

    const recordPath = path.join(
      root,
      ".opencode",
      "plans",
      ".state",
      "hand-records",
      featureId,
      sessionId,
      `${taskId}.json`,
    )
    assert.ok(fs.existsSync(recordPath), "hand-record must be written even though the claim was rejected")
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"))
    assert.equal(record.outcome, "DONE")
    assert.ok(record.capturedVerifiedAt, "capture_verified must still be stamped on the hand-record")

    const gateStatePath = path.join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json")
    const gateState = JSON.parse(fs.readFileSync(gateStatePath, "utf8"))
    assert.ok(
      gateState.capture_verified?.some((entry) => String(entry).includes(taskId)),
      "gate-state capture_verified must include the terminal hand result",
    )
  })
})
