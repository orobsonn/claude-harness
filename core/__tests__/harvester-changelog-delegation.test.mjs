import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

test("core/agents/harvester.md delegates CHANGELOG.md ownership to release-please", () => {
  const harvesterPath = new URL("../agents/harvester.md", import.meta.url);
  const content = readFileSync(harvesterPath, "utf8");

  assert(
    content.includes("release-please"),
    "harvester.md must mention release-please as the CHANGELOG owner"
  );

  assert(
    /release-please.*owns it/is.test(content) ||
      /release-please owns it/i.test(content),
    "harvester.md must explicitly state release-please owns CHANGELOG.md"
  );

  assert(
    content.includes("never writes, appends, or edits") ||
      content.includes("does not write") ||
      content.includes("never write"),
    "harvester.md must state it never writes/appends/edits CHANGELOG.md when release-please is configured"
  );

  assert(
    content.includes("Conventional Commits"),
    "harvester.md must attribute the CHANGELOG derivation to Conventional Commits"
  );
});

test("core/agents/harvester.md keeps the manual CHANGELOG fallback conditioned on absence of release-please", () => {
  const harvesterPath = new URL("../agents/harvester.md", import.meta.url);
  const content = readFileSync(harvesterPath, "utf8");

  const changelogBullet = content.match(/-\s+\*\*`CHANGELOG\.md`\*\*.*/);
  assert(changelogBullet, "harvester.md must have a CHANGELOG.md bullet in the Docs section");

  const bulletText = changelogBullet[0];
  assert(
    bulletText.includes("without") && bulletText.includes("release-please"),
    "the CHANGELOG.md bullet must condition the manual fallback on projects without release-please"
  );
  assert(
    bulletText.includes("releases.md"),
    "the CHANGELOG.md bullet must point to core/rules/releases.md for the manual fallback flow"
  );
});
