/**
 * @description Contract tests for cron-b.mjs — the VPS cron harness's review + AUTO-MERGE
 * phase (task-7). This cron ships PRs to the default branch WITHOUT a human in the loop, so the
 * merge-gating precision is the entire point of this suite.
 *
 * Every seam cronB needs — `gh`, `parseVerdictBlock`, the reviewed-SHA marker
 * (`alreadyReviewed`/`recordReviewed`), and `openRiskMarker` — is INJECTED as an in-memory fake
 * so these tests are fully hermetic: no real `gh` process is ever spawned, and no real
 * filesystem reviewed-SHA state is touched. Assertions are made exclusively on the OBSERVABLE
 * recorded gh call log (which subcommands were invoked, in what order, targeting which PR) and
 * on the reviewed-marker fake's recorded calls — never on a return value from cronB().
 *
 * The fake `gh` supports the two query shapes cronB needs (`gh pr list` and
 * `gh pr view <n> --json body`, both fetched fresh against whatever head SHA is CURRENTLY set
 * for that PR — never memoized across calls) plus recording every other invocation
 * (`gh pr ready`, `gh pr merge --squash`, `gh pr comment`) into a shared `calls` log in argv
 * order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cronB } from "./cron-b.mjs";
import { parseVerdictBlock, formatVerdictBlock } from "./verdict-block.mjs";

/** @description Sentinel embedded in free PR-body prose (outside the verdict block) to signal an open risk that must block auto-merge even under an otherwise-CLEAN verdict. */
const OPEN_RISK_MARKER = "<!--harness:open-risk-->";

/**
 * @description Fake `gh` seam. Records every invocation's argv array into `calls` (in call
 * order). Answers `gh pr list` with the currently-set PR entries `{number, headRefName,
 * headSha}`, and `gh pr view <n> --json body` with `{body}` resolved against whichever head SHA
 * is CURRENTLY set for that PR at call time (never a snapshot taken earlier) — this is what lets
 * a test move a PR's head SHA between two cronB() runs and prove the second run re-fetches
 * fresh. Every other subcommand (`ready`, `merge`, `comment`) just gets recorded; no return value
 * is needed for those.
 */
function makeFakeGh() {
  const calls = [];
  const prs = new Map(); // number -> { headRefName, headSha }
  const bodies = new Map(); // `${number}:${sha}` -> body string

  function setPr(number, { headRefName, headSha }) {
    prs.set(number, { headRefName, headSha });
  }
  function setBody(number, sha, body) {
    bodies.set(`${number}:${sha}`, body);
  }

  function gh(args) {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return [...prs.entries()].map(([number, pr]) => ({ number, ...pr }));
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (args.includes("statusCheckRollup")) {
        return { statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] };
      }
      const number = Number(args[2]);
      const pr = prs.get(number);
      const body = pr ? bodies.get(`${number}:${pr.headSha}`) : undefined;
      return { body: body ?? "" };
    }
    return { ok: true };
  }

  return { gh, calls, setPr, setBody };
}

/**
 * @description Fake reviewed-SHA marker seam (stands in for cron-state's
 * alreadyReviewed/recordReviewed). `seed` pre-populates the `"<pr>:<sha>"` set as already
 * reviewed. Both functions record every call they receive into their own array.
 */
function makeFakeReviewedMarker(seed = new Set()) {
  const reviewed = new Set(seed);
  const reviewedCalls = [];
  const recordedCalls = [];

  function alreadyReviewed(pr, sha) {
    reviewedCalls.push({ pr, sha });
    return reviewed.has(`${pr}:${sha}`);
  }
  function recordReviewed(pr, sha) {
    recordedCalls.push({ pr, sha });
    reviewed.add(`${pr}:${sha}`);
  }

  return { alreadyReviewed, recordReviewed, reviewedCalls, recordedCalls };
}

/** @description Assembles a full cronB() opts object from defaults + per-test overrides. */
function baseOpts(overrides = {}) {
  const { gh } = makeFakeGh();
  const { alreadyReviewed, recordReviewed } = makeFakeReviewedMarker();
  return {
    gh,
    parseVerdictBlock,
    alreadyReviewed,
    recordReviewed,
    stateDir: "/fake/state",
    openRiskMarker: () => false,
    ...overrides,
  };
}

/** @description A realistic PR body carrying a CLEAN verdict block. */
function bodyClean() {
  return ["## Summary", "Adds the thing.", "", formatVerdictBlock({ status: "CLEAN" })].join("\n");
}

/** @description A realistic PR body carrying a BLOCKED verdict block naming `finding`. */
function bodyBlocked(finding) {
  return ["## Summary", "Adds the thing.", "", formatVerdictBlock({ status: "BLOCKED", finding })].join("\n");
}

