#!/usr/bin/env node
/**
 * @description Locked tests for the deterministic test-rail (strong eyes, cheap hands).
 * Verifies that orchestrating-delivery SKILL.md wires: planner-pinned assertion →
 * test-author (Ollama cheap hand) transcribes → compliance (Claude eye) validates
 * fidelity BEFORE freeze → freeze (content-hash MANIFEST) → executor implements
 * read-only → gate re-runs + re-verifies every manifest hash.
 *
 * Also verifies creating-plans SKILL.md states the planner pins (does NOT author or
 * in-run-validate), a cheap test-author transcribes under compliance fidelity validation,
 * and this flow explicitly SUPERSEDES spec §3.7 planner-validates-in-run.
 *
 * SECTION-SCOPED: assertions are made within the target section, not document-wide.
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

const CREATING_PLANS_MD_PATH = resolve(
  __dirname,
  "../skills/creating-plans/SKILL.md"
);

const COMPLIANCE_MD_PATH = resolve(__dirname, "../agents/compliance.md");
const TEST_AUTHOR_MD_PATH = resolve(__dirname, "../agents/test-author.md");

const orchestratingMd = readFileSync(ORCHESTRATING_MD_PATH, "utf8");
const creatingPlansMd = readFileSync(CREATING_PLANS_MD_PATH, "utf8");
const complianceMd = readFileSync(COMPLIANCE_MD_PATH, "utf8");
const testAuthorMd = readFileSync(TEST_AUTHOR_MD_PATH, "utf8");

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
 * Given: orchestrating-delivery SKILL.md with a "Phase 2" section.
 * When: the Phase 2 section is extracted.
 * Then: it documents the per-task order:
 *   (a) test-author transcribes the pinned assertion,
 *   (b) compliance validates fidelity,
 *   (c) freeze,
 *   (d) executor implements against the read-only frozen test.
 */
test("Phase 2 per-task loop: documents order test-author-transcribes → compliance-fidelity → freeze → executor-read-only", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found in orchestrating-delivery SKILL.md");

  // (a) test-author transcribes the pinned assertion
  const mentionsTestAuthorTranscribes =
    (section.includes("test-author") && section.includes("transcribe")) ||
    (section.includes("test-author") && section.includes("transcribes")) ||
    section.includes("test-author transcribes");
  assert(
    mentionsTestAuthorTranscribes,
    "Phase 2 section must state that the test-author transcribes the pinned assertion"
  );

  // (b) compliance validates fidelity
  const mentionsComplianceFidelity =
    (section.includes("compliance") && section.includes("fidelity")) ||
    section.includes("compliance validates fidelity") ||
    section.includes("fidelity validation");
  assert(
    mentionsComplianceFidelity,
    "Phase 2 section must state that compliance validates fidelity"
  );

  // (c) freeze step is present
  const mentionsFreeze =
    section.includes("freeze") || section.includes("frozen manifest") || section.includes("MANIFEST");
  assert(
    mentionsFreeze,
    "Phase 2 section must document the freeze step (manifest freeze)"
  );

  // (d) executor implements against the read-only frozen test
  const mentionsExecutorReadOnly =
    (section.includes("executor") && section.includes("read-only")) ||
    (section.includes("executor") && section.includes("frozen test")) ||
    (section.includes("executor") && section.includes("READ-ONLY"));
  assert(
    mentionsExecutorReadOnly,
    "Phase 2 section must state the executor implements against the read-only frozen test"
  );
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md Phase 2 section.
 * When: the section is extracted.
 * Then:
 *   (a) fidelity validation is attributed to compliance (a Claude eye),
 *   (b) fidelity validation occurs BEFORE the freeze,
 *   (c) it is explicitly stated this is NOT done by the planner in-run.
 */
test("Phase 2: fidelity validation is by compliance (Claude eye) BEFORE freeze, NOT by planner in-run", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found in orchestrating-delivery SKILL.md");

  // (a) fidelity validation attributed to compliance
  const sectionLower = section.toLowerCase();
  const fidelityByCompliance =
    sectionLower.includes("compliance") &&
    (sectionLower.includes("fidelity") || sectionLower.includes("fidelity validation"));
  assert(
    fidelityByCompliance,
    "Phase 2 section must attribute fidelity validation to compliance (the Claude eye)"
  );

  // (b) fidelity validation is BEFORE the freeze
  const fidelityBeforeFreeze =
    section.includes("before freeze") ||
    section.includes("before the freeze") ||
    section.includes("before freezing") ||
    section.includes("fidelity") && section.includes("before") && section.includes("freeze");
  assert(
    fidelityBeforeFreeze,
    "Phase 2 section must state fidelity validation occurs BEFORE the freeze"
  );

  // (c) explicitly NOT by the planner in-run
  const notByPlannerInRun =
    section.includes("NOT by the planner") ||
    section.includes("not by the planner") ||
    section.includes("planner does not") ||
    section.includes("planner does NOT") ||
    section.includes("not the planner") ||
    (section.includes("planner") && section.includes("not in-run")) ||
    (section.includes("NOT") && section.includes("planner") && section.includes("in-run"));
  assert(
    notByPlannerInRun,
    "Phase 2 section must explicitly state fidelity validation is NOT done by the planner in-run"
  );
});

