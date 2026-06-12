#!/usr/bin/env node
/**
 * @description Locked tests for the migration/SQL deterministic rule.
 * Verifies that the creating-plans skill documents:
 * 1. Any cheap-hand task touching **\/*.sql or *\/migrations/** MUST carry a locked_test
 *    that spins up an ephemeral DB, runs the migration, and asserts post-migration state.
 * 2. Text-match assertions on the migration file itself are explicitly FORBIDDEN.
 *
 * This pins the rule that makes SQL/DDL work by cheap hands safe under the deterministic rail.
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

// ─── Test 1 ───────────────────────────────────────────────────────────────────
/**
 * Given: creating-plans SKILL.md.
 * When: the document is searched for a migration rule.
 * Then: it documents that any cheap-hand task whose scope_paths match **\/*.sql or
 *       *\/migrations/** MUST carry a locked_test that spins up an ephemeral DB,
 *       runs the migration, and asserts post-migration state.
 */
test("creating-plans: migration rule documents ephemeral DB + migration execution + post-migration state assertion for cheap-hand tasks", () => {
  // Look for a section that mentions migrations/SQL rule
  const migrationSection = extractSection(creatingPlansMd, "migration");
  const sqlSection = extractSection(creatingPlansMd, "SQL");

  // At least one section about migrations or SQL must exist
  const foundSection = migrationSection.length > 0 || sqlSection.length > 0;
  assert(
    foundSection,
    "creating-plans SKILL.md must contain a section about migrations or SQL rules"
  );

  const relevantSection = migrationSection.length > 0 ? migrationSection : sqlSection;
  const sectionLower = relevantSection.toLowerCase();

  // (a) mentions scope_paths with the exact globs
  const mentionsGlobs =
    (sectionLower.includes("**/*.sql") || sectionLower.includes("*.sql")) &&
    (sectionLower.includes("**/migrations/**") || sectionLower.includes("migrations"));
  assert(
    mentionsGlobs,
    "Migration rule must mention scope_paths matching **/*.sql or **/migrations/**"
  );

  // (b) mentions cheap-hand
  const mentionsCheapHand =
    sectionLower.includes("cheap-hand") ||
    sectionLower.includes("cheap hand") ||
    sectionLower.includes("hand_tiers");
  assert(
    mentionsCheapHand,
    "Migration rule must reference cheap-hand executor or hand_tiers routing"
  );

  // (c) locked_test is mandatory
  const lockedTestMandatory =
    sectionLower.includes("mandatory") ||
    sectionLower.includes("must carry") ||
    sectionLower.includes("is mandatory") ||
    (sectionLower.includes("locked_test") && sectionLower.includes("must"));
  assert(
    lockedTestMandatory,
    "Migration rule must state locked_test is mandatory for migration tasks"
  );

  // (d) mentions ephemeral database
  const ephemeralDb =
    sectionLower.includes("ephemeral") ||
    sectionLower.includes("ephemeral database") ||
    sectionLower.includes("ephemeral db");
  assert(
    ephemeralDb,
    "Migration rule must mention spinning up an ephemeral database"
  );

  // (e) mentions applying/running the migration
  const runMigration =
    (sectionLower.includes("apply") && sectionLower.includes("migration")) ||
    (sectionLower.includes("run") && sectionLower.includes("migration")) ||
    sectionLower.includes("execute");
  assert(
    runMigration,
    "Migration rule must document applying/running the migration"
  );

  // (f) mentions post-migration state assertion
  const postMigrationState =
    (sectionLower.includes("post-migration") && sectionLower.includes("state")) ||
    (sectionLower.includes("after") && sectionLower.includes("migration") && sectionLower.includes("state")) ||
    (sectionLower.includes("schema") && sectionLower.includes("assert")) ||
    sectionLower.includes("post-migration state");
  assert(
    postMigrationState,
    "Migration rule must specify asserting post-migration state (schema, constraints, indexes, rows)"
  );
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: creating-plans SKILL.md migration rule.
 * When: the rule is extracted.
 * Then: it explicitly FORBIDS satisfying the requirement with a text-match assertion
 *       on the migration file itself.
 */
test("creating-plans: migration rule FORBIDS text-match assertions on the migration file", () => {
  // Look for the migration section again
  const migrationSection = extractSection(creatingPlansMd, "migration");
  const sqlSection = extractSection(creatingPlansMd, "SQL");

  const relevantSection = migrationSection.length > 0 ? migrationSection : sqlSection;
  assert(
    relevantSection.length > 0,
    "Migration rule section must exist in creating-plans SKILL.md"
  );

  const sectionLower = relevantSection.toLowerCase();

  // (a) explicitly forbids text-match on migration file
  const forbidsTextMatch =
    sectionLower.includes("not a text-match") ||
    sectionLower.includes("text-match assertion") ||
    sectionLower.includes("reads the migration file and checks for keywords") ||
    sectionLower.includes("file itself") ||
    (sectionLower.includes("not") && sectionLower.includes("text")) ||
    sectionLower.includes("forbidden") ||
    sectionLower.includes("theatre");
  assert(
    forbidsTextMatch,
    "Migration rule must explicitly forbid satisfying the requirement with text-match assertions on the migration file"
  );

  // (b) clarifies why text-match is insufficient
  const explainsWhy =
    sectionLower.includes("proves the file was written") ||
    sectionLower.includes("not that the migration is correct") ||
    sectionLower.includes("syntactically valid") ||
    sectionLower.includes("theatre") ||
    sectionLower.includes("why") ||
    sectionLower.includes("does not prove");
  assert(
    explainsWhy,
    "Migration rule must explain why text-match is insufficient (e.g., it only proves the file exists, not that it works)"
  );
});
