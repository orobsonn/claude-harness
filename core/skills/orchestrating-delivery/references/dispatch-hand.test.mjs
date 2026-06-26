/**
 * @description Contract tests for dispatch-hand.mjs — the "strong eyes, cheap hands"
 * dispatch runner. Every case feeds SYNTHETIC inputs to the pure functions; no real
 * claude/ollama process is spawned. Truth is the scope-checked git diff + locked-test
 * exit code + JSON status, never the model's prose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  REDACTION_MARKER,
  OUTCOME,
  readAuthToken,
  resolveAuthToken,
  redact,
  truncateUpstreamError,
  isBenignCountTokens404,
  hasNonBenignUpstreamError,
  checkScope,
  checkAllowedWrites,
  checkFrozen,
  evaluateRun,
  buildRunRecord,
} from "./dispatch-hand.mjs";

const SCOPE = ["src/feature.ts", "src/feature.test.ts"];
const ALLOWED = ["src/feature.ts"]; // narrower than SCOPE — excludes the frozen test file

/** @description Minimal dispatch descriptor with the given overrides. */
function baseDispatch(overrides = {}) {
  return {
    model: "qwen2.5-coder:7b",
    brief: "implement the feature",
    shared_context: "carry-forward notes",
    scope_paths: SCOPE,
    allowed_writes: ALLOWED,
    ...overrides,
  };
}

/** @description Minimal synthetic child result with the given overrides. */
function baseChild(overrides = {}) {
  return {
    captured: true, // the capture layer attests these fields came from an independent git diff + frozen-test run
    exitCode: 0,
    touchedPaths: ["src/feature.ts"],
    stdout: '{"status":"DONE"}',
    stderr: "",
    lockedTestExitCode: 0,
    prose: "I finished the work.",
    ...overrides,
  };
}

// ---- 1. token leaks NOWHERE (log + captured JSON + record) ----

test("token redaction: literal token appears nowhere in the run record", () => {
  const token = "secret-xyz";
  const dispatch = baseDispatch({
    brief: `do the thing with token ${token} accidentally pasted`,
  });
  const child = baseChild({
    stdout: `auth used ${token} here`,
    stderr: `Authorization: Bearer ${token}`,
  });
  const logs = [`spawning with ANTHROPIC_AUTH_TOKEN=${token}`];

  const record = buildRunRecord({ dispatch, child, token, logs });
  const serialized = JSON.stringify(record);

  assert.ok(
    !serialized.includes(token),
    "literal token must not appear in the serialized run record"
  );
  assert.ok(
    serialized.includes(REDACTION_MARKER),
    "redaction marker must replace the token"
  );
});

test("redact: replaces every occurrence across a multi-channel blob", () => {
  const token = "tok_abc123";
  const blob = `${token} ... line2 ${token} ... line3 ${token}`;
  const out = redact(blob, token);
  assert.ok(!out.includes(token));
  assert.equal(out.split(REDACTION_MARKER).length - 1, 3);
});

test("redact: missing/empty token is a no-op (no crash)", () => {
  assert.equal(redact("nothing here", ""), "nothing here");
  assert.equal(redact("nothing here", undefined), "nothing here");
});

test("readAuthToken: prefers process.env, falls back to .dev.vars content", () => {
  assert.equal(
    readAuthToken({ ANTHROPIC_AUTH_TOKEN: "from-env" }, "ANTHROPIC_AUTH_TOKEN=from-file"),
    "from-env"
  );
  assert.equal(
    readAuthToken({}, "# comment\nANTHROPIC_AUTH_TOKEN=from-file\nOTHER=x"),
    "from-file"
  );
  assert.equal(readAuthToken({}, ""), undefined);
});

test("readAuthToken: OLLAMA_HAND_TOKEN is the preferred env key (CC-inert, sandbox-safe)", () => {
  // The hand-only env key wins over ANTHROPIC_AUTH_TOKEN so the operator can export it locally
  // without hijacking Claude Code's own auth.
  assert.equal(
    readAuthToken({ OLLAMA_HAND_TOKEN: "hand-env", ANTHROPIC_AUTH_TOKEN: "cc-env" }),
    "hand-env"
  );
  // ANTHROPIC_AUTH_TOKEN still resolves (headless/cloud secret) when the hand key is absent.
  assert.equal(readAuthToken({ ANTHROPIC_AUTH_TOKEN: "cc-env" }), "cc-env");
  // .dev.vars fallback accepts either key.
  assert.equal(readAuthToken({}, "OLLAMA_HAND_TOKEN=from-file"), "from-file");
});

