import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadSkillMap, unportedSourceSkills } from "./skills-map.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const SOURCE_DIRS = [
  join(ROOT, "core/claude-code/skills"),
  join(ROOT, "core/opencode/skills"),
];

function sourceSkills(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

test("every Claude Code and OpenCode skill maps to exactly one focused Codex skill", () => {
  const mapping = loadSkillMap();
  const sources = SOURCE_DIRS.flatMap(sourceSkills);
  assert.deepEqual(unportedSourceSkills(mapping, sources), []);
  assert.ok(new Set(mapping.map((row) => row.target)).size < mapping.length, "shared Codex skills intentionally collapse duplicate prose");
  for (const row of mapping) {
    assert.ok(existsSync(join(ROOT, "core/codex/skills", row.target, "SKILL.md")), `${row.source} points to a missing Codex skill: ${row.target}`);
  }
});
