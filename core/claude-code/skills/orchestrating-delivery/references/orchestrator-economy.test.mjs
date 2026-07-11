import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_MD_PATH = resolve(__dirname, "../SKILL.md");
const CROSS_FAMILY_PATH = resolve(__dirname, "./cross-family-eyes.md");

const PRE_GROUP_D_BASELINE_BYTES = 96731;

const skillMd = readFileSync(SKILL_MD_PATH, "utf8");

test("#ac-1.1 shrink: SKILL.md is strictly smaller than the pre-Group-D baseline", () => {
  const actualBytes = Buffer.byteLength(skillMd, "utf8");
  assert.ok(
    actualBytes < PRE_GROUP_D_BASELINE_BYTES,
    `expected SKILL.md byte length (${actualBytes}) to be strictly less than the pre-Group-D baseline (${PRE_GROUP_D_BASELINE_BYTES})`
  );
});

test("#ac-1.1 migration not deletion: references/cross-family-eyes.md exists and carries the migrated detail", () => {
  assert.ok(existsSync(CROSS_FAMILY_PATH), "references/cross-family-eyes.md must exist");

  const crossFamilyMd = readFileSync(CROSS_FAMILY_PATH, "utf8");
  for (const token of ["pendingClaudeRefutation", "policy B", "codex-eye-nudge", "cross-family.mjs"]) {
    assert.ok(
      crossFamilyMd.includes(token),
      `expected references/cross-family-eyes.md to include "${token}"`
    );
  }
});

test("#ac-1.1 linked: SKILL.md links to the migrated reference", () => {
  assert.ok(
    skillMd.includes("references/cross-family-eyes.md"),
    'expected SKILL.md to include "references/cross-family-eyes.md"'
  );
});

test("cross-family tokens retained resident (skill-doc-consistency contract)", () => {
  assert.ok(skillMd.includes("cross-family.mjs"), 'expected SKILL.md to include "cross-family.mjs"');
  assert.ok(
    skillMd.includes("codex-eye-nudge") || skillMd.includes("nudge"),
    'expected SKILL.md to include "codex-eye-nudge" or "nudge"'
  );
  assert.match(skillMd, /after the Claude eye/i);
});

test("#ac-2.1 Explore-probe rule is resident in SKILL.md", () => {
  assert.ok(skillMd.includes("#ac-2.1"), 'expected SKILL.md to include "#ac-2.1"');
  assert.ok(skillMd.includes("Explore"), 'expected SKILL.md to include "Explore"');
  assert.match(skillMd, /probe/i);
});

test("#ac-2.2 minimal bookkeeping rule is resident in SKILL.md", () => {
  assert.ok(skillMd.includes("#ac-2.2"), 'expected SKILL.md to include "#ac-2.2"');
  assert.ok(skillMd.includes("TaskCreate"), 'expected SKILL.md to include "TaskCreate"');
  assert.ok(skillMd.includes("TaskUpdate"), 'expected SKILL.md to include "TaskUpdate"');
});

test("#ac-3.1 no mid-run ToolSearch rule is resident in SKILL.md", () => {
  assert.ok(skillMd.includes("#ac-3.1"), 'expected SKILL.md to include "#ac-3.1"');
  assert.ok(skillMd.includes("ToolSearch"), 'expected SKILL.md to include "ToolSearch"');
  assert.match(skillMd, /prefix[\s-]?cache|prompt-prefix cache/i);
});
