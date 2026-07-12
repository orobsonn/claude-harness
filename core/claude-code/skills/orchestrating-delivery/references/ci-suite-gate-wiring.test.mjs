#!/usr/bin/env node
/**
 * @description Consistency tests pinning the ci-suite gate wiring into orchestrating-delivery SKILL.md (#ac-1.1 / #ac-1.2).
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_MD_PATH = resolve(__dirname, "../SKILL.md");
const skillMd = readFileSync(SKILL_MD_PATH, "utf8");

// ─── Test 1 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md.
 * When: the Phase-3 CLI invocation is scanned.
 * Then: it contains 'ci-test-commands.mjs' AND '--project-root' AND '--out' —
 *       the runnable all-declared-configs suite command (#ac-1.1).
 */
test("SKILL.md: Phase-3 ci-test-commands.mjs runnable command present (#ac-1.1)", () => {
  assert.ok(
    skillMd.includes("ci-test-commands.mjs"),
    "SKILL.md must reference 'ci-test-commands.mjs' (the Phase-3 all-declared-configs suite command)."
  );
  assert.ok(
    skillMd.includes("--project-root"),
    "SKILL.md must reference the '--project-root' flag of the ci-test-commands.mjs invocation."
  );
  assert.ok(
    skillMd.includes("--out"),
    "SKILL.md must reference the '--out' flag of the ci-test-commands.mjs invocation."
  );
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md.
 * When: the machine-read gate is scanned.
 * Then: it contains 'ci-suite-result.json' AND 'allGreen' AND 'complete' —
 *       delivery proceeds only when both are true, read from the artifact on disk (#ac-1.2).
 */
test("SKILL.md: machine-read allGreen && complete gate on ci-suite-result.json present (#ac-1.2)", () => {
  assert.ok(
    skillMd.includes("ci-suite-result.json"),
    "SKILL.md must reference the 'ci-suite-result.json' on-disk artifact."
  );
  assert.ok(
    skillMd.includes("allGreen"),
    "SKILL.md must reference the 'allGreen' field read from ci-suite-result.json."
  );
  assert.ok(
    skillMd.includes("complete"),
    "SKILL.md must reference the 'complete' field read from ci-suite-result.json."
  );
});

// ─── Test 3 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md.
 * When: the step-4 gates note is scanned.
 * Then: it contains 'feature-wide' AND the distinctive phrase 'all-configs suite run'
 *       AND 'per-task' — pinning the exact step-4 clarification wording (the phrase
 *       'all-configs suite run' does not exist anywhere else in SKILL.md, so this
 *       assertion is genuinely RED until the step-4 note is added).
 */
test("SKILL.md: step-4 gates note clarifies the all-configs suite run is feature-wide, not per-task", () => {
  assert.ok(
    skillMd.includes("feature-wide"),
    "SKILL.md must contain 'feature-wide' in the step-4 gates note."
  );
  assert.ok(
    skillMd.includes("all-configs suite run"),
    "SKILL.md must contain the distinctive phrase 'all-configs suite run' in the step-4 gates note."
  );
  assert.ok(
    skillMd.includes("per-task"),
    "SKILL.md must contain 'per-task' in the step-4 gates note (contrasted against feature-wide)."
  );
});

// ─── Test 4 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md.
 * When: the pre-existing consistency tokens are scanned.
 * Then: it still contains ALL of 'brief-serializer', 'descriptor-emitter',
 *       'regate-pending', 'regate-passed', 'spawn-hand' — the minimal edits break
 *       no pre-existing consistency test.
 */
test("SKILL.md: no existing consistency token regressed", () => {
  const existingTokens = [
    "brief-serializer",
    "descriptor-emitter",
    "regate-pending",
    "regate-passed",
    "spawn-hand",
  ];
  for (const token of existingTokens) {
    assert.ok(
      skillMd.includes(token),
      `SKILL.md must still contain the pre-existing token '${token}'.`
    );
  }
});
