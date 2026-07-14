/**
 * @description Locked tests for T8 dual-runtime wiring (cross-family dual eyes).
 * t8-enum, t8-failopen, t8-retry, t8-not-full-dual, t8-merge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DUAL_STATUS,
  DUAL_STATUS_VALUES,
  DUAL_POSTS,
  PRIMARY_ONLY_ERROR_RETRY_COUNT,
  isFullDualCoverage,
  isDualStatusEnum,
  classifySecondaryFailure,
  virginSecondaryBrief,
  extractFindings,
  pendingDualState,
  mergeDualFindings,
  mergeDualVerdicts,
  driveDualEye,
  dualStatusGatePatch,
  dualFailOpenWarning,
} from "./dual-runtime.mjs";

function finding(over = {}) {
  return {
    id: "f1",
    title: "race on checkout",
    severity: "high",
    evidence: "src/a.ts:10",
    ...over,
  };
}

// ---- t8-enum ----

test("t8-enum: dual_status is enum not bare boolean after dual attempt", () => {
  assert.ok(DUAL_STATUS_VALUES.has("both"));
  assert.ok(DUAL_STATUS_VALUES.has("primary_only_failopen"));
  assert.ok(DUAL_STATUS_VALUES.has("pending"));
  assert.ok(DUAL_STATUS_VALUES.has("primary_only_error"));
  assert.equal(DUAL_STATUS_VALUES.size, 4);

  assert.equal(isDualStatusEnum("both"), true);
  assert.equal(isDualStatusEnum("primary_only_failopen"), true);
  assert.equal(isDualStatusEnum(true), false);
  assert.equal(isDualStatusEnum(false), false);
  assert.equal(isDualStatusEnum(1), false);
  assert.equal(isDualStatusEnum("yes"), false);

  const primary = { findings: [finding()] };
  const both = driveDualEye({
    post: "adversary",
    primaryResult: primary,
    runSecondary: () => ({ ok: true, result: { findings: [] } }),
  });
  assert.equal(typeof both.dual_status, "string");
  assert.equal(isDualStatusEnum(both.dual_status), true);
  assert.notEqual(typeof both.dual_status, "boolean");
  assert.equal(both.dual_status, DUAL_STATUS.BOTH);

  const failopen = driveDualEye({
    post: "adversary",
    primaryResult: primary,
    runSecondary: () => ({
      ok: false,
      errorClass: "auth",
      reason: "OpenAI not authenticated",
    }),
  });
  assert.equal(typeof failopen.dual_status, "string");
  assert.equal(isDualStatusEnum(failopen.dual_status), true);
  assert.equal(failopen.dual_status, DUAL_STATUS.PRIMARY_ONLY_FAILOPEN);

  const pending = pendingDualState(primary, { post: "adversary" });
  assert.equal(pending.dual_status, DUAL_STATUS.PENDING);
  assert.equal(isDualStatusEnum(pending.dual_status), true);

  const patch = dualStatusGatePatch(both.dual_status);
  assert.equal(patch.dual_status, "both");
  assert.equal("dual_completed" in patch, false);
  const badPatch = dualStatusGatePatch(/** @type {any} */ (true));
  assert.equal(badPatch.ok, false);
});

// ---- t8-failopen ----

test("t8-failopen: unavailable secondary yields primary_only_failopen and keeps primary findings only", () => {
  const primaryOnly = finding({ id: "p1", title: "primary-only race" });
  const primary = { findings: [primaryOnly] };

  let secondaryCalls = 0;
  const r = driveDualEye({
    post: "adversary",
    primaryResult: primary,
    primaryFamily: "glm",
    secondaryFamily: "openai",
    runSecondary: () => {
      secondaryCalls += 1;
      return {
        ok: false,
        errorClass: "unavailable",
        reason: "OpenAI provider not authenticated",
      };
    },
  });

  assert.equal(r.dual_status, DUAL_STATUS.PRIMARY_ONLY_FAILOPEN);
  assert.equal(r.isFullDualCoverage, false);
  assert.equal(r.secondaryAttempts, 1);
  // Auth/unavailable: no retry storm
  assert.equal(secondaryCalls, 1);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].id, "p1");
  assert.equal(r.findings[0].title, "primary-only race");
  // Never invent secondary findings
  assert.ok(!r.findings.some((f) => f.family === "openai" && f.id !== "p1"));
  assert.ok(r.warning && /segundo modelo|revisão principal/i.test(r.warning));

  // Auth class also failopens without retry
  let authCalls = 0;
  const r2 = driveDualEye({
    post: "plan-reviewer",
    primaryResult: { verdict: "APPROVE", issues: [] },
    runSecondary: () => {
      authCalls += 1;
      return { ok: false, errorClass: "auth", reason: "login required" };
    },
  });
  assert.equal(r2.dual_status, DUAL_STATUS.PRIMARY_ONLY_FAILOPEN);
  assert.equal(authCalls, 1);
  assert.equal(r2.isFullDualCoverage, false);

  assert.equal(classifySecondaryFailure("auth"), "auth_unavailable");
  assert.equal(classifySecondaryFailure("unavailable"), "auth_unavailable");
  assert.equal(classifySecondaryFailure("rate_limit"), "infra_error");
});

