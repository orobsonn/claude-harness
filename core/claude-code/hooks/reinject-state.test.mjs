/**
 * @description Test suite for reinject-state.mjs — SessionStart(compact) hook.
 * Tests drive buildReinject() (pure, mock-injectable) and gcTargets() (pure synthetic
 * data) and handle() (integration via withTempDir fs isolation).
 * No subprocess spawn needed: CLI entry is guarded by import.meta.url.
 * Run with: node --test core/hooks/reinject-state.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildReinject, gcTargets, handle } from "./reinject-state.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Runs fn inside a fresh OS tmpdir (chdir'd to it), then restores cwd and removes the dir.
 * Hooks use relative paths resolved from cwd, so chdir isolation prevents polluting
 * the repo's .claude/plans/ during tests.
 * @param {() => void} fn - Synchronous test body
 */
function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reinject-test-"));
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

/** Returns nowMs - N days in ms */
function daysAgo(n) {
  return Date.now() - n * 24 * 60 * 60 * 1000;
}

/** Sets mtime on a path to a Date (or ms timestamp) */
function setMtime(filePath, mtimeMs) {
  const t = new Date(mtimeMs);
  fs.utimesSync(filePath, t, t);
}

// ---------------------------------------------------------------------------
// buildReinject() — locked tests 1 & 2 (pure, mock readFileSync)
// ---------------------------------------------------------------------------

test(
  "buildReinject: source=compact with triage.json {mode:'FULL', feature_id:'foo'} → additionalContext contains mode 'FULL' and feature_id 'foo'",
  () => {
    const payload = { session_id: "ses_x", source: "compact" };

    const mockRead = (filePath, _enc) => {
      if (filePath.includes("ses_x") && filePath.endsWith("triage.json")) {
        return JSON.stringify({ mode: "FULL", feature_id: "foo" });
      }
      throw new Error("not found");
    };

    const ctx = buildReinject(payload, {
      readFileSync: mockRead,
      plansRoot: ".claude/plans",
    });

    assert.ok(ctx !== null, "additionalContext must not be null");
    assert.ok(ctx.includes("FULL"), "context must contain mode 'FULL'");
    assert.ok(ctx.includes("foo"), "context must contain feature_id 'foo'");
  },
);

test(
  "buildReinject: triage.json.feature_id 'foo' with plan at .claude/plans/foo/execution-plan.json (3 tasks) → additionalContext names the plan path and reports 3 tasks",
  () => {
    const payload = { session_id: "ses_x", source: "compact" };
    const planPath = ".claude/plans/foo/execution-plan.json";

    const mockRead = (filePath, _enc) => {
      if (filePath.includes("ses_x") && filePath.endsWith("triage.json")) {
        return JSON.stringify({ mode: "FULL", feature_id: "foo" });
      }
      if (filePath.endsWith("foo/execution-plan.json")) {
        return JSON.stringify({ tasks: [{}, {}, {}] });
      }
      throw new Error("not found");
    };

    const ctx = buildReinject(payload, {
      readFileSync: mockRead,
      plansRoot: ".claude/plans",
    });

    assert.ok(ctx !== null, "additionalContext must not be null");
    assert.ok(
      ctx.includes(planPath),
      `context must name the plan path '${planPath}'`,
    );
    assert.ok(ctx.includes("3"), "context must report 3 tasks");
  },
);

test(
  "buildReinject: unmatched regate_pending → additionalContext carries a DELIVERY BLOCKED re-gate reminder",
  () => {
    const payload = { session_id: "ses_x", source: "compact" };
    const mockRead = (filePath, _enc) => {
      if (filePath.includes("ses_x") && filePath.endsWith("triage.json")) {
        return JSON.stringify({ mode: "FULL", feature_id: "foo" });
      }
      throw new Error("not found");
    };
    const mockGateState = () => ({ regate_pending: ["task-1"] }); // no regate_passed

    const ctx = buildReinject(payload, {
      readFileSync: mockRead,
      plansRoot: ".claude/plans",
      readGateState: mockGateState,
    });

    assert.ok(ctx !== null, "additionalContext must not be null");
    assert.ok(ctx.includes("DELIVERY BLOCKED"), "context must flag the delivery block");
    assert.ok(ctx.includes("task-1"), "context must name the unmatched re-gate task");
  },
);

