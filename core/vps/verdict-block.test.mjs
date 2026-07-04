/**
 * @description Contract tests for verdict-block.mjs — the machine-readable CLEAN/BLOCKED
 * block embedded in PR bodies so a headless Cron B can decide "safe to merge?" without
 * re-deriving delivery state from free prose. Covers: round-trip format/parse, immunity to
 * stray prose outside the delimiters, fail-closed behavior on malformed blocks, derivation
 * from a final-review state object, and the shipper's downgrade-only delivery-time re-check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatVerdictBlock,
  parseVerdictBlock,
  downgradeVerdictForDelivery,
} from "./verdict-block.mjs";

test("round-trip: CLEAN and BLOCKED verdicts survive format -> parse unchanged", () => {
  const cleanBlock = formatVerdictBlock({ status: "CLEAN" });
  assert.deepEqual(
    parseVerdictBlock(cleanBlock),
    { status: "CLEAN" },
    "a CLEAN verdict must round-trip through formatVerdictBlock -> parseVerdictBlock as CLEAN with no finding"
  );

  const blockedBlock = formatVerdictBlock({ status: "BLOCKED", finding: "gate X failed" });
  assert.deepEqual(
    parseVerdictBlock(blockedBlock),
    { status: "BLOCKED", finding: "gate X failed" },
    "a BLOCKED verdict with a finding must round-trip with the finding text preserved verbatim"
  );
});

test("stray-prose immunity: free prose containing the word CLEAN outside the delimiters must not override a delimited BLOCKED status", () => {
  const blockedBlock = formatVerdictBlock({ status: "BLOCKED", finding: "gate X failed" });
  const prBody = [
    "## Summary",
    "Everything here reads CLEAN to a human skimming it — totally CLEAN, no worries, CLEAN CLEAN CLEAN.",
    "",
    blockedBlock,
    "",
    "More narrative that also says CLEAN after the block.",
  ].join("\n");

  const result = parseVerdictBlock(prBody);
  assert.equal(
    result.status,
    "BLOCKED",
    "only the delimited block is trusted — stray occurrences of the word CLEAN in surrounding prose must never leak into the parsed status"
  );
});

test("fail-closed on malformed blocks: missing close tag, missing status token, and finding-substring-CLEAN must never parse as CLEAN", () => {
  // (a) OPEN delimiter present but no matching CLOSE delimiter anywhere after it.
  const unclosed = "Some PR body.\n<!--harness:verdict-->\nstatus: CLEAN\n(no close tag follows)";
  assert.notEqual(
    parseVerdictBlock(unclosed).status,
    "CLEAN",
    "an open delimiter with no matching close delimiter is malformed and must fail closed (never CLEAN)"
  );

  // (b) Fully delimited block whose body carries no valid status token.
  const noStatusToken = [
    "<!--harness:verdict-->",
    "this block has no recognizable status field at all",
    "<!--/harness:verdict-->",
  ].join("\n");
  assert.notEqual(
    parseVerdictBlock(noStatusToken).status,
    "CLEAN",
    "a well-formed but tokenless block must fail closed (never CLEAN)"
  );

  // (c) Well-formed block: status field is BLOCKED, but the finding text itself contains the
  // substring 'CLEAN' — status must be read from the strict status field, never a substring scan.
  const findingMentionsClean = formatVerdictBlock({
    status: "BLOCKED",
    finding: "gate not CLEAN yet",
  });
  assert.equal(
    parseVerdictBlock(findingMentionsClean).status,
    "BLOCKED",
    "status must come from the strict status field — a finding string that merely contains the substring CLEAN must not flip the status"
  );
});

test("derivation from final-review state: any of UNSAFE security / open-risk / orphan freeze-commit / unresolved blocking adversary finding forces BLOCKED; the all-clear state yields CLEAN", () => {
  const unsafeSecurity = {
    securityVerdict: "UNSAFE",
    openRisk: false,
    orphanFreezeCommit: false,
    unresolvedBlockingAdversaryFinding: false,
  };
  assert.equal(
    parseVerdictBlock(formatVerdictBlock(unsafeSecurity)).status,
    "BLOCKED",
    "a security verdict of UNSAFE must derive to BLOCKED regardless of the other fields"
  );

  const openRisk = {
    securityVerdict: "SECURE",
    openRisk: true,
    orphanFreezeCommit: false,
    unresolvedBlockingAdversaryFinding: false,
  };
  assert.equal(
    parseVerdictBlock(formatVerdictBlock(openRisk)).status,
    "BLOCKED",
    "an open-risk marker must derive to BLOCKED even when security is SECURE"
  );

  const orphanFreeze = {
    securityVerdict: "SECURE",
    openRisk: false,
    orphanFreezeCommit: true,
    unresolvedBlockingAdversaryFinding: false,
  };
  assert.equal(
    parseVerdictBlock(formatVerdictBlock(orphanFreeze)).status,
    "BLOCKED",
    "an orphan freeze-commit must derive to BLOCKED even when security is SECURE"
  );

  const allClear = {
    securityVerdict: "SECURE",
    openRisk: false,
    orphanFreezeCommit: false,
    unresolvedBlockingAdversaryFinding: false,
  };
  assert.equal(
    parseVerdictBlock(formatVerdictBlock(allClear)).status,
    "CLEAN",
    "SECURE security + no open-risk + no orphan freeze-commit + no unresolved blocking adversary finding must derive to CLEAN"
  );
});

test("shipper delivery downgrade is downgrade-only: CLEAN + real delivery risk becomes BLOCKED; BLOCKED, or CLEAN with no risk, is returned unchanged", () => {
  const cleanBlock = formatVerdictBlock({ status: "CLEAN" });
  const riskSignal = { hasRisk: true, finding: "orphan freeze-commit detected for task-3" };

  const downgraded = downgradeVerdictForDelivery(cleanBlock, riskSignal);
  const parsedDowngraded = parseVerdictBlock(downgraded);
  assert.equal(
    parsedDowngraded.status,
    "BLOCKED",
    "a CLEAN block plus a real delivery-time risk signal must be re-emitted as BLOCKED so Cron B never merges it"
  );
  assert.equal(
    parsedDowngraded.finding,
    riskSignal.finding,
    "the downgraded block must name the delivery-time finding that caused the downgrade"
  );

  const blockedBlock = formatVerdictBlock({ status: "BLOCKED", finding: "gate X failed" });
  const unchangedFromBlocked = downgradeVerdictForDelivery(blockedBlock, riskSignal);
  assert.equal(
    unchangedFromBlocked,
    blockedBlock,
    "an already-BLOCKED block must never be upgraded — same risk signal must return it unchanged"
  );

  const noRiskSignal = { hasRisk: false };
  const unchangedFromClean = downgradeVerdictForDelivery(cleanBlock, noRiskSignal);
  assert.equal(
    unchangedFromClean,
    cleanBlock,
    "a CLEAN block with no real delivery-time risk must be returned unchanged — never fabricate a downgrade"
  );
});
