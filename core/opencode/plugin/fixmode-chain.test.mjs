/**
 * @description Composition contract for the OpenCode dispatch plugin chain under a FIX-MODE sniper
 * resume: plan-gate → obs-hand → entry-gate, in the documented `DISPATCH_CHAIN_ORDER`, all three
 * driven over ONE shared `input`/`output` pair.
 *
 * REHOMED by issue #807 from `core/vps/cron-a-dispatch-fixmode.test.mjs` (:356, :451, :481), which
 * died with the retired `core/vps/` engine. None of these three tests calls the retired `dispatch()`
 * — they exercise the live plugins only, which is why they must survive the engine.
 *
 * The delete-safety audit proved this is the ONLY file in the repo that runs all three
 * `create*Hooks` over one shared input/output: `plugin-dispatch-order.test.mjs` asserts file ORDER
 * and the AGENTS.md §12 match but never executes a hook; `plan-write-gate.test.mjs` merely
 * INSTANTIATES plan-gate + obs-hand; `entry-gate.test.mjs` chains obs-hand + entry-gate on the
 * `after` hook only. The cold-repo leg is likewise not covered by `stable-plan-gate.test.mjs`, whose
 * `fixture()` always writes a `gate-state.json` — so the truly cold no-gate-state path is only
 * asserted here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PlanGate } from "./plan-gate.ts";
import { obsHand } from "./obs-hand.ts";
import { EntryGate } from "./entry-gate.ts";
import { decideClassifyAuthority } from "../../shared/lib/classify-authority.mjs";
import { decideClassifyTransition } from "../../shared/lib/classify-stub.mjs";
import { executionPlanPath, gateStatePath } from "../../shared/lib/path-helpers.mjs";
import {
  FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE,
  persistClassifyState,
} from "../tools/lib/classify-persist.mjs";

const { createPlanGateHooks } = PlanGate.testApi;
const { createObsHandHooks } = obsHand.testApi;
const { createEntryGateHooks } = EntryGate.testApi;

const SHA = "abc123abc123abc123abc123abc123abc123abcd";

const DISPATCH_CHAIN = [
  ["plan-gate", createPlanGateHooks],
  ["obs-hand", createObsHandHooks],
  ["entry-gate", createEntryGateHooks],
];

/**
 * Reconstructs the native classify tool's pure path: authority, transition, then triage-state
 * persistence. Classification deliberately does not create or rewrite the stable feature plan.
 */
function runRealClassify({ root, sessionId, featureId, mode, priorState }) {
  const auth = decideClassifyAuthority({ agent: "", parentSessionId: null, sessionId });
  if (!auth.ok) throw new Error(`classify authority denied: ${auth.reason}`);

  const gsPath = gateStatePath({ projectRoot: root, runtime: "opencode", sessionId });
  if (!gsPath.ok) throw new Error(`invalid gate-state path: ${gsPath.reason}`);
  if (priorState !== undefined) {
    fs.mkdirSync(path.dirname(gsPath.path), { recursive: true });
    fs.writeFileSync(gsPath.path, `${JSON.stringify(priorState)}\n`, "utf8");
  }

  const transition = decideClassifyTransition({
    requestedMode: mode,
    requestedFeatureId: featureId,
    currentMode: undefined,
    currentFeatureId: undefined,
    peakMode: undefined,
    classified: false,
  });
  if (!transition.ok) throw new Error(`classify transition denied: ${transition.reason}`);
  if (transition.action !== "fresh") {
    throw new Error(`runRealClassify only models the "fresh" transition; got "${transition.action}"`);
  }

  const statePatch = {
    session_id: sessionId,
    feature_id: transition.featureId,
    mode: transition.mode,
    peak_mode: transition.peakMode,
    classified: true,
    triaged: true,
  };

  const persisted = persistClassifyState({
    statePath: gsPath.path,
    statePatch,
    removeStateKeys: FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE,
  });
  if (!persisted.ok) throw new Error(`classify persistence failed: ${persisted.reason}`);
  return persisted.state;
}

function writeStableFixPlan(root, featureId) {
  const resolved = executionPlanPath({ projectRoot: root, runtime: "opencode", featureId });
  if (!resolved.ok) throw new Error(resolved.reason);
  const plan = {
    feature_id: featureId,
    mode: "light",
    model_strategy: {
      hand_tiers: { low: "openai/gpt-5.6-luna", medium: "openai/gpt-5.6-luna", high: "openai/gpt-5.6-terra" },
      planner: "openai/gpt-5.6-sol",
      "plan-reviewer": "openai/gpt-5.6-sol",
      compliance: "openai/gpt-5.6-sol",
      adversary: "openai/gpt-5.6-sol",
      security: "openai/gpt-5.6-sol",
      harvester: "openai/gpt-5.6-luna",
      shipper: "openai/gpt-5.6-luna",
    },
    final_review: { compliance: true, adversary: true },
    demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] },
    tasks: [{
      id: "t0-fix",
      title: "Apply reviewed fix",
      description: "Apply the bounded review finding.",
      depends_on: [],
      severity: "medium",
      complexity: "medium",
      scope_paths: ["core/x.mjs"],
      resolved_judgments: { source: "approved stable plan" },
      criterion_refs: ["#ac-1"],
      locked_tests: [{ id: "lt-fix", path: "test/fix.test.mjs", assertion: "Given a reviewed fix, When applied, Then the regression stays closed" }],
      adversarial: { enabled: false, focus: [] },
    }],
  };
  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  fs.writeFileSync(resolved.path, `${JSON.stringify(plan)}\n`, "utf8");
}