test("cronB: ignores PRs whose head branch does not start with harness/ — no gh action ever targets a human PR", () => {
  const { gh, calls, setPr, setBody } = makeFakeGh();
  setPr(10, { headRefName: "harness/42", headSha: "sha-10-a" });
  setBody(10, "sha-10-a", bodyClean());
  setPr(11, { headRefName: "feature/human-x", headSha: "sha-11-a" });
  setBody(11, "sha-11-a", bodyClean());

  cronB(baseOpts({ gh }));

  const targetsPr11 = calls.some((args) => args.includes("11") || args.includes(11));
  assert.ok(!targetsPr11, "no gh call (ready/merge/comment/view) may ever target PR 11 (non-harness/ head)");

  const actedOnPr10 = calls.some(
    (args) => args[0] === "pr" && ["ready", "merge", "comment"].includes(args[1]) && args[2] === "10"
  );
  assert.ok(actedOnPr10, "PR 10 (harness/ head) must still be reviewed and acted on");
});

test("cronB: CLEAN verdict + no open-risk marker -> gh pr ready, then gh pr merge --squash, then a summary comment, IN ORDER", () => {
  const { gh, calls, setPr, setBody } = makeFakeGh();
  setPr(10, { headRefName: "harness/42", headSha: "sha-clean" });
  setBody(10, "sha-clean", bodyClean());
  const { alreadyReviewed, recordReviewed, recordedCalls } = makeFakeReviewedMarker();

  cronB(baseOpts({ gh, alreadyReviewed, recordReviewed, openRiskMarker: () => false }));

  const prActionsOnTen = calls.filter((args) => args[0] === "pr" && args[2] === "10");
  const subcommands = prActionsOnTen.map((args) => args[1]);
  const readyIdx = subcommands.indexOf("ready");
  const mergeIdx = subcommands.indexOf("merge");
  const commentIdx = subcommands.lastIndexOf("comment");

  assert.ok(readyIdx !== -1, "gh pr ready 10 must be invoked");
  assert.ok(mergeIdx !== -1, "gh pr merge 10 --squash must be invoked");
  assert.ok(commentIdx !== -1, "a summary gh pr comment 10 must be invoked");
  assert.ok(
    readyIdx < mergeIdx && mergeIdx < commentIdx,
    "the gh call log must show ready, then merge --squash, then the summary comment, in that order"
  );
  assert.ok(prActionsOnTen[mergeIdx].includes("--squash"), "the merge must be --squash");
  assert.ok(
    recordedCalls.some((c) => c.pr === 10 && c.sha === "sha-clean"),
    "PR 10 must be recorded as reviewed at its head SHA after a successful merge"
  );
});

test("cronB: non-green CI comments and never marks ready or merges", () => {
  const { gh: baseGh, calls, setPr, setBody } = makeFakeGh();
  setPr(10, { headRefName: "harness/42", headSha: "sha-ci-red" });
  setBody(10, "sha-ci-red", bodyClean());
  const gh = (args) => args[0] === "pr" && args[1] === "view" && args.includes("statusCheckRollup")
    ? { statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }] }
    : baseGh(args);

  cronB(baseOpts({ gh, openRiskMarker: () => false }));

  assert.equal(calls.some((args) => args[0] === "pr" && args[1] === "ready"), false);
  assert.equal(calls.some((args) => args[0] === "pr" && args[1] === "merge"), false);
  assert.equal(calls.some((args) => args[0] === "pr" && args[1] === "comment"), true);
});

test("cronB: pending CI does not comment-spam while it waits", () => {
  const { gh: baseGh, calls, setPr, setBody } = makeFakeGh();
  setPr(10, { headRefName: "harness/42", headSha: "sha-ci-pending" });
  setBody(10, "sha-ci-pending", bodyClean());
  const gh = (args) => args[0] === "pr" && args[1] === "view" && args.includes("statusCheckRollup")
    ? { statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }] }
    : baseGh(args);

  cronB(baseOpts({ gh, openRiskMarker: () => false }));
  assert.equal(calls.some((args) => args[0] === "pr" && args[1] === "comment"), false);
  assert.equal(calls.some((args) => args[0] === "pr" && args[1] === "merge"), false);
});

