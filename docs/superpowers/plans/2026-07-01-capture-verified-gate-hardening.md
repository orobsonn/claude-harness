# Capture-Verified Gate Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two gaps behind the `victor-pipeline-dados-bot` incident — a cheap-hand dispatch whose `hand-finished`/`capture-verified` markers were never stamped is now caught by reading the real, code-written run-record (not just the manually-stamped session array), and a hand-record with a scope/frozen violation can never be waved through by a `capture-verified` stamp.

**Architecture:** No new subsystem. `gate-lib.mjs` gets a per-feature hand-record layout plus two small helpers (`listHandRecordsForFeature`, `markHandRecordCaptured`). `stamp-triage.mjs`'s `capture-verified` handler cross-validates against the real on-disk record before writing anything (closing the forgery hole an earlier draft of this design introduced — see `docs/specs/2026-07-01-capture-verified-gate-hardening.md` § Adversarial review summary). `entry-gate.mjs`'s existing delivery-gate check gets a second, independent condition sourced from that same real file.

**Tech Stack:** Node.js (`node --test`), no external deps — matches every file touched.

## Global Constraints

- Every hook stays fail-open on infra error, fail-closed only in the deliberate gate-decision branch (repo-wide convention, see `entry-gate.mjs`'s own docstring).
- No new dependency. Node builtins only (`node:fs`, `node:path`, `node:child_process`).
- Commit messages: pt-br, Conventional Commits, no `Co-Authored-By` trailer (per this repo's git history and the operator's global git rules).
- TDD: every task's step 1 is a failing test using the file's existing `node --test` runner and existing test-isolation pattern (`withTempDir` in `gate-lib.test.mjs`; `mkdtempSync` + injected seams elsewhere).
- Do not touch the live-dispatch security model (token handling, redaction, `dispatchHand`) — out of scope per the spec.

---

### Task 1: `gate-lib.mjs` — per-feature hand-record layout + list/mark helpers

**Files:**
- Modify: `core/hooks/lib/gate-lib.mjs:118-141` (`handRecordPathFor`, add two new exports after `readHandRecord`)
- Test: `core/hooks/lib/gate-lib.test.mjs:23` (import list), `:46-51` (existing path test), add new tests after `:75`

**Interfaces:**
- Produces: `handRecordPathFor(qualifiedId: string): string` — now returns `.claude/plans/.state/hand-records/<feature_id>/<task_id>.json` (nested; was flat `<feature_id>__<task_id>.json`).
- Produces: `listHandRecordsForFeature(featureId: string): Array<{taskId: string, record: object}>` — reads only that feature's directory, `[]` on missing dir or any fs error.
- Produces: `markHandRecordCaptured(qualifiedId: string, timestampIso: string): boolean` — `false` (no-op) when no record exists on disk for that id; `true` after stamping `capturedVerifiedAt` onto the real file.
- Consumes: nothing new — `readHandRecord` (already in the file) is reused by both new functions.

- [ ] **Step 1: Write the failing tests**

Edit `core/hooks/lib/gate-lib.test.mjs`. First, update the import list:

```javascript
import {
  isSafeFeatureId,
  isSafeSessionId,
  VALID_MODES,
  isDeliveryRole,
  stateDirFor,
  isExpired,
  gateStatePathFor,
  readGateState,
  mergeGateState,
  resetGateState,
  bareRole,
  handRecordPathFor,
  readHandRecord,
  listHandRecordsForFeature,
  markHandRecordCaptured,
} from "./gate-lib.mjs";
```

Replace the existing flat-path test:

```javascript
test("handRecordPathFor maps feature/task qualified id to feature__task.json under hand-records", () => {
  assert.strictEqual(
    handRecordPathFor("my-feature/task-1"),
    path.join(".claude/plans/.state/hand-records", "my-feature__task-1.json")
  );
});
```

with:

```javascript
test("handRecordPathFor nests the record under a per-feature directory: <feature>/<task>.json", () => {
  assert.strictEqual(
    handRecordPathFor("my-feature/task-1"),
    path.join(".claude/plans/.state/hand-records", "my-feature", "task-1.json")
  );
});

test("listHandRecordsForFeature returns [] when the feature directory does not exist", () => {
  withTempDir(() => {
    assert.deepStrictEqual(listHandRecordsForFeature("no-such-feature"), []);
  });
});

test("listHandRecordsForFeature lists every task record under a feature directory", () => {
  withTempDir(() => {
    const p1 = handRecordPathFor("feat-x/task-1");
    const p2 = handRecordPathFor("feat-x/task-2");
    fs.mkdirSync(path.dirname(p1), { recursive: true });
    fs.writeFileSync(p1, JSON.stringify({ outcome: { status: "DONE" } }));
    fs.writeFileSync(p2, JSON.stringify({ outcome: { status: "FAILED" } }));
    const records = listHandRecordsForFeature("feat-x");
    assert.strictEqual(records.length, 2);
    const byTaskId = Object.fromEntries(records.map((r) => [r.taskId, r.record]));
    assert.strictEqual(byTaskId["task-1"].outcome.status, "DONE");
    assert.strictEqual(byTaskId["task-2"].outcome.status, "FAILED");
  });
});

test("listHandRecordsForFeature skips a garbage JSON file instead of throwing", () => {
  withTempDir(() => {
    const p1 = handRecordPathFor("feat-y/task-1");
    fs.mkdirSync(path.dirname(p1), { recursive: true });
    fs.writeFileSync(p1, "{not json");
    assert.deepStrictEqual(listHandRecordsForFeature("feat-y"), []);
  });
});

test("markHandRecordCaptured returns false and writes nothing when no record exists", () => {
  withTempDir(() => {
    assert.strictEqual(markHandRecordCaptured("ghost/task-1", "2026-07-01T00:00:00.000Z"), false);
    assert.strictEqual(fs.existsSync(handRecordPathFor("ghost/task-1")), false);
  });
});

test("markHandRecordCaptured stamps capturedVerifiedAt onto an existing record without losing other fields", () => {
  withTempDir(() => {
    const p = handRecordPathFor("feat-z/task-1");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ outcome: { status: "DONE" } }));
    assert.strictEqual(markHandRecordCaptured("feat-z/task-1", "2026-07-01T00:00:00.000Z"), true);
    const updated = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(updated.capturedVerifiedAt, "2026-07-01T00:00:00.000Z");
    assert.strictEqual(updated.outcome.status, "DONE");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test core/hooks/lib/gate-lib.test.mjs`
Expected: FAIL — `listHandRecordsForFeature`/`markHandRecordCaptured` are not exported (`TypeError`), and the nested-path test fails against the current flat implementation.

- [ ] **Step 3: Implement in `gate-lib.mjs`**

Replace the body of `handRecordPathFor` (currently at `core/hooks/lib/gate-lib.mjs:118-121`):

```javascript
export function handRecordPathFor(qualifiedId) {
  const separatorIndex = String(qualifiedId).indexOf("/");
  const featureId = separatorIndex === -1 ? String(qualifiedId) : qualifiedId.slice(0, separatorIndex);
  const taskId = separatorIndex === -1 ? "" : qualifiedId.slice(separatorIndex + 1);
  return path.join(".claude/plans/.state/hand-records", featureId, `${taskId}.json`);
}
```

Add these two exports directly after `readHandRecord` (after `core/hooks/lib/gate-lib.mjs:141`):

```javascript
/**
 * Lists every on-disk run-record for a feature. Reads the feature's hand-records directory
 * directly (bounded to one feature, never a repo-wide glob) so the delivery gate's real-file
 * cross-check stays cheap regardless of how many features have ever run.
 * Returns [] on a missing directory or any fs error — never throws.
 * @param {string} featureId - The feature_id (unqualified — no task segment)
 * @returns {Array<{taskId: string, record: object}>}
 */
export function listHandRecordsForFeature(featureId) {
  const dir = path.join(".claude/plans/.state/hand-records", String(featureId));
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const taskId = entry.slice(0, -".json".length);
    const record = readHandRecord(`${featureId}/${taskId}`);
    if (record !== null) {
      results.push({ taskId, record });
    }
  }
  return results;
}

/**
 * Stamps `capturedVerifiedAt` onto the real on-disk run-record for a qualified task id.
 * No-op (returns false, writes nothing) when the record does not exist — this is the
 * anti-forgery guard: a marker for a dispatch that never happened has no file to stamp.
 * Never throws. Atomic write (temp -> rename), mirrors mergeGateState's strategy.
 * @param {string} qualifiedId - `${feature_id}/${task_id}`
 * @param {string} timestampIso - ISO-8601 timestamp string
 * @returns {boolean} true on success, false when the record is missing or the write fails
 */
export function markHandRecordCaptured(qualifiedId, timestampIso) {
  const record = readHandRecord(qualifiedId);
  if (record === null) {
    return false;
  }
  try {
    const merged = { ...record, capturedVerifiedAt: timestampIso };
    const targetPath = handRecordPathFor(qualifiedId);
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test core/hooks/lib/gate-lib.test.mjs`
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 5: Commit**

```bash
git add core/hooks/lib/gate-lib.mjs core/hooks/lib/gate-lib.test.mjs
git commit -m "$(cat <<'EOF'
fix(hooks): organiza hand-records por feature e prepara captura real

handRecordPathFor passa a aninhar em <feature>/<task>.json (era um
diretório raso crescendo sem limite). Novos helpers
listHandRecordsForFeature e markHandRecordCaptured são a base do gate
que lê o registro permanente em vez do carimbo manual.
EOF
)"
```

---

### Task 2: `spawn-hand.mjs` — write into the nested per-feature layout

**Files:**
- Modify: `core/skills/orchestrating-delivery/references/spawn-hand.mjs:514-517`
- Test: `core/skills/orchestrating-delivery/references/live-dispatch.test.mjs:128-133`

**Interfaces:**
- Consumes: nothing new (no import added — see rationale below).
- Produces: `runLiveDispatch`'s written record now lives at `<baseDir>/<feature_id>/<task_id>.json` instead of `<baseDir>/<feature_id>__<task_id>.json`. `baseDir` itself is unchanged (`stateDir` override still works exactly as today — this task does not touch that seam).

**Rationale for NOT importing `handRecordPathFor` from `gate-lib.mjs` here:** `runLiveDispatch` supports an optional `stateDir` override (test seam) that `handRecordPathFor` has no equivalent for (it always resolves relative to `process.cwd()`). Importing it would silently drop that override. Inlining the same nested convention keeps the change to one line and preserves every existing capability.

- [ ] **Step 1: Extend the existing failing-path assertion**

In `core/skills/orchestrating-delivery/references/live-dispatch.test.mjs`, replace:

```javascript
      // A run-record was written, keyed by feature_id/task_id, and carries the outcome.
      assert.ok(writtenRecord, "a run-record must be written to disk");
      assert.ok(
        writtenRecord.path.includes("cheap-hands-wiring") && writtenRecord.path.includes("task-1"),
        "the run-record path must be keyed by feature_id + task_id"
      );
```

with:

```javascript
      // A run-record was written, nested under a per-feature directory.
      assert.ok(writtenRecord, "a run-record must be written to disk");
      assert.ok(
        writtenRecord.path.endsWith(join("cheap-hands-wiring", "task-1.json")),
        "the run-record path must nest under <feature_id>/<task_id>.json"
      );
```

(`join` is already imported at the top of this test file — `import { join, dirname } from "node:path";`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test core/skills/orchestrating-delivery/references/live-dispatch.test.mjs`
Expected: FAIL — `writtenRecord.path` currently ends with `cheap-hands-wiring__task-1.json`, not `cheap-hands-wiring/task-1.json`.

- [ ] **Step 3: Implement in `spawn-hand.mjs`**

Replace (currently `core/skills/orchestrating-delivery/references/spawn-hand.mjs:515-516`):

```javascript
    const baseDir = stateDir ?? join(process.cwd(), ".claude", "plans", ".state", "hand-records");
    const recordPath = join(baseDir, `${descriptor.feature_id}__${descriptor.task_id}.json`);
```

with:

```javascript
    const baseDir = stateDir ?? join(process.cwd(), ".claude", "plans", ".state", "hand-records");
    const recordPath = join(baseDir, descriptor.feature_id, `${descriptor.task_id}.json`);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test core/skills/orchestrating-delivery/references/live-dispatch.test.mjs`
Expected: PASS.

Also run the full existing suite for this file's siblings to catch any other hardcoded flat-path assertion:

Run: `node --test core/skills/orchestrating-delivery/references/spawn-hand.test.mjs core/skills/orchestrating-delivery/references/capture-hand.test.mjs`
Expected: PASS (these files exercise `runLiveDispatch`'s neighbors, not the record path itself, but must not regress).

- [ ] **Step 5: Commit**

```bash
git add core/skills/orchestrating-delivery/references/spawn-hand.mjs core/skills/orchestrating-delivery/references/live-dispatch.test.mjs
git commit -m "$(cat <<'EOF'
fix(hooks): spawn-hand.mjs grava o run-record no layout aninhado

Acompanha a reorganização de gate-lib.mjs — mesmo <feature>/<task>.json,
sem depender de importar handRecordPathFor (preserva o override de
stateDir usado em teste).
EOF
)"
```

---

### Task 3: `stamp-triage.mjs` — cross-validate `capture-verified` against the real record

**Files:**
- Modify: `core/hooks/stamp-triage.mjs:38-46` (imports), `:496-510` (`capture-verified` handler)
- Test: `core/hooks/stamp-triage.test.mjs` (add tests near the existing capture-verified tests — search the file for `"capture-verified"` to find them)

**Interfaces:**
- Consumes: `readHandRecord`, `markHandRecordCaptured` from `./lib/gate-lib.mjs` (Task 1).
- Produces: no new exports — behavior change only. A `capture-verified` marker for a qualified id with NO real on-disk hand-record is now a complete no-op (today it already requires `hand_finished` to contain the id first; this adds a second, independent real-file requirement). A qualified id WITH a real record gets `capturedVerifiedAt` stamped onto that permanent file, in addition to today's `gate-state.json` array append.

- [ ] **Step 1: Write the failing tests**

First, find the existing capture-verified test block to match its style:

Run: `grep -n "capture-verified" core/hooks/stamp-triage.test.mjs`

Add these tests to `core/hooks/stamp-triage.test.mjs` near the other `capture-verified` tests (same `withTempDir`/fixture style already used in that file for `hand-finished`/`capture-verified`). Import `handRecordPathFor` alongside whatever `gate-lib.mjs` exports the file already imports for its own setup:

```javascript
test("capture-verified is a no-op when no real hand-record exists on disk (forgery guard)", () => {
  withTempDir(() => {
    const sessionId = "ses_capture_forge";
    mergeGateState(sessionId, { hand_finished: ["feat-a/task-1"] });
    const payload = {
      session_id: sessionId,
      tool_input: { command: "node .claude/hooks/mark.mjs capture-verified --feature-id feat-a --task-id task-1" },
      tool_response: JSON.stringify({ marker: "capture-verified", feature_id: "feat-a", task_id: "task-1" }),
    };
    handle(payload);
    const state = readGateState(sessionId);
    assert.ok(
      !Array.isArray(state.capture_verified) || !state.capture_verified.includes("feat-a/task-1"),
      "capture_verified must NOT be stamped without a real on-disk hand-record"
    );
  });
});

test("capture-verified stamps capturedVerifiedAt onto the real hand-record when one exists", () => {
  withTempDir(() => {
    const sessionId = "ses_capture_real";
    mergeGateState(sessionId, { hand_finished: ["feat-b/task-1"] });
    const recordPath = handRecordPathFor("feat-b/task-1");
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify({ outcome: { status: "DONE" } }));
    const payload = {
      session_id: sessionId,
      tool_input: { command: "node .claude/hooks/mark.mjs capture-verified --feature-id feat-b --task-id task-1" },
      tool_response: JSON.stringify({ marker: "capture-verified", feature_id: "feat-b", task_id: "task-1" }),
    };
    handle(payload);
    const state = readGateState(sessionId);
    assert.ok(state.capture_verified?.includes("feat-b/task-1"), "capture_verified must be stamped in gate-state.json (existing behavior)");
    const updatedRecord = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.ok(typeof updatedRecord.capturedVerifiedAt === "string" && updatedRecord.capturedVerifiedAt.length > 0, "the real hand-record must carry capturedVerifiedAt");
  });
});
```

If `fs`, `path`, or `handRecordPathFor` aren't already imported in `stamp-triage.test.mjs`, add them to its import block (match the existing import style used for `mergeGateState`/`readGateState`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test core/hooks/stamp-triage.test.mjs`
Expected: FAIL — today's handler stamps `capture_verified` in `gate-state.json` unconditionally (once `hand_finished` contains the id), regardless of whether a real hand-record exists, so the first new test fails; the second fails because `capturedVerifiedAt` is never written.

