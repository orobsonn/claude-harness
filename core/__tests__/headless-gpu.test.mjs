#!/usr/bin/env node
/**
 * @description Locked tests for headless-gpu parity (strong eyes, cheap hands — v3 slice).
 * Verifies orchestrating-delivery/SKILL.md:
 *   (1) Documents that the external hand dispatch path operates in HEADLESS (cloud routine) mode
 *       using the SAME brief-serialization contract as local.
 *   (2) GPU-time guard: a non-zero or timeout exit from the hand is treated as an ESCALATION —
 *       the partial attempt is discarded (per-task-commit stash mechanism), shared_context is NOT
 *       updated for the incomplete task, and a timeout is NOT misclassified as a code-quality
 *       failure that burns the fix/tier budget.
 *
 * SECTION-SCOPED: Test 1 scoped to the "Execution mode" section; Test 2 scoped to "Phase 2".
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
 * Given: orchestrating-delivery/SKILL.md with an "Execution mode" section.
 * When: the external hand-dispatch path documentation is inspected.
 * Then: the section documents that the external hand dispatch path operates in
 *       HEADLESS (cloud routine) mode using the SAME brief-serialization contract as local.
 */
test("orchestrating-delivery Execution mode: external hand dispatch operates in HEADLESS mode with the SAME brief-serialization contract as local", () => {
  const section = extractSection(orchestratingMd, "Execution mode");
  assert(
    section.length > 0,
    "Execution mode section not found in orchestrating-delivery SKILL.md"
  );

  const sectionLower = section.toLowerCase();

  // Section must document that external hand dispatch operates in HEADLESS / cloud routine mode.
  const hasHeadlessHandDispatch =
    sectionLower.includes("headless") &&
    (sectionLower.includes("dispatch-hand") ||
      sectionLower.includes("external hand") ||
      sectionLower.includes("hand dispatch") ||
      sectionLower.includes("hand-dispatch"));
  assert(
    hasHeadlessHandDispatch,
    "Execution mode section must document that the external hand dispatch path operates in HEADLESS (cloud routine) mode"
  );

  // Section must state the same brief-serialization contract applies in headless as in local.
  const hasBriefParity =
    (sectionLower.includes("brief") ||
      sectionLower.includes("brief-serialization") ||
      sectionLower.includes("serialization")) &&
    (sectionLower.includes("same") ||
      sectionLower.includes("identical") ||
      sectionLower.includes("parity")) &&
    (sectionLower.includes("headless") || sectionLower.includes("cloud"));
  assert(
    hasBriefParity,
    "Execution mode section must state the external hand uses the SAME brief-serialization contract in HEADLESS as in local"
  );
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md with a "Phase 2" section.
 * When: the GPU-time guard (hand exit behavior) is inspected.
 * Then: a non-zero or timeout exit from the hand is treated as an ESCALATION;
 *       the partial attempt is discarded via the per-task-commit stash mechanism;
 *       shared_context is NOT updated for the incomplete task;
 *       a timeout is NOT misclassified as a code-quality failure that burns the fix/tier budget.
 */
test("orchestrating-delivery Phase 2 GPU-time guard: non-zero/timeout exit is escalation; stash discard; shared_context not updated; timeout does not burn fix budget", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(
    section.length > 0,
    "Phase 2 section not found in orchestrating-delivery SKILL.md"
  );

  const sectionLower = section.toLowerCase();

  // (a) Non-zero OR timeout exit from the hand must be treated as an escalation.
  const hasNonzeroTimeoutEscalation =
    (sectionLower.includes("non-zero") || sectionLower.includes("nonzero")) &&
    sectionLower.includes("timeout") &&
    sectionLower.includes("escalation");
  assert(
    hasNonzeroTimeoutEscalation,
    "Phase 2 GPU guard must state that a non-zero or timeout exit from the hand is treated as an escalation"
  );

  // (b) Partial attempt must be discarded via the per-task-commit stash mechanism.
  const hasStashDiscard =
    sectionLower.includes("stash") &&
    (sectionLower.includes("partial") || sectionLower.includes("discard"));
  assert(
    hasStashDiscard,
    "Phase 2 GPU guard must state the partial attempt is discarded using the per-task-commit stash mechanism"
  );

  // (c) shared_context must NOT be updated for the incomplete task.
  const hasNoSharedContextUpdate =
    sectionLower.includes("shared_context") &&
    (sectionLower.includes("not updated") ||
      sectionLower.includes("not update") ||
      sectionLower.includes("do not update") ||
      sectionLower.includes("never update") ||
      (sectionLower.includes("shared_context") &&
        sectionLower.includes("incomplete")));
  assert(
    hasNoSharedContextUpdate,
    "Phase 2 GPU guard must state shared_context is NOT updated for the incomplete task"
  );

  // (d) Timeout must be explicitly distinguished from a code-quality failure
  //     and must NOT burn the fix/tier budget.
  const hasTimeoutNotCodeQuality =
    sectionLower.includes("timeout") &&
    (sectionLower.includes("not") || sectionLower.includes("never")) &&
    (sectionLower.includes("code-quality") ||
      sectionLower.includes("code quality") ||
      sectionLower.includes("fix budget") ||
      sectionLower.includes("tier budget") ||
      sectionLower.includes("burn"));
  assert(
    hasTimeoutNotCodeQuality,
    "Phase 2 GPU guard must explicitly state a timeout is NOT a code-quality failure and does not burn the fix/tier budget"
  );
});