test(
  "buildReinject: surfaces feature-qualified unmatched re-gate entries verbatim",
  () => {
    const payload = { session_id: "ses_x", source: "compact" };
    const mockRead = (filePath, _enc) => {
      if (filePath.includes("ses_x") && filePath.endsWith("triage.json")) {
        return JSON.stringify({ mode: "FULL", feature_id: "foo" });
      }
      throw new Error("not found");
    };
    // A bare task-1 collides across two features; the qualified form keeps them distinct.
    const mockGateState = () => ({
      regate_pending: ["feature-a/task-1", "feature-b/task-1"],
      regate_passed: ["feature-b/task-1"],
    });

    const ctx = buildReinject(payload, {
      readFileSync: mockRead,
      plansRoot: ".claude/plans",
      readGateState: mockGateState,
    });

    assert.ok(ctx !== null, "additionalContext must not be null");
    assert.ok(ctx.includes("DELIVERY BLOCKED"), "context must flag the delivery block");
    assert.ok(ctx.includes("feature-a/task-1"), "context must surface the qualified unmatched entry");
    assert.ok(
      !ctx.includes("feature-b/task-1"),
      "the matched qualified entry must not be surfaced as unmatched",
    );
  },
);

test(
  "buildReinject: regate_pending fully matched by regate_passed → no DELIVERY BLOCKED reminder",
  () => {
    const payload = { session_id: "ses_x", source: "compact" };
    const mockRead = (filePath, _enc) => {
      if (filePath.includes("ses_x") && filePath.endsWith("triage.json")) {
        return JSON.stringify({ mode: "FULL", feature_id: "foo" });
      }
      throw new Error("not found");
    };
    const mockGateState = () => ({ regate_pending: ["task-1"], regate_passed: ["task-1"] });

    const ctx = buildReinject(payload, {
      readFileSync: mockRead,
      plansRoot: ".claude/plans",
      readGateState: mockGateState,
    });

    assert.ok(ctx !== null, "additionalContext must not be null");
    assert.ok(!ctx.includes("DELIVERY BLOCKED"), "no block reminder when every re-gate is matched");
  },
);

// ---------------------------------------------------------------------------
// gcTargets() — locked tests 3–6 (pure synthetic DirEntry data)
// ---------------------------------------------------------------------------

test(
  "gcTargets: session-keyed dir containing only triage.json whose mtime is 8 days old → in targets (will be removed)",
  () => {
    const now = Date.now();
    const entries = [
      {
        name: "ses_stale",
        path: ".claude/plans/ses_stale",
        files: ["triage.json"],
        mtimeMs: daysAgo(8),
      },
    ];
    const targets = gcTargets(entries, now);
    assert.equal(targets.length, 1, "one target expected");
    assert.equal(targets[0], ".claude/plans/ses_stale");
  },
);

test(
  "gcTargets: session-keyed dir containing gate-state.json whose mtime is 8 days old → in targets (will be removed)",
  () => {
    const now = Date.now();
    const entries = [
      {
        name: "ses_gs",
        path: ".claude/plans/ses_gs",
        files: ["gate-state.json"],
        mtimeMs: daysAgo(8),
      },
    ];
    const targets = gcTargets(entries, now);
    assert.equal(targets.length, 1, "one target expected");
    assert.equal(targets[0], ".claude/plans/ses_gs");
  },
);

test(
  "gcTargets: feature plan dir containing execution-plan.json whose mtime is 30 days old → NOT in targets (GC excludes plan dirs)",
  () => {
    const now = Date.now();
    const entries = [
      {
        name: "my-feature",
        path: ".claude/plans/my-feature",
        files: ["execution-plan.json"],
        mtimeMs: daysAgo(30),
      },
    ];
    const targets = gcTargets(entries, now);
    assert.equal(targets.length, 0, "feature plan dir must never be a GC target");
  },
);