// ─── Test 3 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md Phase 2 section.
 * When: the section is extracted.
 * Then:
 *   (a) it states the transcription iteration cap is 2,
 *   (b) it states that on cap exhaustion, transcription escalates to a stronger hand.
 */
test("Phase 2: transcription iteration cap is 2 and on exhaustion escalates to stronger hand", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found in orchestrating-delivery SKILL.md");

  // (a) iteration cap = 2
  const mentionsCap2 =
    section.includes("cap: 2") ||
    section.includes("cap = 2") ||
    section.includes("cap of 2") ||
    section.includes("iteration cap: 2") ||
    section.includes("Iteration cap: 2") ||
    section.includes("cap 2") ||
    (section.includes("cap") && section.includes("2") && section.includes("transcri"));
  assert(
    mentionsCap2,
    "Phase 2 section must state the transcription iteration cap is 2"
  );

  // (b) on exhaustion escalate to stronger hand
  const mentionsEscalateStronger =
    (section.includes("escalate") && section.includes("stronger hand")) ||
    (section.includes("exhaustion") && section.includes("stronger")) ||
    (section.includes("cap exhausted") && section.includes("stronger")) ||
    (section.includes("cap exhaustion") && section.includes("stronger"));
  assert(
    mentionsEscalateStronger,
    "Phase 2 section must state that on cap exhaustion, transcription escalates to a stronger hand"
  );
});

// ─── Test 4 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md Phase 2 section.
 * When: the section is extracted.
 * Then it documents all four MANIFEST freeze invariants:
 *   (a) content-hash MANIFEST freeze (test + fixtures),
 *   (b) executor allowed-write set excludes the frozen manifest AND test-runner config,
 *   (c) gate invokes the frozen test directly by path after verifying every manifest hash,
 *   (d) executor diff touching a manifest file or runner config = automatic gate failure.
 */
test("Phase 2: content-hash MANIFEST freeze; executor allowed-write excludes manifest+runner-config; gate invokes test directly by path; manifest/runner-config touch = automatic gate failure", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found in orchestrating-delivery SKILL.md");

  // (a) content-hash MANIFEST that includes test + fixtures
  const mentionsManifest =
    section.includes("MANIFEST") || section.includes("manifest");
  assert(
    mentionsManifest,
    "Phase 2 section must document a content-hash MANIFEST freeze"
  );

  const mentionsFixtures =
    section.includes("fixture") || section.includes("fixtures") || section.includes("support");
  assert(
    mentionsFixtures,
    "Phase 2 section must state the MANIFEST includes fixtures (support files the test-author created)"
  );

  const mentionsContentHash =
    section.includes("content-hash") ||
    section.includes("content hash") ||
    section.includes("hash");
  assert(
    mentionsContentHash,
    "Phase 2 section must document a content-hash MANIFEST"
  );

  // (b) executor allowed-write set excludes frozen manifest and test-runner config
  const mentionsAllowedWriteSet =
    section.includes("allowed-write") ||
    section.includes("allowed write") ||
    section.includes("allowed_write");
  assert(
    mentionsAllowedWriteSet,
    "Phase 2 section must document the executor allowed-write set"
  );

  const mentionsExcludesManifestAndRunnerConfig =
    (section.includes("manifest") && section.includes("runner config")) ||
    (section.includes("manifest") && section.includes("test-runner config")) ||
    (section.includes("manifest") && section.includes("runner")) ||
    (section.includes("allowed-write") && section.includes("manifest"));
  assert(
    mentionsExcludesManifestAndRunnerConfig,
    "Phase 2 section must state executor allowed-write set excludes frozen manifest and test-runner config"
  );

  // (c) gate invokes frozen test directly by path after verifying every manifest hash
  const mentionsDirectByPath =
    section.includes("directly by path") ||
    section.includes("direct path") ||
    section.includes("by path") ||
    (section.includes("directly") && section.includes("path") && section.includes("test"));
  assert(
    mentionsDirectByPath,
    "Phase 2 section must state gate invokes the frozen test directly by path (not via mutable npm script)"
  );

  const mentionsVerifyManifestHash =
    (section.includes("manifest hash") || section.includes("manifest hashes") || section.includes("every manifest hash")) ||
    (section.includes("hash") && section.includes("manifest") && section.includes("verif"));
  assert(
    mentionsVerifyManifestHash,
    "Phase 2 section must state gate verifies every manifest hash before running the test"
  );

  // (d) executor diff touching manifest or runner config = automatic gate failure
  const mentionsAutoGateFailure =
    section.includes("automatic gate failure") ||
    section.includes("AUTOMATIC gate failure") ||
    section.includes("auto gate failure") ||
    (section.includes("automatic") && section.includes("gate failure"));
  assert(
    mentionsAutoGateFailure,
    "Phase 2 section must state executor diff touching a manifest file or runner config = automatic gate failure"
  );
});