test("cronB: BLOCKED verdict, an absent verdict block, or an open-risk marker -> comments naming the blocking finding, NEVER merges", () => {
  const scenarios = [
    {
      label: "BLOCKED verdict with a named finding",
      body: bodyBlocked("unresolved SQL injection risk in the query builder"),
      openRiskMarker: () => false,
      expectedSubstring: "unresolved sql injection risk in the query builder",
    },
    {
      label: "no verdict block at all in the PR body",
      body: "Just a plain PR description with no machine-readable verdict block.",
      openRiskMarker: () => false,
      expectedSubstring: "no verdict block",
    },
    {
      label: "CLEAN verdict block but an open-risk marker present in the body",
      body: bodyClean() + "\n\n" + OPEN_RISK_MARKER,
      openRiskMarker: (body) => body.includes(OPEN_RISK_MARKER),
      expectedSubstring: "open risk",
    },
  ];

  for (const scenario of scenarios) {
    const { gh, calls, setPr, setBody } = makeFakeGh();
    setPr(10, { headRefName: "harness/42", headSha: "sha-x" });
    setBody(10, "sha-x", scenario.body);
    const { alreadyReviewed, recordReviewed } = makeFakeReviewedMarker();

    cronB(baseOpts({ gh, alreadyReviewed, recordReviewed, openRiskMarker: scenario.openRiskMarker }));

    const mergeCalls = calls.filter((args) => args[0] === "pr" && args[1] === "merge");
    assert.equal(mergeCalls.length, 0, `[${scenario.label}] gh call log must contain NO gh pr merge call`);

    const commentCalls = calls.filter((args) => args[0] === "pr" && args[1] === "comment" && args[2] === "10");
    assert.ok(commentCalls.length > 0, `[${scenario.label}] must invoke gh pr comment 10`);

    const commentText = commentCalls.map((args) => args.join(" ")).join(" ").toLowerCase();
    assert.ok(
      commentText.includes(scenario.expectedSubstring),
      `[${scenario.label}] the comment must name the blocking finding (expected to mention "${scenario.expectedSubstring}")`
    );
  }
});

test("cronB: idempotent per PR head SHA — no-ops when already reviewed at the same SHA, acts again once the SHA changes", () => {
  const { gh, calls, setPr, setBody } = makeFakeGh();
  setPr(10, { headRefName: "harness/42", headSha: "abc" });
  setBody(10, "abc", bodyClean());
  const { alreadyReviewed, recordReviewed, recordedCalls } = makeFakeReviewedMarker(new Set(["10:abc"]));

  cronB(baseOpts({ gh, alreadyReviewed, recordReviewed, openRiskMarker: () => false }));

  const actionsAtAbc = calls.filter(
    (args) => args[0] === "pr" && ["ready", "merge", "comment"].includes(args[1]) && args[2] === "10"
  );
  assert.equal(
    actionsAtAbc.length,
    0,
    "a PR already recorded as reviewed at its current head SHA ('abc') must produce NO ready/merge/comment call"
  );

  // Head SHA advances to 'def' (new commits pushed) — cronB must treat this as unreviewed.
  setPr(10, { headRefName: "harness/42", headSha: "def" });
  setBody(10, "def", bodyClean());

  cronB(baseOpts({ gh, alreadyReviewed, recordReviewed, openRiskMarker: () => false }));

  const mergeAtDef = calls.filter((args) => args[0] === "pr" && args[1] === "merge" && args[2] === "10");
  assert.ok(mergeAtDef.length > 0, "once the head SHA changes to 'def', cronB must act (and merge) again");
  assert.ok(
    recordedCalls.some((c) => c.pr === 10 && c.sha === "def"),
    "the new head SHA 'def' must be recorded as reviewed"
  );
});

test("cronB: reads the PR body at the REVIEWED head SHA — a stale CLEAN observed at an earlier SHA never auto-merges a later BLOCKED SHA", () => {
  const { gh, calls, setPr, setBody } = makeFakeGh();
  // Earlier observation at 'abc' was CLEAN — this must never be trusted for a later SHA.
  setBody(10, "abc", bodyClean());
  // Delivery-time downgrade landed at 'def': the CURRENT body is BLOCKED.
  setBody(10, "def", bodyBlocked("delivery-time downgrade: orphan freeze-commit detected"));
  setPr(10, { headRefName: "harness/42", headSha: "def" }); // current head is 'def'

  const { alreadyReviewed, recordReviewed } = makeFakeReviewedMarker();

  cronB(baseOpts({ gh, alreadyReviewed, recordReviewed, openRiskMarker: () => false }));

  const viewCallsOnTen = calls.filter((args) => args[0] === "pr" && args[1] === "view" && args[2] === "10");
  assert.ok(viewCallsOnTen.length > 0, "cronB must fetch the CURRENT body via gh pr view 10 --json body");

  const mergeCalls = calls.filter((args) => args[0] === "pr" && args[1] === "merge" && args[2] === "10");
  assert.equal(
    mergeCalls.length,
    0,
    "the freshly-fetched BLOCKED body at head 'def' must never merge, regardless of an earlier CLEAN observed at 'abc'"
  );
});
