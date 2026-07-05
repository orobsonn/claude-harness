/**
 * @description Pins `normalizeGhResult(args, res)`, the pure normalization function extracted
 * from `defaultGhExec` to fix the `gh pr diff <n> --name-only` shape bug: without `--json`,
 * the old normalizer always returned `{ok}`, but the review phase needs a `string[]` of changed
 * file paths from `pr diff --name-only`. These tests pin the exact contract (see file header of
 * gh-exec.mjs) so the fix can't silently regress back to `{ok}` for the diff branch.
 *
 * RD-5: `pr diff` fetch failures (both `--name-only` and the full-patch form) are fail-CLOSED
 * and must return the distinct sentinel `{ ok: false, diffFailed: true }` — never a bare `[]`
 * (which would be indistinguishable from a genuinely empty diff) and never a bare `{ ok: false }`.
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

test("pr diff --name-only that failed returns the distinct failure sentinel { ok:false, diffFailed:true }, NOT []", () => {
  const result = normalizeGhResult(["pr", "diff", "5", "--name-only"], { status: 1 });
  assert.deepEqual(result, { ok: false, diffFailed: true });
  assert.equal(Array.isArray(result), false);
});

test("pr diff --name-only with status 0 and empty stdout returns [] (empty diff stays distinguishable from the failure sentinel)", () => {
  const result = normalizeGhResult(["pr", "diff", "5", "--name-only"], { status: 0, stdout: "" });
  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 0);
});

test("pr diff <n> without --name-only (full patch) with status 0 returns the stdout patch string, never { ok:true }", () => {
  const patch = "diff --git a/x b/x\n+patch";
  const result = normalizeGhResult(["pr", "diff", "5"], { status: 0, stdout: patch });
  assert.equal(typeof result, "string");
  assert.equal(result, patch);
});

test("pr diff <n> without --name-only that failed returns { ok:false, diffFailed:true }, not a patch string and not a bare { ok:false }", () => {
  const result = normalizeGhResult(["pr", "diff", "5"], { status: 1 });
  assert.deepEqual(result, { ok: false, diffFailed: true });
});

test("defaultGhExec and scopedGh remain exported functions", () => {
  assert.equal(typeof defaultGhExec, "function");
  assert.equal(typeof scopedGh, "function");
});