// ─── Test 5 ───────────────────────────────────────────────────────────────────
/**
 * Given: creating-plans SKILL.md with a "Step 3" section (Derive locked_tests from ACs).
 * When: the Step 3 section is extracted.
 * Then:
 *   (a) it states the planner pins the assertion (NOT authors/in-run-validates the test),
 *   (b) a cheap test-author transcribes the assertion,
 *   (c) under compliance fidelity validation,
 *   (d) AND this flow explicitly SUPERSEDES the spec §3.7 'Chosen UX'
 *       planner-validates-in-run description.
 */
test("creating-plans Step 3: planner pins (not authors/in-run-validates); cheap test-author transcribes; compliance fidelity; SUPERSEDES §3.7 planner-validates-in-run", () => {
  const section = extractSection(creatingPlansMd, "Step 3");
  assert(section.length > 0, "Step 3 section not found in creating-plans SKILL.md");

  // (a) planner pins the assertion, does NOT author or in-run-validate the test
  const plannerPins =
    section.includes("planner pins") ||
    section.includes("planner pins the assertion") ||
    section.includes("pins the assertion") ||
    (section.includes("planner") && section.includes("pins"));
  assert(
    plannerPins,
    "creating-plans Step 3 section must state the planner PINS the assertion"
  );

  const plannerNotAuthor =
    section.includes("does NOT author") ||
    section.includes("does not author") ||
    section.includes("planner does NOT") ||
    section.includes("NOT author") ||
    section.includes("not in-run-validate") ||
    (section.includes("planner") && section.includes("not") && section.includes("author"));
  assert(
    plannerNotAuthor,
    "creating-plans Step 3 section must state the planner does NOT author or in-run-validate the test"
  );

  // (b) cheap test-author transcribes
  const testAuthorTranscribes =
    section.includes("test-author") ||
    (section.includes("cheap") && section.includes("transcribe"));
  assert(
    testAuthorTranscribes,
    "creating-plans Step 3 section must state a cheap test-author transcribes the assertion"
  );

  // (c) under compliance fidelity validation
  const complianceFidelity =
    (section.includes("compliance") && section.includes("fidelity")) ||
    section.includes("fidelity validation");
  assert(
    complianceFidelity,
    "creating-plans Step 3 section must state transcription is under compliance fidelity validation"
  );

  // (d) explicitly SUPERSEDES §3.7 planner-validates-in-run
  const supersedes37 =
    section.includes("§3.7") ||
    section.includes("3.7") ||
    section.includes("SUPERSEDES") ||
    section.includes("supersedes");
  assert(
    supersedes37,
    "creating-plans Step 3 section must explicitly state this flow SUPERSEDES §3.7 planner-validates-in-run"
  );
});

// ─── Test 6 ───────────────────────────────────────────────────────────────────
/**
 * Given: compliance.md with a "Fidelity mode (pre-freeze)" section.
 * When: that section is extracted.
 * Then it documents a pre-freeze fidelity mode that:
 *   (a) is triggered BEFORE the executor (no diff, test intentionally RED),
 *   (b) does NOT run the tests,
 *   (c) does NOT require green (redness is correct),
 *   (d) validates the FULL observable fidelity, returning PASS/FAIL on fidelity alone.
 */
