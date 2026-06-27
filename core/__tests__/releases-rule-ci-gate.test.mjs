import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

test("core/rules/releases.md contains CI-gate rule with mandatory/advisory posture and no-admin-token fallback", () => {
  const releasesRulePath = new URL("../rules/releases.md", import.meta.url);
  const content = readFileSync(releasesRulePath, "utf8");

  // Assert the section exists and contains all required elements:
  // 1. CI green as a release prerequisite
  // 2. MANDATORY for newly-onboarded projects
  // 3. ADVISORY for existing ones (additive posture)
  // 4. no-admin-token fallback (gate available but protection not enforced)

  assert(
    content.includes("CI") && content.includes("prerequisite"),
    "releases.md must state CI green as a release prerequisite"
  );

  assert(
    content.includes("mandatory") && content.includes("new"),
    "releases.md must state that CI gate is MANDATORY for newly-onboarded projects"
  );

  assert(
    content.includes("advisory") && content.includes("existing"),
    "releases.md must state that CI gate is ADVISORY (additive) for existing projects"
  );

  assert(
    content.includes("admin") && content.includes("token"),
    "releases.md must include the no-admin-token fallback (gate available but protection not enforced)"
  );

  // Co-occurrence check: all four elements must appear in the same section
  const ciGateSection = content.match(
    /### CI.*?(?=###|\Z)/is
  );
  assert(
    ciGateSection,
    "releases.md must have a CI-gate subsection (### CI...)"
  );

  const section = ciGateSection[0];
  assert(
    section.includes("prerequisite"),
    "CI-gate section must mention prerequisite"
  );
  assert(
    section.includes("mandatory"),
    "CI-gate section must mention mandatory"
  );
  assert(
    section.includes("advisory"),
    "CI-gate section must mention advisory"
  );
  assert(
    section.includes("admin") && section.includes("token"),
    "CI-gate section must mention admin token fallback"
  );
});
