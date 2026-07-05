import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const cloudRoutinesPath = new URL("../../docs/cloud-routines.md", import.meta.url);
const usagePath = new URL("../../docs/usage.md", import.meta.url);

/**
 * @description Reads a doc file as text, failing with a clear message if it's missing.
 * @param {URL} fileUrl
 * @returns {string}
 */
function readDoc(fileUrl) {
  try {
    return readFileSync(fileUrl, "utf-8");
  } catch (error) {
    throw new Error(`expected doc to exist at ${fileUrl}: ${error.message}`);
  }
}

/**
 * @description Given the combined text of cloud-routines.md and usage.md, when searching
 * for the review-phase kill switch, then it must document the env var
 * HARNESS_REVIEW_ENABLED and the review cadence (every 6h) distinct from Cron A (every 4h).
 */
test("docs document the HARNESS_REVIEW_ENABLED kill switch and the 0 */6 review cadence", () => {
  const combined = `${readDoc(cloudRoutinesPath)}\n${readDoc(usagePath)}`;

  assert.match(
    combined,
    /HARNESS_REVIEW_ENABLED/,
    "expected docs to mention the kill-switch env var HARNESS_REVIEW_ENABLED"
  );
  assert.match(
    combined,
    /0 \*\/6/,
    'expected docs to mention the review cadence "0 */6" (vs Cron A "0 */4")'
  );
});

/**
 * @description Given the combined text of cloud-routines.md and usage.md, when the second
 * model family is absent, then the docs must document the fail-closed behavior: the review
 * phase leaves the PR in "awaiting-merge" instead of silently proceeding.
 */
test("docs document the fail-closed awaiting-merge behavior when the second model family is absent", () => {
  const combined = `${readDoc(cloudRoutinesPath)}\n${readDoc(usagePath)}`;

  assert.match(
    combined,
    /awaiting-merge/i,
    'expected docs to mention the "awaiting-merge" PR state'
  );
  assert.match(
    combined,
    /fail-closed|second family|cross-family/i,
    "expected docs to explain the fail-closed behavior tied to the absence of the second model family"
  );
});