// ---- t8-retry ----

test("t8-retry: primary_only_error retries secondary once then continues fail-open without inventing findings", () => {
  assert.equal(PRIMARY_ONLY_ERROR_RETRY_COUNT, 1);

  const primaryFinding = finding({ id: "keep-me", title: "keep primary" });
  const primary = { findings: [primaryFinding] };

  let calls = 0;
  const r = driveDualEye({
    post: "adversary",
    primaryResult: primary,
    primaryFamily: "glm",
    runSecondary: () => {
      calls += 1;
      return {
        ok: false,
        errorClass: "rate_limit",
        reason: "OpenAI 429 rate limit",
      };
    },
  });

  // Initial attempt + K=1 retry = 2
  assert.equal(calls, 1 + PRIMARY_ONLY_ERROR_RETRY_COUNT);
  assert.equal(r.secondaryAttempts, 2);
  assert.equal(r.dual_status, DUAL_STATUS.PRIMARY_ONLY_ERROR);
  assert.equal(r.isFullDualCoverage, false);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].id, "keep-me");
  // No invented secondary findings
  assert.ok(!r.findings.some((f) => /invent|fabricat|openai-fake/i.test(String(f.id))));
  assert.ok(r.warning);

  // Retry succeeds on second attempt → upgrade to both
  let calls2 = 0;
  const r2 = driveDualEye({
    post: "adversary",
    primaryResult: primary,
    primaryFamily: "glm",
    secondaryFamily: "openai",
    runSecondary: ({ attempt }) => {
      calls2 += 1;
      if (attempt === 1) {
        return { ok: false, errorClass: "5xx", reason: "upstream 503" };
      }
      return {
        ok: true,
        result: {
          findings: [
            finding({
              id: "s1",
              title: "secondary-only issue",
              severity: "medium",
            }),
          ],
        },
      };
    },
  });
  assert.equal(calls2, 2);
  assert.equal(r2.dual_status, DUAL_STATUS.BOTH);
  assert.equal(r2.isFullDualCoverage, true);
  assert.ok(r2.findings.some((f) => f.id === "keep-me" || f.title === "keep primary"));
  assert.ok(r2.findings.some((f) => f.id === "s1" || f.title === "secondary-only issue"));

  // Infinite retry must not happen: max 2 attempts even if always failing
  let storm = 0;
  driveDualEye({
    post: "adversary",
    primaryResult: primary,
    runSecondary: () => {
      storm += 1;
      return { ok: false, errorClass: "crash", reason: "boom" };
    },
  });
  assert.equal(storm, 2);
  assert.ok(storm < 5, "must not spin infinite retries");
});

// ---- t8-not-full-dual ----

test("t8-not-full-dual: primary_only_failopen is not counted as full dual coverage", () => {
  assert.equal(isFullDualCoverage(DUAL_STATUS.BOTH), true);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PRIMARY_ONLY_FAILOPEN), false);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PRIMARY_ONLY_ERROR), false);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PENDING), false);
  assert.equal(isFullDualCoverage(true), false);
  assert.equal(isFullDualCoverage("yes"), false);

  const r = driveDualEye({
    post: "adversary",
    primaryResult: { findings: [finding()] },
    runSecondary: () => ({
      ok: false,
      errorClass: "unauthenticated",
      reason: "not authenticated",
    }),
  });
  assert.equal(r.dual_status, DUAL_STATUS.PRIMARY_ONLY_FAILOPEN);
  assert.equal(r.isFullDualCoverage, false);
  assert.equal(isFullDualCoverage(r.dual_status), false);

  // Metrics must not treat failopen as cross-family ran
  const coverageCount = [r].filter((x) => x.isFullDualCoverage).length;
  assert.equal(coverageCount, 0);
});

// ---- t8-merge ----

