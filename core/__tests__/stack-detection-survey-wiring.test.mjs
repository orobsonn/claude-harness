/**
 * @description Verifies that surveying-codebase/SKILL.md instructs running
 * detect-stack on cold entry (detection-only, generation stays in initializing-projects).
 */

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("surveying-codebase/SKILL.md instructs detect-stack on cold entry and does NOT claim to generate ci.yml", () => {
  const skillPath = resolve(__dirname, "../skills/surveying-codebase/SKILL.md");
  const skillContent = readFileSync(skillPath, "utf8");

  // Assertion 1: SKILL.md must reference detect-stack (detection-only wiring)
  assert(
    skillContent.includes("detect-stack"),
    "SKILL.md must reference 'detect-stack' to instruct running stack detection on cold entry"
  );

  // Assertion 2: SKILL.md must reference detect-stack.mjs file location
  assert(
    skillContent.includes("detect-stack.mjs"),
    "SKILL.md must reference 'detect-stack.mjs' to point to the detection reference implementation"
  );

  // Assertion 3: SKILL.md must explicitly state that generation belongs to initializing-projects
  assert(
    skillContent.includes("initializing-projects") &&
      (skillContent.includes("generation") ||
        skillContent.includes("ci.yml") ||
        skillContent.includes("CI generation")),
    "SKILL.md must explicitly state that CI generation belongs to initializing-projects, not the survey"
  );

  // Assertion 4: Both detect-stack reference AND generation-ownership clause must coexist
  // in a fitting section (i.e., not just scattered anywhere — should be in Pipeline or When to use)
  const sections = skillContent.split(/^## /m);
  let foundCoOccurrence = false;

  for (const section of sections) {
    if (
      section.includes("detect-stack") &&
      section.includes("initializing-projects") &&
      (section.includes("generation") ||
        section.includes("ci.yml") ||
        section.includes("CI generation"))
    ) {
      foundCoOccurrence = true;
      break;
    }
  }

  assert(
    foundCoOccurrence,
    "SKILL.md must include detect-stack reference and generation-ownership clause co-located in the same section (e.g., Pipeline or When to use)"
  );
});
