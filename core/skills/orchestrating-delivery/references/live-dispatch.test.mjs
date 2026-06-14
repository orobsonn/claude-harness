#!/usr/bin/env node
/**
 * @description Tests for runLiveDispatch (spawn-hand.mjs) — the live-dispatch function that
 * wires the cheap Ollama hand end-to-end: validate descriptor → fail-closed token-leak guard →
 * git-universe reconciliation (clean full tree + anchored HEAD) → dispatchHand (live spawn) →
 * INDEPENDENT capture → buildRunRecord → on-disk run-record. This is the regression for the
 * never-fire bug (victor 7fcc1009): the live path existed but was never exercised, so the
 * orchestrator always stamped the escape and dispatched Claude.
 *
 * No real Ollama token is used — every seam (spawn, gitStatus, headSha, capture, env,
 * writeRecord) is injected. The fake spawn asserts ANTHROPIC_BASE_URL=ollama.com and that the
 * token reaches the child ONLY via env, never via argv.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runLiveDispatch } from "./spawn-hand.mjs";

const FREEZE_SHA = "0123456789abcdef0123456789abcdef01234567";
const REAL_LOCKED_TEST =
  "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs";

/** @description Builds a descriptor + a temp brief file; caller tears the dir down. */
function makeDescriptor(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "live-dispatch-test-"));
  const briefFile = join(dir, "brief.txt");
  writeFileSync(briefFile, "implement the thing — no secrets here", "utf8");
  const descriptor = {
    feature_id: "cheap-hands-wiring",
    task_id: "task-1",
    model: "qwen3-coder:480b",
    brief_file: briefFile,
    scope_paths: ["core/"],
    locked_test: REAL_LOCKED_TEST,
    allowed_writes: ["core/"],
    freeze_commit_sha: FREEZE_SHA,
    ...overrides,
  };
  return { descriptor, dir };
}

/**
 * @description Fake spawn that handles BOTH the vacuous-gate dry-run (`node --test <path>`,
 * must report >0 collected tests) and the real `claude` spawn (records env + argv).
 */
function makeFakeSpawn(sink) {
  return (cmd, args, opts) => {
    if (args?.includes("--test")) {
      return { status: 0, stdout: "# tests 5\n", stderr: "", output: [] };
    }
    sink.cmd = cmd;
    sink.args = args;
    sink.env = opts?.env ?? {};
    sink.input = opts?.input;
    return { status: 0, stdout: '{"result":"done"}', stderr: "", output: [] };
  };
}

