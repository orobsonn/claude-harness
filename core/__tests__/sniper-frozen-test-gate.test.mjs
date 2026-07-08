#!/usr/bin/env node
/**
 * @description Locked tests for the sniper-frozen-test-gate feature (#ac-1.1 / #ac-1.2).
 * Pins:
 *   (#ac-1.1) Before accepting an adversary-suggested sniper fix, the orchestrator
 *       DETERMINISTICALLY re-runs EVERY already-GREEN frozen locked_test of EVERY
 *       completed/impl-committed task — a non-vacuous re-run criterion, discriminated
 *       from a vacuous `frozen_paths`-intersection wording (Phase 2, orchestrating-delivery
 *       SKILL.md). The re-run is orchestrator-side, deterministic, and NEVER a sniper
 *       self-certification. Legitimately-RED frozen tests of not-yet-implemented sibling
 *       tasks are excluded by construction.
 *   (#ac-1.2) The sniper NEVER edits a frozen locked_test; instead it produces an
 *       alternative production fix that BOTH keeps the frozen test green AND still
 *       addresses the adversary's concern (sniper.md "How to fix" section). Structurally,
 *       a sniper diff touching a frozen manifest file is an automatic gate failure
 *       (document-wide in orchestrating-delivery SKILL.md), mirroring the executor's rail.
 *
 * SECTION-SCOPED: assertions 1, 2, 3 are scoped to the "Phase 2" section of
 * orchestrating-delivery/SKILL.md; assertion 5 is document-wide in the same file;
 * assertion 4 is scoped to the "How to fix" section of sniper.md.
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

const SNIPER_MD_PATH = resolve(__dirname, "../agents/sniper.md");

const orchestratingMd = readFileSync(ORCHESTRATING_MD_PATH, "utf8");
const sniperMd = readFileSync(SNIPER_MD_PATH, "utf8");

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

// ─── Test 1 (#ac-1.1) — non-vacuous re-run criterion ────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md "Phase 2" section.
 * When: the pre-acceptance gate for an adversary-suggested sniper fix is inspected.
 * Then: a single co-located line states that BEFORE accepting the fix the orchestrator
 *       DETERMINISTICALLY re-runs EVERY already-GREEN frozen locked_test of EVERY
 *       completed/impl-committed task — AND that same line must NOT use the vacuous
 *       `frozen_paths`-intersection wording (discriminated by the token "intersect"),
 *       since Phase 2 legitimately uses `frozen_paths` elsewhere as a manifest field name.
 */
test("orchestrating-delivery Phase 2 (#ac-1.1): before accepting a sniper fix, orchestrator deterministically re-runs every already-GREEN frozen locked_test of every completed task (non-vacuous, not a frozen_paths-intersection check)", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found in orchestrating-delivery SKILL.md");

  const gateLine = section.split("\n").find((line) => {
    const l = line.toLowerCase();
    return (
      l.includes("already-green") &&
      l.includes("frozen") &&
      l.includes("completed") &&
      (l.includes("before") || l.includes("accept"))
    );
  });
  assert(
    gateLine,
    "Phase 2 must state, on a single co-located line, that BEFORE accepting a sniper fix the orchestrator re-runs EVERY already-GREEN frozen locked_test of EVERY completed/impl-committed task"
  );
  assert(
    !gateLine.toLowerCase().includes("intersect"),
    "the gate line must NOT use the vacuous frozen_paths-intersection wording (token 'intersect' forbidden ON the gate line) — Phase 2 already uses `frozen_paths` legitimately as a manifest field name elsewhere, so a bare-absence/intersection check on that field is an unsatisfiable, non-discriminating predicate"
  );
});

// ─── Test 2 (#ac-1.1) — enforcement authority ────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md "Phase 2" section.
 * When: the authority behind the re-run gate is inspected.
 * Then: a single co-located line states the re-run is orchestrator-side and
 *       deterministic, and is NEVER a sniper self-certification.
 */
