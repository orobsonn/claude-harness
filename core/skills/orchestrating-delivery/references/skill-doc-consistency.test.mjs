#!/usr/bin/env node
/**
 * @description Consistency tests for orchestrating-delivery SKILL.md v2 live-dispatch wiring.
 * Verifies that:
 *   1. No 'claude --bare' invocations remain in the document.
 *   2. Executor routing references 'spawn-hand' for ALL tiers and contains no
 *      'HIGH executor stays on Claude' / 'HIGH → Claude' / 'HIGH stays on Claude' /
 *      'deferred to v2' wording for the executor.
 *   3. Sniper routing references 'spawn-hand' AND resolves 'hand_tiers[issue.severity]'
 *      AND both rail tokens 'regate-pending' and 'regate-passed' are present.
 *   4. Eye roles (compliance, adversary, security) are still documented as Claude eye
 *      roles staying on Claude (eyes never resolve to Ollama).
 *
 * Tests run under node:test.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILL_MD_PATH = resolve(__dirname, "../SKILL.md");

const skillMd = readFileSync(SKILL_MD_PATH, "utf8");

// ─── Test 1 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md.
 * When: the entire document is scanned for 'claude --bare'.
 * Then: occurrences === 0 (every invocation must use 'claude -p' + isolated config dir).
 */