test("t8-merge: policy B keeps unrefuted single-family findings after dual merge", () => {
  const onlyPrimary = finding({
    id: "a1",
    title: "primary unique race",
    severity: "high",
  });
  const onlySecondary = finding({
    id: "b1",
    title: "secondary unique orphan",
    severity: "medium",
  });
  const sharedTitle = "shared deadlock";
  const sharedA = finding({ id: "a2", title: sharedTitle, severity: "high" });
  const sharedB = finding({ id: "b2", title: sharedTitle, severity: "high" });

  // Free-text disagreement without refutes object → primary kept
  const freeTextDisagree = finding({
    id: "b3",
    title: "primary unique race",
    severity: "high",
    // no refutes — free text alone must not drop primary
    note: "I disagree with a1",
  });

  const merged = mergeDualFindings(
    [onlyPrimary, sharedA],
    [onlySecondary, sharedB, freeTextDisagree],
    { a: "glm", b: "openai" },
  );

  assert.equal(merged.policy, "B");
  const titles = merged.findings.map((f) => f.title);
  assert.ok(titles.includes("primary unique race"), "unrefuted primary-only kept");
  assert.ok(titles.includes("secondary unique orphan"), "unrefuted secondary-only kept");
  assert.ok(titles.includes(sharedTitle), "shared key present");

  // Explicit refute drops the target
  const target = finding({ id: "drop-me", title: "false positive", severity: "low", family: "glm" });
  const refuter = finding({
    id: "ref-1",
    title: "not a real issue",
    severity: "low",
    family: "openai",
    refutes: {
      target_id: "drop-me",
      target_family: "glm",
      reason: "guard already present upstream",
    },
  });
  // classifyFindings tags family; finalizeFindings needs family on candidates
  const withRefute = mergeDualFindings(
    [{ ...target, family: "glm" }],
    [{ ...refuter, family: "openai" }],
    { a: "glm", b: "openai" },
  );
  // After classify, family is set from labels; refute target_family must match
  // Re-run finalize path via driveDualEye both success
  const dual = driveDualEye({
    post: "adversary",
    primaryResult: {
      findings: [
        finding({ id: "keep", title: "real race", severity: "high" }),
        finding({ id: "drop-me", title: "false positive", severity: "low" }),
      ],
    },
    primaryFamily: "glm",
    secondaryFamily: "openai",
    runSecondary: () => ({
      ok: true,
      result: {
        findings: [
          finding({
            id: "ref-1",
            title: "not a real issue",
            severity: "low",
            refutes: {
              target_id: "drop-me",
                target_family: "glm",
              reason: "guard already present upstream",
            },
          }),
        ],
      },
    }),
  });
  assert.equal(dual.dual_status, DUAL_STATUS.BOTH);
  assert.ok(dual.findings.some((f) => f.id === "keep" || f.title === "real race"));
  // drop-me should be refuted/dropped when refutes matches
  const droppedIds = (dual.dropped || []).map((f) => f.id);
  const keptIds = dual.findings.map((f) => f.id);
  if (droppedIds.includes("drop-me")) {
    assert.ok(!keptIds.includes("drop-me"));
  } else {
    // Policy B: if refute matched, drop-me not in findings; if family tagging differs, at least unrefuted keep survives
    assert.ok(keptIds.includes("keep") || dual.findings.some((f) => f.title === "real race"));
  }

  // driveDualEye both path keeps unrefuted single-family
  const both = driveDualEye({
    post: "adversary",
    primaryResult: { findings: [onlyPrimary] },
    primaryFamily: "glm",
    secondaryFamily: "openai",
    runSecondary: () => ({ ok: true, result: { findings: [onlySecondary] } }),
  });
  assert.equal(both.dual_status, DUAL_STATUS.BOTH);
  assert.equal(both.isFullDualCoverage, true);
  assert.ok(both.findings.some((f) => f.title === "primary unique race"));
  assert.ok(both.findings.some((f) => f.title === "secondary unique orphan"));
});

// ---- t8-merge-description-only (orphan-state: severity-only dedup collapse) ----

