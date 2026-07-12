/**
 * @description Skill must invoke vendored mark-gate paths, never monorepo core/opencode (consumer worktrees).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const skill = join(dirname(fileURLToPath(import.meta.url)), "SKILL.md");

test("OC orchestrating-delivery skill: no monorepo core/opencode mark-gate CLI paths", () => {
  const text = readFileSync(skill, "utf8");
  assert.equal(
    /node\s+core\/opencode\/plugin\/lib\/mark-gate\.mjs/.test(text),
    false,
    "must use .opencode/plugin/lib/mark-gate.mjs for vendored headless",
  );
  assert.match(text, /node\s+\.opencode\/plugin\/lib\/mark-gate\.mjs/);
});
