/**
 * @description Pins `normalizeGhResult(args, res)`, the pure normalization function extracted
 * from `defaultGhExec` to fix the `gh pr diff <n> --name-only` shape bug: without `--json`,
 * the old normalizer always returned `{ok}`, but the review phase needs a `string[]` of changed
 * file paths from `pr diff --name-only`. These tests pin the exact contract (see file header of
 * gh-exec.mjs) so the fix can't silently regress back to `{ok}` for the diff branch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGhResult, defaultGhExec, scopedGh } from "./gh-exec.mjs";

test("--json list call returns the parsed array", () => {
  const result = normalizeGhResult(
    ["pr", "list", "--json", "number"],
    { status: 0, stdout: '[{"number":1},{"number":2}]' }
  );
  assert.deepEqual(result, [{ number: 1 }, { number: 2 }]);
});

test("--json view call returns the parsed object", () => {
  const result = normalizeGhResult(
    ["pr", "view", "5", "--json", "title"],
    { status: 0, stdout: '{"title":"t"}' }
  );
  assert.deepEqual(result, { title: "t" });
});

test("--json call that failed (non-zero status) returns [] (fail-closed)", () => {
  const result = normalizeGhResult(["pr", "list", "--json", "x"], { status: 1 });
  assert.deepEqual(result, []);
});

test("--json call with unparseable stdout returns [] (fail-closed)", () => {
  const result = normalizeGhResult(
    ["pr", "list", "--json", "x"],
    { status: 0, stdout: "not json" }
  );
  assert.deepEqual(result, []);
});

test("non-json mutating call returns {ok:true} on success and {ok:false} on failure", () => {
  const success = normalizeGhResult(
    ["issue", "edit", "5", "--add-label", "x"],
    { status: 0 }
  );
  assert.deepEqual(success, { ok: true });

  const failure = normalizeGhResult(
    ["issue", "edit", "5", "--add-label", "x"],
    { status: 1 }
  );
  assert.deepEqual(failure, { ok: false });
});

test("THE FIX -- pr diff --name-only returns a string[] of file paths, not an {ok} object", () => {
  const result = normalizeGhResult(
    ["pr", "diff", "5", "--name-only"],
    { status: 0, stdout: "core/vps/a.js\nsrc/b.ts\n" }
  );
  assert.deepEqual(result, ["core/vps/a.js", "src/b.ts"]);
  assert.equal(Array.isArray(result), true);
  assert.equal(result.ok, undefined);
});

test("pr diff --name-only filters blank/trailing lines", () => {
  const result = normalizeGhResult(
    ["pr", "diff", "5", "--name-only"],
    { status: 0, stdout: "a.js\n\nb.js\n\n" }
  );
  assert.deepEqual(result, ["a.js", "b.js"]);
});

test("pr diff --name-only that failed returns [] (fail-closed, so touchesGateMachinery sees no gate files on a gh hiccup)", () => {
  const result = normalizeGhResult(["pr", "diff", "5", "--name-only"], { status: 1 });
  assert.deepEqual(result, []);
});

test("defaultGhExec and scopedGh remain exported functions", () => {
  assert.equal(typeof defaultGhExec, "function");
  assert.equal(typeof scopedGh, "function");
});