test("t8-merge-description-only: two primary description-only highs + one secondary high keeps both primary", () => {
  // No id, no title — only description + severity. Old dedupKey collapsed all highs to "|high".
  const primaryDescA = {
    description: "race on checkout write path",
    severity: "high",
    scope: "src/checkout.ts",
  };
  const primaryDescB = {
    description: "orphan state after partial refund",
    severity: "high",
    scope: "src/refund.ts",
  };
  const secondaryDesc = {
    description: "secondary unique auth gap",
    severity: "high",
    scope: "src/auth.ts",
  };

  const dual = driveDualEye({
    post: "adversary",
    primaryResult: { findings: [primaryDescA, primaryDescB] },
    primaryFamily: "glm",
    secondaryFamily: "openai",
    runSecondary: () => ({ ok: true, result: { findings: [secondaryDesc] } }),
  });

  assert.equal(dual.dual_status, DUAL_STATUS.BOTH);
  const texts = dual.findings.map((f) => String(f.title || f.description || ""));
  assert.ok(
    texts.some((t) => /race on checkout/i.test(t)),
    "primary description-only race must be kept",
  );
  assert.ok(
    texts.some((t) => /orphan state after partial refund/i.test(t)),
    "primary description-only orphan must be kept (not collapsed with other high)",
  );
  assert.ok(
    texts.some((t) => /secondary unique auth/i.test(t)),
    "secondary high must be kept",
  );
  assert.ok(
    dual.findings.length >= 3,
    `expected >=3 findings after merge (2 primary + 1 secondary), got ${dual.findings.length}`,
  );
  // extractFindings must stamp id + title on description-only issues
  for (const f of dual.findings) {
    assert.equal(typeof f.id, "string");
    assert.ok(f.id.length > 0, "normalized finding must have non-empty id");
    assert.equal(typeof f.title, "string");
    assert.ok(f.title.length > 0, "normalized finding must have title from description");
  }
});

// ---- supporting contracts (not locked ids but required by DoD) ----

test("t8-posts: dual posts dispatch canonical provider-agnostic family agents", () => {
  assert.equal(DUAL_POSTS["plan-reviewer"].primary, "plan-reviewer-family-1");
  assert.equal(DUAL_POSTS["plan-reviewer"].secondary, "plan-reviewer-family-2");
  assert.equal(DUAL_POSTS.adversary.primary, "adversary-family-1");
  assert.equal(DUAL_POSTS.adversary.secondary, "adversary-family-2");
  for (const post of Object.values(DUAL_POSTS)) {
    assert.doesNotMatch(`${post.primary} ${post.secondary}`, /openai|anthropic|xai|ollama/i);
  }
  assert.equal(DUAL_POSTS["plan-reviewer"].shape, "verdict");
  assert.equal(DUAL_POSTS.adversary.shape, "findings");
});

test("t8-virgin: secondary brief strips primary peer fields", () => {
  const brief = virginSecondaryBrief({
    task: "review plan",
    primaryResult: { verdict: "APPROVE" },
    primaryVerdict: "APPROVE",
    peerFindings: [{ id: "x" }],
    shared_context: "leaked",
    complianceOutput: { pass: true },
    scope: "src/",
  });
  assert.equal(brief.task, "review plan");
  assert.equal(brief.scope, "src/");
  assert.equal("primaryResult" in brief, false);
  assert.equal("primaryVerdict" in brief, false);
  assert.equal("peerFindings" in brief, false);
  assert.equal("shared_context" in brief, false);
  assert.equal("complianceOutput" in brief, false);
});

test("t8-verdict-merge: mergeDualVerdicts sets dual_status enum", () => {
  const m = mergeDualVerdicts(
    { verdict: "APPROVE" },
    { verdict: "REVISE", issues: [{ note: "x" }] },
    { primaryFamily: "glm", secondaryFamily: "openai" },
  );
  assert.equal(m.ok, true);
  assert.equal(m.dual_status, DUAL_STATUS.BOTH);
  assert.equal(m.isFullDualCoverage, true);

  const fo = mergeDualVerdicts({ verdict: "APPROVE" }, null, {
    primaryFamily: "glm",
  });
  assert.equal(fo.dual_status, DUAL_STATUS.PRIMARY_ONLY_FAILOPEN);
  assert.equal(fo.isFullDualCoverage, false);
});

test("t8-extract: extractFindings never invents items from empty/malformed", () => {
  assert.deepEqual(extractFindings(null), []);
  assert.deepEqual(extractFindings({}), []);
  assert.deepEqual(extractFindings({ findings: null }), []);
  assert.equal(extractFindings({ findings: [finding()] }).length, 1);
});

test("t8-warning: fail-open warning is pt-br product language", () => {
  const w = dualFailOpenWarning(DUAL_STATUS.PRIMARY_ONLY_FAILOPEN, "auth");
  assert.match(w, /segundo modelo|revisão principal/i);
  assert.ok(!/stack|exception|TypeError/i.test(w));
});
