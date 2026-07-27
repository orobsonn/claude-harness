/** @description Locked tests for OC bash delivery + forge decide (session-275 + U2 rails). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  decideBashDelivery,
  decideBashAdvisory,
  applyAdvisory,
  adviseIssueForm,
  hasElevatedCeremonyResidue,
  writingTaskIdsFromPlan,
} from "./bash-decide.mjs";

const SID = "ses_test_delivery_1";
const CLEAN_GIT = { branch: "feat/x", commitsAhead: 1, defaultBranch: "main" };
const emptyList = () => [];
const ancestorTrue = () => true;
const ancestorFalse = () => false;

/** Green on-disk DONE+stamp fixture — required for LIGHT|FULL ship (session-bound to SID). */
const stampedDoneList = () => [
  {
    taskId: "t1",
    sessionId: SID,
    record: {
      outcome: "DONE",
      freezeCommitSha: "abc",
      capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
      scopeViolations: [],
      frozenViolations: [],
    },
  },
];

/** @param {Record<string, unknown>} [extra] */
function cleanDeps(extra = {}) {
  return {
    sessionId: SID,
    gitState: CLEAN_GIT,
    isAncestorFn: ancestorTrue,
    listHandRecordsForFeatureFn: emptyList,
    ...extra,
  };
}

/** @param {Record<string, unknown>} [extra] */
function cleanDepsWithCapture(extra = {}) {
  return cleanDeps({
    listHandRecordsForFeatureFn: stampedDoneList,
    ...extra,
  });
}

/** @param {Record<string, unknown>} [extra] */
function fullCeremony(extra = {}) {
  return {
    mode: "FULL",
    classified: true,
    brainstormed: true,
    adversary_fired: true,
    dual_status: "both",
    feature_id: "feat",
    // Ship-ready FULL fixture (#385): final dual review + demo stamped.
    final_review_done: true,
    demo_done: true,
    planner_status: "usable",
    delivery_status: "ready",
    ...extra,
  };
}

/** @param {Record<string, unknown>} [extra] */
function lightCeremony(extra = {}) {
  return {
    mode: "LIGHT",
    classified: true,
    brainstormed: true,
    adversary_fired: true,
    feature_id: "feat",
    planner_status: "usable",
    delivery_status: "ready",
    ...extra,
  };
}

/** @param {Record<string, unknown>} [extra] */
function quickCeremony(extra = {}) {
  return {
    mode: "QUICK",
    classified: true,
    feature_id: "feat",
    ...extra,
  };
}

// ── ceremony deny cases (stay green) ──────────────────────────────────────

test("empty gate + gh pr → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create --draft",
    gateState: {},
    sessionId: SID,
  });
  assert.equal(d.decision, "deny");
});

test("unreadable gate load → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    sessionId: SID,
    gateStateLoadOk: false,
  });
  assert.equal(d.decision, "deny");
});

test("QUICK+classified + clean rails → allow", () => {
  const d = decideBashDelivery({
    command: "git push -u origin h",
    gateState: quickCeremony(),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

test("LIGHT brainstorm+adversary + clean rails + capture evidence → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony(),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

test("LIGHT missing brainstormed → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    sessionId: SID,
    gateState: {
      mode: "LIGHT",
      classified: true,
      adversary_fired: true,
      feature_id: "feat",
    },
  });
  assert.equal(d.decision, "deny");
});

test("no-ceremony → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    sessionId: SID,
    gateState: { mode: "no-ceremony", classified: true },
  });
  assert.equal(d.decision, "deny");
});

test("FULL without dual → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    sessionId: SID,
    gateState: {
      mode: "FULL",
      classified: true,
      brainstormed: true,
      adversary_fired: true,
      feature_id: "feat",
    },
  });
  assert.equal(d.decision, "deny");
});

