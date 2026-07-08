#!/usr/bin/env node
/**
 * @description Locked tests for the fresh-Response-per-call fetch mock convention.
 * Verifies that core/rules/testing-unit.md and core/agents/test-author.md document
 * fetch mocks built with vi.fn().mockImplementation(() => new Response(...)) instead
 * of a shared vi.fn().mockResolvedValue(new Response(...)) singleton — a Response body
 * is a single-use stream, so a resolved-value mock reuses the same instance/body across
 * calls and breaks after the first read.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TESTING_UNIT_MD_PATH = resolve(__dirname, "../rules/testing-unit.md");
const TEST_AUTHOR_MD_PATH = resolve(__dirname, "../agents/test-author.md");

const testingUnitMd = readFileSync(TESTING_UNIT_MD_PATH, "utf8");
const testAuthorMd = readFileSync(TEST_AUTHOR_MD_PATH, "utf8");

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
 * Extract the fetch-mock bullet region from the Patterns bullet list in testing-unit.md.
 * Starts at the line for the fetch-mock example bullet and stops right before the next
 * top-level bold-bullet line — a bullet marker in column 0, not a heading, so extractSection
 * would return an empty string for this target.
 * @param {string} content - Full markdown content.
 * @returns {string} The extracted bullet region, or empty string if not found.
 */
function extractBulletRegion(content) {
  const lines = content.split("\n");
  const startMarker = "- **Mock de fetch no client HTTP**:";
  const boundaryPattern = /^- \*\*/;
  let capturing = false;
  const captured = [];

  for (const line of lines) {
    if (!capturing) {
      if (line.startsWith(startMarker)) {
        capturing = true;
        captured.push(line);
      }
    } else {
      if (boundaryPattern.test(line)) {
        break;
      }
      captured.push(line);
    }
  }

  return captured.join("\n");
}

// ─── Test 1 ───────────────────────────────────────────────────────────────────
/**
 * Given: the "Mock de fetch no client HTTP" bullet region in testing-unit.md.
 * When: the region is extracted via extractBulletRegion and lowercased.
 * Then: it contains the substring "mockimplementation".
 */
