/**
 * @description Locked tests for obs-hand's call-keyed writing-hand record (#476).
 * Observation is fail-open: entry-gate owns scope lifecycle and completion requires its exact
 * producer record. obs-hand never claims, binds, captures, or arms re-gate state.
 */
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { obsHand } from "./obs-hand.ts"

const { createObsHandHooks } = obsHand.testApi
const MODEL_STRATEGY = { hand_tiers: { low: "openai/gpt-5.6-luna", medium: "openai/gpt-5.6-luna", high: "openai/gpt-5.6-terra" }, planner: "openai/planner", "plan-reviewer": "openai/reviewer", compliance: "openai/compliance", adversary: "openai/adversary", security: "openai/security", shipper: "openai/shipper", harvester: "openai/harvester" }
const savedObservabilityRunPath = process.env.HARNESS_OBSERVABILITY_RUN_PATH
const hadObservabilityRunPath = Object.prototype.hasOwnProperty.call(process.env, "HARNESS_OBSERVABILITY_RUN_PATH")
before(() => { delete process.env.HARNESS_OBSERVABILITY_RUN_PATH })
after(() => {
  if (hadObservabilityRunPath) process.env.HARNESS_OBSERVABILITY_RUN_PATH = savedObservabilityRunPath
  else delete process.env.HARNESS_OBSERVABILITY_RUN_PATH
})

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
    await assert.doesNotReject(() => hooks["tool.execute.before"](input, output))
  })
})

test("lt-oh-markerless-observes: markerless dispatch is observed without creating scope authority [#ac-2.1]", async () => {
  await withTempRoot(async (root) => {
    const sessionId = "ses_obshand_rail"
    const featureId = "feat-obshand-rail"
    const taskId = "t0-skeleton"
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId)
    fs.mkdirSync(stateDir, { recursive: true })
    const plan = {
      feature_id: featureId,
      mode: "full",
      model_strategy: MODEL_STRATEGY,
      final_review: { compliance: true, adversary: true },
      demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] },
      tasks: [
        {
          id: taskId,
          title: "Observe hand",
          description: "Observe one hand without claiming scope.",
          depends_on: [],
          severity: "medium",
          complexity: "high",
          scope_paths: ["core/opencode/plugin/"],
          resolved_judgments: { observation: "fail-open" },
          criterion_refs: ["#ac-1.5"],
          locked_tests: [{ id: "lt-1", path: "core/opencode/plugin/obs-hand.test.mjs", assertion: "Given plan, When gated, Then ok" }],
          adversarial: { enabled: false, focus: [] },
        },
      ],
    }
    const planDir = path.join(root, ".opencode", "plans", featureId)
    fs.mkdirSync(planDir, { recursive: true })
    fs.writeFileSync(path.join(planDir, "execution-plan.json"), JSON.stringify(plan), "utf8")
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        session_id: sessionId,
        feature_id: featureId,
        mode: "FULL",
        classified: true,
      }),
      "utf8",
    )

    const hooks = await createObsHandHooks(root)
    const input = { tool: "task", sessionID: sessionId, callID: "call-rail" }
    const args = {
    // No [HARNESS_TASK_CONTEXT] marker — observation may still emit, but cannot claim scope.
      prompt: "Implement the change.",
      subagent_type: "executor-low",
      feature_id: featureId,
      task_id: taskId,
    }
    await assert.doesNotReject(() => hooks["tool.execute.before"](input, { args }))

    const gateState = JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"))
    assert.equal(gateState.dispatch_records, undefined, "obs-hand must not create dispatch authority")
  })
})

test("lt-oh-background-observation: running background result stays fail-open [par_atômico]", async () => {
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
    await assert.doesNotReject(() => hooks["tool.execute.after"](input, {
        args,
        output: `<task state="running"></task>`,
        metadata: { background: true },
      }))
  })
})

test("lt-oh-unproven-completion: absent producer record leaves capture and completion absent [#ac-2.2]", async () => {
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

    await assert.doesNotReject(() => hooks["tool.execute.before"](input, { args }))

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
    assert.equal(fs.existsSync(recordPath), false, "unproven completion must not create a host record")
  })
})