test("FULL + dual both + clean rails + capture evidence → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

// ── #385 ship preconditions: final review + interactive demo ──────────────

test("#ac-1.1 FULL without final_review_done → deny final-review-missing", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ final_review_done: undefined, demo_done: true }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "deny");
  assert.equal(d.details?.denied_class, "final-review-missing");
  assert.match(d.reason, /final-review-missing|final dual review/i);
});

test("#ac-1.2 FULL interactive without demo_done → deny demo-missing", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ demo_done: undefined, headless: false }),
    ...cleanDepsWithCapture(),
    headless: false,
  });
  assert.equal(d.decision, "deny");
  assert.equal(d.details?.denied_class, "demo-missing");
  assert.match(d.reason, /demo-missing|demo marker/i);
});

test("#ac-1.2 FULL headless without demo_done → allow (demo not required)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ demo_done: undefined, headless: true }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "delivery-ok");
});

test("#ac-1.2 FULL headless via input.headless without demo → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ demo_done: undefined }),
    ...cleanDepsWithCapture(),
    headless: true,
  });
  assert.equal(d.decision, "allow");
});

test("#ac-1.3 FULL + final + demo + capture + dual → allow push path", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({
      final_review_done: true,
      demo_done: true,
      hand_finished: ["feat/t1"],
      capture_verified: ["feat/t1@abc"],
    }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "delivery-ok");
  assert.equal(d.details?.denied_class, undefined);
});

test("LIGHT without final_review_done → allow (final rail is FULL-only)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony(),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

test("missing sessionId + delivery → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    gateState: quickCeremony(),
    sessionId: null,
  });
  assert.equal(d.decision, "deny");
});

// ── A5: multitask capture coverage vs bound plan ──────────────────────────

test("writingTaskIdsFromPlan returns ids of tasks with non-empty scope_paths only", () => {
  const plan = {
    tasks: [
      { id: "t1", scope_paths: ["src/a.ts"] },
      { id: "t2", scope_paths: ["src/b.ts"] },
      { id: "t3", scope_paths: [] }, // no scope → not a writing task
      { id: "", scope_paths: ["src/c.ts"] }, // no id → skip
      { scope_paths: ["src/d.ts"] }, // no id → skip
    ],
  };
  assert.deepEqual(writingTaskIdsFromPlan(plan), ["t1", "t2"]);
});

test("writingTaskIdsFromPlan is null (fail-open) for non-enumerable plan", () => {
  assert.equal(writingTaskIdsFromPlan(null), null);
  assert.equal(writingTaskIdsFromPlan({}), null);
  assert.equal(writingTaskIdsFromPlan({ tasks: "nope" }), null);
  assert.equal(writingTaskIdsFromPlan("plan"), null);
});

test("A5: LIGHT bound plan writing task without capture → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony({
      hand_finished: ["feat/t1"],
      capture_verified: ["feat/t1@abc"],
    }),
    ...cleanDepsWithCapture({
      boundPlan: {
        tasks: [
          { id: "t1", scope_paths: ["src/a.ts"] },
          { id: "t2", scope_paths: ["src/b.ts"] }, // planned, never captured
        ],
      },
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /t2/);
  assert.match(d.reason, /no delivery evidence|half-built/i);
});

test("A5: FULL bound plan with every writing task captured → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({
      final_review_done: true,
      demo_done: true,
      hand_finished: ["feat/t1", "feat/t2"],
      capture_verified: ["feat/t1@abc", "feat/t2@abc"],
    }),
    ...cleanDepsWithCapture({
      boundPlan: {
        tasks: [
          { id: "t1", scope_paths: ["src/a.ts"] },
          { id: "t2", scope_paths: ["src/b.ts"] },
        ],
      },
    }),
  });
  assert.equal(d.decision, "allow");
});

