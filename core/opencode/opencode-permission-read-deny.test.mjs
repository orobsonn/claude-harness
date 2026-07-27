/** @description Pins the target shape of `permission.read` / `permission.edit` in the two
 * tracked opencode configs (repo-root `opencode.json` and the vendored
 * `core/opencode/opencode.json.example`): per-pattern maps with a `"*": "allow"` wildcard
 * serialized FIRST, followed by the 8 locked deny patterns, resolved last-match-wins. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rootConfigUrl = new URL("../../opencode.json", import.meta.url);
const exampleConfigUrl = new URL("./opencode.json.example", import.meta.url);

const rootConfig = JSON.parse(readFileSync(rootConfigUrl, "utf8"));
const exampleConfig = JSON.parse(readFileSync(exampleConfigUrl, "utf8"));

const DENY_PATTERNS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".dev.vars",
  "**/.dev.vars",
  "~/.ssh/**",
  "~/.aws/**",
];

const maps = [
  { label: "root read", map: rootConfig.permission.read },
  { label: "root edit", map: rootConfig.permission.edit },
  { label: "example read", map: exampleConfig.permission.read },
  { label: "example edit", map: exampleConfig.permission.edit },
];

test("opencode.json permission.read/edit are per-pattern maps, not scalars (#ac-1.5)", () => {
  assert.equal(
    typeof rootConfig.permission.read,
    "object",
    "root permission.read must be a per-pattern map (object), not a scalar string like \"allow\"",
  );
  assert.notEqual(
    rootConfig.permission.read,
    null,
    "root permission.read must not be null",
  );
  assert.equal(
    Array.isArray(rootConfig.permission.read),
    false,
    "root permission.read must be a plain object, not an array",
  );

  assert.equal(
    typeof rootConfig.permission.edit,
    "object",
    "root permission.edit must be a per-pattern map (object), not a scalar string like \"allow\"",
  );
  assert.notEqual(
    rootConfig.permission.edit,
    null,
    "root permission.edit must not be null",
  );
  assert.equal(
    Array.isArray(rootConfig.permission.edit),
    false,
    "root permission.edit must be a plain object, not an array",
  );

  assert.equal(
    typeof exampleConfig.permission.read,
    "object",
    "example permission.read must be a per-pattern map (object), not a scalar string like \"allow\"",
  );
  assert.notEqual(
    exampleConfig.permission.read,
    null,
    "example permission.read must not be null",
  );
  assert.equal(
    Array.isArray(exampleConfig.permission.read),
    false,
    "example permission.read must be a plain object, not an array",
  );

  assert.equal(
    typeof exampleConfig.permission.edit,
    "object",
    "example permission.edit must be a per-pattern map (object), not a scalar string like \"allow\"",
  );
  assert.notEqual(
    exampleConfig.permission.edit,
    null,
    "example permission.edit must not be null",
  );
  assert.equal(
    Array.isArray(exampleConfig.permission.edit),
    false,
    "example permission.edit must be a plain object, not an array",
  );
});

test("wildcard \"*\": \"allow\" is serialized as the first key in every permission map (#ac-1.5)", () => {
  for (const { label, map } of maps) {
    const keys = Object.keys(map);
    assert.equal(
      keys[0],
      "*",
      `${label}: wildcard must be the first serialized key — resolution is last-match-wins, so a wildcard after the denies would make every deny inert`,
    );
    assert.equal(
      map["*"],
      "allow",
      `${label}: the first key "*" must resolve to "allow"`,
    );
  }
});

test("all 8 locked deny patterns are present and sit after the wildcard (#ac-1.5)", () => {
  for (const { label, map } of maps) {
    const keys = Object.keys(map);
    const wildcardIndex = keys.indexOf("*");
    for (const pattern of DENY_PATTERNS) {
      assert.equal(
        map[pattern],
        "deny",
        `${label}: pattern "${pattern}" must be present with value "deny"`,
      );
      const patternIndex = keys.indexOf(pattern);
      assert.ok(
        patternIndex > wildcardIndex,
        `${label}: pattern "${pattern}" must be serialized after the wildcard "*" so it is not shadowed by last-match-wins resolution`,
      );
    }
  }
});

test("each permission map has exactly 9 keys — wildcard plus the 8 locked denies (#ac-1.5)", () => {
  for (const { label, map } of maps) {
    assert.equal(
      Object.keys(map).length,
      9,
      `${label}: must have exactly 9 keys (1 wildcard + 8 locked deny patterns) — no invented ninth pattern and no allow carve-out`,
    );
  }
});

test("the tracked root config and the vendored example config never diverge in permission.read/edit (#ac-1.5)", () => {
  assert.equal(
    JSON.stringify(rootConfig.permission.read),
    JSON.stringify(exampleConfig.permission.read),
    "root and example permission.read maps must be byte-identical in serialized key order",
  );
  assert.equal(
    JSON.stringify(rootConfig.permission.edit),
    JSON.stringify(exampleConfig.permission.edit),
    "root and example permission.edit maps must be byte-identical in serialized key order",
  );
});