- [ ] **Step 3: Implement in `stamp-triage.mjs`**

Update the import block (currently `core/hooks/stamp-triage.mjs:38-46`):

```javascript
import {
  isSafeFeatureId,
  isSafeSessionId,
  VALID_MODES,
  stateDirFor,
  readGateState,
  mergeGateState,
  resetGateState,
  readHandRecord,
  markHandRecordCaptured,
} from "./lib/gate-lib.mjs";
```

Replace the `capture-verified` handler (currently `core/hooks/stamp-triage.mjs:496-510`):

```javascript
  if (decision.action === "capture-verified") {
    // A capture-verified only counts once the hand actually finished: only append when the task is
    // currently in hand_finished. A capture-verified for a never-finished hand is a no-op — it must
    // never pre-authorize a future (or forged) capture that hasn't run (mirrors the regate-passed guard).
    const current = readGateState(decision.session_id);
    const finished = Array.isArray(current.hand_finished) ? current.hand_finished : [];
    if (!finished.includes(decision.task_id)) {
      return;
    }
    // Second, independent guard: a real on-disk run-record must exist for this qualified id.
    // hand_finished is a manually-stamped array (prose-driven, proven skippable); the run-record
    // is written unconditionally by spawn-hand.mjs's runLiveDispatch, so requiring BOTH means a
    // forged marker with no genuine dispatch behind it stamps nothing anywhere, ever.
    if (readHandRecord(decision.task_id) === null) {
      return;
    }
    const existing = Array.isArray(current.capture_verified) ? current.capture_verified : [];
    if (!existing.includes(decision.task_id)) {
      mergeGateState(decision.session_id, { capture_verified: [...existing, decision.task_id] });
    }
    // Stamp the permanent record too — gate-state.json is session-scoped and does not survive a
    // session restart/compaction; the hand-record does, closing that asymmetry.
    markHandRecordCaptured(decision.task_id, new Date().toISOString());
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test core/hooks/stamp-triage.test.mjs`
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add core/hooks/stamp-triage.mjs core/hooks/stamp-triage.test.mjs
git commit -m "$(cat <<'EOF'
fix(hooks): capture-verified exige o run-record real, não só o carimbo

