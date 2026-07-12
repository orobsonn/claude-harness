/**
 * @description Locked tests for capture-oracle pure module (T7).
 * t7-no-prose-done, t7-enum, t7-no-tests-done + pure helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  OUTCOME,
  OUTCOME_VALUES,
  checkScope,
  checkFrozen,
  checkAllowedWrites,
  excludeHarnessInternal,
  isHarnessInternalPath,
  evaluateRun,
  parseTestsCount,
  subtractUnchanged,
} from "./capture-oracle.mjs";

function baseDispatch(over = {}) {
  return {
    scope_paths: ["src/"],
    frozen_paths: ["src/feature.test.mjs"],
    allowed_writes: ["src/feature.mjs"],
    ...over,
  };
}

function baseChild(over = {}) {
  return {
    captured: true,
    touchedPaths: ["src/feature.mjs"],
    lockedTestExitCode: 0,
    testsCount: 1,
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...over,
  };
}

// ---- t7-enum ----

test("t7-enum: closed outcome enum values only DONE FAILED NOT_DONE CONFIG_ERROR CAPTURE_ERROR", () => {
  assert.deepEqual(
    [...OUTCOME_VALUES].sort(),
    ["CAPTURE_ERROR", "CONFIG_ERROR", "DONE", "FAILED", "NOT_DONE"].sort()
  );
  assert.equal(OUTCOME.DONE, "DONE");
  assert.equal(OUTCOME.FAILED, "FAILED");
  assert.equal(OUTCOME.NOT_DONE, "NOT_DONE");
  assert.equal(OUTCOME.CONFIG_ERROR, "CONFIG_ERROR");
  assert.equal(OUTCOME.CAPTURE_ERROR, "CAPTURE_ERROR");
  assert.equal(OUTCOME_VALUES.size, 5);
});

// ---- t7-no-prose-done ----

test("t7-no-prose-done: evaluateRun never returns DONE from prose or exit-code-only success", () => {
  // Prose claims success, empty diff, exit 0
  const proseOnly = evaluateRun({
    dispatch: baseDispatch(),
    child: baseChild({
      touchedPaths: [],
      exitCode: 0,
      stdout: "Status: DONE — all tests pass!",
    }),
  });
  assert.equal(proseOnly.ok, true);
  assert.notEqual(proseOnly.outcome, OUTCOME.DONE);
  assert.equal(proseOnly.outcome, OUTCOME.NOT_DONE);

  // model_prose source with otherwise-green shape
  const modelProse = evaluateRun({
    dispatch: baseDispatch(),
    child: baseChild({ source: "model_prose" }),
  });
  assert.equal(modelProse.ok, true);
  assert.notEqual(modelProse.outcome, OUTCOME.DONE);
  assert.equal(modelProse.outcome, OUTCOME.NOT_DONE);

  // missing captured attestation + exit 0
  const noCapture = evaluateRun({
    dispatch: baseDispatch(),
    child: {
      touchedPaths: ["src/feature.mjs"],
      lockedTestExitCode: 0,
      testsCount: 1,
      exitCode: 0,
    },
  });
  assert.equal(noCapture.ok, true);
  assert.notEqual(noCapture.outcome, OUTCOME.DONE);
  assert.equal(noCapture.outcome, OUTCOME.NOT_DONE);

  // exitCode 0 alone never upgrades empty/untrusted to DONE
  const exitOnly = evaluateRun({
    dispatch: baseDispatch(),
    child: { captured: true, touchedPaths: [], exitCode: 0, lockedTestExitCode: 0 },
  });
  assert.equal(exitOnly.outcome, OUTCOME.NOT_DONE);
});

test("evaluateRun: green independent capture reaches DONE", () => {
  const r = evaluateRun({ dispatch: baseDispatch(), child: baseChild() });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, OUTCOME.DONE);
});

test("evaluateRun: scope violation is FAILED", () => {
  const r = evaluateRun({
    dispatch: baseDispatch(),
    child: baseChild({ touchedPaths: ["src/feature.mjs", "secrets/x.ts"] }),
  });
  assert.equal(r.outcome, OUTCOME.FAILED);
  assert.ok(r.details.scopeViolations.includes("secrets/x.ts"));
});

test("evaluateRun: frozen path touch is FAILED", () => {
  const r = evaluateRun({
    dispatch: baseDispatch({ allowed_writes: ["src/feature.mjs", "src/feature.test.mjs"] }),
    child: baseChild({
      touchedPaths: ["src/feature.mjs", "src/feature.test.mjs"],
    }),
  });
  assert.equal(r.outcome, OUTCOME.FAILED);
  assert.ok(r.details.frozenViolations.includes("src/feature.test.mjs"));
});

test("evaluateRun: red locked tests is FAILED", () => {
  const r = evaluateRun({
    dispatch: baseDispatch(),
    child: baseChild({ lockedTestExitCode: 1 }),
  });
  assert.equal(r.outcome, OUTCOME.FAILED);
});

test("evaluateRun: vacuous green (testsCount 0) is FAILED", () => {
  const r = evaluateRun({
    dispatch: baseDispatch(),
    child: baseChild({ testsCount: 0, lockedTestExitCode: 0 }),
  });
  assert.equal(r.outcome, OUTCOME.FAILED);
});

// ---- t7-no-tests-done ----

test("t7-no-tests-done: no_tests true tasks can DONE without test re-run when scope and frozen ok", () => {
  const r = evaluateRun({
    dispatch: baseDispatch({ no_tests: true }),
    child: baseChild({
      lockedTestExitCode: undefined,
      testsCount: undefined,
    }),
    task: { no_tests: true },
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, OUTCOME.DONE);

  // Even with red-looking test fields, no_tests skips them
  const r2 = evaluateRun({
    dispatch: baseDispatch(),
    child: baseChild({ lockedTestExitCode: 1, testsCount: 0 }),
    task: { no_tests: true },
  });
  assert.equal(r2.outcome, OUTCOME.DONE);

  // Still not DONE on empty diff
  const empty = evaluateRun({
    dispatch: baseDispatch({ no_tests: true }),
    child: baseChild({ touchedPaths: [], no_tests: true }),
  });
  assert.equal(empty.outcome, OUTCOME.NOT_DONE);

  // Still FAILED on scope violation
  const scope = evaluateRun({
    dispatch: baseDispatch({ no_tests: true }),
    child: baseChild({ touchedPaths: ["out/of/scope.ts"] }),
    task: { no_tests: true },
  });
  assert.equal(scope.outcome, OUTCOME.FAILED);
});

// ---- helpers ----

test("checkScope / checkFrozen / checkAllowedWrites", () => {
  assert.deepEqual(checkScope(["a.ts", "b.ts"], ["a.ts"]), ["b.ts"]);
  assert.deepEqual(checkFrozen(["a.ts", "t.ts"], ["t.ts"]), ["t.ts"]);
  assert.deepEqual(checkAllowedWrites(["a.ts", "b.ts"], ["a.ts"]), ["b.ts"]);
  assert.deepEqual(checkScope(["src/x.ts"], ["src/"]), []);
});

test("excludeHarnessInternal / isHarnessInternalPath", () => {
  assert.equal(isHarnessInternalPath(".claude/.harness-version-check-cache"), true);
  assert.equal(isHarnessInternalPath(".opencode/.harness-version-check-cache"), true);
  assert.equal(isHarnessInternalPath(".claude/.harness-version-check-cache-evil"), false);
  assert.deepEqual(
    excludeHarnessInternal([
      "src/a.ts",
      ".claude/.harness-version-check-cache",
      ".opencode/.harness-version-check-cache.tmp",
    ]),
    ["src/a.ts"]
  );
});

test("parseTestsCount", () => {
  assert.equal(parseTestsCount("# tests 3\n# pass 3\n"), 3);
  assert.equal(parseTestsCount("no marker"), null);
  assert.equal(parseTestsCount("# tests 1\n# tests 5\n"), 5);
});

test("subtractUnchanged", () => {
  const pre = new Map([
    ["dist/junk.js", "h1"],
    ["keep-edited.js", "old"],
  ]);
  const cur = new Map([
    ["dist/junk.js", "h1"],
    ["keep-edited.js", "new"],
    ["brand-new.js", "x"],
  ]);
  const paths = ["dist/junk.js", "keep-edited.js", "brand-new.js"];
  assert.deepEqual(subtractUnchanged(paths, pre, cur), [
    "keep-edited.js",
    "brand-new.js",
  ]);
});

test("evaluateRun never throws on garbage", () => {
  assert.doesNotThrow(() => evaluateRun(null));
  assert.doesNotThrow(() => evaluateRun(undefined));
  assert.doesNotThrow(() => evaluateRun("x"));
  assert.equal(evaluateRun(null).ok, false);
  assert.equal(evaluateRun({}).ok, false);
});
