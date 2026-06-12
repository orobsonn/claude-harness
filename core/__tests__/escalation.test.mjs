#!/usr/bin/env node
/**
 * @description Locked tests for executor escalation (strong eyes, cheap hands — per-task commits design).
 * Verifies that orchestrating-delivery/SKILL.md Phase 2 step 7 (escalation):
 *   (1) On K=1 failure, escalation re-dispatches the EXECUTOR one tier up within hand_tiers
 *       and explicitly NEVER re-dispatches the sniper.
 *   (2) Before re-dispatch, the orchestrator VERIFIES HEAD equals the recorded freeze-commit SHA,
 *       then discards the failed attempt — tracked AND untracked — with
 *       `git stash push --include-untracked` + `git stash drop`. This is SAFE because the per-task
 *       freeze-commit (step 1c-commit) means HEAD always points to the current task's freeze-commit —
 *       the frozen test/fixtures and all prior tasks' committed work are fully preserved. The denied
 *       `git reset --hard` / `git clean -f` (settings baseline) must NOT be used, and the obsolete
 *       entry-snapshot machinery (ENTRY_SNAP / git stash create) must NOT appear.
 *   (3) In v1, a medium-tier failure escalates directly to the Claude hand fallback; hand_tiers.high
 *       becomes the escalation target only after the v2 flip.
 *   (4) Escalation is bounded (no unbounded loop) and cost is instrumented via ccusage.
 *
 * SECTION-SCOPED: all assertions are scoped to the "Phase 2" section of SKILL.md.
 * Tests run under node:test.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ORCHESTRATING_MD_PATH = resolve(
  __dirname,
  "../skills/orchestrating-delivery/SKILL.md"
);

const orchestratingMd = readFileSync(ORCHESTRATING_MD_PATH, "utf8");

/**
 * Extract a markdown section by heading text (case-insensitive partial match).
 * Returns text from the matched heading until the next heading at the same or higher level.
 * @param {string} content - Full markdown content.
 * @param {string} headingText - Partial heading text to match (case-insensitive).
 * @returns {string} The extracted section, or empty string if not found.
 */