// ---------------------------------------------------------------------------
// Locked test 1 — the live branch FIRES: dispatchHand spawns claude against
// ollama.com (token env-only) AND the independent capture runs.
// ---------------------------------------------------------------------------
describe("runLiveDispatch fires the live spawn + independent capture", () => {
  it("spawns claude with ANTHROPIC_BASE_URL=ollama.com (token env-only, never argv) and runs the capture", async () => {
    const { descriptor, dir } = makeDescriptor();
    const token = "fake-live-token-abc123";
    const sink = {};
    let captureArgs = null;

    const fakeCapture = (args) => {
      captureArgs = args;
      return {
        captured: true,
        child: {
          captured: true,
          touchedPaths: ["core/foo.mjs"],
          lockedTestExitCode: 0,
          exitCode: args.child.exitCode,
          stdout: args.child.stdout,
          stderr: args.child.stderr,
          testsCount: 5,
        },
        outcome: { status: "DONE", scopeViolations: [], frozenViolations: [], allowedWriteViolations: [], reasons: [] },
      };
    };

    let writtenRecord = null;
    try {
      const result = await runLiveDispatch(descriptor, {
        spawn: makeFakeSpawn(sink),
        gitStatus: () => "",
        headSha: () => FREEZE_SHA,
        capture: fakeCapture,
        env: { ANTHROPIC_AUTH_TOKEN: token },
        writeRecord: (path, content) => { writtenRecord = { path, content }; },
      });

      // The live spawn actually fired against ollama.com.
      assert.equal(sink.cmd, "claude", "runLiveDispatch must spawn the `claude` binary (live path), not skip it");
      assert.equal(
        sink.env.ANTHROPIC_BASE_URL,
        "https://ollama.com",
        "child env must target ollama.com"
      );

      // Token is env-only — never in argv.
      assert.equal(sink.env.ANTHROPIC_AUTH_TOKEN, token, "token must reach the child via env");
      assert.ok(
        !(sink.args ?? []).join(" ").includes(token),
        "token must NEVER appear in argv"
      );

      // The INDEPENDENT capture ran with the child produced by dispatchHand.
      assert.ok(captureArgs, "the independent capture must be invoked");
      assert.equal(captureArgs.freezeCommitSha, FREEZE_SHA, "capture must anchor to the freeze commit");
      assert.equal(captureArgs.testPath, REAL_LOCKED_TEST, "capture must re-run the frozen locked_test by path");
      assert.equal(captureArgs.token, token, "capture must receive the resolved token for redaction");

      // A run-record was written, keyed by feature_id/task_id, and carries the outcome.
      assert.ok(writtenRecord, "a run-record must be written to disk");
      assert.ok(
        writtenRecord.path.includes("cheap-hands-wiring") && writtenRecord.path.includes("task-1"),
        "the run-record path must be keyed by feature_id + task_id"
      );
      assert.ok(!writtenRecord.content.includes(token), "the run-record must never contain the token literal");

      // runLiveDispatch returns the record + outcome.
      assert.equal(result.outcome.status, "DONE", "outcome must reflect the captured run");
      assert.ok(!JSON.stringify(result.record).includes(token), "the returned record must be token-free");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Locked test 2 — fail-closed when the descriptor itself carries the token
// literal (descriptor.json is a new on-disk leak surface; scrub is CODE).
// ---------------------------------------------------------------------------
describe("runLiveDispatch fail-closed on token in descriptor", () => {
  it("throws and does NOT spawn when the token literal is present in the descriptor bytes", async () => {
    const token = "leaked-token-in-descriptor-zzz";
    const { descriptor, dir } = makeDescriptor({ leaked_field: `bearer ${token}` });
    const sink = {};
    try {
      await assert.rejects(
        () =>
          runLiveDispatch(descriptor, {
            spawn: makeFakeSpawn(sink),
            gitStatus: () => "",
            headSha: () => FREEZE_SHA,
            capture: () => { throw new Error("capture must not run"); },
            env: { ANTHROPIC_AUTH_TOKEN: token },
            writeRecord: () => {},
          }),
        /descriptor .*token|token .*descriptor/i,
        "must reject when the token literal is in the descriptor"
      );
      assert.notEqual(sink.cmd, "claude", "must NOT spawn when fail-closed on a leaked descriptor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Locked test 2b — fail-closed when the brief_file content carries the token
// literal (symmetric with the descriptor guard; the brief is a token-must-never
// surface per the spec — defense-in-depth before redaction).
// ---------------------------------------------------------------------------
describe("runLiveDispatch fail-closed on token in brief_file", () => {
  it("throws and does NOT spawn when the token literal is present in the brief file", async () => {
    const token = "leaked-token-in-brief-qqq";
    const { descriptor, dir } = makeDescriptor();
    writeFileSync(descriptor.brief_file, `do the work, bearer ${token}`, "utf8");
    const sink = {};
    try {
      await assert.rejects(
        () =>
          runLiveDispatch(descriptor, {
            spawn: makeFakeSpawn(sink),
            gitStatus: () => "",
            headSha: () => FREEZE_SHA,
            capture: () => { throw new Error("capture must not run"); },
            env: { ANTHROPIC_AUTH_TOKEN: token },
            writeRecord: () => {},
          }),
        /brief.*token|token.*brief/i,
        "must reject when the token literal is in the brief file"
      );
      assert.notEqual(sink.cmd, "claude", "must NOT spawn when fail-closed on a leaked brief");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Locked test 3 — git-universe reconciliation: refuse a DIRTY full tree before
// spawn (option a — assert the full tree is clean relative to freeze_commit_sha
// so the unscoped capture diff attributes only the hand's work).
// ---------------------------------------------------------------------------
describe("runLiveDispatch fail-closed on a dirty full tree", () => {
  it("throws and does NOT spawn when the full tree is dirty relative to the freeze baseline", async () => {
    const { descriptor, dir } = makeDescriptor();
    const sink = {};
    try {
      await assert.rejects(
        () =>
          runLiveDispatch(descriptor, {
            spawn: makeFakeSpawn(sink),
            gitStatus: () => " M core/shared_context.md\n", // orchestrator-owned out-of-scope dirt
            headSha: () => FREEZE_SHA,
            capture: () => { throw new Error("capture must not run"); },
            env: { ANTHROPIC_AUTH_TOKEN: "tok" },
            writeRecord: () => {},
          }),
        /dirty|clean baseline|uncommitted/i,
        "must reject a dirty full tree (misattribution risk)"
      );
      assert.notEqual(sink.cmd, "claude", "must NOT spawn onto a dirty baseline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Locked test 4 — anchor guard: refuse when HEAD diverged from the recorded
// freeze baseline (the capture diff could no longer anchor to the baseline).
// ---------------------------------------------------------------------------
describe("runLiveDispatch fail-closed on a diverged HEAD", () => {
  it("throws and does NOT spawn when HEAD != freeze_commit_sha", async () => {
    const { descriptor, dir } = makeDescriptor();
    const sink = {};
    try {
      await assert.rejects(
        () =>
          runLiveDispatch(descriptor, {
            spawn: makeFakeSpawn(sink),
            gitStatus: () => "",
            headSha: () => "ffffffffffffffffffffffffffffffffffffffff",
            capture: () => { throw new Error("capture must not run"); },
            env: { ANTHROPIC_AUTH_TOKEN: "tok" },
            writeRecord: () => {},
          }),
        /diverged|anchor|HEAD|freeze/i,
        "must reject when HEAD diverged from the freeze baseline"
      );
      assert.notEqual(sink.cmd, "claude", "must NOT spawn on a diverged HEAD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Locked test 5 — descriptor validation: a missing required field fails closed.
// ---------------------------------------------------------------------------
describe("runLiveDispatch validates the descriptor schema", () => {
  it("throws when a required field (freeze_commit_sha) is missing", async () => {
    const { descriptor, dir } = makeDescriptor();
    delete descriptor.freeze_commit_sha;
    const sink = {};
    try {
      await assert.rejects(
        () =>
          runLiveDispatch(descriptor, {
            spawn: makeFakeSpawn(sink),
            gitStatus: () => "",
            headSha: () => FREEZE_SHA,
            capture: () => { throw new Error("capture must not run"); },
            env: { ANTHROPIC_AUTH_TOKEN: "tok" },
            writeRecord: () => {},
          }),
        /descriptor|required|freeze_commit_sha|missing/i,
        "must reject an incomplete descriptor"
      );
      assert.notEqual(sink.cmd, "claude", "must NOT spawn on an invalid descriptor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
