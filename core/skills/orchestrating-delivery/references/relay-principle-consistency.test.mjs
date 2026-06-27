/**
 * @description Relay-principle consistency suite — asserts that
 * orchestrating-delivery/SKILL.md explicitly states the relay principle and wires the
 * three rails (brief-serializer, descriptor-emitter, test-author as hard precondition
 * of step 1d, fidelity-pass stamp positioned before step 1d, and frozen_paths field in
 * the step-1c manifest-write section). Reads the SKILL.md file ONCE via fs and asserts
 * structural/positional properties. All 6 cases are designed to fail RED against the
 * current (not-yet-rewritten) SKILL.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

test("relay-1 — SKILL.md states the relay principle: orchestrator authors no implementation code and no test code", () => {
  const content = readDoc(SKILL_ORCHESTRATING);
  assert.match(
    content,
    /authors? no implementation code and no test code/i,
    "SKILL.md must explicitly state the relay principle: the orchestrator authors no implementation code and no test code",
  );
});

test("relay-2 — SKILL.md contains the token 'brief-serializer' as the producer of the executor brief (step 1d)", () => {
  const content = readDoc(SKILL_ORCHESTRATING);
  assert.ok(
    content.includes("brief-serializer"),
    "SKILL.md must contain 'brief-serializer' — the component that produces the executor brief in step 1d",
  );
});

test("relay-3 — SKILL.md contains the token 'descriptor-emitter' tied to the freeze-commit/step 1d flow", () => {
  const content = readDoc(SKILL_ORCHESTRATING);
  assert.ok(
    content.includes("descriptor-emitter"),
    "SKILL.md must contain 'descriptor-emitter' tied to the step 1c-commit/1d flow",
  );
});

test("relay-4 — step 1a (test-author) stated as HARD PRECONDITION of step 1d within the executor wiring section", () => {
  const content = readDoc(SKILL_ORCHESTRATING);

  const step1dStart = content.indexOf("1d. executor");
  assert.notEqual(step1dStart, -1, "step 1d executor section must exist in SKILL.md");

  // Bound the window to the 1d section: from "1d. executor" to "**2. compliance**"
  const step2Start = content.indexOf("**2. compliance**", step1dStart);
  const sectionEnd =
    step2Start === -1
      ? Math.min(content.length, step1dStart + 3000)
      : step2Start;
  const executorSection = content.slice(step1dStart, sectionEnd);

  assert.match(
    executorSection,
    /test-author/,
    "step 1d executor wiring section must reference test-author",
  );
  assert.match(
    executorSection,
    /precondition/i,
    "step 1d executor wiring section must state test-author as a hard precondition of the executor dispatch",
  );
});

test("relay-5 — fidelity-rail: mark.mjs fidelity-pass --feature-id present and positioned before step 1d dispatch", () => {
  const content = readDoc(SKILL_ORCHESTRATING);

  // Assert the exact stamp command exists
  assert.match(
    content,
    /mark\.mjs fidelity-pass --feature-id/,
    "SKILL.md must contain the exact fidelity-rail stamp command: node .claude/hooks/mark.mjs fidelity-pass --feature-id",
  );

  const fidelityPassIdx = content.search(/mark\.mjs fidelity-pass --feature-id/);
  const step1dIdx = content.indexOf("1d. executor");
  assert.notEqual(step1dIdx, -1, "step 1d executor section must exist in SKILL.md");

  // Assert positional ordering: the fidelity-pass stamp must precede step 1d
  assert.ok(
    fidelityPassIdx < step1dIdx,
    `fidelity-pass stamp (at index ${fidelityPassIdx}) must appear BEFORE the step 1d anchor (at index ${step1dIdx}) — it belongs with the fidelity-gate (step 1b/1c) not the executor dispatch`,
  );

  // Assert co-occurrence: the fidelity-pass stamp must appear within a fidelity/freeze-commit context
  const windowStart = Math.max(0, fidelityPassIdx - 400);
  const windowEnd = Math.min(content.length, fidelityPassIdx + 400);
  const fidelityWindow = content.slice(windowStart, windowEnd);
  assert.match(
    fidelityWindow,
    /fidelity|freeze-commit/i,
    "fidelity-pass stamp must co-occur with a fidelity or freeze-commit context (step 1b/1c)",
  );
});

test("relay-6 — step 1c freeze-manifest section documents 'frozen_paths' as the field name for the frozen closure in test-manifest-<task_id>.json", () => {
  const content = readDoc(SKILL_ORCHESTRATING);

  const step1cStart = content.indexOf("1c. freeze");
  assert.notEqual(step1cStart, -1, "step 1c freeze section must exist in SKILL.md");

  // The manifest-write context is step 1c up to 1c-commit (before the commit step)
  const step1cCommitStart = content.indexOf("1c-commit", step1cStart);
  assert.notEqual(
    step1cCommitStart,
    -1,
    "step 1c-commit section must exist in SKILL.md after step 1c",
  );

  const manifestSection = content.slice(step1cStart, step1cCommitStart);
  assert.match(
    manifestSection,
    /frozen_paths/,
    "step 1c freeze-manifest section must document 'frozen_paths' as the field name written into test-manifest-<task_id>.json for the frozen closure",
  );
});