function extractSection(content, headingText) {
  const lines = content.split("\n");
  let capturing = false;
  let headingLevel = 0;
  const captured = [];

  for (const line of lines) {
    if (!capturing) {
      const match = line.match(/^(#{1,6})\s+(.*)/);
      if (match && match[2].toLowerCase().includes(headingText.toLowerCase())) {
        capturing = true;
        headingLevel = match[1].length;
        captured.push(line);
      }
    } else {
      const match = line.match(/^(#{1,6})\s/);
      if (match && match[1].length <= headingLevel) {
        break;
      }
      captured.push(line);
    }
  }

  return captured.join("\n");
}

// ─── Test 1 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md with a "Phase 2" section.
 * When: the escalation step (step 7) in Phase 2 is inspected.
 * Then: on K=1 failure, escalation re-dispatches the EXECUTOR one tier up within hand_tiers
 *       and explicitly NEVER re-dispatches the sniper.
 */
test("orchestrating-delivery Phase 2: K=1 failure escalates executor one tier up in hand_tiers; NEVER re-dispatches sniper", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(
    section.length > 0,
    "Phase 2 section not found in orchestrating-delivery SKILL.md"
  );

  const sectionLower = section.toLowerCase();

  // K=1 must be the stated failure threshold for executor escalation
  assert(
    section.includes("K=1") || section.includes("K = 1"),
    "Phase 2 escalation step must state K=1 as the failure threshold"
  );

  // Escalation must re-dispatch the EXECUTOR one tier up in hand_tiers (not the sniper)
  const escalatesExecutor =
    sectionLower.includes("k=1") &&
    sectionLower.includes("executor") &&
    (sectionLower.includes("re-dispatch") || sectionLower.includes("redispatch")) &&
    (sectionLower.includes("tier up") ||
      sectionLower.includes("one tier") ||
      sectionLower.includes("escalat"));
  assert(
    escalatesExecutor,
    "Phase 2 escalation must state re-dispatching the EXECUTOR one tier up in hand_tiers on K=1 failure"
  );

  // Must explicitly state escalation NEVER re-dispatches the sniper
  const neverSniper =
    (section.includes("NEVER") &&
      sectionLower.includes("sniper") &&
      (sectionLower.includes("re-dispatch") || sectionLower.includes("redispatch"))) ||
    (sectionLower.includes("never re-dispatch") && sectionLower.includes("sniper")) ||
    (sectionLower.includes("never redispatch") && sectionLower.includes("sniper"));
  assert(
    neverSniper,
    "Phase 2 escalation must explicitly state it NEVER re-dispatches the sniper"
  );
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md with a "Phase 2" section.
 * When: the escalation step's pre-dispatch reset mechanism is inspected.
 * Then: escalation VERIFIES HEAD == the recorded freeze-commit SHA, then discards the failed
 *       attempt (tracked + untracked) with `git stash push --include-untracked` + `git stash drop`,
 *       explicitly stating this is SAFE because the frozen test/fixtures and all prior tasks are
 *       committed (HEAD = the task's freeze-commit). The denied `git reset --hard` / `git clean -f`
 *       must NOT be used, and the obsolete ENTRY_SNAP / git stash create machinery must NOT appear.
 */
test("orchestrating-delivery Phase 2: escalation reset is verify-then-stash (`git stash push --include-untracked` + `git stash drop`), discards tracked+untracked, HEAD = freeze-commit; does NOT use the denied git reset --hard / git clean -f", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(
    section.length > 0,
    "Phase 2 section not found in orchestrating-delivery SKILL.md"
  );

  const sectionLower = section.toLowerCase();

  // (a) Escalation must use `git stash push --include-untracked` + `git stash drop` to discard
  //     the failed attempt (tracked AND untracked).
  assert(
    section.includes("git stash push --include-untracked"),
    "Phase 2 escalation must use `git stash push --include-untracked` to discard tracked+untracked failed attempt"
  );
  assert(
    section.includes("git stash drop"),
    "Phase 2 escalation must `git stash drop` the moved failed attempt"
  );

  // (b) Escalation must NOT use the denied `git reset --hard` / `git clean -f` commands.
  const usesDeniedReset =
    section.includes("git reset --hard") || section.includes("git clean -f");
  assert(
    !usesDeniedReset,
    "Phase 2 escalation must NOT use the denied `git reset --hard` / `git clean -f` (settings baseline)"
  );

  // (c) Escalation must VERIFY HEAD equals the recorded freeze-commit SHA before resetting,
  //     and ABORT to a critical exception on mismatch.
  const verifiesHead =
    sectionLower.includes("git rev-parse head") &&
    (sectionLower.includes("freeze-commit sha") || sectionLower.includes("freeze commit sha") ||
      sectionLower.includes("recorded freeze")) &&
    (sectionLower.includes("abort") && sectionLower.includes("critical exception"));
  assert(
    verifiesHead,
    "Phase 2 escalation must verify `git rev-parse HEAD` == recorded freeze SHA and ABORT to critical exception on mismatch"
  );

  // (d) The section must state this is SAFE because the frozen test + prior tasks are committed.
  const statesSafe =
    sectionLower.includes("safe") &&
    (sectionLower.includes("frozen test") || sectionLower.includes("frozen test/fixtures")) &&
    (sectionLower.includes("committed") || sectionLower.includes("commit"));
  assert(
    statesSafe,
    "Phase 2 escalation must state the reset is SAFE because the frozen test and prior tasks are committed"
  );

  // (e) The section must state HEAD points to the task's freeze-commit.
  const headIsFreezeCommit =
    sectionLower.includes("freeze-commit") &&
    (section.includes("HEAD is the task") ||
      section.includes("HEAD always points") ||
      section.includes("HEAD points") ||
      sectionLower.includes("head is the task") ||
      sectionLower.includes("head always points to the current task"));
  assert(
    headIsFreezeCommit,
    "Phase 2 escalation must state HEAD points to the task's freeze-commit"
  );

  // (f) The obsolete entry-snapshot machinery must NOT appear.
  const hasObsoleteEntrySnap =
    sectionLower.includes("entry_snap") ||
    sectionLower.includes("git stash create");
  assert(
    !hasObsoleteEntrySnap,
    "Phase 2 escalation must NOT reference the obsolete ENTRY_SNAP / git stash create machinery"
  );
});

// ─── Test 3 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md with a "Phase 2" section.
 * When: the escalation step's v1 tier mapping is inspected.
 * Then: in v1, a medium-tier failure escalates directly to the Claude hand fallback;
 *       hand_tiers.high becomes the escalation target only after the v2 flip.
 */
test("orchestrating-delivery Phase 2: v1 medium-tier failure escalates directly to Claude hand fallback; hand_tiers.high only after v2 flip", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(
    section.length > 0,
    "Phase 2 section not found in orchestrating-delivery SKILL.md"
  );

  const sectionLower = section.toLowerCase();

  // In v1, a medium-tier failure escalates directly to the Claude hand fallback.
  // Checked with "medium-tier" (hyphenated form) to avoid false positives on
  // "hand_tiers.medium" which appears in the sniper fail-class floor.
  const hasMediumClaudeFallback =
    (sectionLower.includes("medium-tier") || sectionLower.includes("medium tier")) &&
    (sectionLower.includes("claude hand fallback") ||
      (sectionLower.includes("claude hand") && sectionLower.includes("fallback")));
  assert(
    hasMediumClaudeFallback,
    "Phase 2 escalation must state that in v1 a medium-tier failure escalates directly to the Claude hand fallback"
  );

  // hand_tiers.high becomes the escalation target only after the v2 flip.
  // "v2 flip" is the specific phrase that won't appear until the executor escalation section.
  const hasV2Flip =
    sectionLower.includes("v2 flip") ||
    (sectionLower.includes("v2") && sectionLower.includes("flip"));
  assert(
    hasV2Flip,
    "Phase 2 escalation must note that hand_tiers.high becomes the escalation target only after the v2 flip"
  );
});

// ─── Test 4 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md with a "Phase 2" section.
 * When: the escalation step's loop control and cost instrumentation are inspected.
 * Then: escalation is bounded (no unbounded loop) and cost is instrumented via ccusage.
 */
test("orchestrating-delivery Phase 2: escalation is bounded (no unbounded loop) and cost-instrumented via ccusage", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(
    section.length > 0,
    "Phase 2 section not found in orchestrating-delivery SKILL.md"
  );

  const sectionLower = section.toLowerCase();

  // Escalation must be stated as bounded (not "bounded max" on a retry loop — the specific
  // phrase must be "bounded escalation" or "escalation is bounded" or similar).
  const isBoundedEscalation =
    sectionLower.includes("bounded escalation") ||
    sectionLower.includes("escalation is bounded") ||
    sectionLower.includes("max escalation") ||
    sectionLower.includes("escalation cap") ||
    sectionLower.includes("escalation steps") ||
    (sectionLower.includes("escalation") &&
      sectionLower.includes("bounded") &&
      sectionLower.includes("loop"));
  assert(
    isBoundedEscalation,
    "Phase 2 escalation must explicitly state it is bounded (no unbounded loop)"
  );

  // Cost must be instrumented via ccusage
  assert(
    sectionLower.includes("ccusage"),
    "Phase 2 escalation must state cost is instrumented via ccusage"
  );
});

// ─── Test 5 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md with a "Phase 2" section.
 * When: the per-task loop's pre-commit branch handling is inspected.
 * Then: before the first per-task commit, the loop ensures a non-main feature branch —
 *       checking `git branch --show-current` and creating `git switch -c <type>/<feature-id>`
 *       when on main/master — so the freeze/impl commit series never lands on protected main.
 */
test("orchestrating-delivery Phase 2: per-task loop ensures a non-main feature branch before the first commit", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(
    section.length > 0,
    "Phase 2 section not found in orchestrating-delivery SKILL.md"
  );

  const sectionLower = section.toLowerCase();

  // Must check the current branch and create a feature branch when on main/master.
  const ensuresBranch =
    sectionLower.includes("git branch --show-current") &&
    sectionLower.includes("git switch -c") &&
    (sectionLower.includes("main") || sectionLower.includes("master")) &&
    (sectionLower.includes("before") && sectionLower.includes("commit"));
  assert(
    ensuresBranch,
    "Phase 2 must ensure a non-main feature branch (git branch --show-current → git switch -c <type>/<feature-id>) before the first per-task commit"
  );
});