// ---- 2. scope violation = run failed (truth is the diff, not prose) ----

test("scope: a child that wrote OUTSIDE scope_paths fails the run", () => {
  const dispatch = baseDispatch();
  const child = baseChild({
    touchedPaths: ["src/feature.ts", "src/secret/other.ts"],
    prose: "All good, success!", // prose lies — diff is the truth
  });
  const violations = checkScope(child.touchedPaths, dispatch.scope_paths);
  assert.deepEqual(violations, ["src/secret/other.ts"]);

  const outcome = evaluateRun({ dispatch, child });
  assert.equal(outcome.status, OUTCOME.FAILED);
  assert.ok(outcome.scopeViolations.includes("src/secret/other.ts"));
});

// ---- 3. allowed-write set is narrower than scope_paths ----

test("allowed-writes: touching inside scope but outside the allow set fails", () => {
  const dispatch = baseDispatch();
  // src/feature.test.ts IS inside scope_paths but NOT in the allowed_writes set.
  const child = baseChild({
    touchedPaths: ["src/feature.ts", "src/feature.test.ts"],
  });
  const scopeViolations = checkScope(child.touchedPaths, dispatch.scope_paths);
  assert.deepEqual(scopeViolations, [], "both paths are within scope_paths");

  const writeViolations = checkAllowedWrites(child.touchedPaths, dispatch.allowed_writes);
  assert.deepEqual(writeViolations, ["src/feature.test.ts"]);

  const outcome = evaluateRun({ dispatch, child });
  assert.equal(outcome.status, OUTCOME.FAILED);
  assert.ok(outcome.allowedWriteViolations.includes("src/feature.test.ts"));
});

// ---- 3b. frozen-manifest write = run failed (auto gate failure, regardless of allowed_writes) ----

test("frozen: a child that wrote a FROZEN manifest path fails, even if allowed_writes permits it", () => {
  // The frozen test file is the rail that makes the cheap hand safe. Put it INSIDE both
  // scope_paths AND allowed_writes to prove the frozen gate fires regardless of those checks.
  const dispatch = baseDispatch({
    allowed_writes: ["src/feature.ts", "src/feature.test.ts"],
    frozen_paths: ["src/feature.test.ts"],
  });
  const child = baseChild({
    touchedPaths: ["src/feature.ts", "src/feature.test.ts"],
    prose: "Tweaked the test to make it pass — all green!", // prose lies; the diff is the truth
  });

  // Even though allowed_writes would permit src/feature.test.ts, the frozen gate must fire.
  const frozenViolations = checkFrozen(child.touchedPaths, dispatch.frozen_paths);
  assert.deepEqual(frozenViolations, ["src/feature.test.ts"]);

  const outcome = evaluateRun({ dispatch, child });
  assert.equal(outcome.status, OUTCOME.FAILED);
  assert.ok(outcome.frozenViolations.includes("src/feature.test.ts"));
  assert.ok(
    outcome.reasons.some((r) => r.includes("frozen-manifest violation")),
    "reason must flag the frozen-manifest violation"
  );
});

// ---- 4. count_tokens 404 is benign ----

test("count_tokens 404 in stderr + in-scope diff + exit 0 => success", () => {
  const stderr =
    "POST https://ollama.com/v1/messages/count_tokens 404 Not Found\nproceeding anyway";
  assert.equal(isBenignCountTokens404(stderr), true);

  const dispatch = baseDispatch();
  const child = baseChild({ exitCode: 0, stderr });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(outcome.status, OUTCOME.DONE);
});

test("isBenignCountTokens404: unrelated 404 is not benign", () => {
  assert.equal(isBenignCountTokens404("GET /v1/models 404"), false);
  assert.equal(isBenignCountTokens404(""), false);
});

// ---- 5. upstream error body truncated to <=500 ----

test("upstream error body >500 chars is truncated to <=500", () => {
  const body = "x".repeat(2000);
  const out = truncateUpstreamError(body);
  assert.ok(out.length <= 500);

  const dispatch = baseDispatch();
  const child = baseChild({
    exitCode: 1,
    upstreamErrorBody: body,
    touchedPaths: [],
  });
  const record = buildRunRecord({ dispatch, child, token: "t", logs: [] });
  assert.ok(record.upstreamErrorBody.length <= 500);
});