test("A5: DONE_WITH_CONCERNS writing task (hand record, no capture) → allow, no false-block", () => {
  // DONE_WITH_CONCERNS is shippable but the system never capture-stamps it. A5 must
  // exempt it (it has a hand record) instead of demanding a capture that never exists.
  const listWithConcerns = () => [
    {
      taskId: "t1",
      sessionId: SID,
      record: {
        outcome: "DONE",
        freezeCommitSha: "abc",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        scopeViolations: [],
        frozenViolations: [],
      },
    },
    {
      taskId: "t2",
      sessionId: SID,
      record: { outcome: "DONE_WITH_CONCERNS", scopeViolations: [], frozenViolations: [] },
    },
  ];
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({
      final_review_done: true,
      demo_done: true,
      hand_finished: ["feat/t1"],
      capture_verified: ["feat/t1@abc"], // t2 intentionally uncaptured
    }),
    ...cleanDeps({
      listHandRecordsForFeatureFn: listWithConcerns,
      boundPlan: {
        tasks: [
          { id: "t1", scope_paths: ["src/a.ts"] },
          { id: "t2", scope_paths: ["src/b.ts"] },
        ],
      },
    }),
  });
  assert.equal(d.decision, "allow");
});

test("A5: planned writing task with NO record and NO capture → deny (silent skip)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony({
      hand_finished: ["feat/t1"],
      capture_verified: ["feat/t1@abc"],
    }),
    ...cleanDepsWithCapture({
      boundPlan: {
        tasks: [
          { id: "t1", scope_paths: ["src/a.ts"] },
          { id: "t2", scope_paths: ["src/b.ts"] }, // never dispatched: no record in stampedDoneList
        ],
      },
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /t2/);
  assert.match(d.reason, /no delivery evidence|never dispatched/i);
});

test("A5 fail-open: bound plan absent → does not add a new block", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony({
      hand_finished: ["feat/t1"],
      capture_verified: ["feat/t1@abc"],
    }),
    ...cleanDepsWithCapture({ boundPlan: null }),
  });
  assert.equal(d.decision, "allow");
});

test("A5 fail-open: non-enumerable bound plan (no tasks array) → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony({
      hand_finished: ["feat/t1"],
      capture_verified: ["feat/t1@abc"],
    }),
    ...cleanDepsWithCapture({ boundPlan: { note: "corrupt" } }),
  });
  assert.equal(d.decision, "allow");
});

// ── #475: forge wall removed — advisory channel (allow + prose hint, never deny) ──
// decideBashForge/isStateForgeCommand and the whole detector family (marker-path binding,
// interpreter/eval/preload/tmp-drop/archive/source/package-runner classifiers) are gone.
// The bash gate never denies a non-delivery command anymore. decideBashAdvisory only ever
// allows; its sole job is to optionally attach a non-blocking advisory string, delivered by
// applyAdvisory on output.metadata (the OC plugin API's only prose channel back to the model).

test("#ac-1.1: previously forge-denied command shapes now allow (all retired classes)", () => {
  const previouslyDenied = [
    "npm run build",
    "make test",
    'node -e "console.log(1)"',
    "bash script.sh",
    "tar -xf x.tgz",
    "source .venv/bin/activate",
    "npx some-tool",
    "bunx some-tool",
    "yarn dlx some-tool",
    "pnpm dlx some-tool",
    "node --require=./x.js core/index.mjs",
    'bash -c "echo x"',
    "cat > .opencode/plans/.state/ses_x/gate-state.json <<'EOF'\n{}\nEOF",
    "./evil.mjs",
    "node /tmp/evil.mjs",
    "echo x | bash",
    "cp forged.json .opencode/plans/.state/ses_x/gate-state.json",
    "env -i node evil.mjs",
    'python3 -c "print(1)"',
  ];
  for (const command of previouslyDenied) {
    assert.equal(
      decideBashAdvisory({ command }).decision,
      "allow",
      `decideBashAdvisory must allow: ${command}`,
    );
    assert.equal(
      decideBashDelivery({ command }).decision,
      "allow",
      `decideBashDelivery must allow non-delivery command: ${command}`,
    );
  }
});

