#!/usr/bin/env node
/**
 * @description Tests vendor-core.mjs vendoring behavior, especially hooks inclusion
 * and *.test.mjs exclusion.
 *
 * Usage:
 *   node vendor-core.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  execFileSync,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the test location
const vendorCoreScript = join(__dirname, "vendor-core.mjs");
const harnessRoot = join(__dirname, "../../../..");

test("vendor-core: hooks are included in FRAMEWORK_OWNED", (t) => {
  const scriptContent = readFileSync(vendorCoreScript, "utf8");
  assert.match(
    scriptContent,
    /const FRAMEWORK_OWNED = \["agents",\s*"skills",\s*"rules",\s*"hooks"\]/,
    "FRAMEWORK_OWNED should contain 'hooks' alongside agents, skills, and rules"
  );
});

test("vendor-core: all required hook files are copied to target", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" }
    );

    if (result.status !== 0) {
      throw new Error(
        `vendor-core failed: ${result.stderr || result.stdout}`
      );
    }

    const requiredFiles = [
      ".claude/hooks/entry-gate.mjs",
      ".claude/hooks/stamp-triage.mjs",
      ".claude/hooks/reinject-state.mjs",
      ".claude/hooks/classify.mjs",
      ".claude/hooks/mark.mjs",
      ".claude/hooks/lib/gate-lib.mjs",
    ];

    for (const file of requiredFiles) {
      const fullPath = join(tempDir, file);
      assert.ok(
        existsSync(fullPath),
        `${file} should exist in vendored target`
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("vendor-core: no *.test.mjs files are copied to hooks", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" }
    );

    if (result.status !== 0) {
      throw new Error(
        `vendor-core failed: ${result.stderr || result.stdout}`
      );
    }

    const hooksDir = join(tempDir, ".claude", "hooks");
    if (existsSync(hooksDir)) {
      const allFiles = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else {
            allFiles.push(entry.name);
          }
        }
      };
      walk(hooksDir);

      const testFiles = allFiles.filter((f) => f.endsWith(".test.mjs"));
      assert.strictEqual(
        testFiles.length,
        0,
        `No *.test.mjs files should be present under .claude/hooks/, but found: ${testFiles.join(", ")}`
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