test("orchestrating-delivery Phase 2 (#ac-1.1): the re-run is orchestrator-side and deterministic, NEVER a sniper self-certification", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found in orchestrating-delivery SKILL.md");

  const authorityLine = section.split("\n").some((line) => {
    const l = line.toLowerCase();
    return (
      l.includes("orchestrator-side") &&
      (l.includes("never") || l.includes("not")) &&
      l.includes("self-certif")
    );
  });
  assert(
    authorityLine,
    "Phase 2 must state, on a single co-located line, that the re-run is orchestrator-side and deterministic and is NEVER a sniper self-certification"
  );
});

// ─── Test 3 (#ac-1.1) — sibling exclusion ────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md "Phase 2" section.
 * When: the treatment of not-yet-implemented sibling tasks is inspected.
 * Then: a single co-located line states legitimately-RED frozen tests of
 *       not-yet-implemented sibling tasks are excluded by construction (so the
 *       re-run gate never mistakes a sibling's expected-red frozen test for a
 *       regression caused by the sniper fix).
 */
test("orchestrating-delivery Phase 2 (#ac-1.1): legitimately-RED frozen tests of not-yet-implemented sibling tasks are excluded by construction", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found in orchestrating-delivery SKILL.md");

  const siblingLine = section.split("\n").some((line) => {
    const l = line.toLowerCase();
    return (l.includes("red") || l.includes("sibling")) && l.includes("excluded by construction");
  });
  assert(
    siblingLine,
    "Phase 2 must state, on a single co-located line, that legitimately-RED frozen tests of not-yet-implemented sibling tasks are excluded by construction"
  );
});

// ─── Test 4 (#ac-1.2) — sniper never edits a frozen test; alternative fix ────────
/**
 * Given: sniper.md "How to fix" section.
 * When: the sniper's handling of a defect implicating a frozen locked_test is inspected.
 * Then: a single co-located line states the sniper NEVER edits a frozen locked_test
 *       AND instead produces an alternative production fix that BOTH keeps the frozen
 *       test green AND still addresses the adversary's concern. Both halves must be
 *       co-located on the SAME line — deleting "still addresses the adversary's
 *       concern" must turn this assertion red.
 */
test("sniper.md How to fix (#ac-1.2): sniper NEVER edits a frozen locked_test; instead produces an alternative production fix that keeps the test green AND still addresses the adversary's concern (co-located)", () => {
  const section = extractSection(sniperMd, "How to fix");
  assert(section.length > 0, "How to fix section not found in sniper.md");

  const fixLine = section.split("\n").some((line) => {
    const l = line.toLowerCase();
    return (
      l.includes("never") &&
      l.includes("frozen") &&
      (l.includes("production fix") || l.includes("green")) &&
      (l.includes("addresses") || l.includes("concern"))
    );
  });
  assert(
    fixLine,
    "sniper.md 'How to fix' must state, on a SINGLE co-located line, that the sniper NEVER edits a frozen locked_test and instead produces an alternative production fix that BOTH keeps the frozen test green AND still addresses the adversary's concern — both halves must be co-located (deleting 'still addresses the adversary's concern' must turn this red, not just deleting the 'never edits frozen test' half)"
  );
});

// ─── Test 5 (#ac-1.2) — structural teeth ─────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md, document-wide.
 * When: the sniper's allowed-write rail (mirroring the executor's) is inspected.
 * Then: a single line names a SNIPER diff (like the executor's) touching a frozen
 *       manifest file as an automatic gate failure.
 */
test("orchestrating-delivery (#ac-1.2, document-wide): a SNIPER diff touching a frozen manifest file is an automatic gate failure (mirrors the executor's rail)", () => {
  const line = orchestratingMd.split("\n").some((l) => {
    const lower = l.toLowerCase();
    return lower.includes("sniper") && lower.includes("manifest") && lower.includes("automatic gate failure");
  });
  assert(
    line,
    "orchestrating-delivery SKILL.md must state, on a single line, that a SNIPER diff (like the executor's) touching a frozen manifest file is an automatic gate failure"
  );
});
