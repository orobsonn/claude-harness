#!/usr/bin/env node
/**
 * @description Locked tests for the sniper-hand-regate feature (strong eyes, cheap hands v2).
 * Verifies that:
 *   (1) sniper.md AND orchestrating-delivery/SKILL.md state the sniper resolves from
 *       hand_tiers[issue.severity] (cheap Ollama hand) for ALL severities, including high;
 *   (2) orchestrating-delivery/SKILL.md rewrites the fail-class floor in hand_tiers
 *       denomination ("never below hand_tiers.medium"), replacing the old "never below sonnet"
 *       Claude-alias floor;
 *   (3) the Phase 2 loop description for a high-severity sniper fix mandates a re-gate by a
 *       strong Claude eye (fresh virgin adversary) AFTER the fix, and a reconciliation note
 *       states the re-gate — not a Claude sniper — guarantees the grave fix.
 *
 * SECTION-SCOPED: orchestrating-delivery assertions are scoped to "Model routing" or "Phase 2"
 * sections; sniper.md is short and tested document-wide.
 * Tests run under node:test.
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

const SNIPER_MD_PATH = resolve(__dirname, "../agents/sniper.md");

const MARK_MJS_PATH = resolve(__dirname, "../hooks/mark.mjs");

const orchestratingMd = readFileSync(ORCHESTRATING_MD_PATH, "utf8");
const sniperMd = readFileSync(SNIPER_MD_PATH, "utf8");
const markMjs = readFileSync(MARK_MJS_PATH, "utf8");

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
 * Given: sniper.md and orchestrating-delivery/SKILL.md.
 * When: the model note in sniper.md and the "Model routing" section of
 *       orchestrating-delivery are inspected.
 * Then: both state the sniper resolves from hand_tiers[issue.severity] (a cheap Ollama hand)
 *       for ALL severities, including high — with no Claude-tier exception for high.
 */
