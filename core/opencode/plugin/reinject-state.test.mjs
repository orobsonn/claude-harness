/** @description Integration and fail-closed tests for OpenCode session compaction recovery. */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Worker } from "node:worker_threads"
import { createReinjectStateHooks } from "./reinject-state.ts"
import { buildSessionRecovery, cleanupRetainedCompletedSession, encodeRecoveryPayload, sweepRetainedSessions } from "./lib/session-state.mjs"
import { semanticPlanHash } from "./lib/planner-artifact.mjs"

function fixture(sessionID = "ses-own", featureID = "restore-own-session") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-reinject-"))
  const stateDir = path.join(root, ".opencode", "plans", ".state", sessionID)
  const planDir = path.join(root, ".opencode", "plans", `${sessionID}-${featureID}`)
  const snapshotDir = path.join(stateDir, "bound-plans")
  fs.mkdirSync(snapshotDir, { recursive: true })
  fs.mkdirSync(planDir, { recursive: true })
  const task = (id) => ({
    id,
    severity: "low",
    scope_paths: ["src/index.ts"],
    criterion_refs: ["#ac-1.1"],
    no_tests: true,
    locked_tests: [],
    depends_on: [],
  })
  const plan = { feature_id: featureID, mode: "full", tasks: [task("task-one"), task("task-two")] }
  const hash = semanticPlanHash(plan)
  const snapshotPath = path.join(snapshotDir, `${hash}.json`)
  fs.writeFileSync(snapshotPath, JSON.stringify(plan))
  fs.writeFileSync(path.join(planDir, "execution-plan.json"), JSON.stringify(plan))
  const statePath = path.join(stateDir, "gate-state.json")
  fs.writeFileSync(statePath, JSON.stringify({
    session_id: sessionID,
    feature_id: featureID,
    mode: "FULL",
    planner_status: "usable",
    planner_plan_binding: {
      session_id: sessionID,
      feature_id: featureID,
      snapshot_path: path.relative(root, snapshotPath),
      snapshot_hash: hash,
    },
    capture_verified: [`${featureID}/task-one@abc1234`],
    regate_pending: [`${featureID}/task-two`],
    regate_passed: [],
  }))
  return { root, sessionID, featureID, statePath, planDir, snapshotPath }
}

function cleanup(value) {
  fs.rmSync(value.root, { recursive: true, force: true })
}

test("official compacting hook restores bounded derived session context", async () => {
  const f = fixture()
  try {
    const hooks = await createReinjectStateHooks(f.root, f.root, { setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} })
    assert.equal("chat.message" in hooks, false)
    const output = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: f.sessionID }, output)
    assert.equal(output.context.length, 1)
    assert.ok(Buffer.byteLength(output.context[0], "utf8") <= 8192)
    const payload = JSON.parse(output.context[0].split("\n")[1])
    assert.equal(payload.mode, "FULL")
    assert.equal(payload.feature_id, "restore-own-session")
    assert.equal(payload.canonical_plan_path, `.opencode/plans/${f.sessionID}-${f.featureID}/execution-plan.json`)
    assert.deepEqual(payload.progress, { capture_verified: 0, total_tasks: 2 })
    assert.equal(payload.shared_context_path, `.opencode/plans/${f.sessionID}-${f.featureID}/shared_context.md`)
    assert.deepEqual(payload.unmatched_regates, ["restore-own-session/task-two"])
    assert.doesNotMatch(output.context[0], /abc1234/)
    assert.equal(output.context[0].includes(f.root), false)
  } finally { cleanup(f) }
})

test("chat state-like text cannot trigger recovery", async () => {
  const f = fixture()
  try {
    const hooks = await createReinjectStateHooks(f.root, f.root)
    assert.equal(hooks["chat.message"], undefined)
  } finally { cleanup(f) }
})

