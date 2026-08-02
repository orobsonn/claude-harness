/** @description Locked tests for shared absolution pure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  absolutionPrefix,
  matchesAbsolution,
  parseAbsolutionEntry,
} from "./absolution.mjs";
import * as absolution from "./absolution.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

test("formatFeatureTaskEntry: bare and SHA-qualified entries are deterministic", () => {
  assert.equal(typeof absolution.formatFeatureTaskEntry, "function");
  assert.equal(absolution.formatFeatureTaskEntry("feature", "task"), "feature/task");
  assert.equal(absolution.formatFeatureTaskEntry("feature", "task", null), "feature/task");
  assert.equal(absolution.formatFeatureTaskEntry("feature", "task", "abc123"), "feature/task@abc123");
  assert.equal(absolution.formatFeatureTaskEntry("feature", "task", ""), "feature/task");
});

test("matchesAbsolution: prefix@sha + ancestor true → true", () => {
  assert.equal(
    matchesAbsolution("feat/t1", ["feat/t1@abc"], () => true),
    true,
  );
});

test("matchesAbsolution: divergent sha (ancestor false) → false", () => {
  assert.equal(
    matchesAbsolution("feat/t1", ["feat/t1@abc"], () => false),
    false,
  );
});

test("matchesAbsolution: unqualified (no @sha) → false", () => {
  assert.equal(
    matchesAbsolution("feat/t1", ["feat/t1"], () => true),
    false,
  );
});

test("matchesAbsolution: isAncestorFn null → false", () => {
  assert.equal(
    matchesAbsolution("feat/t1", ["feat/t1@abc"], () => null),
    false,
  );
});

test("absolutionPrefix: splits at last @; non-string → empty", () => {
  assert.equal(absolutionPrefix("feat/t@deadbeef"), "feat/t");
  assert.equal(absolutionPrefix(null), "");
  assert.equal(absolutionPrefix(1), "");
});

test("parseAbsolutionEntry: valid / invalid", () => {
  assert.deepEqual(parseAbsolutionEntry("a/b@sha1"), {
    prefix: "a/b",
    sha: "sha1",
  });
  assert.equal(parseAbsolutionEntry("no-at"), null);
});

test("shared pure: no fs import and no .claude/.opencode hardcode", () => {
  for (const name of [
    "absolution.mjs",
    "regate-classify.mjs",
    "git-state.mjs",
  ]) {
    const src = readFileSync(join(__dir, name), "utf8");
    assert.equal(src.includes("node:fs"), false, name);
    assert.equal(src.includes(".claude"), false, name);
    assert.equal(src.includes(".opencode"), false, name);
  }
});
