#!/usr/bin/env node
/**
 * @description Contract tests for test-author agent definition.
 * Verifies frontmatter tools are EXACTLY [Read, Write] and body
 * restricts scope to transcribing ONE assertion into ONE test file.
 * Tests run under node:test.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const agentMdPath = resolve(__dirname, "../agents/test-author.md");

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
 * Test 1: Given core/agents/test-author.md, when its frontmatter is parsed,
 * the tools list is EXACTLY [Read, Write] (no Edit, Bash, Skill, or Glob).
 */
test("test-author.md: frontmatter tools are EXACTLY [Read, Write]", () => {
  const content = readFileSync(agentMdPath, "utf8");
  const { frontmatter } = parseFrontmatter(content);

  assert(frontmatter.tools, "frontmatter must have tools field");
  assert(
    Array.isArray(frontmatter.tools),
    "tools must be an array or list"
  );

  // Must be exactly 2 tools
  assert.equal(
    frontmatter.tools.length,
    2,
    `Expected exactly 2 tools, got ${frontmatter.tools.length}`
  );

  // Must be Read and Write in that order
  assert.equal(
    frontmatter.tools[0],
    "Read",
    `Expected first tool to be Read, got ${frontmatter.tools[0]}`
  );
  assert.equal(
    frontmatter.tools[1],
    "Write",
    `Expected second tool to be Write, got ${frontmatter.tools[1]}`
  );

  // Must NOT include Edit, Bash, Skill, Glob, Grep
  const forbidden = ["Edit", "Bash", "Skill", "Glob", "Grep"];
  for (const tool of forbidden) {
    assert(
      !frontmatter.tools.includes(tool),
      `tools must not include ${tool}`
    );
  }
});

/**
 * Test 2: Given test-author.md body, when parsed, it forbids writing
 * production code and forbids editing files other than the single target
 * test_path. Must contain explicit scope-restriction language.
 */
test("test-author.md: body forbids production code and off-path edits", () => {
  const content = readFileSync(agentMdPath, "utf8");
  const { body } = parseFrontmatter(content);

  // Must contain language forbidding production code
  const bodyLower = body.toLowerCase();
  const forbidsProduction =
    body.includes("must NOT write production") ||
    body.includes("must not write production") ||
    body.includes("forbidden") ||
    body.includes("do not write") ||
    body.includes("must not write") ||
    bodyLower.includes("proibido") ||
    bodyLower.includes("escrever código de produção");

  assert(
    forbidsProduction,
    "body must explicitly forbid writing production code"
  );

  // Must contain language forbidding edits outside target test_path
  const forbidsOffPath =
    body.includes("must NOT edit") ||
    body.includes("must not edit") ||
    body.includes("only the") ||
    body.includes("target test_path") ||
    bodyLower.includes("não editar") ||
    bodyLower.includes("edição") ||
    bodyLower.includes("editar") ||
    bodyLower.includes("fora");

  assert(
    forbidsOffPath,
    "body must explicitly forbid editing files outside target test_path"
  );

  // Must mention scope restriction (one assertion, one test file)
  const mentionsScope =
    body.includes("ONE assertion") ||
    body.includes("one assertion") ||
    body.includes("single assertion") ||
    bodyLower.includes("única asserção") ||
    bodyLower.includes("uma asserção") ||
    body.includes("one test file") ||
    bodyLower.includes("um arquivo");

  assert(
    mentionsScope,
    "body must describe scope restriction (one assertion → one test file)"
  );
});
