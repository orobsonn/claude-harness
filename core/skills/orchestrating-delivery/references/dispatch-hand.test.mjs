/**
 * @description Contract tests for dispatch-hand.mjs — the "strong eyes, cheap hands"
 * dispatch runner. Every case feeds SYNTHETIC inputs to the pure functions; no real
 * claude/ollama process is spawned. Truth is the scope-checked git diff + locked-test
 * exit code + JSON status, never the model's prose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REDACTION_MARKER,
  OUTCOME,
  readAuthToken,
  redact,
  truncateUpstreamError,
  isBenignCountTokens404,
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
