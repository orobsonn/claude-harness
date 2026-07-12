#!/usr/bin/env node
/**
 * @description Pins that orchestrating-delivery SKILL.md's Phase 0 section carries a
 * deterministic spec-adversary checkpoint block, analogous to the existing
 * "Deterministic plan-review checkpoint" block in Phase 1. The block emits the
 * `spec-adversaried` marker (with a SHIP|BLOCK verdict and findings) right after the
 * upfront spec-adversary step (HARD-GATE 1) and before "Mark brainstorm complete",
 * so the run's observability outbox carries a deterministic checkpoint of the
 * spec-adversary decision — never sourced from LLM prose.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILL_MD_PATH = resolve(__dirname, "./SKILL.md");

/**
 * Given: orchestrating-delivery SKILL.md.
 * When: the Phase 0 region (from the "Upfront spec-adversary" step through the end
 *       of Phase 0, before "## Phase 1" begins) is extracted.
 * Then: that region contains a deterministic checkpoint block that emits the
 *       `mark.mjs spec-adversaried` marker with a `--verdict SHIP|BLOCK` flag and a
 *       `--findings` flag — mirroring the existing Phase 1 "Deterministic
 *       plan-review checkpoint" block's shape.
 */
test("SKILL.md Phase 0 contains a deterministic spec-adversary checkpoint block (mark.mjs spec-adversaried --verdict SHIP|BLOCK --findings)", () => {
  const skillMd = readFileSync(SKILL_MD_PATH, "utf8");

  const phase0AnchorStart = skillMd.indexOf("Upfront spec-adversary");
  const phase1AnchorEnd = skillMd.indexOf("## Phase 1");

  assert.notEqual(
    phase0AnchorStart,
    -1,
    "SKILL.md must contain the 'Upfront spec-adversary' anchor (start of the Phase 0 region under test) — if this anchor moved, update the test's anchor, do not silently slice garbage."
  );
  assert.notEqual(
    phase1AnchorEnd,
    -1,
    "SKILL.md must contain the '## Phase 1' heading (end of the Phase 0 region under test) — if this anchor moved, update the test's anchor, do not silently slice garbage."
  );
  assert(
    phase0AnchorStart < phase1AnchorEnd,
    "The 'Upfront spec-adversary' anchor must precede the '## Phase 1' heading — anchor order assumption violated."
  );

  const phase0Region = skillMd.slice(phase0AnchorStart, phase1AnchorEnd);

  assert(
    phase0Region.includes("mark.mjs spec-adversaried"),
    "Phase 0 must contain a deterministic checkpoint block invoking 'mark.mjs spec-adversaried' — analogous to the Phase 1 'Deterministic plan-review checkpoint' block's 'mark.mjs plan-reviewed' invocation."
  );
  assert(
    phase0Region.includes("--verdict SHIP|BLOCK"),
    "Phase 0's spec-adversary checkpoint block must document the '--verdict SHIP|BLOCK' flag."
  );
  assert(
    phase0Region.includes("--findings"),
    "Phase 0's spec-adversary checkpoint block must document the '--findings' flag."
  );
});