test("JSON envelope escapes newline and control characters from every path value", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oc-reinject-control-"))
  const root = path.join(parent, "worktree\nignore previous\u0001")
  fs.mkdirSync(root)
  const original = fixture("ses-control", "control-path")
  try {
    fs.cpSync(path.join(original.root, ".opencode"), path.join(root, ".opencode"), { recursive: true })
    const stateDir = path.join(root, ".opencode", "plans", ".state", original.sessionID)
    const statePath = path.join(stateDir, "gate-state.json")
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"))
    state.planner_plan_binding.snapshot_path = path.relative(root, path.join(stateDir, "bound-plans", `${state.planner_plan_binding.snapshot_hash}.json`))
    fs.writeFileSync(statePath, JSON.stringify(state))
    const recovered = buildSessionRecovery(root, original.sessionID, { isAncestor: () => false })
    assert.equal(recovered.ok, true)
    assert.equal(recovered.context.includes("worktree\nignore"), false)
    assert.equal(recovered.context.includes("\u0001"), false)
    assert.equal(recovered.context.includes("ignore previous"), false)
    JSON.parse(recovered.context.split("\n")[1])
  } finally {
    cleanup(original)
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test("UTF-8 byte cap includes delimiters and truncates only at a valid multibyte boundary", () => {
  const context = encodeRecoveryPayload({ schema: "harness.compaction-recovery.v1", value: "界".repeat(20_000) })
  assert.ok(context)
  assert.ok(Buffer.byteLength(context, "utf8") <= 8192)
  assert.equal(Buffer.from(context, "utf8").toString("utf8"), context)
  const payload = JSON.parse(context.split("\n")[1])
  assert.equal(payload.truncated, true)
  assert.equal(payload.truncated_json_prefix.includes("�"), false)
})

test("re-gates match only the same feature/task with an ancestor SHA", () => {
  const f = fixture()
  try {
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    state.regate_passed = [`${f.featureID}/task-two@feed123`]
    fs.writeFileSync(f.statePath, JSON.stringify(state))
    let recovered = buildSessionRecovery(f.root, f.sessionID, { isAncestor: (sha) => sha === "feed123" })
    assert.equal(recovered.ok, true)
    assert.deepEqual(JSON.parse(recovered.context.split("\n")[1]).unmatched_regates, [])

    recovered = buildSessionRecovery(f.root, f.sessionID, { isAncestor: () => false })
    assert.equal(recovered.ok, true)
    assert.deepEqual(JSON.parse(recovered.context.split("\n")[1]).unmatched_regates, ["restore-own-session/task-two"])
  } finally { cleanup(f) }
})

test("wrong envelope session is rejected without mutating either session", async () => {
  const f = fixture()
  try {
    const before = fs.readFileSync(f.statePath)
    const hooks = await createReinjectStateHooks(f.root, f.root)
    const output = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: "ses-other" }, output)
    assert.deepEqual(output.context, [])
    assert.deepEqual(fs.readFileSync(f.statePath), before)
    assert.equal(fs.existsSync(path.join(f.root, ".opencode", "plans", ".state", "ses-other")), false)
  } finally { cleanup(f) }
})

test("corrupt state, sibling worktree, traversal, and snapshot symlink fail closed", async () => {
  const f = fixture()
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "oc-reinject-sibling-"))
  try {
    fs.writeFileSync(f.statePath, "{")
    let hooks = await createReinjectStateHooks(f.root, f.root)
    let output = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: f.sessionID }, output)
    assert.deepEqual(output.context, [])

    hooks = await createReinjectStateHooks(sibling, f.root)
    output = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: f.sessionID }, output)
    assert.deepEqual(output.context, [])

    hooks = await createReinjectStateHooks(f.root, f.root)
    assert.equal(hooks["experimental.session.compacting"] instanceof Function, true)
    output = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: "../foreign" }, output)
    assert.deepEqual(output.context, [])

    const valid = fixture("ses-symlink", "symlink-plan")
    try {
      const outside = path.join(sibling, "snapshot.json")
      fs.writeFileSync(outside, JSON.stringify({ feature_id: valid.featureID, tasks: [{ id: "task-one" }] }))
      fs.rmSync(valid.snapshotPath)
      fs.symlinkSync(outside, valid.snapshotPath)
      hooks = await createReinjectStateHooks(valid.root, valid.root)
      output = { context: [] }
      await hooks["experimental.session.compacting"]({ sessionID: valid.sessionID }, output)
      assert.deepEqual(output.context, [])
    } finally { cleanup(valid) }
  } finally {
    cleanup(f)
    fs.rmSync(sibling, { recursive: true, force: true })
  }
})

