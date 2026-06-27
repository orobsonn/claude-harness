#!/usr/bin/env node
/**
 * @description Locked tests for scan-secrets-in-tree.mjs.
 *
 * Test #2: Real repo tree (doc-paths excluded) → ZERO findings.
 * Test #3: Temp tree with planted high-entropy token → finding detected.
 *
 * Usage:
 *   node --test core/skills/initializing-projects/references/scan-secrets-in-tree.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Repo root: core/skills/initializing-projects/references/ → ../../../../
const REPO_ROOT = resolve(__dirname, "../../../..");

import { scanSecretsInTree } from "./scan-secrets-in-tree.mjs";

// ---------------------------------------------------------------------------
// Locked test #2 — real repo tree with doc-path exclusions → ZERO findings
// ---------------------------------------------------------------------------

test("locked-2: real repo tree (core/rules/ and *.md excluded) reports ZERO findings", () => {
  // This is the acceptance oracle: if this fails the scanner has a false positive.
  // Excluded per spec: core/rules/ (example literals) and **/*.md (doc paths).
  // .git, node_modules, .dev.vars, .env* are always skipped by the scanner itself.
  const { findings } = scanSecretsInTree(REPO_ROOT, {
    exclude: ["core/rules/", "**/*.md"],
  });

  assert.deepStrictEqual(
    findings,
    [],
    `Scanner produced false-positive findings on the real repo tree:\n` +
      findings.map((f) => `  ${f.file}:${f.line} [${f.pattern}] ${f.excerpt}`).join("\n")
  );
});

// ---------------------------------------------------------------------------
// Locked test #3 — temp tree with planted high-entropy token → ≥1 finding
// ---------------------------------------------------------------------------

test("locked-3: temp tree with planted high-entropy token reports a finding", () => {
  const dir = mkdtempSync(join(tmpdir(), "scan-secrets-tree-test-"));
  try {
    // Build the token from parts so the source of THIS test file does not contain
    // the assembled pattern literal (which would cause test #2 to self-flag).
    // The prefix "ghp_" matches GitHub PAT pattern only when followed by 20+ alphanum chars.
    // Each part below is < 20 chars — assembling them at runtime writes the full token to disk.
    const prefix = "ghp_";
    const upper = "ABCDEFGHIJKLMNOPQRST"; // 20 chars uppercase
    const lower = "uvwxyz012345"; // 12 chars lowercase+digit
    const plantedToken = prefix + upper + lower; // 36 chars total → valid ghp_ pattern

    // Write the token into a non-doc .mjs file that the scanner will pick up
    writeFileSync(
      join(dir, "config.mjs"),
      `/** @description planted test fixture */\nconst TOKEN = "${plantedToken}";\n`
    );

    const { findings } = scanSecretsInTree(dir, {});

    assert.ok(
      findings.length > 0,
      `Expected at least one finding for a planted ghp_ token but got zero.\n` +
        `Planted token length: ${plantedToken.length} chars.`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