function fixEntryDeps(scopePaths = ["core/x.mjs"]) {
  return {
    dispatchEnvironment: {
      HARNESS_FIX_MODE: "1",
      HARNESS_FIX_SCOPE_JSON: JSON.stringify({ version: 1, reviewed_sha: SHA, scope_paths: scopePaths }),
    },
    isAncestorFn: () => true,
  };
}

/**
 * Drives a single Task dispatch through the real before-hook chain against a project root, in
 * documented order. Returns `{ survived: true }` if every plugin's `tool.execute.before` allowed
 * it, or `{ survived: false, deniedAt, message }` at the first thrown deny.
 */
async function runDispatchChain(root, input, output, entryDeps = null) {
  for (const [name, factory] of DISPATCH_CHAIN) {
    const hooks = name === "entry-gate" && entryDeps ? await factory(root, entryDeps) : await factory(root);
    const before = hooks["tool.execute.before"];
    if (!before) continue;
    try {
      await before(input, output);
    } catch (err) {
      return { survived: false, deniedAt: name, message: err instanceof Error ? err.message : String(err) };
    }
  }
  return { survived: true };
}

test("#ac-3.1 sniper Task dispatch with classified LIGHT state and an existing stable plan survives the real dispatch chain", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixmode-chain-"));
  try {
    const sessionId = "ses_fixmode_chain";
    const featureId = "feat-fixmode-chain";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    const gateState = {
      session_id: sessionId,
      feature_id: featureId,
      mode: "LIGHT",
      classified: true,
    };
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify(gateState), "utf8");
    writeStableFixPlan(root, featureId);

    const input = { tool: "task", sessionID: sessionId, callID: "call-fixmode-1" };
    const output = {
      args: {
        prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"t0-fix"}[/HARNESS_TASK_CONTEXT]\nFix the reported bug.`,
        subagent_type: "sniper-high",
        feature_id: featureId,
        task_id: "t0-fix",
      },
    };

    for (const [name, createHooks] of DISPATCH_CHAIN) {
      const hooks = name === "entry-gate" ? await createHooks(root, fixEntryDeps()) : await createHooks(root);
      await assert.doesNotReject(
        () => hooks["tool.execute.before"](input, output),
        `${name} must not deny the fix-mode sniper dispatch`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("chain: sniper Task dispatch with no classified state or stable plan is denied by the factual plan gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixmode-chain-"));
  try {
    // Deliberately nothing on disk: no `.opencode/plans/.state/<sid>/gate-state.json`, no
    // `.opencode/harness.routing.json` — the cold-repo / fleet-fix-mode shape the roadmap names.
    const sessionId = "ses_fixmode_chain";
    const input = {
      tool: "task",
      sessionID: sessionId,
      callID: "fixmode-chain-sniper",
    };
    const output = {
      args: {
        prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"t0-fix"}[/HARNESS_TASK_CONTEXT]\nFix the reported bug.`,
        subagent_type: "sniper-medium",
        feature_id: "feat-fixmode-chain",
        task_id: "t0-fix",
      },
    };

    const result = await runDispatchChain(root, input, output);
    assert.equal(result.survived, false,
      "expected a truly cold/empty gate-state to be DENIED (ceremony/classify missing), not to survive");
    assert.equal(result.deniedAt, "plan-gate");
    assert.match(result.message, /gate-state missing|stable plan missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#ac-3 (issue #513): classify plus the pre-existing stable plan lets a fix-mode sniper resume", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixmode-classify-"));
  try {
    const sessionId = "ses_fixmode_classify_513";
    const featureId = "feat-fixmode-classify-513";

    // Nothing on disk yet — same cold start as the `chain:` test above. Simulate a session that
    // followed FIX_MODE_TRIGGER's new instruction by actually running the real classify pipeline
    // before the sniper dispatch.
    const persistedState = runRealClassify({ root, sessionId, featureId, mode: "LIGHT" });
    assert.equal(persistedState.classified, true, "classify must persist classified:true");
    assert.equal(persistedState.mode, "LIGHT", "classify must persist mode LIGHT");
    writeStableFixPlan(root, featureId);

    const input = { tool: "task", sessionID: sessionId, callID: "call-fixmode-classify-1" };
    const output = {
      args: {
        prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"t0-fix"}[/HARNESS_TASK_CONTEXT]\nFix the reported bug.`,
        subagent_type: "sniper-high",
        feature_id: featureId,
        task_id: "t0-fix",
      },
    };

    const result = await runDispatchChain(root, input, output, fixEntryDeps());
    assert.equal(
      result.survived,
      true,
      `expected the sniper dispatch to survive once classify genuinely ran first; denied at ${result.deniedAt}: ${result.message}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
