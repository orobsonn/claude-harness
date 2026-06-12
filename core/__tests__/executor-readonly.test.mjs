#!/usr/bin/env node
/**
 * @description Contract tests for executor agent read-only stance on frozen tests.
 * Verifies the executor no longer authors tests (TDD removed), receives frozen tests
 * READ-ONLY, and receives domain guidance via system-prompt injection under --bare mode.
 * Tests run under node:test.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const executorMdPath = resolve(__dirname, "../agents/executor.md");

/**
 * Parses YAML frontmatter from a markdown file.
 * Returns { frontmatter: object, body: string }.
 */
function parseFrontmatter(content) {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    throw new Error("File must start with --- delimiter");
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error("No closing --- delimiter found");
  }

  const frontmatterLines = lines.slice(1, endIdx);
  const fm = {};
  let tools = [];

  // Parse frontmatter line by line
  for (let i = 0; i < frontmatterLines.length; i++) {
    const line = frontmatterLines[i];
    if (!line.trim()) continue;

    // Check for tools: key (YAML list on following lines)
    if (line.trim().startsWith("tools:")) {
      // Extract tools from multi-line YAML list
      for (let j = i + 1; j < frontmatterLines.length; j++) {
        const toolLine = frontmatterLines[j];
        if (toolLine.match(/^\s+-\s+/)) {
          // Matches "  - Read" or similar
          const toolName = toolLine.replace(/^\s+-\s+/, "").trim();
          tools.push(toolName);
        } else if (toolLine.trim() && !toolLine.match(/^\s/)) {
          // End of tools section (non-indented line)
          break;
        } else if (toolLine.trim() && !toolLine.match(/^\s+-/)) {
          // Indented but not a list item; end of section
          break;
        }
      }
    } else {
      // Regular key: value
      const [key, ...valueParts] = line.split(":");
      const value = valueParts.join(":").trim();
      fm[key.trim()] = value;
    }
  }

  fm.tools = tools;
  const body = lines.slice(endIdx + 1).join("\n");
  return { frontmatter: fm, body };
}

/**
 * Test 1: Given core/agents/executor.md, when parsed, it states the executor
 * receives frozen locked_tests READ-ONLY and does NOT author/write test files.
 * The prior "Author the locked_tests first (TDD)" instruction MUST be removed.
 */
test("executor.md: removes TDD test-authoring step, states frozen-test read-only stance", () => {
  const content = readFileSync(executorMdPath, "utf8");
  const { body } = parseFrontmatter(content);

  // MUST NOT contain old TDD instruction
  const oldTddPhrase = "Author the locked_tests first (TDD)";
  assert(
    !body.includes(oldTddPhrase),
    `body must NOT contain "${oldTddPhrase}" — TDD test-authoring step must be removed`
  );

  // MUST contain language stating frozen-test read-only stance
  const statesFrozenReadOnly =
    body.includes("frozen locked_tests") ||
    body.includes("frozen locked_test") ||
    body.includes("frozen tests") ||
    body.includes("READ-ONLY") ||
    body.includes("read-only") ||
    (body.includes("receives") && body.includes("frozen")) ||
    body.includes("locked_tests are frozen");

  assert(
    statesFrozenReadOnly,
    "body must explicitly state executor receives frozen locked_tests READ-ONLY"
  );

  // MUST contain language forbidding test authoring/writing
  const forbidsTestAuthoring =
    body.includes("does NOT author") ||
    body.includes("does not author") ||
    body.includes("STOP authoring tests") ||
    body.includes("stops authoring tests") ||
    body.includes("must NOT write test") ||
    body.includes("must not write test") ||
    body.includes("no Write/Edit on the test_path") ||
    (body.includes("read-only") && body.includes("test"));

  assert(
    forbidsTestAuthoring,
    "body must explicitly forbid test authoring/writing; executor receives tests as read-only inputs"
  );
});

/**
 * Test 2: Given executor.md, when parsed, it states domain guidance is
 * delivered via system-prompt injection under --bare mode (skill-loss mitigation),
 * not via native skill auto-load.
 */
test("executor.md: states domain guidance via system-prompt injection under --bare", () => {
  const content = readFileSync(executorMdPath, "utf8");
  const { body } = parseFrontmatter(content);

  // MUST mention system-prompt injection
  const mentionsSystemPrompt =
    body.includes("system-prompt") ||
    body.includes("system prompt") ||
    body.includes("SYSTEM-PROMPT INJECTION") ||
    body.includes("system-prompt injection") ||
    (body.includes("injection") && body.includes("skill"));

  assert(
    mentionsSystemPrompt,
    "body must mention system-prompt injection for domain guidance delivery"
  );

  // MUST mention --bare mode or skill-loss mitigation
  const mentionsBareOrSkillLoss =
    body.includes("--bare") ||
    body.includes("bare") ||
    body.includes("skill") ||
    body.includes("skill-loss") ||
    body.includes("skills stripped");

  assert(
    mentionsBareOrSkillLoss,
    "body must reference --bare mode or skill-loss mitigation (skills stripped)"
  );

  // MUST state this is default under --bare
  const statesDefault =
    body.includes("by default") ||
    body.includes("default") ||
    (body.includes("system-prompt") && body.includes("default"));

  assert(
    statesDefault,
    "body must state system-prompt injection is the default domain-guidance mechanism under --bare"
  );
});
