#!/usr/bin/env node
/**
 * @description Locked tests for orchestrating-delivery SKILL.md hand-dispatch routing.
 * Verifies that HANDS (executor) resolve from hand_tiers via dispatch-hand.mjs (Ollama),
 * EYES (orchestrator + all reviewers) stay on Claude, the orchestrator writes a brief
 * that serializes budget-capped shared_context into the hand's system-prompt file, and
 * the sensitive-path section contains all required verbatim globs.
 *
 * SECTION-SCOPED: every assertion is made within its target section, not document-wide.
 * Tests run under node:test.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILL_MD_PATH = resolve(
  __dirname,
  "../skills/orchestrating-delivery/SKILL.md"
);

const skillMd = readFileSync(SKILL_MD_PATH, "utf8");

/**
 * Extract a markdown section by heading text (case-insensitive partial match).
 * Returns text from the matched heading until the next heading at the same or higher level.
 * @param {string} content - Full markdown content.
 * @param {string} headingText - Partial heading text to match (case-insensitive).
 * @returns {string} The extracted section, or empty string if not found.
 */
function extractSection(content, headingText) {
  const lines = content.split("\n");
  let capturing = false;
  let headingLevel = 0;
  const captured = [];

  for (const line of lines) {
    if (!capturing) {
      const match = line.match(/^(#{1,6})\s+(.*)/);
      if (match && match[2].toLowerCase().includes(headingText.toLowerCase())) {
        capturing = true;
        headingLevel = match[1].length;
        captured.push(line);
      }
    } else {
      const match = line.match(/^(#{1,6})\s/);
      if (match && match[1].length <= headingLevel) {
        break;
      }
      captured.push(line);
    }
  }

  return captured.join("\n");
}

/**
 * Extract non-separator markdown table rows from a section.
 * Includes the header row; excludes `|---|` separator rows.
 * @param {string} section - The section text to scan.
 * @returns {string[]} Array of row strings.
 */
function extractTableRows(section) {
  return section
    .split("\n")
    .filter(
      (line) =>
        line.trim().startsWith("|") &&
        !line.trim().match(/^\|[\s\-|:]+\|$/)
    );
}

// ─── Test 1 ───────────────────────────────────────────────────────────────────
/**
 * Given: SKILL.md with a "Model routing" section.
 * When: the routing table rows are extracted from that section.
 * Then: the executor row resolves from hand_tiers (Ollama via external dispatch-hand.mjs),
 *       while orchestrator and every reviewer row resolve to a Claude model (not Ollama).
 */
test("routing table: executor resolves from hand_tiers via dispatch-hand.mjs; orchestrator and reviewers resolve to Claude", () => {
  const section = extractSection(skillMd, "Model routing");
  assert(section.length > 0, "Model routing section not found in SKILL.md");

  const rows = extractTableRows(section);

  // Executor row must reference hand_tiers
  const executorRow = rows.find((r) =>
    r.toLowerCase().includes("| executor")
  );
  assert(executorRow, "executor row not found in routing table");
  assert(
    executorRow.includes("hand_tiers"),
    `executor row must reference hand_tiers, got:\n  ${executorRow}`
  );

  // Executor row must reference dispatch-hand.mjs (the external Ollama dispatcher)
  assert(
    executorRow.includes("dispatch-hand.mjs"),
    `executor row must reference dispatch-hand.mjs, got:\n  ${executorRow}`
  );

  // Orchestrator row must reference a Claude model — not Ollama
  const orchestratorRow = rows.find((r) =>
    r.toLowerCase().includes("orchestrator")
  );
  assert(orchestratorRow, "orchestrator row not found in routing table");
  assert(
    !orchestratorRow.toLowerCase().includes("ollama"),
    `orchestrator row must NOT reference Ollama, got:\n  ${orchestratorRow}`
  );
  assert(
    orchestratorRow.toLowerCase().includes("sonnet") ||
      orchestratorRow.toLowerCase().includes("claude"),
    `orchestrator row must reference a Claude model, got:\n  ${orchestratorRow}`
  );

  // Every reviewer/eye row must resolve to Claude (not Ollama)
  const REVIEWER_ROLES = [
    "planner",
    "plan-reviewer",
    "compliance",
    "adversary",
    "security",
    "harvester",
    "shipper",
  ];
  for (const role of REVIEWER_ROLES) {
    const reviewerRows = rows.filter((r) =>
      r.toLowerCase().includes(role.toLowerCase())
    );
    assert(reviewerRows.length > 0, `${role} row not found in routing table`);
    for (const reviewerRow of reviewerRows) {
      assert(
        !reviewerRow.toLowerCase().includes("ollama"),
        `reviewer/eye role '${role}' must NOT reference Ollama, got:\n  ${reviewerRow}`
      );
      assert(
        !reviewerRow.includes("hand_tiers"),
        `reviewer/eye role '${role}' must NOT route via hand_tiers, got:\n  ${reviewerRow}`
      );
      assert(
        !reviewerRow.includes("dispatch-hand.mjs"),
        `reviewer/eye role '${role}' must NOT route via dispatch-hand.mjs, got:\n  ${reviewerRow}`
      );
    }
  }
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: SKILL.md with a "Phase 2" section describing executor dispatch.
 * When: the Phase 2 section is extracted.
 * Then: it states the orchestrator writes a brief that serializes the budget-capped curated
 *       shared_context into the external hand's system-prompt/brief file.
 */
test("dispatch section (Phase 2): orchestrator writes brief serializing budget-capped shared_context into hand system-prompt/brief file", () => {
  const section = extractSection(skillMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found in SKILL.md");

  assert(
    section.includes("brief"),
    "Phase 2 section must mention 'brief' (the hand dispatch brief written by the orchestrator)"
  );

  assert(
    section.includes("budget-capped") || section.includes("budget capped"),
    "Phase 2 section must mention 'budget-capped' in the context of hand dispatch"
  );

  assert(
    section.includes("shared_context"),
    "Phase 2 section must mention 'shared_context' being serialized into the hand brief"
  );

  assert(
    section.includes("system-prompt") || section.includes("system prompt"),
    "Phase 2 section must mention 'system-prompt' as the delivery mechanism for context parity"
  );
});

// ─── Test 3 ───────────────────────────────────────────────────────────────────
/**
 * Given: SKILL.md with a "Model routing" section.
 * When: all eye/reviewer rows are extracted.
 * Then: NO eye/reviewer row maps to an Ollama model id — every eye stays on Claude.
 */
test("routing table: NO eye/reviewer row maps to an Ollama model id", () => {
  const section = extractSection(skillMd, "Model routing");
  assert(section.length > 0, "Model routing section not found in SKILL.md");

  const rows = extractTableRows(section);

  const EYE_ROLES = [
    "orchestrator",
    "planner",
    "plan-reviewer",
    "compliance",
    "adversary",
    "security",
    "harvester",
    "shipper",
  ];

  for (const role of EYE_ROLES) {
    const matchedRows = rows.filter((r) =>
      r.toLowerCase().includes(role.toLowerCase())
    );
    assert(matchedRows.length > 0, `${role} row not found in routing table`);
    for (const row of matchedRows) {
      assert(
        !row.toLowerCase().includes("ollama"),
        `eye/reviewer role '${role}' must NOT map to an Ollama model id, got:\n  ${row}`
      );
      assert(
        !row.includes("hand_tiers"),
        `eye/reviewer role '${role}' must NOT route via hand_tiers, got:\n  ${row}`
      );
      assert(
        !row.includes("dispatch-hand.mjs"),
        `eye/reviewer role '${role}' must NOT route via dispatch-hand.mjs, got:\n  ${row}`
      );
    }
  }
});

// ─── Test 4 ───────────────────────────────────────────────────────────────────
/**
 * Given: SKILL.md with a "Phase 1" section containing the sensitive-path override.
 * When: the Phase 1 section is extracted.
 * Then: it contains each verbatim allowlist glob and states that any match forces FULL.
 */
test("sensitive-path section (Phase 1): contains all verbatim globs and states forces FULL", () => {
  const section = extractSection(skillMd, "Phase 1");
  assert(section.length > 0, "Phase 1 section not found in SKILL.md");

  const REQUIRED_GLOBS = [
    "**/auth/**",
    "**/payment/**",
    "**/billing/**",
    "**/*.sql",
    "**/migrations/**",
    "**/.env*",
    "**/package.json",
  ];

  for (const glob of REQUIRED_GLOBS) {
    assert(
      section.includes(glob),
      `sensitive-path section must contain the verbatim glob '${glob}'`
    );
  }

  // Must state that a match forces FULL
  assert(
    section.toLowerCase().includes("forces full"),
    "sensitive-path section must state that any match forces FULL"
  );
});

// ─── Test 5 ───────────────────────────────────────────────────────────────────
/**
 * Given: SKILL.md with a "Context composition" section and a "Phase 2" section.
 * When: each section is extracted.
 * Then: BOTH sections contain the literal string ANTHROPIC_AUTH_TOKEN and the
 *       phrase "MUST NEVER contain", freezing the secret-hygiene guard in both
 *       channels (belt + suspenders). The actual leak is already closed by code
 *       + dispatch-hand.test.mjs; this pins the redundant prose guard.
 */
test("secret-hygiene guard: both Context composition and Phase 2 sections contain ANTHROPIC_AUTH_TOKEN and MUST NEVER contain", () => {
  const contextSection = extractSection(skillMd, "Context composition");
  assert(
    contextSection.length > 0,
    "Context composition section not found in SKILL.md"
  );

  const phase2Section = extractSection(skillMd, "Phase 2");
  assert(phase2Section.length > 0, "Phase 2 section not found in SKILL.md");

  for (const [name, section] of [
    ["Context composition", contextSection],
    ["Phase 2", phase2Section],
  ]) {
    assert(
      section.includes("ANTHROPIC_AUTH_TOKEN"),
      `${name} section must contain the literal 'ANTHROPIC_AUTH_TOKEN' (secret-hygiene guard)`
    );
    assert(
      section.includes("MUST NEVER contain"),
      `${name} section must contain the phrase 'MUST NEVER contain' (secret-hygiene guard)`
    );
  }
});

// ─── Test 6 ───────────────────────────────────────────────────────────────────
/**
 * Given: SKILL.md with a "Phase 2" section describing executor dispatch.
 * When: the Phase 2 section is extracted.
 * Then: the executor dispatch step states the hand runs in the working tree under the
 *       harness command-sandbox + a per-dispatch allowed-write set — NOT an isolated git worktree.
 */
test("dispatch section (Phase 2): executor runs in working tree under sandbox + per-dispatch allowed-write set (NOT isolated git worktree)", () => {
  const section = extractSection(skillMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found in SKILL.md");

  // Must state working tree (not isolated git worktree)
  assert(
    section.includes("working tree") || section.includes("working-tree"),
    "Phase 2 dispatch step must state the hand runs in the working tree"
  );

  // Must state per-dispatch allowed-write set
  assert(
    section.includes("per-dispatch allowed-write set") ||
      (section.includes("per-dispatch") && section.includes("allowed-write set")),
    "Phase 2 dispatch step must state the per-dispatch allowed-write set"
  );

  // Must NOT state isolated git worktree as the v1 mechanism
  assert(
    !section.includes("isolated git worktree"),
    "Phase 2 dispatch step must NOT state 'isolated git worktree' as the v1 mechanism"
  );
});