test("#ac-2.2: decideBashAdvisory is fail-open — never denies, even on malformed input", () => {
  const malformed = [
    {},
    { command: undefined },
    { command: 123 },
    { command: null },
    { command: "gh issue create", cwd: 42 },
    { command: "gh issue create", cwd: null },
  ];
  for (const input of malformed) {
    const d = decideBashAdvisory(input);
    assert.equal(d.ok, true);
    assert.equal(d.decision, "allow");
  }
});

test("#ac-2.1: decideBashAdvisory attaches an advisory for gh issue create in a vendored repo", () => {
  const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "../../../..");
  const d = decideBashAdvisory({ command: "gh issue create --title x", cwd: repoRoot });
  assert.equal(d.decision, "allow");
  assert.equal(typeof d.advisory, "string");
  assert.match(d.advisory, /harness-task\.yml/);
});

test("#ac-2.1: decideBashAdvisory omits advisory when convention already followed", () => {
  const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "../../../..");
  const d = decideBashAdvisory({
    command: 'gh issue create --title "[harness] foo" --label "harness:ready"',
    cwd: repoRoot,
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.advisory, undefined);
});

test("#ac-2.1: applyAdvisory writes the advisory to output.metadata.bash_advisory", () => {
  const output = {};
  applyAdvisory({ ok: true, decision: "allow", reason: "advisory", advisory: "hint text" }, output);
  assert.equal(output.metadata.bash_advisory, "hint text");
});

test("applyAdvisory preserves existing output.metadata keys", () => {
  const output = { metadata: { model: "x" } };
  applyAdvisory({ ok: true, decision: "allow", reason: "advisory", advisory: "hint text" }, output);
  assert.equal(output.metadata.model, "x");
  assert.equal(output.metadata.bash_advisory, "hint text");
});

test("applyAdvisory is a no-op when the decision carries no advisory", () => {
  const output = {};
  applyAdvisory({ ok: true, decision: "allow", reason: "no-advisory" }, output);
  assert.equal(output.metadata, undefined);
});

test("#ac-2.2: applyAdvisory is fail-open on malformed output (never throws)", () => {
  const decision = { ok: true, decision: "allow", reason: "advisory", advisory: "hint text" };
  assert.doesNotThrow(() => applyAdvisory(decision, null));
  assert.doesNotThrow(() => applyAdvisory(decision, undefined));
  assert.doesNotThrow(() => applyAdvisory(decision, "not-an-object"));
  assert.doesNotThrow(() => applyAdvisory(null, {}));
  assert.doesNotThrow(() => applyAdvisory(undefined, {}));
});

// ── adviseIssueForm pure function contracts (ported 1:1 from Claude Code, entry-gate.mjs) ──

test("adviseIssueForm #1: gh issue create + existsFn=true + abs cwd → returns advisory string (truthy)", () => {
  const result = adviseIssueForm("gh issue create --title x", "/abs/repo", () => true);
  assert.ok(result, "advisory must be a truthy string when form exists in abs cwd");
  assert.equal(typeof result, "string", "advisory must be a string");
});

test("adviseIssueForm #2: non-gh-issue command → null", () => {
  const result = adviseIssueForm("ls -la", "/abs/repo", () => true);
  assert.equal(result, null, "non-gh-issue command must return null");
});

test("adviseIssueForm #3: command already contains harness:ready → null (no re-nudge)", () => {
  const result = adviseIssueForm(
    'gh issue create --title "[harness] foo" --label "harness:ready"',
    "/abs/repo",
    () => true,
  );
  assert.equal(result, null, "command already following convention must return null");
});

test("adviseIssueForm #4: relative cwd or empty or undefined → null (fail-open, no nudge)", () => {
  assert.equal(adviseIssueForm("gh issue create --title x", "repo", () => true), null);
  assert.equal(adviseIssueForm("gh issue create --title x", "", () => true), null);
  assert.equal(adviseIssueForm("gh issue create --title x", undefined, () => true), null);
});

test("adviseIssueForm #5: existsFn=()=>false → null (no form vendored → no nudge)", () => {
  const result = adviseIssueForm("gh issue create --title x", "/abs/repo", () => false);
  assert.equal(result, null, "no form vendored must return null");
});

