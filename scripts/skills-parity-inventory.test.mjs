/** @description Pins the three-skill closure decision (creating-issues, measuring-cost, reviewing-pull-requests) on the OC-port skills inventory table, and pins that creating-plans / initializing-projects keep their own already-resolved rationale untouched by that closure. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const FULL_MAP_PATH = join(
  REPO_ROOT,
  "docs/specs/oc-port/inventory/full-map.md"
);

const DECISION_TOKENS = ["PORT", "DROP", "CC-only-deferred"];
const DECISION_TOKEN_RE = new RegExp(`\\b(${DECISION_TOKENS.join("|")})\\b`, "g");
const DECISION_TOKEN_TEST_RE = new RegExp(`\\b(${DECISION_TOKENS.join("|")})\\b`);

/**
 * @description Find the table row line for a given skill name (line starting with `| <skill> |`).
 * @param {string} text
 * @param {string} skill
 * @returns {string | undefined}
 */
function getRowLine(text, skill) {
  return text
    .split("\n")
    .find((line) => line.trim().startsWith(`| ${skill} |`));
}

describe("skills-parity-inventory", () => {
  it("creating-issues, measuring-cost and reviewing-pull-requests rows each carry exactly one decision token with a non-empty reason", () => {
    const text = readFileSync(FULL_MAP_PATH, "utf8");
    const skills = ["creating-issues", "measuring-cost", "reviewing-pull-requests"];

    for (const skill of skills) {
      const line = getRowLine(text, skill);
      assert.ok(line, `row for "${skill}" not found in full-map.md`);

      const matches = [...line.matchAll(DECISION_TOKEN_RE)];
      assert.equal(
        matches.length,
        1,
        `expected exactly one decision token (PORT|DROP|CC-only-deferred) on the "${skill}" row, found ${matches.length}: "${line}"`
      );

      const token = matches[0][0];
      const afterTokenIdx = matches[0].index + token.length;
      let reason = line.slice(afterTokenIdx);
      reason = reason.replace(/\|+\s*$/, "").trim();
      reason = reason.replace(/^[\s\-–—:]+/, "").trim();

      assert.ok(
        reason.length >= 3,
        `expected a non-empty reason after "${token}" on the "${skill}" row, got: "${reason}" (full line: "${line}")`
      );
    }
  });

  it("creating-plans and initializing-projects rows keep their own existing rationale and are untouched by the three-skill closure decision", () => {
    const text = readFileSync(FULL_MAP_PATH, "utf8");

    const plansLine = getRowLine(text, "creating-plans");
    const initLine = getRowLine(text, "initializing-projects");

    assert.ok(plansLine, `row for "creating-plans" not found in full-map.md`);
    assert.ok(initLine, `row for "initializing-projects" not found in full-map.md`);

    assert.match(
      plansLine,
      /cc|schema|oc inline/i,
      `creating-plans row must retain its CC / schema / OC inline rationale, got: "${plansLine}"`
    );
    assert.match(
      initLine,
      /pkg/i,
      `initializing-projects row must retain its PKG rationale, got: "${initLine}"`
    );

    assert.equal(
      DECISION_TOKEN_TEST_RE.test(plansLine),
      false,
      `creating-plans row must NOT contain a decision token (PORT|DROP|CC-only-deferred), got: "${plansLine}"`
    );
    assert.equal(
      DECISION_TOKEN_TEST_RE.test(initLine),
      false,
      `initializing-projects row must NOT contain a decision token (PORT|DROP|CC-only-deferred), got: "${initLine}"`
    );
  });
});
