import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Dual-mirror drift guard (RD-7). The SHIPPED source of truth is this `modules/` tree (tracked); the
 * `.claude/modules/` copy is the harness's own LOCAL self-vendoring (gitignored — absent in a fresh CI
 * checkout). So the guard runs ONLY where the vendored mirror is present (local dev): it then asserts
 * every production .mjs is byte-identical across the two mirrors, catching a source edit that forgot to
 * re-vendor. When the vendored mirror is absent (CI / fresh clone), the guard is a documented no-op —
 * it never fails on a legitimately source-only tree.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..");
const sourceDir = testDir;
const mirrorDir = path.join(repoRoot, ".claude", "modules", "codex-adversary", "references");

const FILES = ["codex-adversary.mjs", "cross-family.mjs", "merge-findings.mjs"];

test("dual-mirror byte-identity: production .mjs files match across mirrors (skipped when vendored mirror absent)", () => {
  if (!existsSync(mirrorDir)) {
    // Source-only tree (CI / fresh checkout): nothing to compare, guard is a no-op by design.
    return;
  }
  for (const fileName of FILES) {
    const sourceContent = readFileSync(path.join(sourceDir, fileName), "utf8");
    const mirrorContent = readFileSync(path.join(mirrorDir, fileName), "utf8");
    assert.equal(sourceContent, mirrorContent, `mismatch for ${fileName}`);
  }
});
