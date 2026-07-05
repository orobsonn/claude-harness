#!/usr/bin/env node
/**
 * @description Consistency tests for reviewing-pull-requests SKILL.md.
 * Verifies that:
 *   1. The frontmatter has EXACTLY the keys `name` and `description` (no others),
 *      `name` is exactly `reviewing-pull-requests`, and the body declares the skill
 *      spawns NO write-hand (eyes-only — no executor / sniper / spawn-hand / Ollama
 *      dispatch of a write-capable hand).
 *   2. The body names all three eyes (adversary, compliance, security), the compliance
 *      diff-adapter, the cross-family requirement, and states the verdict artifact is
 *      written to the engine-controlled stateDir.
 *
 * Tests run under node:test.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

/**
 * @description Reads the SKILL.md under review, failing with a clear message if it
 * does not exist yet (expected RED before the skill is authored).
 * @returns {string} the raw SKILL.md content
 */
function readSkillMd() {
  try {
    return readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  } catch (error) {
    throw new Error(
      `Expected core/skills/reviewing-pull-requests/SKILL.md to exist and be readable, but got: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * @description Extracts the YAML frontmatter block (between the first two `---`
 * lines) and parses it into a simple `key -> value` map via naive line splitting.
 * @param {string} content - the full SKILL.md content
 * @returns {{ keys: string[], values: Record<string, string> }} parsed frontmatter
 */
function parseFrontmatter(content) {
  const lines = content.split("\n");
  assert.equal(lines[0].trim(), "---", "SKILL.md must open with a '---' frontmatter fence.");

  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  assert.notEqual(
    closingIndex,
    -1,
    "SKILL.md frontmatter must be closed with a second '---' fence."
  );

  const frontmatterLines = lines.slice(1, closingIndex + 1);
  const keys = [];
  const values = {};

  for (const line of frontmatterLines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (match) {
      const [, key, rawValue] = match;
      keys.push(key);
      values[key] = rawValue.trim().replace(/^"(.*)"$/, "$1");
    }
  }

  return { keys, values };
}

// ─── Test 1 ───────────────────────────────────────────────────────────────────
/**
 * Given: core/skills/reviewing-pull-requests/SKILL.md.
 * When: parsed.
 * Then:
 *   (a) the frontmatter has EXACTLY the keys `name` and `description` (no others), AND
 *   (b) `name` is exactly `reviewing-pull-requests`, AND
 *   (c) the body declares NO write-hand — the lowercased body must NOT match
 *       /spawn-hand|dispatch(es)?\s+(the\s+)?(executor|sniper)/ AND MUST match
 *       /no write.?hand|eyes.only|spawns? no/ (eyes-only, hands_free per #ac-2.2).
 */
test("SKILL.md: frontmatter has exactly name+description, name is reviewing-pull-requests, body declares eyes-only (no write-hand)", () => {
  const skillMd = readSkillMd();
  const { keys, values } = parseFrontmatter(skillMd);

  assert.deepEqual(
    keys.sort(),
    ["description", "name"],
    `Frontmatter must have EXACTLY the keys 'name' and 'description' (no others), got: ${JSON.stringify(keys)}`
  );

  assert.equal(
    values.name,
    "reviewing-pull-requests",
    `Frontmatter 'name' must be exactly 'reviewing-pull-requests', got: "${values.name}"`
  );

  const body = skillMd.slice(skillMd.indexOf("---", 3) + 3);
  const lowerBody = body.toLowerCase();

  const forbiddenWriteHandPattern = /spawn-hand|dispatch(es)?\s+(the\s+)?(executor|sniper)/;
  assert.equal(
    forbiddenWriteHandPattern.test(lowerBody),
    false,
    "SKILL.md body must NOT dispatch a write-hand (no 'spawn-hand', no 'dispatch(es) the executor/sniper') — this skill is eyes-only."
  );

  const declaresEyesOnlyPattern = /no write.?hand|eyes.only|spawns? no/;
  assert.equal(
    declaresEyesOnlyPattern.test(lowerBody),
    true,
    "SKILL.md body must explicitly declare it spawns no write-hand (e.g. 'no write-hand', 'eyes-only', 'spawns no ...')."
  );
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: the SKILL.md body.
 * When: scanned.
 * Then:
 *   (a) it names all three eyes (`adversary`, `compliance`, `security`), AND
 *   (b) it names the compliance `diff-adapter` (or `compliance-diff-adapter`), AND
 *   (c) it states the `cross-family` requirement, AND
 *   (d) it states the verdict artifact is written to the engine-controlled `stateDir`
 *       (body contains 'stateDir' AND a phrase about the verdict artifact, e.g.
 *       /verdict artifact.*stateDir|stateDir.*artifact|review-<pr>-<sha>/i).
 */
test("SKILL.md: names all three eyes, the compliance diff-adapter, cross-family requirement, and the stateDir verdict artifact", () => {
  const skillMd = readSkillMd();

  for (const eye of ["adversary", "compliance", "security"]) {
    assert.equal(
      skillMd.toLowerCase().includes(eye),
      true,
      `SKILL.md must name the '${eye}' eye.`
    );
  }

  const mentionsDiffAdapter =
    skillMd.includes("diff-adapter") || skillMd.includes("compliance-diff-adapter");
  assert.equal(
    mentionsDiffAdapter,
    true,
    "SKILL.md must name the compliance 'diff-adapter' (or 'compliance-diff-adapter')."
  );

  assert.equal(
    skillMd.toLowerCase().includes("cross-family"),
    true,
    "SKILL.md must state the 'cross-family' requirement."
  );

  assert.equal(
    skillMd.includes("stateDir"),
    true,
    "SKILL.md must mention 'stateDir' — the engine-controlled destination for the verdict artifact."
  );

  const verdictArtifactToStateDir =
    /verdict artifact[\s\S]{0,200}stateDir|stateDir[\s\S]{0,200}artifact|review-<pr>-<sha>/i.test(
      skillMd
    );
  assert.equal(
    verdictArtifactToStateDir,
    true,
    "SKILL.md must state that the verdict artifact is written to the engine-controlled 'stateDir' (e.g. 'verdict artifact ... stateDir' or a 'review-<pr>-<sha>' filename pattern)."
  );
});
