#!/usr/bin/env node
/**
 * @description Locked integration tests for the CLI glue layer added to
 * detect-stack.mjs, detect-secrets.mjs, generate-ci.mjs, and branch-protection.mjs.
 * Each test spawns the CLI as a subprocess against a temp directory so the
 * pure-function exports are unaffected.
 *
 * Run: node --test core/__tests__/cli-glue.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REFS = join(__dirname, "../skills/initializing-projects/references");

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "cli-glue-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 1 — generate-ci.mjs WRITES .github/workflows/ci.yml
// ---------------------------------------------------------------------------

test("locked-cli-1: generate-ci.mjs --target writes .github/workflows/ci.yml", () => {
  const dir = makeTempDir();
  try {
    // No package.json → detectStack returns node-test runner
    const result = spawnSync(
      process.execPath,
      [join(REFS, "generate-ci.mjs"), "--target", dir],
      { encoding: "utf8" }
    );

    assert.strictEqual(
      result.status,
      0,
      `CLI must exit 0, stderr: ${result.stderr}`
    );

    const ciPath = join(dir, ".github", "workflows", "ci.yml");
    assert.ok(existsSync(ciPath), "ci.yml must exist after generate-ci runs");

    const content = readFileSync(ciPath, "utf8");
    assert.ok(content.includes("on:"), "ci.yml must contain 'on:'");
    assert.ok(
      content.includes("pull_request"),
      "ci.yml must contain 'pull_request'"
    );
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 2 — NON-CLOBBER: existing ci.yml is preserved when generate-ci runs again
// ---------------------------------------------------------------------------

test("locked-cli-2: generate-ci.mjs is non-clobber — existing ci.yml is not overwritten", () => {
  const dir = makeTempDir();
  try {
    const ciDir = join(dir, ".github", "workflows");
    const ciPath = join(ciDir, "ci.yml");
    mkdirSync(ciDir, { recursive: true });
    const SENTINEL = "# SENTINEL — do not overwrite\n";
    writeFileSync(ciPath, SENTINEL, "utf8");

    const result = spawnSync(
      process.execPath,
      [join(REFS, "generate-ci.mjs"), "--target", dir],
      { encoding: "utf8" }
    );

    assert.strictEqual(
      result.status,
      0,
      `CLI must exit 0 on non-clobber path, stderr: ${result.stderr}`
    );

    const content = readFileSync(ciPath, "utf8");
    assert.strictEqual(
      content,
      SENTINEL,
      "Existing ci.yml must be byte-identical after non-clobber run"
    );

    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert.ok(
      combined.toLowerCase().includes("skip"),
      `Output must mention 'skip', got stdout: ${result.stdout} stderr: ${result.stderr}`
    );
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 3 — detect-stack.mjs prints JSON with runner "node-test" for empty dir
// ---------------------------------------------------------------------------

test("locked-cli-3: detect-stack.mjs --target <no-package-json-dir> prints JSON with runner node-test", () => {
  const dir = makeTempDir();
  try {
    const result = spawnSync(
      process.execPath,
      [join(REFS, "detect-stack.mjs"), "--target", dir],
      { encoding: "utf8" }
    );

    assert.strictEqual(
      result.status,
      0,
      `CLI must exit 0, stderr: ${result.stderr}`
    );

    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.stdout.trim()); },
      "stdout must be valid JSON"
    );

    assert.strictEqual(
      parsed.runner,
      "node-test",
      `Expected runner "node-test", got: ${parsed.runner}`
    );
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 4 — branch-protection.mjs without --apply is dry-run (no network I/O)
// ---------------------------------------------------------------------------

test("locked-cli-4: branch-protection.mjs without --apply is dry-run — exits 0, prints payload, no PUT", () => {
  // Bogus repo so any accidental PUT would fail; without --apply it must NOT attempt one.
  const result = spawnSync(
    process.execPath,
    [
      join(REFS, "branch-protection.mjs"),
      "--repo", "bogus-owner/bogus-repo",
      "--branch", "main",
      "--required-context", "test",
    ],
    { encoding: "utf8" }
  );

  assert.strictEqual(
    result.status,
    0,
    `CLI must exit 0 in dry-run mode, stderr: ${result.stderr}`
  );

  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  assert.ok(
    combined.toLowerCase().includes("dry") ||
      combined.toLowerCase().includes("would") ||
      combined.toLowerCase().includes("payload"),
    `Output must indicate dry-run / payload preview, got: ${combined}`
  );

  // Must not contain a PUT-failure or network error message
  assert.ok(
    !result.stderr.toLowerCase().includes("put failed") &&
      !result.stderr.toLowerCase().includes("network error"),
    `Must not produce network errors in dry-run, stderr: ${result.stderr}`
  );
});
