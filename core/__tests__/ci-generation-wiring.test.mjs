/**
 * @description Verifies CI generation and branch protection wiring in initializing-projects/SKILL.md.
 * Tests that:
 * 1. SKILL.md references generate-ci.mjs and documents the order of operations (workflow lands and runs BEFORE branch protection).
 * 2. SKILL.md states branch protection is reported as "not applied" when no admin token is present.
 * 3. vendor-core.mjs does NOT vendor a static ci.yml template.
 */

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("initializing-projects/SKILL.md references generate-ci.mjs and documents workflow-then-protection order", () => {
  const skillPath = resolve(__dirname, "../skills/initializing-projects/SKILL.md");
  const skillContent = readFileSync(skillPath, "utf8");

  // Assertion 1a: SKILL.md must reference generate-ci.mjs
  assert(
    skillContent.includes("generate-ci.mjs"),
    "SKILL.md must reference 'generate-ci.mjs' for CI generation during onboarding"
  );

  // Assertion 1b: SKILL.md must document the order-of-operations constraint
  const orderOfOpsSection = skillContent.match(
    /generate-ci\.mjs[\s\S]{0,2000}branch.{0,50}protect/i
  );
  assert(
    orderOfOpsSection !== null,
    "SKILL.md must document the relationship between CI generation and branch protection in co-located text"
  );

  // Assertion 1c: Must explicitly state workflow lands and runs BEFORE protection
  assert(
    skillContent.includes("lands and runs") ||
      skillContent.includes("run once") ||
      skillContent.includes("has run once") ||
      (skillContent.includes("workflow") && skillContent.includes("before")),
    "SKILL.md must document that the workflow lands and runs once BEFORE branch protection is applied"
  );
});

test("initializing-projects/SKILL.md states branch protection is 'not applied' when no admin token", () => {
  const skillPath = resolve(__dirname, "../skills/initializing-projects/SKILL.md");
  const skillContent = readFileSync(skillPath, "utf8");

  // Assertion 2a: Must mention "not applied" (not failed)
  assert(
    skillContent.includes("not applied"),
    "SKILL.md must state branch protection is 'not applied' (not failed) when no admin token is present"
  );

  // Assertion 2b: Should contextualize the lack of admin token
  assert(
    skillContent.includes("admin") || skillContent.includes("token"),
    "SKILL.md must reference the admin token requirement in the 'not applied' clause"
  );
});

test("vendor-core.mjs REPO_FILES does NOT vendor a static ci.yml", () => {
  const vendorPath = resolve(
    __dirname,
    "../skills/initializing-projects/references/vendor-core.mjs"
  );
  const vendorContent = readFileSync(vendorPath, "utf8");

  // Assertion 3: REPO_FILES must NOT contain any ci.yml entry
  // Check the REPO_FILES array definition
  const repoFilesMatch = vendorContent.match(
    /const\s+REPO_FILES\s*=\s*\[([\s\S]*?)\]/
  );
  assert(
    repoFilesMatch !== null,
    "vendor-core.mjs must have a REPO_FILES constant defined"
  );

  const repoFilesContent = repoFilesMatch[1];
  assert(
    !repoFilesContent.includes("ci.yml"),
    "vendor-core.mjs REPO_FILES must NOT vendor a static ci.yml (CI is generated per-project, never vendored)"
  );
});
