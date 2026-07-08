#!/usr/bin/env node
/**
 * @description Locked tests for the DEFERRED-RISK cross-task recheck mechanism.
 * Verifies orchestrating-delivery/SKILL.md documents:
 *   (1) The Phase 2 "record + curate" (step 6) `### DEFERRED-RISK: <task-id>` block format —
 *       `falsify:` (neutral hypothesis-to-disprove) and `guards:` (a state entity, NEVER a file
 *       path) fields, and that `falsify` MUST NOT carry a prior verdict / safe-fine-confirmed
 *       conclusion.
 *   (2) The block's write semantics — idempotent rewrite keyed by task-id (NOT an append),
 *       inheriting the same no-secrets/no-PII scrub as the rest of shared_context.
 *   (3) The Phase 2 per-task "adversary" (step 3) pre-dispatch match: the ORCHESTRATOR (not the
 *       adversary, not an LLM judgment) greps the current task's diff CONTENT across every file
 *       for each accumulated DEFERRED-RISK note's `guards` entity names, folding ONLY matched
 *       notes into the adversary's L2 task contract as a "falsify these premises" directive.
 *   (4) The no-match branch is a no-op — the adversary dispatch stays byte-identical, virgin,
 *       zero shared_context exposure.
 *   (5) "Context composition" reconciliation — the existing "adversary enters virgin" /
 *       "non-negotiable" guardrail still stands, and the DEFERRED-RISK match is a narrow,
 *       deterministic (grep-matched) exception scoped to matched guards overlaps, explicitly
 *       NOT a general loosening of the virgin rule.
 *   (6) The reporting rule — a matched premise that no longer holds becomes a
 *       `[cross-task-composition]` finding on the CURRENT task citing the originating task-id,
 *       flowing into step 5 like any other finding; no match / all premises holding → no new
 *       finding.
 *   (7) The retention policy — DEFERRED-RISK notes are EXEMPT from the general shared_context
 *       relevance ceiling, removed/resolved only when a later diff guards the named entity AND
 *       that guard is pinned by a frozen locked_test, never on unaided orchestrator judgment.
 *   (8) The mode scope — the mechanism is FULL-mode only (LIGHT's "Per-task review: none" row is
 *       unaffected), and Phase 3 (final dual review) is not touched by it.
 *
 * SECTION-SCOPED: tests 1, 2, 7 scoped to "record + curate"; tests 3, 4, 6 scoped to
 * "3. adversary"; test 5 scoped to "Context composition"; test 8 scans the whole document.
 * The mechanism is not yet documented in SKILL.md — every test below is designed to fail RED
 * until a later step wires the DEFERRED-RISK mechanism into the skill.
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

// ─── Test 1 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md's Phase 2 "record + curate" (step 6) section.
 * When: the DEFERRED-RISK note format is inspected.
 * Then: the section documents a `### DEFERRED-RISK: <task-id>` block carrying a `falsify:`
 *       field (a neutral hypothesis-to-disprove) and a `guards:` field; states that `guards`
 *       names a state entity such as a table/column/cache-key/symbol and is NEVER a file path;
 *       and states that `falsify` MUST NOT contain a prior verdict or a
 *       "safe"/"fine"/"compliance-confirmed" conclusion.
 */
