/** @description Deterministic ceremony ordering, durable restart recovery, tamper rejection, and persistence tests. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createEntryGateHooks } from "./entry-gate.ts";
import {
  captureSpecAdversaryResult,
  completionEvidence,
  recoverCeremony,
  transitionCeremony,
} from "./lib/ceremony-transition.mjs";
import { withGateStateLock } from "./lib/gate-state.mjs";

const SESSION = "ses-ceremony-recovery";
const FEATURE = "deterministic-resume";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ceremony-recovery-"));
  const stateFile = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
  const specFile = path.join(root, ".opencode", "plans", `${SESSION}-${FEATURE}`, "spec.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(specFile), { recursive: true });
  fs.writeFileSync(specFile, "# Durable spec\n\n#uj-1\n\n#ac-1.1\n");
  const state = { session_id: SESSION, feature_id: FEATURE, ceremony_generation: "generation-1", classified: true, mode: "FULL" };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return {
    root, stateFile, state,
    read: () => JSON.parse(fs.readFileSync(stateFile, "utf8")),
    write: (value) => fs.writeFileSync(stateFile, JSON.stringify(value)),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function planner(hooks) {
  return hooks["tool.execute.before"](
    { tool: "task", sessionID: SESSION, callID: "planner-call" },
    { args: { subagent_type: "planner", prompt: "Plan." } },
  );
}

function acceptedEvidence(run) {
  const brainstorm = transitionCeremony(run.root, run.state, "brainstormed");
  assert.equal(brainstorm.ok, true);
  assert.equal(captureSpecAdversaryResult(run.root, {
    sessionId: SESSION, featureId: FEATURE, generation: run.state.ceremony_generation, callId: "adversary-call", role: "adversary-family-1",
    output: '{"issues":[]}',
  }), true);
  const adversary = transitionCeremony(run.root, brainstorm.state, "adversary_fired");
  assert.equal(adversary.ok, true);
  return adversary.state.ceremony_evidence;
}

test("fresh flow persists brainstorm then accepted adversary before planner preflight", async () => {
  const run = fixture();
  try {
    const first = transitionCeremony(run.root, run.state, "brainstormed");
    assert.equal(first.ok, true);
    assert.equal(first.state.brainstormed, true);
    assert.equal(first.state.adversary_fired, undefined);
    assert.equal(transitionCeremony(run.root, run.state, "adversary_fired").ok, false);
    assert.equal(captureSpecAdversaryResult(run.root, {
      sessionId: SESSION, featureId: FEATURE, generation: run.state.ceremony_generation, callId: "adv", role: "adversary-family-1", output: '{"issues":[]}',
    }), true);
    const second = transitionCeremony(run.root, first.state, "adversary_fired");
    assert.equal(second.ok, true);
    run.write(second.state);
    const hooks = await createEntryGateHooks(run.root);
    await assert.doesNotReject(() => planner(hooks));
  } finally { run.cleanup(); }
});

test("restart preflight reissues current seals from durable canonical evidence and is idempotent", async () => {
  const run = fixture();
  try {
    const moduleUrl = pathToFileURL(path.resolve("core/opencode/plugin/lib/ceremony-transition.mjs")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import fs from "node:fs";
      const api = await import(${JSON.stringify(moduleUrl)});
      const root = process.argv[1];
      const stateFile = process.argv[2];
      let state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      state = api.transitionCeremony(root, state, "brainstormed").state;
      api.captureSpecAdversaryResult(root, {
        sessionId: state.session_id, featureId: state.feature_id, generation: state.ceremony_generation,
        callId: "child-adversary", role: "adversary-family-1", output: '{"issues":[]}',
      });
      state = api.transitionCeremony(root, state, "adversary_fired").state;
      fs.writeFileSync(stateFile, JSON.stringify(state));
    `, run.root, run.stateFile], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const oldSeal = run.read().brainstormed_binding.seal;
    const hooks = await createEntryGateHooks(run.root);
    await assert.doesNotReject(() => planner(hooks));
    const once = fs.readFileSync(run.stateFile, "utf8");
    assert.equal(run.read().brainstormed, true);
    assert.equal(run.read().adversary_fired, true);
    assert.notEqual(run.read().brainstormed_binding.seal, oldSeal);
    await assert.doesNotReject(() => planner(hooks));
    assert.equal(fs.readFileSync(run.stateFile, "utf8"), once);
  } finally { run.cleanup(); }
});

test("multiprocess restart between phases persists brainstorm recovery, consumes next transition, then resumes planner", async () => {
  const run = fixture();
  try {
    const moduleUrl = pathToFileURL(path.resolve("core/opencode/plugin/lib/ceremony-transition.mjs")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import fs from "node:fs";
      const { transitionCeremony } = await import(${JSON.stringify(moduleUrl)});
      const root = process.argv[1];
      const stateFile = process.argv[2];
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      fs.writeFileSync(stateFile, JSON.stringify(transitionCeremony(root, state, "brainstormed").state));
    `, run.root, run.stateFile], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const staleSeal = run.read().brainstormed_binding.seal;
    const hooks = await createEntryGateHooks(run.root);
    const roles = [];
    await assert.rejects(() => {
      roles.push("planner");
      return planner(hooks);
    }, (error) => {
      const structured = JSON.parse(error.message.slice(error.message.indexOf("{") ));
      assert.equal(structured.code, "CEREMONY_PROOF_REQUIRED");
      assert.equal(structured.missing_proof, "spec_adversary_completion_evidence");
      assert.deepEqual(structured.next_transition, { phase: "spec-adversary", action: "resume", marker: "adversary_fired" });
      return true;
    });
    assert.equal(run.read().brainstormed, true);
    assert.notEqual(run.read().brainstormed_binding.seal, staleSeal);
    assert.equal(run.read().adversary_fired, undefined);

    roles.push("adversary-family-1");
    await assert.doesNotReject(() => hooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION, callID: "spec-adversary" },
      { args: { subagent_type: "adversary-family-1", prompt: "Attack canonical spec." } },
    ));
    assert.equal(captureSpecAdversaryResult(run.root, {
      sessionId: SESSION, featureId: FEATURE, generation: run.state.ceremony_generation,
      callId: "spec-adversary", role: "adversary-family-1", output: '{"issues":[]}',
    }), true);
    const accepted = withGateStateLock(run.stateFile, (previous) => {
      const transition = transitionCeremony(run.root, previous, "adversary_fired");
      return transition.ok ? transition.state : transition;
    });
    assert.equal(accepted.ok, true);
    assert.equal(run.read().adversary_fired, true);

    roles.push("planner");
    await assert.doesNotReject(() => planner(hooks));
    assert.deepEqual(roles, ["planner", "adversary-family-1", "planner"]);
    assert.equal(roles.some((role) => role === "explore" || role === "general"), false);
  } finally { run.cleanup(); }
});

test("concurrent and repeated partial preflights converge on one brainstorm seal and same next proof", async () => {
  const run = fixture();
  try {
    const brainstorm = transitionCeremony(run.root, run.state, "brainstormed");
    run.write({ ...run.state, ceremony_evidence: brainstorm.state.ceremony_evidence });
    const hooks = await createEntryGateHooks(run.root);
    const results = await Promise.allSettled([planner(hooks), planner(hooks)]);
    assert.equal(results.every((result) => result.status === "rejected"), true);
    for (const result of results) assert.match(result.reason.message, /spec_adversary_completion_evidence/);
    const state = run.read();
    assert.equal(state.brainstormed, true);
    assert.equal(state.adversary_fired, undefined);
    assert.equal(state.marker_seals.filter((record) => record.operation === "brainstormed").length, 1);
    const stable = fs.readFileSync(run.stateFile, "utf8");
    await assert.rejects(() => planner(hooks), /spec_adversary_completion_evidence/);
    assert.equal(fs.readFileSync(run.stateFile, "utf8"), stable);
  } finally { run.cleanup(); }
});

test("forged, stale, and cross-session evidence fail with exact deterministic transition", async () => {
  for (const variant of ["forged", "stale", "cross-session"]) {
    const run = fixture();
    try {
      const evidence = acceptedEvidence(run);
      const bad = structuredClone(evidence);
      if (variant === "forged") bad.brainstormed.artifact_sha256 = "0".repeat(64);
      if (variant === "stale") fs.appendFileSync(path.join(run.root, bad.brainstormed.artifact_path), "changed");
      if (variant === "cross-session") bad.brainstormed.session_id = "ses-other";
      run.write({ ...run.state, ceremony_evidence: bad });
      const hooks = await createEntryGateHooks(run.root);
      await assert.rejects(() => planner(hooks), (error) => {
        assert.match(error.message, /CEREMONY_PROOF_REQUIRED/);
        assert.match(error.message, /brainstorming_completion_evidence/);
        assert.match(error.message, /"phase":"brainstorming"/);
        return true;
      });
      assert.equal(run.read().brainstormed, undefined, variant);
    } finally { run.cleanup(); }
  }
});

test("missing evidence never invents a terminal marker or diagnostic agent dispatch", async () => {
  const run = fixture();
  try {
    const hooks = await createEntryGateHooks(run.root);
    await assert.rejects(() => planner(hooks), /brainstorming_completion_evidence/);
    assert.equal(run.read().brainstormed, undefined);
    assert.equal(run.read().adversary_fired, undefined);
    assert.doesNotMatch(JSON.stringify(run.read()), /explore|general/);
  } finally { run.cleanup(); }
});

test("persistence failure blocks planner without exposing recovered markers", async () => {
  const run = fixture();
  try {
    run.write({ ...run.state, ceremony_evidence: acceptedEvidence(run) });
    let persistenceCalls = 0;
    const hooks = await createEntryGateHooks(run.root, {
      ceremonyPersistFn: () => {
        persistenceCalls += 1;
        return { ok: false, reason: "injected persistence failure" };
      },
    });
    await assert.rejects(() => planner(hooks), /CEREMONY_PERSIST_FAILED/);
    assert.equal(run.read().brainstormed, undefined);
    assert.equal(persistenceCalls, 1);
  } finally { run.cleanup(); }
});

test("canonical evidence cannot be reused for a different feature", () => {
  const run = fixture();
  try {
    const evidence = acceptedEvidence(run);
    const foreign = { ...run.state, feature_id: "other-feature", ceremony_evidence: evidence };
    const recovered = recoverCeremony(run.root, foreign);
    assert.equal(recovered.ok, false);
    assert.equal(recovered.error.missing_proof, "brainstorming_completion_evidence");
    assert.equal(completionEvidence(run.root, foreign, "brainstormed").ok, false);
  } finally { run.cleanup(); }
});
