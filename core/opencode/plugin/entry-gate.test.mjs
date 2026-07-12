/**
 * @description Locked tests for OC entry-gate shell (bash delivery + task ceremony).
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createEntryGateHooks } from "./entry-gate.ts"

const SID = "ses_test1"

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {Record<string, unknown> | null} state - null = missing file
 */
function writeGateState(root, sessionId, state) {
  const dir = path.join(root, ".opencode", "plans", ".state", sessionId)
  fs.mkdirSync(dir, { recursive: true })
  if (state === null) return
  fs.writeFileSync(
    path.join(dir, "gate-state.json"),
    JSON.stringify(state),
    "utf8",
  )
}

/**
 * @param {(hooks: Awaited<ReturnType<typeof createEntryGateHooks>>, root: string) => Promise<void> | void} fn
 */
async function withHooks(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "entry-gate-"))
  try {
    const hooks = await createEntryGateHooks(root)
    await fn(hooks, root)
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

test("bash gh pr create + empty gate-state → throws [entry-gate]", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, {})
    const before = hooks["tool.execute.before"]
    assert.ok(before)
    await assert.rejects(
      () =>
        before(
          { tool: "bash", sessionID: SID },
          { args: { command: "gh pr create --draft" } },
        ),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /\[entry-gate\]/)
        return true
      },
    )
  })
})

test("task executor without ceremony → throws [entry-gate]", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, {})
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () =>
        before(
          { tool: "task", sessionID: SID },
          { args: { subagent_type: "executor-high" } },
        ),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /\[entry-gate\]/)
        return true
      },
    )
  })
})

test("bash ls → does not throw", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, {})
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() =>
      before({ tool: "bash", sessionID: SID }, { args: { command: "ls" } }),
    )
  })
})

test("delivery bash missing sessionID → throws", async () => {
  await withHooks(async (hooks) => {
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () =>
        before(
          { tool: "bash" },
          { args: { command: "gh pr create" } },
        ),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /\[entry-gate\]/)
        return true
      },
    )
  })
})