test("adviseIssueForm #6: non-string command → null", () => {
  assert.equal(adviseIssueForm(undefined, "/abs/repo", () => true), null);
  assert.equal(adviseIssueForm(123, "/abs/repo", () => true), null);
});

test("adviseIssueForm #7: harness:ready loose in --body/--title prose does not suppress the nudge (regression)", () => {
  const result = adviseIssueForm(
    'gh issue create --title x --body "não esqueça harness:ready depois"',
    "/abs/repo",
    () => true,
  );
  assert.ok(result, "a harness:ready mention outside --label/-l must not suppress the advisory");
});

test("adviseIssueForm #8: -l short flag with harness:ready suppresses the nudge", () => {
  const result = adviseIssueForm('gh issue create --title x -l harness:ready', "/abs/repo", () => true);
  assert.equal(result, null);
});

test("adviseIssueForm #9: --label with a comma-separated list containing harness:ready suppresses the nudge", () => {
  const result = adviseIssueForm(
    'gh issue create --title x --label "P0,harness:ready"',
    "/abs/repo",
    () => true,
  );
  assert.equal(result, null);
});

// ── U2 rails locked tests ─────────────────────────────────────────────────

test("B1: FULL ceremony + unmatched regate_pending → deny names feat/t1", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ regate_pending: ["feat/t1"] }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t1/);
  assert.doesNotMatch(d.reason, /ceremony-delivery-ok/);
});

test("B2: pending matched by regate_passed@sha + ancestor true → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({
      regate_pending: ["feat/t1"],
      regate_passed: ["feat/t1@abc"],
    }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

test("divergent sha (isAncestor false) → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({
      regate_pending: ["feat/t1"],
      regate_passed: ["feat/t1@sha"],
    }),
    ...cleanDeps({ isAncestorFn: ancestorFalse }),
  });
  assert.equal(d.decision, "deny");
});

test("unqualified regate_passed → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({
      regate_pending: ["feat/t1"],
      regate_passed: ["feat/t1"],
    }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
});

test("trilho-4 #1: hand_finished without capture_verified → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ hand_finished: ["feat/t1"] }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
});

test("hand_finished + capture_verified divergent sha → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({
      hand_finished: ["feat/t1"],
      capture_verified: ["feat/t1@deadbeef"],
    }),
    ...cleanDeps({ isAncestorFn: ancestorFalse }),
  });
  assert.equal(d.decision, "deny");
});

test("regate matched AND capture unmatched → deny (independent rails)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({
      regate_pending: ["feat/t1"],
      regate_passed: ["feat/t1@abc"],
      hand_finished: ["feat/t2"],
    }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t2|capture|hand-finished/i);
});

test("both regate+capture matched + real-file clear → allow (single terminal)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({
      regate_pending: ["feat/t1"],
      regate_passed: ["feat/t1@abc"],
      hand_finished: ["feat/t2"],
      capture_verified: ["feat/t2@def"],
    }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "delivery-ok");
});

test("listFn DONE missing capturedVerifiedAt → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => [
        {
          taskId: "t1",
          sessionId: "s1",
          record: { outcome: "DONE", freezeCommitSha: "abc" },
        },
      ],
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /capturedVerifiedAt/);
});

test("DONE+stamp+scopeViolations → deny hard-stop", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => [
        {
          taskId: "t1",
          sessionId: "s1",
          record: {
            outcome: "DONE",
            freezeCommitSha: "abc",
            capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
            scopeViolations: ["leak.ts"],
          },
        },
      ],
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /SCOPE\/FROZEN/);
});

test("gitState.branch main → deny protected (not ceremony-delivery-ok)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDeps({
      gitState: { branch: "main", commitsAhead: 3, defaultBranch: "main" },
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /protected branch/i);
  assert.doesNotMatch(d.reason, /ceremony-delivery-ok/);
});

test("gitState.branch master → deny protected", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDeps({
      gitState: { branch: "master", commitsAhead: 2, defaultBranch: "master" },
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /protected branch/i);
});

