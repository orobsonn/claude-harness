#!/usr/bin/env node
/**
 * @description Pins that executor.md, test-author.md, and the creating-plans
 * SKILL.md all instruct module-relative .md path resolution (fileURLToPath
 * pattern) instead of a hardcoded absolute path, and that test-author.md
 * carves out fixtures, comments, and string-literal needles from that rule.
 * Tests run under node:test.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const executorMdPath = resolve(__dirname, "../agents/executor.md");
const testAuthorMdPath = resolve(__dirname, "../agents/test-author.md");
const creatingPlansSkillPath = resolve(
  __dirname,
  "../skills/creating-plans/SKILL.md"
);

/**
 * Slices content from the line containing headerLine up to (but excluding)
 * the next line matching nextHeaderRegex. Returns the whole remainder if no
 * terminating line is found.
 */
function sectionWindow(content, headerLine, nextHeaderRegex = /^## /m) {
  const lines = content.split("\n");

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(headerLine)) {
      startIdx = i;
      break;
    }
  }
  assert(startIdx !== -1, `header line not found: ${headerLine}`);

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (nextHeaderRegex.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * Test 1: Given core/agents/executor.md, when sliced to the
 * "## Implementation rules" section window, the window names the
 * module-relative fileURLToPath idiom and both forbidden hardcoded-path
 * roots (/Users/ and /home/).
 */
test("executor.md: Implementation rules window pins module-relative .md path resolution", () => {
  const content = readFileSync(executorMdPath, "utf8");
  const window = sectionWindow(content, "## Implementation rules");

  assert(
    window.includes("fileURLToPath(import.meta.url)"),
    "Implementation rules window must reference fileURLToPath(import.meta.url)"
  );
  assert(
    window.includes("/Users/"),
    "Implementation rules window must name /Users/ as a hardcoded-path hazard"
  );
  assert(
    window.includes("/home/"),
    "Implementation rules window must name /home/ as a hardcoded-path hazard"
  );
});

/**
 * Test 2: Given core/agents/test-author.md, when sliced to the
 * "## Como transcrever" section window, the window names the
 * module-relative fileURLToPath idiom and both forbidden hardcoded-path
 * roots (/Users/ and /home/).
 */
test("test-author.md: Como transcrever window pins module-relative .md path resolution", () => {
  const content = readFileSync(testAuthorMdPath, "utf8");
  const window = sectionWindow(content, "## Como transcrever");

  assert(
    window.includes("fileURLToPath(import.meta.url)"),
    "Como transcrever window must reference fileURLToPath(import.meta.url)"
  );
  assert(
    window.includes("/Users/"),
    "Como transcrever window must name /Users/ as a hardcoded-path hazard"
  );
  assert(
    window.includes("/home/"),
    "Como transcrever window must name /home/ as a hardcoded-path hazard"
  );
});

/**
 * Test 3: Given the same "## Como transcrever" window of
 * core/agents/test-author.md, the window states all THREE carve-outs
 * (fixture, comment, string-literal needle) are NOT the hazard, each tied
 * to a specific phrase that only appears once the real carve-out guidance
 * is written (not a generic word that already occurs there for unrelated
 * reasons).
 */
test("test-author.md: Como transcrever window states fixture/comment/needle carve-outs", () => {
  const content = readFileSync(testAuthorMdPath, "utf8");
  const window = sectionWindow(content, "## Como transcrever");
  const windowLower = window.toLowerCase();

  assert.ok(
    windowLower.includes("synthetic fixture"),
    "window must carve out fixtures with the phrase 'synthetic fixture'"
  );

  assert.ok(
    windowLower.includes("comment") && windowLower.includes("not the hazard"),
    "window must carve out comments with the word 'comment' and the phrase 'not the hazard'"
  );

  assert.ok(
    window.includes("content.includes"),
    "window must carve out string-literal needles with the exact token 'content.includes'"
  );
});

/**
 * Test 4: Given core/skills/creating-plans/SKILL.md, when sliced to the
 * "Step 3 — Derive locked_tests from ACs" section window (up to the next
 * Step heading at any of #/##/### depth), the window pins the
 * fileURLToPath idiom and states repo paths must be resolved
 * module-relative rather than hardcoded absolute.
 */
test("creating-plans SKILL.md: Step 3 window pins module-relative repo path resolution", () => {
  const content = readFileSync(creatingPlansSkillPath, "utf8");
  const window = sectionWindow(
    content,
    "Step 3 — Derive locked_tests from ACs",
    /^#{1,3} Step /m
  );
  const windowLower = window.toLowerCase();

  assert(
    window.includes("fileURLToPath"),
    "Step 3 window must reference fileURLToPath"
  );
  assert(
    windowLower.includes("module-relative") ||
      (windowLower.includes("hardcoded") && windowLower.includes("absolute")),
    "Step 3 window must state paths are resolved module-relative, not hardcoded absolute"
  );
});
