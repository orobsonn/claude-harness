/** @description Published npm artifact must carry every native runtime source required by vendor. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("npm pack dry-run includes native issue skill, rule, template, VPS setup entry, and Codex runtime", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const files = new Set(JSON.parse(output)[0].files.map((entry) => entry.path));
  for (const path of [
    "core/opencode/skills/creating-issues/SKILL.md",
    "core/opencode/skills/creating-issues/references/submit-issue.mjs",
    "core/opencode/rules/creating-issues.md",
    "core/github/ISSUE_TEMPLATE/harness-task.yml",
    "core/claude-code/skills/initializing-projects/references/setup-vps.mjs",
    "core/codex/config.toml",
    "core/codex/hooks.json",
    "core/codex/agents/planner.toml",
    "core/codex/skills/harness-triage/SKILL.md",
  ]) {
    assert.ok(files.has(path), `published artifact missing ${path}`);
  }
});
