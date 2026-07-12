/**
 * @description Pins AC-1.2 of issue #251 — mergeClaudeGitignore merges the harness ephemeral-ignore
 * lines into `<claudeDir>/.gitignore` without clobbering existing project content. Each test uses a
 * fresh temp claudeDir (mkdtempSync + os.tmpdir()) and cleans up after itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeClaudeGitignore } from "./vendor-core.mjs";

/** @description Creates a fresh, isolated claudeDir for one test. */
function makeClaudeDir() {
  return mkdtempSync(join(tmpdir(), "vendor-gitignore-test-"));
}

test("#ac-1.2 mergeClaudeGitignore: absent file creates .gitignore containing the required lines", () => {
  const claudeDir = makeClaudeDir();
  try {
    mergeClaudeGitignore(claudeDir);
    const content = readFileSync(join(claudeDir, ".gitignore"), "utf8");
    assert.ok(content.includes("plans/"), "must include plans/");
    assert.ok(content.includes("settings.local.json"), "must include settings.local.json");
    assert.ok(content.includes("*.local.md"), "must include *.local.md");
    assert.ok(content.includes(".harness-version-check-cache"), "must include .harness-version-check-cache");
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("#ac-1.2 mergeClaudeGitignore: merges into existing content without clobbering it", () => {
  const claudeDir = makeClaudeDir();
  try {
    const gitignorePath = join(claudeDir, ".gitignore");
    writeFileSync(gitignorePath, "# my project\nnode_modules/\ndist/\n");

    mergeClaudeGitignore(claudeDir);

    const content = readFileSync(gitignorePath, "utf8");
    assert.ok(content.includes("node_modules/"), "existing node_modules/ must be preserved");
    assert.ok(content.includes("dist/"), "existing dist/ must be preserved");
    assert.ok(content.includes("plans/"), "plans/ must be added by the merge");
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("#ac-1.2 mergeClaudeGitignore: idempotent — a second call does not duplicate plans/ and reports already ignored", () => {
  const claudeDir = makeClaudeDir();
  try {
    mergeClaudeGitignore(claudeDir);
    const secondResult = mergeClaudeGitignore(claudeDir);

    const content = readFileSync(join(claudeDir, ".gitignore"), "utf8");
    const plansLines = content.split(/\r?\n/).filter((line) => line.trim() === "plans/");
    assert.equal(plansLines.length, 1, "plans/ must appear exactly once after two calls");
    assert.equal(secondResult, "already ignored", "the second call must report already ignored");
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});
