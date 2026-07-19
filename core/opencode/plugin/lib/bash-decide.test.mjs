/** @description Locked tests for OC bash delivery + forge decide (session-275 + U2 rails). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  decideBashDelivery,
  decideBashForge,
  firstArgvBasename,
  isStateForgeCommand,
  isExpandingRedirect,
  hasShellChainMetacharacters,
  isHarnessPrescribedPackageCommand,
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

// ── forge cases (unchanged) ───────────────────────────────────────────────

test("forge cat gate-state → deny", () => {
  const d = decideBashForge({
    command: "cat > .opencode/plans/.state/ses_x/gate-state.json <<EOF\n{}\nEOF",
  });
  assert.equal(d.decision, "deny");
});

test("forge triage.json → deny", () => {
  const d = decideBashForge({
    command: "tee .opencode/plans/.state/s/triage.json < /tmp/x",
  });
  assert.equal(d.decision, "deny");
});

test("execution-plan.json bash write → allow (orchestrator plan channel)", () => {
  const d = decideBashForge({
    command: "cat > .opencode/plans/feat/execution-plan.json <<EOF\n{}\nEOF",
  });
  assert.equal(d.decision, "allow");
});

test("mark-gate path-bound harness script → allow forge path", () => {
  assert.equal(firstArgvBasename("node core/opencode/plugin/lib/mark-gate.mjs stamp"), "mark-gate");
  // pure single command: oracle path as arg, no chain/redirect
  const d = decideBashForge({
    command:
      "node core/opencode/plugin/lib/mark-gate.mjs stamp --session ses_x .opencode/plans/.state/ses_x/gate-state.json",
  });
  assert.equal(d.decision, "allow");
  const vendored = decideBashForge({
    command:
      "node .opencode/plugin/lib/mark-gate.mjs dual --session ses_x --status both",
  });
  assert.equal(vendored.decision, "allow");
});

test("CC marker CLI .claude/hooks/classify.mjs → deny with OC redirect (#291)", () => {
  const d = decideBashForge({
    command: "node .claude/hooks/classify.mjs --mode LIGHT --feature-id capture-verified",
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /Claude-Code marker|classify tool|mark-gate/i);
});

test("CC marker CLI core/claude-code/hooks/mark.mjs → deny under OC", () => {
  const d = decideBashForge({
    command: "node core/claude-code/hooks/mark.mjs brainstorm-done --feature-id f",
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /Claude-Code marker|mark-gate/i);
});

test("impostor /tmp/mark-gate.mjs basename → deny forge", () => {
  const d = decideBashForge({
    command:
      "node /tmp/mark-gate.mjs stamp --session ses_x .opencode/plans/.state/ses_x/gate-state.json",
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /anti-forgery|path-bound|gate-state/i);
});

test("native mark authority cannot execute or import through ordinary bash", () => {
  for (const command of [
    "node core/opencode/plugin/marker-authority.ts",
    "node .opencode/plugin/marker-authority.ts",
    "node --input-type=module -e \"import './core/opencode/plugin/lib/marker-capability.mjs'\"",
    "node --input-type=module -e \"import './.opencode/tools/lib/mark-native.mjs'\"",
  ]) {
    const decision = decideBashForge({ command });
    assert.equal(decision.decision, "deny", command);
    assert.match(decision.reason, /host|authority|marker/i);
  }
});

test("impostor ./evil/mark-gate.mjs → deny forge", () => {
  const d = decideBashForge({
    command:
      "node ./evil/mark-gate.mjs stamp .opencode/plans/.state/s/gate-state.json",
  });
  assert.equal(d.decision, "deny");
});

test("node -e encoded/concat path forge → deny (no literal oracle required)", () => {
  const joinPath = decideBashForge({
    command:
      'node -e \'require("fs").writeFileSync([".opencode","plans",".state","s","gate"+"-state.json"].join("/"),"{}")\'',
  });
  assert.equal(joinPath.decision, "deny");
  assert.match(joinPath.reason, /eval one-liner|anti-forgery/i);

  // Split base64 so secret-scanner does not flag the fixture as a leaked token.
  const b64 = decideBashForge({
    command:
      'node -e \'require("fs").writeFileSync(Buffer.from("Lm9wZW5jb2Rl"+"L3BsYW5zLy5zdGF0ZS9zL2dhdGUtc3RhdGUuanNvbg==","base64").toString(),"{}")\'',
  });
  assert.equal(b64.decision, "deny");

  const py = decideBashForge({
    command: 'python3 -c \'open("/tmp/x","w").write("x")\'',
  });
  assert.equal(py.decision, "deny");
});

test("node /tmp/evil.mjs drop → deny even without oracle substring", () => {
  const d = decideBashForge({
    command: "node /tmp/evil.mjs",
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /\/tmp|impostor|anti-forgery/i);
});

test("suffix impostor evil/.opencode/plugin/lib/mark-gate.mjs → deny", () => {
  const d = decideBashForge({
    command:
      "node evil/.opencode/plugin/lib/mark-gate.mjs stamp .opencode/plans/.state/s/gate-state.json",
  });
  assert.equal(d.decision, "deny");
});

test("cwd-drop node w.mjs → deny (two-step forge)", () => {
  const d = decideBashForge({ command: "node w.mjs" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /two-step|markers|anti-forgery/i);
});

test("multi-seg scripts/forge.mjs → deny (two-step forge)", () => {
  const d = decideBashForge({ command: "node scripts/forge-gate.mjs" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /two-step|markers|anti-forgery/i);
});

test("bash -c encoded write → deny", () => {
  const d = decideBashForge({
    command: 'bash -c "echo hi > /tmp/x"',
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /nested shells|anti-forgery/i);
});

test("ash -c also deny", () => {
  assert.equal(decideBashForge({ command: "ash -c 'echo x'" }).decision, "deny");
});

test("node --require=./x.js -e eval → deny", () => {
  const d = decideBashForge({
    command: 'node --require=./x.js -e "console.log(1)"',
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /eval one-liner|preload|anti-forgery/i);
});

test("node --require=./forge.js core/x.mjs → deny preload", () => {
  const d = decideBashForge({
    command: "node --require=./forge.js core/opencode/plugin/lib/bash-decide.test.mjs",
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /preload|anti-forgery/i);
});

test("node *.test.mjs multi-segment still allow", () => {
  const d = decideBashForge({
    command: "node core/opencode/plugin/lib/bash-decide.test.mjs",
  });
  assert.equal(d.decision, "allow");
});

test("node --test suite allow", () => {
  const d = decideBashForge({
    command: "node --test core/opencode/plugin/lib/bash-decide.test.mjs",
  });
  assert.equal(d.decision, "allow");
});

test("allowlisted vendor-core tooling allow", () => {
  const d = decideBashForge({
    command:
      "node core/claude-code/skills/initializing-projects/references/vendor-core.mjs --help",
  });
  assert.equal(d.decision, "allow");
});

test("cwd evil.test.mjs → deny (test only under core|modules|.opencode)", () => {
  assert.equal(decideBashForge({ command: "node evil.test.mjs" }).decision, "deny");
});

test("node --test evil.mjs → deny", () => {
  assert.equal(
    decideBashForge({ command: "node --test evil.mjs" }).decision,
    "deny",
  );
});

test("node --import=./forge.mjs marker → deny preload", () => {
  assert.equal(
    decideBashForge({
      command:
        "node --import=./forge.mjs core/opencode/plugin/lib/mark-gate.mjs dual --session s --status both",
    }).decision,
    "deny",
  );
});

test("NODE_OPTIONS=--require=./f.js node marker → deny", () => {
  assert.equal(
    decideBashForge({
      command:
        "NODE_OPTIONS=--require=./f.js node core/opencode/plugin/lib/mark-gate.mjs dual --session s --status both",
    }).decision,
    "deny",
  );
});

test("env node evil.mjs → deny", () => {
  assert.equal(decideBashForge({ command: "env node evil.mjs" }).decision, "deny");
});

test("./evil.mjs direct exec → deny", () => {
  assert.equal(decideBashForge({ command: "./evil.mjs" }).decision, "deny");
});

test("bash scripts/x.sh → deny", () => {
  assert.equal(
    decideBashForge({ command: "bash scripts/x.sh" }).decision,
    "deny",
  );
});

test("base64 | bash → deny", () => {
  assert.equal(
    decideBashForge({ command: "base64 -d <<< abc | bash" }).decision,
    "deny",
  );
});

test("redirect with $ expansion → deny", () => {
  assert.equal(
    decideBashForge({
      command: "echo x > .opencode/$p/.$s/sess/$g.json",
    }).decision,
    "deny",
  );
});

test("plan heredoc without $ still allow", () => {
  assert.equal(
    decideBashForge({
      command:
        "cat > .opencode/plans/feat/execution-plan.json <<EOF\n{}\nEOF",
    }).decision,
    "allow",
  );
});

test("tar extract → deny", () => {
  assert.equal(
    decideBashForge({ command: "tar -xzf drop.tgz" }).decision,
    "deny",
  );
  assert.equal(decideBashForge({ command: "tar xf drop.tgz" }).decision, "deny");
  assert.equal(decideBashForge({ command: "7z x drop.7z" }).decision, "deny");
});

test("cp overwrite mark-gate.mjs → deny", () => {
  assert.equal(
    decideBashForge({
      command: "cp /tmp/x core/opencode/plugin/lib/mark-gate.mjs",
    }).decision,
    "deny",
  );
});

test("source evil.sh → deny", () => {
  assert.equal(decideBashForge({ command: "source evil.sh" }).decision, "deny");
  assert.equal(decideBashForge({ command: ". ./evil.sh" }).decision, "deny");
  assert.equal(decideBashForge({ command: "bash < evil.sh" }).decision, "deny");
});

test("npm run / make → deny; npm test / npm ci allow (paired oracle)", () => {
  const runBuild = "npm run build";
  assert.equal(decideBashForge({ command: runBuild }).decision, "deny");
  assert.equal(isStateForgeCommand(runBuild), true);

  const makeAll = "make all";
  assert.equal(decideBashForge({ command: makeAll }).decision, "deny");
  assert.equal(isStateForgeCommand(makeAll), true);

  const npmTest = "npm test";
  assert.equal(decideBashForge({ command: npmTest }).decision, "allow");
  assert.equal(isStateForgeCommand(npmTest), false);

  const npmCi = "npm ci";
  assert.equal(decideBashForge({ command: npmCi }).decision, "allow");
  assert.equal(isStateForgeCommand(npmCi), false);
});

test("known package/interpreter denials expose exact closed resolver class", () => {
  const launcher = decideBashForge({ command: "npx vitest run core/a.test.mjs" });
  assert.equal(launcher.decision, "deny");
  assert.deepEqual(launcher.details, { denied_class: "package_launcher", resolver: "verify" });
  assert.match(launcher.reason, /call native `verify` once/i);

  const interpreter = decideBashForge({ command: "node node_modules/vitest/vitest.mjs run core/a.test.mjs" });
  assert.equal(interpreter.decision, "deny");
  assert.deepEqual(interpreter.details, { denied_class: "interpreter", resolver: "verify" });
  assert.match(interpreter.reason, /registered targeted-test equivalent/i);
});

test("cp forged.json $GS expansion → deny", () => {
  assert.equal(
    decideBashForge({
      command: "GS=.opencode/plans/.state/s/gate-state.json cp forged.json $GS",
    }).decision,
    "deny",
  );
});

test("mark-gate with stdout redirect to .state → deny forge", () => {
  const d = decideBashForge({
    command:
      "node core/opencode/plugin/lib/mark-gate.mjs stamp --session ses_x > .opencode/plans/.state/ses_x/gate-state.json",
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /anti-forgery|gate-state|plans\/\.state/i);
});

test("mark-gate + shell chain ; cat forge → deny", () => {
  const d = decideBashForge({
    command:
      "node core/opencode/plugin/lib/mark-gate.mjs stamp --session ses_x ; cat > .opencode/plans/.state/x",
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /anti-forgery|gate-state|plans\/\.state/i);
});

test("mark-gate + && / || / | / $( / backtick chain → deny", () => {
  for (const command of [
    "node mark-gate.mjs stamp && cat > .opencode/plans/.state/x",
    "node mark-gate.mjs stamp || cat > .opencode/plans/.state/x",
    "node mark-gate.mjs stamp | tee .opencode/plans/.state/x",
    "node mark-gate.mjs stamp $(echo .opencode/plans/.state/x)",
    "node mark-gate.mjs stamp `echo .opencode/plans/.state/x`",
    "node mark-gate.mjs stamp\ncat > .opencode/plans/.state/x",
  ]) {
    assert.equal(
      decideBashForge({ command }).decision,
      "deny",
      `expected deny for: ${command}`,
    );
  }
});

test("dual-merge basename NOT allowlisted", () => {
  assert.equal(firstArgvBasename("node dual-merge.mjs"), "dual-merge");
  const d = decideBashForge({
    command: "node dual-merge.mjs > .opencode/plans/.state/s/gate-state.json",
  });
  assert.equal(d.decision, "deny");
});

test("forge cp into gate-state.json → deny (no > required)", () => {
  const d = decideBashForge({
    command: "cp /tmp/x .opencode/plans/.state/s/gate-state.json",
  });
  assert.equal(d.decision, "deny");
});

test("forge node -e writeFileSync gate-state → deny", () => {
  const d = decideBashForge({
    command:
      "node -e \"fs.writeFileSync('.opencode/plans/.state/s/gate-state.json','{}')\"",
  });
  assert.equal(d.decision, "deny");
});

test("forge mv/rsync state oracle paths → deny", () => {
  assert.equal(
    decideBashForge({
      command: "mv /tmp/x .opencode/plans/.state/s/triage.json",
    }).decision,
    "deny",
  );
  assert.equal(
    decideBashForge({
      command: "rsync /tmp/x .opencode/plans/.state/s/gate-state.json",
    }).decision,
    "deny",
  );
  // plan path is not a state oracle
  assert.equal(
    decideBashForge({
      command: "rsync /tmp/x .opencode/plans/feat/execution-plan.json",
    }).decision,
    "allow",
  );
});

test("oracle path without allowlist basename → deny even ls of .state", () => {
  const d = decideBashForge({
    command: "ls .opencode/plans/.state",
  });
  assert.equal(d.decision, "deny");
});

test("non-oracle path → allow forge check", () => {
  const d = decideBashForge({ command: "cp /tmp/a /tmp/b" });
  assert.equal(d.decision, "allow");
});

test("quoted spec heredoc treats punctuation and source-like prose as literal content", () => {
  const command = [
    "cat > .opencode/plans/ses-1-price/spec.md <<'EOF'",
    "Existing contracts. Auth and upstream errors stay sanitized.",
    "source evil.sh is documentation here, not a shell command.",
    ". another sentence fragment is also literal Markdown.",
    "EOF",
  ].join("\n");
  assert.equal(decideBashForge({ command }).decision, "allow");
  assert.equal(isStateForgeCommand(command), false);
});

test("quoted heredoc with $ / ${} / backticks in body is allow (literal payload, #72 false deny)", () => {
  const command = [
    "cat > .opencode/plans/ses_x-feat/spec.md <<'EOF'",
    "Price is $100. Template ${var}. Docs show $(date) and `code`.",
    "const x = process.env.FOO",
    "EOF",
  ].join("\n");
  assert.equal(decideBashForge({ command }).decision, "allow", "quoted body $ must not trip expanding-redirect");
  assert.equal(isExpandingRedirect(command), false);
  assert.equal(isStateForgeCommand(command), false);

  const plan = [
    "cat > .opencode/plans/ses_x-feat/execution-plan.json <<'EOF'",
    '{"feature_id":"feat","mode":"light","tasks":[{"id":"t1","title":"use $x"}]}',
    "EOF",
  ].join("\n");
  assert.equal(decideBashForge({ command: plan }).decision, "allow");
});

test("unquoted heredoc with $ in body still deny (shell expands)", () => {
  const command = [
    "cat > .opencode/plans/ses_x-feat/spec.md <<EOF",
    "price $HOME",
    "EOF",
  ].join("\n");
  assert.equal(decideBashForge({ command }).decision, "deny");
  assert.equal(isExpandingRedirect(command), true);
});

test("$SPEC_DIR plan/spec write (no .state) allow — #72 headless false deny", () => {
  const command = [
    'SPEC_DIR=".opencode/plans/ses_x-feat"',
    'mkdir -p "$SPEC_DIR"',
    "cat > \"$SPEC_DIR/spec.md\" <<'SPECEOF'",
    "CTA/CTD rules with $100 in prose",
    "SPECEOF",
    'printf "%s\\n" "| fail_closed | x |" >> .opencode/decision-ledger.md',
    'ls -la "$SPEC_DIR/"',
  ].join("\n");
  assert.equal(isExpandingRedirect(command), false);
  assert.equal(decideBashForge({ command }).decision, "allow");
});

test("opaque > $GS still deny; expansion + .state still deny", () => {
  assert.equal(
    decideBashForge({ command: "echo forged > $GS" }).decision,
    "deny",
  );
  assert.equal(
    decideBashForge({
      command: 'echo forged > "$GS"; GS=.opencode/plans/.state/s/gate-state.json',
    }).decision,
    "deny",
  );
  assert.equal(
    decideBashForge({
      command: "cat forged.json > .opencode/plans/.state/$sid/gate-state.json",
    }).decision,
    "deny",
  );
});test("source command after a quoted heredoc terminator remains denied", () => {
  const command = [
    "cat > .opencode/plans/ses-1-price/spec.md <<'EOF'",
    "source evil.sh is literal payload.",
    "EOF",
    "source evil.sh",
  ].join("\n");
  assert.equal(decideBashForge({ command }).decision, "deny");
  assert.equal(isStateForgeCommand(command), true);
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

// ── harness-prescribed package runner allow/deny (post-fix target) ──────────

/** @description decideBashForge + isStateForgeCommand: npx tsc --noEmit → allow */
test("decideBashForge + isStateForgeCommand: npx tsc --noEmit → allow", () => {
  const cmd = "npx tsc --noEmit";
  assert.equal(decideBashForge({ command: cmd }).decision, "allow");
  assert.equal(isStateForgeCommand(cmd), false);
});

