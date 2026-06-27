/**
 * @description Verifies that updating-harness/SKILL.md instructs re-running
 * CI generation on re-sync AND explicitly states that existing ci.yml is NOT clobbered.
 */

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("updating-harness/SKILL.md instructs re-running CI generation on re-sync with non-clobber semantics", () => {
  const skillPath = resolve(__dirname, "../skills/updating-harness/SKILL.md");
  const skillContent = readFileSync(skillPath, "utf8");

  // Assertion 1: SKILL.md must reference generate-ci (CI generation re-sync instruction)
  assert(
    skillContent.includes("generate-ci"),
    "SKILL.md must reference 'generate-ci' to instruct re-running CI generation on re-sync"
  );

  // Assertion 2: SKILL.md must reference generate-ci.mjs file location
  assert(
    skillContent.includes("generate-ci.mjs"),
    "SKILL.md must reference 'generate-ci.mjs' to point to the CI generation reference implementation"
  );

  // Assertion 3: SKILL.md must explicitly state that existing ci.yml is NOT clobbered
  assert(
    skillContent.includes("ci.yml") &&
      (skillContent.includes("NOT clobber") ||
        skillContent.includes("not clobber") ||
        skillContent.includes("non-clobber") ||
        skillContent.includes("does not clobber") ||
        skillContent.includes("never clobber") ||
        skillContent.includes("does not overwrite") ||
        skillContent.includes("never overwrites")),
    "SKILL.md must explicitly state that existing ci.yml is NOT clobbered on re-sync"
  );

  // Assertion 4: Both generate-ci reference AND non-clobber clause must coexist
  // in a fitting section (same section = co-occurrence)
  const sections = skillContent.split(/^## /m);
  let foundCoOccurrence = false;

  for (const section of sections) {
    if (
      section.includes("generate-ci") &&
      section.includes("ci.yml") &&
      (section.includes("NOT clobber") ||
        section.includes("not clobber") ||
        section.includes("non-clobber") ||
        section.includes("does not clobber") ||
        section.includes("never clobber") ||
        section.includes("does not overwrite") ||
        section.includes("never overwrites"))
    ) {
      foundCoOccurrence = true;
      break;
    }
  }

  assert(
    foundCoOccurrence,
    "SKILL.md must include generate-ci reference and non-clobber clause co-located in the same section"
  );
});