test("sniper.md and orchestrating-delivery: sniper resolves from hand_tiers[issue.severity] for ALL severities including high", () => {
  // --- sniper.md: model note must mention hand_tiers ---
  // sniper.md is a short, focused doc; checked document-wide (like test-author checks in test-rail).
  assert(
    sniperMd.includes("hand_tiers"),
    "sniper.md model note must reference hand_tiers (cheap Ollama hand routing)"
  );

  // Must NOT still say the old Claude-tier routing (haiku/sonnet/opus per tier)
  const sniperMdLower = sniperMd.toLowerCase();
  const hasOldClaudeRouting =
    sniperMdLower.includes("opus for high") ||
    sniperMdLower.includes("haiku for low, sonnet for medium, opus for high");
  assert(
    !hasOldClaudeRouting,
    "sniper.md must NOT retain the old 'haiku for low, sonnet for medium, opus for high' Claude-tier routing"
  );

  // --- orchestrating-delivery: Model routing section — ALL sniper rows must reference hand_tiers ---
  const routingSection = extractSection(orchestratingMd, "Model routing");
  assert(
    routingSection.length > 0,
    "Model routing section not found in orchestrating-delivery SKILL.md"
  );

  const rows = extractTableRows(routingSection);

  // Collect ALL sniper rows (handles duplicate rows for same role)
  const sniperRows = rows.filter((r) => r.toLowerCase().includes("| sniper"));
  assert(sniperRows.length > 0, "sniper row not found in Model routing table");

  for (const row of sniperRows) {
    assert(
      row.includes("hand_tiers"),
      `sniper routing row must reference hand_tiers (cheap Ollama hand) for ALL severities, got:\n  ${row}`
    );
    // Must NOT still say the old tiers[] (Claude model tiers denominator)
    assert(
      !row.includes("`tiers["),
      `sniper routing row must NOT reference old \`tiers[\` (Claude model tiers), got:\n  ${row}`
    );
  }
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md with a "Phase 2" section.
 * When: the Phase 2 section is extracted.
 * Then: the sniper fail-class floor is stated in hand_tiers denomination:
 *       "never below hand_tiers.medium for a fail-class finding",
 *       and the old "never below sonnet" / "never dispatch below sonnet" Claude-alias
 *       wording is NOT present anywhere in that section's sniper step.
 */
test("orchestrating-delivery Phase 2: sniper fail-class floor is 'never below hand_tiers.medium' (old 'never below sonnet' replaced)", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(
    section.length > 0,
    "Phase 2 section not found in orchestrating-delivery SKILL.md"
  );

  // New floor must be in hand_tiers denomination
  const hasHandTiersMediumFloor =
    section.includes("hand_tiers.medium") &&
    (section.includes("fail-class") || section.includes("fail class"));
  assert(
    hasHandTiersMediumFloor,
    "Phase 2 sniper step must state the fail-class floor as 'never below hand_tiers.medium for a fail-class finding'"
  );

  // Old Claude-alias floor must be GONE from the section
  const hasOldSonnetFloor =
    section.includes("never dispatch below sonnet") ||
    section.includes("never below sonnet");
  assert(
    !hasOldSonnetFloor,
    "Phase 2 sniper step must NOT retain the old 'never below sonnet' (Claude-alias) floor — it must be rewritten in hand_tiers denomination"
  );
});

// ─── Test 3 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md with a "Phase 2" section.
 * When: the Phase 2 section is extracted.
 * Then:
 *   (a) the loop description for a high-severity sniper fix states a MANDATORY re-gate
 *       by a strong Claude eye (fresh virgin adversary) runs AFTER the fix;
 *   (b) a reconciliation note (flagging §8) states the re-gate — not a Claude sniper —
 *       is what guarantees the grave fix.
 */
test("orchestrating-delivery Phase 2: high-severity sniper fix triggers mandatory strong-eye re-gate AFTER fix; reconciliation note states re-gate (not Claude sniper) guarantees grave fix", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(
    section.length > 0,
    "Phase 2 section not found in orchestrating-delivery SKILL.md"
  );

  const sectionLower = section.toLowerCase();

  // (a) MANDATORY re-gate must be explicitly stated after the fix for high severity
  const hasMandatoryRegate =
    (section.includes("MANDATORY re-gate") || section.includes("mandatory re-gate")) &&
    (sectionLower.includes("after the fix") ||
      sectionLower.includes("after your fix") ||
      sectionLower.includes("after the sniper fix"));
  assert(
    hasMandatoryRegate,
    "Phase 2 must state a MANDATORY re-gate runs AFTER the sniper fix for high-severity findings"
  );

  // The re-gate must be by a strong Claude eye (fresh virgin adversary)
  const regateByStrongEye =
    (sectionLower.includes("strong") &&
      sectionLower.includes("eye") &&
      sectionLower.includes("re-gate")) ||
    (sectionLower.includes("virgin adversary") && sectionLower.includes("re-gate")) ||
    (sectionLower.includes("adversary") && sectionLower.includes("mandatory re-gate"));
  assert(
    regateByStrongEye,
    "Phase 2 must state the mandatory re-gate is by a strong Claude eye (fresh virgin adversary)"
  );

  // (b) Reconciliation note: the re-gate (NOT a Claude sniper) guarantees the grave fix
  const hasReconciliationNote =
    section.includes("Reconciles") ||
    section.includes("reconciles") ||
    section.includes("§8") ||
    (section.includes("re-gate") &&
      (section.includes("not a Claude sniper") ||
        section.includes("not the Claude sniper") ||
        section.includes("not a claude sniper")));
  assert(
    hasReconciliationNote,
    "Phase 2 must have a reconciliation note (flagging spec §8) — the re-gate, not a Claude sniper, guarantees the grave fix"
  );

  const regateGuaranteesGraveFix =
    (sectionLower.includes("re-gate") &&
      sectionLower.includes("grave") &&
      sectionLower.includes("guarantee")) ||
    (sectionLower.includes("mandatory") &&
      sectionLower.includes("re-gate") &&
      sectionLower.includes("grave"));
  assert(
    regateGuaranteesGraveFix,
    "Phase 2 reconciliation note must state the mandatory re-gate guarantees the grave fix"
  );
});

// ─── Test 4 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md Phase 2 section.
 * When: the sniper severity-resolution clause is inspected.
 * Then: the safety-critical "gate failure / compliance VIOLATED-locked-decision = auto-high"
 *       resolution clause survives — without it, a grave finding could resolve to a low tier
 *       and skip the re-gate.
 */
