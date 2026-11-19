/**
 * @description Locks the lean-CI rule (rules/ci.md): mirrored byte-identical in the
 * claude-code and opencode cores, scoped to workflow files, carrying every pillar of
 * the pattern, and referenced (never contradicted) by the rules, agents and skills
 * that author or review CI.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const CORES = ["claude-code", "opencode"];

test("ci.md exists in every rule-mirroring core and is byte-identical", () => {
  for (const core of CORES) {
    assert.ok(existsSync(new URL(`../${core}/rules/ci.md`, import.meta.url)), `${core}/rules/ci.md must exist`);
  }
  assert.equal(
    read("../opencode/rules/ci.md"),
    read("../claude-code/rules/ci.md"),
    "opencode/rules/ci.md must mirror claude-code/rules/ci.md",
  );
});

test("ci.md is path-scoped to workflow files and follows the rule format", () => {
  const rule = read("../claude-code/rules/ci.md");
  const frontmatter = rule.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, "ci.md must open with a YAML frontmatter block");
  assert.match(frontmatter[1], /^paths:\n(?:  - .+\n?)+/m, "frontmatter must declare paths:");
  assert.match(frontmatter[1], /- "\.github\/workflows\/\*\*"/, "paths must include .github/workflows/**");
  for (const section of ["## Conventions", "## Patterns", "## Gotchas"]) {
    assert.ok(rule.includes(`\n${section}\n`), `ci.md must have a ${section} section`);
  }
});

test("ci.md carries every pillar of the lean-CI pattern", () => {
  const rule = read("../claude-code/rules/ci.md");
  const pillars = {
    "PR is the gate (no suite re-run on push to main)": /O PR e a porta/,
    "affected tests only on the PR": /vitest run --changed origin\//,
    "full history for --changed": /fetch-depth: 0/,
    "non-import inputs force a full run": /forceRerunTriggers/,
    "nightly full suite guarded by 24h commit check": /git log -1 --since='24 hours ago'/,
    "full suite on manual dispatch": /workflow_dispatch/,
    "full suite on ci-completo label": /ci-completo/,
    "expensive job in its own workflow with paths": /Job caro em workflow proprio/,
    "runner cost multipliers": /windows-latest`? \*\*2x\*\*[\s\S]*macos-latest`? \*\*10x\*\*/,
    "concurrency keyed by workflow and ref": /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/,
    "cancel in progress on PR": /cancel-in-progress/,
    "timeout on every job": /timeout-minutes/,
    "dependency cache": /cache: npm/,
    "minimal permissions": /contents: read/,
    "third-party actions pinned by SHA": /SHA completo/,
    "secret scan as a step in an existing job": /gitleaks[\s\S]*job de governanca que ja existe/,
    "monthly minutes budget for Free org": /2\.000 min/,
  };
  for (const [pillar, re] of Object.entries(pillars)) {
    assert.match(rule, re, `ci.md must cover: ${pillar}`);
  }
});

test("testing-e2e.md no longer puts Playwright alongside unit on every PR and defers to ci.md", () => {
  for (const core of CORES) {
    const rule = read(`../${core}/rules/testing-e2e.md`);
    assert.ok(!rule.includes("paralelo ao unit"), `${core} testing-e2e.md must drop the "parallel to unit on every PR" guidance`);
    const ci = rule.slice(rule.indexOf("### CI"), rule.indexOf("## Patterns"));
    assert.match(ci, /workflow proprio/, `${core} testing-e2e.md CI section must put Playwright in its own workflow`);
    assert.match(ci, /`paths:`/, `${core} testing-e2e.md CI section must restrict the e2e workflow with paths:`);
    assert.match(ci, /`ci\.md`/, `${core} testing-e2e.md CI section must point to ci.md`);
  }
});

test("releases.md requires the last full suite green before release and points to ci.md", () => {
  for (const core of CORES) {
    const rule = read(`../${core}/rules/releases.md`);
    const section = rule.match(/### CI green[\s\S]*?(?=\n## |\n### )/);
    assert.ok(section, `${core} releases.md must keep the CI green section`);
    assert.match(section[0], /suite completa/, `${core} releases.md must require the last full suite green`);
    assert.match(section[0], /`ci\.md`/, `${core} releases.md must point to ci.md`);
  }
});

test("the CI review and generation points reference the rule instead of duplicating it", () => {
  const pointers = [
    ["../claude-code/agents/compliance.md", ".claude/rules/ci.md"],
    ["../opencode/agents/compliance.md", ".opencode/rules/ci.md"],
    ["../claude-code/skills/initializing-projects/SKILL.md", ".claude/rules/ci.md"],
    ["../claude-code/skills/updating-harness/SKILL.md", ".claude/rules/ci.md"],
  ];
  for (const [file, ref] of pointers) {
    assert.ok(read(file).includes(ref), `${file} must reference ${ref}`);
  }
  assert.match(read("../opencode/AGENTS.md"), /\.opencode\/rules\/` \([^)]*\bci\b[^)]*\)/, "opencode AGENTS.md must list ci among the rules");
});
