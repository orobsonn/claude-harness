import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CANONICAL_ROLES, EYE_ROLES, HAND_ROLES, isCanonicalRole, rolePolicy } from "./roles.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const EYE_TOOLS = ["read", "grep", "find", "ls"];
const HAND_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

test("only namespaced harness roles are canonical", () => {
  assert.equal(CANONICAL_ROLES.length, 10);
  assert.equal(new Set(CANONICAL_ROLES).size, 10);
  assert.equal(isCanonicalRole("harness-planner"), true);
  assert.equal(isCanonicalRole("planner"), false);
  assert.equal(isCanonicalRole("HARNESS-planner"), false);
  assert.equal(isCanonicalRole("harness-unknown"), false);
});

test("role policies preserve the harness split between eyes and hands", () => {
  assert.deepEqual([...EYE_ROLES].sort(), [
    "harness-adversary",
    "harness-compliance",
    "harness-harvester",
    "harness-plan-reviewer",
    "harness-planner",
    "harness-security",
  ]);
  assert.deepEqual([...HAND_ROLES].sort(), [
    "harness-executor",
    "harness-shipper",
    "harness-sniper",
    "harness-test-author",
  ]);
  for (const role of EYE_ROLES) assert.deepEqual(rolePolicy(role).tools, EYE_TOOLS, role);
  for (const role of HAND_ROLES) assert.deepEqual(rolePolicy(role).tools, HAND_TOOLS, role);
  assert.equal(rolePolicy("harness-unknown"), null);
});

test("each canonical role has a locked Pi agent asset matching its policy", () => {
  for (const role of CANONICAL_ROLES) {
    const asset = join(ROOT, "core", "pi", "runtime", "agents", `${role}.md`);
    assert.equal(existsSync(asset), true, asset);
    const content = readFileSync(asset, "utf8");
    assert.match(content, /^locked: true$/m, role);
    assert.match(content, new RegExp(`tools: ${rolePolicy(role).tools.join(", ")}`), role);
  }
});
