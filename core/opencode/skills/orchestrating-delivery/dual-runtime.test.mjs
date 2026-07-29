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

function canonicalIssue(raw = {}) {
  const severity = raw.severity || "medium";
  return {
    description: raw.description || raw.title || "review finding",
    category: raw.category || "other",
    severity,
    scope: raw.scope || "src/file.ts",
    evidence: raw.evidence || "src/file.ts:1",
    suggested_sniper_tier: `sniper-${severity}`,
    fix_hint: raw.fix_hint || "src/file.ts:handler: apply the bounded fix",
  };
}

function adversaryReport(items = [], family = 1) {
  return {
    ...(family === 2 ? { family: "family-2" } : {}),
    issues: items.map(canonicalIssue),
  };
}

// ---- t8-enum ----

test("t8-enum: dual_status is enum not bare boolean after dual attempt", () => {
  assert.ok(DUAL_STATUS_VALUES.has("both"));
  assert.ok(DUAL_STATUS_VALUES.has("primary_only"));
  assert.ok(DUAL_STATUS_VALUES.has("primary_only_failopen"));
  assert.ok(DUAL_STATUS_VALUES.has("pending"));
  assert.ok(DUAL_STATUS_VALUES.has("primary_only_error"));
  assert.equal(DUAL_STATUS_VALUES.size, 5);

  assert.equal(isDualStatusEnum("both"), true);
  assert.equal(isDualStatusEnum("primary_only_failopen"), true);
  assert.equal(isDualStatusEnum(true), false);
  assert.equal(isDualStatusEnum(false), false);
  assert.equal(isDualStatusEnum(1), false);
  assert.equal(isDualStatusEnum("yes"), false);

  const primary = adversaryReport([finding()]);
  const both = driveDualEye({
    post: "adversary",
    primaryResult: primary,
    runSecondary: () => ({ ok: true, result: adversaryReport([], 2) }),
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
  assert.equal(failopen.dual_status, DUAL_STATUS.PRIMARY_ONLY);

  const pending = pendingDualState(primary, { post: "adversary" });
  assert.equal(pending.dual_status, DUAL_STATUS.PENDING);
  assert.equal(isDualStatusEnum(pending.dual_status), true);

  const patch = dualStatusGatePatch(both.dual_status);
  assert.equal(patch.dual_status, "both");
  assert.equal("dual_completed" in patch, false);
  const badPatch = dualStatusGatePatch(/** @type {any} */ (true));
  assert.equal(badPatch.ok, false);
});

test("t8-boundary: malformed primary is rejected before secondary dispatch", () => {
  let calls = 0;
  const result = driveDualEye({
    post: "adversary",
    primaryResult: {},
    runSecondary: () => {
      calls += 1;
      return { ok: true, result: adversaryReport([], 2) };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.dual_status, DUAL_STATUS.PENDING);
  assert.equal(result.primary_failure_class, "malformed");
  assert.equal(result.isFullDualCoverage, false);
});

// ---- t8-failopen ----

test("t8-failopen: unavailable secondary yields primary_only and keeps failure reason separate", () => {
  const primaryOnly = finding({ id: "p1", title: "primary-only race" });
  const primary = adversaryReport([primaryOnly]);

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

  assert.equal(r.dual_status, DUAL_STATUS.PRIMARY_ONLY);
  assert.equal(r.secondary_status, "unavailable");
  assert.equal(r.secondary_failure_class, "unavailable");
  assert.equal(r.isFullDualCoverage, false);
  assert.equal(r.secondaryAttempts, 1);
  // Auth/unavailable: no retry storm
  assert.equal(secondaryCalls, 1);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].title, "primary-only race");
  assert.equal(r.findings[0].title, "primary-only race");
  // Never invent secondary findings
  assert.ok(!r.findings.some((f) => f.family === "openai" && f.id !== "p1"));
  assert.ok(r.warning && /segundo modelo|revisão principal/i.test(r.warning));

  // Auth class also failopens without retry
  let authCalls = 0;
  const r2 = driveDualEye({
    post: "plan-reviewer",
    primaryResult: { verdict: "APPROVE", findings: [] },
    runSecondary: () => {
      authCalls += 1;
      return { ok: false, errorClass: "auth", reason: "login required" };
    },
  });
  assert.equal(r2.dual_status, DUAL_STATUS.PRIMARY_ONLY);
  assert.equal(authCalls, 1);
  assert.equal(r2.isFullDualCoverage, false);

  assert.equal(classifySecondaryFailure("auth"), "auth_unavailable");
  assert.equal(classifySecondaryFailure("unavailable"), "auth_unavailable");
  assert.equal(classifySecondaryFailure("rate_limit"), "infra_error");
});

// ---- t8-retry ----

test("t8-retry: secondary error retries once then returns primary_only without inventing findings", () => {
  assert.equal(PRIMARY_ONLY_ERROR_RETRY_COUNT, 1);

  const primaryFinding = finding({ id: "keep-me", title: "keep primary" });
  const primary = adversaryReport([primaryFinding]);

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
  assert.equal(r.dual_status, DUAL_STATUS.PRIMARY_ONLY);
  assert.equal(r.secondary_status, "failed");
  assert.equal(r.secondary_failure_class, "rate_limit");
  assert.equal(r.isFullDualCoverage, false);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].title, "keep primary");
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
        result: adversaryReport([
            finding({
              id: "s1",
              title: "secondary-only issue",
              severity: "medium",
            }),
          ], 2),
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

test("t8-not-full-dual: primary_only is not counted as full dual coverage", () => {
  assert.equal(isFullDualCoverage(DUAL_STATUS.BOTH), true);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PRIMARY_ONLY), false);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PRIMARY_ONLY_FAILOPEN), false);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PRIMARY_ONLY_ERROR), false);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PENDING), false);
  assert.equal(isFullDualCoverage(true), false);
  assert.equal(isFullDualCoverage("yes"), false);

  const r = driveDualEye({
    post: "adversary",
    primaryResult: adversaryReport([finding()]),
    runSecondary: () => ({
      ok: false,
      errorClass: "unauthenticated",
      reason: "not authenticated",
    }),
  });
  assert.equal(r.dual_status, DUAL_STATUS.PRIMARY_ONLY);
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
  // The runtime boundary rejects merge-only refute vehicles as non-canonical family-2 reports.
  const dual = driveDualEye({
    post: "adversary",
    primaryResult: adversaryReport([
        finding({ id: "keep", title: "real race", severity: "high" }),
        finding({ id: "drop-me", title: "false positive", severity: "low" }),
      ]),
    primaryFamily: "glm",
    secondaryFamily: "openai",
    runSecondary: () => ({
      ok: true,
      result: {},
    }),
  });
  assert.equal(dual.dual_status, DUAL_STATUS.PRIMARY_ONLY);
  assert.equal(dual.secondary_status, "failed");
  assert.equal(dual.secondary_failure_class, "malformed");
  assert.equal(dual.isFullDualCoverage, false);
  assert.ok(dual.findings.some((f) => f.title === "real race"));

  // driveDualEye both path keeps unrefuted single-family
  const both = driveDualEye({
    post: "adversary",
    primaryResult: adversaryReport([onlyPrimary]),
    primaryFamily: "glm",
    secondaryFamily: "openai",
    runSecondary: () => ({ ok: true, result: adversaryReport([onlySecondary], 2) }),
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
    primaryResult: adversaryReport([primaryDescA, primaryDescB]),
    primaryFamily: "glm",
    secondaryFamily: "openai",
    runSecondary: () => ({ ok: true, result: adversaryReport([secondaryDesc], 2) }),
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

// ---- t8-merge-plan-review-fields (#531: plan-review findings deduped by severity alone) ----

function planReviewFinding(over = {}) {
  return {
    area: "decomposition",
    severity: "high",
    task_id: "task-1",
    problem: "race no lock",
    planner_instruction: "add mutex around the shared counter",
    ...over,
  };
}

function planReviewReport(findings, family) {
  return {
    ...(family === 2 ? { family: "family-2" } : {}),
    verdict: findings.length > 0 ? "REVISE" : "APPROVE",
    findings,
  };
}

test("t8-merge-plan-review-fields: plan-reviewer findings of equal severity from both families are not collapsed (#531)", () => {
  const primaryFinding = planReviewFinding({
    task_id: "task-1",
    area: "decomposition",
    problem: "race no lock",
  });
  const secondaryFinding = planReviewFinding({
    task_id: "task-9",
    area: "introduced-risk",
    problem: "N+1 query introduced by the new fetch loop",
  });

  const dual = driveDualEye({
    post: "plan-reviewer",
    primaryResult: planReviewReport([primaryFinding], 1),
    primaryFamily: "claude",
    secondaryFamily: "codex",
    runSecondary: () => ({ ok: true, result: planReviewReport([secondaryFinding], 2) }),
  });

  assert.equal(dual.dual_status, DUAL_STATUS.BOTH);
  const problems = dual.findings.map((f) => f.problem);
  assert.ok(problems.includes("race no lock"), "primary plan-review finding must survive the merge");
  assert.ok(
    problems.includes("N+1 query introduced by the new fetch loop"),
    "secondary plan-review finding must survive the merge, not be consumed by a severity-only dedup key",
  );
  assert.equal(dual.findings.length, 2, "no plan-review finding may disappear from the merge");
});

test("t8-merge-plan-review-fields: same defect (same task_id + problem) from both families unifies into one entry", () => {
  const shared = planReviewFinding({ task_id: "task-1", area: "decomposition", problem: "race no lock" });

  const dual = driveDualEye({
    post: "plan-reviewer",
    primaryResult: planReviewReport([shared], 1),
    primaryFamily: "claude",
    secondaryFamily: "codex",
    runSecondary: () => ({ ok: true, result: planReviewReport([{ ...shared }], 2) }),
  });

  assert.equal(dual.dual_status, DUAL_STATUS.BOTH);
  assert.equal(dual.findings.length, 1, "identical plan-review defect must unify into a single entry");
  assert.equal(dual.findings[0].problem, "race no lock");
});

// ---- supporting contracts (not locked ids but required by DoD) ----

test("t8-posts: dual posts dispatch canonical provider-agnostic family agents", () => {
  assert.equal(DUAL_POSTS["plan-reviewer"].primary, "plan-reviewer");
  assert.equal(DUAL_POSTS["plan-reviewer"].secondary, null);
  assert.equal(DUAL_POSTS.adversary.primary, "adversary");
  assert.equal(DUAL_POSTS.adversary.secondary, null);
  for (const post of Object.values(DUAL_POSTS)) {
    assert.doesNotMatch(`${post.primary}`, /openai|anthropic|xai|ollama/i);
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
  assert.equal(fo.dual_status, DUAL_STATUS.PRIMARY_ONLY);
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
