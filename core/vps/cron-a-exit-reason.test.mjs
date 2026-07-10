/**
 * @description Contract tests for the exit-reason capture path of cron-a-exit.mjs — the
 * best-effort forensic summary written on every non-PR cron-a exit (requeued/blocked/failed),
 * the secret-scrubbing applied before that summary is persisted, the argv parsing for the CLI
 * entry point, and the real composition-root wiring (runCronAExitCli) that binds captureExitReason
 * into the CLI orchestration alongside notifyExit.
 *
 * captureExitReason() is fire-and-forget: it must never throw, even when the write target does
 * not exist. It writes join(stateDir, 'issue-<issueNumber>-exit-reason.json') only on non-PR
 * outcomes (outcome.outcome !== 'done'), always best-effort unlinks the raw log at logPath
 * afterward (on every outcome, including 'done'), and always scrubs secret-shaped substrings out
 * of the persisted summary via scrubSecrets().
 *
 * Every seam these tests need is either a real temp file/dir (mkdtemp under os.tmpdir(), per this
 * repo's hermetic style — see cron-a-exit.test.mjs) or an injected clock (`now`). No real gh/git
 * process is ever spawned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { cronAExit, scrubSecrets, captureExitReason, runCronAExitCli, parseArgv } from "./cron-a-exit.mjs";

/** @description Fresh temp dir for one test; caller is responsible for rmSync cleanup. */
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "exit-reason-"));
}

/** @description Writes a deterministic N-line raw log ("line-1".."line-N") and returns its lines. */
function writeLinesLog(path, count) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    lines.push(`line-${i}`);
  }
  writeFileSync(path, lines.join("\n"), "utf8");
  return lines;
}

test("captureExitReason: non-PR outcome writes issue-<N>-exit-reason.json with the outcome, now()-derived timestamp, and a summary of the last 200 log lines", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "raw.log");
    const lines = writeLinesLog(logPath, 300);
    const outcome = { outcome: "requeued", issueNumber: 42, hadPr: false, finding: null };

    captureExitReason({ stateDir: dir, outcome, exitCode: 0, logPath, now: () => 1700000000 });

    const reasonFile = join(dir, "issue-42-exit-reason.json");
    assert.ok(existsSync(reasonFile), "reason file must exist after a non-PR exit");
    const parsed = JSON.parse(readFileSync(reasonFile, "utf8"));
    assert.equal(parsed.outcome, "requeued");
    assert.equal(parsed.timestamp, 1700000000);
    const expectedSummary = lines.slice(100, 300).join("\n");
    assert.equal(parsed.summary, expectedSummary, "summary must equal the last 200 lines of the log, joined by newline");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureExitReason: 'done' outcome writes NO issue-<N>-exit-reason.json file", () => {
  const dir = makeTempDir();
  try {
    const outcome = { outcome: "done", hadPr: true, issueNumber: 42, finding: null };

    captureExitReason({ stateDir: dir, outcome, exitCode: 0, logPath: undefined, now: () => 1700000000 });

    assert.equal(existsSync(join(dir, "issue-42-exit-reason.json")), false, "the PR-exists path must never write a reason file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureExitReason: non-PR outcome with exitCode===0 -> category 'no-pr-produced'", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "raw.log");
    writeLinesLog(logPath, 10);
    const outcome = { outcome: "requeued", issueNumber: 42, hadPr: false, finding: null };

    captureExitReason({ stateDir: dir, outcome, exitCode: 0, logPath, now: () => 1700000000 });

    const parsed = JSON.parse(readFileSync(join(dir, "issue-42-exit-reason.json"), "utf8"));
    assert.equal(parsed.category, "no-pr-produced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureExitReason: non-PR outcome with exitCode===7 -> category 'tool-error'", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "raw.log");
    writeLinesLog(logPath, 10);
    const outcome = { outcome: "failed", issueNumber: 42, hadPr: false, finding: null };

    captureExitReason({ stateDir: dir, outcome, exitCode: 7, logPath, now: () => 1700000000 });

    const parsed = JSON.parse(readFileSync(join(dir, "issue-42-exit-reason.json"), "utf8"));
    assert.equal(parsed.category, "tool-error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureExitReason: non-PR outcome with exitCode undefined and a valid logPath -> category 'unknown'", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "raw.log");
    writeLinesLog(logPath, 5);
    const outcome = { outcome: "requeued", issueNumber: 42, hadPr: false, finding: null };

    captureExitReason({ stateDir: dir, outcome, exitCode: undefined, logPath, now: () => 1700000000 });

    const parsed = JSON.parse(readFileSync(join(dir, "issue-42-exit-reason.json"), "utf8"));
    assert.equal(parsed.category, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scrubSecrets: redacts a GitHub token (ghp_ + 36 alphanumeric chars)", () => {
  const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const input = `leaked token: ${token} in the log`;

  const output = scrubSecrets(input);

  assert.ok(output.includes("[REDACTED]"), "output must contain the redaction marker");
  assert.ok(!output.includes(token), "output must not contain the raw token substring verbatim");
});