test("gitState.branch === defaultBranch → deny protected", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDeps({
      gitState: { branch: "trunk", commitsAhead: 1, defaultBranch: "trunk" },
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /protected branch/i);
});

test("gitState.commitsAhead 0 → deny; gitState null → does not alone deny", () => {
  const zero = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDeps({
      gitState: { branch: "feat/x", commitsAhead: 0, defaultBranch: "main" },
    }),
  });
  assert.equal(zero.decision, "deny");
  assert.match(zero.reason, /zero commits/i);

  const nullGit = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDepsWithCapture({ gitState: null }),
  });
  assert.equal(nullGit.decision, "allow");
});

test("regate_pending non-array → deny gate-state corrupted (not stamp regate-passed)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ regate_pending: "BROKEN" }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gate-state corrupted/);
  assert.doesNotMatch(d.reason, /stamp regate-passed/);
});

test("hand_finished non-array → deny gate-state corrupted", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ hand_finished: { y: 2 } }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gate-state corrupted/);
  assert.match(d.reason, /hand_finished/);
});

test("capture_verified non-array → deny gate-state corrupted", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ capture_verified: { z: 3 } }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gate-state corrupted/);
  assert.match(d.reason, /capture_verified/);
});

test("regate_passed non-array → deny gate-state corrupted", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ regate_passed: { x: 1 } }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gate-state corrupted/);
  assert.match(d.reason, /regate_passed/);
});

test("LIGHT/FULL without string feature_id → deny", () => {
  const light = decideBashDelivery({
    command: "git push",
    gateState: {
      mode: "LIGHT",
      classified: true,
      brainstormed: true,
      adversary_fired: true,
      planner_status: "usable",
      delivery_status: "ready",
    },
    ...cleanDeps(),
  });
  assert.equal(light.decision, "deny");
  assert.match(light.reason, /feature_id/);

  const full = decideBashDelivery({
    command: "git push",
    gateState: {
      mode: "FULL",
      classified: true,
      brainstormed: true,
      adversary_fired: true,
      dual_status: "both",
      final_review_done: true,
      demo_done: true,
      planner_status: "usable",
      delivery_status: "ready",
    },
    ...cleanDeps(),
  });
  assert.equal(full.decision, "deny");
  assert.match(full.reason, /feature_id/);
});

test("ceremony-complete + unmatched regate → rail reason NOT ceremony-delivery-ok", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony({ regate_pending: ["feat/t1"] }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t1/);
  assert.doesNotMatch(d.reason, /ceremony-delivery-ok/);
});

// ── QUICK rails (no early quick-delivery-ok) ──────────────────────────────

test("QUICK+classified + unmatched regate → deny NOT quick-delivery-ok", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: quickCeremony({ regate_pending: ["feat/t1"] }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /feat\/t1/);
  assert.doesNotMatch(d.reason, /quick-delivery-ok/);
});

test("QUICK+classified + unmatched hand_finished → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: quickCeremony({ hand_finished: ["feat/t1"] }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
});

test("QUICK+classified + listFn DONE without stamp → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: quickCeremony(),
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => [
        {
          taskId: "t1",
          sessionId: "s1",
          record: { outcome: "DONE", freezeCommitSha: "abc" },
        },
      ],
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /capturedVerifiedAt/);
});

test("QUICK+classified + regate_pending non-array → deny corrupted", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: quickCeremony({ regate_pending: "BROKEN" }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gate-state corrupted/);
});

test("QUICK+classified + gitState main or commitsAhead 0 → deny", () => {
  const main = decideBashDelivery({
    command: "git push",
    gateState: quickCeremony(),
    ...cleanDeps({
      gitState: { branch: "main", commitsAhead: 1, defaultBranch: "main" },
    }),
  });
  assert.equal(main.decision, "deny");

  const zero = decideBashDelivery({
    command: "git push",
    gateState: quickCeremony(),
    ...cleanDeps({
      gitState: { branch: "feat/x", commitsAhead: 0, defaultBranch: "main" },
    }),
  });
  assert.equal(zero.decision, "deny");
});

