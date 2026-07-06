/**
 * @description Test suite (RED — the hand-ran append action does not exist yet in
 * stamp-triage.mjs) for the spawn-hand outbox-append observability action: when a
 * PostToolUse(Bash) command includes `spawn-hand.mjs --descriptor <path>` AND the parsed
 * stdout is the REAL run-record (a genuine completed run — has fields like model/scope_paths/
 * outcome/exitCode/freezeCommitSha, NOT the {configError:true,...} pre-spawn shape), a
 * {type:'hand-ran', task, model} event must be appended to the run's observability outbox.
 * task/model are sourced from the --descriptor file named in the command argv (the trustworthy
 * source), NEVER from the stdout run-record (which carries no role/task_id field at all).
 * Mirrors the withTempDir isolation pattern and the spawn-hand payload-building convention
 * from core/hooks/stamp-triage.test.mjs. Run with: node --test core/hooks/stamp-triage-obs-hand.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decide, handle } from "./stamp-triage.mjs";
import { createRun, readEvents } from "../vps/obs-outbox.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Runs fn inside a fresh OS tmpdir (chdir'd to it), then restores cwd and removes the dir.
 * @param {(tmpDir: string) => void} fn - Synchronous test body, receives the tmpDir
 */
function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-triage-obs-hand-test-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    fn(tmpDir);
  } finally {
    process.chdir(savedCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

/**
 * Creates a real obs-outbox meta (via createRun) under tmpDir, returning the meta path.
 * @param {string} tmpDir
 * @param {number} issueNumber
 * @returns {string} the obs-<issue>.json meta path
 */
function setupObsMeta(tmpDir, issueNumber) {
  const stateDir = path.join(tmpDir, ".claude", "plans", ".state", "obs");
  fs.mkdirSync(stateDir, { recursive: true });
  return createRun({ issueNumber, project: "claude-harness", worktreePath: tmpDir }, stateDir);
}

/**
 * Writes a real descriptor JSON file under tmpDir, returning its absolute path.
 * @param {string} tmpDir
 * @param {string} fileName
 * @param {object} descriptor
 * @returns {string} the descriptor path
 */
function writeDescriptor(tmpDir, fileName, descriptor) {
  const descriptorPath = path.join(tmpDir, fileName);
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor), "utf8");
  return descriptorPath;
}

/**
 * Builds a spawn-hand.mjs PostToolUse(Bash) payload whose command names the descriptor
 * path and whose stdout is the given (real run-record OR config-error) JSON shape.
 * @param {string} sessionId
 * @param {string} descriptorPath
 * @param {object} stdoutShape
 */
function makeSpawnHandPayload(sessionId, descriptorPath, stdoutShape) {
  return {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: {
      command: `node .claude/skills/orchestrating-delivery/references/spawn-hand.mjs --descriptor ${descriptorPath}`,
    },
    tool_response: JSON.stringify(stdoutShape),
  };
}

/**
 * Runs fn with process.env[name] set to value (or deleted, when value is undefined),
 * restoring the prior state (present-or-absent) afterward.
 * @param {string} name
 * @param {string|undefined} value
 * @param {() => void} fn
 */
function withEnvVar(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    fn();
  } finally {
    if (had) {
      process.env[name] = prev;
    } else {
      delete process.env[name];
    }
  }
}

// ---------------------------------------------------------------------------
// Assertion 1
// ---------------------------------------------------------------------------

/**
 * @description Given a PostToolUse(Bash) payload whose command includes
 * 'spawn-hand.mjs --descriptor <path>' and whose stdout is the REAL run-record JSON
 * ({model, scope_paths, outcome, exitCode} — NO role field, NO top-level task_id) with the
 * descriptor at <path> carrying {feature_id, task_id:'task-2', model:'glm-5.2'} and
 * HARNESS_OBSERVABILITY_RUN_PATH pointed at an existing obs meta, when stamp-triage handle()
 * runs, then a {type:'hand-ran', task:'task-2', model:'glm-5.2'} event is appended (task/model
 * sourced from the descriptor, never from a nonexistent stdout role field).
 */
test(
  "handle: spawn-hand real run-record + descriptor task-2/glm-5.2 + HARNESS_OBSERVABILITY_RUN_PATH set → {type:'hand-ran', task:'task-2', model:'glm-5.2'} appended to the outbox",
  () => {
    withTempDir((tmpDir) => {
      const metaPath = setupObsMeta(tmpDir, 501);
      const descriptorPath = writeDescriptor(tmpDir, "descriptor-task-2.json", {
        feature_id: "vps-run-observability",
        task_id: "task-2",
        model: "glm-5.2",
      });
      const stdoutRecord = {
        model: "glm-5.2",
        scope_paths: ["core/hooks/stamp-triage.mjs"],
        outcome: { status: "DONE" },
        exitCode: 0,
        freezeCommitSha: "abc1234",
      };
      const payload = makeSpawnHandPayload("ses_hand1", descriptorPath, stdoutRecord);

      withEnvVar("HARNESS_OBSERVABILITY_RUN_PATH", metaPath, () => {
        assert.doesNotThrow(() => handle(payload));
      });

      const events = readEvents(metaPath);
      const handRan = events.find((e) => e.type === "hand-ran");
      assert.ok(handRan, "a hand-ran event must be appended to the outbox");
      assert.equal(handRan.task, "task-2");
      assert.equal(handRan.model, "glm-5.2");
    });
  },
);

