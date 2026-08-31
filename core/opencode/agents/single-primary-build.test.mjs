/** @description The operator has one primary conversation: build owns delivery and lifecycle shortcuts. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentsDir = dirname(fileURLToPath(import.meta.url));
const ocRoot = join(agentsDir, "..");
const commandDir = join(ocRoot, "command");

function frontmatter(source) {
  return source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
}

test("only build is a primary agent and lifecycle commands stay in that conversation", () => {
  const primaryAgents = readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => /^mode: primary$/m.test(frontmatter(readFileSync(join(agentsDir, name), "utf8"))))
    .map((name) => name.replace(/\.md$/, ""));

  assert.deepEqual(primaryAgents, ["build"]);
  assert.equal(existsSync(join(agentsDir, "plan.md")), false);
  assert.equal(existsSync(join(agentsDir, "harness-config.md")), false);

  for (const command of ["updating-harness", "configuring-model-routing"]) {
    const source = readFileSync(join(commandDir, `${command}.md`), "utf8");
    assert.doesNotMatch(frontmatter(source), /^agent:/m);
    assert.match(source, new RegExp(`oc-${command}`));
  }
});

test("a direct lifecycle request bypasses triage before the first skill call", () => {
  const rootRules = readFileSync(join(ocRoot, "AGENTS.md"), "utf8");
  const build = readFileSync(join(agentsDir, "build.md"), "utf8");

  assert.match(rootRules, /direct lifecycle request[\s\S]*before `oc-triaging-requests`/i);
  assert.match(build, /direct lifecycle request[\s\S]*before `oc-triaging-requests`/i);
});