// ── precedence ────────────────────────────────────────────────────────────

test("incomplete ceremony AND unmatched regate → ceremony reason first", () => {
  const d = decideBashDelivery({
    command: "git push",
    sessionId: SID,
    gateState: {
      mode: "FULL",
      classified: true,
      brainstormed: true,
      adversary_fired: true,
      // no dual_status
      feature_id: "feat",
      regate_pending: ["feat/t1"],
    },
    gitState: CLEAN_GIT,
    isAncestorFn: ancestorTrue,
    listHandRecordsForFeatureFn: emptyList,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /dual_status/i);
  assert.doesNotMatch(d.reason, /feat\/t1/);
});

test("listHandRecordsForFeatureFn not function when needed → deny real-file-list-unavailable", () => {
  const full = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    sessionId: SID,
    gitState: CLEAN_GIT,
    isAncestorFn: ancestorTrue,
    // listFn absent
  });
  assert.equal(full.decision, "deny");
  assert.match(full.reason, /real-file-list-unavailable/);

  const light = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony(),
    sessionId: SID,
    gitState: CLEAN_GIT,
    isAncestorFn: ancestorTrue,
  });
  assert.equal(light.decision, "deny");
  assert.match(light.reason, /real-file-list-unavailable/);

  const withFeature = decideBashDelivery({
    command: "git push",
    gateState: quickCeremony({ feature_id: "feat" }),
    sessionId: SID,
    gitState: CLEAN_GIT,
    isAncestorFn: ancestorTrue,
  });
  assert.equal(withFeature.decision, "deny");
  assert.match(withFeature.reason, /real-file-list-unavailable/);
});

test("LIGHT|FULL empty hand-record list → deny real-file-no-capture-evidence", () => {
  const light = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony(),
    ...cleanDeps({ listHandRecordsForFeatureFn: emptyList }),
  });
  assert.equal(light.decision, "deny");
  assert.match(light.reason, /real-file-no-capture-evidence/);

  const full = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDeps({ listHandRecordsForFeatureFn: emptyList }),
  });
  assert.equal(full.decision, "deny");
  assert.match(full.reason, /real-file-no-capture-evidence/);
});

test("listFn throws → deny real-file-list-unavailable", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => {
        throw new Error("readdir failed");
      },
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /real-file-list-unavailable/);
});

test("QUICK empty list still allow (no requireCaptureEvidence)", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: quickCeremony(),
    ...cleanDeps({ listHandRecordsForFeatureFn: emptyList }),
  });
  assert.equal(d.decision, "allow");
});

test("FULL + only other-session DONE stamp → deny real-file-no-capture-evidence", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => [
        {
          taskId: "t1",
          sessionId: "other_session",
          record: {
            outcome: "DONE",
            freezeCommitSha: "abc",
            capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
            scopeViolations: [],
            frozenViolations: [],
          },
        },
      ],
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /real-file-no-capture-evidence/);
});

test("FULL + current session DONE stamp → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});

test("FULL + other-session DONE without stamp still hard-stop deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: fullCeremony(),
    ...cleanDeps({
      listHandRecordsForFeatureFn: () => [
        {
          taskId: "t1",
          sessionId: "other_session",
          record: { outcome: "DONE", freezeCommitSha: "abc" },
        },
      ],
    }),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /capturedVerifiedAt/);
});

// ── #ac-2.4 / #ac-2.11: opencode.json.example permission.bash contract (config only) ──