test(
  "gcTargets: session-keyed dir containing execution-plan.json alongside triage.json (30 days old) → NOT in targets",
  () => {
    // Belt-and-suspenders: even if a dir has both markers AND execution-plan.json, it is NOT a target
    const now = Date.now();
    const entries = [
      {
        name: "mixed",
        path: ".claude/plans/mixed",
        files: ["triage.json", "execution-plan.json"],
        mtimeMs: daysAgo(30),
      },
    ];
    const targets = gcTargets(entries, now);
    assert.equal(
      targets.length,
      0,
      "dir with execution-plan.json must not be GC'd even if triage.json present",
    );
  },
);

test(
  "gcTargets: session-keyed dir whose mtime is 1 day old → NOT in targets (retained, not stale)",
  () => {
    const now = Date.now();
    const entries = [
      {
        name: "ses_fresh",
        path: ".claude/plans/ses_fresh",
        files: ["triage.json"],
        mtimeMs: daysAgo(1),
      },
    ];
    const targets = gcTargets(entries, now);
    assert.equal(targets.length, 0, "recent dir must be retained");
  },
);

// Boundary: exactly at threshold (7 days) is NOT expired (strictly older than)
test("gcTargets: dir exactly 7 days old → retained (threshold is strictly >7 days)", () => {
  const now = Date.now();
  const entries = [
    {
      name: "ses_boundary",
      path: ".claude/plans/ses_boundary",
      files: ["triage.json"],
      mtimeMs: daysAgo(7),
    },
  ];
  // isExpired uses nowMs - mtimeMs > maxAgeMs (strict greater-than), so exactly 7 days = not expired
  const targets = gcTargets(entries, now);
  assert.equal(targets.length, 0, "dir exactly 7 days old must not be GC'd");
});

// ---------------------------------------------------------------------------
// handle() integration tests — GC with real fs (locked tests 3–4 full deletion,
// locked test 5 retention, locked test 6 retention, locked test 7 fail-open)
// ---------------------------------------------------------------------------

test(
  "handle GC: session-keyed dir with only triage.json 8 days old → dir is removed",
  () => {
    withTempDir(() => {
      const plansRoot = ".claude/plans";
      const sessionDir = path.join(plansRoot, ".state", "ses_old_triage");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "triage.json"), "{}");
      // Set mtime AFTER writing files (dir mtime update)
      setMtime(sessionDir, daysAgo(8));

      handle({ session_id: "ses_current", source: "compact" }, { plansRoot });

      assert.equal(
        fs.existsSync(sessionDir),
        false,
        "stale session dir with triage.json must be removed",
      );
    });
  },
);

test(
  "handle GC: session-keyed dir with gate-state.json 8 days old → dir is removed",
  () => {
    withTempDir(() => {
      const plansRoot = ".claude/plans";
      const sessionDir = path.join(plansRoot, ".state", "ses_old_gs");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "gate-state.json"), "{}");
      setMtime(sessionDir, daysAgo(8));

      handle({ session_id: "ses_current", source: "compact" }, { plansRoot });

      assert.equal(
        fs.existsSync(sessionDir),
        false,
        "stale session dir with gate-state.json must be removed",
      );
    });
  },
);

test(
  "handle GC: feature plan dir (contains execution-plan.json) 30 days old → NOT removed",
  () => {
    withTempDir(() => {
      const plansRoot = ".claude/plans";
      const featureDir = path.join(plansRoot, "my-feature");
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        path.join(featureDir, "execution-plan.json"),
        JSON.stringify({ tasks: [] }),
      );
      setMtime(featureDir, daysAgo(30));

      handle({ session_id: "ses_current", source: "compact" }, { plansRoot });

      assert.ok(
        fs.existsSync(featureDir),
        "feature plan dir must NOT be removed by GC",
      );
    });
  },
);

test(
  "handle GC: session-keyed dir 1 day old → retained (not stale enough)",
  () => {
    withTempDir(() => {
      const plansRoot = ".claude/plans";
      const sessionDir = path.join(plansRoot, ".state", "ses_fresh");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "triage.json"), "{}");
      setMtime(sessionDir, daysAgo(1));

      handle({ session_id: "ses_current", source: "compact" }, { plansRoot });

      assert.ok(fs.existsSync(sessionDir), "fresh session dir must be retained");
    });
  },
);

