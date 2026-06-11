/**
 * @description Test suite for stamp-triage.mjs — PostToolUse(Bash) hook.
 * Tests drive decide() and handle() directly (no subprocess spawn).
 * All file-system tests use withTempDir() for isolation — same pattern as gate-lib.test.mjs.
 * Run with: node --test core/hooks/stamp-triage.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decide, handle } from "./stamp-triage.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Runs fn inside a fresh OS tmpdir (chdir'd to it), then restores cwd and removes the dir.
 * gate-lib uses relative paths resolved from cwd, so chdir isolation prevents polluting
 * the repo's .claude/plans/ during tests.
 * @param {() => void} fn - Synchronous test body
 */
function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-triage-test-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    fn();
  } finally {
    process.chdir(savedCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

/**
 * Builds a realistic classify.mjs PostToolUse payload.
 * @param {string} sessionId - payload.session_id
 * @param {string} mode - mode echoed by classify
 * @param {string} featureId - feature_id echoed by classify
 * @param {object} [extra] - extra fields to merge into the payload (e.g. { agent_id: 'ag_1' })
 */
function makeClassifyPayload(sessionId, mode, featureId, extra = {}) {
  return {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: {
      command: `node .claude/hooks/classify.mjs --mode ${mode} --feature-id ${featureId}`,
    },
    tool_response: JSON.stringify({ mode, feature_id: featureId }),
    ...extra,
  };
}

/**
 * Builds a brainstorm-done marker payload.
 * @param {string} sessionId - payload.session_id
 * @param {string} featureId - feature_id passed to mark.mjs
 * @param {object} [extra] - extra fields (e.g. { agent_id: 'ag_1' })
 */
function makeBrainstormPayload(sessionId, featureId, extra = {}) {
  return {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: {
      command: `node .claude/hooks/mark.mjs brainstorm-done --feature-id ${featureId}`,
    },
    tool_response: JSON.stringify({ marker: "brainstorm-done", feature_id: featureId }),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// decide() — pure unit tests (no I/O, no chdir needed)
// ---------------------------------------------------------------------------

test("decide: returns action:none for non-object payload", () => {
  assert.deepEqual(decide(null).action, "none");
  assert.deepEqual(decide(undefined).action, "none");
  assert.deepEqual(decide("string").action, "none");
  assert.deepEqual(decide(42).action, "none");
  assert.deepEqual(decide([]).action, "none");
});

test("decide: returns action:none when agent_id is present (subagent context)", () => {
  const payload = makeClassifyPayload("ses_real", "FULL", "user-auth", { agent_id: "ag_1" });
  assert.equal(decide(payload).action, "none");
});

test("decide: returns action:none when session_id is absent", () => {
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "node classify.mjs --mode FULL --feature-id user-auth" },
    tool_response: JSON.stringify({ mode: "FULL", feature_id: "user-auth" }),
  };
  assert.equal(decide(payload).action, "none");
});

test("decide: returns action:none when tool_input.command is absent", () => {
  const payload = { session_id: "ses_x", tool_name: "Bash", tool_input: {} };
  assert.equal(decide(payload).action, "none");
});

test("decide: classify marker with valid args → action:triage with correct fields", () => {
  const payload = makeClassifyPayload("ses_real", "FULL", "user-auth");
  const result = decide(payload);
  assert.equal(result.action, "triage");
  assert.equal(result.session_id, "ses_real");
  assert.equal(result.mode, "FULL");
  assert.equal(result.feature_id, "user-auth");
});

test("decide: classify marker ignores any session_id in tool_response (spoofing)", () => {
  const payload = {
    session_id: "ses_real",
    tool_name: "Bash",
    tool_input: {
      command: "node .claude/hooks/classify.mjs --mode FULL --feature-id user-auth",
    },
    tool_response: JSON.stringify({
      mode: "FULL",
      feature_id: "user-auth",
      session_id: "ses_evil",
    }),
  };
  const result = decide(payload);
  assert.equal(result.action, "triage");
  assert.equal(result.session_id, "ses_real"); // payload value wins
});

test("decide: classify marker with BOGUS mode → action:none", () => {
  const payload = makeClassifyPayload("ses_real", "BOGUS", "user-auth");
  assert.equal(decide(payload).action, "none");
});

test("decide: classify marker with path-traversal feature_id → action:none", () => {
  const payload = {
    session_id: "ses_real",
    tool_name: "Bash",
    tool_input: {
      command: "node .claude/hooks/classify.mjs --mode FULL --feature-id ../../etc/cron",
    },
    tool_response: JSON.stringify({ mode: "FULL", feature_id: "../../etc/cron" }),
  };
  assert.equal(decide(payload).action, "none");
});

test("decide: classify marker with malformed tool_response JSON → action:none", () => {
  const payload = {
    session_id: "ses_real",
    tool_name: "Bash",
    tool_input: { command: "node .claude/hooks/classify.mjs --mode FULL --feature-id x" },
    tool_response: "not-json",
  };
  assert.equal(decide(payload).action, "none");
});

test("decide: brainstorm-done marker (no agent_id) → action:brainstorm-done", () => {
  const payload = makeBrainstormPayload("ses_x", "foo");
  const result = decide(payload);
  assert.equal(result.action, "brainstorm-done");
  assert.equal(result.session_id, "ses_x");
});

test("decide: brainstorm-done marker with agent_id → action:none", () => {
  const payload = makeBrainstormPayload("ses_x", "foo", { agent_id: "ag_1" });
  assert.equal(decide(payload).action, "none");
});

test("decide: unrelated command → action:none", () => {
  const payload = {
    session_id: "ses_x",
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
    tool_response: "total 0\n",
  };
  assert.equal(decide(payload).action, "none");
});

// ---------------------------------------------------------------------------
// handle() — integration tests using withTempDir for fs isolation
// ---------------------------------------------------------------------------

test(
  "handle: classify command with valid args → triage.json written with payload session_id",
  () => {
    withTempDir(() => {
      const payload = makeClassifyPayload("ses_real", "FULL", "user-auth");
      handle(payload);

      const triagePath = `.claude/plans/.state/ses_real/triage.json`;
      assert.ok(fs.existsSync(triagePath), "triage.json should exist");

      const triage = JSON.parse(fs.readFileSync(triagePath, "utf8"));
      assert.equal(triage.session_id, "ses_real");
      assert.equal(triage.mode, "FULL");
      assert.equal(triage.feature_id, "user-auth");
      assert.ok(typeof triage.created_at === "string", "created_at should be a string");
    });
  },
);

test(
  "handle: classify output claiming session_id 'ses_evil' → triage.json written under payload session_id 'ses_real'",
  () => {
    withTempDir(() => {
      const payload = {
        session_id: "ses_real",
        tool_name: "Bash",
        tool_input: {
          command: "node .claude/hooks/classify.mjs --mode FULL --feature-id user-auth",
        },
        tool_response: JSON.stringify({
          mode: "FULL",
          feature_id: "user-auth",
          session_id: "ses_evil",
        }),
      };
      handle(payload);

      const realPath = `.claude/plans/.state/ses_real/triage.json`;
      const evilPath = `.claude/plans/.state/ses_evil/triage.json`;

      assert.ok(fs.existsSync(realPath), "triage.json should be under ses_real");
      assert.equal(
        fs.existsSync(evilPath),
        false,
        "no file should be written under ses_evil",
      );

      const triage = JSON.parse(fs.readFileSync(realPath, "utf8"));
      assert.equal(triage.session_id, "ses_real");
    });
  },
);

test(
  "handle: classify output feature_id '../../etc/cron' → no triage.json written, process does not throw",
  () => {
    withTempDir(() => {
      const payload = {
        session_id: "ses_real",
        tool_name: "Bash",
        tool_input: {
          command: "node .claude/hooks/classify.mjs --mode FULL --feature-id ../../etc/cron",
        },
        tool_response: JSON.stringify({ mode: "FULL", feature_id: "../../etc/cron" }),
      };

      assert.doesNotThrow(() => handle(payload));

      // Nothing should have been written anywhere under .claude/plans
      assert.equal(
        fs.existsSync(".claude/plans/.state/ses_real/triage.json"),
        false,
        "no triage.json should be written for invalid feature_id",
      );
      // The plans dir itself should not exist at all
      assert.equal(
        fs.existsSync(".claude"),
        false,
        "no .claude dir should exist after rejected write",
      );
    });
  },
);

test("handle: classify output mode 'BOGUS' → no triage.json written", () => {
  withTempDir(() => {
    const payload = makeClassifyPayload("ses_real", "BOGUS", "user-auth");
    assert.doesNotThrow(() => handle(payload));
    assert.equal(
      fs.existsSync(".claude/plans/.state/ses_real/triage.json"),
      false,
      "no triage.json should be written for invalid mode",
    );
  });
});

test(
  "handle: brainstorm-done marker (no agent_id) → gate-state.json has brainstormed=true",
  () => {
    withTempDir(() => {
      const payload = makeBrainstormPayload("ses_x", "foo");
      handle(payload);

      const gateStatePath = `.claude/plans/.state/ses_x/gate-state.json`;
      assert.ok(fs.existsSync(gateStatePath), "gate-state.json should exist");

      const state = JSON.parse(fs.readFileSync(gateStatePath, "utf8"));
      assert.equal(state.brainstormed, true);
    });
  },
);

test(
  "handle: brainstorm-done marker with agent_id 'ag_1' → gate-state.json NOT written",
  () => {
    withTempDir(() => {
      const payload = makeBrainstormPayload("ses_y", "foo", { agent_id: "ag_1" });
      handle(payload);

      assert.equal(
        fs.existsSync(".claude/plans/.state/ses_y/gate-state.json"),
        false,
        "gate-state.json must NOT be written when agent_id is present",
      );
    });
  },
);

test(
  "handle: brainstorm-done preserves adversary_fired in gate-state.json (read-merge-write, no drop)",
  () => {
    withTempDir(() => {
      const sessionId = "ses_nodrop";
      const stateDir = `.claude/plans/.state/${sessionId}`;
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "gate-state.json"),
        JSON.stringify({ adversary_fired: true }),
        "utf8",
      );

      const payload = makeBrainstormPayload(sessionId, "foo");
      handle(payload);

      const state = JSON.parse(
        fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"),
      );
      assert.equal(
        state.brainstormed,
        true,
        "brainstormed must be set after brainstorm-done marker",
      );
      assert.equal(
        state.adversary_fired,
        true,
        "adversary_fired must be retained — read-merge-write must never drop it",
      );
    });
  },
);