test("testing-unit.md: fetch-mock bullet region uses mockImplementation", () => {
  const bulletRegion = extractBulletRegion(testingUnitMd);
  const bulletRegionLower = bulletRegion.toLowerCase();

  assert(
    bulletRegionLower.includes("mockimplementation"),
    'Fetch-mock bullet region in testing-unit.md must contain "mockImplementation"'
  );
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: the same fetch-mock bullet region, lowercased.
 * When: searched for the mockResolvedValue token.
 * Then: it does NOT contain any occurrence of "mockresolvedvalue" — scoped only to
 *       this bullet region, never to the file as a whole.
 */
test("testing-unit.md: fetch-mock bullet region does not use mockResolvedValue", () => {
  const bulletRegion = extractBulletRegion(testingUnitMd);
  const bulletRegionLower = bulletRegion.toLowerCase();

  assert(
    !bulletRegionLower.includes("mockresolvedvalue"),
    'Fetch-mock bullet region in testing-unit.md must not contain any occurrence of "mockResolvedValue"'
  );
});

// ─── Test 3 ───────────────────────────────────────────────────────────────────
/**
 * Given: the same fetch-mock bullet region, lowercased.
 * When: occurrences of "mockimplementation" are counted.
 * Then: there are at least two occurrences — the 200 case and the 500 case both converted.
 */
test("testing-unit.md: fetch-mock bullet region converts both call sites (200 and 500) to mockImplementation", () => {
  const bulletRegion = extractBulletRegion(testingUnitMd);
  const bulletRegionLower = bulletRegion.toLowerCase();
  const occurrences = bulletRegionLower.split("mockimplementation").length - 1;

  assert(
    occurrences >= 2,
    `Fetch-mock bullet region must contain at least 2 occurrences of "mockImplementation" (both the 200 and 500 call sites), found ${occurrences}`
  );
});

// ─── Test 4 ───────────────────────────────────────────────────────────────────
/**
 * Given: the "Gotchas" section of testing-unit.md.
 * When: the section is extracted via extractSection and split into individual bullets.
 * Then: at least one bullet contains, within that same bullet, both the "mockresolvedvalue"
 *       token and a negation word (nunca | não | nao | never | evitar) — co-occurrence
 *       scoped per bullet, never across the whole section.
 */
test("testing-unit.md: Gotchas warns against mockResolvedValue for Response mocks", () => {
  const gotchasSection = extractSection(testingUnitMd, "Gotchas");
  const bullets = gotchasSection.split(/\n(?=- )/);
  const negationWords = ["nunca", "não", "nao", "never", "evitar"];

  const hasQualifyingBullet = bullets.some((bullet) => {
    const bulletLower = bullet.toLowerCase();
    return (
      bulletLower.includes("mockresolvedvalue") &&
      negationWords.some((word) => bulletLower.includes(word))
    );
  });

  assert(
    hasQualifyingBullet,
    'Gotchas section in testing-unit.md must have a bullet that both mentions "mockResolvedValue" and a negation word (nunca/não/nao/never/evitar) in the same bullet'
  );
});

// ─── Test 5 ───────────────────────────────────────────────────────────────────
/**
 * Given: the "Transcreva" section of test-author.md.
 * When: the section is extracted via extractSection (partial token "Transcreva") and lowercased.
 * Then: it contains all four: "mockimplementation", "new response", at least one single-use-body
 *       token (single-use | uma única vez | readablestream | bodyused), and at least one
 *       fresh-body token (fresco | dentro do closure | json.stringify) — scoped only to this
 *       section, never a whole-file search.
 */
test("test-author.md: Transcreva section documents mockImplementation + new Response + single-use body + fresh body", () => {
  const transcrevaSection = extractSection(testAuthorMd, "Transcreva");
  const sectionLower = transcrevaSection.toLowerCase();

  assert(
    sectionLower.includes("mockimplementation"),
    'Transcreva section in test-author.md must contain "mockImplementation"'
  );

  assert(
    sectionLower.includes("new response"),
    'Transcreva section in test-author.md must contain "new Response"'
  );

  const singleUseBodyTokens = ["single-use", "uma única vez", "readablestream", "bodyused"];
  assert(
    singleUseBodyTokens.some((token) => sectionLower.includes(token)),
    "Transcreva section in test-author.md must declare the single-use-body reason (single-use | uma única vez | readablestream | bodyUsed)"
  );

  const freshBodyTokens = ["fresco", "dentro do closure", "json.stringify"];
  assert(
    freshBodyTokens.some((token) => sectionLower.includes(token)),
    "Transcreva section in test-author.md must declare the fresh-body-per-call constraint (fresco | dentro do closure | JSON.stringify)"
  );
});

// ─── Test 6 ───────────────────────────────────────────────────────────────────
/**
 * Given: the "Mocks" section of testing-unit.md (partial token "Mocks" — the real heading
 *        is "### Mocks — so nas bordas" with an em-dash).
 * When: the section is extracted via extractSection and lowercased.
 * Then: it contains "mockimplementation" and does NOT contain "mockresolvedvalue".
 */
test("testing-unit.md: Mocks section prescribes mockImplementation, not mockResolvedValue", () => {
  const mocksSection = extractSection(testingUnitMd, "Mocks");
  const mocksSectionLower = mocksSection.toLowerCase();

  assert(
    mocksSectionLower.includes("mockimplementation"),
    'Mocks section in testing-unit.md must contain "mockImplementation"'
  );

  assert(
    !mocksSectionLower.includes("mockresolvedvalue"),
    'Mocks section in testing-unit.md must not contain "mockResolvedValue"'
  );
});

// ─── Test 7 ───────────────────────────────────────────────────────────────────
/**
 * Given: the same "Mocks" section, lowercased.
 * When: searched for the fresh-body-inside-the-closure constraint.
 * Then: it contains at least one of: "fresco" | "dentro do closure" — deliberately without
 *       "readablestream", which belongs to the single-use-body reason (test 8), not this
 *       fresh-body constraint.
 */
test("testing-unit.md: Mocks section declares the fresh-body-inside-closure constraint", () => {
  const mocksSection = extractSection(testingUnitMd, "Mocks");
  const mocksSectionLower = mocksSection.toLowerCase();
  const freshBodyTokens = ["fresco", "dentro do closure"];

  assert(
    freshBodyTokens.some((token) => mocksSectionLower.includes(token)),
    'Mocks section in testing-unit.md must declare the fresh-body constraint via "fresco" or "dentro do closure"'
  );
});

// ─── Test 8 ───────────────────────────────────────────────────────────────────
/**
 * Given: the same "Mocks" section, lowercased.
 * When: searched for the single-use-body reason.
 * Then: it contains at least one of: "single-use" | "uma única vez" | "readablestream" |
 *       "bodyused". This pins presence only — it does not assert absence of the string
 *       "cannot perform i/o on behalf of a different request"; citing it as a repro is allowed.
 */
test("testing-unit.md: Mocks section declares the single-use-body reason", () => {
  const mocksSection = extractSection(testingUnitMd, "Mocks");
  const mocksSectionLower = mocksSection.toLowerCase();
  const singleUseTokens = ["single-use", "uma única vez", "readablestream", "bodyused"];

  assert(
    singleUseTokens.some((token) => mocksSectionLower.includes(token)),
    "Mocks section in testing-unit.md must declare the single-use-body reason (single-use | uma única vez | readablestream | bodyUsed)"
  );
});
