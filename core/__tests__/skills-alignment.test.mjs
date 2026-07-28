/**
 * @description Test suite for skills alignment: validates that triaging-requests and orchestrating-delivery
 * prose align with the deterministic entry gate (classify.mjs marker, brainstorm-done marker, upfront spec-adversary),
 * and that every numbered cap in orchestrating-delivery declares which loop it governs (#529).
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOP_THRESHOLDS } from '../opencode/plugin/lib/loop-decide.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');

/**
 * Read a skill file and return its content.
 */
function readSkill(skillName) {
  const skillPath = join(projectRoot, 'skills', skillName, 'SKILL.md');
  return readFileSync(skillPath, 'utf-8');
}

/**
 * @description Read an OpenCode-flavoured skill file (core/opencode/skills/<name>/SKILL.md).
 * @param {string} skillName kebab-case skill directory name
 * @returns {string} raw markdown
 */
function readOcSkill(skillName) {
  return readFileSync(join(projectRoot, 'opencode', 'skills', skillName, 'SKILL.md'), 'utf-8');
}

/**
 * Test 1: Verify triaging-requests instructs running classify.mjs with the chosen mode and feature_id.
 */
test('triaging-requests Step 6 instructs running classify.mjs with chosen mode and feature_id', () => {
  const triagingSkill = readSkill('triaging-requests');

  // The skill must contain a step that mentions classify.mjs and both mode and feature_id
  assert(
    triagingSkill.includes('classify.mjs'),
    'triaging-requests must mention classify.mjs'
  );
  assert(
    triagingSkill.includes('--mode'),
    'triaging-requests must instruct --mode flag for classify.mjs'
  );
  assert(
    triagingSkill.includes('--feature-id'),
    'triaging-requests must instruct --feature-id flag for classify.mjs'
  );
  assert(
    triagingSkill.includes('Step 6') || triagingSkill.includes('final'),
    'triaging-requests must have a final step (Step 6 or "final")'
  );

  // Verify it comes after Step 5 (Dispatch)
  const step5Index = triagingSkill.indexOf('### Step 5');
  const classifyIndex = triagingSkill.indexOf('classify.mjs');
  assert(
    step5Index < classifyIndex,
    'classify.mjs instruction must come after Step 5 (Dispatch)'
  );
});

/**
 * Test 2: Verify orchestrating-delivery states the upfront spec-adversary is mandatory in both LIGHT and FULL.
 */
test('orchestrating-delivery mandates upfront spec-adversary in both LIGHT and FULL', () => {
  const orchestratingSkill = readSkill('orchestrating-delivery');

  // The LIGHT vs FULL table must explicitly state that spec-adversary is mandatory in both
  assert(
    orchestratingSkill.includes('MANDATORY'),
    'orchestrating-delivery must state spec-adversary is MANDATORY'
  );
  assert(
    orchestratingSkill.includes('Spec-adversary'),
    'orchestrating-delivery must name "Spec-adversary" in the LIGHT vs FULL table'
  );

  // Find the Spec-adversary row and verify it mentions MANDATORY for both columns
  const specAdvRow = orchestratingSkill.match(/\| Spec-adversary[^\n]*\n/);
  assert(
    specAdvRow !== null,
    'orchestrating-delivery must have a Spec-adversary row in the LIGHT vs FULL table'
  );

  const rowContent = specAdvRow[0];
  const mandatoryCount = (rowContent.match(/MANDATORY/g) || []).length;
  assert(
    mandatoryCount >= 2,
    'The Spec-adversary row must state MANDATORY for both LIGHT and FULL columns'
  );

  // Verify the text mentions both modes are covered (upfront/before plan dispatch)
  assert(
    rowContent.includes('upfront') || rowContent.includes('before plan'),
    'Spec-adversary row must clarify that it happens upfront before plan dispatch'
  );
});

/**
 * Test 3: Verify Phase 0 ends with the brainstorm-done marker step in both interactive and headless branches.
 */