test("upstream body: token straddling the 500-char boundary leaves no fragment", () => {
  // 'Z'/'9' chars appear in neither the body filler nor the redaction marker, so any
  // surviving 'Z'/'9' is unambiguously a leaked token fragment.
  const token = "Z9".repeat(20); // 40 chars
  // Token starts at index 480 and runs to 519 — it crosses the 500-char cut line.
  const body = "a".repeat(480) + token + "b".repeat(100);

  const dispatch = baseDispatch();
  const child = baseChild({ exitCode: 1, upstreamErrorBody: body, touchedPaths: [] });
  const record = buildRunRecord({ dispatch, child, token, logs: [] });

  assert.ok(record.upstreamErrorBody.length <= 500);
  assert.ok(
    !record.upstreamErrorBody.includes(token),
    "the full token must not survive in the recorded body"
  );
  assert.ok(
    !/[Z9]/.test(record.upstreamErrorBody),
    "no token FRAGMENT may survive — redact must run before truncate"
  );
});

// ---- 6. empty diff + prose-success => NOT DONE ----

test("prose says success but EMPTY diff => NOT DONE", () => {
  const dispatch = baseDispatch();
  const child = baseChild({
    touchedPaths: [],
    stdout: '{"status":"DONE"}',
    prose: "Successfully implemented everything, all tests pass!",
  });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(outcome.status, OUTCOME.NOT_DONE);
  assert.notEqual(outcome.status, OUTCOME.DONE);
});

test("evaluateRun: a child sourced from model prose is NOT trusted", () => {
  const dispatch = baseDispatch();
  // Same shape as a passing run, but flagged as self-reported by the model.
  const child = baseChild({ source: "model_prose" });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(outcome.status, OUTCOME.NOT_DONE);
  assert.notEqual(outcome.status, OUTCOME.DONE);
});

test("evaluateRun: a child OMITTING `captured` is NOT trusted (fail-closed)", () => {
  const dispatch = baseDispatch();
  // Shape of a passing run, but the capture layer never attested `captured: true`.
  const { captured, ...withoutCaptured } = baseChild();
  const outcome = evaluateRun({ dispatch, child: withoutCaptured });
  assert.equal(outcome.status, OUTCOME.NOT_DONE);
  assert.notEqual(outcome.status, OUTCOME.DONE);
});

test("evaluateRun: locked-test non-zero exit fails an otherwise-clean run", () => {
  const dispatch = baseDispatch();
  const child = baseChild({ lockedTestExitCode: 1 });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(outcome.status, OUTCOME.FAILED);
});

test("evaluateRun: in-scope, in-allow, non-empty diff, exit 0, tests green => DONE", () => {
  const outcome = evaluateRun({ dispatch: baseDispatch(), child: baseChild() });
  assert.equal(outcome.status, OUTCOME.DONE);
});

// ---- locked_test #1: count_tokens 404 on stdout/json channel is benign ----

test("locked#1: count_tokens 404 on stdout (not stderr) is benign — evaluateRun does NOT fail", () => {
  // The child's stderr is empty; the 404 appears only on stdout (or a parsed-json error field).
  const stdout = "POST https://ollama.com/v1/messages/count_tokens 404 Not Found\nsome other output";
  const stderr = ""; // empty — no count_tokens mention on stderr

  // isBenignCountTokens404 must recognise the 404 from the stdout channel too.
  assert.equal(
    isBenignCountTokens404(stderr, stdout),
    true,
    "stdout-only count_tokens 404 must be recognised as benign"
  );

  // evaluateRun must NOT mark the run FAILED for that 404 when the diff is non-empty and locked tests pass.
  const dispatch = baseDispatch();
  const child = baseChild({ exitCode: 1, stderr, stdout });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(
    outcome.status,
    OUTCOME.DONE,
    "a run whose only non-zero exit is a benign count_tokens 404 on stdout must resolve DONE"
  );
});

// ---- locked_test #2: a genuine upstream 500 on stdout is NOT swallowed ----