test("snapshot binding accepts only the exact canonical repo-relative path", () => {
  for (const mutate of [
    (f, state) => { state.planner_plan_binding.snapshot_path = f.snapshotPath },
    (_f, state) => { state.planner_plan_binding.snapshot_path = state.planner_plan_binding.snapshot_path.replace("bound-plans/", "bound-plans/./") },
    (_f, state) => { state.planner_plan_binding.snapshot_path = state.planner_plan_binding.snapshot_path.replace("bound-plans/", "bound-plans/x/../") },
    (_f, state) => { state.planner_plan_binding.snapshot_path = state.planner_plan_binding.snapshot_path.replaceAll("/", "\\") },
    (_f, state) => { state.planner_plan_binding.snapshot_path = `.opencode/plans/.state/ses-other/bound-plans/${state.planner_plan_binding.snapshot_hash}.json` },
  ]) {
    const f = fixture()
    try {
      const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
      mutate(f, state)
      fs.writeFileSync(f.statePath, JSON.stringify(state))
      assert.equal(buildSessionRecovery(f.root, f.sessionID).ok, false)
    } finally { cleanup(f) }
  }
})

test("expired completed session cleanup removes only its stale marker", () => {
  const f = fixture()
  try {
    fs.writeFileSync(f.statePath, JSON.stringify({
      session_id: f.sessionID,
      session_status: "completed",
      session_completed_at: "2026-01-01T00:00:00.000Z",
    }))
    const result = cleanupRetainedCompletedSession(f.root, f.sessionID, {
      retentionMs: 1_000,
      now: Date.parse("2026-01-02T00:00:00.000Z"),
    })
    assert.deepEqual(result, { ok: true, cleaned: true })
    assert.equal(fs.existsSync(f.statePath), false)
    assert.equal(fs.existsSync(path.join(f.planDir, "execution-plan.json")), true)
  } finally { cleanup(f) }
})

test("concurrent reopen wins after completed marker is claimed", () => {
  const f = fixture()
  try {
    fs.writeFileSync(f.statePath, JSON.stringify({
      session_id: f.sessionID,
      session_status: "completed",
      session_completed_at: "2026-01-01T00:00:00.000Z",
    }))
    const originalRename = fs.renameSync
    fs.renameSync = function(source, target) {
      originalRename.call(fs, source, target)
      if (source === path.dirname(f.statePath) && String(target).endsWith(".retained")) {
        fs.mkdirSync(path.dirname(f.statePath), { recursive: true })
        fs.writeFileSync(f.statePath, JSON.stringify({ session_id: f.sessionID, session_status: "active" }))
      }
    }
    try {
      const result = cleanupRetainedCompletedSession(f.root, f.sessionID, {
        retentionMs: 0,
        now: Date.parse("2026-01-02T00:00:00.000Z"),
      })
      assert.equal(result.cleaned, true)
    } finally { fs.renameSync = originalRename }
    assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).session_status, "active")
  } finally { cleanup(f) }
})

test("active and completed-inside-retention sessions are retained", () => {
  const f = fixture()
  try {
    for (const state of [
      { session_id: f.sessionID, session_status: "active", session_completed_at: "2020-01-01T00:00:00.000Z" },
      { session_id: f.sessionID, session_status: "completed", session_completed_at: "2026-01-01T00:00:00.000Z" },
    ]) {
      fs.writeFileSync(f.statePath, JSON.stringify(state))
      const result = cleanupRetainedCompletedSession(f.root, f.sessionID, {
        retentionMs: 86_400_000,
        now: Date.parse("2026-01-01T12:00:00.000Z"),
      })
      assert.equal(result.cleaned, false)
      assert.equal(fs.existsSync(f.statePath), true)
    }
  } finally { cleanup(f) }
})