// ---------------------------------------------------------------------------
// Assertion 2
// ---------------------------------------------------------------------------

/**
 * @description Given the same real-run-record shape but the descriptor at <path> carries
 * task_id:'task-9' and model:'kimi-k2.7-code', when stamp-triage handle() runs, then a
 * {type:'hand-ran', task:'task-9', model:'kimi-k2.7-code'} event is appended (the appended
 * event never fabricates a role the stdout record does not carry).
 */
test(
  "handle: spawn-hand real run-record + descriptor task-9/kimi-k2.7-code → appended event carries task/model FROM THE DESCRIPTOR, never fabricating a role the stdout record does not carry",
  () => {
    withTempDir((tmpDir) => {
      const metaPath = setupObsMeta(tmpDir, 502);
      const descriptorPath = writeDescriptor(tmpDir, "descriptor-task-9.json", {
        feature_id: "vps-run-observability",
        task_id: "task-9",
        model: "kimi-k2.7-code",
      });
      const stdoutRecord = {
        model: "kimi-k2.7-code",
        scope_paths: ["core/vps/obs-outbox.mjs"],
        outcome: { status: "DONE" },
        exitCode: 0,
        freezeCommitSha: "def5678",
      };
      const payload = makeSpawnHandPayload("ses_hand2", descriptorPath, stdoutRecord);

      withEnvVar("HARNESS_OBSERVABILITY_RUN_PATH", metaPath, () => {
        assert.doesNotThrow(() => handle(payload));
      });

      const events = readEvents(metaPath);
      const handRan = events.find((e) => e.type === "hand-ran");
      assert.ok(handRan, "a hand-ran event must be appended to the outbox");
      assert.equal(handRan.task, "task-9", "task must be sourced from the descriptor's task_id");
      assert.equal(handRan.model, "kimi-k2.7-code", "model must be sourced from the descriptor's model");
      assert.equal(
        Object.prototype.hasOwnProperty.call(handRan, "role"),
        false,
        "the appended event must never fabricate a role the stdout run-record does not carry",
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Assertion 3
// ---------------------------------------------------------------------------

/**
 * @description Given a spawn-hand payload whose stdout is the config-error shape
 * {configError:true, reason:'no token', feature_id:'f', task_id:'t'}, when stamp-triage
 * handle() and the CLI decision are computed, then NO hand-ran event is appended AND the
 * existing hand-config-error-nudge action is still returned (existing behavior preserved)
 * and handle() does not throw.
 */
test(
  "handle/decide: spawn-hand configError:true stdout → NO hand-ran event appended AND the existing hand-config-error-nudge action is preserved; handle() does not throw",
  () => {
    withTempDir((tmpDir) => {
      const metaPath = setupObsMeta(tmpDir, 503);
      const descriptorPath = writeDescriptor(tmpDir, "descriptor-task-err.json", {
        feature_id: "f",
        task_id: "t",
        model: "glm-5.2",
      });
      const configErrorStdout = {
        configError: true,
        reason: "no token",
        feature_id: "f",
        task_id: "t",
      };
      const payload = makeSpawnHandPayload("ses_hand3", descriptorPath, configErrorStdout);

      // Existing behavior preserved: decide() still returns the pre-spawn config-error nudge.
      const decision = decide(payload);
      assert.equal(decision.action, "hand-config-error-nudge");
      assert.equal(decision.reason, "no token");
      assert.equal(decision.feature_id, "f");
      assert.equal(decision.task_id, "t");

      withEnvVar("HARNESS_OBSERVABILITY_RUN_PATH", metaPath, () => {
        assert.doesNotThrow(() => handle(payload));
      });

      const events = readEvents(metaPath);
      const handRan = events.find((e) => e.type === "hand-ran");
      assert.equal(
        handRan,
        undefined,
        "a config-error stdout must NEVER append a hand-ran event — the hand never completed a run",
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Assertion 4
// ---------------------------------------------------------------------------

/**
 * @description Given a spawn-hand real-run-record payload with HARNESS_OBSERVABILITY_RUN_PATH
 * unset, when stamp-triage handle() runs, then NO event file is written and handle() does not
 * throw.
 */
test(
  "handle: spawn-hand real run-record with HARNESS_OBSERVABILITY_RUN_PATH UNSET → no event file written, handle() does not throw",
  () => {
    withTempDir((tmpDir) => {
      const descriptorPath = writeDescriptor(tmpDir, "descriptor-task-unset.json", {
        feature_id: "vps-run-observability",
        task_id: "task-4",
        model: "glm-5.2",
      });
      const stdoutRecord = {
        model: "glm-5.2",
        scope_paths: ["core/hooks/stamp-triage.mjs"],
        outcome: { status: "DONE" },
        exitCode: 0,
      };
      const payload = makeSpawnHandPayload("ses_hand4", descriptorPath, stdoutRecord);

      withEnvVar("HARNESS_OBSERVABILITY_RUN_PATH", undefined, () => {
        assert.doesNotThrow(() => handle(payload));
      });

      // No observability meta/events directory was ever created under the temp dir.
      const obsStateDir = path.join(tmpDir, ".claude", "plans", ".state", "obs");
      assert.equal(
        fs.existsSync(obsStateDir),
        false,
        "no observability directory should be created when HARNESS_OBSERVABILITY_RUN_PATH is unset",
      );
    });
  },
);
