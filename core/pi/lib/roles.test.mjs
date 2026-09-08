import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CANONICAL_ROLES, DISCUSSION_ROLES, EYE_ROLES, HAND_ROLES, RUNTIME_ROLES, isCanonicalRole, isDiscussionRole, isRuntimeRole, rolePolicy } from "./roles.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const EYE_TOOLS = ["read", "grep", "find", "ls"];
const HAND_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const SHIPPER_TOOLS = ["read", "grep", "find", "ls", "bash"];
const PLANNER_TOOLS = ["read", "grep", "find", "ls", "write"];

test("only namespaced harness roles are canonical", () => {
  assert.equal(CANONICAL_ROLES.length, 11);
  assert.equal(new Set(CANONICAL_ROLES).size, 11);
  assert.equal(isCanonicalRole("harness-planner"), true);
  assert.equal(isCanonicalRole("harness-discussion-adversary"), false);
  assert.deepEqual(DISCUSSION_ROLES, ["harness-discussion-adversary"]);
  assert.equal(RUNTIME_ROLES.length, 12);
  assert.equal(isDiscussionRole("harness-discussion-adversary"), true);
  assert.equal(isRuntimeRole("harness-discussion-adversary"), true);
  assert.equal(isCanonicalRole("planner"), false);
  assert.equal(isCanonicalRole("HARNESS-planner"), false);
  assert.equal(isCanonicalRole("harness-unknown"), false);
});

test("discussion adversary is a read-only runtime role outside delivery", () => {
  assert.equal(rolePolicy("harness-discussion-adversary").kind, "discussion");
  assert.deepEqual(rolePolicy("harness-discussion-adversary").tools, EYE_TOOLS);
});

test("role policies preserve the harness split between eyes and hands", () => {
  assert.deepEqual([...EYE_ROLES].sort(), [
    "harness-adversary",
    "harness-compliance",
    "harness-harvester",
    "harness-plan-reviewer",
    "harness-planner",
    "harness-security",
    "harness-test-reviewer",
  ]);
  assert.deepEqual([...HAND_ROLES].sort(), [
    "harness-executor",
    "harness-shipper",
    "harness-sniper",
    "harness-test-author",
  ]);
  for (const role of EYE_ROLES) {
    if (role === "harness-planner") continue;
    assert.deepEqual(rolePolicy(role).tools, EYE_TOOLS, role);
  }
  for (const role of HAND_ROLES) {
    assert.deepEqual(rolePolicy(role).tools, role === "harness-shipper" ? SHIPPER_TOOLS : HAND_TOOLS, role);
  }
  assert.equal(rolePolicy("harness-unknown"), null);
});

test("only the planner escapes the eye tool set, and only to author the canonical plan", () => {
  assert.deepEqual(rolePolicy("harness-planner").tools, PLANNER_TOOLS);
  assert.equal(rolePolicy("harness-planner").kind, "eye");
  // Nenhum olho escreve código: nem `edit` nem `bash` entram no planner.
  assert.equal(rolePolicy("harness-planner").tools.includes("edit"), false);
  assert.equal(rolePolicy("harness-planner").tools.includes("bash"), false);
});

test("each canonical role has a locked Pi agent asset matching its policy", () => {
  for (const role of RUNTIME_ROLES) {
    const asset = join(ROOT, "core", "pi", "runtime", "agents", `${role}.md`);
    assert.equal(existsSync(asset), true, asset);
    const content = readFileSync(asset, "utf8");
    assert.match(content, /^locked: true$/m, role);
    assert.match(content, new RegExp(`tools: ${rolePolicy(role).tools.join(", ")}`), role);
  }
});