test(
  "handle: fs error raised while scanning the plans dir → exits 0 and deletes nothing (fail-open)",
  () => {
    withTempDir(() => {
      const plansRoot = ".claude/plans";
      // Create a stale session dir that would normally be GC'd
      const sessionDir = path.join(plansRoot, ".state", "ses_would-be-deleted");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "triage.json"), "{}");
      setMtime(sessionDir, daysAgo(8));

      // Inject a scan function that throws (simulates disk error)
      const throwingScan = () => {
        throw new Error("simulated disk full");
      };

      // Must not throw (exits 0)
      assert.doesNotThrow(() => {
        handle(
          { session_id: "ses_current", source: "compact" },
          {
            plansRoot,
            scan: throwingScan,
            readFileSync: () => {
              throw new Error("no triage");
            },
          },
        );
      }, "handle must not throw on scan error (fail-open)");

      // The stale session dir must be untouched (scan error → GC skipped)
      assert.ok(
        fs.existsSync(sessionDir),
        "stale session dir must survive a scan error (fail-open, delete nothing)",
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Additional coverage
// ---------------------------------------------------------------------------

test("buildReinject: non-object payload → null", () => {
  assert.equal(buildReinject(null), null);
  assert.equal(buildReinject(undefined), null);
  assert.equal(buildReinject("string"), null);
  assert.equal(buildReinject(42), null);
  assert.equal(buildReinject([]), null);
});

test("buildReinject: missing session_id → null", () => {
  const result = buildReinject({ source: "compact" });
  assert.equal(result, null);
});

test("buildReinject: triage.json missing → null (no injection)", () => {
  const result = buildReinject(
    { session_id: "ses_x", source: "compact" },
    { readFileSync: () => { throw new Error("ENOENT"); } },
  );
  assert.equal(result, null);
});

test("buildReinject: triage.json malformed JSON → null", () => {
  const result = buildReinject(
    { session_id: "ses_x", source: "compact" },
    { readFileSync: () => "not-json" },
  );
  assert.equal(result, null);
});

test("buildReinject: triage missing mode/feature_id fields → null", () => {
  const mockRead = () => JSON.stringify({ other: "field" });
  const result = buildReinject(
    { session_id: "ses_x", source: "compact" },
    { readFileSync: mockRead },
  );
  assert.equal(result, null);
});

test("buildReinject: plan file missing → still injects triage summary (graceful degradation)", () => {
  const mockRead = (filePath) => {
    if (filePath.endsWith("triage.json")) {
      return JSON.stringify({ mode: "LIGHT", feature_id: "some-feature" });
    }
    throw new Error("ENOENT");
  };
  const ctx = buildReinject(
    { session_id: "ses_x", source: "compact" },
    { readFileSync: mockRead, plansRoot: ".claude/plans" },
  );
  assert.ok(ctx !== null, "should inject triage summary even without plan");
  assert.ok(ctx.includes("LIGHT"));
  assert.ok(ctx.includes("some-feature"));
});

test("gcTargets: empty dirEntries → empty targets", () => {
  assert.deepEqual(gcTargets([], Date.now()), []);
});

test("gcTargets: dir with no session marker and no execution-plan.json (8 days old) → NOT in targets", () => {
  const entries = [
    {
      name: "orphan",
      path: ".claude/plans/orphan",
      files: ["some-other-file.json"],
      mtimeMs: daysAgo(8),
    },
  ];
  const targets = gcTargets(entries, Date.now());
  assert.equal(targets.length, 0, "dir without session marker must not be GC'd");
});

test("handle: malformed non-JSON payload → does not throw, returns null", () => {
  assert.doesNotThrow(() => handle(null));
  assert.doesNotThrow(() => handle(undefined));
  assert.doesNotThrow(() => handle("string"));
  assert.doesNotThrow(() => handle(42));

  assert.equal(handle(null), null);
  assert.equal(handle(undefined), null);
});

test(
  "handle: source=compact, triage.json present → returns hookSpecificOutput with additionalContext",
  () => {
    withTempDir(() => {
      const plansRoot = ".claude/plans";
      const sessionDir = path.join(plansRoot, ".state", "ses_reinject");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "triage.json"),
        JSON.stringify({ mode: "FULL", feature_id: "my-feature" }),
      );

      const result = handle(
        { session_id: "ses_reinject", source: "compact" },
        { plansRoot },
      );

      assert.ok(result !== null, "result must not be null");
      assert.ok(
        typeof result.hookSpecificOutput?.additionalContext === "string",
        "additionalContext must be a string",
      );
      assert.ok(result.hookSpecificOutput.additionalContext.includes("FULL"));
      assert.ok(
        result.hookSpecificOutput.additionalContext.includes("my-feature"),
      );
      assert.equal(
        result.hookSpecificOutput.hookEventName,
        "SessionStart",
        "hookEventName must be SessionStart",
      );
    });
  },
);

test(
  "handle: source=compact with plan file → additionalContext includes plan path and task count",
  () => {
    withTempDir(() => {
      const plansRoot = ".claude/plans";

      // Session triage.json
      const sessionDir = path.join(plansRoot, ".state", "ses_with_plan");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "triage.json"),
        JSON.stringify({ mode: "FULL", feature_id: "feat-abc" }),
      );

      // Feature execution-plan.json
      const featureDir = path.join(plansRoot, "feat-abc");
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        path.join(featureDir, "execution-plan.json"),
        JSON.stringify({ tasks: [{}, {}, {}, {}] }),
      );

      const result = handle(
        { session_id: "ses_with_plan", source: "compact" },
        { plansRoot },
      );

      assert.ok(result !== null);
      const ctx = result.hookSpecificOutput.additionalContext;
      const expectedPlanPath = path.join(plansRoot, "feat-abc", "execution-plan.json");
      assert.ok(
        ctx.includes(expectedPlanPath),
        `context must name plan path '${expectedPlanPath}'`,
      );
      assert.ok(ctx.includes("4"), "context must report 4 tasks");
    });
  },
);