test("locked#2: genuine upstream 500 on stdout with non-zero exit => FAILED (adjacency guard holds)", () => {
  // A 500 body on stdout does NOT contain the count_tokens adjacency pattern — the guard must hold.
  const stdout = "Internal Server Error 500: quota exceeded";
  const stderr = "";

  assert.equal(
    isBenignCountTokens404(stderr, stdout),
    false,
    "a non-count_tokens upstream error must NOT be treated as benign"
  );

  const dispatch = baseDispatch();
  const child = baseChild({ exitCode: 1, stderr, stdout });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(
    outcome.status,
    OUTCOME.FAILED,
    "a genuine upstream 500 with non-zero exit must fail the run"
  );
});

// ---- locked_test #3: captured stderr is truncated AND redacted (redact before truncate) ----

test("locked#3: buildRunRecord truncates captured stderr <=500 chars AND leaves no token fragment", () => {
  // Token of 'Z9' repeated — chars that appear in neither filler nor the redaction marker.
  // Token starts at index 480, straddles the 500-char cut boundary (runs to 519).
  // Any surviving Z or 9 in the record.stderr is unambiguously a leaked fragment.
  const token = "Z9".repeat(20); // 40 chars
  const childStderr = "a".repeat(480) + token + "b".repeat(100); // 620 chars total

  const dispatch = baseDispatch();
  const child = baseChild({ stderr: childStderr });
  const record = buildRunRecord({ dispatch, child, token, logs: [] });

  assert.ok(
    record.stderr.length <= 500,
    `record.stderr must be <=500 chars; got ${record.stderr.length}`
  );
  assert.ok(
    !record.stderr.includes(token),
    "the full token must not appear in record.stderr"
  );
  assert.ok(
    !/[Z9]/.test(record.stderr),
    "no token FRAGMENT (Z or 9) may survive — redact must run before truncate"
  );
});

// ---- locked_test #4: '--bare' must not appear anywhere in dispatch-hand.mjs ----

test("locked#4: dispatch-hand.mjs contains zero occurrences of the literal string '--bare'", () => {
  // Read the source file from disk — this is the canonical check, not a memory assertion.
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(dir, "dispatch-hand.mjs"), "utf8");

  const occurrences = (src.match(/--bare/g) ?? []).length;
  assert.equal(
    occurrences,
    0,
    `'--bare' must not appear in dispatch-hand.mjs; found ${occurrences} occurrence(s)`
  );
});

// ---- locked_test #5: a benign count_tokens 404 co-occurring with a REAL 500 is NOT swallowed ----

test("locked#5: benign count_tokens 404 + co-occurring upstream 500 on stdout => FAILED (real error not swallowed)", () => {
  // Ollama emits the benign count_tokens 404 on warmup of nearly every call; a real later
  // failure (quota 500) co-occurs on a SEPARATE line. The benign-404 forgiveness must NOT
  // swallow the genuine 500.
  const stdout =
    "POST https://ollama.com/v1/messages/count_tokens 404 Not Found\nInternal Server Error 500: quota exceeded";
  const stderr = "";

  assert.equal(
    isBenignCountTokens404(stderr, stdout),
    true,
    "the warmup 404 line is still recognised as benign"
  );
  assert.equal(
    hasNonBenignUpstreamError(stderr, stdout),
    true,
    "the co-occurring 500 on a non-benign line is a real upstream error"
  );

  const dispatch = baseDispatch();
  const child = baseChild({ exitCode: 1, stderr, stdout });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(
    outcome.status,
    OUTCOME.FAILED,
    "a real upstream 500 co-occurring with a benign warmup 404 must NOT be forgiven"
  );
});

// ---- locked_test #5b: benign 404 and a REAL 500 SHARING THE SAME LINE is NOT swallowed ----

test("locked#5b: benign count_tokens 404 + co-occurring upstream 500 on the SAME line => FAILED", () => {
  // The real 500 sits on the SAME physical line as the benign warmup 404 (no newline). A
  // per-line wholesale skip would forgive the whole line and swallow the genuine 500; the
  // strip-and-rescan must remove only the count_tokens…404 span and still catch the 500.
  const stdout =
    "POST https://ollama.com/v1/messages/count_tokens 404 Not Found - upstream 500 quota exceeded";
  const stderr = "";

  assert.equal(
    isBenignCountTokens404(stderr, stdout),
    true,
    "the warmup 404 span on the line is still recognised as benign"
  );
  assert.equal(
    hasNonBenignUpstreamError(stderr, stdout),
    true,
    "the co-occurring 500 sharing the benign line is a real upstream error"
  );

  const dispatch = baseDispatch();
  const child = baseChild({ exitCode: 1, stderr, stdout });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(
    outcome.status,
    OUTCOME.FAILED,
    "a real upstream 500 sharing the benign warmup-404 line must NOT be forgiven"
  );
});