test("compliance.md: documents a pre-freeze fidelity mode that does NOT run tests and does NOT require green", () => {
  const section = extractSection(complianceMd, "Fidelity mode");
  assert(section.length > 0, "compliance.md must have a 'Fidelity mode (pre-freeze)' section");

  const sectionLower = section.toLowerCase();

  // (a) triggered before the executor, test intentionally RED, no diff
  const preExecutorRed =
    (sectionLower.includes("before the executor") || sectionLower.includes("before executor")) &&
    sectionLower.includes("red") &&
    (sectionLower.includes("no diff") || sectionLower.includes("without a diff"));
  assert(
    preExecutorRed,
    "Fidelity mode must state it triggers before the executor with no diff and an intentionally RED test"
  );

  // (b) does NOT run the tests
  const doesNotRun =
    (sectionLower.includes("do not run") || sectionLower.includes("not run")) &&
    (sectionLower.includes("npm test") || sectionLower.includes("node --test") || sectionLower.includes("gate"));
  assert(
    doesNotRun,
    "Fidelity mode must state it does NOT run the tests"
  );

  // (c) does NOT require green
  const noGreen =
    (sectionLower.includes("require green") || sectionLower.includes("not require green")) ||
    (sectionLower.includes("redness") && sectionLower.includes("correct"));
  assert(
    noGreen,
    "Fidelity mode must state redness is correct / it does NOT require green"
  );

  // (d) validates the FULL observable, PASS/FAIL on fidelity alone
  const fullObservable =
    sectionLower.includes("full observable") &&
    (sectionLower.includes("fidelity alone") || sectionLower.includes("on fidelity"));
  assert(
    fullObservable,
    "Fidelity mode must validate the FULL observable and return PASS/FAIL on fidelity alone"
  );
});

// ─── Test 7 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md Phase 2 section (§1c freeze).
 * When: the Phase 2 section is extracted.
 * Then §1c defines the manifest as the frozen test's DEPENDENCY CLOSURE
 *   (a) explicitly NOT by provenance / not just test-author-created files,
 *   (b) transitively resolving fixtures/data/helpers the test imports/reads,
 *   (c) regardless of who created the file,
 *   AND enumerates the runner-config exclusion set:
 *   (d) the package.json framework KEYS (setupFiles/setupFilesAfterEnv/moduleNameMapper/globalSetup),
 *   (e) tsconfig paths/compilerOptions, .npmrc, babel config, and --import/--require/NODE_OPTIONS loaders.
 */
test("orchestrating §1c: manifest = test dependency closure (not provenance) + explicit runner-config exclusion set", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(section.length > 0, "Phase 2 section not found in orchestrating-delivery SKILL.md");

  const sectionLower = section.toLowerCase();

  // (a) dependency closure, NOT by provenance
  const dependencyClosure = sectionLower.includes("dependency closure");
  assert(
    dependencyClosure,
    "§1c must define the manifest as the frozen test's dependency closure"
  );
  const notProvenance =
    sectionLower.includes("not by provenance") ||
    sectionLower.includes("regardless of who created") ||
    sectionLower.includes("not the criterion");
  assert(
    notProvenance,
    "§1c must state the manifest is NOT defined by provenance (not just test-author-created files)"
  );

  // (b) transitively resolves fixtures/data/helpers the test imports/reads
  const transitive =
    sectionLower.includes("transitive") &&
    (sectionLower.includes("import") || sectionLower.includes("require") || sectionLower.includes("reads")) &&
    (sectionLower.includes("fixture") || sectionLower.includes("helper") || sectionLower.includes("data file"));
  assert(
    transitive,
    "§1c must state the closure transitively resolves fixtures/data/helpers the test imports/requires/reads"
  );

  // (c) regardless of who created the file
  const regardlessCreator = sectionLower.includes("regardless of who created");
  assert(
    regardlessCreator,
    "§1c must state the closure holds regardless of who created the file"
  );

  // (d) package.json framework KEYS enumerated
  const frameworkKeys =
    sectionLower.includes("setupfiles") &&
    sectionLower.includes("modulenamemapper") &&
    sectionLower.includes("globalsetup") &&
    (sectionLower.includes("setupfilesafterenv") || sectionLower.includes("setupfilesaftereach"));
  assert(
    frameworkKeys,
    "§1c must enumerate the package.json framework config KEYS (setupFiles/setupFilesAfterEnv/moduleNameMapper/globalSetup)"
  );

  // (e) tsconfig/.npmrc/babel + loader vectors enumerated
  const tsconfigEtc =
    sectionLower.includes("tsconfig") &&
    sectionLower.includes(".npmrc") &&
    sectionLower.includes("babel");
  assert(
    tsconfigEtc,
    "§1c must enumerate tsconfig paths/compilerOptions, .npmrc, and babel config in the exclusion set"
  );
  const loaderVectors =
    sectionLower.includes("--import") &&
    sectionLower.includes("--require") &&
    sectionLower.includes("node_options");
  assert(
    loaderVectors,
    "§1c must enumerate the --import/--require/NODE_OPTIONS loader vectors in the exclusion set"
  );
});