Um mark.mjs capture-verified forjado (sem dispatch real por trás) agora
não escreve nada em lugar nenhum — precisa do arquivo real gravado por
spawn-hand.mjs, não só do array hand_finished manualmente carimbado.
EOF
)"
```

---

### Task 4: `entry-gate.mjs` — delivery gate reads the real record; scope violations hard-stop

**Files:**
- Modify: `core/hooks/entry-gate.mjs:41-49` (imports), `:339` (`decideBash` signature — 2 new deps), `:429-446` (freeze-commit early trigger, inside the non-delivery-command branch), `:523-543` (the existing capture-rail check), `:566-596` (`decide()`'s deps + Bash dispatch), plus two new internal helpers near `defaultHeadSha` (`:74-89`): `defaultIsAncestor` and `checkRealFileCaptureRail`
- Test: `core/hooks/entry-gate.test.mjs` (add tests near the existing `hand_finished`/`capture_verified` delivery-gate tests — search for `"unmatchedCapture"` or `"hand-finished without capture-verified"` to find them)

**Interfaces:**
- Consumes: `listHandRecordsForFeature`, `readHandRecord` (already imported) from `./lib/gate-lib.mjs` (Task 1).
- Produces: no new exports from `entry-gate.mjs` itself besides the internal `defaultIsAncestor`/`checkRealFileCaptureRail` (not exported — mirrors `defaultHeadSha`'s internal-only scope). `decideBash` gains 2 new injectable deps: `isAncestorFn`, `listHandRecordsForFeatureFn`.

**Design recap (from the spec):** the existing `hand_finished`/`capture_verified` array-diff stays (cheap, correct when the markers exist). A second, independent check (`checkRealFileCaptureRail`, shared by both call sites below) reads `listHandRecordsForFeature(gateState.feature_id)`; for each record whose `freezeCommitSha` is an ancestor-or-equal of current HEAD:
- non-empty `scopeViolations`/`frozenViolations` → deny with a distinct hard-stop message, regardless of `capturedVerifiedAt`.
- else `outcome.status === "DONE"` and no `capturedVerifiedAt` → deny with a message naming the exact task.

Two call sites use this same check (spec AC-2 and AC-4): the mandatory delivery-command gate (`git push`/`gh pr create`/`gh pr merge`), and a best-effort early trigger on a freeze-commit (`git commit` whose message matches `test(<scope>): freeze locked tests for <task-id>`) — catching the gap one task sooner when the commit message happens to match the convention, without gating every ordinary commit.

- [ ] **Step 1: Write the failing tests**

Run first: `grep -n "hand_finished\|capture_verified\|unmatchedCapture" core/hooks/entry-gate.test.mjs` to locate the existing delivery-gate capture-rail tests and match their fixture style (they build a `payload` with `tool_name: "Bash"`, `tool_input: { command: "git push" }`, a `session_id`, and inject `readGateStateFn`/`gitStateFn`).

Add these tests near them:

```javascript
test("decideBash denies push when a real DONE hand-record has no capturedVerifiedAt (hand_finished was never stamped)", () => {
  const payload = {
    tool_name: "Bash",
    session_id: "ses_realfile_1",
    tool_input: { command: "git push" },
  };
  const result = decide(payload, {
    // gate-state has NO hand_finished/capture_verified at all — simulating the incident where
    // the manual marker was skipped entirely.
    readGateStateFn: () => ({ feature_id: "feat-real" }),
    gitStateFn: () => null,
    isHeadlessFn: () => false,
    headShaFn: () => "deadbeef",
    // The record's freezeCommitSha equals HEAD → it IS an ancestor (a commit is its own ancestor).
    isAncestorFn: (sha) => sha === "deadbeef",
    listHandRecordsForFeatureFn: (featureId) => {
      assert.equal(featureId, "feat-real");
      return [{
        taskId: "task-1",
        record: {
          freezeCommitSha: "deadbeef",
          outcome: { status: "DONE", scopeViolations: [], frozenViolations: [] },
        },
      }];
    },
  });
  assert.equal(result.allow, false);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /task-1/);
});

