/**
 * @description Locked tests for OC entry-gate shell (bash delivery + task facts).
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { EntryGate } from "./entry-gate.ts"
import { obsHand } from "./obs-hand.ts"

const { createEntryGateHooks } = EntryGate.testApi
const { createObsHandHooks } = obsHand.testApi
import { semanticPlanHash } from "../lib/planner-artifact.mjs"

const SID = "ses_test1"

test("entry and plan gates have no ceremony sidecar or recovery dependency", () => {
  for (const relativePath of ["entry-gate.ts", "plan-gate.ts"]) {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8")
    assert.doesNotMatch(
      source,
      /ceremony-binding|ceremony-transition|recoverCeremony|validateCeremonyBinding/,
      relativePath,
    )
  }
})

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
function fullDeliveryState(extra = {}, sessionId = SID) {
  return {
    session_id: sessionId,
    mode: "FULL",
    classified: true,
    brainstormed: true,
    adversary_fired: true,
    feature_id: "feat",
    // Exact writing-hand scope is bound only to a usable planner artifact.
    planner_status: "usable",
    regate_pending: [],
    regate_passed: [],
    hand_finished: [],
    capture_verified: [],
    ...extra,
  }
}

/** @description Install the immutable snapshot required for an exact writing-hand claim. */
function writeScopeReadyState(root, sessionId = SID, taskId = "task-scope") {
  const featureId = "feat"
  const plan = {
    feature_id: featureId,
    kind: "full",
    mode: "full",
    model_strategy: {
      hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
      planner: "openai/gpt-5.6-sol", "plan-reviewer": "openai/gpt-5.6-sol", compliance: "openai/gpt-5.6-terra",
      adversary: "openai/gpt-5.6-sol", security: "openai/gpt-5.6-sol", shipper: "openai/gpt-5.6-luna", harvester: "openai/gpt-5.6-luna",
    },
    tasks: [{ id: taskId, severity: "low", complexity: "low", scope_paths: ["src"], allowed_writes: [], criterion_refs: ["#ac-1"], locked_tests: [{ id: "lt-1", path: "tests/a.test.mjs", assertion: "a" }] }],
  }
  const content = JSON.stringify(plan)
  const fileHash = crypto.createHash("sha256").update(content).digest("hex")
  const snapshotPath = path.join(root, ".opencode", "plans", ".state", sessionId, "bound-plans", `${fileHash}.json`)
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.writeFileSync(snapshotPath, content)
  const snapshotRel = `.opencode/plans/.state/${sessionId}/bound-plans/${fileHash}.json`
  writeGateState(root, sessionId, fullDeliveryState({
    fidelity_pass: [`${featureId}/${taskId}`],
    planner_plan_binding: {
      session_id: sessionId,
      feature_id: featureId,
      snapshot_path: snapshotRel,
      snapshot_hash: semanticPlanHash(plan),
      snapshot_file_hash: fileHash,
    },
  }, sessionId))
}

function exactDispatchPath(root, sessionId, callId) {
  return path.join(root, ".opencode", "plans", ".state", sessionId, "dispatch-records", `${crypto.createHash("sha256").update(callId).digest("hex")}.json`)
}

