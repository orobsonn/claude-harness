import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEEPSEEK_MODEL, DEFAULT_MODEL_PROFILE, GLM_MODEL, MODEL_PROFILE_ENV, MODEL_PROFILE_HASH_ENV,
  MODEL_PROFILE_VERSION,
  loadModelProfileFromEnv, modelStrategyFromProfile, parseModelProfileArgs,
  profilePrompt, readModelProfileSnapshot, resolveModelProfile, routeFromModelProfile,
  stableProfileJson, writeModelProfileSnapshot,
} from "./model-profile.mjs";

test("AC-01 baseline preserves every canonical route and needs no Ollama credential", () => {
  const profile = resolveModelProfile({ profile: "baseline" });
  assert.equal(profile.profile, "baseline");
  assert.equal(routeFromModelProfile(profile, "harness-executor", "low").model, "openai-codex/gpt-5.6-luna");
  assert.equal(routeFromModelProfile(profile, "harness-executor", "high").model, "openai-codex/gpt-5.6-terra");
  assert.equal(routeFromModelProfile(profile, "harness-plan-reviewer").model, "openai-codex/gpt-6-astra");
  assert.equal(profile.parents.global.route, null);
  assert.equal(profile.parents.local.route, null);
});

test("new sessions default to DeepSeek orchestration while baseline stays explicit", () => {
  const profile = resolveModelProfile();
  assert.equal(MODEL_PROFILE_VERSION, 3);
  assert.equal(profile.version, 3);
  assert.equal(DEFAULT_MODEL_PROFILE, "trial-orchestration-deepseek");
  assert.equal(profile.profile, DEFAULT_MODEL_PROFILE);
  assert.equal(profile.parents.global.route.model, DEEPSEEK_MODEL);
  assert.equal(profile.parents.local.route.model, DEEPSEEK_MODEL);
  assert.equal(resolveModelProfile({ profile: "baseline" }).parents.global.route, null);
});

test("AC-02 hands profiles change executor, sniper and test-author while eyes stay fixed", () => {
  for (const [name, tierModel] of [
    ["trial-hands-deepseek", () => DEEPSEEK_MODEL],
    ["trial-hands-glm", () => GLM_MODEL],
  ]) {
    const profile = resolveModelProfile({ profile: name });
    for (const role of ["harness-executor", "harness-sniper"]) {
      for (const complexity of ["low", "medium", "high", "max"]) {
        assert.equal(routeFromModelProfile(profile, role, complexity).model, `ollama-cloud/${tierModel(complexity)}`);
      }
    }
    assert.equal(routeFromModelProfile(profile, "harness-planner").model, "openai-codex/gpt-5.6-sol");
    assert.equal(routeFromModelProfile(profile, "harness-test-author", "low").model, `ollama-cloud/${tierModel("low")}`);
    assert.equal(routeFromModelProfile(profile, "harness-test-author", "high").model, `ollama-cloud/${tierModel("high")}`);
    assert.equal(routeFromModelProfile(profile, "harness-test-reviewer").model, "openai-codex/gpt-5.6-luna");
    assert.equal(routeFromModelProfile(profile, "harness-compliance").model, "openai-codex/gpt-5.6-terra");
  }
});

test("AC-03 parent targets are independent and do not change eyes", () => {
  const profile = resolveModelProfile({
    profile: "trial-hands-deepseek", globalParent: "deepseek", localParent: "baseline",
  });
  assert.equal(profile.parents.global.route.model, DEEPSEEK_MODEL);
  assert.equal(profile.parents.local.route, null);
  assert.equal(routeFromModelProfile(profile, "harness-security").model, "openai-codex/gpt-5.6-sol");
});

test("AC-04 unknown profiles and parent targets fail closed", () => {
  assert.throws(() => resolveModelProfile({ profile: "prompt-chosen" }), /unknown/);
  assert.throws(() => resolveModelProfile({ globalParent: "glm" }), /invalid global/);
  assert.deepEqual(routeFromModelProfile(resolveModelProfile(), "harness-executor", "unknown"), {
    ok: false, reason: "hand-complexity",
  });
});

test("AC-05 prompt exposes the admitted projection without secrets", () => {
  const prompt = profilePrompt(resolveModelProfile({ profile: "trial-hands-deepseek" }));
  assert.match(prompt, /HARNESS_MODEL_PROFILE/);
  assert.match(prompt, /ollama-cloud\/deepseek-v4\.1-flash/);
  assert.doesNotMatch(prompt, /OLLAMA_API_KEY|apiKey|Bearer/);
});

