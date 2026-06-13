/**
 * @description Contract tests for capture-hand.mjs — the INDEPENDENT capture that turns a
 * finished cheap-hand child into the harness-controlled child result feeding evaluateRun.
 * The HARNESS (never the model prose) builds touchedPaths (union diff + untracked) and the
 * locked-test exit, runs the frozen test ITSELF, redacts the token before any sink/disk, and
 * fails-closed on a dirty/divergent tree. Every dependency (git, testRunner, logSink, fs) is
 * INJECTED — no real process/git/disk-of-record is exercised here beyond an ephemeral tmp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OUTCOME, readAuthToken, UPSTREAM_BODY_MAX } from "./dispatch-hand.mjs";
import { captureResult } from "./capture-hand.mjs";

const FREEZE_SHA = "abc123freeze";

/** @description A fake git whose every method is overridable per test. */
function fakeGit(overrides = {}) {
  return {
    headSha: () => FREEZE_SHA,
    statusPorcelain: () => "",
    diffNameOnly: () => [],
    lsFilesOthers: () => [],
    lsFilesAllOthers: () => [],
    ...overrides,
  };
}

/** @description A fake test runner returning a canned `# tests N` stdout + exit code. */
function fakeTestRunner(overrides = {}) {
  return {
    stdout: "# tests 3\n# pass 3\n# fail 0\n",
    stderr: "",
    exitCode: 0,
    ...overrides,
  };
}

/** @description Minimal dispatch descriptor. */
function baseDispatch(overrides = {}) {
  return {
    model: "qwen2.5-coder:7b",
    scope_paths: ["core/x/new.mjs"],
    allowed_writes: ["core/x/new.mjs"],
    frozen_paths: [],
    ...overrides,
  };
}

/** @description Minimal finished child (the cheap hand's raw spawn result). */
function baseChild(overrides = {}) {
  return {
    exitCode: 0,
    stdout: "I finished the work, all green!",
    stderr: "",
    ...overrides,
  };
}

/** @description Collects every line delivered to an injected log sink. */
function collectingSink() {
  const lines = [];
  const sink = (line) => lines.push(line);
  sink.lines = lines;
  return sink;
}

