import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readRepoFile = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("README version badge uses the package version and a static-badge color", () => {
  const readme = readRepoFile("README.md");
  const { version } = JSON.parse(readRepoFile("package.json"));
  const badgeMatch = readme.match(
    /!\[version\]\((https:\/\/img\.shields\.io\/static\/v1\?[^\s)]+)\)\s*<!-- x-release-please-version -->/
  );

  assert.ok(badgeMatch, "version badge and release-please marker must stay together");
  const badgeUrl = new URL(badgeMatch[1]);
  assert.equal(badgeUrl.pathname, "/static/v1");
  assert.equal(badgeUrl.searchParams.get("label"), "version");
  assert.equal(badgeUrl.searchParams.get("message"), version);
  assert.equal(badgeUrl.searchParams.get("color"), "blue");
});
