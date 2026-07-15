/**
 * @description Pins the dual-eye nudge extension to `createObsEyeHooks`
 * (core/opencode/plugin/obs-eye.ts, `tool.execute.after`) and its companion pure library
 * `core/opencode/plugin/lib/dual-nudge.mjs` — neither exists yet at authoring time; every
 * assertion below fixes the CONTRACT the extension must satisfy and is expected to fail
 * (RED) until the executor implements it.
 *
 * DESIGN NOTE (informs the expected `dual-nudge.mjs` contract):
 * Tests 9, 11 and 12 exercise failure/race paths of `withGateStateLock` that are
 * impractical to force deterministically through the real, already fail-safe
 * `core/opencode/plugin/lib/gate-state.mjs` (every internal failure there is already
 * caught and returned as `{ ok: false, decision: "deny", reason }` — it is designed to
 * never throw). To pin those paths precisely, this suite assumes `dual-nudge.mjs` exports
 * a pure, directly-testable function shaped like the injectable-dependency pattern already
 * used by `core/opencode/plugin/lib/mark-gate.mjs` (e.g. `resolvePath = gateStatePath`,
 * `merge = mergeGateState`):
 *
 *   applyDualNudge({ role, featureId, taskId, phase, crossFamilyEnabled, gateStatePath,
 *     withGateStateLock, now })
 *
 * where `gateStatePath` and `withGateStateLock` are injected as zero/one-arg callables
 * (the caller pre-binds `projectRoot`/`sessionId` into `gateStatePath`, mirroring how
 * `mark-gate.mjs` callers already resolve paths before calling into gate-state helpers).
 * `applyDualNudge` never throws: on success it returns `{ ok: true, state }` (the
 * persisted next gate-state); on any internal failure (seam throws OR seam denies) it
 * returns `{ ok: false, reason }` — the same Result shape used everywhere else in this
 * codebase (`gate-state.mjs`, `path-helpers.mjs`). Tests 1-8, 10 and 13 exercise the real
 * `createObsEyeHooks` hook end-to-end against a real `gate-state.json` on disk; test 12
 * also exercises the real hook, forcing the real (fail-safe, never-throws) deny path via
 * genuine filesystem manipulation (gate-state.json target replaced by a real directory).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createObsEyeHooks } from "./obs-eye.ts";
import { gateStatePath } from "../../shared/lib/path-helpers.mjs";

const SID = "ses_test1";
const FEATURE_ID = "obs-eye-nudge";
const TASK_ID = "task-1";
const PHASE = "plan-review";

/** @param {string} prefix */
function makeProjectRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @param {string} projectRoot
 * @param {string} sessionId
 * @returns {string}
 */
function resolveGateStatePath(projectRoot, sessionId) {
  const r = gateStatePath({ projectRoot, sessionId, runtime: "opencode" });
  assert.ok(r.ok, "gateStatePath must resolve for a valid projectRoot/sessionId fixture");
  return r.path;
}

/**
 * @param {string} projectRoot
 * @param {string} sessionId
 * @param {Record<string, unknown>} state
 */
function writeGateState(projectRoot, sessionId, state) {
  const p = resolveGateStatePath(projectRoot, sessionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state), "utf8");
}

/**
 * @param {string} projectRoot
 * @param {string} sessionId
 * @returns {Record<string, unknown>}
 */