// ---- locked_test #5c: a REAL code BEFORE the 404 on the SAME line is NOT swallowed ----

test("locked#5c: upstream 500 BEFORE the count_tokens 404 on the same line => FAILED (position-independent)", () => {
  // A warmup 500 sits BEFORE the benign count_tokens 404 on one physical line. The old
  // positional strip swallowed a code that preceded the benign span; the position-independent
  // test must catch it.
  const stdout = "count_tokens 500 warmup then 404 Not Found";
  const stderr = "";

  assert.equal(
    hasNonBenignUpstreamError(stderr, stdout),
    true,
    "a 500 preceding the benign 404 is a real upstream error regardless of position"
  );

  const dispatch = baseDispatch();
  const child = baseChild({ exitCode: 1, stderr, stdout });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(
    outcome.status,
    OUTCOME.FAILED,
    "a real upstream 500 before the benign 404 must NOT be forgiven"
  );
});

// ---- locked_test #5d: a REAL code BETWEEN two benign count_tokens-404 spans is NOT swallowed ----

test("locked#5d: upstream 500 BETWEEN two count_tokens-404 spans on one line => FAILED (position-independent)", () => {
  // The real 500 sits BETWEEN two benign count_tokens 404 spans on a single line. The old
  // positional strip could window past the intervening code; the position-independent test
  // must catch it.
  const stdout = "count_tokens warmup 404 then 500 then count_tokens 404";
  const stderr = "";

  assert.equal(
    hasNonBenignUpstreamError(stderr, stdout),
    true,
    "a 500 between two benign 404 spans is a real upstream error regardless of position"
  );

  const dispatch = baseDispatch();
  const child = baseChild({ exitCode: 1, stderr, stdout });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(
    outcome.status,
    OUTCOME.FAILED,
    "a real upstream 500 between two benign 404 spans must NOT be forgiven"
  );
});

// ---- locked_test #6: captured stdout is truncated AND redacted (redact before truncate) ----

test("locked#6: buildRunRecord truncates captured stdout <=500 chars AND leaves no token fragment", () => {
  // Token of 'Z9' repeated — chars that appear in neither filler nor the redaction marker.
  // Token starts at index 480, straddles the 500-char cut boundary (runs to 519).
  // Any surviving Z or 9 in the record.stdout is unambiguously a leaked fragment.
  const token = "Z9".repeat(20); // 40 chars
  const childStdout = "a".repeat(480) + token + "b".repeat(100); // 620 chars total

  const dispatch = baseDispatch();
  const child = baseChild({ stdout: childStdout });
  const record = buildRunRecord({ dispatch, child, token, logs: [] });

  assert.ok(
    record.stdout.length <= 500,
    `record.stdout must be <=500 chars; got ${record.stdout.length}`
  );
  assert.ok(
    !record.stdout.includes(token),
    "the full token must not appear in record.stdout"
  );
  assert.ok(
    !/[Z9]/.test(record.stdout),
    "no token FRAGMENT (Z or 9) may survive — redact must run before truncate"
  );
});

// ---- locked_test #7: a directory entry WITHOUT a trailing slash covers files under it ----

