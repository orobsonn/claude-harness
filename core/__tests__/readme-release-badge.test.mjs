import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readRepoFile = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("README version badge uses the package version and a static-badge color", () => {
  const readme = readRepoFile("README.md");
  const { version } = JSON.parse(readRepoFile("package.json"));
  const badgeMatch = readme.match(
    /!\[version\]\((https:\/\/img\.shields\.io\/badge\/version-([^-\s)]+)-blue)\)\s*<!-- x-release-please-version -->/
  );

  assert.ok(badgeMatch, "version badge and release-please marker must stay together");
  assert.equal(
    badgeMatch[1],
    `https://img.shields.io/badge/version-${version}-blue`
  );
  assert.deepEqual(badgeMatch[1].split("/").at(-1).split("-"), [
    "version",
    version,
    "blue",
  ]);
});
