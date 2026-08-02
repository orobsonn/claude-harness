/** @description Pins the target shape of `permission.read` / `permission.edit` in the two
 * tracked opencode configs (repo-root `opencode.json` and the vendored
 * `core/opencode/opencode.json.example`): per-pattern maps with a `"*": "allow"` wildcard
 * serialized FIRST. Read keeps the 8 secret denies; edit adds the harness-owned state deny. */

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

const STATE_DENY = ".opencode/plans/.state/**";
const readMaps = [
  { label: "root read", map: rootConfig.permission.read },
  { label: "example read", map: exampleConfig.permission.read },
];
const editMaps = [
  { label: "root edit", map: rootConfig.permission.edit },
  { label: "example edit", map: exampleConfig.permission.edit },
];
const maps = [...readMaps, ...editMaps];

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

test("all 8 locked secret deny patterns are present and sit after the wildcard (#ac-1.5)", () => {
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

test("read has exactly the wildcard + 8 secret denies; edit also denies harness state", () => {
  for (const { label, map } of readMaps) {
    assert.equal(
      Object.keys(map).length,
      9,
      `${label}: must have exactly 9 keys (1 wildcard + 8 locked deny patterns)`,
    );
  }
  for (const { label, map } of editMaps) {
    assert.equal(map[STATE_DENY], "deny", `${label}: harness state must be denied`);
    assert.ok(Object.keys(map).indexOf(STATE_DENY) > Object.keys(map).indexOf("*"));
    assert.equal(Object.keys(map).length, 10, `${label}: must add exactly one state deny`);
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
