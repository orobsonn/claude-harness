/**
 * @description Frozen contract tests for the CORRECTED touchesGateMachinery matcher (AC-2.3, AC-2.4).
 * The prior matcher used `file.startsWith(glob)` — a hole: `settings.json`/`CLAUDE.md`/`verdict-block`
 * only matched at the repo root, so the real `core/settings.json` / `core/CLAUDE.md` escaped, and
 * `.github/`/`package.json`/`core/modules/` were uncovered. These tests pin the two-class semantics:
 *   (1) DIRECTORY-prefix globs are ROOT-anchored, segment-aligned (vendor/core/vps/x → false);
 *   (2) BASENAME globs match the FINAL path segment by exact equality at any depth
 *       (a/b/CLAUDE.md → true, MYCLAUDE.mdx → false, user-settings.json → false).
 * RED until review-gate-hardening.mjs replaces the startsWith matcher and widens the glob set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { touchesGateMachinery } from "./review-gate-hardening.mjs";

// --- AC-2.3: the real control surface now matches ---
test("AC-2.3 core/settings.json matches (directory-prefix segment match, not bare startsWith)", () => {
  assert.equal(touchesGateMachinery(["core/settings.json"]), true);
});
test("AC-2.3 .github/workflows/ci.yml matches (CI config is control surface)", () => {
  assert.equal(touchesGateMachinery([".github/workflows/ci.yml"]), true);
});
test("AC-2.3 package.json matches (dep/test-script surface)", () => {
  assert.equal(touchesGateMachinery(["package.json"]), true);
});
test("AC-2.3 core/modules/codex-adversary/x.mjs matches (cross-family machinery)", () => {
  assert.equal(touchesGateMachinery(["core/modules/codex-adversary/references/cross-family.mjs"]), true);
});
test("AC-2.3 docs/nested/CLAUDE.md matches (basename at any depth)", () => {
  assert.equal(touchesGateMachinery(["docs/nested/CLAUDE.md"]), true);
});

// --- AC-2.4: no over-broad / substring / mis-anchored match ---
test("AC-2.4 src/foo.ts does not match (product file)", () => {
  assert.equal(touchesGateMachinery(["src/foo.ts"]), false);
});
test("AC-2.4 README.md does not match", () => {
  assert.equal(touchesGateMachinery(["README.md"]), false);
});
test("AC-2.4 src/user-settings.json does not match (final segment is user-settings.json, not settings.json — segment equality, never substring)", () => {
  assert.equal(touchesGateMachinery(["src/user-settings.json"]), false);
});
test("AC-2.4 vendor/core/vps/x.mjs does not match (directory-prefix globs are ROOT-anchored, never at inner depth)", () => {
  assert.equal(touchesGateMachinery(["vendor/core/vps/x.mjs"]), false);
});
test("AC-2.4 MYCLAUDE.mdx does not match (final segment is MYCLAUDE.mdx, not CLAUDE.md — exact equality, never prefix/substring)", () => {
  assert.equal(touchesGateMachinery(["MYCLAUDE.mdx"]), false);
});

// --- regression: a genuine gate-machinery dir still matches (unchanged behavior) ---
test("AC-2.3 core/vps/x.mjs still matches (existing behavior preserved)", () => {
  assert.equal(touchesGateMachinery(["core/vps/cron-review.mjs"]), true);
});
