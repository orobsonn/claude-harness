/**
 * @description Locked then-clauses for harvest-guard (#378).
 * #ac-1.1/#ac-1.3: missing findings.md → host throw deny on harvester task.
 * Non-harvester task and present findings → allow.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createHarvestGuardHooks,
  decideHarvestFindings,
  isHarvesterRole,
  isTaskTool,
  resolveProjectRoot,
  bareRole,
} from "./lib/harvest-findings.mjs"

/**
 * @param {(root: string) => void | Promise<void>} fn
 */
async function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-guard-"))
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

test("isTaskTool accepts task variants only", () => {
  assert.equal(isTaskTool("task"), true)
  assert.equal(isTaskTool("Task"), true)
  assert.equal(isTaskTool("harvest"), false)
  assert.equal(isTaskTool("bash"), false)
})

test("isHarvesterRole matches bare harvester only", () => {
  assert.equal(isHarvesterRole("harvester"), true)
  assert.equal(isHarvesterRole("Harvester"), true)
  assert.equal(isHarvesterRole("@harness/harvester"), true)
  assert.equal(isHarvesterRole("harvester.md"), true)
  assert.equal(isHarvesterRole("shipper"), false)
  assert.equal(isHarvesterRole("executor-high"), false)
  assert.equal(bareRole("harness:harvester"), "harvester")
})

test("decideHarvestFindings denies when findings.md missing", async () => {
  await withTempRoot((root) => {
    const d = decideHarvestFindings(root)
    assert.equal(d.decision, "deny")
    assert.equal(d.ok, false)
    assert.match(d.reason, /\[harvest-guard\].*findings\.md missing/)
  })
})

test("decideHarvestFindings denies when findings.md is empty", async () => {
  await withTempRoot((root) => {
    fs.writeFileSync(path.join(root, "findings.md"), "", "utf8")
    const d = decideHarvestFindings(root)
    assert.equal(d.decision, "deny")
    assert.match(d.reason, /empty/)
  })
})

test("decideHarvestFindings denies when findings.md is a directory", async () => {
  await withTempRoot((root) => {
    fs.mkdirSync(path.join(root, "findings.md"))
    const d = decideHarvestFindings(root)
    assert.equal(d.decision, "deny")
    assert.match(d.reason, /directory/)
  })
})

test("decideHarvestFindings allows non-empty regular findings.md", async () => {
  await withTempRoot((root) => {
    fs.writeFileSync(path.join(root, "findings.md"), "# findings\n- ok\n", "utf8")
    const d = decideHarvestFindings(root)
    assert.equal(d.decision, "allow")
    assert.equal(d.ok, true)
  })
})

test("#ac-1.3: harvester task throws when findings.md absent", async () => {
  await withTempRoot(async (root) => {
    const hooks = createHarvestGuardHooks(root)
    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { tool: "task", sessionID: "ses_h1", callID: "c1" },
          { args: { subagent_type: "harvester", prompt: "harvest" } },
        ),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /\[harvest-guard\].*findings\.md missing/)
        return true
      },
    )
  })
})

test("harvester task allows when findings.md present", async () => {
  await withTempRoot(async (root) => {
    fs.writeFileSync(path.join(root, "findings.md"), "## Findings\n- done\n", "utf8")
    const hooks = createHarvestGuardHooks(root)
    await assert.doesNotReject(() =>
      hooks["tool.execute.before"](
        { tool: "task", sessionID: "ses_h2", callID: "c2" },
        { args: { subagent_type: "harvester", prompt: "harvest" } },
      ),
    )
  })
})

test("non-harvester task is not gated by findings.md", async () => {
  await withTempRoot(async (root) => {
    const hooks = createHarvestGuardHooks(root)
    await assert.doesNotReject(() =>
      hooks["tool.execute.before"](
        { tool: "task", sessionID: "ses_h3", callID: "c3" },
        { args: { subagent_type: "shipper", prompt: "ship" } },
      ),
    )
  })
})

test("non-task tools are ignored (dead harvest tool path gone)", async () => {
  await withTempRoot(async (root) => {
    const hooks = createHarvestGuardHooks(root)
    await assert.doesNotReject(() =>
      hooks["tool.execute.before"](
        { tool: "harvest", sessionID: "ses_h4", callID: "c4" },
        { args: {} },
      ),
    )
  })
})

test("resolveProjectRoot prefers directory then worktree", () => {
  assert.equal(resolveProjectRoot("/a", "/b"), "/a")
  assert.equal(resolveProjectRoot("", "/b"), "/b")
  assert.equal(resolveProjectRoot(undefined, "/b"), "/b")
})

test("#ac-1.2: harvester.md plan paths use sessionID-feature_id", () => {
  const md = fs.readFileSync(
    new URL("../agents/harvester.md", import.meta.url),
    "utf8",
  )
  assert.match(md, /\.opencode\/plans\/<sessionID>-<feature_id>\//)
  assert.doesNotMatch(md, /\.opencode\/plans\/<feature_id>\//)
})