test('orchestrating-delivery Phase 0 ends with brainstorm-done marker in both interactive and headless', () => {
  const orchestratingSkill = readSkill('orchestrating-delivery');

  // The skill must contain mark.mjs brainstorm-done command
  assert(
    orchestratingSkill.includes('mark.mjs brainstorm-done'),
    'orchestrating-delivery must mention mark.mjs brainstorm-done command'
  );

  // Verify it is in Phase 0
  const phase0Start = orchestratingSkill.indexOf('## Phase 0');
  const phase1Start = orchestratingSkill.indexOf('## Phase 1');
  const markerIndex = orchestratingSkill.indexOf('mark.mjs brainstorm-done');

  assert(
    phase0Start !== -1 && phase1Start !== -1,
    'orchestrating-delivery must have both Phase 0 and Phase 1 sections'
  );
  assert(
    markerIndex > phase0Start && markerIndex < phase1Start,
    'brainstorm-done marker must be in Phase 0 (between Phase 0 and Phase 1 headings)'
  );

  // Verify the marker instruction mentions both INTERACTIVE and HEADLESS branches
  const phase0Content = orchestratingSkill.substring(phase0Start, phase1Start);
  assert(
    phase0Content.includes('**INTERACTIVE:**') && phase0Content.includes('**HEADLESS:**'),
    'Phase 0 marker step must have explicit INTERACTIVE and HEADLESS branches'
  );

  // Verify both branches mention the marker
  const interactiveSection = phase0Content.substring(
    phase0Content.lastIndexOf('**INTERACTIVE:**'),
    phase0Content.length
  );
  assert(
    interactiveSection.includes('mark.mjs brainstorm-done'),
    'INTERACTIVE branch must mention mark.mjs brainstorm-done'
  );
});

/**
 * #ac-1.1 / #ac-1.3 — the plan-review HARD-GATE names its own stop condition and carries no
 * foreign cap. A round number or the word "cap"/"stop" at the point of action is what let a
 * converging review abort against the adversary loop's cap (#529).
 */
test('#ac-1.1 HARD-GATE 2 headless delegates the plan-review loop to plan_review_count / revise_nudge only', () => {
  const skill = readOcSkill('orchestrating-delivery');

  const gateStart = skill.indexOf('**HARD-GATE 2 — approve plan');
  assert.notEqual(gateStart, -1, 'orchestrating-delivery must have a HARD-GATE 2 block');
  const gateBlock = skill.slice(gateStart, skill.indexOf('\n\n', gateStart));

  const headlessStart = gateBlock.indexOf('**HEADLESS:**');
  assert.notEqual(headlessStart, -1, 'HARD-GATE 2 must have a HEADLESS branch');
  const headless = gateBlock.slice(headlessStart);

  // #ac-1.1: the only two authorities named for this loop.
  assert.match(headless, /plan_review_count/, 'HARD-GATE 2 headless must name plan_review_count');
  assert.match(headless, /revise_nudge/, 'HARD-GATE 2 headless must name revise_nudge');

  // #ac-1.1: the positive next action, so a REVISE has somewhere to go.
  assert.match(headless, /re-dispatch `planner`/, 'HARD-GATE 2 headless must state the next action (re-dispatch planner)');

  // #ac-1.3: read in isolation it carries no round number and no stop instruction — negating a
  // stop condition at the point of action installs the association instead of removing it.
  // The negatives cover SYNONYMS, not two literal words: "once the adversary ceiling is reached,
  // halt and comment" reinstalls the exact defect while dodging "cap" and "stop".
  assert.doesNotMatch(
    headless,
    /\bround\s*\d|\b\d+\s*rounds?\b/i,
    'HARD-GATE 2 headless must contain no round number'
  );
  assert.doesNotMatch(
    headless,
    /\b(caps?|ceilings?|budget exhausted|past (the )?budget)\b/i,
    'HARD-GATE 2 headless must not name a cap or ceiling — foreign or its own'
  );
  assert.doesNotMatch(
    headless,
    /\b(stop|stops|stopping|stopped|halt|halts|abort|aborts|escalate|escalates|give up|hand (this |it )?back)\b/i,
    'HARD-GATE 2 headless must carry no stop instruction — only the next action and the nudge'
  );
});

/**
 * #ac-1.2 — each numbered cap declares, in its own rule, the loop it governs and that it does not
 * govern the plan-review loop. Scope lives with the rule that needs containing, never at the point
 * of action.
 */