function writingTaskArgs(taskId = "task-scope") {
  return { subagent_type: "executor-low", taskId, feature_id: "feat", prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]` }
}

test("#ac-1.1: bash gh pr create + empty gate-state on a feature branch with commits → PERMITIDO (fail-open; was denied by 'delivery requires readable gate-state')", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, {})
      const before = hooks["tool.execute.before"]
      assert.ok(before)
      await assert.doesNotReject(() =>
        before(
          { tool: "bash", sessionID: SID },
          { args: { command: "gh pr create --draft" } },
        ),
      )
    },
    {
      gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
    },
  )
})

test("gh pr merge is denied when the injected GitHub rollup is not provably green", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, fullDeliveryState())
      const before = hooks["tool.execute.before"]
      await assert.rejects(
        () => before({ tool: "bash", sessionID: SID }, { args: { command: "gh pr merge 42 --squash" } }),
        /CI is still running; merge is denied/,
      )
    },
    {
      gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
      readMergeCheckRollupFn: () => [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }],
    },
  )
})

test("gh pr merge reads the exact literal target and allows a green rollup", async () => {
  let target = undefined
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, fullDeliveryState())
      const before = hooks["tool.execute.before"]
      await assert.doesNotReject(() =>
        before({ tool: "bash", sessionID: SID }, { args: { command: "gh pr merge 42 --squash" } }),
      )
    },
    {
      gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
      readMergeCheckRollupFn: (value) => {
        target = value
        return [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }]
      },
    },
  )
  assert.equal(target, "42")
})

test("a current lifecycle-only PR may merge when its repository has no CI", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, fullDeliveryState())
      await assert.doesNotReject(() =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: SID },
          { args: { command: "gh pr merge --squash --delete-branch" } },
        ),
      )
    },
    {
      gitStateFn: () => ({ branch: "chore/harness-lifecycle-updating-harness-1", commitsAhead: 1, defaultBranch: "main" }),
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
      readMergeCheckRollupFn: () => [],
      isLifecycleOnlyMergeFn: () => true,
    },
  )
})

test("the lifecycle no-CI exception never authorizes an explicit PR target", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, fullDeliveryState())
      await assert.rejects(
        () => hooks["tool.execute.before"](
          { tool: "bash", sessionID: SID },
          { args: { command: "gh pr merge 42 --squash" } },
        ),
        /No CI checks are reported; merge is denied/,
      )
    },
    {
      gitStateFn: () => ({ branch: "chore/harness-lifecycle-updating-harness-1", commitsAhead: 1, defaultBranch: "main" }),
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
      readMergeCheckRollupFn: () => [],
      isLifecycleOnlyMergeFn: () => true,
    },
  )
})

test("gh pr merge rejects a chained second merge before reading any PR", async () => {
  let reads = 0
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, fullDeliveryState())
      await assert.rejects(
        () => hooks["tool.execute.before"](
          { tool: "bash", sessionID: SID },
          { args: { command: "gh pr merge 42 --squash && gh pr merge 43 --squash" } },
        ),
        /PR target is ambiguous/,
      )
    },
    {
      gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
      readMergeCheckRollupFn: () => {
        reads += 1
        return [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }]
      },
    },
  )
  assert.equal(reads, 0)
})

test("task executor without required delivery facts → throws [entry-gate]", async () => {
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

test("shipper Task resolves re-gate SHA ancestry through the entry hook", async () => {
  const state = fullDeliveryState({
    regate_pending: ["feat/task-1"],
    regate_passed: ["feat/task-1@review-sha"],
  })

  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, state)
    await assert.rejects(
      () => hooks["tool.execute.before"](
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "shipper" } },
      ),
      /strong-eye re-gate/,
    )
  }, { isAncestorFn: () => false })

  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, state)
    await assert.doesNotReject(() => hooks["tool.execute.before"](
      { tool: "task", sessionID: SID },
      { args: { subagent_type: "shipper" } },
    ))
  }, { isAncestorFn: () => true })

  for (const unavailableLookup of [() => null, () => { throw new Error("git unavailable") }]) {
    await withHooks(async (hooks, root) => {
      writeGateState(root, SID, state)
      await assert.rejects(
        () => hooks["tool.execute.before"](
          { tool: "task", sessionID: SID },
          { args: { subagent_type: "shipper" } },
        ),
        /strong-eye re-gate/,
      )
    }, { isAncestorFn: unavailableLookup })
  }
})

test("planner accepts plain persisted boolean facts without sidecars or provenance proof", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, {
      session_id: SID,
      feature_id: "feat",
      mode: "FULL",
      classified: true,
      brainstormed: true,
      adversary_fired: true,
    })
    await assert.doesNotReject(
      () => hooks["tool.execute.before"](
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "planner" } },
      ),
    )
  })
})

test("dispatch args diverging from the brief's HARNESS_TASK_CONTEXT still fail closed (#484 adversary finding)", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullDeliveryState({ fidelity_pass: ["feat/trusted-task", "feat/task-b"] }))
    const before = hooks["tool.execute.before"]
    // The brief (prompt marker) says task-a; dispatch args claim task-b. Tolerating alias
    // disagreement (#484) must NOT extend to laundering which task the fidelity/scope gates
    // validate against — this decouples "what the hand was told" from "what gets gated",
    // defeating the frozen-test fidelity guarantee. Must reject.
    await assert.rejects(
      () => before(
        { tool: "task", sessionID: SID },
        { args: {
          subagent_type: "executor-low",
          task: "task-a",
          taskId: "task-b",
          prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"task-a"}[/HARNESS_TASK_CONTEXT]',
        } },
      ),
      /taskId dispatch args diverge from the brief/,
    )
  })
})

test("task/taskId aliases without a brief marker resolve tolerantly to the first alias in priority order (#484)", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullDeliveryState({ fidelity_pass: ["feat/task-b"] }))
    const before = hooks["tool.execute.before"]
    // No prompt marker to cross-check against — nothing but the dispatch args themselves
    // disagree, so this stays tolerant: the first alias in priority order (taskId) wins.
    await assert.doesNotReject(
      () => before(
        { tool: "task", sessionID: SID },
        { args: {
          subagent_type: "executor-low",
          task: "task-a",
          taskId: "task-b",
          prompt: "Implement the task.",
        } },
      ),
    )
  })
})

test("official resume fields (command/task_id) do not fight HARNESS_TASK_CONTEXT or the trusted envelope", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullDeliveryState({ fidelity_pass: ["feat/trusted-task"] }))
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() => before(
      { tool: "task", sessionID: SID, task_id: "trusted-task" },
      { args: {
        subagent_type: "executor-low",
        command: "resume-or-skill-command",
        task_id: "official-host-resume-id",
        prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"model-task"}[/HARNESS_TASK_CONTEXT]',
      } },
    ))
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

test("canonical plan Bash ownership is not duplicated in entry-gate", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullDeliveryState())
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() => before(
      { tool: "bash", sessionID: SID },
      { args: { command: "cat > .opencode/plans/ses-feat/execution-plan.json <<'EOF'\n{}\nEOF" } },
    ))
    await assert.doesNotReject(() => before(
      { tool: "bash", sessionID: SID },
      { args: { command: "cat .opencode/plans/ses-feat/execution-plan.json" } },
    ))
  })
})

test("#ac-1.5: delivery bash missing sessionID → PERMITIDO (fail-open, infra error)", async () => {
  await withHooks(
    async (hooks) => {
      const before = hooks["tool.execute.before"]
      await assert.doesNotReject(() =>
        before(
          { tool: "bash" },
          { args: { command: "gh pr create" } },
        ),
      )
    },
    { gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }) },
  )
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

test("#ac-1.1: bash git push empty delivery state on a feature branch with commits → PERMITIDO (fail-open)", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, {})
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
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
    },
  )
})

test("bash git push with clear rails + gitState fixture → no throw", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, fullDeliveryState())
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

test("bash git push with DONE hand-record capturedVerifiedAt + freeze ancestor → no throw", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, fullDeliveryState())
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

// ── #ac-1.2 / #ac-1.3 through the real hook (branch/zero-commits rail kept 1:1) ────────

test("#ac-1.2: bash git push from main through the real hook → throws protected branch", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, {})
      const before = hooks["tool.execute.before"]
      await assert.rejects(
        () => before({ tool: "bash", sessionID: SID }, { args: { command: "git push" } }),
        /protected branch/i,
      )
    },
    { gitStateFn: () => ({ branch: "main", commitsAhead: 3, defaultBranch: "main" }) },
  )
})

test("#ac-1.3: bash git push with zero commits ahead through the real hook → throws zero commits", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, {})
      const before = hooks["tool.execute.before"]
      await assert.rejects(
        () => before({ tool: "bash", sessionID: SID }, { args: { command: "git push" } }),
        /zero commits/i,
      )
    },
    { gitStateFn: () => ({ branch: "feat/x", commitsAhead: 0, defaultBranch: "main" }) },
  )
})

// ── #ac-1.4 corrupt-regate parity through the real hook (deliberate fail-closed exception) ──

test("#ac-1.4: bash git push with corrupt regate_pending (non-array) through the real hook → throws gate-state corrupted, naming the raw value", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, { regate_pending: "BROKEN" })
      const before = hooks["tool.execute.before"]
      await assert.rejects(
        () => before({ tool: "bash", sessionID: SID }, { args: { command: "git push" } }),
        (err) => {
          assert.match(err.message, /gate-state corrupted/)
          assert.match(err.message, /BROKEN/)
          return true
        },
      )
    },
    {
      gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
    },
  )
})

test("#ac-1.4: bash git push with absent regate_pending through the real hook → PERMITIDO (fail-open, distinct from corrupt)", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, {})
      const before = hooks["tool.execute.before"]
      await assert.doesNotReject(() =>
        before({ tool: "bash", sessionID: SID }, { args: { command: "git push" } }),
      )
    },
    {
      gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
    },
  )
})

// ── marker-seal is deliberately NOT enforced on the bash delivery path ─────────────────
// Locks the reverted decision (see entry-gate.ts and docs/OC-CC-PARITY-REPORT.md item #32):
// an UNSEALED regate_passed entry (as if written directly to gate-state.json by an ordinary,
// freely-allowed non-delivery bash command, rather than stamped via mark.mjs) still clears
// the regate rail on the bash path. This is intentional — validating the per-process-instance
// seal here would resurrect incident #423 (every marker sealed before an OpenCode restart
// becomes permanently unverifiable, bricking delivery for any resumed session). The Task
// dispatch branch (a few lines below in this same hook) still validates seals unchanged.

test("bash git push with an UNSEALED regate_passed entry through the real hook → does not throw (marker-seal intentionally not enforced on bash; see #423)", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, {
        feature_id: "feat",
        regate_pending: ["feat/t1"],
        regate_passed: ["feat/t1@abc"],
      })
      const before = hooks["tool.execute.before"]
      await assert.doesNotReject(() =>
        before({ tool: "bash", sessionID: SID }, { args: { command: "git push" } }),
      )
    },
    {
      gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
      listHandRecordsForFeatureFn: () => [],
      isAncestorFn: () => true,
    },
  )
})

// ── #ac-2.1 spawn-hand.mjs fidelity rail through the real hook ─────────────────────────

test("#ac-2.1: spawn-hand.mjs dispatch with --descriptor whose task lacks fidelity-pass through the real hook → throws naming the qualified task", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, { feature_id: "feat", fidelity_pass: [] })
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () =>
        before(
          { tool: "bash", sessionID: SID },
          { args: { command: "node spawn-hand.mjs --descriptor /nonexistent-descriptor.json" } },
        ),
      /descriptor/,
    )
  })
})

test("#ac-2.1: spawn-hand.mjs dispatch without --descriptor through the real hook → PERMITIDO (fail-open)", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, {})
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() =>
      before(
        { tool: "bash", sessionID: SID },
        { args: { command: "cat spawn-hand.mjs" } },
      ),
    )
  })
})

// ── #ac-2.2 freeze-commit early capture trigger through the real hook ──────────────────

test("#ac-2.2: freeze-commit message with an unresolved hand-record for the current feature through the real hook → throws early, naming capturedVerifiedAt", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, { feature_id: "feat" })
      const before = hooks["tool.execute.before"]
      await assert.rejects(
        () =>
          before(
            { tool: "bash", sessionID: SID },
            { args: { command: 'git commit -m "test(cron): freeze locked tests for task-2"' } },
          ),
        /capturedVerifiedAt/,
      )
    },
    {
      listHandRecordsForFeatureFn: () => [
        { taskId: "t1", sessionId: SID, record: { outcome: "DONE", freezeCommitSha: "abc" } },
      ],
      isAncestorFn: () => true,
    },
  )
})

test("#ac-2.2: an ordinary git commit message through the real hook → PERMITIDO even with an unresolved hand-record (trigger is scoped to the freeze-commit convention)", async () => {
  await withHooks(
    async (hooks, root) => {
      writeGateState(root, SID, { feature_id: "feat" })
      const before = hooks["tool.execute.before"]
      await assert.doesNotReject(() =>
        before(
          { tool: "bash", sessionID: SID },
          { args: { command: 'git commit -m "chore: update memory notes"' } },
        ),
      )
    },
    {
      listHandRecordsForFeatureFn: () => [
        { taskId: "t1", sessionId: SID, record: { outcome: "DONE", freezeCommitSha: "abc" } },
      ],
      isAncestorFn: () => true,
    },
  )
})

test("lt-pure-planner-facts-allow — decideEntryTask planner + required facts → allow", async () => {
  const { decideEntryTask } = await import("../lib/entry-decide.mjs")
  const decision = decideEntryTask({
    subagentType: "planner",
    gateState: fullDeliveryState(),
  })
  assert.equal(decision.ok, true)
  assert.equal(decision.decision, "allow")
})

test("lt-entry-planner-s1-facts-allow — plain boolean facts under SID allow planner", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullDeliveryState())
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() =>
      before(
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "planner" } },
      ),
    )
  })
})

test("lt-entry-planner-null-sessionid-deny — task planner without sessionID rejects with /sessionId/", async () => {
  await withHooks(async (hooks) => {
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () =>
        before(
          { tool: "task" },
          { args: { subagent_type: "planner" } },
        ),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /sessionId/)
        assert.ok(
          !/brainstormed|adversary_fired/.test(err.message),
          "must not mask a missing sessionId as a missing planner fact",
        )
        return true
      },
    )
  })
})

test('#ac-1.5: lt-entry-delivery-bash-null-sessionid-allow — bash "gh pr create" without sessionID → PERMITIDO (fail-open, was denied naming /sessionId/)', async () => {
  await withHooks(
    async (hooks) => {
      const before = hooks["tool.execute.before"]
      await assert.doesNotReject(() =>
        before(
          { tool: "bash" },
          { args: { command: "gh pr create" } },
        ),
      )
    },
    { gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }) },
  )
})

test("lt-entry-s1-load-reads-classified — classified state with planner facts under S1 allows planner", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullDeliveryState())
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() =>
      before(
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "planner" } },
      ),
    )
  })
})

test("#ac-1.4 planner dispatch declaring a DIFFERENT feature_id than gate-state is denied through the real hook", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullDeliveryState({ feature_id: "feat" }))
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () =>
        before(
          { tool: "task", sessionID: SID },
          { args: { subagent_type: "planner", feature_id: "other-feature" } },
        ),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /\[entry-gate\]/)
        const denial = JSON.parse(err.message.slice(err.message.indexOf("{")))
        assert.equal(denial.code, "CEREMONY_PROOF_REQUIRED")
        assert.equal(denial.missing_proof, "brainstorming_completion_evidence")
        return true
      },
    )
    // Same feature_id as gate-state: no mismatch, allowed.
    await assert.doesNotReject(() =>
      before(
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "planner", feature_id: "feat" } },
      ),
    )
  })
})

// #ac-1.5 regression matrix: foreign S2 state proves tool args cannot select identity.
test("lt-reg-full-state-s1-planner-allow — required S1 facts allow planner", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullDeliveryState())
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() =>
      before(
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "planner" } },
      ),
    )
  })
})

test("lt-reg-null-sessionid-not-planner-fact — null sessionId denial names sessionId", async () => {
  await withHooks(async (hooks) => {
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () =>
        before(
          { tool: "task" },
          { args: { subagent_type: "planner" } },
        ),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /sessionId/)
        assert.ok(
          !/brainstormed|adversary_fired/.test(err.message),
          "must not mask a missing sessionId as a missing planner fact",
        )
        return true
      },
    )
  })
})

test("lt-reg-empty-state-valid-sid-fail-closed — valid S1 empty/missing state denies planner prerequisites", async () => {
  // missing file case (load returns ok+{} )
  await withHooks(async (hooks, root) => {
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () =>
        before(
          { tool: "task", sessionID: SID },
          { args: { subagent_type: "planner" } },
        ),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /\[entry-gate\]/)
        return true
      },
    )
  })
  // explicit empty object
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, {})
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () =>
        before(
          { tool: "task", sessionID: SID },
          { args: { subagent_type: "planner" } },
        ),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /\[entry-gate\]/)
        return true
      },
    )
  })
})

test("lt-reg-toolargs-foreign-hook-s1 — hook S1 facts + toolArgs.session_id foreign S2 still use S1", async () => {
  await withHooks(async (hooks, root) => {
    const S1 = "ses_reg_s1"
    const S2 = "ses_reg_s2"
    writeGateState(root, S1, fullDeliveryState({}, S1))
    // Foreign S2 proves toolArgs does not bind or leak identity.
    writeGateState(root, S2, fullDeliveryState({}, S2))
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() =>
      before(
        { tool: "task", sessionID: S1 },
        { args: { subagent_type: "planner", session_id: S2 } },
      ),
    )
  })
})

test("lt-reg-toolargs-foreign-hook-missing — missing hook sessionID ignores foreign toolArgs state", async () => {
  await withHooks(async (hooks, root) => {
    const S2 = "ses_reg_s2"
    writeGateState(root, S2, fullDeliveryState())
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () =>
        before(
          { tool: "task" },
          { args: { subagent_type: "planner", session_id: S2 } },
        ),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /\[entry-gate\]/)
        assert.match(err.message, /sessionId/)
        assert.ok(
          !/brainstormed|adversary_fired/.test(err.message),
          "sessionId cause must not be masked as a planner fact"
        )
        return true
      },
    )
  })
})

test("classify denied on child session (parentID set)", async () => {
  await withHooks(
    async (hooks) => {
      const before = hooks["tool.execute.before"]
      await assert.rejects(
        () =>
          before(
            { tool: "classify", sessionID: SID, agent: "build" },
            { args: { mode: "LIGHT", feature_id: "feat-x" } },
          ),
        (err) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /\[entry-gate\]/)
          assert.match(err.message, /child session|top-level/)
          return true
        },
      )
    },
    {
      getSessionParentIdFn: async () => "ses_parent",
    },
  )
})

test("classify denied for executor agent even top-level", async () => {
  await withHooks(
    async (hooks) => {
      const before = hooks["tool.execute.before"]
      await assert.rejects(
        () =>
          before(
            { tool: "classify", sessionID: SID, agent: "executor-high" },
            { args: { mode: "QUICK", feature_id: "feat-x" } },
          ),
        (err) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /executor-high|brief only|classify denied/)
          return true
        },
      )
    },
    {
      getSessionParentIdFn: async () => null,
    },
  )
})

test("classify allowed for top-level build", async () => {
  await withHooks(
    async (hooks) => {
      const before = hooks["tool.execute.before"]
      await before(
        { tool: "classify", sessionID: SID, agent: "build" },
        { args: { mode: "LIGHT", feature_id: "feat-x" } },
      )
    },
    {
      getSessionParentIdFn: async () => null,
    },
  )
})

test("configure-routing permits only an official root harness-config caller (#446)", async () => {
  const allowedCaller = async () => ({ ok: true, agent: "harness-config", parentSessionId: null })
  await withHooks(async (hooks) => {
    await assert.doesNotReject(() => hooks["tool.execute.before"](
      { tool: "configure-routing", sessionID: SID, callID: "routing-root" },
      { args: { action: "apply", confirm_weak_judgment_eyes: true } },
    ))
  }, { resolveConfigureRoutingAuthorityFn: allowedCaller })

  for (const caller of [
    { ok: true, agent: "harness-config", parentSessionId: "ses_parent" },
    { ok: true, agent: "general", parentSessionId: null },
    { ok: true, agent: "explore", parentSessionId: null },
    { ok: false, reason: "official runtime metadata unavailable" },
  ]) {
    await withHooks(async (hooks) => {
      await assert.rejects(
        () => hooks["tool.execute.before"](
          { tool: "configure-routing", sessionID: SID, callID: "routing-denied" },
          { args: { action: "apply", confirm_weak_judgment_eyes: true } },
        ),
        /\[entry-gate\].*(configure-routing|official runtime metadata|child session)/i,
      )
    }, { resolveConfigureRoutingAuthorityFn: async () => caller })
  }
})

test("configure-routing ignores model-supplied agent fields and binds the exact official tool part (#446)", async () => {
  const officialClient = ({ agent = "harness-config", parentID = null } = {}) => ({
    session: {
      get: async () => ({ data: { id: SID, ...(parentID ? { parentID } : {}) } }),
      messages: async () => ({ data: [{
        info: { id: "msg-routing", role: "assistant", sessionID: SID, agent },
        parts: [{ type: "tool", tool: "configure-routing", callID: "routing-official", sessionID: SID, messageID: "msg-routing" }],
      }] }),
    },
  })
  await withHooks(async (hooks) => {
    await assert.doesNotReject(() => hooks["tool.execute.before"](
      { tool: "configure-routing", sessionID: SID, callID: "routing-official", agent: "general" },
      { args: { action: "apply" } },
    ))
  }, { client: officialClient() })

  await withHooks(async (hooks) => {
    await assert.rejects(
      () => hooks["tool.execute.before"](
        { tool: "configure-routing", sessionID: SID, callID: "routing-official", agent: "harness-config" },
        { args: { action: "apply" } },
      ),
      /\[entry-gate\].*general/i,
    )
  }, { client: officialClient({ agent: "general" }) })
})

test("#ac-1.1 corrupt (illegible) gate-state permits task dispatch with a logged warning, and a transient hiccup self-heals on retry", async () => {
  await withHooks(async (hooks, root) => {
    const dir = path.join(root, ".opencode", "plans", ".state", SID)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "gate-state.json")
    fs.writeFileSync(file, "{not valid json", "utf8")
    const before = hooks["tool.execute.before"]
    const originalError = console.error
    const logged = []
    console.error = (...args) => { logged.push(args.map(String).join(" ")) }
    try {
      // Every harness role is a "delivery role" — a genuinely empty state (what an
      // unreadable file collapses to) still fails its own planner-fact check downstream. This
      // dispatch alone cannot prove "permitted"; it only proves the unreadable FILE itself is
      // never the denial reason (never gate-state-unreadable / invalid JSON).
      try {
        await before(
          { tool: "task", sessionID: SID },
          { args: { subagent_type: "planner", description: "plan", prompt: "x" } },
        )
      } catch (err) {
        assert.ok(err instanceof Error)
        assert.doesNotMatch(err.message, /gate-state-unreadable|gate-state invalid JSON/)
      }
    } finally {
      console.error = originalError
    }
    assert.ok(logged.some((line) => /gate-state unreadable/.test(line)), "expected a logged warning")

    // The real, provable value of #ac-1.1: a TRANSIENT infra hiccup (the realistic case — a race
    // with a concurrent writer, a momentary read error) does not permanently brick the session.
    // Once the file is readable again, the NEXT dispatch proceeds normally — unlike the old
    // fail-closed behavior, which denied unconditionally and never recovered on retry.
    writeGateState(root, SID, fullDeliveryState())
    await assert.doesNotReject(() => before(
      { tool: "task", sessionID: SID },
      { args: { subagent_type: "planner", description: "plan", prompt: "x" } },
    ))
  })
})

// --- #516 fleet bash denylist choke-point ------------------------------------------------

function withEnv(overrides, fn) {
  const saved = {}
  for (const key of Object.keys(overrides)) saved[key] = process.env[key]
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return (async () => {
    try {
      return await fn()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })()
}

test("#516: fleet dispatch context (HARNESS_NOTIFY_PROJECT set) denies a destructive git force-push via the denylist choke-point, independent of gate-state/advisory", async () => {
  await withEnv({ HARNESS_NOTIFY_PROJECT: "test-project", HARNESS_OC_DATA_HOME: undefined }, async () => {
    await withHooks(async (hooks, root) => {
      writeGateState(root, SID, {})
      const before = hooks["tool.execute.before"]
      await assert.rejects(
        () =>
          before(
            { tool: "bash", sessionID: SID },
            { args: { command: "git push --force origin main" } },
          ),
        (err) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /\[entry-gate\]/)
          assert.match(err.message, /issue #516/)
          return true
        },
      )
    })
  })
})

test("#516: fleet dispatch context still allows git push --force-with-lease (denylist's own findLast carve-out survives the plugin-level re-check)", async () => {
  await withEnv({ HARNESS_NOTIFY_PROJECT: "test-project", HARNESS_OC_DATA_HOME: undefined }, async () => {
    await withHooks(
      async (hooks, root) => {
        writeGateState(root, SID, {})
        const before = hooks["tool.execute.before"]
        await assert.doesNotReject(() =>
          before(
            { tool: "bash", sessionID: SID },
            { args: { command: "git push --force-with-lease origin feat/x" } },
          ),
        )
      },
      {
        gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
        listHandRecordsForFeatureFn: () => [],
        isAncestorFn: () => true,
      },
    )
  })
})

test("#516: fleet dispatch context still allows a prescribed npx carve-out (npx vitest run) even though the broad 'npx *' pattern is a deny", async () => {
  await withEnv({ HARNESS_NOTIFY_PROJECT: "test-project", HARNESS_OC_DATA_HOME: undefined }, async () => {
    await withHooks(
      async (hooks, root) => {
        writeGateState(root, SID, {})
        const before = hooks["tool.execute.before"]
        await assert.doesNotReject(() =>
          before(
            { tool: "bash", sessionID: SID },
            { args: { command: "npx vitest run some.test.mjs" } },
          ),
        )
      },
      {
        gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
        listHandRecordsForFeatureFn: () => [],
        isAncestorFn: () => true,
      },
    )
  })
})

test("#516: same destructive command is NOT blocked by this choke-point outside fleet dispatch (no HARNESS_NOTIFY_PROJECT) — interactive sessions rely on the resolved permission.bash config, scoped deliberately like DANGEROUS_BASH_DENYLIST itself", async () => {
  await withEnv({ HARNESS_NOTIFY_PROJECT: undefined, HARNESS_OC_DATA_HOME: undefined }, async () => {
    await withHooks(
      async (hooks, root) => {
        writeGateState(root, SID, {})
        const before = hooks["tool.execute.before"]
        await assert.doesNotReject(() =>
          before(
            { tool: "bash", sessionID: SID },
            { args: { command: "git push --force origin main" } },
          ),
        )
      },
      {
        gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
        listHandRecordsForFeatureFn: () => [],
        isAncestorFn: () => true,
      },
    )
  })
})

test("#516: HARNESS_OC_DATA_HOME alone does NOT arm the choke-point (adversarial review fix) — core/opencode/skills/triaging-requests/SKILL.md documents it as unreliable: a manually-started operator SSH session on the VPS inherits it from the shell, so keying on it would have armed npx/bash-c/tar denies against a live interactive operator", async () => {
  await withEnv({ HARNESS_NOTIFY_PROJECT: undefined, HARNESS_OC_DATA_HOME: "/tmp/oc-data-test" }, async () => {
    await withHooks(
      async (hooks, root) => {
        writeGateState(root, SID, {})
        const before = hooks["tool.execute.before"]
        await assert.doesNotReject(() =>
          before(
            { tool: "bash", sessionID: SID },
            { args: { command: "git reset --hard HEAD~1" } },
          ),
        )
      },
      {
        gitStateFn: () => ({ branch: "feat/x", commitsAhead: 1, defaultBranch: "main" }),
        listHandRecordsForFeatureFn: () => [],
        isAncestorFn: () => true,
      },
    )
  })
})

test("entry-gate claims one exact dispatch record after allowing a writing Task", async () => {
  await withHooks(async (hooks, root) => {
    writeScopeReadyState(root)
    await hooks["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "call-claim" }, { args: writingTaskArgs() })
    const record = JSON.parse(fs.readFileSync(exactDispatchPath(root, SID, "call-claim"), "utf8"))
    assert.deepEqual(record, {
      parent_session_id: SID,
      dispatch_call_id: "call-claim",
      child_session_id: null,
      feature_id: "feat",
      task_id: "task-scope",
      role: "executor-low",
      scope_paths: ["src"],
      allowed_writes: [],
      frozen_paths: ["tests/a.test.mjs"],
      snapshot_hash: record.snapshot_hash,
      claimed_at: record.claimed_at,
    })
    assert.match(record.claimed_at, /^\d{4}-\d{2}-\d{2}T/)
  })
})

test("fix-mode writing Task fails closed when exact task or call identity is missing", async () => {
  const reviewedSha = "abc123abc123abc123abc123abc123abc123abcd"
  const deps = {
    dispatchEnvironment: {
      HARNESS_FIX_MODE: "1",
      HARNESS_FIX_SCOPE_JSON: JSON.stringify({ version: 1, reviewed_sha: reviewedSha, scope_paths: ["src/fix.ts"] }),
    },
    isAncestorFn: () => true,
  }
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, { session_id: SID, feature_id: "feat", classified: true, mode: "LIGHT" })
    const before = hooks["tool.execute.before"]
    for (const [input, prompt] of [
      [{ tool: "task", sessionID: SID, callID: "missing-task" }, "repair"],
      [{ tool: "task", sessionID: SID, callID: "malformed-task" }, "[HARNESS_TASK_CONTEXT]{bad}[/HARNESS_TASK_CONTEXT]"],
      [{ tool: "task", sessionID: SID }, '[HARNESS_TASK_CONTEXT]{"task_id":"fix-task"}[/HARNESS_TASK_CONTEXT]'],
    ]) {
      await assert.rejects(
        () => before(input, { args: { prompt, subagent_type: "sniper-high", feature_id: "feat" } }),
        /exact dispatch identity required/,
      )
    }
  }, deps)
})

test("fix-mode default SHA ancestry probe is rooted in the target project", async () => {
  const foreignSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  await withHooks(async (hooks, root) => {
    execFileSync("git", ["init", "-q"], { cwd: root })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root })
    fs.writeFileSync(path.join(root, "target.txt"), "target\n")
    execFileSync("git", ["add", "target.txt"], { cwd: root })
    execFileSync("git", ["commit", "-qm", "target"], { cwd: root })
    writeGateState(root, SID, { session_id: SID, feature_id: "feat", classified: true, mode: "LIGHT" })
    await assert.rejects(
      () => hooks["tool.execute.before"](
        { tool: "task", sessionID: SID, callID: "foreign-sha" },
        { args: {
          prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"fix-task"}[/HARNESS_TASK_CONTEXT]',
          subagent_type: "sniper-high",
          feature_id: "feat",
        } },
      ),
      /reviewed sha is not an ancestor/,
    )
  }, {
    dispatchEnvironment: {
      HARNESS_FIX_MODE: "1",
      HARNESS_FIX_SCOPE_JSON: JSON.stringify({ version: 1, reviewed_sha: foreignSha, scope_paths: ["target.txt"] }),
    },
  })
})

test("entry-gate terminal after and tool error remove only their exact parent call", async () => {
  await withHooks(async (hooks, root) => {
    writeScopeReadyState(root)
    const args = writingTaskArgs()
    await hooks["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "call-after" }, { args })
    await hooks["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "call-sibling" }, { args })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: SID, callID: "call-after" }, { args })
    assert.equal(fs.existsSync(exactDispatchPath(root, SID, "call-after")), false)
    assert.equal(fs.existsSync(exactDispatchPath(root, SID, "call-sibling")), true)
    await hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "tool", tool: "task", sessionID: SID, callID: "call-sibling", state: { status: "error" } } } } })
    assert.equal(fs.existsSync(exactDispatchPath(root, SID, "call-sibling")), false)
  })
})

test("entry-gate binds a child only from one official parent Task fact", async () => {
  const childSessionId = "child-scope"
  const client = {
    session: {
      get: async () => ({ data: { id: childSessionId, parentID: SID } }),
      messages: async () => ({ data: [{
        info: { id: "parent-message", sessionID: SID, role: "assistant" },
        parts: [{ type: "tool", tool: "task", sessionID: SID, messageID: "parent-message", callID: "call-bind", state: { status: "running", input: { subagent_type: "executor-low" }, metadata: { sessionId: childSessionId } } }],
      }] }),
    },
  }
  await withHooks(async (hooks, root) => {
    writeScopeReadyState(root)
    await hooks["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "call-bind" }, { args: writingTaskArgs() })
    await hooks.event({ event: { type: "message.updated", properties: { info: { sessionID: childSessionId, agent: "executor-low" } } } })
    const record = JSON.parse(fs.readFileSync(exactDispatchPath(root, SID, "call-bind"), "utf8"))
    assert.equal(record.child_session_id, childSessionId)
  }, { client })
})

test("entry-gate leaves an exact record unbound when SDK is unavailable or parent facts are ambiguous", async () => {
  const childSessionId = "child-unbound"
  const ambiguousClient = {
    session: {
      get: async () => ({ data: { id: childSessionId, parentID: SID } }),
      messages: async () => ({ data: ["one", "two"].map((id) => ({
        info: { id, sessionID: SID, role: "assistant" },
        parts: [{ type: "tool", tool: "task", sessionID: SID, messageID: id, callID: "call-unbound", state: { status: "running", input: { subagent_type: "executor-low" }, metadata: { sessionId: childSessionId } } }],
      })) }),
    },
  }
  await withHooks(async (hooks, root) => {
    writeScopeReadyState(root)
    await hooks["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "call-unbound" }, { args: writingTaskArgs() })
    await assert.doesNotReject(() => hooks.event({ event: { type: "message.updated", properties: { info: { sessionID: childSessionId, agent: "executor-low" } } } }))
    const record = JSON.parse(fs.readFileSync(exactDispatchPath(root, SID, "call-unbound"), "utf8"))
    assert.equal(record.child_session_id, null)
  }, { client: ambiguousClient })

  await withHooks(async (hooks, root) => {
    writeScopeReadyState(root)
    await hooks["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "call-sdk-fault" }, { args: writingTaskArgs() })
    await assert.doesNotReject(() => hooks.event({ event: { type: "message.updated", properties: { info: { sessionID: childSessionId, agent: "executor-low" } } } }))
    const record = JSON.parse(fs.readFileSync(exactDispatchPath(root, SID, "call-sdk-fault"), "utf8"))
    assert.equal(record.child_session_id, null)
  }, { client: { session: { get: async () => { throw new Error("SDK unavailable") }, messages: async () => [] } } })

  await withHooks(async (hooks, root) => {
    writeScopeReadyState(root)
    await hooks["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "call-sdk-mismatch" }, { args: writingTaskArgs() })
    await hooks.event({ event: { type: "message.updated", properties: { info: { sessionID: childSessionId, agent: "executor-low" } } } })
    const record = JSON.parse(fs.readFileSync(exactDispatchPath(root, SID, "call-sdk-mismatch"), "utf8"))
    assert.equal(record.child_session_id, null)
  }, { client: { session: { get: async () => ({ data: { id: "different-child", parentID: SID } }), messages: async () => { throw new Error("must not query foreign parent") } } } })
})

test("entry-gate DONE completion retains exact producer authority until capture", async () => {
  await withHooks(async (hooks, root) => {
    writeScopeReadyState(root)
    const args = writingTaskArgs()
    await hooks["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "call-finish-first" }, { args })
    await hooks["tool.execute.after"]({ tool: "task", sessionID: SID, callID: "call-finish-first" }, { args, output: "Status: DONE" })
    const recordPath = path.join(root, ".opencode", "plans", ".state", "hand-records", "feat", SID, "task-scope.json")
    assert.equal(JSON.parse(fs.readFileSync(recordPath, "utf8")).producerCallId, "call-finish-first")
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, `.opencode/plans/.state/${SID}/gate-state.json`), "utf8")).hand_finished, ["feat/task-scope"])
    assert.equal(fs.existsSync(exactDispatchPath(root, SID, "call-finish-first")), true)
  })
})

test("entry-gate background running after keeps its exact dispatch record", async () => {
  await withHooks(async (hooks, root) => {
    writeScopeReadyState(root)
    const args = writingTaskArgs()
    const input = { tool: "task", sessionID: SID, callID: "call-background-running" }
    await hooks["tool.execute.before"](input, { args })
    await hooks["tool.execute.after"](input, { args, metadata: { background: true }, output: '<task state="running">' })
    assert.equal(fs.existsSync(exactDispatchPath(root, SID, "call-background-running")), true)
  })
})

test("entry-gate completion producer failure retains exact dispatch authority for retry", async () => {
  await withHooks(async (hooks, root) => {
    writeScopeReadyState(root)
    const initialArgs = writingTaskArgs()
    const input = { tool: "task", sessionID: SID, callID: "call-completion-retry" }
    await hooks["tool.execute.before"](input, { args: initialArgs })
    const mismatchedArgs = { ...initialArgs, subagent_type: "sniper-low" }
    await hooks["tool.execute.after"](input, { args: mismatchedArgs, output: "Status: DONE" })
    assert.equal(fs.existsSync(exactDispatchPath(root, SID, "call-completion-retry")), true)
    assert.equal(fs.existsSync(path.join(root, ".opencode", "plans", ".state", "hand-records", "feat", SID, "task-scope.json")), false)
  })
})

test("obs-first then entry terminal after keeps hand record and capture-pending producer stable", async () => {
  await withHooks(async (hooks, root) => {
    writeScopeReadyState(root)
    const args = writingTaskArgs()
    const input = { tool: "task", sessionID: SID, callID: "call-obs-first" }
    const output = { args, output: "Status: DONE" }
    await hooks["tool.execute.before"](input, { args })
    const obs = await createObsHandHooks(root)
    await obs["tool.execute.after"](input, output)
    const recordPath = path.join(root, ".opencode", "plans", ".state", "hand-records", "feat", SID, "task-scope.json")
    const before = fs.readFileSync(recordPath)
    await hooks["tool.execute.after"](input, output)
    assert.deepEqual(fs.readFileSync(recordPath), before)
    assert.equal(fs.existsSync(exactDispatchPath(root, SID, "call-obs-first")), true)
  })
})