test("orchestrating-delivery Phase 2: auto-high severity-resolution clause (gate failure / compliance VIOLATED = auto-high) survives", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found");

  const hasAutoHighClause =
    section.includes("auto-") &&
    section.toLowerCase().includes("high") &&
    section.includes("gate failure") &&
    section.includes("VIOLATED");
  assert(
    hasAutoHighClause,
    "Phase 2 step 5 must state a gate failure or a compliance VIOLATED-locked-decision is auto-high"
  );
});

// ─── Test 5 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery/SKILL.md Phase 2 section.
 * When: the deterministic re-gate rail is inspected.
 * Then: the `regate-pending`/`regate-passed` markers are referenced as a
 *       delivery-blocking precondition (the rail that survives compaction).
 */
test("orchestrating-delivery Phase 2: regate-pending/regate-passed referenced as a delivery-blocking precondition", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found");

  assert(
    section.includes("regate-pending") && section.includes("regate-passed"),
    "Phase 2 step 5 must reference both regate-pending and regate-passed markers"
  );
  assert(
    section.toLowerCase().includes("delivery-blocking"),
    "Phase 2 step 5 must state the unmatched regate-pending is a delivery-blocking precondition"
  );
});

// ─── Test 6 ───────────────────────────────────────────────────────────────────
/**
 * Given: hooks/mark.mjs (the marker CLI).
 * When: the supported markers are inspected.
 * Then: mark.mjs supports the two new re-gate markers (regate-pending, regate-passed),
 *       so the deterministic rail has a CLI surface to stamp them.
 */
test("mark.mjs supports the regate-pending and regate-passed markers", () => {
  assert(
    markMjs.includes("regate-pending"),
    "mark.mjs must support the regate-pending marker"
  );
  assert(
    markMjs.includes("regate-passed"),
    "mark.mjs must support the regate-passed marker"
  );
});

// ─── Test 7 (Change 2 — process-eye-routing) ────────────────────────────────────
/**
 * Given: orchestrating-delivery Phase 2 step 5.
 * When: the conditional re-gate for a NON-grave surgical HIGH fix is inspected.
 * Then: a light path is allowed via (a) a red->green frozen test OR (b) a virgin sonnet
 *       adversary spot-check, and a merely "stays green" test is explicitly INSUFFICIENT.
 */
test("Phase 2 step 5 (Change 2): non-grave surgical HIGH fix light path — red->green test OR virgin sonnet spot-check; stays-green rejected", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found");
  const lower = section.toLowerCase();

  // A conditional / light path exists for a surgical, non-grave HIGH fix.
  assert(
    (lower.includes("surgical") || lower.includes("mechanical")) &&
      (lower.includes("light path") || lower.includes("conditional re-gate") || lower.includes("conditional")),
    "step 5 must describe a conditional/light re-gate path for a non-grave surgical HIGH fix"
  );

  // Option (a): a red->green frozen test IS the re-gate.
  assert(
    lower.includes("red") && lower.includes("green"),
    "step 5 light path must include the red->green frozen-test shortcut"
  );

  // Explicitly reject a "stays green" test as sufficient (adversary H2).
  assert(
    lower.includes("stays green") || lower.includes("stay green"),
    "step 5 must explicitly REJECT a merely 'stays green' test as the re-gate (insufficient — the test is blind to the fix)"
  );

  // Option (b): a virgin sonnet spot-check eye (still Claude), never the orchestrator.
  assert(
    lower.includes("sonnet") && (lower.includes("spot-check") || lower.includes("spot check")),
    "step 5 light path must include a virgin sonnet adversary spot-check option"
  );
});

// ─── Test 8 (Change 2) — grave classes NEVER take the light path ─────────────────
/**
 * Given: orchestrating-delivery Phase 2 step 5.
 * When: the grave-class guardrail is inspected.
 * Then: an isGrave(fix) fix — any canonical-critical-class, sensitive-path, re-architecture,
 *       or >1 function/seam — is FORBIDDEN the light path and keeps the full opus re-gate;
 *       the omission of the irreversible classes is closed (all canonical classes count).
 */
