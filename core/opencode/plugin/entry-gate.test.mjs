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
 * @param {import("./entry-gate.ts").EntryGateDeps} [deps]
 */
async function withHooks(fn, deps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "entry-gate-"))
  try {
    const hooks = await createEntryGateHooks(root, deps)
    await fn(hooks, root)
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/** @returns {Record<string, unknown>} */
function fullCeremony(extra = {}) {
  return {
    mode: "FULL",
    classified: true,
    brainstormed: true,
    adversary_fired: true,
    dual_status: "both",
    feature_id: "feat",
    regate_pending: [],
    regate_passed: [],
    hand_finished: [],
    capture_verified: [],
    ...extra,
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

test("bash ls non-delivery → git/list never invoked, no throw", async () => {
  let gitCalls = 0
  let listCalls = 0
  let ancestorCalls = 0
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, {})
      const before = hooks["tool.execute.before"]
      await assert.doesNotReject(() =>
        before({ tool: "bash", sessionID: SID }, { args: { command: "ls" } }),
      )
      assert.equal(gitCalls, 0, "gitStateFn must not run for non-delivery")
      assert.equal(listCalls, 0, "listFn must not run for non-delivery")
      assert.equal(ancestorCalls, 0, "isAncestorFn must not run for non-delivery")
    },
    {
      gitStateFn: () => {
        gitCalls += 1
        return { branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }
      },
      listHandRecordsForFeatureFn: () => {
        listCalls += 1
        return []
      },
      isAncestorFn: () => {
        ancestorCalls += 1
        return true
      },
    },
  )
})

test("bash git push empty ceremony → throws [entry-gate] deny", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, {})
      const before = hooks["tool.execute.before"]
      await assert.rejects(
        () =>
          before(
            { tool: "bash", sessionID: SID },
            { args: { command: "git push" } },
          ),
        (err) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /\[entry-gate\]/)
          return true
        },
      )
    },
    {
      gitStateFn: () => ({
        branch: "feat/x",
        commitsAhead: 1,
        defaultBranch: "main",
      }),
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
    },
  )
})

test("bash git push FULL dual + clear rails + gitState fixture → no throw", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, fullCeremony())
      const before = hooks["tool.execute.before"]
      await assert.doesNotReject(() =>
        before(
          { tool: "bash", sessionID: SID },
          { args: { command: "git push" } },
        ),
      )
    },
    {
      gitStateFn: () => ({
        branch: "feat/x",
        commitsAhead: 1,
        defaultBranch: "main",
      }),
      // LIGHT|FULL require current-session DONE+stamp (no vacuous empty list)
      listHandRecordsForFeatureFn: () => [
        {
          taskId: "task-1",
          sessionId: SID,
          record: {
            outcome: "DONE",
            freezeCommitSha: "abc123def456",
            capturedVerifiedAt: "2026-07-12T00:00:00.000Z",
            scopeViolations: [],
            frozenViolations: [],
          },
        },
      ],
      isAncestorFn: () => true,
    },
  )
})

test("bash git push FULL dual + DONE hand-record capturedVerifiedAt + freeze ancestor → no throw", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, fullCeremony())
      const before = hooks["tool.execute.before"]
      await assert.doesNotReject(() =>
        before(
          { tool: "bash", sessionID: SID },
          { args: { command: "git push" } },
        ),
      )
    },
    {
      gitStateFn: () => ({
        branch: "feat/x",
        commitsAhead: 1,
        defaultBranch: "main",
      }),
      listHandRecordsForFeatureFn: (featureId) => {
        assert.equal(featureId, "feat")
        return [
          {
            taskId: "task-1",
            sessionId: SID,
            record: {
              outcome: "DONE",
              freezeCommitSha: "abc123def456",
              capturedVerifiedAt: "2026-07-12T00:00:00.000Z",
              scopeViolations: [],
              frozenViolations: [],
            },
          },
        ]
      },
      isAncestorFn: (sha) => {
        assert.equal(sha, "abc123def456")
        return true
      },
    },
  )
})