/** @description Recursively lists every file under a directory. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const TEST_PATH = "core/x/new.test.mjs";

function baseArgs(overrides = {}) {
  return {
    dispatch: baseDispatch(),
    child: baseChild(),
    freezeCommitSha: FREEZE_SHA,
    testPath: TEST_PATH,
    git: fakeGit(),
    testRunner: () => fakeTestRunner(),
    logSink: () => {},
    token: "fake-token-for-tests",
    keepArtifacts: false,
    ...overrides,
  };
}

// ---- 1. untracked new file is captured via ls-files, not read as empty diff ----

test("touchedPaths unions untracked files: new file captured even when diff is empty", () => {
  const result = captureResult(
    baseArgs({
      git: fakeGit({
        diffNameOnly: () => [],
        lsFilesOthers: () => ["core/x/new.mjs"],
      }),
    })
  );
  assert.deepEqual(result.child.touchedPaths, ["core/x/new.mjs"]);
});

// ---- 2. zero collected tests is NEVER a pass (vacuous-green guard) ----

test("vacuous-green guard: `# tests 0` exit 0 yields a FAILED outcome", () => {
  const result = captureResult(
    baseArgs({
      git: fakeGit({ lsFilesOthers: () => ["core/x/new.mjs"] }),
      testRunner: () => fakeTestRunner({ stdout: "# tests 0\n# pass 0\n", exitCode: 0 }),
    })
  );
  assert.equal(result.outcome.status, OUTCOME.FAILED);
});

// ---- 2b. stdout-injection cannot defeat the vacuous-green guard (LAST `# tests N` wins) ----

test("injected top-of-stream `# tests 999` is ignored; trailing TAP `# tests 0` → FAILED", () => {
  // A non-frozen in-scope source the frozen test imports could emit `# tests 999` at module-load,
  // landing ABOVE the real TAP summary. parseTestsCount must read the LAST full-line match (the
  // genuine trailing `# tests 0`), full-line anchored so a mid-line `# tests 999 fake` cannot match.
  const result = captureResult(
    baseArgs({
      git: fakeGit({ lsFilesOthers: () => ["core/x/new.mjs"] }),
      testRunner: () =>
        fakeTestRunner({
          stdout:
            "# tests 999\nTAP version 13\nok 1 - placeholder\n# tests 999 fake\n# tests 0\n# pass 0\n",
          exitCode: 0,
        }),
    })
  );
  assert.equal(result.child.testsCount, 0);
  assert.equal(result.outcome.status, OUTCOME.FAILED);
});

// ---- 3. dirty / divergent tree before spawn → critical exception, never captured ----

test("divergent HEAD before capture → critical-exception signal, captured never true", () => {
  const result = captureResult(
    baseArgs({ git: fakeGit({ headSha: () => "different-sha" }) })
  );
  assert.equal(result.criticalException, true);
  assert.notEqual(result.captured, true);
  assert.notEqual(result.child?.captured, true);
});

test("HEAD == freeze_sha with a dirty tree (the hand's work) → NOT a critical exception; captures", () => {
  const result = captureResult(
    baseArgs({
      git: fakeGit({
        // HEAD unchanged, but the tree is dirty: the hand modified a tracked file AND added a
        // new untracked one. Real git reports both; this is the EXPECTED post-hoc state, not a
        // failure. The fix removed the post-hoc clean-tree precondition that made this the only
        // path real git could ever produce — proving a successful hand now reaches capture.
        statusPorcelain: () => " M core/x/new.mjs\n?? core/x/extra.mjs\n",
        diffNameOnly: () => ["core/x/new.mjs"],
        lsFilesOthers: () => ["core/x/extra.mjs"],
      }),
      dispatch: baseDispatch({
        scope_paths: ["core/x/new.mjs", "core/x/extra.mjs"],
        allowed_writes: ["core/x/new.mjs", "core/x/extra.mjs"],
      }),
    })
  );
  assert.notEqual(result.criticalException, true);
  assert.equal(result.captured, true);
  assert.equal(result.child.captured, true);
  assert.deepEqual(result.child.touchedPaths, ["core/x/new.mjs", "core/x/extra.mjs"]);
});

// ---- 4. prose claims success but union diff is EMPTY → captured:true from capture, NOT_DONE ----

test("empty git capture overrides success prose: captured:true, evaluateRun NOT_DONE", () => {
  const result = captureResult(
    baseArgs({
      child: baseChild({ stdout: "SUCCESS: implemented core/x/new.mjs, all tests pass" }),
      git: fakeGit({ diffNameOnly: () => [], lsFilesOthers: () => [] }),
    })
  );
  assert.equal(result.child.captured, true);
  assert.deepEqual(result.child.touchedPaths, []);
  assert.equal(result.outcome.status, OUTCOME.NOT_DONE);
});

// ---- 4b. gitignored out-of-scope write is recovered via no-exclude sweep → scope violation ----

test("gitignored out-of-scope write escapes --exclude-standard but is flagged via lsFilesAllOthers → FAILED", () => {
  const result = captureResult(
    baseArgs({
      git: fakeGit({
        diffNameOnly: () => ["core/x/new.mjs"],
        // --exclude-standard hides the gitignored write; the no-exclude sweep reports it.
        lsFilesOthers: () => [],
        lsFilesAllOthers: () => ["core/x/new.mjs", "dist/sneak.js"],
      }),
    })
  );
  assert.ok(
    result.child.touchedPaths.includes("dist/sneak.js"),
    "gitignored out-of-scope path must be appended to touchedPaths"
  );
  assert.equal(result.outcome.status, OUTCOME.FAILED);
  assert.ok(result.outcome.scopeViolations.includes("dist/sneak.js"));
});

// ---- 4c. gitignored IN-SCOPE FROZEN write is recovered → frozen violation, FAILED ----

test("gitignored in-scope FROZEN write reaches touchedPaths → evaluateRun FAILED with frozen violation", () => {
  const frozen = "core/x/new.test.mjs";
  const result = captureResult(
    baseArgs({
      // The frozen path is IN scope (scope ⊃ frozen), so a scope-only sweep would NOT flag it.
      // The union over checkFrozen recovers the gitignored write and surfaces it to evaluateRun.
      dispatch: baseDispatch({
        scope_paths: ["core/x/new.mjs", frozen],
        allowed_writes: ["core/x/new.mjs"],
        frozen_paths: [frozen],
      }),
      git: fakeGit({
        diffNameOnly: () => ["core/x/new.mjs"],
        lsFilesOthers: () => [],
        lsFilesAllOthers: () => ["core/x/new.mjs", frozen],
      }),
    })
  );
  assert.ok(
    result.child.touchedPaths.includes(frozen),
    "gitignored in-scope frozen path must be appended to touchedPaths"
  );
  assert.equal(result.outcome.status, OUTCOME.FAILED);
  assert.ok(result.outcome.frozenViolations.includes(frozen));
});

// ---- 4d. CLI wiring resolves a token (NOT undefined) → live artifacts are redacted ----

test("token wiring: a resolved .dev.vars/env token redacts captured artifacts (CLI must not pass undefined)", () => {
  const token = "secret-ollama-token-xyz";
  // The CLI resolves the token via readAuthToken(process.env, devVars). Lock that wiring: a token
  // carried by either source resolves, and that resolved token — passed into captureResult —
  // redacts the live artifacts. Passing undefined (the prior CLI bug) would leave the token raw.
  assert.equal(readAuthToken({ ANTHROPIC_AUTH_TOKEN: token }, ""), token);
  assert.equal(readAuthToken({}, `ANTHROPIC_AUTH_TOKEN=${token}\n`), token);

  const resolved = readAuthToken({}, `ANTHROPIC_AUTH_TOKEN=${token}\n`);
  const result = captureResult(
    baseArgs({
      git: fakeGit({ lsFilesOthers: () => ["core/x/new.mjs"] }),
      child: baseChild({ stdout: `echoing env ${token}`, stderr: `401 body ${token}` }),
      token: resolved,
      keepArtifacts: true,
    })
  );

  const dir = result.artifactDir;
  assert.ok(dir && existsSync(dir), "artifact dir must exist when keepArtifacts");
  for (const file of walk(dir)) {
    assert.equal(
      readFileSync(file, "utf8").includes(token),
      false,
      `resolved token leaked into ${file} — CLI must pass the token, never undefined`
    );
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---- 5. token leaks NOWHERE across every written on-disk artifact ----

test("redaction on disk: token absent from result.json + cost NDJSON artifacts", () => {
  const token = "secret-ollama-token-xyz";
  const result = captureResult(
    baseArgs({
      git: fakeGit({ lsFilesOthers: () => ["core/x/new.mjs"] }),
      child: baseChild({
        stdout: `working with ${token} now`,
        stderr: `auth ${token}`,
      }),
      token,
      costStream: [
        { event: "usage", token, cost: 0.01 },
        { event: "done", note: `billed ${token}` },
      ],
      keepArtifacts: true,
    })
  );

  const dir = result.artifactDir;
  assert.ok(dir && existsSync(dir), "artifact dir must exist when keepArtifacts");
  const files = walk(dir);
  assert.ok(files.length >= 2, "expected result.json + cost stream written");
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.equal(content.includes(token), false, `token leaked into ${file}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---- 6. token redacted BEFORE the injected sink (per-line tee), not only before disk ----

test("live tee redaction: injected sink never receives the raw token", () => {
  const token = "secret-ollama-token-xyz";
  const sink = collectingSink();
  captureResult(
    baseArgs({
      git: fakeGit({ lsFilesOthers: () => ["core/x/new.mjs"] }),
      child: baseChild({
        stdout: `line one ${token} line two`,
        stderr: `err ${token}`,
      }),
      token,
      logSink: sink,
    })
  );
  assert.ok(sink.lines.length > 0, "sink must receive tee'd child lines");
  for (const line of sink.lines) {
    assert.equal(line.includes(token), false, `token leaked to sink: ${line}`);
  }
});

// ---- 7. undefined token fails closed (silent no-op redaction is never allowed) ----

test("captureResult throws when token is undefined (fail-closed, never silent no-op redaction)", () => {
  assert.throws(
    () => captureResult(baseArgs({ token: undefined })),
    /requires a resolved auth token/
  );
});

// ---- 8. git adapter without lsFilesAllOthers fails closed (gitignore-escape sweep mandatory) ----

test("captureResult throws when git adapter omits lsFilesAllOthers (sweep cannot be silently disabled)", () => {
  const partialGit = fakeGit();
  delete partialGit.lsFilesAllOthers;
  assert.throws(
    () => captureResult(baseArgs({ git: partialGit })),
    /must provide lsFilesAllOthers/
  );
});

// ---- 9. stderr/stdout in persisted result.json are length-truncated AND token-redacted,
//         while evaluateRun still sees the full stream for benign-404 detection ----

test("persisted result.json: stderr truncated to <=500 chars, token absent, evaluateRun still classifies benign count_tokens 404 from full stderr", () => {
  // The token straddles the 500-char boundary using the 'Z9' distinctive-char trick:
  // the token starts near char 490 so its first chars fall before 500 and the rest after —
  // confirming the truncation point does not accidentally preserve a token fragment.
  const token = "Z9Z9Z9-secret-ollama-token";
  const benign404Prefix = "count_tokens request failed with 404 not found\n";
  // Fill to position 490 with 'A', then embed the token straddling the 500 boundary.
  const filler = "A".repeat(490 - benign404Prefix.length);
  const longStderr = benign404Prefix + filler + token + "B".repeat(200);
  // Sanity: the full stderr is well over 500 chars and the token straddles the cut.
  assert.ok(longStderr.length > 500, "stderr must be longer than UPSTREAM_BODY_MAX for this test");
  assert.ok(longStderr.indexOf(token) < 500, "token must start before the truncation point");
  assert.ok(longStderr.indexOf(token) + token.length > 500, "token must straddle the truncation boundary");

  const result = captureResult(
    baseArgs({
      git: fakeGit({ lsFilesOthers: () => ["core/x/new.mjs"] }),
      child: baseChild({ exitCode: 1, stdout: "", stderr: longStderr }),
      token,
      keepArtifacts: true,
    })
  );

  // (a) evaluateRun used the FULL stderr → benign count_tokens 404 was recognised, so the
  //     non-zero child exit does NOT produce FAILED (only NOT_DONE from empty diff, which
  //     is overridden here by touchedPaths being non-empty → FAILED from locked-test exit is
  //     the actual reason, but the child exit itself was forgiven by isBenignCountTokens404).
  //     We assert the outcome is NOT "FAILED due to child exit" by checking reasons.
  assert.ok(
    !result.outcome.reasons.some((r) => r.startsWith("child exited")),
    `benign count_tokens 404 should have been forgiven in the full stderr; reasons: ${result.outcome.reasons}`
  );

  // (b) persisted result.json: stderr field is <=500 chars AND contains no token fragment.
  const dir = result.artifactDir;
  assert.ok(dir && existsSync(dir), "artifact dir must exist when keepArtifacts");
  const resultJson = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  const persistedStderr = resultJson.child.stderr;
  assert.ok(
    typeof persistedStderr === "string" && persistedStderr.length <= UPSTREAM_BODY_MAX,
    `persisted stderr must be <=${UPSTREAM_BODY_MAX} chars; got ${typeof persistedStderr === "string" ? persistedStderr.length : typeof persistedStderr}`
  );
  assert.equal(
    persistedStderr.includes(token),
    false,
    "no token fragment must survive in the persisted stderr"
  );
  // Also verify the raw token string is absent anywhere in the file.
  const raw = readFileSync(join(dir, "result.json"), "utf8");
  assert.equal(raw.includes(token), false, "token must not appear anywhere in result.json");

  rmSync(dir, { recursive: true, force: true });
});
