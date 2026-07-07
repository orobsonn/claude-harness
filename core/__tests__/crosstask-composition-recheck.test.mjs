#!/usr/bin/env node
/**
 * @description Locked tests for the cross-task-composition-recheck feature.
 *
 * The per-task adversary must catch cross-task composition bugs — a later task quietly
 * invalidating an EARLIER task's "deferred-because-unreachable" risk note — before the final
 * review. Verifies that core/skills/orchestrating-delivery/SKILL.md encodes:
 *   (1) a DEDICATED append-only deferred-risk store (deferred-risks.md) that is EXEMPT from the
 *       budget-capped shared_context ceiling — so notes survive the whole run and are never
 *       silently clobbered by the whole-file shared_context rewrite;
 *   (2) a structured note schema whose depends-on captures a DATA-entity / shared-state /
 *       precondition (not only file:function) — so the orphan-state class (row overwrite) is
 *       visible, plus premise + guard + origin task;
 *   (3) the per-task adversary brief construction (Phase 2 step 3): before dispatch, the
 *       orchestrator greps the later task's diff against the earlier deferred-risk notes and
 *       injects each match into adversarial.focus as an attack TARGET (the premise to break),
 *       re-evaluating whether the "unreachable" premise still holds (AC1.1);
 *   (4) a broken premise is flagged as a finding ON THE LATER TASK — routed to the sniper, or
 *       escalated when the fix touches an earlier committed task — never deferred silently to
 *       final review (AC1.2);
 *   (5) the virgin guardrail is preserved — the adversary still never reads shared_context; the
 *       injected item is an attack target, not a verdict;
 *   (6) the mechanism is FULL-only (per-task adversary runs only in FULL) and this limitation is
 *       documented; the final-review process (Phase 3) is not altered.
 *
 * SECTION-SCOPED where noted; otherwise document-wide. Tests run under node:test.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ORCHESTRATING_MD_PATH = resolve(
  __dirname,
  "../skills/orchestrating-delivery/SKILL.md"
);

const orchestratingMd = readFileSync(ORCHESTRATING_MD_PATH, "utf8");
const md = orchestratingMd.toLowerCase();

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
      const match = line.match(/^(#{1,6})\s+/);
      if (match && match[1].length <= headingLevel) break;
      captured.push(line);
    }
  }
  return captured.join("\n");
}

const phase2 = extractSection(orchestratingMd, "Phase 2").toLowerCase();
const contextComposition = extractSection(
  orchestratingMd,
  "Context composition"
).toLowerCase();

test("names a dedicated append-only deferred-risk store, distinct from shared_context", () => {
  assert.match(
    md,
    /deferred-risks\.md/,
    "must name the dedicated deferred-risks.md store"
  );
  assert.match(
    md,
    /append-only/,
    "the deferred-risk store must be append-only"
  );
});

test("the deferred-risk store is exempt from the shared_context budget ceiling", () => {
  // A note stored in the whole-file-rewritten, budget-capped shared_context can be silently
  // dropped; the store must be explicitly exempt so notes survive the entire run.
  assert.match(
    md,
    /exempt from[^\n]*ceiling|not subject to[^\n]*ceiling|never dropped|not budget-capped/,
    "the deferred-risk store must be exempt from the budget/ceiling"
  );
});

test("note schema captures a data-entity / shared-state precondition, not only file:function", () => {
  // depends-on must include the data entity so the orphan-state (row overwrite) class is visible.
  assert.match(
    md,
    /depends-on/,
    "the note schema must have a depends-on field"
  );
  assert.match(
    md,
    /data entity|data-entity|shared state|shared-state|row\/|serialization contract|serialization-contract/,
    "depends-on must span a data entity / shared state, not only file:function"
  );
  assert.match(md, /premise/, "the note schema must carry the premise");
  assert.match(md, /guard/, "the note schema must carry the guard");
});

test("Phase 2 step 3: orchestrator greps the later diff against earlier deferred-risk notes", () => {
  assert.match(
    phase2,
    /grep/,
    "Phase 2 must describe grepping the later diff against deferred-risk notes"
  );
  assert.match(
    phase2,
    /deferred-risk/,
    "Phase 2 must reference the deferred-risk notes"
  );
  assert.match(
    phase2,
    /adversarial\.focus/,
    "matches must be injected into adversarial.focus"
  );
});

test("re-evaluates whether the unreachable premise still holds (AC1.1)", () => {
  assert.match(
    phase2,
    /premise[^\n]{0,40}still holds|whether[^\n]{0,60}premise[^\n]{0,40}holds|unreachable[^\n]{0,80}(still )?holds/,
    "must re-evaluate whether the deferred premise still holds"
  );
});

test("injected item is an attack target, not a verdict (virgin guardrail preserved)", () => {
  assert.match(
    phase2,
    /attack target|premise to break|hypothesis to break|to break/,
    "the injected focus item must be framed as an attack target / premise to break"
  );
  // The adversary must still never read shared_context — the guardrail is not weakened.
  assert.match(
    contextComposition,
    /never reads[^\n]*shared_context|adversary[^\n]*virgin/,
    "Context composition must preserve the adversary's virgin guardrail over shared_context"
  );
});

test("broken premise is flagged as a finding on the later task, not deferred to final review (AC1.2)", () => {
  assert.match(
    phase2,
    /finding on the (later|current) task|flag[^\n]*finding/,
    "a broken premise must be flagged as a finding on the later task"
  );
  assert.match(
    phase2,
    /never[^\n]*final review|not[^\n]*final review|before[^\n]*final review|rather than[^\n]*final review/,
    "the finding must not be silently deferred to final review"
  );
});

test("a cross-task fix touching an earlier committed task escalates, not a per-task sniper job", () => {
  // The sniper's allowed_writes is the current task's scope; a fix in an earlier committed
  // task's files cannot be a per-task sniper job — it must escalate. Anchored on the
  // premise-break context so it pins the new cross-task routing, not pre-existing escalation prose.
  assert.match(
    phase2,
    /premise[^\n]{0,160}escalat|earlier[^\n]{0,40}committed[^\n]{0,160}escalat|escalat[^\n]{0,120}earlier[^\n]{0,40}committed/,
    "a premise-break whose fix touches an earlier committed task must escalate"
  );
});

test("the cross-task re-check is documented as FULL-only", () => {
  const lightFull = extractSection(orchestratingMd, "LIGHT vs FULL").toLowerCase();
  const hay = lightFull + "\n" + phase2;
  // Anchored on the feature's unique tokens so it pins the new FULL-only doc, not the
  // pre-existing "per-task adversary only runs in FULL" sentence.
  assert.match(
    hay,
    /(cross-task|composition re-check|deferred-risk)[^\n]{0,160}(full-only|full only|only in full)|(full-only|full only|only in full)[^\n]{0,160}(cross-task|composition re-check|deferred-risk)/,
    "the cross-task composition re-check must be documented as FULL-only"
  );
});
