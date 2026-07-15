/**
 * @description Locked tests for OC entry-gate shell (bash delivery + task ceremony).
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createEntryGateHooks } from "./entry-gate.ts"
import { sealedMarkerRecord } from "./lib/marker-seal.mjs"

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
function fullCeremony(extra = {}, sessionId = SID) {
  const state = {
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
  const featureId = typeof state.feature_id === "string" ? state.feature_id : ""
  const markerSeals = []
  for (const [key, action] of [["brainstormed", "brainstormed"], ["adversary_fired", "adversary_fired"], ["dual_status", "dual"]]) {
    if (state[key] === true || typeof state[key] === "string") {
      markerSeals.push(sealedMarkerRecord({ sessionId, featureId, operation: action, payload: state[key] }))
    }
  }
  for (const [key, action] of [["fidelity_pass", "fidelity"], ["regate_pending", "regate-pending"], ["regate_passed", "regate-passed"], ["hand_finished", "hand-finished"], ["capture_verified", "capture-verified"]]) {
    if (Array.isArray(state[key])) {
      for (const value of state[key]) markerSeals.push(sealedMarkerRecord({ sessionId, featureId, operation: action, payload: value }))
    }
  }
  if (!("marker_seals" in extra)) state.marker_seals = markerSeals
  if (!("brainstormed_binding" in extra)) state.brainstormed_binding = { session_id: sessionId, feature_id: featureId, operation: "brainstormed", seal: markerSeals.find((record) => record.operation === "brainstormed").seal }
  if (!("adversary_fired_binding" in extra)) state.adversary_fired_binding = { session_id: sessionId, feature_id: featureId, operation: "adversary_fired", seal: markerSeals.find((record) => record.operation === "adversary_fired").seal }
  return state
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

test("direct unsigned marker mutation cannot release a delivery role", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, {
      session_id: SID,
      feature_id: "feat",
      mode: "FULL",
      classified: true,
      brainstormed: true,
      adversary_fired: true,
      dual_status: "both",
    })
    await assert.rejects(
      () => hooks["tool.execute.before"](
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "planner" } },
      ),
      /unsigned|another process instance/,
    )
  })
})

test("task identity aliases conflict before dispatch, while trusted task identity overrides model input", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullCeremony({ fidelity_pass: ["feat/trusted-task"] }))
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () => before(
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "executor-low", task_id: "task-a", taskId: "task-b" } },
      ),
      /taskId.*conflict/,
    )
    await assert.doesNotReject(() => before(
      { tool: "task", sessionID: SID, task_id: "trusted-task" },
      { args: {
        subagent_type: "executor-low",
        task_id: "model-task",
        prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"model-task"}[/HARNESS_TASK_CONTEXT]',
      } },
    ))
  })
})

test("planner rejects ceremony marker bound to another session or feature", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullCeremony({
      session_id: SID,
      brainstormed_binding: { session_id: "ses-other", feature_id: "feat", operation: "brainstormed" },
      adversary_fired_binding: { session_id: SID, feature_id: "other-feature", operation: "adversary_fired" },
    }))
    await assert.rejects(
      () => hooks["tool.execute.before"](
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "planner" } },
      ),
      /not bound|session binding mismatch|feature binding mismatch/,
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

test("bound execution plan blocks bash mutation but permits read", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullCeremony({ planner_status: "usable" }))
    const before = hooks["tool.execute.before"]
    await assert.rejects(
      () => before(
        { tool: "bash", sessionID: SID },
        { args: { command: "cat > .opencode/plans/ses-feat/execution-plan.json <<'EOF'\n{}\nEOF" } },
      ),
      /immutable/,
    )
    await assert.doesNotReject(() => before(
      { tool: "bash", sessionID: SID },
      { args: { command: "cat .opencode/plans/ses-feat/execution-plan.json" } },
    ))
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

test("lt-pure-planner-full-ceremony-allow — decideEntryTask planner + full ceremony → allow (import decideEntryTask from entry-decide.mjs)", async () => {
  const { decideEntryTask } = await import("./lib/entry-decide.mjs")
  const decision = decideEntryTask({
    subagentType: "planner",
    gateState: fullCeremony(),
  })
  assert.equal(decision.ok, true)
  assert.equal(decision.decision, "allow")
})

test("lt-entry-planner-s1-full-ceremony-allow — write fullCeremony under SID, hook sessionID SID, task planner → doesNotReject", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullCeremony())
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() =>
      before(
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "planner" } },
      ),
    )
  })
})

test("lt-entry-planner-null-sessionid-deny — task planner without sessionID → rejects with /sessionId/ and NOT /ceremony missing/", async () => {
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
          !/ceremony missing/.test(err.message),
          "must not contain generic ceremony missing when sessionId is the cause",
        )
        return true
      },
    )
  })
})

test('lt-entry-delivery-bash-null-sessionid-deny — bash "gh pr create" without sessionID → rejects with /sessionId/', async () => {
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
        assert.match(err.message, /sessionId/)
        return true
      },
    )
  })
})

test("lt-entry-s1-load-reads-classified — fullCeremony with classified under S1 + planner + sessionID S1 → allow", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullCeremony())
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() =>
      before(
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "planner" } },
      ),
    )
  })
})

// #ac-1.5 regression matrix (task-3) — explicit lt-reg-* names per spec; reuse helpers; foreign S2 written to prove no toolArgs bind
// 1+2 covered by identical lt-entry-* (task-2); thin aliases with comment only (per instruction)
test("lt-reg-full-ceremony-s1-planner-allow — full ceremony S1 + planner allow (thin alias; identical to lt-entry-planner-s1-full-ceremony-allow which task-2 covers; explicit lt-reg name for AC matrix)", async () => {
  await withHooks(async (hooks, root) => {
    writeGateState(root, SID, fullCeremony())
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() =>
      before(
        { tool: "task", sessionID: SID },
        { args: { subagent_type: "planner" } },
      ),
    )
  })
})

test("lt-reg-null-sessionid-not-ceremony — null sessionId deny /sessionId/ not ceremony (thin alias; identical to lt-entry-planner-null-sessionid-deny which task-2 covers; explicit lt-reg name for AC matrix)", async () => {
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
          !/ceremony missing/.test(err.message),
          "must not contain generic ceremony missing when sessionId is the cause",
        )
        return true
      },
    )
  })
})

// 3,4,5: missing coverage for matrix; use planner + fullCeremony state on disk; foreign S2
test("lt-reg-empty-ceremony-valid-sid-fail-closed — valid S1 empty/missing state + planner → deny ceremony or brainstorm (NOT allow)", async () => {
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
        const m = err.message
        assert.ok(
          /ceremony missing|brainstormed|adversary_fired/.test(m),
          "deny with ceremony/brainstorm reason on empty state"
        )
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

test("lt-reg-toolargs-foreign-hook-s1 — hook S1 full ceremony + toolArgs.session_id foreign S2 → still allow via S1 (planner)", async () => {
  await withHooks(async (hooks, root) => {
    const S1 = "ses_reg_s1"
    const S2 = "ses_reg_s2"
    writeGateState(root, S1, fullCeremony({}, S1))
    // write foreign S2 with full ceremony to prove toolArgs does not bind / leak
    writeGateState(root, S2, fullCeremony({}, S2))
    const before = hooks["tool.execute.before"]
    await assert.doesNotReject(() =>
      before(
        { tool: "task", sessionID: S1 },
        { args: { subagent_type: "planner", session_id: S2 } },
      ),
    )
  })
})

test("lt-reg-toolargs-foreign-hook-missing — hook missing sessionID + toolArgs foreign full ceremony → deny /sessionId/ NOT allow", async () => {
  await withHooks(async (hooks, root) => {
    const S2 = "ses_reg_s2"
    writeGateState(root, S2, fullCeremony())
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
          !/ceremony missing/.test(err.message),
          "sessionId cause must not be masked as ceremony"
        )
        return true
      },
    )
  })
})