test("Phase 2 step 5 (Change 2): isGrave(fix) — canonical class / sensitive-path / re-arch / >1 seam — never takes the light path", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found");
  const lower = section.toLowerCase();

  // The grave predicate must cover ALL canonical classes (not a hand-picked two) —
  // named explicitly as canonical-critical-class(es) so the irreversible classes 1/2 are in.
  assert(
    lower.includes("canonical") && (lower.includes("critical-class") || lower.includes("critical class")),
    "step 5 grave predicate must reference the canonical-critical-classes (all of them, incl. the irreversible classes)"
  );

  // Grave surfaces named: sensitive-path AND (re-architecture OR >1 function/seam).
  assert(lower.includes("sensitive-path") || lower.includes("sensitive path"), "grave predicate must include sensitive-path");
  assert(
    lower.includes("re-architecture") || lower.includes(">1 function") || lower.includes("more than one") || lower.includes(">1 seam") || lower.includes("multiple function"),
    "grave predicate must include re-architecture / >1 function-or-seam"
  );

  // The light path is explicitly forbidden for grave fixes — pinned as a CO-LOCATED
  // statement on ONE line (a token-scatter check would stay green if the guarantee sentence
  // were deleted, since 'not'/'light path' co-occur elsewhere in the ~150-line section).
  const graveGuaranteeLine = section
    .split("\n")
    .some((line) => {
      const l = line.toLowerCase();
      return l.includes("grave") && (l.includes("never") || l.includes("forbidden")) && l.includes("light path");
    });
  assert(
    graveGuaranteeLine,
    "step 5 must carry a single-line guarantee that a GRAVE fix NEVER takes the light path (co-located, not token-scattered)"
  );

  // The bias-to-grave default (when in doubt → grave/opus) must be stated (adversary M1).
  assert(
    (lower.includes("when in doubt") || lower.includes("bias-to-grave") || lower.includes("bias to grave") || lower.includes("ambiguity")) &&
      lower.includes("grave"),
    "step 5 must state the hard bias-to-grave default (ambiguity resolves to the full opus re-gate)"
  );
});

// ─── Test 9 (Change 2) — light-path regate-passed requires an on-disk artifact ───
/**
 * Given: orchestrating-delivery self-check section.
 * When: the light-path evidence backstop is inspected.
 * Then: the self-check asserts that every light-path regate-passed has its on-disk
 *       run/ artifact (the only teeth for the prose-only artifact belt; #ac-2.5).
 */
test("Self-check (Change 2): a light-path regate-passed requires its on-disk run/ artifact", () => {
  const selfCheck = extractSection(orchestratingMd, "Self-check");
  assert(selfCheck.length > 0, "Self-check section not found");
  const lower = selfCheck.toLowerCase();

  assert(
    lower.includes("regate-passed") && lower.includes("light path") && lower.includes("artifact"),
    "self-check must require an on-disk artifact for every light-path regate-passed (#ac-2.5)"
  );
  assert(
    lower.includes("run/") || lower.includes("on-disk") || lower.includes("on disk"),
    "self-check must state the artifact lives on disk under run/"
  );
});

// ─── Test 10 (Change 2) — mark.mjs doc records the flexed re-gate producers ───────
/**
 * Given: hooks/mark.mjs doc-comment.
 * When: inspected.
 * Then: it records that regate-passed may be earned via the full opus adversary (grave) OR
 *       the red->green test / virgin sonnet spot-check (surgical non-grave), each leaving an
 *       artifact (#ac-2.6); and the 2-cycle re-gate iteration cap survives in step 5.
 */
test("mark.mjs doc (Change 2): regate-passed earnable via opus adversary OR red->green test / sonnet spot-check; 2-cycle cap survives", () => {
  const lower = markMjs.toLowerCase();
  assert(
    lower.includes("regate-passed") &&
      (lower.includes("spot-check") || lower.includes("red->green") || lower.includes("red→green") || lower.includes("light path")),
    "mark.mjs doc-comment must record the light-path way to earn regate-passed (surgical non-grave) alongside the full opus adversary (grave) (#ac-2.6)"
  );

  // The 2-cycle re-gate iteration cap must survive in the SKILL step 5.
  const phase2 = extractSection(orchestratingMd, "Phase 2");
  assert(
    phase2.toLowerCase().includes("iteration cap") && phase2.includes("2"),
    "step 5 must retain the 2-cycle re-gate iteration cap (#ac-2.6)"
  );
});