test("orchestrating-delivery Phase 2 record + curate (step 6): DEFERRED-RISK block format documents falsify/guards fields with the state-entity-not-file-path and no-prior-verdict constraints", () => {
  const start = skillMd.indexOf("**6. record + curate**");
  const end = skillMd.indexOf("**6-commit. impl-commit**", start);
  assert(start !== -1, "record + curate (step 6) marker not found in orchestrating-delivery SKILL.md");
  const section = skillMd.slice(start, end === -1 ? undefined : end);

  const sectionLower = section.toLowerCase();

  const hasDeferredRiskBlockFormat =
    sectionLower.includes("deferred-risk:") &&
    sectionLower.includes("<task-id>") &&
    sectionLower.includes("falsify:") &&
    sectionLower.includes("guards:");
  assert(
    hasDeferredRiskBlockFormat,
    "record + curate section must document a `### DEFERRED-RISK: <task-id>` block carrying `falsify:` and `guards:` fields"
  );

  const hasFalsifyIsNeutralHypothesis =
    sectionLower.includes("falsify") &&
    (sectionLower.includes("neutral hypothesis") ||
      sectionLower.includes("hypothesis-to-disprove") ||
      sectionLower.includes("hypothesis to disprove"));
  assert(
    hasFalsifyIsNeutralHypothesis,
    "record + curate section must state `falsify` is a neutral hypothesis-to-disprove"
  );

  const hasGuardsStateEntityNotFilePath =
    sectionLower.includes("guards") &&
    (sectionLower.includes("table") ||
      sectionLower.includes("column") ||
      sectionLower.includes("cache-key") ||
      sectionLower.includes("symbol")) &&
    (sectionLower.includes("never a file path") ||
      sectionLower.includes("not a file path") ||
      sectionLower.includes("never a path"));
  assert(
    hasGuardsStateEntityNotFilePath,
    "record + curate section must state `guards` names a state entity (table/column/cache-key/symbol) and is NEVER a file path"
  );

  const hasFalsifyNoPriorVerdict =
    sectionLower.includes("falsify") &&
    (sectionLower.includes("must not contain a prior verdict") ||
      sectionLower.includes("must not contain a verdict") ||
      sectionLower.includes("no prior verdict")) &&
    (sectionLower.includes("safe") ||
      sectionLower.includes("fine") ||
      sectionLower.includes("compliance-confirmed"));
  assert(
    hasFalsifyNoPriorVerdict,
    "record + curate section must state `falsify` MUST NOT contain a prior verdict or a safe/fine/compliance-confirmed conclusion"
  );
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md's Phase 2 "record + curate" (step 6) section.
 * When: the DEFERRED-RISK write semantics are inspected.
 * Then: the section states the block is written as an idempotent rewrite keyed by task-id
 *       (NOT an append) and inherits the same no-secrets/no-PII scrub as the rest of
 *       shared_context.
 */
test("orchestrating-delivery Phase 2 record + curate (step 6): DEFERRED-RISK note write semantics are an idempotent rewrite keyed by task-id and inherit the no-secrets/no-PII scrub", () => {
  const start = skillMd.indexOf("**6. record + curate**");
  const end = skillMd.indexOf("**6-commit. impl-commit**", start);
  assert(start !== -1, "record + curate (step 6) marker not found in orchestrating-delivery SKILL.md");
  const section = skillMd.slice(start, end === -1 ? undefined : end);

  const sectionLower = section.toLowerCase();

  const hasIdempotentRewriteKeyedByTaskId =
    sectionLower.includes("idempotent") &&
    sectionLower.includes("rewrite") &&
    sectionLower.includes("keyed by task-id") &&
    (sectionLower.includes("not an append") ||
      sectionLower.includes("never an append") ||
      sectionLower.includes("not append"));
  assert(
    hasIdempotentRewriteKeyedByTaskId,
    "record + curate section must state the DEFERRED-RISK block is written as an idempotent rewrite keyed by task-id, NOT an append"
  );

  const hasNoSecretsScrubInheritance =
    sectionLower.includes("deferred-risk") &&
    (sectionLower.includes("no-secrets") || sectionLower.includes("no secrets")) &&
    (sectionLower.includes("no-pii") || sectionLower.includes("no pii")) &&
    (sectionLower.includes("inherit") || sectionLower.includes("same"));
  assert(
    hasNoSecretsScrubInheritance,
    "record + curate section must state the DEFERRED-RISK block inherits the same no-secrets/no-PII scrub as the rest of shared_context"
  );
});

// ─── Test 3 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md's Phase 2 per-task "adversary" (step 3) section.
 * When: the pre-dispatch match step is inspected.
 * Then: the section states that the ORCHESTRATOR (explicitly not the adversary and not an LLM
 *       judgment) greps the current task's diff CONTENT across every file in the diff (not
 *       filename-scoped) for each accumulated DEFERRED-RISK note's `guards` entity names, and
 *       on a match folds ONLY the matched note(s) into the adversary's L2 task contract as a
 *       "falsify these premises" directive.
 */
test("orchestrating-delivery Phase 2 per-task adversary (step 3): the ORCHESTRATOR greps the diff CONTENT across every file for each DEFERRED-RISK note's guards entity, folding only matched notes into the adversary L2 contract", () => {
  const start = skillMd.indexOf("**3. adversary**");
  const end = skillMd.indexOf("**3b. security**", start);
  assert(start !== -1, "Phase 2 per-task adversary (step 3) marker not found in orchestrating-delivery SKILL.md");
  const section = skillMd.slice(start, end === -1 ? undefined : end);

  const sectionLower = section.toLowerCase();

  const hasOrchestratorNotAdversaryNotLLM =
    sectionLower.includes("orchestrator") &&
    (sectionLower.includes("not the adversary") || sectionLower.includes("not adversary")) &&
    (sectionLower.includes("not an llm judgment") ||
      sectionLower.includes("not llm judgment") ||
      sectionLower.includes("not a llm judgment"));
  assert(
    hasOrchestratorNotAdversaryNotLLM,
    "Phase 2 per-task adversary section must state the ORCHESTRATOR (explicitly not the adversary, not an LLM judgment) performs the pre-dispatch match"
  );

  const hasGrepDiffContentAllFiles =
    sectionLower.includes("grep") &&
    sectionLower.includes("diff") &&
    sectionLower.includes("content") &&
    (sectionLower.includes("every file") || sectionLower.includes("all files")) &&
    (sectionLower.includes("not filename-scoped") || sectionLower.includes("not filename scoped"));
  assert(
    hasGrepDiffContentAllFiles,
    "Phase 2 per-task adversary section must state the orchestrator greps the diff CONTENT across every file in the diff (not filename-scoped)"
  );

  const hasGuardsEntityNames =
    sectionLower.includes("deferred-risk") &&
    sectionLower.includes("guards") &&
    (sectionLower.includes("entity name") || sectionLower.includes("entity names"));
  assert(
    hasGuardsEntityNames,
    "Phase 2 per-task adversary section must state the grep targets each accumulated DEFERRED-RISK note's guards entity names"
  );

  const hasFoldOnlyMatchedIntoL2FalsifyDirective =
    sectionLower.includes("fold") &&
    sectionLower.includes("only") &&
    sectionLower.includes("matched") &&
    sectionLower.includes("l2") &&
    (sectionLower.includes("falsify these premises") ||
      (sectionLower.includes("falsify") && sectionLower.includes("premises")));
  assert(
    hasFoldOnlyMatchedIntoL2FalsifyDirective,
    "Phase 2 per-task adversary section must state a match folds ONLY the matched note(s) into the adversary's L2 task contract as a 'falsify these premises' directive"
  );
});

// ─── Test 4 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md's Phase 2 per-task "adversary" (step 3) section.
 * When: the no-match branch is inspected.
 * Then: the section states that with no match the step is a no-op and the adversary dispatch is
 *       byte-identical to today — still virgin, with zero shared_context exposure.
 */
test("orchestrating-delivery Phase 2 per-task adversary (step 3): the no-match branch is a no-op — dispatch stays byte-identical, virgin, zero shared_context exposure", () => {
  const start = skillMd.indexOf("**3. adversary**");
  const end = skillMd.indexOf("**3b. security**", start);
  assert(start !== -1, "Phase 2 per-task adversary (step 3) marker not found in orchestrating-delivery SKILL.md");
  const section = skillMd.slice(start, end === -1 ? undefined : end);

  const sectionLower = section.toLowerCase();

  const hasNoMatchNoOp = sectionLower.includes("no match") && sectionLower.includes("no-op");
  assert(
    hasNoMatchNoOp,
    "Phase 2 per-task adversary section must state that with no match the step is a no-op"
  );

  const hasByteIdenticalVirginZeroExposure =
    (sectionLower.includes("byte-identical") || sectionLower.includes("byte identical")) &&
    sectionLower.includes("virgin") &&
    (sectionLower.includes("zero shared_context exposure") ||
      (sectionLower.includes("zero") &&
        sectionLower.includes("shared_context") &&
        sectionLower.includes("exposure")));
  assert(
    hasByteIdenticalVirginZeroExposure,
    "Phase 2 per-task adversary section must state the dispatch stays byte-identical to today, still virgin, with zero shared_context exposure"
  );
});

// ─── Test 5 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md's "Context composition" section.
 * When: the virgin-guarantee reconciliation is inspected.
 * Then: the existing "adversary enters virgin" guardrail bullet and its "non-negotiable"
 *       wording are still present AND a reconciliation note states the DEFERRED-RISK match is a
 *       narrow, deterministic (grep-matched) exception scoped only to matched guards overlaps,
 *       explicitly NOT a general loosening of the virgin rule.
 */
test("orchestrating-delivery Context composition: the virgin-guarantee guardrail and its non-negotiable wording remain, reconciled by a narrow deterministic DEFERRED-RISK exception scoped to matched guards overlaps", () => {
  const section = extractSection(skillMd, "Context composition");
  assert(section.length > 0, "Context composition section not found in orchestrating-delivery SKILL.md");

  const sectionLower = section.toLowerCase();

  const hasVirginGuardrailNonNegotiable =
    sectionLower.includes("adversary enters") &&
    sectionLower.includes("virgin") &&
    sectionLower.includes("non-negotiable");
  assert(
    hasVirginGuardrailNonNegotiable,
    "Context composition section must still carry the existing 'adversary enters virgin' guardrail bullet with its 'non-negotiable' wording"
  );

  const hasReconciliationNote =
    sectionLower.includes("deferred-risk") &&
    sectionLower.includes("narrow") &&
    (sectionLower.includes("deterministic") ||
      sectionLower.includes("grep-matched") ||
      sectionLower.includes("grep matched")) &&
    sectionLower.includes("exception") &&
    sectionLower.includes("guards");
  assert(
    hasReconciliationNote,
    "Context composition section must state the DEFERRED-RISK match is a narrow, deterministic (grep-matched) exception scoped only to matched guards overlaps"
  );

  const hasNotGeneralLoosening =
    sectionLower.includes("not a general loosening") && sectionLower.includes("virgin");
  assert(
    hasNotGeneralLoosening,
    "Context composition section must explicitly state the DEFERRED-RISK exception is NOT a general loosening of the virgin rule"
  );
});

// ─── Test 6 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md's Phase 2 per-task "adversary" (step 3) reporting rule.
 * When: a matched premise no longer holds.
 * Then: the section states the adversary reports it as a finding on the CURRENT task tagged
 *       `[cross-task-composition]` (citing the originating task-id) that flows into step 5
 *       (sniper) like any other finding, and that zero matches or all premises still holding
 *       produces no new finding.
 */
test("orchestrating-delivery Phase 2 per-task adversary (step 3): a stale matched premise is reported as a [cross-task-composition] finding on the current task citing the originating task-id, feeding step 5; no matches or all premises holding yields no new finding", () => {
  const start = skillMd.indexOf("**3. adversary**");
  const end = skillMd.indexOf("**3b. security**", start);
  assert(start !== -1, "Phase 2 per-task adversary (step 3) marker not found in orchestrating-delivery SKILL.md");
  const section = skillMd.slice(start, end === -1 ? undefined : end);

  const sectionLower = section.toLowerCase();

  const hasCrossTaskCompositionTag =
    sectionLower.includes("[cross-task-composition]") &&
    sectionLower.includes("current task") &&
    (sectionLower.includes("originating task-id") ||
      sectionLower.includes("citing the originating task-id") ||
      (sectionLower.includes("citing") && sectionLower.includes("task-id")));
  assert(
    hasCrossTaskCompositionTag,
    "Phase 2 per-task adversary section must state a matched premise that no longer holds is reported as a finding on the CURRENT task tagged [cross-task-composition] citing the originating task-id"
  );

  const hasFlowsIntoStep5LikeAnyOther =
    sectionLower.includes("step 5") &&
    (sectionLower.includes("like any other finding") || sectionLower.includes("any other finding"));
  assert(
    hasFlowsIntoStep5LikeAnyOther,
    "Phase 2 per-task adversary section must state the finding flows into step 5 (sniper) like any other finding"
  );

  const hasNoMatchOrAllHoldingNoNewFinding =
    (sectionLower.includes("zero matches") || sectionLower.includes("no matches")) &&
    sectionLower.includes("all premises") &&
    sectionLower.includes("hold") &&
    (sectionLower.includes("no new finding") || sectionLower.includes("produces no new finding"));
  assert(
    hasNoMatchOrAllHoldingNoNewFinding,
    "Phase 2 per-task adversary section must state zero matches or all premises still holding produces no new finding"
  );
});

// ─── Test 7 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md's DEFERRED-RISK bookkeeping rule.
 * When: the retention policy is inspected.
 * Then: the section states DEFERRED-RISK notes are EXEMPT from the general shared_context
 *       relevance ceiling and are removed/marked resolved ONLY when a later task's diff guards
 *       the named entity AND that guard is pinned by a frozen locked_test — never on the
 *       orchestrator's unaided judgment.
 */
test("orchestrating-delivery Phase 2 record + curate (step 6): DEFERRED-RISK notes are exempt from the shared_context relevance ceiling and are removed only when a later diff guards the entity AND a frozen locked_test pins that guard", () => {
  const start = skillMd.indexOf("**6. record + curate**");
  const end = skillMd.indexOf("**6-commit. impl-commit**", start);
  assert(start !== -1, "record + curate (step 6) marker not found in orchestrating-delivery SKILL.md");
  const section = skillMd.slice(start, end === -1 ? undefined : end);

  const sectionLower = section.toLowerCase();

  const hasExemptFromCeiling =
    sectionLower.includes("deferred-risk") &&
    sectionLower.includes("exempt") &&
    sectionLower.includes("ceiling");
  assert(
    hasExemptFromCeiling,
    "record + curate section must state DEFERRED-RISK notes are EXEMPT from the general shared_context relevance ceiling"
  );

  const hasRemovalConditions =
    (sectionLower.includes("removed") || sectionLower.includes("resolved")) &&
    sectionLower.includes("guards the") &&
    sectionLower.includes("frozen") &&
    sectionLower.includes("locked_test");
  assert(
    hasRemovalConditions,
    "record + curate section must state DEFERRED-RISK notes are removed/marked resolved ONLY when a later task's diff guards the named entity AND that guard is pinned by a frozen locked_test"
  );

  const hasNeverUnaidedJudgment =
    sectionLower.includes("never") &&
    sectionLower.includes("orchestrator") &&
    (sectionLower.includes("unaided judgment") || sectionLower.includes("unaided judgement"));
  assert(
    hasNeverUnaidedJudgment,
    "record + curate section must state the removal never happens on the orchestrator's unaided judgment"
  );
});

// ─── Test 8 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md's DEFERRED-RISK mechanism documentation.
 * When: its mode scope is inspected.
 * Then: the SKILL.md explicitly states the mechanism is FULL-mode only (LIGHT's "Per-task
 *       review: none" row is unaffected) and that Phase 3 (final dual review) is NOT touched
 *       by it.
 */
test("orchestrating-delivery DEFERRED-RISK mechanism documentation: explicitly FULL-mode only (LIGHT's 'Per-task review: none' row unaffected) and Phase 3 final dual review is not touched", () => {
  const contentLower = skillMd.toLowerCase();

  const hasFullModeOnly =
    contentLower.includes("deferred-risk") &&
    (contentLower.includes("full-mode only") || contentLower.includes("full mode only"));
  assert(
    hasFullModeOnly,
    "SKILL.md must explicitly state the DEFERRED-RISK mechanism is FULL-mode only"
  );

  const hasLightPerTaskReviewNoneUnaffected =
    contentLower.includes("light") &&
    contentLower.includes("per-task review") &&
    contentLower.includes("none") &&
    contentLower.includes("unaffected");
  assert(
    hasLightPerTaskReviewNoneUnaffected,
    "SKILL.md must state LIGHT's 'Per-task review: none' row is unaffected by the DEFERRED-RISK mechanism"
  );

  const hasPhase3NotTouched =
    contentLower.includes("phase 3") &&
    (contentLower.includes("not touched") || contentLower.includes("is not touched"));
  assert(
    hasPhase3NotTouched,
    "SKILL.md must state Phase 3 (final dual review) is NOT touched by the DEFERRED-RISK mechanism"
  );
});