test(
  "handle: source=compact, no triage.json for session → returns null (no injection)",
  () => {
    withTempDir(() => {
      const result = handle(
        { session_id: "ses_notriage", source: "compact" },
        { plansRoot: ".claude/plans" },
      );
      assert.equal(result, null, "no triage.json → no injection");
    });
  },
);

test(
  "handle GC: current session's own dir (only triage.json, 8 days old) is NOT deleted, while a different stale session dir IS deleted",
  () => {
    withTempDir(() => {
      const plansRoot = ".claude/plans";

      // Current session's own state dir — stale by mtime, but must be protected.
      const currentDir = path.join(plansRoot, ".state", "ses_current");
      fs.mkdirSync(currentDir, { recursive: true });
      fs.writeFileSync(path.join(currentDir, "triage.json"), "{}");
      setMtime(currentDir, daysAgo(8));

      // A different, genuinely stale session dir — must still be GC'd.
      const otherDir = path.join(plansRoot, ".state", "ses_other");
      fs.mkdirSync(otherDir, { recursive: true });
      fs.writeFileSync(path.join(otherDir, "triage.json"), "{}");
      setMtime(otherDir, daysAgo(8));

      handle({ session_id: "ses_current", source: "compact" }, { plansRoot });

      assert.ok(
        fs.existsSync(currentDir),
        "current session's own dir must NEVER be GC'd even when stale",
      );
      assert.equal(
        fs.existsSync(otherDir),
        false,
        "a different stale session dir must still be GC'd",
      );
    });
  },
);