test("locked#7: a no-trailing-slash directory entry covers files beneath it, consistent with the git-pathspec guard", () => {
  // The pre-spawn guard scopes via `git status --porcelain -- core/x`, where git treats `core/x`
  // as a directory prefix (by path component). checkScope must agree: a directory entry written
  // WITHOUT the trailing slash (the form a planner may emit) must cover everything under it — not
  // demand an exact file match. Before the fix, this dispatch ALWAYS failed in capture (the guard
  // covered the files by prefix while checkScope did not) — a confusing latent trap.
  const scopePaths = ["core/x"]; // directory entry, no trailing slash

  // Files UNDER the directory are covered → no scope violation.
  assert.deepEqual(
    checkScope(["core/x/new.mjs", "core/x/sub/deep.mjs"], scopePaths),
    [],
    "files beneath a no-slash directory entry must be in scope"
  );

  // The directory path itself (an exact-file match) is still covered.
  assert.deepEqual(
    checkScope(["core/x"], scopePaths),
    [],
    "the exact entry path must remain covered"
  );

  // A SIBLING that merely shares the string prefix is NOT covered — matching git's
  // path-component boundary, so `core/x` never bleeds into `core/xyz.mjs`.
  assert.deepEqual(
    checkScope(["core/xyz.mjs"], scopePaths),
    ["core/xyz.mjs"],
    "a string-prefix sibling must NOT be covered — git matches by path component"
  );

  // The trailing slash is cosmetic: `core/x` and `core/x/` cover identically.
  assert.deepEqual(
    checkScope(["core/x/new.mjs", "core/xyz.mjs"], ["core/x"]),
    checkScope(["core/x/new.mjs", "core/xyz.mjs"], ["core/x/"]),
    "a directory entry with and without a trailing slash must cover identically"
  );

  // Out-of-contract git-pathspec MAGIC entries fail CLOSED — an empty or "/" entry must cover
  // NOTHING (never match-all), so a stray entry can never silently authorize every write.
  assert.deepEqual(
    checkScope(["core/x/new.mjs"], [""]),
    ["core/x/new.mjs"],
    "an empty entry must cover nothing — fail closed, never match-all"
  );
  assert.deepEqual(
    checkScope(["core/x/new.mjs"], ["/"]),
    ["core/x/new.mjs"],
    "a bare '/' entry (empty base) must cover nothing — fail closed"
  );

  // The same normalization governs the full coverage end-to-end through evaluateRun: a hand
  // that wrote a file under the no-slash directory entry reaches DONE (no spurious scope fail).
  const dispatch = baseDispatch({ scope_paths: ["core/x"], allowed_writes: ["core/x"] });
  const child = baseChild({ touchedPaths: ["core/x/new.mjs"] });
  const outcome = evaluateRun({ dispatch, child });
  assert.equal(
    outcome.status,
    OUTCOME.DONE,
    "a write under a no-slash directory scope entry must NOT trip a scope violation"
  );
});

// ---- locked_tests: resolveAuthToken global fallback ----

test("resolveAuthToken: env wins — cwd/global readFileSafe never consulted", () => {
  let readFileSafeCalled = false;
  const readFileSafe = () => {
    readFileSafeCalled = true;
    return "";
  };
  const result = resolveAuthToken(
    { ANTHROPIC_AUTH_TOKEN: "from-env" },
    { cwd: "/fake-cwd", homeDir: "/fake-home", readFileSafe }
  );
  assert.equal(result, "from-env", "env token must win");
  assert.equal(readFileSafeCalled, false, "readFileSafe must not be consulted when env carries the token");
});

test("resolveAuthToken: cwd/.dev.vars beats global when env is empty", () => {
  const fakeCwd = "/fake-cwd";
  const fakeHome = "/fake-home";
  const cwdVars = "/fake-cwd/.dev.vars";
  const globalVars = "/fake-home/.claude/.dev.vars";
  const readFileSafe = (p) => {
    if (p === cwdVars) return "ANTHROPIC_AUTH_TOKEN=from-cwd";
    if (p === globalVars) return "";
    return "";
  };
  const result = resolveAuthToken(
    {},
    { cwd: fakeCwd, homeDir: fakeHome, readFileSafe }
  );
  assert.equal(result, "from-cwd", "cwd/.dev.vars must beat the global file");
});

test("resolveAuthToken: global fallback fires when env and cwd are both empty", () => {
  const fakeCwd = "/fake-cwd";
  const fakeHome = "/fake-home";
  const cwdVars = "/fake-cwd/.dev.vars";
  const globalVars = "/fake-home/.claude/.dev.vars";
  const readFileSafe = (p) => {
    if (p === cwdVars) return "";
    if (p === globalVars) return "ANTHROPIC_AUTH_TOKEN=from-global";
    return "";
  };
  const result = resolveAuthToken(
    {},
    { cwd: fakeCwd, homeDir: fakeHome, readFileSafe }
  );
  assert.equal(result, "from-global", "global ~/.claude/.dev.vars must be the final fallback");
});

test("resolveAuthToken: returns undefined when env and both files are empty", () => {
  const readFileSafe = () => "";
  const result = resolveAuthToken(
    {},
    { cwd: "/fake-cwd", homeDir: "/fake-home", readFileSafe }
  );
  assert.equal(result, undefined, "must return undefined when no source has the token");
});