/** @description #ac-2.4 + #ac-2.11: parse example and assert bash permission shape (no * allow, ask default, prescribed allows, ceremony, no broad globs) */
test("#ac-2.4 #ac-2.11: opencode.json.example bash permission baseline", () => {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const jsonPath = path.join(__dirname, "../../../opencode/opencode.json.example");
  const raw = fs.readFileSync(jsonPath, "utf8");
  const config = JSON.parse(raw);
  const bash = config.permission && config.permission.bash;
  assert.ok(bash, "permission.bash must exist");

  // default is ask, no * allow
  assert.equal(bash["*"], "ask");
  const starVal = bash["*"];
  assert.notEqual(starVal, "allow");
  // no key '*' has allow value (redundant but explicit)
  assert.equal(Object.prototype.hasOwnProperty.call(bash, "*") && bash["*"] === "allow", false);

  // package allow keys present (the 6)
  const pkgKeys = [
    "npx tsc --noEmit",
    'npx -y "github:orobsonn/claude-harness#v*" init --target opencode',
    'npx -y "github:orobsonn/claude-harness#v*" init --target claude',
    'npx -y "github:orobsonn/claude-harness#v*" init --target both',
    "npm test",
    "npm run typecheck",
  ];
  for (const k of pkgKeys) {
    assert.equal(bash[k], "allow", `expected allow for package key: ${k}`);
  }

  // every github:orobsonn key contains ' init'
  for (const k of Object.keys(bash)) {
    if (k.includes("github:orobsonn")) {
      assert.match(k, / init/, `github key must contain ' init': ${k}`);
    }
  }

  // no allow key equal to the forbidden open globs
  const forbidden = ["node *", "npm run *", "npx *"];
  for (const k of Object.keys(bash)) {
    if (bash[k] === "allow") {
      assert.equal(forbidden.includes(k), false, `must not have broad allow: ${k}`);
    }
  }

  // ceremony keys present
  assert.equal(bash["node .opencode/plugin/lib/mark-gate.mjs *"], "allow");
  assert.equal(bash["node core/opencode/plugin/lib/mark-gate.mjs *"], "allow");

  // gh * , node --test * , git status* present (as allow)
  assert.equal(bash["gh *"], "allow");
  assert.equal(bash["node --test *"], "allow");
  assert.equal(bash["git status*"], "allow");
});

// ── anti-QUICK-launder + review-cap delivery rails (#72) ──────────────────

test("hasElevatedCeremonyResidue detects peak LIGHT and failure cap", () => {
  assert.equal(hasElevatedCeremonyResidue({ peak_mode: "LIGHT" }), true);
  assert.equal(hasElevatedCeremonyResidue({ review_status: "primary_failure_cap_reached" }), true);
  assert.equal(hasElevatedCeremonyResidue({ brainstormed: true }), true);
  assert.equal(hasElevatedCeremonyResidue({ mode: "QUICK", classified: true }), false);
});

test("QUICK ship after primary_failure_cap → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: quickCeremony({ review_status: "primary_failure_cap_reached" }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /review_status=primary_failure_cap_reached|review-cap/);
});

test("QUICK ship after prior LIGHT peak_mode → deny launder", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    gateState: quickCeremony({ peak_mode: "LIGHT", dual_status: { adversary: "primary_only" } }),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /QUICK delivery denied|quick-launder|elevated ceremony/);
});

test("genuine QUICK without residue still allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: quickCeremony(),
    ...cleanDeps(),
  });
  assert.equal(d.decision, "allow");
});

test("LIGHT ship blocked while primary_failure_cap_reached even with ceremony", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony({ review_status: "primary_failure_cap_reached" }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /primary_failure_cap_reached/);
});

test("LIGHT ship denied when planner_status not usable", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony({ planner_status: "planner_unavailable" }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /planner_status=usable|planner-not-usable/);
});

test("LIGHT ship denied when delivery_status delivery-blocked", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    gateState: lightCeremony({
      planner_status: "usable",
      delivery_status: "delivery-blocked",
    }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /delivery-blocked/);
});

test("LIGHT ship allow when planner usable + ceremony + capture", () => {
  const d = decideBashDelivery({
    command: "git push",
    gateState: lightCeremony({ planner_status: "usable", delivery_status: "ready" }),
    ...cleanDepsWithCapture(),
  });
  assert.equal(d.decision, "allow");
});
