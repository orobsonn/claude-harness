import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

test("core/rules/releases.md declares release-please as the primary CHANGELOG/release-PR owner when configured", () => {
  const releasesRulePath = new URL("../rules/releases.md", import.meta.url);
  const content = readFileSync(releasesRulePath, "utf8");

  const rpSection = content.match(/### Release-please.*?(?=\n### |$)/s);
  assert(rpSection, "releases.md must have a '### Release-please' subsection");

  const section = rpSection[0];

  assert(
    section.includes("release-please-config.json"),
    "release-please section must key off release-please-config.json presence"
  );
  assert(
    section.includes("CHANGELOG") && section.includes("Conventional Commits"),
    "release-please section must state the CHANGELOG is derived from Conventional Commits"
  );
  assert(
    /harness NAO edita/i.test(section) || /does not edit/i.test(section),
    "release-please section must state the harness does not edit CHANGELOG.md manually when configured"
  );
  assert(
    section.includes("chore: release"),
    "release-please section must state the harness does not open a manual 'chore: release' PR when configured"
  );
  assert(
    /fallback/i.test(section),
    "release-please section must mark the rest of the manual flow as the fallback for projects without release-please"
  );
});