function readGateStateFile(projectRoot, sessionId) {
  const p = resolveGateStatePath(projectRoot, sessionId);
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * @description Build (input, output) for a `task` tool call carrying a
 * subagent_type/feature_id/task_id/phase eye return — same shape resolveHookArgs/
 * extractTaskIds already read (args on output.args, sessionID on input). `phase` is read
 * directly off `args` by the new dual-nudge codepath (extractTaskIds does not surface it).
 */
function makeTaskCall({ role, featureId, taskId, phase, sessionId = SID, responseText = "APPROVE" }) {
  const args = {
    subagent_type: role,
    feature_id: featureId,
    task_id: taskId,
    phase,
  };
  const input = { tool: "task", sessionID: sessionId };
  const output = { args, output: responseText, metadata: {} };
  return { input, output };
}

/** @param {boolean} enabled */
function setCrossFamily(enabled) {
  const prev = process.env.HARNESS_CODEX_ADVERSARY;
  if (enabled) {
    process.env.HARNESS_CODEX_ADVERSARY = "1";
  } else {
    delete process.env.HARNESS_CODEX_ADVERSARY;
  }
  return prev;
}

/** @param {string|undefined} prev */
function restoreCrossFamily(prev) {
  if (prev === undefined) {
    delete process.env.HARNESS_CODEX_ADVERSARY;
  } else {
    process.env.HARNESS_CODEX_ADVERSARY = prev;
  }
}

test("eligible primary eye + cross-family enabled + no prior attempt → dual_status pending and the feature/task/phase tuple is recorded", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-pending-");
  const prevEnv = setCrossFamily(true);
  try {
    const hooks = await createObsEyeHooks(projectRoot);
    const { input, output } = makeTaskCall({ role: "plan-reviewer", featureId: FEATURE_ID, taskId: TASK_ID, phase: PHASE });
    await hooks["tool.execute.after"](input, output);
    const state = readGateStateFile(projectRoot, SID);
    assert.equal(state.dual_status, "pending", "an eligible primary eye with cross-family enabled and no prior attempt must set dual_status to pending");
    assert.ok(Array.isArray(state.dual_nudge_attempts), "dual_nudge_attempts must be an array");
    assert.ok(
      state.dual_nudge_attempts.includes(`${FEATURE_ID}/${TASK_ID}/${PHASE}`),
      "dual_nudge_attempts must contain the feature/task/phase tuple",
    );
  } finally {
    restoreCrossFamily(prevEnv);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("eligible primary eye + cross-family disabled stays pending/skipped until primary accounting, never terminal fail-open", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-failopen-");
  const prevEnv = setCrossFamily(false);
  try {
    const hooks = await createObsEyeHooks(projectRoot);
    const { input, output } = makeTaskCall({ role: "plan-reviewer", featureId: FEATURE_ID, taskId: TASK_ID, phase: PHASE });
    await assert.doesNotReject(() => hooks["tool.execute.after"](input, output));
    const state = readGateStateFile(projectRoot, SID);
    assert.equal(
      state.dual_status,
      "pending",
      "the nudge cannot claim a terminal primary result before report accounting",
    );
    assert.equal(state.dual_secondary_status, "skipped_disabled");
  } finally {
    restoreCrossFamily(prevEnv);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("eligible primary eye + successful gate-state persist → output.metadata.dual_nudge is a non-empty string, injected only after the successful persist", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-metadata-");
  const prevEnv = setCrossFamily(true);
  try {
    const hooks = await createObsEyeHooks(projectRoot);
    const { input, output } = makeTaskCall({ role: "plan-reviewer", featureId: FEATURE_ID, taskId: TASK_ID, phase: PHASE });
    await hooks["tool.execute.after"](input, output);
    assert.equal(typeof output.metadata?.dual_nudge, "string", "output.metadata.dual_nudge must be a string after a successful persist");
    assert.ok(output.metadata.dual_nudge.length > 0, "output.metadata.dual_nudge must be non-empty");
  } finally {
    restoreCrossFamily(prevEnv);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("second distinct phase for the same feature/task/role → both tuple entries recorded in dual_nudge_attempts (no role-only dedupe)", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-2phases-");
  const prevEnv = setCrossFamily(true);
  try {
    const hooks = await createObsEyeHooks(projectRoot);
    const first = makeTaskCall({ role: "plan-reviewer", featureId: FEATURE_ID, taskId: TASK_ID, phase: "plan-review" });
    await hooks["tool.execute.after"](first.input, first.output);
    const second = makeTaskCall({ role: "plan-reviewer", featureId: FEATURE_ID, taskId: TASK_ID, phase: "final-review" });
    await hooks["tool.execute.after"](second.input, second.output);
    const state = readGateStateFile(projectRoot, SID);
    assert.ok(
      state.dual_nudge_attempts.includes(`${FEATURE_ID}/${TASK_ID}/plan-review`),
      "the first phase tuple must be present",
    );
    assert.ok(
      state.dual_nudge_attempts.includes(`${FEATURE_ID}/${TASK_ID}/final-review`),
      "the second, later phase tuple must also be present — not suppressed by a role-only dedupe",
    );
  } finally {
    restoreCrossFamily(prevEnv);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("re-firing an already-recorded tuple with dual_status already 'both' → dual_nudge_attempts unchanged, dual_status not regressed to pending", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-dedupe-");
  const prevEnv = setCrossFamily(false);
  try {
    const tuple = `${FEATURE_ID}/${TASK_ID}/${PHASE}`;
    writeGateState(projectRoot, SID, { dual_status: "both", dual_nudge_attempts: [tuple] });
    const hooks = await createObsEyeHooks(projectRoot);
    const { input, output } = makeTaskCall({ role: "plan-reviewer", featureId: FEATURE_ID, taskId: TASK_ID, phase: PHASE });
    await hooks["tool.execute.after"](input, output);
    const state = readGateStateFile(projectRoot, SID);
    assert.deepEqual(
      state.dual_nudge_attempts,
      [tuple],
      "re-firing an already-recorded tuple must not append a duplicate entry",
    );
    assert.equal(state.dual_status, "both", "dual_status must not be regressed back to pending for an already-recorded tuple");
  } finally {
    restoreCrossFamily(prevEnv);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("global dual_status already 'both' + a brand-new unattempted tuple → dual_status stays 'both', the new tuple is still appended", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-both-");
  try {
    writeGateState(projectRoot, SID, {
      dual_status: "both",
      dual_nudge_attempts: ["other-feature/other-task/plan-review"],
    });
    const hooks = await createObsEyeHooks(projectRoot);
    const { input, output } = makeTaskCall({ role: "plan-reviewer", featureId: FEATURE_ID, taskId: TASK_ID, phase: PHASE });
    await hooks["tool.execute.after"](input, output);
    const state = readGateStateFile(projectRoot, SID);
    assert.equal(state.dual_status, "both", "dual_status must remain 'both' after a new tuple's nudge attempt");
    assert.ok(
      state.dual_nudge_attempts.includes(`${FEATURE_ID}/${TASK_ID}/${PHASE}`),
      "the new tuple must be appended alongside the pre-existing one",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("global dual_status already 'primary_only_error' + a brand-new unattempted tuple → dual_status stays 'primary_only_error', the new tuple is still appended", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-error-");
  try {
    writeGateState(projectRoot, SID, {
      dual_status: "primary_only_error",
      dual_nudge_attempts: ["other-feature/other-task/plan-review"],
    });
    const hooks = await createObsEyeHooks(projectRoot);
    const { input, output } = makeTaskCall({ role: "plan-reviewer", featureId: FEATURE_ID, taskId: TASK_ID, phase: PHASE });
    await hooks["tool.execute.after"](input, output);
    const state = readGateStateFile(projectRoot, SID);
    assert.equal(state.dual_status, "primary_only_error", "dual_status must remain 'primary_only_error' after a new tuple's nudge attempt");
    assert.ok(
      state.dual_nudge_attempts.includes(`${FEATURE_ID}/${TASK_ID}/${PHASE}`),
      "the new tuple must be appended alongside the pre-existing one",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("global dual_status already 'primary_only_failopen' + a brand-new unattempted tuple → dual_status stays 'primary_only_failopen', the new tuple is still appended", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-failopen2-");
  try {
    writeGateState(projectRoot, SID, {
      dual_status: "primary_only_failopen",
      dual_nudge_attempts: ["other-feature/other-task/plan-review"],
    });
    const hooks = await createObsEyeHooks(projectRoot);
    const { input, output } = makeTaskCall({ role: "plan-reviewer", featureId: FEATURE_ID, taskId: TASK_ID, phase: PHASE });
    await hooks["tool.execute.after"](input, output);
    const state = readGateStateFile(projectRoot, SID);
    assert.equal(
      state.dual_status,
      "primary_only_failopen",
      "dual_status must remain 'primary_only_failopen' after a new tuple's nudge attempt",
    );
    assert.ok(
      state.dual_nudge_attempts.includes(`${FEATURE_ID}/${TASK_ID}/${PHASE}`),
      "the new tuple must be appended alongside the pre-existing one",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("[dual-nudge pure] applyDualNudge honors a terminal 'both' state that only becomes visible to the read performed inside the same lock as the write (not a stale outer read)", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-race-");
  try {
    const { applyDualNudge } = await import("./lib/dual-nudge.mjs");
    const gp = gateStatePath({ projectRoot, sessionId: SID, runtime: "opencode" });
    assert.ok(gp.ok, "gateStatePath must resolve for this fixture");
    mkdirSync(dirname(gp.path), { recursive: true });
    // On-disk state is empty (no dual_status yet) — anything reading the file OUTSIDE the
    // lock sees no terminal status. The injected withGateStateLock simulates a concurrent
    // writer that committed dual_status='both' with an existing tuple, visible ONLY to the
    // read performed inside this lock callback.
    writeFileSync(gp.path, JSON.stringify({}), "utf8");

    let lockCalls = 0;
    const fakeWithGateStateLock = (_statePath, fn) => {
      lockCalls += 1;
      const prevUnderLock = {
        dual_status: "both",
        dual_nudge_attempts: ["already/recorded/phase-x"],
      };
      const next = fn(prevUnderLock);
      return { ok: true, state: next };
    };

    let thrown = null;
    let result;
    try {
      result = await applyDualNudge({
        role: "plan-reviewer",
        featureId: FEATURE_ID,
        taskId: TASK_ID,
        phase: PHASE,
        sessionId: SID,
        crossFamilyEnabled: true,
        gateStatePath: () => gp,
        withGateStateLock: fakeWithGateStateLock,
        now: () => "2026-07-12T00:00:00.000Z",
      });
    } catch (err) {
      thrown = err;
    }

    assert.equal(thrown, null, "applyDualNudge must not throw");
    assert.equal(lockCalls, 1, "withGateStateLock must be invoked exactly once");
    assert.ok(result && result.ok === true, "applyDualNudge must report success");
    assert.equal(
      result.state.dual_status,
      "both",
      "the final persisted dual_status must remain 'both' — never clobbered back to 'pending' by a stale outer read",
    );
    assert.ok(
      result.state.dual_nudge_attempts.includes(`${FEATURE_ID}/${TASK_ID}/${PHASE}`),
      "the new tuple must still be appended",
    );
    assert.ok(
      result.state.dual_nudge_attempts.includes("already/recorded/phase-x"),
      "the pre-existing concurrent tuple must survive",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("secondary eye (plan-reviewer-openai) → no dual_status write and no dual_nudge_attempts append (only primary eyes trigger the nudge)", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-secondary-");
  try {
    writeGateState(projectRoot, SID, { mode: "FULL", feature_id: FEATURE_ID });
    const hooks = await createObsEyeHooks(projectRoot);
    const { input, output } = makeTaskCall({ role: "plan-reviewer-openai", featureId: FEATURE_ID, taskId: TASK_ID, phase: PHASE });
    await hooks["tool.execute.after"](input, output);
    const state = readGateStateFile(projectRoot, SID);
    assert.equal(state.dual_status, undefined, "a secondary eye (plan-reviewer-openai) must never write dual_status");
    assert.equal(state.dual_nudge_attempts, undefined, "a secondary eye (plan-reviewer-openai) must never append dual_nudge_attempts");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("canonical family-1 eyes reach the hook and family-2 eyes never trigger the primary nudge", async () => {
  const prevEnv = setCrossFamily(true);
  try {
    for (const role of ["plan-reviewer-family-1", "adversary-family-1"]) {
      const projectRoot = makeProjectRoot("obs-eye-canonical-primary-");
      try {
        const hooks = await createObsEyeHooks(projectRoot);
        const { input, output } = makeTaskCall({
          role,
          featureId: FEATURE_ID,
          taskId: TASK_ID,
          phase: PHASE,
        });
        await hooks["tool.execute.after"](input, output);
        const state = readGateStateFile(projectRoot, SID);
        assert.equal(state.dual_status, "pending", role);
        assert.ok(state.dual_nudge_attempts.includes(`${FEATURE_ID}/${TASK_ID}/${PHASE}`), role);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    }

    for (const role of ["plan-reviewer-family-2", "adversary-family-2"]) {
      const projectRoot = makeProjectRoot("obs-eye-canonical-secondary-");
      try {
        writeGateState(projectRoot, SID, { mode: "FULL", feature_id: FEATURE_ID });
        const hooks = await createObsEyeHooks(projectRoot);
        const { input, output } = makeTaskCall({
          role,
          featureId: FEATURE_ID,
          taskId: TASK_ID,
          phase: PHASE,
        });
        await hooks["tool.execute.after"](input, output);
        const state = readGateStateFile(projectRoot, SID);
        assert.equal(state.dual_status, undefined, role);
        assert.equal(state.dual_nudge_attempts, undefined, role);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    }
  } finally {
    restoreCrossFamily(prevEnv);
  }
});

test("[dual-nudge pure] applyDualNudge — a withGateStateLock seam that throws is fail-open: never re-throws, reports the nudge as not applied", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-throw-");
  try {
    const { applyDualNudge } = await import("./lib/dual-nudge.mjs");
    const gp = gateStatePath({ projectRoot, sessionId: SID, runtime: "opencode" });
    assert.ok(gp.ok, "gateStatePath must resolve for this fixture");
    const throwingWithGateStateLock = () => {
      throw new Error("simulated withGateStateLock crash");
    };

    let thrown = null;
    let result;
    try {
      result = await applyDualNudge({
        role: "plan-reviewer",
        featureId: FEATURE_ID,
        taskId: TASK_ID,
        phase: PHASE,
        sessionId: SID,
        crossFamilyEnabled: true,
        gateStatePath: () => gp,
        withGateStateLock: throwingWithGateStateLock,
        now: () => "2026-07-12T00:00:00.000Z",
      });
    } catch (err) {
      thrown = err;
    }

    assert.equal(thrown, null, "applyDualNudge must never let a withGateStateLock throw escape (fail-open)");
    assert.ok(
      result && result.ok === false,
      "a thrown withGateStateLock seam must be reported as a non-applied nudge (ok:false), never crash the caller",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("FAIL-OPEN — gate-state write denied without throwing (gate-state.json target is a real directory) → hook never throws, output.metadata and output.output stay byte-identical", async () => {
  const projectRoot = makeProjectRoot("obs-eye-nudge-denyfs-");
  const prevEnv = setCrossFamily(true);
  try {
    const gp = gateStatePath({ projectRoot, sessionId: SID, runtime: "opencode" });
    assert.ok(gp.ok, "gateStatePath must resolve for this fixture");
    // Replace the gate-state.json TARGET with a real directory: the underlying
    // writeGateStateAtomic's rename(tmp, statePath) fails (EISDIR), and withGateStateLock's
    // own fail-safe design returns { ok:false, decision:'deny', reason } — never throws.
    mkdirSync(gp.path, { recursive: true });

    const hooks = await createObsEyeHooks(projectRoot);
    const { input, output } = makeTaskCall({ role: "plan-reviewer", featureId: FEATURE_ID, taskId: TASK_ID, phase: PHASE });
    const metadataBefore = JSON.parse(JSON.stringify(output.metadata));
    const outputBefore = output.output;

    await assert.doesNotReject(() => hooks["tool.execute.after"](input, output));
    assert.deepEqual(
      output.metadata,
      metadataBefore,
      "fail-open: output.metadata must stay byte-identical when the gate-state write is denied without throwing",
    );
    assert.equal(
      output.output,
      outputBefore,
      "fail-open: output.output must stay byte-identical when the gate-state write is denied without throwing",
    );
  } finally {
    restoreCrossFamily(prevEnv);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("obs-eye.ts loading contract: dual-nudge.mjs is referenced only via a dynamic import inside createObsEyeHooks, never a static top-level import", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcPath = join(here, "obs-eye.ts");
  const src = readFileSync(srcPath, "utf8");
  const lines = src.split("\n");
  const staticImportLines = lines.filter(
    (line) => /^\s*import\b/.test(line) && /dual-nudge\.mjs/.test(line),
  );
  assert.equal(
    staticImportLines.length,
    0,
    "obs-eye.ts must not statically import ./lib/dual-nudge.mjs at module scope",
  );
  assert.match(
    src,
    /await\s+import\(\s*["']\.\/lib\/dual-nudge\.mjs["']\s*\)/,
    "dual-nudge.mjs must be loaded via a dynamic `await import(\"./lib/dual-nudge.mjs\")` inside createObsEyeHooks (same pattern already used for ./lib/obs-emit.mjs)",
  );

  const projectRoot = makeProjectRoot("obs-eye-nudge-loading-");
  try {
    const hooks = await createObsEyeHooks(projectRoot);
    assert.ok(
      hooks && typeof hooks["tool.execute.after"] === "function",
      "createObsEyeHooks must still resolve and expose tool.execute.after with the new dependency wired in",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
