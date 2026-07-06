/**
 * @description Test-author mandate consistency suite — asserts that the widened
 * test-author contract (kaizen 2026-07-01, m2 task-5) is documented in both the agent
 * mandate (core/agents/test-author.md) and the orchestrating-delivery dispatch guidance
 * (SKILL.md step 1a):
 *   - AC-1.1: the mandate covers narrow maintenance edits on already-authored/frozen
 *     tests, not only the initial transcription, and states such edits must not be
 *     refused as outside the transcription contract.
 *   - AC-1.2: the dispatch brief must never ask the test-author to run Bash / verify —
 *     verification is the orchestrator's separate responsibility.
 * Reads each doc ONCE via fs and asserts textual invariants.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEST_AUTHOR_AGENT = fileURLToPath(
  new URL("../../../agents/test-author.md", import.meta.url),
);
const SKILL_ORCHESTRATING = fileURLToPath(
  new URL("../SKILL.md", import.meta.url),
);

/**
 * Reads a doc file as UTF-8 text.
 * @param {string} filePath - Absolute path to the doc file.
 * @returns {string} File content.
 */
function readDoc(filePath) {
  return readFileSync(filePath, "utf8");
}

test("mandate-1 — test-author.md widens the contract to narrow maintenance edits on already-frozen tests", () => {
  const content = readDoc(TEST_AUTHOR_AGENT);
  assert.match(
    content,
    /manuten[çc][ãa]o pontual/i,
    "test-author.md must document the narrow maintenance-edit dispatch shape",
  );
  assert.match(
    content,
    /j[áa] (autorad[oa]\/)?congelad[oa]/i,
    "test-author.md must state the maintenance edit applies to an already-authored/frozen test",
  );
});

test("mandate-2 — test-author.md states a legitimate maintenance edit must NOT be refused as outside the transcription contract", () => {
  const content = readDoc(TEST_AUTHOR_AGENT);
  assert.match(
    content,
    /n[ãa]o recus/i,
    "test-author.md must explicitly say a legitimate maintenance edit is not to be refused as outside the transcription contract",
  );
});

test("mandate-3 — test-author.md states verification/Bash is not its job", () => {
  const content = readDoc(TEST_AUTHOR_AGENT);
  assert.match(
    content,
    /verifica[çc][ãa]o n[ãa]o [ée] sua/i,
    "test-author.md must state that verification is not the test-author's responsibility",
  );
  assert.match(
    content,
    /n[ãa]o tem Bash|rode Bash/i,
    "test-author.md must note the test-author has no Bash / must never be asked to run Bash",
  );
});

test("mandate-4 — SKILL.md step 1a dispatch guidance documents both dispatch shapes", () => {
  const content = readDoc(SKILL_ORCHESTRATING);

  const step1aStart = content.indexOf("**1a. test-author**");
  assert.notEqual(step1aStart, -1, "step 1a test-author section must exist in SKILL.md");
  const step1bStart = content.indexOf("**1b. compliance**", step1aStart);
  assert.notEqual(step1bStart, -1, "step 1b compliance section must follow step 1a in SKILL.md");
  const step1aSection = content.slice(step1aStart, step1bStart);

  assert.match(
    step1aSection,
    /narrow maintenance edit/i,
    "step 1a dispatch guidance must document the narrow maintenance-edit dispatch shape",
  );
});

test("mandate-5 — SKILL.md step 1a forbids asking the test-author to run Bash / verify", () => {
  const content = readDoc(SKILL_ORCHESTRATING);

  const step1aStart = content.indexOf("**1a. test-author**");
  assert.notEqual(step1aStart, -1, "step 1a test-author section must exist in SKILL.md");
  const step1bStart = content.indexOf("**1b. compliance**", step1aStart);
  const step1aSection = content.slice(step1aStart, step1bStart);

  assert.match(
    step1aSection,
    /MUST NEVER ask the test-author to run Bash/i,
    "step 1a dispatch guidance must state the brief must never ask the test-author to run Bash or verify",
  );
});