test("handle: malformed non-object payload → writes nothing and does not throw", () => {
  withTempDir(() => {
    assert.doesNotThrow(() => handle(null));
    assert.doesNotThrow(() => handle(undefined));
    assert.doesNotThrow(() => handle("not-json-object"));
    assert.doesNotThrow(() => handle(42));
    assert.doesNotThrow(() => handle([]));

    // Nothing should have been written
    assert.equal(
      fs.existsSync(".claude"),
      false,
      "no .claude dir should exist after malformed payloads",
    );
  });
});

test(
  "handle: successful triage write → triage.json exists and no .tmp temp file remains",
  () => {
    withTempDir(() => {
      const payload = makeClassifyPayload("ses_notmp", "LIGHT", "clean-feature");
      handle(payload);

      const triagePath = `.claude/plans/.state/ses_notmp/triage.json`;
      const tmpPath = `${triagePath}.tmp`;

      assert.ok(
        fs.existsSync(triagePath),
        "triage.json should exist after successful write",
      );
      assert.equal(
        fs.existsSync(tmpPath),
        false,
        "no .tmp file should remain after atomic rename",
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Additional coverage
// ---------------------------------------------------------------------------

test("handle: all four valid modes are accepted for triage", () => {
  for (const mode of ["no-ceremony", "QUICK", "LIGHT", "FULL"]) {
    withTempDir(() => {
      const sessionId = `ses-mode-${mode.toLowerCase().replace("-", "")}`;
      const payload = makeClassifyPayload(sessionId, mode, "valid-feature");
      handle(payload);
      const triagePath = `.claude/plans/.state/${sessionId}/triage.json`;
      assert.ok(fs.existsSync(triagePath), `triage.json should be written for mode '${mode}'`);
      const triage = JSON.parse(fs.readFileSync(triagePath, "utf8"));
      assert.equal(triage.mode, mode);
    });
  }
});

test("handle: re-classification overwrites existing triage.json (reclassify allowed)", () => {
  withTempDir(() => {
    const payload1 = makeClassifyPayload("ses_reclassify", "LIGHT", "some-feature");
    handle(payload1);
    const payload2 = makeClassifyPayload("ses_reclassify", "FULL", "some-feature");
    handle(payload2);

    const triagePath = `.claude/plans/.state/ses_reclassify/triage.json`;
    const triage = JSON.parse(fs.readFileSync(triagePath, "utf8"));
    assert.equal(triage.mode, "FULL", "second classify should overwrite with new mode");
  });
});

test("handle: classify with object-shaped tool_response { stdout } → triage.json written with mode FULL", () => {
  withTempDir(() => {
    const payload = {
      session_id: "ses_objshape",
      tool_name: "Bash",
      tool_input: {
        command: "node .claude/hooks/classify.mjs --mode FULL --feature-id x",
      },
      tool_response: {
        stdout: JSON.stringify({ mode: "FULL", feature_id: "x" }),
        stderr: "",
      },
    };
    handle(payload);
    const triagePath = `.claude/plans/.state/ses_objshape/triage.json`;
    assert.ok(fs.existsSync(triagePath), "triage.json should be written for object-shaped tool_response");
    const triage = JSON.parse(fs.readFileSync(triagePath, "utf8"));
    assert.equal(triage.mode, "FULL");
    assert.equal(triage.feature_id, "x");
  });
});

test("decide: brainstorm-done command whose stdout is NOT marker JSON → action:none (no forgery)", () => {
  const payload = {
    session_id: "ses_forge",
    tool_name: "Bash",
    tool_input: { command: "grep brainstorm-done .claude/hooks/mark.mjs" },
    tool_response: "const MARKER = 'brainstorm-done';\n",
  };
  assert.equal(decide(payload).action, "none");
});

test("decide: real mark.mjs stdout (marker JSON) → action:brainstorm-done", () => {
  const payload = {
    session_id: "ses_realmark",
    tool_name: "Bash",
    tool_input: { command: "node .claude/hooks/mark.mjs brainstorm-done --feature-id foo" },
    tool_response: JSON.stringify({ marker: "brainstorm-done", feature_id: "foo" }),
  };
  const result = decide(payload);
  assert.equal(result.action, "brainstorm-done");
  assert.equal(result.session_id, "ses_realmark");
});

test("decide: path-traversal session_id '../../evil' → action:none, nothing written", () => {
  withTempDir(() => {
    const payload = makeClassifyPayload("../../evil", "FULL", "user-auth");
    assert.equal(decide(payload).action, "none");
    assert.doesNotThrow(() => handle(payload));
    assert.equal(
      fs.existsSync(".claude"),
      false,
      "no .claude dir should exist for path-traversal session_id",
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 1: (re)classify resets per-feature ceremony in gate-state.json
// ---------------------------------------------------------------------------

test("handle: classify stamps gate-state.json with the classified feature_id", () => {
  withTempDir(() => {
    handle(makeClassifyPayload("ses_stamp", "FULL", "feature-a"));
    const state = JSON.parse(
      fs.readFileSync(".claude/plans/.state/ses_stamp/gate-state.json", "utf8"),
    );
    assert.deepEqual(state, { feature_id: "feature-a" });
  });
});

test("handle: reclassify to feature B resets stale brainstormed/adversary_fired and stamps B", () => {
  withTempDir(() => {
    // Feature A: classify then complete the ceremony (brainstormed + adversary_fired)
    handle(makeClassifyPayload("ses_reset_feat", "FULL", "feature-a"));
    handle(makeBrainstormPayload("ses_reset_feat", "feature-a"));
    const stateDir = ".claude/plans/.state/ses_reset_feat";
    // Simulate adversary_fired written by entry-gate, preserving feature_id
    const afterBs = JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"));
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({ ...afterBs, adversary_fired: true }),
      "utf8",
    );

    // Reclassify to feature B → must reset ceremony
    handle(makeClassifyPayload("ses_reset_feat", "FULL", "feature-b"));

    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"));
    assert.equal(state.feature_id, "feature-b", "feature_id must be the new feature");
    assert.equal(state.brainstormed, undefined, "stale brainstormed must be cleared");
    assert.equal(state.adversary_fired, undefined, "stale adversary_fired must be cleared");
  });
});

// ---------------------------------------------------------------------------
// Fix 3: robust marker stdout parsing (extra output around the JSON line)
// ---------------------------------------------------------------------------

test("handle: noisy classify stdout (banner + trailing 'ok') → triage IS written", () => {
  withTempDir(() => {
    const payload = {
      session_id: "ses_noisy",
      tool_name: "Bash",
      tool_input: {
        command: "node .claude/hooks/classify.mjs --mode FULL --feature-id x && echo ok",
      },
      tool_response: 'noise\n{"mode":"FULL","feature_id":"x"}\nok',
    };
    handle(payload);
    const triagePath = ".claude/plans/.state/ses_noisy/triage.json";
    assert.ok(fs.existsSync(triagePath), "triage.json should be written despite surrounding noise");
    const triage = JSON.parse(fs.readFileSync(triagePath, "utf8"));
    assert.equal(triage.mode, "FULL");
    assert.equal(triage.feature_id, "x");
  });
});

test("decide: noisy brainstorm stdout with marker JSON among extra lines → action:brainstorm-done", () => {
  const payload = {
    session_id: "ses_noisy_bs",
    tool_name: "Bash",
    tool_input: { command: "node .claude/hooks/mark.mjs brainstorm-done --feature-id foo && echo done" },
    tool_response: 'starting\n{"marker":"brainstorm-done","feature_id":"foo"}\ndone',
  };
  assert.equal(decide(payload).action, "brainstorm-done");
});

test("handle: classify with tool_output field (alternate payload key) → triage.json written", () => {
  withTempDir(() => {
    const payload = {
      session_id: "ses_altkey",
      tool_name: "Bash",
      tool_input: {
        command: "node .claude/hooks/classify.mjs --mode QUICK --feature-id alt-feature",
      },
      tool_output: JSON.stringify({ mode: "QUICK", feature_id: "alt-feature" }),
    };
    handle(payload);
    const triagePath = `.claude/plans/.state/ses_altkey/triage.json`;
    assert.ok(fs.existsSync(triagePath), "triage.json should be written using tool_output field");
    const triage = JSON.parse(fs.readFileSync(triagePath, "utf8"));
    assert.equal(triage.mode, "QUICK");
    assert.equal(triage.feature_id, "alt-feature");
  });
});