test("decideBash allows push when the real hand-record already carries capturedVerifiedAt", () => {
  const payload = {
    tool_name: "Bash",
    session_id: "ses_realfile_2",
    tool_input: { command: "git push" },
  };
  const result = decide(payload, {
    readGateStateFn: () => ({ feature_id: "feat-real" }),
    gitStateFn: () => null,
    isHeadlessFn: () => false,
    headShaFn: () => "deadbeef",
    isAncestorFn: () => true,
    listHandRecordsForFeatureFn: () => [{
      taskId: "task-1",
      record: {
        freezeCommitSha: "deadbeef",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        outcome: { status: "DONE", scopeViolations: [], frozenViolations: [] },
      },
    }],
  });
  assert.equal(result.allow, true);
});

test("decideBash denies push with a distinct hard-stop message when a hand-record has a scope violation, even if capturedVerifiedAt is set", () => {
  const payload = {
    tool_name: "Bash",
    session_id: "ses_realfile_3",
    tool_input: { command: "git push" },
  };
  const result = decide(payload, {
    readGateStateFn: () => ({ feature_id: "feat-real" }),
    gitStateFn: () => null,
    isHeadlessFn: () => false,
    headShaFn: () => "deadbeef",
    isAncestorFn: () => true,
    listHandRecordsForFeatureFn: () => [{
      taskId: "task-1",
      record: {
        freezeCommitSha: "deadbeef",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        outcome: { status: "FAILED", scopeViolations: ["src/out-of-scope.ts"], frozenViolations: [] },
      },
    }],
  });
  assert.equal(result.allow, false);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /scope/i);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /task-1/);
});