test("scrubSecrets: redacts an Anthropic key, a JWT, a GitHub PAT, a Bearer header, and a TOKEN= assignment", () => {
  const anthropicKey = "sk-ant-api03-AA11bb22";
  const jwt = "eyJhbGciOiJI.eyJzdWIiOiIx.sIgnAtUre";
  const githubPat = "github_pat_11ABCDEF0123456789abcd";
  const bearerHeader = "Bearer abc.def.ghi";
  const tokenAssignment = "TOKEN=supersecretvalue";
  const input = [
    `anthropic: ${anthropicKey}`,
    `jwt: ${jwt}`,
    `pat: ${githubPat}`,
    `auth: ${bearerHeader}`,
    `env: ${tokenAssignment}`,
  ].join("\n");

  const output = scrubSecrets(input);

  assert.ok(!output.includes(anthropicKey), "the Anthropic key must not survive verbatim");
  assert.ok(!output.includes(jwt), "the JWT must not survive verbatim");
  assert.ok(!output.includes(githubPat), "the GitHub PAT must not survive verbatim");
  assert.ok(!output.includes(bearerHeader), "the Bearer header must not survive verbatim");
  assert.ok(!output.includes(tokenAssignment), "the TOKEN= assignment must not survive verbatim");
});

test("captureExitReason: scrubs a ghp_ token found in the raw log before persisting the summary", () => {
  const dir = makeTempDir();
  try {
    const token = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
    const logPath = join(dir, "raw.log");
    writeFileSync(logPath, `line one\nsecret token: ${token}\nline three`, "utf8");
    const outcome = { outcome: "failed", issueNumber: 42, hadPr: false, finding: null };

    captureExitReason({ stateDir: dir, outcome, exitCode: 1, logPath, now: () => 1700000000 });

    const parsed = JSON.parse(readFileSync(join(dir, "issue-42-exit-reason.json"), "utf8"));
    assert.ok(parsed.summary.includes("[REDACTED]"), "the persisted summary must contain the redaction marker");
    assert.ok(!parsed.summary.includes(token), "the persisted summary must never contain the raw token verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureExitReason: writes the reason file with mode 0o600", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "raw.log");
    writeLinesLog(logPath, 3);
    const outcome = { outcome: "requeued", issueNumber: 42, hadPr: false, finding: null };

    captureExitReason({ stateDir: dir, outcome, exitCode: 0, logPath, now: () => 1700000000 });

    const reasonFile = join(dir, "issue-42-exit-reason.json");
    const mode = statSync(reasonFile).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureExitReason: a write failure (nonexistent parent stateDir) is swallowed — returns without throwing, no file created", () => {
  const dir = makeTempDir();
  try {
    const missingStateDir = join(dir, "does-not-exist", "nested");
    const outcome = { outcome: "requeued", issueNumber: 42, hadPr: false, finding: null };

    assert.doesNotThrow(() => {
      captureExitReason({ stateDir: missingStateDir, outcome, exitCode: 0, logPath: undefined, now: () => 1700000000 });
    });
    assert.equal(existsSync(join(missingStateDir, "issue-42-exit-reason.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cronAExit: direct invocation with injected opts never creates an issue-<N>-exit-reason.json itself", () => {
  const dir = makeTempDir();
  try {
    const gh = () => ({ ok: true });
    const runLock = { release: () => {} };
    const counts = { 42: 0 };
    const counter = {
      read: (n) => counts[n] ?? 0,
      reset: (n) => {
        counts[n] = 0;
      },
      increment: (n) => {
        counts[n] = (counts[n] ?? 0) + 1;
      },
    };
    const bodyFile = join(dir, "issue-42-body.txt");
    const envFile = join(dir, "issue-42-env.env");
    writeFileSync(bodyFile, "the issue body", "utf8");
    writeFileSync(envFile, "SOME_SECRET=abc123", "utf8");

    cronAExit(42, "/fake/worktree", bodyFile, envFile, {
      gh,
      runLock,
      counter,
      prExists: () => false,
      blockingFinding: () => null,
      stateDir: dir,
      acquireTs: 1000,
      retryCeilingK: 2,
    });

    assert.equal(
      existsSync(join(dir, "issue-42-exit-reason.json")),
      false,
      "cronAExit itself must never write the exit-reason file — that is captureExitReason's job"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArgv: exactly 4 argv elements -> issueNumber/worktree/bodyFile/envFile parsed, logPath and exitCode undefined", () => {
  const argv = ["42", "/wt", "/s/body.txt", "/s/env.env"];

  const parsed = parseArgv(argv);

  assert.equal(parsed.issueNumber, 42);
  assert.equal(parsed.worktree, "/wt");
  assert.equal(parsed.bodyFile, "/s/body.txt");
  assert.equal(parsed.envFile, "/s/env.env");
  assert.equal(parsed.logPath, undefined);
  assert.equal(parsed.exitCode, undefined);
});

test("parseArgv: 6 argv elements -> logPath and exitCode (Number) parsed alongside the original 4 fields", () => {
  const argv = ["42", "/wt", "/s/body.txt", "/s/env.env", "/s/issue-42-output.log", "7"];

  const parsed = parseArgv(argv);

  assert.equal(parsed.issueNumber, 42);
  assert.equal(parsed.worktree, "/wt");
  assert.equal(parsed.bodyFile, "/s/body.txt");
  assert.equal(parsed.envFile, "/s/env.env");
  assert.equal(parsed.logPath, "/s/issue-42-output.log");
  assert.equal(parsed.exitCode, 7);
  assert.equal(typeof parsed.exitCode, "number");
});

test("parseArgv: fewer than 4 argv elements throws", () => {
  assert.throws(() => parseArgv(["42", "/wt"]));
});

test("captureExitReason: unlinks the raw log file after reading it (non-PR outcome)", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "raw.log");
    writeLinesLog(logPath, 20);
    const outcome = { outcome: "requeued", issueNumber: 42, hadPr: false, finding: null };

    captureExitReason({ stateDir: dir, outcome, exitCode: 0, logPath, now: () => 1700000000 });

    assert.equal(existsSync(logPath), false, "the raw log file must be unlinked (best-effort) after being read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureExitReason: non-PR outcome with no logPath and no exitCode still writes the reason file, category 'unknown', summary ''", () => {
  const dir = makeTempDir();
  try {
    const outcome = { outcome: "requeued", issueNumber: 42, hadPr: false, finding: null };

    assert.doesNotThrow(() => {
      captureExitReason({ stateDir: dir, outcome, exitCode: undefined, logPath: undefined, now: () => 1700000000 });
    });

    const reasonFile = join(dir, "issue-42-exit-reason.json");
    assert.ok(existsSync(reasonFile), "the reason file must still be written even without a logPath");
    const parsed = JSON.parse(readFileSync(reasonFile, "utf8"));
    assert.equal(parsed.category, "unknown");
    assert.equal(parsed.summary, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureExitReason: 'done' outcome still unlinks the raw log file at logPath, even though no reason file is written", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "raw.log");
    writeLinesLog(logPath, 15);
    const outcome = { outcome: "done", hadPr: true, issueNumber: 42, finding: null };

    captureExitReason({ stateDir: dir, outcome, exitCode: 0, logPath, now: () => 1700000000 });

    assert.equal(existsSync(join(dir, "issue-42-exit-reason.json")), false, "the PR-exists path must never write a reason file");
    assert.equal(existsSync(logPath), false, "the raw (unscrubbed) log file must still be removed on the PR path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCronAExitCli: drives the REAL orchestration — captureExitReason is invoked exactly once, AFTER notifyExit resolves, with stateDir/outcome/logPath/exitCode derived from argv", async () => {
  const dir = makeTempDir();
  try {
    const bodyFile = join(dir, "issue-42-body.txt");
    const envFile = join(dir, "issue-42-env.env");
    const logPath = join(dir, "issue-42-output.log");
    writeFileSync(bodyFile, "the issue body", "utf8");
    writeFileSync(envFile, "SOME_SECRET=abc123", "utf8");
    writeFileSync(logPath, "raw log content", "utf8");
    const argv = ["42", "/fake/worktree", bodyFile, envFile, logPath, "3"];

    const order = [];
    const nonPrOutcome = { outcome: "requeued", issueNumber: 42, hadPr: false, finding: null };

    const cronAExitFake = () => nonPrOutcome;
    const notifyExitFake = async (outcome) => {
      order.push("notifyExit");
      assert.equal(outcome, nonPrOutcome);
    };
    const captureCalls = [];
    const captureExitReasonFake = (args) => {
      order.push("captureExitReason");
      captureCalls.push(args);
    };

    const deps = {
      cronAExit: cronAExitFake,
      notifyExit: notifyExitFake,
      captureExitReason: captureExitReasonFake,
      gh: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0, reset: () => {}, increment: () => {} },
      prExists: () => false,
      blockingFinding: () => null,
      acquireTs: 1000,
      retryCeilingK: 2,
      now: () => 1700000000,
    };

    await runCronAExitCli(argv, deps);

    assert.equal(captureCalls.length, 1, "captureExitReason must be invoked exactly once");
    assert.deepEqual(order, ["notifyExit", "captureExitReason"], "captureExitReason must run AFTER notifyExit resolves");

    const captured = captureCalls[0];
    assert.equal(captured.stateDir, dirname(bodyFile), "stateDir must be derived from dirname(bodyFile)");
    assert.equal(captured.outcome, nonPrOutcome);
    assert.equal(captured.logPath, logPath);
    assert.equal(captured.exitCode, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
