/**
 * @description Test suite for skills alignment: validates that triaging-requests and orchestrating-delivery
 * prose align with the deterministic entry gate (classify.mjs marker, brainstorm-done marker, upfront spec-adversary).
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