test("SKILL.md: no 'claude --bare' occurrences anywhere in the document", () => {
  const bareOccurrences = (skillMd.match(/claude\s+--bare/g) ?? []).length;
  assert.equal(
    bareOccurrences,
    0,
    `Expected 0 occurrences of 'claude --bare' but found ${bareOccurrences}. ` +
      "All invocations must use 'claude -p' + isolated ephemeral CLAUDE_CONFIG_DIR."
  );
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md.
 * When: the executor routing section is scanned.
 * Then:
 *   (a) it references 'spawn-hand' for the executor route, AND
 *   (b) contains NO remaining 'HIGH executor stays on Claude' / 'HIGH → Claude' /
 *       'HIGH stays on Claude' / 'deferred to v2' wording for the executor.
 * (executor-high → hand_tiers.high; all tiers route to the live spawn path).
 */
test("SKILL.md: executor routes ALL tiers to spawn-hand; no 'HIGH executor stays on Claude' / 'deferred to v2' wording", () => {
  // (a) executor routing references 'spawn-hand'
  // Check that the executor row/section mentions spawn-hand
  const mentionsSpawnHandForExecutor =
    skillMd.includes("spawn-hand") &&
    (() => {
      // Confirm spawn-hand appears in executor context (not only in sniper context).
      // Look for spawn-hand within the executor row of the routing table or phase 2 step 1d.
      const executorTableRowMatch = skillMd.match(
        /\|\s*executor\s*\|[^|]*spawn-hand[^|]*\|/i
      );
      const phase2Step1d = skillMd.match(
        /1d\.\s+executor[\s\S]{0,1000}spawn-hand/i
      );
      const escalationSection = skillMd.match(
        /v2 tier mapping[\s\S]{0,500}spawn-hand/i
      );
      return (
        executorTableRowMatch !== null ||
        phase2Step1d !== null ||
        escalationSection !== null
      );
    })();

  assert(
    mentionsSpawnHandForExecutor,
    "SKILL.md executor routing must reference 'spawn-hand' (all tiers dispatch the live spawn path)."
  );

  // (b) no forbidden 'HIGH stays on Claude' / 'HIGH → Claude' / 'deferred to v2' wording
  // for the executor specifically. These regexes target executor-high-on-Claude phrasings.
  const forbiddenPatterns = [
    /HIGH\s+executor\s+stays\s+on\s+Claude/i,
    /HIGH\s+executor.*stays\s+on\s+Claude/i,
    /HIGH\s+stays\s+on\s+Claude/i,
    /HIGH\s*→\s*Claude/,
    /deferred\s+to\s+v[23]/i,
    /HIGH\s+executor.*deferred/i,
    /executor.*HIGH.*deferred/i,
    /HIGH executor stays on/i,
  ];

  for (const pattern of forbiddenPatterns) {
    // To avoid false positives on eye-role sentences (e.g. "adversary stays on Claude"),
    // only flag if the pattern also co-occurs with an executor-high context.
    // We test the pattern against the full doc; the patterns are specific enough.
    const match = skillMd.match(pattern);
    assert(
      match === null,
      `SKILL.md must NOT contain executor-high-on-Claude wording. Found: "${match?.[0]}"`
    );
  }
});

// ─── Test 3 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md.
 * When: the sniper routing section is scanned.
 * Then:
 *   (a) it references 'spawn-hand' in the sniper context, AND
 *   (b) it resolves 'hand_tiers[issue.severity]' for the sniper, AND
 *   (c) both rail tokens 'regate-pending' and 'regate-passed' are present.
 */
test("SKILL.md: sniper references 'spawn-hand'; resolves hand_tiers[issue.severity]; rail tokens regate-pending + regate-passed present", () => {
  // (a) sniper context references spawn-hand
  // The sniper row in the routing table or phase 2 step 5 must mention spawn-hand.
  const sniperSpawnHand =
    skillMd.match(/\|\s*sniper\s*\|[^|]*spawn-hand[^|]*\|/i) !== null ||
    skillMd.match(/5\.\s+sniper[\s\S]{0,1000}spawn-hand/i) !== null ||
    skillMd.match(/sniper[\s\S]{0,300}spawn-hand/i) !== null;

  assert(
    sniperSpawnHand,
    "SKILL.md sniper routing must reference 'spawn-hand' (sniper live-wired to the spawn path)."
  );

  // (b) sniper resolves hand_tiers[issue.severity]
  const sniperHandTiers =
    skillMd.includes("hand_tiers[issue.severity]") ||
    skillMd.match(/sniper[\s\S]{0,500}hand_tiers\[issue\.severity\]/i) !== null;

  assert(
    sniperHandTiers,
    "SKILL.md sniper routing must resolve 'hand_tiers[issue.severity]'."
  );

  // (c) both rail tokens present
  assert(
    skillMd.includes("regate-pending"),
    "SKILL.md must contain the rail token 'regate-pending' (sniper HIGH re-gate deterministic rail)."
  );
  assert(
    skillMd.includes("regate-passed"),
    "SKILL.md must contain the rail token 'regate-passed' (sniper HIGH re-gate deterministic rail)."
  );
});

// ─── Test 4 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md.
 * When: the document is scanned for eye-role routing.
 * Then: compliance, adversary, and security are each documented as Claude eye roles
 *       that stay on Claude (never resolve to Ollama).
 */
test("SKILL.md: eye roles (compliance, adversary, security) stay on Claude; never resolve to Ollama", () => {
  // The routing table has rows for compliance, adversary, security — each must be a Claude tier.
  // We check that the routing table rows use "sonnet" or "opus" (Claude aliases) for these roles,
  // and that the doc explicitly states eyes never resolve to Ollama.

  // (a) compliance row in the routing table uses a Claude alias (sonnet/opus/haiku)
  const complianceRow = skillMd.match(
    /\|\s*compliance\s*(?:\(.*?\))?\s*\|([^|]+)\|/i
  );
  if (complianceRow) {
    const complianceModel = complianceRow[1];
    const isClaudeAlias =
      /sonnet|opus|haiku/i.test(complianceModel);
    assert(
      isClaudeAlias,
      `compliance row in routing table must use a Claude alias (sonnet/opus/haiku), got: "${complianceModel.trim()}"`
    );
  }

  // (b) adversary row in the routing table uses opus
  const adversaryRows = [...skillMd.matchAll(/\|\s*adversary[^|]*\|([^|]+)\|/gi)];
  for (const row of adversaryRows) {
    const model = row[1];
    const isClaudeAlias = /sonnet|opus|haiku/i.test(model);
    assert(
      isClaudeAlias,
      `adversary row in routing table must use a Claude alias (sonnet/opus/haiku), got: "${model.trim()}"`
    );
  }

  // (c) security row in the routing table uses a Claude alias
  const securityRow = skillMd.match(/\|\s*security[^|]*\|([^|]+)\|/i);
  if (securityRow) {
    const securityModel = securityRow[1];
    const isClaudeAlias = /sonnet|opus|haiku/i.test(securityModel);
    assert(
      isClaudeAlias,
      `security row in routing table must use a Claude alias (sonnet/opus/haiku), got: "${securityModel.trim()}"`
    );
  }

  // (d) the doc explicitly states no eye role ever resolves to Ollama (the hard constraint)
  const eyesNeverOllama =
    skillMd.includes("No eye role ever resolves to an Ollama model") ||
    skillMd.includes("no eye role ever resolves to an Ollama model") ||
    (skillMd.match(/eye\s+role.*never.*Ollama/i) !== null) ||
    (skillMd.match(/No eye role.*non-Claude/i) !== null);

  assert(
    eyesNeverOllama,
    "SKILL.md must explicitly state that no eye role ever resolves to an Ollama model (hard constraint)."
  );
});