test("cleanup never renames a foreign child index and preserves its bytes", () => {
  const f = fixture("ses-clean-target", "clean-target")
  try {
    fs.writeFileSync(f.statePath, JSON.stringify({
      session_id: f.sessionID,
      feature_id: f.featureID,
      session_status: "completed",
      session_completed_at: "2026-01-01T00:00:00.000Z",
    }))
    const indexRoot = path.join(f.root, ".opencode", "plans", ".state", "active-dispatch-children")
    fs.mkdirSync(indexRoot, { recursive: true })
    const child = "ses-foreign-child"
    const foreign = path.join(indexRoot, `${crypto.createHash("sha256").update(child).digest("hex")}.json`)
    const bytes = Buffer.from(JSON.stringify({ parentSessionId: "ses-foreign", childSessionId: child, callId: "call", token: "token" }))
    fs.writeFileSync(foreign, bytes)
    const originalRename = fs.renameSync
    let foreignRenames = 0
    fs.renameSync = function(source, target) {
      if (source === foreign) foreignRenames += 1
      return originalRename.call(fs, source, target)
    }
    try {
      assert.equal(cleanupRetainedCompletedSession(f.root, f.sessionID, { retentionMs: 0, now: Date.parse("2026-01-02T00:00:00Z") }).cleaned, true)
    } finally { fs.renameSync = originalRename }
    assert.equal(foreignRenames, 0)
    assert.deepEqual(fs.readFileSync(foreign), bytes)
  } finally { cleanup(f) }
})

test("cleanup discards claimed old own index but preserves concurrent recreation", () => {
  const f = fixture("ses-own-index", "own-index")
  try {
    fs.writeFileSync(f.statePath, JSON.stringify({
      session_id: f.sessionID,
      feature_id: f.featureID,
      session_status: "completed",
      session_completed_at: "2026-01-01T00:00:00.000Z",
    }))
    const indexRoot = path.join(f.root, ".opencode", "plans", ".state", "active-dispatch-children")
    fs.mkdirSync(indexRoot, { recursive: true })
    const child = "ses-own-child"
    const own = path.join(indexRoot, `${crypto.createHash("sha256").update(child).digest("hex")}.json`)
    fs.writeFileSync(own, JSON.stringify({ parentSessionId: f.sessionID, childSessionId: child, callId: "old-call", token: "old-token" }))
    const replacement = JSON.stringify({ parentSessionId: f.sessionID, childSessionId: child, callId: "new-call", token: "new-token" })
    const originalRename = fs.renameSync
    fs.renameSync = function(source, target) {
      const result = originalRename.call(fs, source, target)
      if (source === own && String(target).endsWith(".retained")) fs.writeFileSync(own, replacement)
      return result
    }
    try {
      assert.equal(cleanupRetainedCompletedSession(f.root, f.sessionID, { retentionMs: 0, now: Date.parse("2026-01-02T00:00:00Z") }).cleaned, true)
    } finally { fs.renameSync = originalRename }
    assert.equal(fs.readFileSync(own, "utf8"), replacement)
  } finally { cleanup(f) }
})

test("session.updated waits for cleanup lifecycle lock and recreates active state", async () => {
  const f = fixture("ses-lifecycle-race", "lifecycle-race")
  let worker
  try {
    fs.writeFileSync(f.statePath, JSON.stringify({
      session_id: f.sessionID,
      feature_id: f.featureID,
      session_status: "completed",
      session_completed_at: "2026-01-01T00:00:00.000Z",
    }))
    const workerResult = new Promise((resolve, reject) => {
      const start = () => {
        const signal = new SharedArrayBuffer(4)
        const view = new Int32Array(signal)
        worker = new Worker(`
          const { parentPort, workerData } = require("node:worker_threads");
          import(workerData.module).then((api) => {
            const view = new Int32Array(workerData.signal);
            Atomics.store(view, 0, 1);
            Atomics.notify(view, 0);
            const result = api.recordSessionCompletion(workerData.root, workerData.sessionID, {
              eventType: "session.updated",
              now: workerData.now,
              lockOptions: { timeoutMs: 10000 },
            });
            parentPort.postMessage(result);
          }).catch((error) => { throw error; });
        `, {
          eval: true,
          workerData: {
            module: new URL("./lib/session-state.mjs", import.meta.url).href,
            root: f.root,
            sessionID: f.sessionID,
            now: Date.parse("2026-01-02T00:00:01.000Z"),
            signal,
          },
        })
        worker.once("message", resolve)
        worker.once("error", reject)
        Atomics.wait(view, 0, 0, 5_000)
        assert.equal(Atomics.load(view, 0), 1)
      }
      const cleaned = cleanupRetainedCompletedSession(f.root, f.sessionID, {
        retentionMs: 0,
        now: Date.parse("2026-01-02T00:00:00.000Z"),
        beforeSessionRename: start,
      })
      assert.equal(cleaned.cleaned, true)
    })
    const result = await workerResult
    assert.equal(result.reopened, true)
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    assert.equal(state.session_id, f.sessionID)
    assert.equal(state.session_status, "active")
    assert.equal(state.session_reopened_at, "2026-01-02T00:00:01.000Z")
  } finally {
    if (worker) await worker.terminate()
    cleanup(f)
  }
})

