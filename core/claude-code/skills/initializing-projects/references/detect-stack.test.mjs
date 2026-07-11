/**
 * @description Tests for detect-stack.mjs — verifies stack detection for
 * node-test, vitest, jest, and unknown (skip) scenarios.
 *
 * Usage:
 *   node --test core/skills/initializing-projects/references/detect-stack.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack } from "./detect-stack.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "detect-stack-test-"));
}

test("no package.json → node-test detected with exact command", async (t) => {
  const dir = makeTempDir();
  try {
    const result = detectStack(dir);
    assert.equal(result.status, "detected");
    assert.equal(result.runner, "node-test");
    assert.equal(result.command, 'node --test "**/*.test.mjs"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json with vitest in devDependencies → vitest runner", async (t) => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "test-project",
        devDependencies: {
          vitest: "^1.0.0",
        },
      })
    );
    const result = detectStack(dir);
    assert.equal(result.status, "detected");
    assert.equal(result.runner, "vitest");
    assert.ok(
      result.command.includes("vitest") || result.command === "npm test",
      `Expected vitest command, got: ${result.command}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json with jest in devDependencies → jest runner", async (t) => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "test-project",
        devDependencies: {
          jest: "^29.0.0",
        },
      })
    );
    const result = detectStack(dir);
    assert.equal(result.status, "detected");
    assert.equal(result.runner, "jest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json with no recognized runner → status skip with reason, does not throw", async (t) => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "test-project",
        devDependencies: {
          lodash: "^4.0.0",
        },
      })
    );
    let result;
    assert.doesNotThrow(() => {
      result = detectStack(dir);
    });
    assert.equal(result.status, "skip");
    assert.ok(
      typeof result.reason === "string" && result.reason.length > 0,
      `Expected non-empty reason string, got: ${JSON.stringify(result.reason)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