/** @description Harness updater without an explicit runtime target is denied. */
test("decideBashForge + isStateForgeCommand: harness updater without target is denied", () => {
  const cmd = "npx github:orobsonn/claude-harness#v0.43.1 init";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description Exact stable release updater command is allowed. */
test("decideBashForge + isStateForgeCommand: exact stable release updater is allowed", () => {
  const cmd = 'npx -y "github:orobsonn/claude-harness#v0.43.1" init --target both';
  assert.equal(decideBashForge({ command: cmd }).decision, "allow");
  assert.equal(isStateForgeCommand(cmd), false);
});

/** @description Branch refs cannot replace the harness through the updater lane. */
test("decideBashForge + isStateForgeCommand: harness updater branch ref is denied", () => {
  const cmd = 'npx -y "github:orobsonn/claude-harness#feature/x" init --target both';
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npx github:... init --target opencode → allow */
test("decideBashForge + isStateForgeCommand: npx github:orobsonn/claude-harness#v0.43.1 init --target opencode → allow", () => {
  const cmd = "npx github:orobsonn/claude-harness#v0.43.1 init --target opencode";
  assert.equal(decideBashForge({ command: cmd }).decision, "allow");
  assert.equal(isStateForgeCommand(cmd), false);
});

/** @description decideBashForge + isStateForgeCommand: npm test → allow */
test("decideBashForge + isStateForgeCommand: npm test → allow", () => {
  const cmd = "npm test";
  assert.equal(decideBashForge({ command: cmd }).decision, "allow");
  assert.equal(isStateForgeCommand(cmd), false);
});

/** @description decideBashForge + isStateForgeCommand: npm run typecheck → allow */
test("decideBashForge + isStateForgeCommand: npm run typecheck → allow", () => {
  const cmd = "npm run typecheck";
  assert.equal(decideBashForge({ command: cmd }).decision, "allow");
  assert.equal(isStateForgeCommand(cmd), false);
});

/** @description decideBashForge + isStateForgeCommand: npm run build-malicious-thing → deny */
test("decideBashForge + isStateForgeCommand: npm run build-malicious-thing → deny", () => {
  const cmd = "npm run build-malicious-thing";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npx evil-pkg → deny */
test("decideBashForge + isStateForgeCommand: npx evil-pkg → deny", () => {
  const cmd = "npx evil-pkg";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npx github:... (no init) → deny */
test("decideBashForge + isStateForgeCommand: npx github:orobsonn/claude-harness#v0.43.1 (no init) → deny", () => {
  const cmd = "npx github:orobsonn/claude-harness#v0.43.1";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npm test --prefix /tmp/evil → deny */
test("decideBashForge + isStateForgeCommand: npm test --prefix /tmp/evil → deny", () => {
  const cmd = "npm test --prefix /tmp/evil";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npm test -C /tmp/evil → deny */
test("decideBashForge + isStateForgeCommand: npm test -C /tmp/evil → deny", () => {
  const cmd = "npm test -C /tmp/evil";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: PATH=/tmp/x npx tsc --noEmit → deny */
test("decideBashForge + isStateForgeCommand: PATH=/tmp/x npx tsc --noEmit → deny", () => {
  const cmd = "PATH=/tmp/x npx tsc --noEmit";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npm_config_prefix=/tmp/evil npm test → deny */
test("decideBashForge + isStateForgeCommand: npm_config_prefix=/tmp/evil npm test → deny", () => {
  const cmd = "npm_config_prefix=/tmp/evil npm test";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: env npm test → deny */
test("decideBashForge + isStateForgeCommand: env npm test → deny", () => {
  const cmd = "env npm test";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: NODE_OPTIONS=--require=x npm test → deny */
test("decideBashForge + isStateForgeCommand: NODE_OPTIONS=--require=x npm test → deny", () => {
  const cmd = "NODE_OPTIONS=--require=x npm test";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npx tsc --noEmit && true → deny */
test("decideBashForge + isStateForgeCommand: npx tsc --noEmit && true → deny", () => {
  const cmd = "npx tsc --noEmit && true";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npm test ; echo x → deny */
test("decideBashForge + isStateForgeCommand: npm test ; echo x → deny", () => {
  const cmd = "npm test ; echo x";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npm test & true → deny */
test("decideBashForge + isStateForgeCommand: npm test & true → deny", () => {
  const cmd = "npm test & true";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npm test $FOO → deny */
test("decideBashForge + isStateForgeCommand: npm test $FOO → deny", () => {
  const cmd = "npm test $FOO";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npm test -- --watch → deny */
test("decideBashForge + isStateForgeCommand: npm test -- --watch → deny", () => {
  const cmd = "npm test -- --watch";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npm run typecheck --strict → deny */
test("decideBashForge + isStateForgeCommand: npm run typecheck --strict → deny", () => {
  const cmd = "npm run typecheck --strict";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: npm run lint → deny */
test("decideBashForge + isStateForgeCommand: npm run lint → deny", () => {
  const cmd = "npm run lint";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description decideBashForge + isStateForgeCommand: make all → deny */
test("decideBashForge + isStateForgeCommand: make all → deny", () => {
  const cmd = "make all";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description hasShellChainMetacharacters detects & (post extension) */
test("hasShellChainMetacharacters: npx tsc --noEmit & true → true", () => {
  assert.equal(hasShellChainMetacharacters("npx tsc --noEmit & true"), true);
});

/** @description isHarnessPrescribedPackageCommand contract */
test("isHarnessPrescribedPackageCommand: non-string/empty false; prescribed true; run false; wrapper false", () => {
  assert.equal(isHarnessPrescribedPackageCommand(undefined), false);
  assert.equal(isHarnessPrescribedPackageCommand(""), false);
  assert.equal(isHarnessPrescribedPackageCommand("npx tsc --noEmit"), true);
  assert.equal(isHarnessPrescribedPackageCommand("npm run build"), false);
  // wrapper-prefixed (env / VAR=) must be false for the prescribed fn itself
  assert.equal(isHarnessPrescribedPackageCommand("env npx tsc --noEmit"), false);
  assert.equal(isHarnessPrescribedPackageCommand("PATH=/x npx tsc --noEmit"), false);
});

// ── wall-hole closes (sniper-high: override flags / env -i / npm flags / bash opts) ──

/** @description github init + --prefix → deny+forge (#ac-2.6 word-boundary hole) */
test("decideBashForge + isStateForgeCommand: npx github:… init --prefix /tmp/evil → deny", () => {
  const cmd = "npx github:orobsonn/claude-harness#v0.43.1 init --prefix /tmp/evil";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
  assert.equal(isHarnessPrescribedPackageCommand(cmd), false);
});

/** @description github init + -C → deny+forge */
test("decideBashForge + isStateForgeCommand: npx github:… init -C /tmp/evil → deny", () => {
  const cmd = "npx github:orobsonn/claude-harness#v0.43.1 init -C /tmp/evil";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
  assert.equal(isHarnessPrescribedPackageCommand(cmd), false);
});

/** @description github init + --workspace → deny+forge */
test("decideBashForge + isStateForgeCommand: npx github:… init --workspace evil → deny", () => {
  const cmd = "npx github:orobsonn/claude-harness#v0.43.1 init --workspace evil";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
  assert.equal(isHarnessPrescribedPackageCommand(cmd), false);
});

/** @description env -i node evil.mjs → deny (complex env residual) */
test("decideBashForge + isStateForgeCommand: env -i node evil.mjs → deny", () => {
  const cmd = "env -i node evil.mjs";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description npm --prefix /tmp/evil test → deny (lifecycle with intervening flags) */
test("decideBashForge + isStateForgeCommand: npm --prefix /tmp/evil test → deny", () => {
  const cmd = "npm --prefix /tmp/evil test";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description npm -C x run typecheck → deny (lifecycle with intervening flags) */
test("decideBashForge + isStateForgeCommand: npm -C /tmp/evil run typecheck → deny", () => {
  const cmd = "npm -C /tmp/evil run typecheck";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description bash --noprofile -c → deny (shell -c with intervening options) */
test("decideBashForge + isStateForgeCommand: bash --noprofile -c \"echo x\" → deny", () => {
  const cmd = 'bash --noprofile -c "echo x"';
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description keep green: npx tsc / npm test / npm ci still allow */
test("wall-hole closes keep green: npx tsc --noEmit / npm test / npm ci allow", () => {
  assert.equal(decideBashForge({ command: "npx tsc --noEmit" }).decision, "allow");
  assert.equal(isStateForgeCommand("npx tsc --noEmit"), false);
  assert.equal(decideBashForge({ command: "npm test" }).decision, "allow");
  assert.equal(isStateForgeCommand("npm test"), false);
  assert.equal(decideBashForge({ command: "npm ci" }).decision, "allow");
  assert.equal(isStateForgeCommand("npm ci"), false);
});

// ── wall-hole closes round-2 (sniper-high: aliases / dlx / prefix / attached / shell / node --test) ──

/** @description npm run-script alias → deny */
test("decideBashForge + isStateForgeCommand: npm run-script build-malicious-thing → deny", () => {
  const cmd = "npm run-script build-malicious-thing";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description npm x alias → deny */
test("decideBashForge + isStateForgeCommand: npm x evil-pkg → deny", () => {
  const cmd = "npm x evil-pkg";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description pnpm dlx / yarn dlx / bunx → deny */
test("decideBashForge + isStateForgeCommand: pnpm dlx / yarn dlx / bunx evil → deny", () => {
  for (const cmd of ["pnpm dlx evil", "yarn dlx evil", "bunx evil"]) {
    assert.equal(decideBashForge({ command: cmd }).decision, "deny", `expected deny for: ${cmd}`);
    assert.equal(isStateForgeCommand(cmd), true, `expected forge for: ${cmd}`);
  }
});

/** @description prefix wrappers around npm lifecycle → deny (not prescribed) */
test("decideBashForge + isStateForgeCommand: time npm run evil → deny", () => {
  const cmd = "time npm run evil";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
  assert.equal(isHarnessPrescribedPackageCommand(cmd), false);
});

/** @description prefix wrappers: command/nice/nohup/corepack npm run → deny */
test("decideBashForge + isStateForgeCommand: command/nice/nohup/corepack npm run evil → deny", () => {
  for (const cmd of [
    "command npm run evil",
    "nice npm run evil",
    "nohup npm run evil",
    "corepack npm run evil",
  ]) {
    assert.equal(decideBashForge({ command: cmd }).decision, "deny", `expected deny for: ${cmd}`);
    assert.equal(isStateForgeCommand(cmd), true, `expected forge for: ${cmd}`);
    assert.equal(isHarnessPrescribedPackageCommand(cmd), false);
  }
});

/** @description attached short -C override on github init → deny */
test("decideBashForge + isStateForgeCommand: npx github:… init -C/tmp/evil → deny", () => {
  const cmd = "npx github:orobsonn/claude-harness#v0.43.1 init -C/tmp/evil";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
  assert.equal(isHarnessPrescribedPackageCommand(cmd), false);
});

/** @description time bash -c → deny (shell basename not only argv0) */
test("decideBashForge + isStateForgeCommand: time bash -c \"echo x\" → deny", () => {
  const cmd = 'time bash -c "echo x"';
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description command bash --noprofile -c → deny */
test("decideBashForge + isStateForgeCommand: command bash --noprofile -c \"echo x\" → deny", () => {
  const cmd = 'command bash --noprofile -c "echo x"';
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description bash -o pipefail -c → deny (skip value-taking -o) */
test("decideBashForge + isStateForgeCommand: bash -o pipefail -c \"echo x\" → deny", () => {
  const cmd = 'bash -o pipefail -c "echo x"';
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description bare node --test (cwd discovery) → deny */
test("decideBashForge + isStateForgeCommand: node --test → deny", () => {
  const cmd = "node --test";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description keep green: authorized node --test path still allow */
test("wall-hole round-2 keep green: node --test authorized path / npx tsc / npm test allow", () => {
  assert.equal(
    decideBashForge({
      command: "node --test core/opencode/plugin/lib/bash-decide.test.mjs",
    }).decision,
    "allow",
  );
  assert.equal(decideBashForge({ command: "npx tsc --noEmit" }).decision, "allow");
  assert.equal(decideBashForge({ command: "npm test" }).decision, "allow");
  assert.equal(decideBashForge({ command: "npm ci" }).decision, "allow");
});

// ── wall-hole closes round-3 (sniper-high: .. path / quotes / chain / reporter / pnpx) ──

/** @description path traversal core/../evil.test.mjs → deny */
test("decideBashForge + isStateForgeCommand: node core/../evil.test.mjs → deny", () => {
  const cmd = "node core/../evil.test.mjs";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description node --test with path traversal → deny */
test("decideBashForge + isStateForgeCommand: node --test core/../evil.test.mjs → deny", () => {
  const cmd = "node --test core/../evil.test.mjs";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description shell-quoted package manager binary → deny lifecycle */
test('decideBashForge + isStateForgeCommand: "npm" run evil → deny', () => {
  const cmd = '"npm" run evil';
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description single-quoted package manager binary → deny lifecycle */
test("decideBashForge + isStateForgeCommand: 'npm' run evil → deny", () => {
  const cmd = "'npm' run evil";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description authorized test + shell chain → deny (multi-command forge) */
test("decideBashForge + isStateForgeCommand: node authorized.test.mjs && python3 evil.py → deny", () => {
  const cmd =
    "node core/opencode/plugin/lib/bash-decide.test.mjs && python3 evil.py";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description node --test + custom --test-reporter module → deny */
test("decideBashForge + isStateForgeCommand: node --test … --test-reporter ./evil.mjs → deny", () => {
  const cmd =
    "node --test core/opencode/plugin/lib/bash-decide.test.mjs --test-reporter ./evil.mjs";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description pnpx like bunx/npx → deny */
test("decideBashForge + isStateForgeCommand: pnpx evil → deny", () => {
  const cmd = "pnpx evil";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description keep green after round-3: prescribed package + authorized test + mark-gate */
test("wall-hole round-3 keep green: npx tsc / npm test / npm ci / node --test / mark-gate allow", () => {
  assert.equal(decideBashForge({ command: "npx tsc --noEmit" }).decision, "allow");
  assert.equal(isStateForgeCommand("npx tsc --noEmit"), false);
  assert.equal(decideBashForge({ command: "npm test" }).decision, "allow");
  assert.equal(isStateForgeCommand("npm test"), false);
  assert.equal(decideBashForge({ command: "npm ci" }).decision, "allow");
  assert.equal(isStateForgeCommand("npm ci"), false);
  assert.equal(
    decideBashForge({
      command: "node --test core/opencode/plugin/lib/bash-decide.test.mjs",
    }).decision,
    "allow",
  );
  assert.equal(
    decideBashForge({
      command: "node core/opencode/plugin/lib/bash-decide.test.mjs",
    }).decision,
    "allow",
  );
  assert.equal(
    decideBashForge({
      command:
        "node core/opencode/plugin/lib/mark-gate.mjs stamp --session ses_x .opencode/plans/.state/ses_x/gate-state.json",
    }).decision,
    "allow",
  );
});

// ── wall-hole closes round-4 (sniper-high: NODE_OPTIONS reporter / yarn|pnpm node|exec / command node) ──

/** @description NODE_OPTIONS=--test-reporter=./evil.mjs node --test authorized → deny */
test("decideBashForge + isStateForgeCommand: NODE_OPTIONS=--test-reporter=./evil.mjs node --test authorized → deny", () => {
  const cmd =
    "NODE_OPTIONS=--test-reporter=./evil.mjs node --test core/opencode/plugin/lib/bash-decide.test.mjs";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description yarn node / pnpm node / yarn exec → deny (package-manager interpreter lifecycle) */
test("decideBashForge + isStateForgeCommand: yarn node / pnpm node / yarn exec evil → deny", () => {
  for (const cmd of ["yarn node evil.mjs", "pnpm node evil.mjs", "yarn exec evil"]) {
    assert.equal(decideBashForge({ command: cmd }).decision, "deny", `expected deny for: ${cmd}`);
    assert.equal(isStateForgeCommand(cmd), true, `expected forge for: ${cmd}`);
  }
});

/** @description command node evil.mjs → deny (interpreter basename not only argv0) */
test("decideBashForge + isStateForgeCommand: command node evil.mjs → deny", () => {
  const cmd = "command node evil.mjs";
  assert.equal(decideBashForge({ command: cmd }).decision, "deny");
  assert.equal(isStateForgeCommand(cmd), true);
});

/** @description keep green: authorized node --test / mark-gate / command node mark-gate / prescribed packages */
test("wall-hole round-4 keep green: node --test / mark-gate / command node mark-gate / npx tsc / npm test / npm ci allow", () => {
  assert.equal(
    decideBashForge({
      command: "node --test core/opencode/plugin/lib/bash-decide.test.mjs",
    }).decision,
    "allow",
  );
  assert.equal(
    decideBashForge({
      command:
        "node core/opencode/plugin/lib/mark-gate.mjs stamp --session ses_x .opencode/plans/.state/ses_x/gate-state.json",
    }).decision,
    "allow",
  );
  assert.equal(
    decideBashForge({
      command:
        "command node core/opencode/plugin/lib/mark-gate.mjs stamp --session ses_x .opencode/plans/.state/ses_x/gate-state.json",
    }).decision,
    "allow",
  );
  assert.equal(decideBashForge({ command: "npx tsc --noEmit" }).decision, "allow");
  assert.equal(isStateForgeCommand("npx tsc --noEmit"), false);
  assert.equal(decideBashForge({ command: "npm test" }).decision, "allow");
  assert.equal(isStateForgeCommand("npm test"), false);
  assert.equal(decideBashForge({ command: "npm ci" }).decision, "allow");
  assert.equal(isStateForgeCommand("npm ci"), false);
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
