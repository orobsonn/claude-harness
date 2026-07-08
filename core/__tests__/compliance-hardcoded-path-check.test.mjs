#!/usr/bin/env node
/**
 * @description Transcribed assertions for the planner-pinned hardcoded-path
 * check that must live inside the "## Fidelity mode (pre-freeze)" window of
 * core/agents/compliance.md. All three assertions read the SAME window
 * (header to the first line matching /^## /m) and check for check content,
 * fs-access hazard anchors, and stated carve-outs. Expected RED until the
 * check prose is added to compliance.md.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const complianceMdPath = resolve(__dirname, "../agents/compliance.md");

/**
 * Returns the substring of `content` starting at the line CONTAINING
 * `headerLine`, up to (but excluding) the next line matching
 * `nextHeaderRegex`. Terminates at the first match, including a false
 * header inside a fenced code block — this is intentional: the real check
 * content for this section lives in the prose BEFORE that fence.
 */
function sectionWindow(content, headerLine, nextHeaderRegex = /^## /m) {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((line) => line.includes(headerLine));
  if (startIdx === -1) {
    throw new Error(`Header not found: ${headerLine}`);
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (nextHeaderRegex.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

const complianceMd = readFileSync(complianceMdPath, "utf8");
const fidelityWindow = sectionWindow(complianceMd, "## Fidelity mode (pre-freeze)");

/**
 * Test 1: Given compliance.md's "## Fidelity mode (pre-freeze)" window, when
 * inspected, it must state a hardcoded-path check that flags a `/Users/` or
 * `/home/` absolute-path literal in a new/edited test file, tagged as a
 * blocking/high-severity problem.
 */
test("compliance.md fidelity window: hardcoded-path check present and tagged blocking/high", () => {
  assert.ok(
    fidelityWindow.includes("/Users/"),
    "fidelity window must name the /Users/ absolute-path literal"
  );
  assert.ok(
    fidelityWindow.includes("/home/"),
    "fidelity window must name the /home/ absolute-path literal"
  );
  assert.ok(
    /blocking/i.test(fidelityWindow),
    "fidelity window must mark the check as blocking (case-insensitive 'blocking')"
  );
  assert.ok(
    /high/i.test(fidelityWindow),
    "fidelity window must mark the check as high severity (case-insensitive 'high')"
  );
  assert.ok(
    /test file/i.test(fidelityWindow),
    "fidelity window must indicate the check applies to a test file (case-insensitive 'test file')"
  );
});

/**
 * Test 2: Given the same fidelity window, when inspected, the hazard must be
 * scoped to a filesystem-access POSITION, not treated categorically — it
 * must name at least two of the fs-access anchors that indicate the literal
 * sits in an actual file-read position.
 */
test("compliance.md fidelity window: hazard scoped to a filesystem-access position", () => {
  const anchors = ["readFileSync", "resolve", "import", "fileURLToPath"];
  const present = anchors.filter((anchor) => fidelityWindow.includes(anchor));
  assert.ok(
    present.length >= 2,
    `fidelity window must name at least two fs-access anchors from [${anchors.join(", ")}]; found: [${present.join(", ")}]`
  );
});

/**
 * Test 3: Given the same fidelity window, when inspected, it must state the
 * three carve-outs that are explicitly NOT the hazard: a synthetic fixture,
 * a comment, and a content.includes search needle.
 */
test("compliance.md fidelity window: three carve-outs stated as NOT the hazard", () => {
  assert.ok(
    /synthetic fixture/i.test(fidelityWindow),
    "fidelity window must carve out 'synthetic fixture' (case-insensitive)"
  );
  assert.ok(
    /comment/i.test(fidelityWindow),
    "fidelity window must carve out 'comment' (case-insensitive)"
  );
  assert.ok(
    fidelityWindow.includes("content.includes"),
    "fidelity window must carve out the exact token 'content.includes'"
  );
});
