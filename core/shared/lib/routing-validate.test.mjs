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

  it("t1-family-missing: missing required family on adversary → error", () => {
    const cfg = structuredClone(defaultRouting);
    delete cfg.roles.adversary.families["family-1"];
    const res = validateRouting(cfg);
    assert.equal(res.ok, false);
    assert.match(res.reason, /invalid required family-1 on adversary/);
  });

  it("t1-required-shape: empty roles and input-controlled constraints cannot bypass canonical validation", () => {
    for (const mutate of [
      (cfg) => { cfg.roles = {}; },
      (cfg) => { cfg.constraints.requireDualOn = []; },
      (cfg) => { cfg.constraints.crossFamilyRoles = ["adversary"]; },
      (cfg) => { delete cfg.roles["plan-reviewer"]; cfg.constraints.requireDualOn = ["adversary", "adversary"]; },
      (cfg) => { delete cfg.roles.build; },
      (cfg) => { delete cfg.roles.executor.tiers.high; },
    ]) {
      const cfg = structuredClone(defaultRouting);
      mutate(cfg);
      assert.equal(validateRouting(cfg).ok, false);
    }
  });

  it("t1-same-provider: same provider on dual pair → error", () => {
    const cfg = structuredClone(defaultRouting);
    cfg.roles.adversary.families["family-2"].model = "openai/gpt-5.5";
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

  it("t1-v1-adapter: legacy dual routing becomes canonical v2 families", () => {
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
    assert.deepEqual(adapted.roles.adversary.families["family-1"], {
      model: "openai/gpt-5.6-sol", primary: true, optional: false, countsLoop: true,
    });
    assert.deepEqual(adapted.roles.adversary.families["family-2"], {
      model: "ollama-cloud/kimi-k2.7-code", primary: false, optional: true, countsLoop: false,
    });
    assert.equal(adapted.roles.build.model, "openai/gpt-5.6-sol");
    assert.equal(adapted.roles["test-author"].model, "ollama-cloud/glm-5.2");
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
        timeout: 12_000,
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
    assert.equal(adapted.roles.adversary.families["family-1"].model, "openai/gpt-5.6-sol");
    assert.equal(adapted.roles.adversary.families["family-1"].timeout, 12_000);
    assert.equal(adapted.roles.adversary.families["family-2"].model, "acme/not-grok-small");
    assert.equal(
      adapted.roles.adversary.families["family-2"].alternates[0].model,
      "ollama-cloud/kimi-k2.7-code",
    );
    assert.equal(validateRouting(adapted).ok, true);
  });

  it("t1-v1-adapter-preserves: route extensions, labels, and additional dual entries survive deterministically", () => {
    const legacy = structuredClone(defaultRouting);
    legacy.version = 1;
    legacy.modelCapabilities["third/model"] = { supportsReasoningEffort: false };
    for (const role of ["plan-reviewer", "adversary"]) {
      legacy.roles[role] = {
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "high",
        timeout: 45_000,
        extension: { trace: true },
        label: "primary-label",
        dual: [
          { model: "ollama-cloud/kimi-k2.7-code", label: "secondary-label", timeout: 30_000 },
          { model: "third/model", label: "fallback-label", custom: "kept" },
        ],
      };
    }
    const adapted = adaptRoutingV1(legacy);
    const primary = adapted.roles.adversary.families["family-1"];
    const secondary = adapted.roles.adversary.families["family-2"];
    assert.equal(primary.reasoningEffort, "high");
    assert.equal(primary.timeout, 45_000);
    assert.deepEqual(primary.extension, { trace: true });
    assert.equal(primary.label, "primary-label");
    assert.equal(secondary.label, "secondary-label");
    assert.equal(secondary.timeout, 30_000);
    assert.deepEqual(secondary.alternates, [
      { model: "third/model", label: "fallback-label", custom: "kept" },
    ]);
    assert.equal(primary.primary, true);
    assert.equal(secondary.primary, false);
    assert.equal(validateRouting(adapted).ok, true);
  });

  it("t1-v1-adapter-invalid: malformed additional dual entries remain visible to validation", () => {
    const legacy = structuredClone(defaultRouting);
    legacy.version = 1;
    for (const role of ["plan-reviewer", "adversary"]) {
      legacy.roles[role] = {
        model: "openai/gpt-5.6-sol",
        dual: [{ model: "ollama-cloud/kimi-k2.7-code" }, { label: "missing-model" }],
      };
    }
    const adapted = adaptRoutingV1(legacy);
    assert.deepEqual(adapted.roles.adversary.families["family-2"].alternates, [{ label: "missing-model" }]);
    const result = validateRouting(adapted);
    assert.equal(result.ok, false);
    assert.match(result.reason, /invalid family-2 alternate/);
  });
});