test("open parent prompt bootstraps the ceremony without changing child prompts", () => {
  const trial = resolveModelProfile({ profile: "trial-orchestration-deepseek" });
  assert.match(profilePrompt(trial, { parentKind: "global" }), /HARNESS_OPEN_PARENT_BOOTSTRAP/);
  assert.match(profilePrompt(trial, { parentKind: "local" }), /calling classify/);
  assert.doesNotMatch(profilePrompt(trial), /HARNESS_OPEN_PARENT_BOOTSTRAP/);
  assert.doesNotMatch(profilePrompt(resolveModelProfile({ profile: "baseline" }), { parentKind: "global" }), /HARNESS_OPEN_PARENT_BOOTSTRAP/);
});

test("new Ollama snapshots use the operational 256 Ki token context", () => {
  const profile = resolveModelProfile({ profile: "trial-hands-deepseek" });
  assert.equal(profile.models.deepseek.context_window, 262_144);
  assert.equal(profile.models.glm.context_window, 262_144);
});

test("v2 Ollama snapshots remain canonical at 1M for exact resume", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-profile-v2-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = resolveModelProfile({ profile: "trial-orchestration-deepseek", version: 2 });
  assert.equal(old.models.deepseek.context_window, 1_000_000);
  writeModelProfileSnapshot(root, "old-session", old);
  assert.deepEqual(readModelProfileSnapshot(root, "old-session").snapshot, old);
});

test("AC-07 admitted snapshot is immutable and disk defaults cannot replace it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const admitted = resolveModelProfile({ profile: "trial-hands-deepseek" });
  const saved = writeModelProfileSnapshot(root, "session-a", admitted);
  assert.equal(loadModelProfileFromEnv({
    [MODEL_PROFILE_ENV]: saved.path,
    [MODEL_PROFILE_HASH_ENV]: saved.sha256,
  }).profile, "trial-hands-deepseek");
  assert.throws(() => writeModelProfileSnapshot(root, "session-a", resolveModelProfile({ profile: "baseline" })), /immutable/);
});

test("AC-08 legacy absence resolves baseline while malformed snapshots are rejected", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readModelProfileSnapshot(root, "legacy").absent, true);
  assert.equal(loadModelProfileFromEnv({}).profile, "baseline");
  const saved = writeModelProfileSnapshot(root, "bad", resolveModelProfile());
  fs.writeFileSync(saved.path, "{}\n");
  assert.throws(() => loadModelProfileFromEnv({
    [MODEL_PROFILE_ENV]: saved.path,
    [MODEL_PROFILE_HASH_ENV]: saved.sha256,
  }), /hash mismatch/);
});

test("v1 sessions retain their admitted tiered DeepSeek/GLM routes after the v2 default", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = resolveModelProfile({ profile: "trial-orchestration-deepseek", version: 1 });
  assert.equal(routeFromModelProfile(legacy, "harness-executor", "medium").model, `ollama-cloud/${DEEPSEEK_MODEL}`);
  assert.equal(routeFromModelProfile(legacy, "harness-executor", "high").model, `ollama-cloud/${GLM_MODEL}`);
  writeModelProfileSnapshot(root, "legacy-v1", legacy);
  const restored = readModelProfileSnapshot(root, "legacy-v1");
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.snapshot, legacy);
});

test("AC-13 profile carries dated rates without treating missing usage as zero", () => {
  const profile = resolveModelProfile({ profile: "trial-hands-deepseek" });
  assert.equal(profile.models.deepseek.id, DEEPSEEK_MODEL);
  assert.equal(Object.hasOwn(profile, "usage"), false);
  assert.equal(Object.hasOwn(profile, "confirmed_cost"), false);
});

test("AC-14 snapshot and parser never contain a credential value", () => {
  const sentinel = "secret-sentinel-never-persist";
  const snapshot = resolveModelProfile({ profile: "trial-hands-deepseek" });
  assert.doesNotMatch(stableProfileJson(snapshot), new RegExp(sentinel));
  assert.match(stableProfileJson(snapshot), /OLLAMA_API_KEY/);
});

test("AC-15 baseline rollback affects only new snapshots", () => {
  const trial = resolveModelProfile({ profile: "trial-hands-deepseek" });
  const rollback = resolveModelProfile({ profile: "baseline" });
  assert.equal(trial.profile, "trial-hands-deepseek");
  assert.equal(rollback.profile, "baseline");
  assert.notEqual(trial.sha256, rollback.sha256);
});

test("profile CLI parsing strips only operational flags before --", () => {
  assert.deepEqual(parseModelProfileArgs([
    "--harness-profile", "trial-hands-deepseek", "--", "--harness-profile", "prose",
  ]), {
    argv: ["--", "--harness-profile", "prose"],
    inspect: false,
    selection: { profile: "trial-hands-deepseek" },
    explicit: true,
  });
});

test("model strategy projects only the plan contract", () => {
  assert.deepEqual(modelStrategyFromProfile(resolveModelProfile({ profile: "trial-hands-deepseek" })).hand_tiers, {
    low: "ollama-cloud/deepseek-v4.1-flash",
    medium: "ollama-cloud/deepseek-v4.1-flash",
    high: "ollama-cloud/deepseek-v4.1-flash",
  });
});