test('#ac-1.2 every numbered cap in orchestrating-delivery declares its scope', () => {
  const skill = readOcSkill('orchestrating-delivery');

  // Discovered by SWEEP, not by a hardcoded list: the AC says "each numbered cap block of the
  // file", so a cap added tomorrow must fail by construction until it declares its scope.
  const CAP_RULE_LINE = /^.*\*\*(?:Cap \d|CAP = \d|Same-agent retry K=\d|Primary failure cap)[^\n]*$/gm;
  const rules = [...skill.matchAll(CAP_RULE_LINE)].map((match) => match[0]);

  // These four are known to exist; a drop below that means the sweep silently stopped matching.
  assert.ok(rules.length >= 4, `expected at least 4 numbered cap rules, swept ${rules.length}`);

  for (const rule of rules) {
    const label = rule.slice(0, 60);

    // The rule is its own markdown paragraph — the scope declaration must live inside it, next to
    // the rule that needs containing, never at the point of action.
    assert.match(rule, /\bonly\b/, `cap rule must scope itself with "only": ${label}`);
    assert.match(
      rule,
      /never bounds the plan-reviewer[^.]*`plan_review_count`/,
      `cap rule must declare it does not bound the plan-review loop: ${label}`
    );
  }

  // The plan-review loop's own section states it has no second budget (#ac-1.1), and does it
  // WITHOUT enumerating the foreign caps by name at the point of action (the PR #10 lesson).
  const ownSection = skill.match(/This loop has no second budget[^\n]*/);
  assert.notEqual(ownSection, null, 'the plan-review step must declare it has no second budget');
  assert.doesNotMatch(
    ownSection[0],
    /CAP = \d|Cap \d|K=\d/,
    'the plan-review step must not name foreign caps at the point of action'
  );
});

/**
 * #ac-3.1 — the prose budget cannot drift from the deterministic gate. The skill is a system
 * instruction; a number it states that the rail does not enforce is a live stop-rule collision.
 */
test('#529 the plan-review budget in orchestrating-delivery matches LOOP_THRESHOLDS', () => {
  const skill = readOcSkill('orchestrating-delivery');

  const stated = skill.match(/`plan_review_count`,\s*(\d+)\s*useful rounds/);
  assert.notEqual(stated, null, 'orchestrating-delivery must state the plan_review_count budget in rounds');
  assert.equal(
    Number(stated[1]),
    LOOP_THRESHOLDS.plan_review.deny,
    'the budget in prose must equal LOOP_THRESHOLDS.plan_review.deny'
  );
});

/**
 * #ac-2.1 — creating-plans runs inside the planner, which has no user in headless. Every
 * "stop and ask the user" needs a headless branch or the planner strands the run.
 */
test('#ac-2.1 every "ask the user" in creating-plans has a HEADLESS branch', () => {
  const skill = readOcSkill('creating-plans');

  assert.match(skill, /\*\*HEADLESS:?\*\*/, 'creating-plans must have at least one HEADLESS branch');

  // Synonyms too: "resolve it with the user" / "ask the operator" / "consult the user" are the
  // same instruction, and keying on one literal lets the defect back in under another word.
  const ASK_PATTERN = /\b(ask|consult|resolve it with|check with|confirm with)\s+the\s+(user|operator)\b/gi;
  const occurrences = [...skill.matchAll(ASK_PATTERN)];
  assert.notEqual(occurrences.length, 0, 'creating-plans must still describe the interactive ask');

  for (const match of occurrences) {
    const window = skill.slice(Math.max(0, match.index - 400), match.index + 700);
    assert.match(
      window,
      /\*\*HEADLESS:?\*\*/,
      `"${match[0]}" at offset ${match.index} has no HEADLESS branch — headless has no user to ask`
    );
  }
});

/**
 * #ac-2.2 — a headless planner resolves the ambiguity and records it; it never returns no plan and
 * never leaves TBD in resolved_judgments.
 */
test('#ac-2.2 creating-plans makes the headless planner resolve and mark, never withhold the plan', () => {
  const skill = readOcSkill('creating-plans');

  assert.match(
    skill,
    /resolved_judgments_model_resolved/,
    'creating-plans must name the array that marks a model-resolved judgment'
  );
  assert.match(
    skill,
    /never return without a plan/i,
    'creating-plans must forbid the headless planner from returning no plan'
  );
  assert.match(
    skill,
    /`TBD` is never a valid value/,
    'creating-plans must forbid TBD in resolved_judgments in both modes'
  );
});