// ─── Test 8 ───────────────────────────────────────────────────────────────────
/**
 * Given: test-author.md scope contract.
 * When: the document is read.
 * Then it PERMITS writing the fixture/support files ENUMERATED by the locked_test
 *   (so they can be captured in the freeze manifest), while still banning
 *   arbitrary auxiliary files and production code.
 */
test("test-author.md: permits writing fixtures ENUMERATED by the locked_test (still bans arbitrary files + production code)", () => {
  const docLower = testAuthorMd.toLowerCase();

  // (a) permits fixtures enumerated by the locked_test
  const permitsEnumeratedFixtures =
    (docLower.includes("fixture") || docLower.includes("suporte")) &&
    docLower.includes("locked_test") &&
    (docLower.includes("enumera") || docLower.includes("enumerad") || docLower.includes("enumerate"));
  assert(
    permitsEnumeratedFixtures,
    "test-author.md must permit writing the fixtures ENUMERATED by the locked_test"
  );

  // (b) still bans arbitrary auxiliary files
  const bansArbitrary =
    (docLower.includes("auxiliar") || docLower.includes("auxiliary")) &&
    (docLower.includes("não") || docLower.includes("nao") || docLower.includes("proibido"));
  assert(
    bansArbitrary,
    "test-author.md must still ban arbitrary auxiliary files not enumerated by the locked_test"
  );

  // (c) still bans production code
  const bansProduction =
    (docLower.includes("código de produção") || docLower.includes("codigo de producao")) &&
    docLower.includes("proibido");
  assert(
    bansProduction,
    "test-author.md must still ban writing production code"
  );
});

// ─── Test 9 ───────────────────────────────────────────────────────────────────
/**
 * Given: orchestrating-delivery SKILL.md Phase 2 section (§4 gates).
 * When: the Phase 2 section is extracted.
 * Then:
 *   (a) the gate is stated to be a Stop hook,
 *   (b) the Stop hook runs the frozen test directly by path and blocks the hand until green,
 *   (c) the orchestrator reverts out-of-scope working-tree writes via the stash mechanism
 *       (git restore for tracked + git stash push --include-untracked + git stash drop for
 *       untracked), NOT git clean, after the hand finishes.
 */
test("Phase 2 §4: gate is a Stop hook that blocks the hand until green; orchestrator reverts out-of-scope writes via the stash mechanism (git restore + git stash, not git clean)", () => {
  const section = extractSection(orchestratingMd, "Phase 2");
  assert(
    section.length > 0,
    "Phase 2 section not found in orchestrating-delivery SKILL.md"
  );

  const sectionLower = section.toLowerCase();

  // (a) gate is a Stop hook
  assert(
    section.includes("Stop hook") || section.includes("stop hook"),
    "Phase 2 §4 must state the gate is a Stop hook"
  );

  // (b) blocks the hand until the frozen test is green
  const blocksHandUntilGreen =
    sectionLower.includes("blocks the hand") ||
    (sectionLower.includes("block") &&
      sectionLower.includes("hand") &&
      sectionLower.includes("green"));
  assert(
    blocksHandUntilGreen,
    "Phase 2 §4 must state the Stop hook blocks the hand until the frozen test is green"
  );

  // (c) orchestrator reverts out-of-scope writes via the stash mechanism (NOT git clean)
  const revertsViaStash =
    sectionLower.includes("revert") &&
    sectionLower.includes("git restore") &&
    sectionLower.includes("git stash");
  assert(
    revertsViaStash,
    "Phase 2 §4 must state the orchestrator reverts out-of-scope working-tree writes via the stash mechanism (git restore + git stash)"
  );

  // and must NOT retain the old "via git checkout/git clean" revert prescription
  assert(
    !sectionLower.includes("via `git checkout`/`git clean`"),
    "Phase 2 §4 must NOT prescribe the old git checkout/git clean revert (git clean -f* is denied by the baseline)"
  );
});
