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

const SESSION = "ses_planGateTest01"
const FEATURE = "feat-plan-gate"

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
      locked_tests: [{ id: "lt-1", path: "core/opencode/plugin/plan-gate.test.mjs" }],
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
    JSON.stringify(gateState),
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
  return hooks["tool.execute.before"](
    { tool: "task", sessionID: SESSION },
    { args: { subagent_type: subagentType } },
  )
}

test("lt-pg-missing: executor + missing plan throws [plan-gate]", async () => {
  await withTempRoot(async (root) => {
    seedProject(root, {
      feature_id: FEATURE,
      dual_status: "both",
    })
    await assert.rejects(
      () => runHook(root, "executor-high"),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /\[plan-gate\]/)
        assert.match(err.message, /plan missing|full plan required/i)
        return true
      },
    )
  })
})

test("lt-pg-stub: sniper + stub plan throws [plan-gate]", async () => {
  await withTempRoot(async (root) => {
    seedProject(
      root,
      { feature_id: FEATURE, dual_status: "both" },
      { kind: "stub", mode: "LIGHT", feature_id: FEATURE, tasks: [] },
    )
    await assert.rejects(
      () => runHook(root, "sniper-medium"),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /\[plan-gate\]/)
        assert.match(err.message, /stub|empty tasks|expect full/i)
        return true
      },
    )
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
      { feature_id: FEATURE, dual_status: "both" },
      GOLDEN_FULL,
    )
    await assert.doesNotReject(() => runHook(root, "executor-low"))
  })
})
