/**
 * @description Doc-consistency suite — asserts that harness skill/agent docs pin
 * the deterministic-rails contract (model_strategy shape, default hand_tiers ladder,
 * legacy back-compat notes). Reads doc files via fs and asserts on their content.
 * Cases are appended per task; never overwrite the whole file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SKILL_CREATING_PLANS = fileURLToPath(
  new URL("../skills/creating-plans/SKILL.md", import.meta.url),
);
const AGENT_PLANNER = fileURLToPath(
  new URL("../agents/planner.md", import.meta.url),
);
const SKILL_ORCHESTRATING = fileURLToPath(
  new URL("../skills/orchestrating-delivery/SKILL.md", import.meta.url),
);
const AGENT_TEST_AUTHOR = fileURLToPath(
  new URL("../agents/test-author.md", import.meta.url),
);

/**
 * Reads a doc file as UTF-8 text.
 * @param {string} filePath - Absolute path to the doc file.
 * @returns {string} File content.
 */
function readDoc(filePath) {
  return readFileSync(filePath, "utf8");
}

test("AC1 — creating-plans Step 7 presents hand_tiers as default and pins the ladder", () => {
  const content = readDoc(SKILL_CREATING_PLANS);

  const step7Start = content.indexOf("## Step 7");
  assert.notEqual(step7Start, -1, "Step 7 section must exist");
  const step7End = content.indexOf("## Step 8", step7Start);
  const step7 = step7End === -1 ? content.slice(step7Start) : content.slice(step7Start, step7End);

  assert.match(
    step7,
    /hand_tiers/,
    "Step 7 must reference hand_tiers",
  );
  assert.match(
    step7,
    /\bdefault\b/i,
    "Step 7 must present hand_tiers as the default shape",
  );
  assert.ok(
    step7.includes("glm-5.1"),
    "Step 7 must pin the cravado ladder value glm-5.1",
  );
  assert.ok(
    step7.includes("deepseek-v4-pro"),
    "Step 7 must pin the cravado ladder value deepseek-v4-pro",
  );
  assert.ok(
    step7.includes("kimi-2.7"),
    "Step 7 must pin the cravado ladder value kimi-2.7",
  );
  assert.match(
    step7,
    /back-compat|back compat|read-back-compat/i,
    "Step 7 must demote legacy tiers to a back-compat note",
  );
});

test("AC2 — planner agent emits hand_tiers by default, legacy tiers only as back-compat", () => {
  const content = readDoc(AGENT_PLANNER);

  assert.match(
    content,
    /hand_tiers/,
    "planner.md must reference hand_tiers",
  );
  assert.match(
    content,
    /hand_tiers[^.]*\bdefault\b|\bdefault\b[^.]*hand_tiers/i,
    "planner.md must present hand_tiers as the default emitted shape",
  );
  assert.match(
    content,
    /back-compat|back compat/i,
    "planner.md must refer to legacy tiers as a back-compat note",
  );
});

test("trilho-3-4 AC1 — escalation section stamps mark.mjs escalation-fallback before the K=1 Claude fallback", () => {
  const content = readDoc(SKILL_ORCHESTRATING);

  assert.match(
    content,
    /mark\.mjs\s+escalation-fallback\s+--feature-id/,
    "escalation section must instruct running mark.mjs escalation-fallback --feature-id",
  );
  assert.match(
    content,
    /escalation-fallback[\s\S]*--task-id/,
    "the escalation-fallback marker must carry --task-id",
  );
  assert.match(
    content,
    /entry-gate[\s\S]*DENIES the fallback|DENIES the fallback[\s\S]*entry-gate/,
    "must state the entry-gate hand-routing branch DENIES the fallback without the ticket",
  );
});

test("trilho-3-4 AC2 — hand-dispatch/capture steps carry feature_id/task_id and the hand-finished + capture-verified markers", () => {
  const content = readDoc(SKILL_ORCHESTRATING);

  assert.ok(
    content.includes("feature_id") && content.includes("task_id"),
    "hand dispatch descriptor must carry feature_id and task_id",
  );
  assert.match(
    content,
    /session_id[\s\S]*PostToolUse[\s\S]*NOT the descriptor|NOT the descriptor[\s\S]*PostToolUse/,
    "must note session_id comes from the PostToolUse payload, NOT the descriptor",
  );
  assert.match(
    content,
    /mark\.mjs\s+hand-finished\s+--feature-id/,
    "must run mark.mjs hand-finished --feature-id right after the cheap hand returns",
  );
  assert.match(
    content,
    /mark\.mjs\s+capture-verified\s+--feature-id/,
    "must run mark.mjs capture-verified --feature-id after capture reports captured:true",
  );
  assert.match(
    content,
    /capture-verified[\s\S]*captured\s*:?\s*true|captured\s*:?\s*true[\s\S]*capture-verified/,
    "capture-verified must be gated on captured:true",
  );
});

test("trilho-3-4 AC3 — Hands vs Eyes taxonomy names test-author as a HAND alongside executor and sniper", () => {
  const content = readDoc(SKILL_ORCHESTRATING);

  const anchor = content.indexOf("Hands vs Eyes (v2 wiring)");
  assert.notEqual(anchor, -1, "Hands vs Eyes (v2 wiring) sentence must exist");
  const section = content.slice(anchor, anchor + 1200);

  assert.match(
    section,
    /executor[\s\S]*sniper[\s\S]*test-author|test-author[\s\S]*executor[\s\S]*sniper|executor[\s\S]*test-author[\s\S]*sniper/,
    "the taxonomy sentence must name executor, sniper AND test-author as HAND roles",
  );
  assert.match(
    section,
    /\bHAND\b/,
    "the taxonomy sentence must label them HAND roles",
  );
});

test("trilho-3-test-author AC1 — test-author doc describes an Ollama/spawn-hand HAND resolving from hand_tiers, not a standalone Claude-haiku hand", () => {
  const content = readDoc(AGENT_TEST_AUTHOR);

  assert.match(
    content,
    /spawn-hand/i,
    "test-author.md must describe dispatch via the spawn-hand (Ollama) path",
  );
  assert.match(
    content,
    /hand_tiers/,
    "test-author.md must resolve its model from hand_tiers",
  );
  assert.match(
    content,
    /ollama/i,
    "test-author.md must frame the role as an Ollama hand",
  );
  assert.doesNotMatch(
    content,
    /Claude(?:\s+\w+)?\s+haiku\s+(?:hand|Agent)/i,
    "test-author.md must NOT claim it IS a standalone Claude haiku hand/Agent",
  );
});
