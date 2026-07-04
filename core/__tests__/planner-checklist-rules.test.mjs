#!/usr/bin/env node
/**
 * @description Locked tests for three planner checklist rules pinned in
 * creating-plans/SKILL.md (kaizen #93/#94/#98):
 * 1. AC-1.1 — Step 6 scope_paths rule must state that scope_paths cover the
 *    "files that make it usable" (not just the file directly touched).
 * 2. AC-1.2 — Step 2 decomposition rule must state that splitting a function's
 *    "required positional parameter" must "preserve the pinned signature".
 * 3. AC-1.3 — Step 3 locked_tests rule must require locked_tests to
 *    "cover ALL branches" of the derived behavior.
 * 4. AC-1.4 — the change is insertions-only: pre-existing anchor lines in the
 *    checklists this change touches remain byte-identical.
 *
 * These are RED until the executor adds the three new rule phrases to
 * core/skills/creating-plans/SKILL.md, and GREEN after.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CREATING_PLANS_MD_PATH = resolve(
  __dirname,
  "../skills/creating-plans/SKILL.md"
);

const creatingPlansMd = readFileSync(CREATING_PLANS_MD_PATH, "utf8");

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

/**
 * Count non-overlapping occurrences of a literal substring in a haystack.
 * @param {string} haystack - Text to search.
 * @param {string} needle - Literal substring to count.
 * @returns {number} Number of occurrences.
 */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ─── Test 1 — AC-1.1 ────────────────────────────────────────────────────────
/**
 * Given: creating-plans SKILL.md Step 6 (scope_paths, resolved_judgments, criterion_refs).
 * When: the scope_paths rule is extracted.
 * Then: it documents that scope_paths must cover the "files that make it usable",
 *       and that exact phrase appears exactly once in the whole document.
 */
test("creating-plans: Step 6 scope_paths rule documents 'files that make it usable'", () => {
  const step6Section = extractSection(creatingPlansMd, "Step 6 — scope_paths");
  assert(
    step6Section.length > 0,
    "Step 6 — scope_paths section must exist in creating-plans SKILL.md"
  );

  assert(
    step6Section.includes("files that make it usable"),
    "Step 6 scope_paths rule must state that scope_paths cover the 'files that make it usable'"
  );

  const occurrences = countOccurrences(creatingPlansMd, "files that make it usable");
  assert.equal(
    occurrences,
    1,
    `'files that make it usable' must appear exactly once in the whole file, found ${occurrences}`
  );
});

// ─── Test 2 — AC-1.2 ────────────────────────────────────────────────────────
/**
 * Given: creating-plans SKILL.md Step 2 (Decompose into tasks).
 * When: the decomposition rule is extracted.
 * Then: it documents that splitting a function whose "required positional parameter"
 *       is shared across call sites must "preserve the pinned signature", and both
 *       phrases appear exactly once each in the whole document.
 */
test("creating-plans: Step 2 decomposition rule documents 'required positional parameter' and 'preserve the pinned signature'", () => {
  const step2Section = extractSection(creatingPlansMd, "Step 2 — Decompose");
  assert(
    step2Section.length > 0,
    "Step 2 — Decompose section must exist in creating-plans SKILL.md"
  );

  assert(
    step2Section.includes("required positional parameter"),
    "Step 2 decomposition rule must mention 'required positional parameter'"
  );
  assert(
    step2Section.includes("preserve the pinned signature"),
    "Step 2 decomposition rule must mention 'preserve the pinned signature'"
  );

  const requiredParamOccurrences = countOccurrences(
    creatingPlansMd,
    "required positional parameter"
  );
  assert.equal(
    requiredParamOccurrences,
    1,
    `'required positional parameter' must appear exactly once in the whole file, found ${requiredParamOccurrences}`
  );

  const preserveSignatureOccurrences = countOccurrences(
    creatingPlansMd,
    "preserve the pinned signature"
  );
  assert.equal(
    preserveSignatureOccurrences,
    1,
    `'preserve the pinned signature' must appear exactly once in the whole file, found ${preserveSignatureOccurrences}`
  );
});

// ─── Test 3 — AC-1.3 ────────────────────────────────────────────────────────
/**
 * Given: creating-plans SKILL.md Step 3 (Derive locked_tests from ACs).
 * When: the locked_tests rule is extracted.
 * Then: it documents that locked_tests must "cover ALL branches" of the derived
 *       behavior, and that exact phrase appears exactly once in the whole document.
 */
test("creating-plans: Step 3 locked_tests rule documents 'cover ALL branches'", () => {
  const step3Section = extractSection(creatingPlansMd, "Step 3 — Derive");
  assert(
    step3Section.length > 0,
    "Step 3 — Derive locked_tests section must exist in creating-plans SKILL.md"
  );

  assert(
    step3Section.includes("cover ALL branches"),
    "Step 3 locked_tests rule must state that locked_tests must 'cover ALL branches'"
  );

  const occurrences = countOccurrences(creatingPlansMd, "cover ALL branches");
  assert.equal(
    occurrences,
    1,
    `'cover ALL branches' must appear exactly once in the whole file, found ${occurrences}`
  );
});

// ─── Test 4 — AC-1.4 ────────────────────────────────────────────────────────
/**
 * Given: creating-plans SKILL.md before and after the three rules above are added.
 * When: the pre-existing anchor lines in the touched checklists are searched.
 * Then: each anchor still appears byte-identical, proving the change is
 *       insertions-only (no deletion or alteration of the existing checklists).
 */
test("creating-plans: pre-existing checklist anchors remain byte-identical (insertions-only)", () => {
  const anchors = [
    "**Unit of decomposition: the task** — not a micro-step, not a giant module.",
    "**A locked_test pins observable behavior — not that code ran.**",
    "## Step 6 — scope_paths, resolved_judgments, criterion_refs",
  ];

  for (const anchor of anchors) {
    assert(
      creatingPlansMd.includes(anchor),
      `Pre-existing anchor must remain byte-identical in creating-plans SKILL.md: "${anchor}"`
    );
  }
});