test("idle mid-run does not start retention", async () => {
  const f = fixture("ses-mid-run", "mid-run-feature")
  try {
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    state.hand_finished = [`${f.featureID}/task-one`]
    state.capture_verified = [`${f.featureID}/task-one@aaa1111`]
    fs.writeFileSync(f.statePath, JSON.stringify(state))
    const hooks = await createReinjectStateHooks(f.root, f.root, {
      isAncestorFn: () => true,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: f.sessionID } } })
    assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).session_completed_at, undefined)
  } finally { cleanup(f) }
})

test("retention sweep never synthesizes completion for terminal-looking state", () => {
  const f = fixture("ses-sweep-only", "sweep-only-feature")
  try {
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    state.hand_finished = [`${f.featureID}/task-one`, `${f.featureID}/task-two`]
    state.capture_verified = [`${f.featureID}/task-one@aaa1111`, `${f.featureID}/task-two@bbb2222`]
    state.regate_passed = [`${f.featureID}/task-two@bbb2222`]
    fs.writeFileSync(f.statePath, JSON.stringify(state))
    const result = sweepRetainedSessions(f.root, { retentionMs: 0, now: Date.now(), isAncestor: () => true })
    assert.deepEqual(result, { ok: true, cleaned: 0 })
    const after = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    assert.equal(after.session_status, undefined)
    assert.equal(after.session_completed_at, undefined)
  } finally { cleanup(f) }
})

test("idle complete starts retention, updated activity reopens, and timer later cleans only owned state", async () => {
  const f = fixture("ses-terminal", "terminal-feature")
  const other = fixture("ses-other-active", "other-feature")
  let clock = Date.parse("2026-07-15T00:00:00.000Z")
  let timerCallback = null
  try {
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    state.capture_verified = [
      `${f.featureID}/task-one@aaa1111`,
      `${f.featureID}/task-two@bbb2222`,
    ]
    state.hand_finished = [
      `${f.featureID}/task-one`,
      `${f.featureID}/task-two`,
    ]
    state.regate_passed = [`${f.featureID}/task-two@bbb2222`]
    fs.writeFileSync(f.statePath, JSON.stringify(state))
    const handRecords = path.join(f.root, ".opencode", "plans", ".state", "hand-records", f.featureID, f.sessionID)
    fs.mkdirSync(handRecords, { recursive: true })
    fs.writeFileSync(path.join(handRecords, "task-one.json"), "{}")
    const childIndexes = path.join(f.root, ".opencode", "plans", ".state", "active-dispatch-children")
    fs.mkdirSync(childIndexes, { recursive: true })
    fs.writeFileSync(path.join(childIndexes, "other.json"), JSON.stringify({ parentSessionId: other.sessionID, childSessionId: "other-child" }))

    const hooks = await createReinjectStateHooks(f.root, f.root, {
      retentionMs: 1_000,
      now: () => clock,
      isAncestorFn: () => true,
      setIntervalFn: (callback) => { timerCallback = callback; return { unref() {} } },
      clearIntervalFn: () => {},
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: f.sessionID } } })
    assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).session_completed_at, new Date(clock).toISOString())
    await hooks.event({ event: { type: "session.updated", properties: { info: { id: f.sessionID } } } })
    assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).session_completed_at, undefined)
    const resumed = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    fs.writeFileSync(f.statePath, JSON.stringify(resumed))
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: f.sessionID } } })
    assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).session_completed_at, new Date(clock).toISOString())
    clock += 1_001
    timerCallback()
    assert.equal(fs.existsSync(path.dirname(f.statePath)), false)
    assert.equal(fs.existsSync(handRecords), false)
    assert.equal(fs.existsSync(path.join(childIndexes, "other.json")), true)
    assert.equal(fs.existsSync(path.join(f.planDir, "execution-plan.json")), true)
    assert.equal(fs.existsSync(other.statePath), true)
  } finally {
    cleanup(f)
    cleanup(other)
  }
})
