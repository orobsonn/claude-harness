/** @description Native second-eye coordinator reads authoritative routing instead of caller claims. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

const stub = `
  const schemaValue = { optional() { return this }, describe() { return this } };
  export const tool = (definition) => definition;
  tool.schema = { string() { return Object.create(schemaValue) } };
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin/tool") {
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const pluginPath = new URL("./second-eye-coordinator.ts", import.meta.url);
const { default: secondEyeCoordinator } = await import(pluginPath.href);
const {
  beginSecondEyeDispatch,
  recordRefuteDispatchResult,
  recordSecondEyeDispatchResult,
} = await import("./lib/second-eye-authority.mjs");
const { reviewReportHash } = await import("./lib/loop-decide.mjs");

const finding = {
  description: "Boundary failure",
  category: "boundary",
  severity: "medium",
  scope: "src/a.ts",
  evidence: "src/a.ts:handler",
  suggested_sniper_tier: "sniper-medium",
  fix_hint: "Fix src/a.ts:handler",
};

test("prepare tool trusts canonical routing and preserves the no-second-eye default", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "second-eye-coordinator-"));
  try {
    fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
    const routingPath = path.join(root, ".opencode", "harness.routing.json");
    fs.writeFileSync(routingPath, JSON.stringify({ roles: { adversary: { model: "openai/gpt-5.6-sol" } } }));
    const statePath = path.join(root, ".opencode", "plans", ".state", "ses-second-eye", "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const primaryReport = { issues: [] };
    const primaryHash = reviewReportHash(primaryReport);
    fs.writeFileSync(statePath, JSON.stringify({
      session_id: "ses-second-eye",
      feature_id: "issue-603",
      review_epoch: 1,
      primary_review_last_report: primaryReport,
      primary_review_last_report_hash: primaryHash,
      review_outcomes: [{
        canonical_identity: "adversary",
        logical_role: "adversary",
        outcome: "useful",
        report_hash: primaryHash,
        session_id: "ses-second-eye",
        feature_id: "issue-603",
        epoch: 1,
        family: 1,
      }],
    }));
    const hooks = await secondEyeCoordinator({ directory: root, worktree: root });
    const args = {
      role: "adversary",
    };
    const context = { sessionID: "ses-second-eye" };
    const primaryOnly = JSON.parse((await hooks.tool["second-eye-prepare"].execute(args, context)).output);
    assert.equal(primaryOnly.action, "primary-only");
    assert.equal(primaryOnly.refute_dispatch, null);

    fs.writeFileSync(routingPath, JSON.stringify({ roles: { adversary: { model: "openai/gpt-5.6-sol", secondEyeModel: "xai/grok-4.5" } } }));
    beginSecondEyeDispatch({
      sessionId: context.sessionID,
      callId: "secondary-call",
      role: "adversary",
      featureId: "issue-603",
      epoch: 1,
      primaryReportHash: primaryHash,
    });
    recordSecondEyeDispatchResult({
      sessionId: context.sessionID,
      callId: "secondary-call",
      result: `\`\`\`json\n${JSON.stringify({ issues: [finding] })}\n\`\`\`\nSecondary narrative.`,
    });
    const configured = JSON.parse((await hooks.tool["second-eye-prepare"].execute(args, context)).output);
    assert.equal(configured.action, "dispatch-refute");
    assert.equal(configured.refute_dispatch.subagent_type, "adversary");
    assert.equal(typeof configured.adjudication_id, "string");

    const targetId = configured.classified.onlyB[0].id;
    const premature = JSON.parse((await hooks.tool["second-eye-finalize"].execute({
      adjudication_id: configured.adjudication_id,
    }, context)).output);
    assert.equal(premature.ok, false);
    recordRefuteDispatchResult(
      configured.adjudication_id,
      JSON.stringify({ refutations: [{ target_id: targetId, refuted: false, reason: "real" }] }),
    );
    const finalized = JSON.parse((await hooks.tool["second-eye-finalize"].execute({
      adjudication_id: configured.adjudication_id,
    }, context)).output);
    assert.equal(finalized.action, "route-findings");
    assert.deepEqual(finalized.result, { issues: [] });
    assert.equal(finalized.findings.length, 1);

    const replay = JSON.parse((await hooks.tool["second-eye-finalize"].execute({
      adjudication_id: configured.adjudication_id,
    }, context)).output);
    assert.equal(replay.ok, false);

    const tamperedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    tamperedState.primary_review_last_report = { issues: [finding] };
    fs.writeFileSync(statePath, JSON.stringify(tamperedState));
    const rejected = JSON.parse((await hooks.tool["second-eye-prepare"].execute(args, context)).output);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "authoritative primary report missing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
