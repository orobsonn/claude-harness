/** @description Locked tests for OC bash delivery + forge decide (session-275 + U2 rails). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideBashDelivery,
  decideBashForge,
  firstArgvBasename,
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

test("missing sessionId + delivery → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    gateState: quickCeremony(),
    sessionId: null,
  });
  assert.equal(d.decision, "deny");
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

test("impostor /tmp/mark-gate.mjs basename → deny forge", () => {
  const d = decideBashForge({
    command:
      "node /tmp/mark-gate.mjs stamp --session ses_x .opencode/plans/.state/ses_x/gate-state.json",
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /anti-forgery|path-bound|gate-state/i);
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

test("npm run / make / npm test → deny; npm ci allow", () => {
  assert.equal(decideBashForge({ command: "npm run build" }).decision, "deny");
  assert.equal(decideBashForge({ command: "make all" }).decision, "deny");
  assert.equal(decideBashForge({ command: "npm test" }).decision, "deny");
  assert.equal(decideBashForge({ command: "npm ci" }).decision, "allow");
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