test("decideBash ignores a hand-record whose freezeCommitSha is not an ancestor of HEAD (abandoned/unrelated branch)", () => {
  const payload = {
    tool_name: "Bash",
    session_id: "ses_realfile_4",
    tool_input: { command: "git push" },
  };
  const result = decide(payload, {
    readGateStateFn: () => ({ feature_id: "feat-real" }),
    gitStateFn: () => null,
    isHeadlessFn: () => false,
    headShaFn: () => "deadbeef",
    isAncestorFn: () => false,
    listHandRecordsForFeatureFn: () => [{
      taskId: "task-1",
      record: { freezeCommitSha: "stale-sha", outcome: { status: "DONE", scopeViolations: [], frozenViolations: [] } },
    }],
  });
  assert.equal(result.allow, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test core/hooks/entry-gate.test.mjs`
Expected: FAIL — `isAncestorFn`/`listHandRecordsForFeatureFn` are not consumed yet (and the freeze-commit trigger doesn't exist yet), so all 6 new tests get the current (wrong) allow/deny result.

- [ ] **Step 3: Implement in `entry-gate.mjs`**

Update the import block (currently `core/hooks/entry-gate.mjs:41-49`):

```javascript
import {
  isDeliveryRole,
  bareRole,
  isSafeSessionId,
  stateDirFor,
  readGateState,
  mergeGateState,
  readHandRecord,
  listHandRecordsForFeature,
} from "./lib/gate-lib.mjs";
```

Add a new helper right after `defaultHeadSha` (currently ending at `core/hooks/entry-gate.mjs:89`):

```javascript
/**
 * @description Best-effort ancestor probe for scoping the real-file capture check to the
 * current branch's lineage. Returns true when `sha` is an ancestor of (or equal to) HEAD,
 * false when git POSITIVELY determines it is not (exit 1 — the definitive, safe-to-deny
 * signal), or null on any other error (bad sha, git failure) so the caller fails OPEN
 * (skips that record rather than denying on an undetermined answer).
 * @param {string} sha
 * @returns {boolean|null}
 */
function defaultIsAncestor(sha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (err) {
    if (err?.status === 1) return false;
    return null;
  }
}

/**
 * @description Runs the real-file capture rail for one feature: lists every hand-record via
 * listHandRecordsForFeatureFn, scopes to records whose freezeCommitSha is an ancestor of (or
 * equal to) HEAD, and returns a deny result for the first violation found — a scope/frozen
 * violation (hard-stop regardless of capturedVerifiedAt), or a DONE outcome with no
 * capturedVerifiedAt. Returns null when nothing blocks. Shared by both call sites (the
 * mandatory delivery-command gate and the best-effort freeze-commit early trigger) so the two
 * can never drift out of sync on what counts as "unresolved".
 * @param {string} featureId
 * @param {{ listHandRecordsForFeatureFn: function, isAncestorFn: function }} deps
 * @returns {null | { allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
function checkRealFileCaptureRail(featureId, { listHandRecordsForFeatureFn, isAncestorFn }) {
  let records = [];
  try {
    records = listHandRecordsForFeatureFn(featureId);
  } catch {
    records = [];
  }
  for (const { taskId, record } of records) {
    if (!record || typeof record !== "object") continue;
    const sha = record.freezeCommitSha;
    if (typeof sha !== "string" || sha.length === 0) continue;
    let ancestor = null;
    try {
      ancestor = isAncestorFn(sha);
    } catch {
      ancestor = null;
    }
    if (ancestor !== true) continue; // undetermined or not-an-ancestor → skip (fail open on this record)
    const outcome = record.outcome ?? {};
    const scopeViolations = Array.isArray(outcome.scopeViolations) ? outcome.scopeViolations : [];
    const frozenViolations = Array.isArray(outcome.frozenViolations) ? outcome.frozenViolations : [];
    if (scopeViolations.length > 0 || frozenViolations.length > 0) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `[entry-gate] Blocked: the independent capture for ${featureId}/${taskId} found a ` +
            `SCOPE/FROZEN-MANIFEST violation (${[...scopeViolations, ...frozenViolations].join(", ")}). ` +
            "This requires a human decision, not a re-run or a capture-verified stamp — resolve " +
            "the out-of-scope write (revert it or fold it into scope_paths deliberately) before proceeding.",
        },
      };
    }
    if (outcome.status === "DONE" && typeof record.capturedVerifiedAt !== "string") {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `[entry-gate] Blocked: the on-disk run-record for ${featureId}/${taskId} shows a ` +
            "completed dispatch with no independent capture stamped on it yet " +
            "(capturedVerifiedAt missing), regardless of what hand_finished/capture_verified show. " +
            "Run capture-hand.mjs and stamp capture-verified before proceeding.",
        },
      };
    }
  }
  return null;
}
```

Replace the existing capture-rail block (currently `core/hooks/entry-gate.mjs:523-543`):

```javascript
  // Capture rail — independent of the re-gate rail. A finished cheap-hand (hand_finished)
  // whose output has not been independently captured/verified (no matching capture_verified)
  // blocks delivery. Same qualified ${feature_id}/${task_id} shape and array-diff style.
  const handFinished = Array.isArray(gateState.hand_finished) ? gateState.hand_finished : [];
  const captureVerified = Array.isArray(gateState.capture_verified) ? gateState.capture_verified : [];
  const unmatchedCapture = handFinished.filter((t) => !captureVerified.includes(t));
  if (unmatchedCapture.length > 0) {
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[entry-gate] Blocked: delivery command denied — finished cheap-hand task(s) " +
          `${unmatchedCapture.join(", ")} still await independent capture/verification ` +
          "(hand-finished without capture-verified). Independently capture the hand output and " +
          "stamp capture-verified before running any delivery command " +
          "(git push / gh pr create / gh pr merge).",
      },
    };
  }
  // Real-file capture rail — independent of hand_finished/capture_verified (a session-scoped,
  // manually-stamped pair that a prior incident showed can be skipped for EVERY dispatch in a
  // run, leaving the array-diff above with nothing to compare). This reads the run-record
  // spawn-hand.mjs writes unconditionally on every dispatch, scoped to the current feature and
  // to records whose freeze commit is still part of this branch's history (never a stale
  // abandoned/already-shipped feature's leftovers).
  const featureId = typeof gateState.feature_id === "string" ? gateState.feature_id : null;
  if (featureId !== null) {
    const realFileDeny = checkRealFileCaptureRail(featureId, { listHandRecordsForFeatureFn, isAncestorFn });
    if (realFileDeny !== null) {
      return {
        allow: false,
        hookSpecificOutput: {
          ...realFileDeny.hookSpecificOutput,
          permissionDecisionReason:
            `${realFileDeny.hookSpecificOutput.permissionDecisionReason} ` +
            "(git push / gh pr create / gh pr merge).",
        },
      };
    }
  }
```

Update `decideBash`'s signature to accept the two new deps (currently `core/hooks/entry-gate.mjs:339`):

```javascript
function decideBash(payload, { readGateStateFn, gitStateFn, readDescriptorFn, adviseIssueFormFn, isAncestorFn, listHandRecordsForFeatureFn }) {
```

Now add the freeze-commit best-effort early trigger (spec AC-4) inside the **non-delivery-command** branch — insert it right at the top of the existing `if (!isDeliveryCommand(command)) { ... }` block (currently `core/hooks/entry-gate.mjs:435-446`), before the issue-form advisory logic:

```javascript
  if (!isDeliveryCommand(command)) {
    // Best-effort early trigger (spec AC-4): a freeze-commit for the NEXT task is a natural,
    // low-frequency checkpoint to catch an unresolved capture ONE task sooner than the mandatory
    // delivery gate above. String-matched on the commit-message convention from
    // orchestrating-delivery/SKILL.md step 1c-commit ("test(<scope>): freeze locked tests for
    // <task-id>") — advisory only. The delivery-command branch above (git push / gh pr create /
    // gh pr merge) remains the single MANDATORY enforcement point regardless of whether this
    // trigger fires; a commit message that doesn't match this convention simply skips it.
    if (/\bgit\s+commit\b/.test(command) && /freeze locked tests for/i.test(command)) {
      const freezeSessionId = payload.session_id;
      if (typeof freezeSessionId === "string" && freezeSessionId.length > 0 && isSafeSessionId(freezeSessionId)) {
        let freezeGateState = {};
        try {
          freezeGateState = readGateStateFn(freezeSessionId);
        } catch {
          freezeGateState = {};
        }
        const freezeFeatureId = typeof freezeGateState.feature_id === "string" ? freezeGateState.feature_id : null;
        if (freezeFeatureId !== null) {
          const earlyDeny = checkRealFileCaptureRail(freezeFeatureId, { listHandRecordsForFeatureFn, isAncestorFn });
          if (earlyDeny !== null) {
            return earlyDeny;
          }
        }
      }
    }
    const advisory = typeof adviseIssueFormFn === "function"
      ? adviseIssueFormFn(command, payload.cwd)
      : null;
    if (advisory) {
      return {
        allow: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: advisory },
      };
    }
    return { allow: true };
  }
```

(This replaces the existing `if (!isDeliveryCommand(command)) { ... }` block in full — the advisory logic inside is unchanged, only the new freeze-commit check is prepended.)

Finally, update `decide()` to default and forward the two new deps (currently `core/hooks/entry-gate.mjs:566-596`) — add to the destructured defaults:

```javascript
    readHandRecordFn = readHandRecord,
    headShaFn = defaultHeadSha,
    isAncestorFn = defaultIsAncestor,
    listHandRecordsForFeatureFn = listHandRecordsForFeature,
```

and forward them in the `decideBash` call:

```javascript
  if (payload.tool_name === "Bash") {
    return decideBash(payload, { readGateStateFn, gitStateFn, readDescriptorFn, adviseIssueFormFn, isAncestorFn, listHandRecordsForFeatureFn });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test core/hooks/entry-gate.test.mjs`
Expected: PASS, all 6 new tests (4 delivery-gate + 2 freeze-commit-trigger). Pay attention to any PRE-EXISTING test that calls `decide()`/`decideBash` with a `git push`/`gh pr create`/`gh pr merge` command (or ANY `git commit`) and a `gateState` carrying a `feature_id` but no `isAncestorFn`/`listHandRecordsForFeatureFn` override — the new defaults (`defaultIsAncestor`, `listHandRecordsForFeature`) will run for real in that case. If any such test fails because it now hits the filesystem/git, add `isAncestorFn: () => false` (or omit `feature_id` from that test's `gateState`) to keep it hermetic, matching how the file already isolates `gitStateFn`.

- [ ] **Step 5: Commit**

```bash
git add core/hooks/entry-gate.mjs core/hooks/entry-gate.test.mjs
git commit -m "$(cat <<'EOF'
fix(hooks): gate de entrega lê o run-record real, não só o carimbo

Fecha o buraco do incidente: mesmo se hand-finished nunca for
carimbado (o carimbo manual provou falhar 4 de 5 vezes numa run real),
o registro permanente gravado por spawn-hand.mjs ainda é lido e barra
a entrega. Violação de escopo/manifesto vira bloqueio explícito, nunca
satisfeito só por um carimbo capture-verified.
EOF
)"
```

---

### Task 5: `core/skills/orchestrating-delivery/SKILL.md` — align the docs

**Files:**
- Modify: `core/skills/orchestrating-delivery/SKILL.md` (the "Capture-verified marker (Trilho 4)" paragraph inside step 4 "gates", around the text `**ONLY after** capture-hand reports captured: true`)

**Interfaces:** none (docs only).

- [ ] **Step 1: Locate the exact text to update**

Run: `grep -n "Capture-verified marker" core/skills/orchestrating-delivery/SKILL.md`

- [ ] **Step 2: Append a clarifying sentence**

Using `Edit`, find this exact sentence inside step 4's paragraph:

```
(This `capture-verified` marker is implemented by a later task; this is the prose that instructs its use.)
```

and change it to:

```
(This `capture-verified` marker is implemented by a later task; this is the prose that instructs its use.) **The marker alone is not authoritative** — the entry-gate's delivery-bash-gate cross-checks the qualified id against the real on-disk run-record `spawn-hand.mjs` wrote (`.claude/plans/.state/hand-records/<feature_id>/<task_id>.json`), not only the `hand_finished`/`capture_verified` arrays in `gate-state.json`. A dispatch whose `hand-finished`/`capture-verified` markers were never stamped at all is still caught, because the run-record's mere existence is unconditional (written by code, not by the orchestrator remembering a CLI call). A record carrying a scope or frozen-manifest violation is a hard delivery block that no `capture-verified` stamp can clear.
```

- [ ] **Step 3: No test to run (docs-only change) — verify by reading the diff**

Run: `git diff core/skills/orchestrating-delivery/SKILL.md`
Expected: the single sentence insertion above, nothing else changed.

- [ ] **Step 4: Commit**

```bash
git add core/skills/orchestrating-delivery/SKILL.md
git commit -m "$(cat <<'EOF'
docs: documenta que capture-verified é cruzado com o run-record real

Alinha o SKILL.md com o comportamento novo do entry-gate/stamp-triage
(fix anterior desta série) — o carimbo manual deixou de ser a única
fonte de verdade que a entrega confia.
EOF
)"
```

---

### Task 6: Review pass + PR

**Files:** none new — this task reviews the accumulated diff from Tasks 1-5.

- [ ] **Step 1: Run the full test suite**

Run: `node --test core/hooks/lib/gate-lib.test.mjs core/hooks/entry-gate.test.mjs core/hooks/stamp-triage.test.mjs core/hooks/mark.test.mjs core/skills/orchestrating-delivery/references/live-dispatch.test.mjs core/skills/orchestrating-delivery/references/spawn-hand.test.mjs core/skills/orchestrating-delivery/references/capture-hand.test.mjs`
Expected: PASS across the board. `mark.mjs` is included because it's the CLI whose stdout `stamp-triage.mjs` parses — unaffected by this series, but a cheap regression check given it sits on the same rail.

- [ ] **Step 2: Dispatch review subagents against the full diff**

This repo is the harness's own source and is not self-vendored (no `.claude/skills/` here), so there is no `compliance`/`adversary`/`security` agent to dispatch as a vendored skill — reproduce the same independent-review discipline directly with the `Agent` tool, one dispatch per lens, all against `git diff main...HEAD` (or the equivalent range for this branch):

- **compliance-equivalent** (general-purpose agent): "Read `docs/specs/2026-07-01-capture-verified-gate-hardening.md`'s Acceptance Criteria section and the diff on this branch. For each `#ac-N`, cite the exact file:line that satisfies it, or flag it as unmet. Do not comment on style — only AC coverage."
- **adversary-equivalent** (general-purpose agent, virgin — do not hand it the spec's own "Adversarial review summary" section, only the Problem/Design sections and the diff): "Attack this diff for the same class of issue the incident was about: self-certification / forgeable audit trails. Can any Bash command, malformed record, or race condition make `capturedVerifiedAt` appear on a record without a genuine `spawn-hand.mjs` dispatch behind it? Can a scope-violated record still ship?"
- **security-equivalent** (general-purpose agent): "Review the diff in `core/hooks/entry-gate.mjs`, `core/hooks/stamp-triage.mjs`, `core/hooks/lib/gate-lib.mjs` for path-traversal via `featureId`/`taskId` (e.g. a feature_id containing `../`), and for any new fail-open branch that should be fail-closed."

Resolve any finding before proceeding — either fix inline (new commit, same conventions as Tasks 1-4) or, if a finding is a deliberate accepted trade-off already covered by the spec, note it in the PR body instead of the code.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin docs/capture-verified-gate-hardening-spec
gh pr create --title "fix: endurece o gate capture-verified com o run-record real" --body "$(cat <<'EOF'
## Summary
- Fecha o gap do incidente real (victor-pipeline-dados-bot, m4-fup-pipeline): o gate de entrega agora lê o run-record permanente gravado por `spawn-hand.mjs`, não só o carimbo manual `hand_finished`/`capture_verified` — pega mesmo quando o carimbo nunca foi feito.
- Violação de escopo/manifesto congelado vira bloqueio explícito, nunca satisfeito por um `capture-verified` stamp.
- `capture-verified` forjado (sem dispatch real) agora não escreve nada em lugar nenhum — cross-valida contra o arquivo real antes.
- Reorganiza `.claude/plans/.state/hand-records/` por feature (era um diretório raso crescendo sem limite).

Ver `docs/specs/2026-07-01-capture-verified-gate-hardening.md` para o design completo, incluindo a revisão adversarial que rejeitou a primeira versão (auto-carimbo via parsing de stdout — forjável).

## Test plan
- [ ] `node --test core/hooks/lib/gate-lib.test.mjs`
- [ ] `node --test core/hooks/entry-gate.test.mjs`
- [ ] `node --test core/hooks/stamp-triage.test.mjs`
- [ ] `node --test core/skills/orchestrating-delivery/references/live-dispatch.test.mjs core/skills/orchestrating-delivery/references/spawn-hand.test.mjs core/skills/orchestrating-delivery/references/capture-hand.test.mjs`
- [ ] Revisão manual do diff (compliance/adversary/security equivalentes, dispatchados via Agent tool nesta sessão)
EOF
)"
```

- [ ] **Step 4: Report the PR URL to the operator**

Relay the URL `gh pr create` prints — do not merge; per this repo's own git rules, merge happens on operator authorization.
