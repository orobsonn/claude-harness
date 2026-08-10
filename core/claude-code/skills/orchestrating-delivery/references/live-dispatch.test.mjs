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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { runLiveDispatch, HAND_BASH_TIMEOUT_MS, dirtyTreeRefusal } from "./spawn-hand.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPAWN_CLI = join(__dirname, "spawn-hand.mjs");

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
    role: "executor",
    model: "glm-5.2",
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

      // A run-record was written, nested under a per-feature directory.
      assert.ok(writtenRecord, "a run-record must be written to disk");
      assert.ok(
        writtenRecord.path.endsWith(join("cheap-hands-wiring", "executor", "task-1.json")),
        "the run-record path must nest under <feature_id>/<role>/<task_id>.json"
      );
      assert.ok(!writtenRecord.content.includes(token), "the run-record must never contain the token literal");

      // runLiveDispatch returns the record + outcome.
      assert.equal(result.outcome.status, "DONE", "outcome must reflect the captured run");
      assert.ok(!JSON.stringify(result.record).includes(token), "the returned record must be token-free");

      // The record is ANCHORED to the freeze it ran against (the entry-gate freshness cross-check).
      assert.equal(result.record.freezeCommitSha, FREEZE_SHA, "the record must carry the freeze_commit_sha it ran against");
      assert.equal(JSON.parse(writtenRecord.content).freezeCommitSha, FREEZE_SHA, "the persisted record must carry freezeCommitSha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #ac-2.2 — the assembled dispatch carries an EXPLICIT 600000 Bash-tool timeout field
// (bash_timeout_ms), so the orchestrator's foreground `node spawn-hand.mjs` call never
// defaults to the Bash tool's 120000ms and SIGKILLs the hand at 2 min. Observed via the
// injected capture seam, which receives the assembled dispatch.
// ---------------------------------------------------------------------------
describe("runLiveDispatch assembles a dispatch carrying the explicit Bash timeout (#ac-2.2)", () => {
  it("the dispatch handed to the capture seam carries bash_timeout_ms === 600000", async () => {
    const { descriptor, dir } = makeDescriptor();
    const token = "fake-live-token-bashtimeout";
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

    try {
      await runLiveDispatch(descriptor, {
        spawn: makeFakeSpawn(sink),
        gitStatus: () => "",
        headSha: () => FREEZE_SHA,
        capture: fakeCapture,
        env: { ANTHROPIC_AUTH_TOKEN: token },
        writeRecord: () => {},
      });

      assert.ok(captureArgs, "the capture seam must receive the assembled dispatch");
      assert.equal(
        captureArgs.dispatch.bash_timeout_ms,
        600000,
        "the assembled dispatch must carry an explicit bash_timeout_ms of 600000",
      );
      assert.equal(
        captureArgs.dispatch.bash_timeout_ms,
        HAND_BASH_TIMEOUT_MS,
        "bash_timeout_ms must equal the exported HAND_BASH_TIMEOUT_MS constant",
      );
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
// #361 — an off-ladder model is a CONFIG error, not a run failure.
// This distinction is load-bearing: the CLI maps a THROW to exit 2 (configError,
// no run-record) and a RETURN to exit 0/1. Only a run-record with outcome FAILED
// — a genuine run-and-fail — authorizes a Claude hand fallback at the entry-gate.
// If a refused model ever produced a record instead of throwing, a plan pinning
// gpt-oss would silently buy itself an expensive Claude hand on every task.
// ---------------------------------------------------------------------------
describe("runLiveDispatch fail-closed on an unapproved hand model (#361)", () => {
  it("throws, spawns nothing, and writes NO run-record for an off-ladder model", async () => {
    for (const refused of ["gpt-oss:120b", "deepseek-v4-pro", "qwen3-coder:480b"]) {
      const { descriptor, dir } = makeDescriptor({ model: refused });
      const sink = {};
      let recordWritten = false;
      try {
        await assert.rejects(
          () =>
            runLiveDispatch(descriptor, {
              spawn: makeFakeSpawn(sink),
              gitStatus: () => "",
              headSha: () => FREEZE_SHA,
              capture: () => { throw new Error("capture must not run"); },
              env: { ANTHROPIC_AUTH_TOKEN: "tok-abc" },
              writeRecord: () => { recordWritten = true; },
              stateDir: dir,
            }),
          new RegExp(refused.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          `must reject the off-ladder model ${refused}, naming it`,
        );
        assert.notEqual(sink.cmd, "claude", `must NOT spawn a hand on ${refused}`);
        assert.equal(recordWritten, false, "a config error must write NO run-record (it would authorize a Claude fallback)");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("stamps modelFallbackUsed on the record when the descriptor carries no model (#ac-1.3)", async () => {
    const { descriptor, dir } = makeDescriptor();
    delete descriptor.model;
    let record = null;
    try {
      await runLiveDispatch(descriptor, {
        spawn: makeFakeSpawn({}),
        gitStatus: () => "",
        headSha: () => FREEZE_SHA,
        capture: ({ child }) => ({ child: { ...child, touchedPaths: [], lockedTestExitCode: 0 } }),
        env: { ANTHROPIC_AUTH_TOKEN: "tok-abc" },
        // The seam is writeRecord(path, content) — the record is the serialized second arg.
        writeRecord: (_path, content) => { record = JSON.parse(content); },
      });
      assert.equal(record.model, "glm-5.2", "absence falls back to the medium rung");
      assert.equal(record.modelFallbackUsed, true, "the fallback must never be silent on the record");
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
    // scope_paths is narrowed to src/ so the dirt below is GENUINELY out-of-scope — otherwise the
    // fixture's default ["core/"] would contain it and this would exercise the in-scope branch.
    const { descriptor, dir } = makeDescriptor({ scope_paths: ["src/"], allowed_writes: ["src/"] });
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
// Locked test 3b — the SNIPER diagnosis. A sniper dispatched at SKILL.md's step 5
// with the executor's impl still uncommitted trips the same dirty guard, but the
// generic "commit/stash orchestrator files first" text misdiagnoses it: the dirt
// IS the implementation, and stashing it DESTROYS the work the sniper exists to
// fix. When the dirt lands inside the dispatch's OWN scope_paths, the refusal must
// name the skipped impl-commit and warn off the stash. Both branches still REFUSE —
// this only chooses the diagnosis, so it can never weaken the guard.
// ---------------------------------------------------------------------------
describe("runLiveDispatch diagnoses a skipped impl-commit (dirt inside scope_paths)", () => {
  it("names the impl-commit and warns against stashing when the dirt is in scope", async () => {
    const { descriptor, dir } = makeDescriptor({
      scope_paths: ["src/orders/"],
      allowed_writes: ["src/orders/"],
    });
    const sink = {};
    try {
      await assert.rejects(
        () =>
          runLiveDispatch(descriptor, {
            spawn: makeFakeSpawn(sink),
            // The executor's own uncommitted implementation — NOT orchestrator paperwork.
            gitStatus: () => " M src/orders/total.ts\n?? src/orders/tax.ts\n",
            headSha: () => FREEZE_SHA,
            capture: () => { throw new Error("capture must not run"); },
            env: { ANTHROPIC_AUTH_TOKEN: "tok" },
            writeRecord: () => {},
          }),
        (err) => {
          assert.match(err.message, /impl-commit/i, "must name the impl-commit as the missing step");
          assert.match(err.message, /src\/orders\/total\.ts/, "must name the in-scope dirty path");
          assert.match(err.message, /do not.*stash|never.*stash/i, "must warn off the stash that would destroy the impl");
          return true;
        },
        "must diagnose in-scope dirt as a skipped impl-commit"
      );
      assert.notEqual(sink.cmd, "claude", "must NOT spawn onto a dirty baseline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the generic orchestrator-paperwork diagnosis when NO dirt is in scope", async () => {
    const { descriptor, dir } = makeDescriptor({ scope_paths: ["src/orders/"] });
    try {
      await assert.rejects(
        () =>
          runLiveDispatch(descriptor, {
            spawn: makeFakeSpawn({}),
            gitStatus: () => " M findings.md\n",
            headSha: () => FREEZE_SHA,
            capture: () => { throw new Error("capture must not run"); },
            env: { ANTHROPIC_AUTH_TOKEN: "tok" },
            writeRecord: () => {},
          }),
        (err) => {
          assert.match(err.message, /commit\/stash orchestrator files/i, "out-of-scope dirt keeps the stash advice");
          assert.doesNotMatch(err.message, /impl-commit/i, "must NOT misdiagnose paperwork as a skipped impl-commit");
          return true;
        },
        "must reject out-of-scope dirt with the generic diagnosis"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dirtyTreeRefusal (pure)", () => {
  it("reads the porcelain rename form (R old -> new) as the destination path", () => {
    const msg = dirtyTreeRefusal("R  src/a.ts -> src/orders/b.ts\n", ["src/orders/"]);
    assert.match(msg, /impl-commit/i, "the rename DESTINATION is what lands in scope");
    assert.match(msg, /src\/orders\/b\.ts/, "must name the destination, not the source");
  });

  it("matches a scope entry with or without its trailing slash, and never by bare prefix", () => {
    assert.match(dirtyTreeRefusal("?? core/x.ts\n", ["core"]), /impl-commit/i, "scope without trailing slash");
    assert.match(dirtyTreeRefusal("?? core/x.ts\n", ["core/"]), /impl-commit/i, "scope with trailing slash");
    assert.doesNotMatch(
      dirtyTreeRefusal("?? coreless/x.ts\n", ["core"]),
      /impl-commit/i,
      "'coreless/' must NOT count as inside 'core' — a bare prefix match would misdiagnose"
    );
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

  it("throws when task_id is a path-traversal attempt instead of a safe kebab-case id", async () => {
    const { descriptor, dir } = makeDescriptor({ task_id: "../../../etc/evil" });
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
            writeRecord: () => { throw new Error("writeRecord must not run"); },
          }),
        /feature_id|task_id|kebab-case/i,
        "must reject a path-traversal task_id before it can be used as a path segment"
      );
      assert.notEqual(sink.cmd, "claude", "must NOT spawn when the id is unsafe");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Locked test 6 (Part B) — config-error escape: the CLI distinguishes a
// PRE-SPAWN CONFIG ERROR from a genuine run failure. A config error exits 2 with
// a structured { configError: true } signal (the orchestrator routes exit 2 to
// the critical-exception path — never a silent Claude fallback, never a lock).
// ---------------------------------------------------------------------------
describe("spawn-hand CLI classifies a pre-spawn config error as exit 2", () => {
  it("exits 2 with a configError signal on an invalid descriptor (not exit 0/1 like a genuine run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-cli-"));
    try {
      // An invalid descriptor (missing required field) throws at schema validation BEFORE the
      // token is resolved or anything spawns — a deterministic pre-spawn config error.
      const descriptorPath = join(dir, "descriptor.json");
      writeFileSync(descriptorPath, JSON.stringify({ feature_id: "x", task_id: "y" }), "utf8");

      const res = spawnSync(process.execPath, [SPAWN_CLI, "--descriptor", descriptorPath], { encoding: "utf8" });

      assert.equal(res.status, 2, `a pre-spawn config error must exit 2 (got ${res.status})`);
      const out = `${res.stdout ?? ""}`;
      assert.match(out, /"configError"\s*:\s*true/, "the CLI must emit a structured configError signal on stdout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
