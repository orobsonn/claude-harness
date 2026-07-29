/** @description Locked tests for routing-validate (T1). Never-throw ValidationResult contract. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRouting } from "./routing-validate.mjs";
import { adaptRoutingV1 } from "./routing-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRouting = JSON.parse(
  readFileSync(join(__dirname, "../../opencode/harness.routing.json"), "utf8"),
);

describe("routing-validate", () => {
  it("t1-ok: default operator JSON validates", () => {
    const res = validateRouting(defaultRouting);
    assert.equal(res.ok, true);
  });

  it("t1-planner-fallback: optional valid route passes and malformed route fails", () => {
    const configured = structuredClone(defaultRouting);
    configured.roles.planner.fallback = { model: "ollama-cloud/kimi-k2.7-code" };
    assert.equal(validateRouting(configured).ok, true);

    const malformed = structuredClone(defaultRouting);
    malformed.roles.planner.fallback = {};
    const result = validateRouting(malformed);
    assert.equal(result.ok, false);
    assert.match(result.reason, /invalid fallback model route on planner/);
  });

  it("t1-single-evaluator: default routing is flat { model } without families/constraints", () => {
    assert.equal(defaultRouting.roles.adversary.model, "openai/gpt-5.6-sol");
    assert.equal(defaultRouting.roles["plan-reviewer"].model, "openai/gpt-5.6-sol");
    assert.equal(defaultRouting.roles.adversary.families, undefined);
    assert.equal(defaultRouting.constraints, undefined);
    assert.deepEqual(validateRouting(defaultRouting), { ok: true });
  });

  it("#582: secondEyeModel is optional and must be a provider/model slug", () => {
    const ok = structuredClone(defaultRouting);
    ok.roles.adversary.secondEyeModel = "xai/grok-4.5";
    ok.roles["plan-reviewer"].secondEyeModel = "xai/grok-4.5";
    ok.modelCapabilities["xai/grok-4.5"] = { supportsReasoningEffort: false };
    assert.deepEqual(validateRouting(ok), { ok: true });

    const bad = structuredClone(defaultRouting);
    bad.roles.adversary.secondEyeModel = "not-a-slug";
    const result = validateRouting(bad);
    assert.equal(result.ok, false);
    assert.match(result.reason, /invalid secondEyeModel on adversary/);
  });

  it("#582: secondEyeModel requires modelCapabilities entry", () => {
    const cfg = structuredClone(defaultRouting);
    cfg.roles.adversary.secondEyeModel = "xai/grok-4.5";
    cfg.roles["plan-reviewer"].secondEyeModel = "xai/grok-4.5";
    const res = validateRouting(cfg);
    assert.equal(res.ok, false);
    assert.match(res.reason, /missing supportsReasoningEffort for xai\/grok-4\.5/);
  });

  it("#576: legacy families shape still validates when fully formed", () => {
    const cfg = structuredClone(defaultRouting);
    cfg.roles["plan-reviewer"] = {
      families: {
        "family-1": { model: "openai/gpt-5.6-sol", primary: true, optional: false, countsLoop: true },
        "family-2": { model: "xai/grok-4.5", primary: false, optional: true, countsLoop: false },
      },
    };
    cfg.roles.adversary = {
      families: {
        "family-1": { model: "openai/gpt-5.6-sol", primary: true, optional: false, countsLoop: true },
        "family-2": { model: "xai/grok-4.5", primary: false, optional: true, countsLoop: false },
      },
    };
    cfg.constraints = {
      requireDualOn: ["plan-reviewer", "adversary"],
      crossFamilyRoles: ["plan-reviewer", "adversary"],
    };
    cfg.modelCapabilities["xai/grok-4.5"] = { supportsReasoningEffort: false };
    assert.deepEqual(validateRouting(cfg), { ok: true });
  });

  it("#576: review roles cannot mix the simple and families shapes", () => {
    const cfg = structuredClone(defaultRouting);
    cfg.roles.adversary = {
      model: "openai/gpt-5.6-sol",
      families: {
        "family-1": { model: "openai/gpt-5.6-sol", primary: true, optional: false, countsLoop: true },
        "family-2": { model: "xai/grok-4.5", primary: false, optional: true, countsLoop: false },
      },
    };
    cfg.constraints = {
      requireDualOn: ["plan-reviewer", "adversary"],
      crossFamilyRoles: ["plan-reviewer", "adversary"],
    };
    cfg.modelCapabilities["xai/grok-4.5"] = { supportsReasoningEffort: false };
    const result = validateRouting(cfg);
    assert.equal(result.ok, false);
    assert.match(result.reason, /mixed review route on adversary/);
  });

  it("t1-required-shape: empty roles cannot bypass canonical validation", () => {
    for (const mutate of [
      (cfg) => { cfg.roles = {}; },
      (cfg) => { delete cfg.roles["plan-reviewer"]; },
      (cfg) => { delete cfg.roles.build; },
      (cfg) => { delete cfg.roles.executor.tiers.high; },
      (cfg) => { cfg.constraints = { requireDualOn: [] }; },
    ]) {
      const cfg = structuredClone(defaultRouting);
      mutate(cfg);
      assert.equal(validateRouting(cfg).ok, false);
    }
  });

  it("t1-same-provider: same provider on legacy dual pair → error", () => {
    const cfg = structuredClone(defaultRouting);
    cfg.roles.adversary = {
      families: {
        "family-1": { model: "openai/gpt-5.6-sol", primary: true, optional: false, countsLoop: true },
        "family-2": { model: "openai/gpt-5.5", primary: false, optional: true, countsLoop: false },
      },
    };
    cfg.roles["plan-reviewer"] = {
      families: {
        "family-1": { model: "openai/gpt-5.6-sol", primary: true, optional: false, countsLoop: true },
        "family-2": { model: "xai/grok-4.5", primary: false, optional: true, countsLoop: false },
      },
    };
    cfg.constraints = {
      requireDualOn: ["plan-reviewer", "adversary"],
      crossFamilyRoles: ["plan-reviewer", "adversary"],
    };
    cfg.modelCapabilities["openai/gpt-5.5"] = { supportsReasoningEffort: true };
    const res = validateRouting(cfg);
    assert.equal(res.ok, false);
    assert.match(res.reason, /same provider across families for adversary/);
  });

  it("t1-never-throw: null roles, missing dual.model, malformed input never throw", () => {
    const cases = [
      null,
      undefined,
      "string",
      42,
      [],
      {},
      { version: 2, roles: null, constraints: { requireDualOn: ["adversary"], crossFamilyRoles: [] }, modelCapabilities: {} },
      { version: 2, roles: { adversary: null }, constraints: { requireDualOn: ["adversary"], crossFamilyRoles: [] }, modelCapabilities: {} },
      {
        version: 2,
        roles: { adversary: { families: null } },
        constraints: { requireDualOn: ["adversary"], crossFamilyRoles: ["adversary"] },
        modelCapabilities: {},
      },
      {
        version: 2,
        roles: { adversary: { families: { "family-1": {} } } },
        constraints: { requireDualOn: ["adversary"], crossFamilyRoles: ["adversary"] },
        modelCapabilities: {},
      },
      {
        version: 2,
        roles: { adversary: { families: { "family-1": null, "family-2": [] } } },
        constraints: { requireDualOn: ["adversary"], crossFamilyRoles: ["adversary"] },
        modelCapabilities: { "ollama-cloud/g": { supportsReasoningEffort: true } },
      },
    ];
    for (const c of cases) {
      let res;
      assert.doesNotThrow(() => {
        res = validateRouting(c);
      });
      assert.equal(typeof res, "object");
      assert.equal(typeof res.ok, "boolean");
      if (!res.ok) assert.equal(typeof res.reason, "string");
    }
  });

  it("t1-reasoning-effort: each model capability declares a boolean flag", () => {
    const cfg = structuredClone(defaultRouting);
    cfg.modelCapabilities["openai/gpt-5.6-sol"].supportsReasoningEffort = "true";
    const res = validateRouting(cfg);
    assert.equal(res.ok, false);
    assert.match(res.reason, /missing supportsReasoningEffort for openai\/gpt-5\.6-sol/);

    const ok = validateRouting(defaultRouting);
    assert.equal(ok.ok, true);
    assert.equal(defaultRouting.modelCapabilities["openai/gpt-5.6-sol"].supportsReasoningEffort, true);
  });

  it("t1-reasoning-capability: configured reasoning is checked without provider exceptions", () => {
    for (const model of ["ollama-cloud/glm-5.2", "custom-provider/no-reasoning"]) {
      const cfg = structuredClone(defaultRouting);
      cfg.roles["test-author"] = { model, reasoningEffort: "high" };
      cfg.modelCapabilities[model] = { supportsReasoningEffort: false };
      const res = validateRouting(cfg);
      assert.equal(res.ok, false);
      assert.match(res.reason, new RegExp(`${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} does not support reasoningEffort`));
    }
  });

  it("t1-model-slug: provider and model segments must both be non-empty", () => {
    for (const model of ["/", "/model", "provider/", "provider/ "]) {
      const cfg = structuredClone(defaultRouting);
      cfg.roles.build.model = model;
      cfg.modelCapabilities[model] = { supportsReasoningEffort: true };
      assert.equal(validateRouting(cfg).ok, false, `${JSON.stringify(model)} must fail`);
    }
  });

  it("t1-v1-adapter: legacy dual routing becomes flat single evaluator + secondEyeModel", () => {
    const legacy = {
      ...structuredClone(defaultRouting),
      version: 1,
      roles: {
        ...structuredClone(defaultRouting.roles),
        adversary: { model: "xai/grok-4.5", dual: [{ model: "ollama-cloud/kimi-k2.7-code" }] },
        "plan-reviewer": { model: "xai/grok-4.5", dual: [{ model: "ollama-cloud/kimi-k2.7-code" }] },
      },
    };
    legacy.roles.build.model = "xai/grok-4.3";
    legacy.roles["test-author"].model = "xai/grok-build-0.1";
    legacy.modelCapabilities["xai/grok-4.3"] = { supportsReasoningEffort: true };
    legacy.modelCapabilities["xai/grok-4.5"] = { supportsReasoningEffort: true };
    legacy.modelCapabilities["xai/grok-build-0.1"] = { supportsReasoningEffort: false };
    const adapted = adaptRoutingV1(legacy);
    assert.equal(adapted.version, 2);
    assert.deepEqual(adapted.roles.adversary, {
      model: "openai/gpt-5.6-sol",
      secondEyeModel: "ollama-cloud/kimi-k2.7-code",
    });
    assert.equal(adapted.roles.build.model, "openai/gpt-5.6-sol");
    assert.equal(adapted.roles["test-author"].model, "ollama-cloud/glm-5.2");
    assert.equal(adapted.constraints, undefined);
    assert.equal(Object.keys(adapted.modelCapabilities).some((model) => model.startsWith("xai/grok")), false);
    assert.equal(validateRouting(adapted).ok, true);
  });

  it("t1-v1-adapter-models: known Grok routes migrate by role while custom Grok-like slugs survive", () => {
    const legacy = structuredClone(defaultRouting);
    legacy.version = 1;
    legacy.roles.build.model = "custom/grok-finetune";
    legacy.roles.planner.model = "xai/grok-4.5";
    legacy.roles.executor.tiers.low.model = "xai/grok-build-0.1";
    legacy.roles.executor.tiers.medium.model = "xai/grok-4.3";
    legacy.roles.executor.tiers.high.model = "xai/grok-4.5";
    for (const role of ["plan-reviewer", "adversary"]) {
      legacy.roles[role] = {
        model: "xai/grok-4.5",
        dual: [
          { model: "acme/not-grok-small", label: "custom-secondary" },
          { model: "xai/grok-4.3", label: "legacy-alternate" },
        ],
      };
    }
    legacy.modelCapabilities["custom/grok-finetune"] = { supportsReasoningEffort: false };
    legacy.modelCapabilities["acme/not-grok-small"] = { supportsReasoningEffort: false };
    for (const model of ["xai/grok-4.3", "xai/grok-4.5", "xai/grok-build-0.1"]) {
      legacy.modelCapabilities[model] = { supportsReasoningEffort: model !== "xai/grok-build-0.1" };
    }
    const adapted = adaptRoutingV1(legacy);
    assert.equal(adapted.roles.build.model, "custom/grok-finetune");
    assert.equal(adapted.roles.planner.model, "openai/gpt-5.6-sol");
    assert.deepEqual(
      ["low", "medium", "high"].map((tier) => adapted.roles.executor.tiers[tier].model),
      ["ollama-cloud/gemma4:31b", "ollama-cloud/glm-5.2", "ollama-cloud/kimi-k2.7-code"],
    );
    assert.equal(adapted.roles.adversary.model, "openai/gpt-5.6-sol");
    assert.equal(adapted.roles.adversary.secondEyeModel, "acme/not-grok-small");
    assert.equal(validateRouting(adapted).ok, true);
  });

  it("t1-v1-adapter: dual primary without secondary becomes single evaluator without secondEye", () => {
    const legacy = structuredClone(defaultRouting);
    legacy.version = 1;
    for (const role of ["plan-reviewer", "adversary"]) {
      legacy.roles[role] = { model: "openai/gpt-5.6-sol" };
    }
    const adapted = adaptRoutingV1(legacy);
    assert.deepEqual(adapted.roles.adversary, { model: "openai/gpt-5.6-sol" });
    assert.equal(adapted.roles.adversary.secondEyeModel, undefined);
    assert.equal(adapted.constraints, undefined);
    assert.equal(validateRouting(adapted).ok, true);
  });

  it("t1-v1-adapter-preserves: primary route extensions survive on the flat role", () => {
    const legacy = structuredClone(defaultRouting);
    legacy.version = 1;
    for (const role of ["plan-reviewer", "adversary"]) {
      legacy.roles[role] = {
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "high",
        timeout: 45_000,
        extension: { trace: true },
        label: "primary-label",
        bogus: 1,
        families: { "family-1": { model: "should-not-survive" } },
        dual: [{ model: "ollama-cloud/kimi-k2.7-code", label: "secondary-label" }],
      };
    }
    const adapted = adaptRoutingV1(legacy);
    const eye = adapted.roles.adversary;
    assert.equal(eye.model, "openai/gpt-5.6-sol");
    assert.equal(eye.secondEyeModel, "ollama-cloud/kimi-k2.7-code");
    assert.equal(eye.reasoningEffort, "high");
    assert.equal(eye.timeout, 45_000);
    assert.deepEqual(eye.extension, { trace: true });
    assert.equal(eye.label, "primary-label");
    assert.equal(eye.bogus, undefined);
    assert.equal(eye.families, undefined);
    assert.equal(adapted.roles["plan-reviewer"].bogus, undefined);
    assert.equal(adapted.roles["plan-reviewer"].families, undefined);
    assert.equal(validateRouting(adapted).ok, true);
  });
});
