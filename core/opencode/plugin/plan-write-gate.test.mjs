/**
 * @description Locked tests for plan-write-gate (LIGHT state anti-forge).
 * Pure decide + hermetic plugin hook with OC arg shapes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decide,
  extractWritePath,
  throwIfDenied,
} from "./lib/plan-write-decide.mjs";
import { PlanWriteGate } from "./plan-write-gate.ts";
import { PlanGate } from "./plan-gate.ts";
import { obsHand } from "./obs-hand.ts";

const { createPlanWriteGateHooks } = PlanWriteGate.testApi;
const { createPlanGateHooks } = PlanGate.testApi;
const { createObsHandHooks } = obsHand.testApi;

async function installComposition(root) {
  await createPlanGateHooks(root);
  await createObsHandHooks(root);
}

function createScopedHooks(root, { scopePaths = ["src/a.ts"] } = {}) {
  return createPlanWriteGateHooks(root, {
    requireHeartbeat: false,
    resolveRuntimeIdentity: async (_projectRoot, input) => ({
      ok: true,
      parentSessionId: input.sessionID,
      runtimeSessionId: `child-${input.sessionID}`,
      callId: "task-call",
      role: "executor-high",
      record: { parent_session_id: input.sessionID, dispatch_call_id: "task-call", child_session_id: `child-${input.sessionID}`, feature_id: "feat-scope", task_id: "t1", role: "executor", scope_paths: scopePaths, allowed_writes: [], snapshot_hash: "a".repeat(64), claimed_at: "2026-08-01T00:00:00.000Z" },
    }),
  });
}

test("autoload surface exposes only the canonical plugin factory as a function", async () => {
  const module = await import("./plan-write-gate.ts");
  const functionExports = Object.entries(module)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(functionExports, ["PlanWriteGate", "default"]);
  assert.equal(module.PlanWriteGate, module.default);
});

test("deny model-tool writes to a feature canonical execution-plan.json", () => {
  const p = {
    tool_input: { file_path: ".opencode/plans/foo/execution-plan.json" },
  };
  assert.equal(decide(p).allow, false);
  assert.match(decide(p).reason ?? "", /canonical plan/i);
});

test("literal Bash mutations against a canonical plan are frictioned while reads pass", () => {
  for (const command of [
    "echo '{}' > .opencode/plans/ses-feat/execution-plan.json",
    "tee .opencode/plans/ses-feat/execution-plan.json",
    "rm .opencode/plans/ses-feat/execution-plan.json",
    "sed -i 's/a/b/' .opencode/plans/ses-feat/execution-plan.json",
    "mv .opencode/plans/ses-feat/execution-plan.json /tmp/archive.json",
    "mv /tmp/new.json .opencode/plans/ses-feat/execution-plan.json",
  ]) {
    assert.equal(decide({ args: { command } }).allow, false, command);
  }
  assert.equal(decide({ args: { command: "cat .opencode/plans/ses-feat/execution-plan.json" } }).allow, true);
  assert.equal(decide({ args: { command: "cp .opencode/plans/ses-feat/execution-plan.json /tmp/plan-copy.json" } }).allow, true);
  assert.equal(decide({ args: { command: "git diff -- .opencode/plans/ses-feat/execution-plan.json > /tmp/plan.diff" } }).allow, true);
  assert.equal(decide({ args: { command: "cat .opencode/plans/ses-feat/execution-plan.json | tee /tmp/plan-copy.json" } }).allow, true);
  assert.equal(decide({ args: { command: "tee /tmp/plan-copy.json < .opencode/plans/ses-feat/execution-plan.json" } }).allow, true);
  assert.equal(decide({ args: { command: "tee /tmp/x < /dev/null; tee .opencode/plans/ses-feat/execution-plan.json" } }).allow, false);
  assert.equal(decide({ args: { command: "echo tee && cat .opencode/plans/ses-feat/execution-plan.json" } }).allow, true);
  assert.equal(decide({ args: { command: "echo x | tee .opencode/plans/ses-feat/execution-plan.json" } }).allow, false);
  assert.equal(decide({ args: { command: "printf '{}' > /tmp/.opencode/plans/ses-feat/execution-plan.json" } }).allow, false);
});

test("literal Bash friction denies canonical targets but keeps cp and rsync sources readable", () => {
  const canonical = ".opencode/plans/ses-feat/execution-plan.json";
  const absolute = "/work/project/.opencode/plans/ses-feat/execution-plan.json";
  for (const command of [
    `cp /tmp/new-plan.json ${canonical}`,
    `rsync /tmp/new-plan.json ${canonical}`,
    `truncate -s 0 ${canonical}`,
    `sed -i '' 's/a/b/' ${absolute}`,
    `cp /tmp/new-plan.json ${absolute}`,
    `rsync /tmp/new-plan.json ${absolute}`,
    `truncate -s 0 ${absolute}`,
  ]) assert.equal(decide({ args: { command } }).allow, false, command);
  for (const command of [
    `cp ${canonical} /tmp/plan-copy.json`,
    `rsync ${canonical} /tmp/plan-copy.json`,
    `cp ${absolute} /tmp/plan-copy.json`,
    `rsync ${absolute} /tmp/plan-copy.json`,
  ]) assert.equal(decide({ args: { command } }).allow, true, command);
});

test("literal Bash mutations cannot forge .opencode/plans/.state while reads remain available", () => {
  const state = ".opencode/plans/.state/session/gate-state.json";
  const absolute = `/work/project/${state}`;
  for (const command of [
    `node -e 'require("fs").writeFileSync("${state}", "{}")'`,
    `python3 -c 'open("${state}", "w").write("{}")'`,
    `sed -i 's/false/true/' ${state}`,
    `printf '{}' | tee ${state}`,
    `rm -f ${state}`,
    `python3 - <<'PY'\nopen("${absolute}", "w").write("{}")\nPY`,
    `cd .opencode/plans && python3 -c 'open(".state/session/gate-state.json", "w").write("{}")'`,
    `cd .opencode/plans && printf '{}' | tee .state/session/gate-state.json`,
    `cd .opencode/plans/.state/session && tee gate-state.json`,
  ]) {
    const decision = decide({ args: { command } });
    assert.equal(decision.allow, false, command);
    assert.match(decision.reason ?? "", /state|forge/i, command);
  }
  for (const command of [
    `cat ${state}`,
    `git diff -- ${state}`,
    `cp ${state} /tmp/state-copy.json`,
  ]) assert.equal(decide({ args: { command } }).allow, true, command);
});

test("canonical plan is denied through apply_patch for every role and any target in a multi-file patch", async () => {
  const before = (await createPlanWriteGateHooks()) ["tool.execute.before"];
  const patch = "*** Begin Patch\n*** Update File: src/allowed.ts\n@@\n-old\n+new\n*** Update File: .opencode/plans/ses-feat/execution-plan.json\n@@\n-old\n+new\n*** End Patch";
  for (const agent of ["planner", "compliance", "executor-low", "sniper-high"]) {
    await assert.rejects(
      () => before({ tool: "apply_patch", agent }, { args: { patchText: patch } }),
      /canonical plan/,
      agent,
    );
  }
});

test("canonical plan scan reaches a real plan after a nested .state decoy", () => {
  const p = "/tmp/.opencode/plans/.state/old/.opencode/plans/ses-feat/execution-plan.json";
  assert.equal(decide({ tool_input: { file_path: p } }).allow, false);
  assert.match(decide({ tool_input: { file_path: p } }).reason ?? "", /canonical plan/);
});

test("official delete variants deny canonical plan before identity resolution", async () => {
  const before = (await createPlanWriteGateHooks()) ["tool.execute.before"];
  for (const tool of ["delete", "file.delete", "delete_file", "fs_delete"]) {
    await assert.rejects(
      () => before({ tool }, { args: { filePath: ".opencode/plans/ses-feat/execution-plan.json" } }),
      /canonical plan/,
      tool,
    );
  }
});

test("canonical path ignores an unrelated .state ancestor but excludes plans/.state itself", () => {
  assert.equal(decide({ tool_input: { file_path: "/tmp/.state/project/.opencode/plans/feat/execution-plan.json" } }).allow, false);
  assert.equal(decide({ tool_input: { file_path: "/tmp/project/.opencode/plans/.state/ses/execution-plan.json" } }).allow, false);
});

test("deny write to gate-state.json (basename rail)", () => {
  const p = { tool_input: { file_path: "any/gate-state.json" } };
  const r = decide(p);
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /gate-state\/triage/);
});

test("deny write to triage.json under .state", () => {
  const p = {
    tool_input: { file_path: ".opencode/plans/.state/ses/triage.json" },
  };
  assert.equal(decide(p).allow, false);
});

test("carve-out basename *.test.* fixtures pass", () => {
  const p = { tool_input: { file_path: "__fixtures__/gate-state.test.json" } };
  assert.equal(decide(p).allow, true);
});

test("carve never applies to live gate-state basename even under .test. session segment", () => {
  const p = {
    tool_input: {
      file_path: ".opencode/plans/.state/ses.test.x/gate-state.json",
    },
  };
  const r = decide(p);
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /gate-state|harness markers/);
});

test("empty path fail-closed", () => {
  const r = decide({ tool_input: {} });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /path missing/);
});

test("deny Write overwrite of native mark authority", () => {
  for (const file_path of ["core/opencode/plugin/marker-authority.ts", ".opencode/plugin/marker-authority.ts"]) {
    const result = decide({ tool_input: { file_path } });
    assert.equal(result.allow, false, file_path);
    assert.match(result.reason ?? "", /tooling|anti-forgery/);
  }
});

test("deny Write overwrite of frozen tooling vendor-core", () => {
  const r = decide({
    tool_input: {
      file_path:
        "core/claude-code/skills/initializing-projects/references/vendor-core.mjs",
    },
  });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /tooling|anti-forgery/);
});

test("traversal to state denied (no carve bypass)", () => {
  const p = {
    tool_input: {
      file_path:
        "../../../__fixtures__/.opencode/plans/.state/s/gate-state.json",
    },
  };
  assert.equal(decide(p).allow, false);
});

test("absolute path under .state hits oracle (deny)", () => {
  const state = {
    tool_input: {
      file_path: "/home/u/proj/.opencode/plans/.state/ses/other.json",
    },
  };
  const rState = decide(state);
  assert.equal(rState.allow, false);
  assert.match(rState.reason ?? "", /\.state|gate-state|harness markers/);

  const absOutsideOracle = {
    tool_input: { file_path: "/tmp/unrelated/notes.json" },
  };
  assert.equal(decide(absOutsideOracle).allow, true);

  const absPlan = {
    tool_input: { file_path: "/tmp/.opencode/plans/foo/execution-plan.json" },
  };
  assert.equal(decide(absPlan).allow, false);
});

test("absolute path with decoy .opencode parent still hits .state oracle (deny)", () => {
  // First .opencode is not plans/.state — must scan every segment, not only indexOf
  const p = {
    tool_input: {
      file_path: "/tmp/.opencode/work/proj/.opencode/plans/.state/s/other.json",
    },
  };
  const r = decide(p);
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /\.state|harness markers/);
});

test("extractWritePath accepts OC filePath args", () => {
  assert.equal(
    extractWritePath({ args: { filePath: ".opencode/plans/.state/s/gate-state.json" } }),
    ".opencode/plans/.state/s/gate-state.json",
  );
  assert.equal(
    extractWritePath({ tool_input: { file_path: "x/gate-state.json" } }),
    "x/gate-state.json",
  );
});

test("throwIfDenied throws [plan-write-gate] prefix", () => {
  assert.throws(
    () =>
      throwIfDenied(
        decide({
          tool_input: { file_path: ".opencode/plans/.state/s/gate-state.json" },
        }),
      ),
    /\[plan-write-gate\]/,
  );
  assert.doesNotThrow(() =>
    throwIfDenied(
      decide({
        tool_input: { file_path: "src/app.ts" },
      }),
    ),
  );
});

test("hermetic plugin: OC write to gate-state and canonical plan throw; normal file allows", async () => {
  const hooks = await createPlanWriteGateHooks();
  const before = hooks["tool.execute.before"];
  assert.equal(typeof before, "function");

  await assert.rejects(
    () =>
      before(
        { tool: "write" },
        {
          args: {
            filePath: ".opencode/plans/.state/ses_x/gate-state.json",
            content: "{}",
          },
        },
      ),
    /\[plan-write-gate\]/,
  );

  await assert.rejects(() =>
    before(
      { tool: "write" },
      {
        args: {
          filePath: ".opencode/plans/feat/execution-plan.json",
          content: "{}",
        },
      },
    ),
    /canonical plan/,
  );

  await assert.doesNotReject(() =>
    before(
      { tool: "edit" },
      { args: { filePath: "src/lib/foo.ts", content: "x" } },
    ),
  );

  // namespaced write tool
  await assert.rejects(
    () =>
      before(
        { tool: "file.write" },
        { args: { path: "cwd/triage.json", content: "{}" } },
      ),
    /\[plan-write-gate\]/,
  );
});

test("canonical execution plan is denied through Write/Edit regardless of binding", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-bound-"));
  try {
    const stateDir = path.join(root, ".opencode", "plans", ".state", "ses_bound");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ planner_status: "usable" }));
    const before = (await createScopedHooks(root))["tool.execute.before"];
    await assert.rejects(
      () => before(
        { tool: "write", sessionID: "ses_bound" },
        { args: { filePath: ".opencode/plans/ses_bound-feat/execution-plan.json", content: "{}" } },
      ),
      /canonical plan/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scope rail locked tests (A3 parity for OC plan-write-decide + hook)
// ---------------------------------------------------------------------------

test("lt-scope-out-deny: call-keyed scope_paths=['src/a.ts'] role executor, actingRole executor-high, isSubagent true, write src/b.ts → allow false, reason includes src/b.ts and scope", () => {
  const payload = { tool_input: { file_path: "src/b.ts" } };
  const gateState = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "feat",
      task_id: "t1",
      scope_paths: ["src/a.ts"],
      allowed_writes: [],
    } },
  };
  const r = decide(payload, { gateState, dispatchRecord: gateState.dispatch_records.legacy, actingRole: "executor-high", isSubagent: true });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /src\/b\.ts/);
  assert.match(r.reason ?? "", /scope/);
});

test("lt-scope-in-allow: same, write src/a.ts → allow true", () => {
  const payload = { tool_input: { file_path: "src/a.ts" } };
  const gateState = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "feat",
      task_id: "t1",
      scope_paths: ["src/a.ts"],
      allowed_writes: [],
    } },
  };
  const r = decide(payload, { gateState, dispatchRecord: gateState.dispatch_records.legacy, actingRole: "executor-high", isSubagent: true });
  assert.equal(r.allow, true);
});

test("frozen oracle denies executor and sniper before their broad scope allows the write", () => {
  for (const role of ["executor-high", "sniper-medium"]) {
    const record = {
      role: role.startsWith("sniper") ? "sniper" : "executor", feature_id: "feat", task_id: "t1",
      scope_paths: ["src/"], allowed_writes: [], frozen_paths: ["src/oracle.test.mjs", "src/fixtures/oracle.json"],
    };
    const result = decide({ tool_input: { file_path: "src/oracle.test.mjs" } }, {
      dispatchRecord: record, actingRole: role, isSubagent: true,
    });
    assert.equal(result.allow, false, role);
    assert.match(result.reason ?? "", /frozen/i);
  }
});

test("lt-scope-file-not-prefix: scope ['src/a.ts'], write src/a.ts/evil.ts → allow false", () => {
  const payload = { tool_input: { file_path: "src/a.ts/evil.ts" } };
  const gateState = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "f",
      task_id: "t",
      scope_paths: ["src/a.ts"],
      allowed_writes: [],
    } },
  };
  const r = decide(payload, { gateState, dispatchRecord: gateState.dispatch_records.legacy, actingRole: "executor-high", isSubagent: true });
  assert.equal(r.allow, false);
});

test("lt-scope-dir-prefix-allow: scope ['src/lib'] or ['src/lib/'], write src/lib/foo.ts → allow true", () => {
  const gateStateDir = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "f",
      task_id: "t",
      scope_paths: ["src/lib"],
      allowed_writes: [],
    } },
  };
  const gateStateDirSlash = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "f",
      task_id: "t",
      scope_paths: ["src/lib/"],
      allowed_writes: [],
    } },
  };
  const p = { tool_input: { file_path: "src/lib/foo.ts" } };
  assert.equal(
    decide(p, { gateState: gateStateDir, dispatchRecord: gateStateDir.dispatch_records.legacy, actingRole: "executor-high", isSubagent: true }).allow,
    true,
  );
  assert.equal(
    decide(p, { gateState: gateStateDirSlash, dispatchRecord: gateStateDirSlash.dispatch_records.legacy, actingRole: "executor-high", isSubagent: true }).allow,
    true,
  );
});

test("lt-scope-family-match: ad.role='executor', acting executor-high, out of scope → deny", () => {
  const payload = { tool_input: { file_path: "src/b.ts" } };
  const gateState = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "f",
      task_id: "t",
      scope_paths: ["src/a.ts"],
      allowed_writes: [],
    } },
  };
  const r = decide(payload, { gateState, dispatchRecord: gateState.dispatch_records.legacy, actingRole: "executor-high", isSubagent: true });
  assert.equal(r.allow, false);
});

test("lt-scope-role-mismatch-failopen: ad.role sniper, acting executor, out of sniper scope → allow true", () => {
  const payload = { tool_input: { file_path: "src/b.ts" } };
  const gateState = {
    dispatch_records: { legacy: {
      role: "sniper",
      feature_id: "f",
      task_id: "t",
      scope_paths: ["src/fix.ts"],
      allowed_writes: [],
    } },
  };
  const r = decide(payload, { gateState, dispatchRecord: gateState.dispatch_records.legacy, actingRole: "executor", isSubagent: true });
  assert.equal(r.allow, true);
});

test("lt-scope-no-record-failopen: no call-keyed record → allow true for src/anywhere.ts", () => {
  const payload = { tool_input: { file_path: "src/anywhere.ts" } };
  const r = decide(payload, { gateState: {}, actingRole: "executor-high", isSubagent: true });
  assert.equal(r.allow, true);
});

test("lt-anti-forge-still-denies: armed scope that includes gate-state path, write gate-state.json → deny anti-forge reason", () => {
  const payload = {
    tool_input: { file_path: ".opencode/plans/.state/ses/gate-state.json" },
  };
  const gateState = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "f",
      task_id: "t",
      scope_paths: [".opencode/plans/.state/ses/gate-state.json"],
      allowed_writes: [],
    } },
  };
  const r = decide(payload, { gateState, dispatchRecord: gateState.dispatch_records.legacy, actingRole: "executor-high", isSubagent: true });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /gate-state|harness markers/);
});

test("lt-allowed-writes-allow: scope src/a.ts, allowed_writes docs/x.md, write docs/x.md → allow true", () => {
  const payload = { tool_input: { file_path: "docs/x.md" } };
  const gateState = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "f",
      task_id: "t",
      scope_paths: ["src/a.ts"],
      allowed_writes: ["docs/x.md"],
    } },
  };
  const r = decide(payload, { gateState, dispatchRecord: gateState.dispatch_records.legacy, actingRole: "executor-high", isSubagent: true });
  assert.equal(r.allow, true);
});

test("lt-scope-path-normalize-escape: scope ['src/lib'], write src/lib/../b.ts → allow false", () => {
  const payload = { tool_input: { file_path: "src/lib/../b.ts" } };
  const gateState = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "f",
      task_id: "t",
      scope_paths: ["src/lib"],
      allowed_writes: [],
    } },
  };
  const r = decide(payload, { gateState, dispatchRecord: gateState.dispatch_records.legacy, actingRole: "executor-high", isSubagent: true });
  assert.equal(r.allow, false);
});

test("lt-factory-hook-scope-rail: temp dir with a call-keyed state record; out-of-scope write throws and in-scope write passes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-scope-"));
  try {
    await installComposition(root);
    const stateDir = path.join(root, ".opencode", "plans", ".state", "ses_scope");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        dispatch_records: { legacy: {
          role: "executor",
          feature_id: "feat-scope",
          task_id: "t1",
          scope_paths: ["src/a.ts"],
          allowed_writes: [],
        } },
      }),
      "utf8",
    );
    const hooks = await createScopedHooks(root);
    const before = hooks["tool.execute.before"];
    assert.equal(typeof before, "function");

    await assert.rejects(
      () =>
        before(
          {
            tool: "write",
            sessionID: "ses_scope",
            agent: "executor-high",
          },
          {
            args: {
              filePath: "src/b.ts",
              content: "x",
            },
          },
        ),
      /\[plan-write-gate\]/,
    );

    await assert.doesNotReject(() =>
      before(
        {
          tool: "write",
          sessionID: "ses_scope",
          agent: "executor-high",
        },
        {
          args: {
            filePath: "src/a.ts",
            content: "x",
          },
        },
      ),
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("lt-factory-hook-input-agent-no-subagent_type: armed dispatch + Write args only filePath src/b.ts + input.agent executor-high (no subagent_type on args) → deny out-of-scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-agent-"));
  try {
    await installComposition(root);
    const stateDir = path.join(root, ".opencode", "plans", ".state", "ses_agent");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        dispatch_records: { legacy: {
          role: "executor",
          feature_id: "feat-agent",
          task_id: "t1",
          scope_paths: ["src/a.ts"],
          allowed_writes: [],
        } },
      }),
      "utf8",
    );
    const hooks = await createScopedHooks(root);
    const before = hooks["tool.execute.before"];

    await assert.rejects(
      () =>
        before(
          {
            tool: "write",
            sessionID: "ses_agent",
            agent: "executor-high",
          },
          {
            args: {
              filePath: "src/b.ts",
              content: "x",
            },
          },
        ),
      /\[plan-write-gate\]/,
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// HIGH sniper re-gate: role spoof (A), case-sensitive scope (B), agent_id-only (C)
// ---------------------------------------------------------------------------

test("lt-scope-role-spoof-compliance-args: input.agent=executor-high + args.subagent_type=compliance + armed + write src/b.ts → DENY (not fail-open)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-spoof-c-"));
  try {
    await installComposition(root);
    const stateDir = path.join(root, ".opencode", "plans", ".state", "ses_spoof_c");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        dispatch_records: { legacy: {
          role: "executor",
          feature_id: "feat-spoof",
          task_id: "t1",
          scope_paths: ["src/a.ts"],
          allowed_writes: [],
        } },
      }),
      "utf8",
    );
    const hooks = await createScopedHooks(root);
    const before = hooks["tool.execute.before"];

    await assert.rejects(
      () =>
        before(
          {
            tool: "write",
            sessionID: "ses_spoof_c",
            agent: "executor-high",
          },
          {
            args: {
              filePath: "src/b.ts",
              content: "x",
              subagent_type: "compliance",
            },
          },
        ),
      /\[plan-write-gate\]/,
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("lt-scope-role-spoof-sniper-args: input.agent=executor-high + args.subagent_type=sniper-high + armed + write src/b.ts → DENY (no family-mismatch fail-open from spoofed args)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-spoof-s-"));
  try {
    await installComposition(root);
    const stateDir = path.join(root, ".opencode", "plans", ".state", "ses_spoof_s");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        dispatch_records: { legacy: {
          role: "executor",
          feature_id: "feat-spoof-s",
          task_id: "t1",
          scope_paths: ["src/a.ts"],
          allowed_writes: [],
        } },
      }),
      "utf8",
    );
    const hooks = await createScopedHooks(root);
    const before = hooks["tool.execute.before"];

    await assert.rejects(
      () =>
        before(
          {
            tool: "write",
            sessionID: "ses_spoof_s",
            agent: "executor-high",
          },
          {
            args: {
              filePath: "src/b.ts",
              content: "x",
              subagent_type: "sniper-high",
            },
          },
        ),
      /\[plan-write-gate\]/,
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("lt-scope-case-sensitive-deny: scope ['src/a.ts'], write 'SRC/A.TS' → deny when rail armed", () => {
  const payload = { tool_input: { file_path: "SRC/A.TS" } };
  const gateState = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "feat-case",
      task_id: "t1",
      scope_paths: ["src/a.ts"],
      allowed_writes: [],
    } },
  };
  const r = decide(payload, {
    gateState,
    dispatchRecord: gateState.dispatch_records.legacy,
    actingRole: "executor-high",
    isSubagent: true,
  });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /SRC\/A\.TS|scope|OUTSIDE/i);
});

test("lt-scope-agent-id-only-no-role: isSubagent true + empty actingRole + armed executor dispatch + write src/b.ts → DENY (no fail-open)", () => {
  const payload = { tool_input: { file_path: "src/b.ts" } };
  const gateState = {
    dispatch_records: { legacy: {
      role: "executor",
      feature_id: "feat-id-only",
      task_id: "t1",
      scope_paths: ["src/a.ts"],
      allowed_writes: [],
    } },
  };
  const r = decide(payload, {
    gateState,
    dispatchRecord: gateState.dispatch_records.legacy,
    actingRole: "",
    isSubagent: true,
  });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /identity|acting role|agent_id/i);
});

test("lt-factory-hook-agent-id-only: input.agent_id only (no role) + armed executor + write src/b.ts → deny", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-id-only-"));
  try {
    await installComposition(root);
    const stateDir = path.join(root, ".opencode", "plans", ".state", "ses_id_only");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        dispatch_records: { legacy: {
          role: "executor",
          feature_id: "feat-id-only",
          task_id: "t1",
          scope_paths: ["src/a.ts"],
          allowed_writes: [],
        } },
      }),
      "utf8",
    );
    const hooks = await createScopedHooks(root);
    const before = hooks["tool.execute.before"];

    await assert.rejects(
      () =>
        before(
          {
            tool: "write",
            sessionID: "ses_id_only",
            agent_id: "ag_sub_1",
          },
          {
            args: {
              filePath: "src/b.ts",
              content: "x",
            },
          },
        ),
      /\[plan-write-gate\]/,
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("lt-factory-hook-agent-id-only-spoof-args-sniper: input.agent_id only + args.subagent_type=sniper-high + armed executor + write src/b.ts → DENY (args cannot set actingRole)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-id-spoof-"));
  try {
    await installComposition(root);
    const stateDir = path.join(root, ".opencode", "plans", ".state", "ses_id_spoof");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        dispatch_records: { legacy: {
          role: "executor",
          feature_id: "feat-id-spoof",
          task_id: "t1",
          scope_paths: ["src/a.ts"],
          allowed_writes: [],
        } },
      }),
      "utf8",
    );
    const hooks = await createScopedHooks(root);
    const before = hooks["tool.execute.before"];

    await assert.rejects(
      () =>
        before(
          {
            tool: "write",
            sessionID: "ses_id_spoof",
            agent_id: "ag_sub_spoof",
          },
          {
            args: {
              filePath: "src/b.ts",
              content: "x",
              subagent_type: "sniper-high",
            },
          },
        ),
      /\[plan-write-gate\]/,
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("lt-factory-hook-absolute-path-scope: scope src/a.ts; absolute join(root,src/a.ts) allow; absolute out-of-scope deny", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-abs-"));
  try {
    await installComposition(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const stateDir = path.join(root, ".opencode", "plans", ".state", "ses_abs");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({
        dispatch_records: { legacy: {
          role: "executor",
          feature_id: "feat-abs",
          task_id: "t1",
          scope_paths: ["src/a.ts"],
          allowed_writes: [],
        } },
      }),
      "utf8",
    );
    const hooks = await createScopedHooks(root);
    const before = hooks["tool.execute.before"];

    await assert.doesNotReject(() =>
      before(
        {
          tool: "write",
          sessionID: "ses_abs",
          agent: "executor-high",
        },
        {
          args: {
            filePath: path.join(root, "src", "a.ts"),
            content: "x",
          },
        },
      ),
    );

    await assert.rejects(
      () =>
        before(
          {
            tool: "write",
            sessionID: "ses_abs",
            agent: "executor-high",
          },
          {
            args: {
              filePath: path.join(root, "src", "b.ts"),
              content: "x",
            },
          },
        ),
      /\[plan-write-gate\]/,
    );

    await assert.rejects(
      () =>
        before(
          {
            tool: "write",
            sessionID: "ses_abs",
            agent: "executor-high",
          },
          {
            args: {
              filePath: "/tmp/outside-project/evil.ts",
              content: "x",
            },
          },
        ),
      /\[plan-write-gate\]/,
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("out-of-scope Write denies without a composition shadow registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-shadow-"));
  try {
    const session = "ses_shadow";
    const stateDir = path.join(root, ".opencode", "plans", ".state", session);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ dispatch_records: { legacy: {
      session_id: session, feature_id: "feat", task_id: "task", role: "executor-high",
      scope_paths: ["src/a.ts"], allowed_writes: [], call_id: "task-call",
    } } }));
    const before = (await createScopedHooks(root, { scopePaths: ["src"] }))["tool.execute.before"];
    await assert.rejects(() => before(
      { tool: "write", sessionID: session, agent: "executor-high" },
      { args: { filePath: "outside/b.ts", content: "private content must not be logged" } },
    ), /OUTSIDE/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("composition proof enforces Edit scope while Bash is never walled (#484)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-enforce-tools-"));
  try {
    await installComposition(root);
    const session = "ses_tools";
    const stateDir = path.join(root, ".opencode", "plans", ".state", session);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ dispatch_records: { legacy: {
      session_id: session, feature_id: "feat", task_id: "task", role: "executor-high",
      scope_paths: ["src"], allowed_writes: [], call_id: "task-call",
    } } }));
    const before = (await createScopedHooks(root, { scopePaths: ["src"] }))["tool.execute.before"];
    await assert.rejects(() => before(
      { tool: "edit", sessionID: session, agent: "executor-high" },
      { args: { filePath: "outside/b.ts", oldString: "x", newString: "y" } },
    ), /OUTSIDE|safe project path/);
    // #484: plan-write-gate never walls Bash, active writing-hand dispatch or not — Claude
    // Code parity (its plan-write-gate only rails Write/Edit). Every one of these previously
    // denied under the OC-only blanket bash deny.
    for (const command of [
      "git status --short",
      "git diff --stat",
      "git log --oneline -3",
      "git rev-parse HEAD",
      "node --test test/foo.test.ts",
      "ls src",
      "cat src/ok.ts",
      "touch src/ok.ts outside/evil.ts",
      "node script.mjs",
      "python tool.py",
      "npm test",
      "git apply fix.patch",
      "dd if=/dev/zero of=out.bin",
      "tee out.txt",
      "env node script.mjs",
      "bash -c 'touch src/x'",
      "cat input | sponge output",
      "git -c core.pager='sh -c evil' status",
      "rg --pre 'sh -c evil' pattern",
    ]) {
      await assert.doesNotReject(() => before(
        { tool: "bash", sessionID: session, agent: "executor-high" },
        { args: { command } },
      ), command);
    }
    await assert.doesNotReject(() => before(
      { tool: "apply_patch", sessionID: session, agent: "executor-high" },
      { args: { patchText: "*** Begin Patch\n*** Update File: src/one.ts\n@@\n-old\n+new\n*** Add File: src/two.ts\n+new\n*** End Patch" } },
    ));
    await assert.rejects(() => before(
      { tool: "functions.apply_patch", sessionID: session, agent: "executor-high" },
      { args: { patchText: "*** Begin Patch\n*** Update File: src/one.ts\n@@\n-old\n+new\n*** Add File: outside/evil.ts\n+new\n*** End Patch" } },
    ), /OUTSIDE|safe project path/);
    await assert.doesNotReject(() => before(
      { tool: "multi_edit", sessionID: session, agent: "executor-high" },
      { args: { edits: [{ filePath: "src/one.ts" }, { filePath: "src/two.ts" }] } },
    ));
    await assert.rejects(() => before(
      { tool: "write_file", sessionID: session, agent: "executor-high" },
      { args: { filePath: "outside/write.ts" } },
    ), /OUTSIDE|safe project path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Bash during an active writing-hand dispatch is never shadow-recorded or blocked (#484)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-shadow-bash-"));
  try {
    const session = "ses_shadow_bash";
    const stateDir = path.join(root, ".opencode", "plans", ".state", session);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ dispatch_records: { legacy: {
      session_id: session, feature_id: "feat", task_id: "task", role: "executor-high",
      scope_paths: ["src"], allowed_writes: [], call_id: "task-call",
    } } }));
    const before = (await createScopedHooks(root))["tool.execute.before"];
    await assert.doesNotReject(() => before(
      { tool: "bash", sessionID: session, agent: "executor-high" },
      { args: { command: "node script.mjs" } },
    ));
    await assert.doesNotReject(() => before(
      { tool: "bash", sessionID: session, agent: "executor-high" },
      { args: { command: "python tool.py" } },
    ));
    // Bash skips identity/scope resolution, but its literal anti-forge check still runs.
    assert.equal(fs.existsSync(path.join(stateDir, "scope-events.jsonl")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Bash verification bypasses a conflicting writing-hand identity", async () => {
  const hooks = await createPlanWriteGateHooks("/workspace", {
    resolveRuntimeIdentity: async () => ({
      ok: false,
      conflict: true,
      reason: "official writing-hand message relationship conflicts",
    }),
  });
  const before = hooks["tool.execute.before"];

  await assert.doesNotReject(() => before(
    { tool: "bash", sessionID: "ses-review", agent: "compliance" },
    { args: { command: "node --test tests/domain-migrations.test.mjs" } },
  ));
  await assert.rejects(() => before(
    { tool: "write", sessionID: "ses-review", agent: "executor-medium" },
    { args: { filePath: "src/outside-scope.ts", content: "x" } },
  ), /identity conflicts/);
});

test("apply_patch denies an unsafe path without a composition shadow registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-shadow-patch-"));
  try {
    const session = "ses_shadow_patch";
    const stateDir = path.join(root, ".opencode", "plans", ".state", session);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ dispatch_records: { legacy: {
      session_id: session, feature_id: "feat", task_id: "task", role: "executor-high",
      scope_paths: ["src"], allowed_writes: [], call_id: "task-call",
    } } }));
    const before = (await createScopedHooks(root))["tool.execute.before"];
    await assert.rejects(() => before(
      { tool: "apply_patch", sessionID: session, agent: "executor-high" },
      { args: { patchText: "*** Begin Patch\n*** Update File: src/in.ts\n@@\n-a\n+b\n*** Update File: ../escape.ts\n@@\n-a\n+b\n*** End Patch" } },
    ), /OUTSIDE|safe project path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
