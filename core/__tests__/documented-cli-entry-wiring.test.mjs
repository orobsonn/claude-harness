/**
 * @description Verifies the documented-CLI entry-block wiring across compliance.md and
 * code-quality.md. Tests that:
 * 1. compliance.md places the `process.argv[1]` / `import.meta.url` entry-block check in the
 *    POST-IMPL section, never in the dead pre-freeze mode.
 * 2. compliance.md names the doc-driven trigger (a documented `node <path>.mjs` invocation).
 * 3. compliance.md states the import-only exception (a module never documented as a CLI is not
 *    flagged for lacking an entry block).
 * 4. compliance.md gives a FAIL directive when the entry block is absent/missing.
 * 5. code-quality.md carries the runnable-doc-to-entry-block authoring convention.
 * 6. code-quality.md prohibits documenting an import-only module as a bash CLI and requires the
 *    import-and-call form instead.
 */

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @description Slices `content` from `startHeading` up to the next heading matched by
 * `endHeadingRegex` (or to the end of the string if there is no further heading).
 * @param {string} content
 * @param {string} startHeading
 * @param {RegExp} endHeadingRegex
 * @returns {string}
 */
function sliceSection(content, startHeading, endHeadingRegex) {
  const startIdx = content.indexOf(startHeading);
  if (startIdx === -1) return "";
  const sliceStart = startIdx + startHeading.length;
  const rest = content.slice(sliceStart);
  const endMatch = endHeadingRegex.exec(rest);
  const sliceEnd = endMatch ? endMatch.index : rest.length;
  return rest.slice(0, sliceEnd);
}

const complianceContent = readFileSync(resolve(__dirname, "../agents/compliance.md"), "utf8");
const codeQualityContent = readFileSync(resolve(__dirname, "../rules/code-quality.md"), "utf8");

const POST_IMPL_HEADING = "## How to validate (post-impl green mode)";
const PRE_FREEZE_HEADING = "## Fidelity mode (pre-freeze)";
const NEXT_HEADING_RE = /\n## /;

test("compliance.md places the entry-block check (process.argv[1] + import.meta.url) in the post-impl section, not pre-freeze", () => {
  const postImplSection = sliceSection(complianceContent, POST_IMPL_HEADING, NEXT_HEADING_RE);
  const preFreezeSection = sliceSection(complianceContent, PRE_FREEZE_HEADING, NEXT_HEADING_RE);

  assert(
    postImplSection.includes("process.argv[1]"),
    "post-impl section must reference 'process.argv[1]' as part of the entry-block check"
  );
  assert(
    postImplSection.includes("import.meta.url"),
    "post-impl section must reference 'import.meta.url' as part of the entry-block check"
  );
  assert(
    !preFreezeSection.includes("process.argv[1]"),
    "pre-freeze section must NOT contain 'process.argv[1]' — the entry-block check must not land in the dead pre-freeze mode"
  );
  assert(
    !preFreezeSection.includes("import.meta.url"),
    "pre-freeze section must NOT contain 'import.meta.url' — the entry-block check must not land in the dead pre-freeze mode"
  );
});

test("compliance.md names the doc-driven trigger — a documented 'node <path>.mjs' invocation — in the post-impl section", () => {
  const postImplSection = sliceSection(complianceContent, POST_IMPL_HEADING, NEXT_HEADING_RE);

  const nodeMjsInvocation = /node\s+[^\n`]*\.mjs/;
  assert(
    nodeMjsInvocation.test(postImplSection),
    "post-impl section must reference a documented 'node <path>.mjs' invocation as the activating condition"
  );
  assert(
    postImplSection.includes("SKILL.md") ||
      postImplSection.includes("CI comment") ||
      postImplSection.includes("comment"),
    "post-impl section must name the doc source (SKILL.md or a CI comment) that carries the invocation"
  );
});

test("compliance.md states the import-only exception in the post-impl section", () => {
  const postImplSection = sliceSection(complianceContent, POST_IMPL_HEADING, NEXT_HEADING_RE);

  const noNodeMjsReference = /no\s+node\s+[^\n`]*\.mjs\s+reference/i;
  assert(
    postImplSection.includes("import-only") ||
      postImplSection.includes("not flagged") ||
      postImplSection.includes("never module-driven") ||
      noNodeMjsReference.test(postImplSection),
    "post-impl section must state the import-only exception: a module never documented as a CLI is not flagged for lacking an entry block"
  );
});

test("compliance.md gives a FAIL directive when the entry block is absent/missing", () => {
  const postImplSection = sliceSection(complianceContent, POST_IMPL_HEADING, NEXT_HEADING_RE);

  const failTiedToAbsentBlock =
    /(entry block|import\.meta\.url)[\s\S]{0,400}(absent|missing)[\s\S]{0,160}(FAIL|fail the check)/i.test(
      postImplSection
    ) ||
    /(FAIL|fail the check)[\s\S]{0,240}(absent|missing)[\s\S]{0,400}(entry block|import\.meta\.url)/i.test(
      postImplSection
    );
  assert(
    failTiedToAbsentBlock,
    "post-impl section must direct a FAIL specifically when the documented module's entry block is absent/missing — the FAIL directive must sit in proximity to the entry-block phrasing, not just appear somewhere in the section"
  );
});

test("code-quality.md carries the runnable-doc-to-entry-block authoring convention", () => {
  const nodeMjsInvocation = /node\s+[^\n`]*\.mjs/;
  assert(
    nodeMjsInvocation.test(codeQualityContent),
    "code-quality.md must reference a 'node <module>.mjs' style invocation"
  );
  assert(
    codeQualityContent.includes("entry block") ||
      codeQualityContent.includes("import.meta.url") ||
      codeQualityContent.includes("process.argv"),
    "code-quality.md must require an entry block (import.meta.url / process.argv) when a module is documented as a runnable CLI"
  );
});

test("code-quality.md prohibits documenting an import-only module as a bash CLI and requires import-and-call", () => {
  const hasImportAndCallConvention =
    codeQualityContent.includes("import-and-call") ||
    (codeQualityContent.includes("import") &&
      codeQualityContent.includes("call") &&
      codeQualityContent.includes("fn()"));
  assert(
    hasImportAndCallConvention,
    "code-quality.md must require the import-and-call form for an import-only module's usage example"
  );

  const hasImportOnlyProhibition =
    codeQualityContent.includes("import-only") ||
    codeQualityContent.includes("import and call") ||
    (codeQualityContent.includes("never") && codeQualityContent.includes("node"));
  assert(
    hasImportOnlyProhibition,
    "code-quality.md must prohibit documenting an import-only module (no entry block) as a bash 'node <module>.mjs' CLI"
  );
});