test(
  "buildReinject: triage.json feature_id '../../evil' → no plan read attempted, additionalContext has no traversed path",
  () => {
    const attempted = [];
    const mockRead = (filePath, _enc) => {
      attempted.push(filePath);
      if (filePath.endsWith("triage.json")) {
        return JSON.stringify({ mode: "FULL", feature_id: "../../evil" });
      }
      throw new Error("not found");
    };

    const ctx = buildReinject(
      { session_id: "ses_x", source: "compact" },
      { readFileSync: mockRead, plansRoot: ".claude/plans" },
    );

    assert.ok(ctx !== null, "triage-only context must still be returned");
    assert.ok(
      !attempted.some((p) => p.endsWith("execution-plan.json")),
      "no plan read must be attempted for an unsafe feature_id",
    );
    assert.ok(
      !ctx.includes("evil/execution-plan.json"),
      "additionalContext must not contain a traversed plan path",
    );
  },
);

test(
  "buildReinject: session_id '../../evil' (path traversal attempt) → returns null, no triage read",
  () => {
    const attempted = [];
    const mockRead = (filePath, _enc) => {
      attempted.push(filePath);
      throw new Error("should not be called for unsafe session_id");
    };

    const ctx = buildReinject(
      { session_id: "../../evil", source: "compact" },
      { readFileSync: mockRead, plansRoot: ".claude/plans" },
    );

    assert.equal(ctx, null, "unsafe session_id must return null (no injection)");
    assert.equal(
      attempted.length,
      0,
      "no file read must be attempted for an unsafe session_id",
    );
  },
);

test(
  "handle: source=compact, session_id '../../evil' (path traversal) → returns null (no injection)",
  () => {
    withTempDir(() => {
      const plansRoot = ".claude/plans";

      // Even if we place a triage.json at a traversable path, isSafeSessionId blocks it
      const evilSessionDir = path.join(plansRoot, "../../evil");
      fs.mkdirSync(evilSessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(evilSessionDir, "triage.json"),
        JSON.stringify({ mode: "FULL", feature_id: "malicious" }),
      );

      const result = handle(
        { session_id: "../../evil", source: "compact" },
        { plansRoot },
      );

      assert.equal(
        result,
        null,
        "unsafe session_id must prevent injection even if triage.json exists",
      );
    });
  },
);

test(
  "handle GC: feature dir whose execution-plan.json is a symlink (30 days old) → NOT removed",
  () => {
    withTempDir(() => {
      const plansRoot = ".claude/plans";
      const featureDir = path.join(plansRoot, "symlinked-feature");
      fs.mkdirSync(featureDir, { recursive: true });

      // Real plan lives elsewhere; the feature dir only holds a symlink to it.
      const realPlan = path.join(plansRoot, "real-plan.json");
      fs.writeFileSync(realPlan, JSON.stringify({ tasks: [] }));
      fs.symlinkSync(
        path.resolve(realPlan),
        path.join(featureDir, "execution-plan.json"),
      );
      setMtime(featureDir, daysAgo(30));

      handle({ session_id: "ses_current", source: "compact" }, { plansRoot });

      assert.ok(
        fs.existsSync(featureDir),
        "feature dir with a symlinked plan must NOT be GC'd",
      );
    });
  },
);

test("handle: GC and reinject coexist — stale dir removed AND context injected", () => {
  withTempDir(() => {
    const plansRoot = ".claude/plans";

    // Stale session dir (should be GC'd)
    const staleDir = path.join(plansRoot, ".state", "ses_stale_old");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "triage.json"), "{}");
    setMtime(staleDir, daysAgo(10));

    // Current session (should be reinjected)
    const currentDir = path.join(plansRoot, ".state", "ses_current");
    fs.mkdirSync(currentDir, { recursive: true });
    fs.writeFileSync(
      path.join(currentDir, "triage.json"),
      JSON.stringify({ mode: "LIGHT", feature_id: "active-feature" }),
    );

    const result = handle(
      { session_id: "ses_current", source: "compact" },
      { plansRoot },
    );

    // GC removed stale dir
    assert.equal(
      fs.existsSync(staleDir),
      false,
      "stale dir must be GC'd",
    );

    // Reinject returned context
    assert.ok(result !== null, "result must not be null");
    assert.ok(result.hookSpecificOutput.additionalContext.includes("LIGHT"));
    assert.ok(
      result.hookSpecificOutput.additionalContext.includes("active-feature"),
    );
  });
});
