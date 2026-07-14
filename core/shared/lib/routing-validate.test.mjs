/** @description Locked tests for routing-validate (T1). Never-throw ValidationResult contract. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRouting } from "./routing-validate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRouting = JSON.parse(
  readFileSync(join(__dirname, "../../opencode/harness.routing.json"), "utf8"),
);

describe("routing-validate", () => {
  it("t1-ok: default operator JSON validates", () => {
    const res = validateRouting(defaultRouting);
    assert.equal(res.ok, true);
  });

  it("t1-dual-missing: missing dual on adversary → error", () => {
    const cfg = structuredClone(defaultRouting);
    delete cfg.roles.adversary.dual;
    const res = validateRouting(cfg);
    assert.equal(res.ok, false);
    assert.match(res.reason, /missing dual on adversary/);
  });

  it("t1-same-provider: same provider on dual pair → error", () => {
    const cfg = structuredClone(defaultRouting);
    cfg.roles.adversary.dual = [{ model: "ollama-cloud/glm-5.2", label: "same" }];
    const res = validateRouting(cfg);
    assert.equal(res.ok, false);
    assert.match(res.reason, /same provider on dual for adversary/);
  });

  it("t1-never-throw: null roles, missing dual.model, malformed input never throw", () => {
    const cases = [
      null,
      undefined,
      "string",
      42,
      [],
      {},
      { version: 1, roles: null, constraints: { requireDualOn: ["adversary"], crossFamilyRoles: [] }, modelCapabilities: {} },
      { version: 1, roles: { adversary: null }, constraints: { requireDualOn: ["adversary"], crossFamilyRoles: [] }, modelCapabilities: {} },
      {
        version: 1,
        roles: { adversary: { model: "ollama-cloud/g", dual: [null] } },
        constraints: { requireDualOn: ["adversary"], crossFamilyRoles: ["adversary"] },
        modelCapabilities: {},
      },
      {
        version: 1,
        roles: { adversary: { dual: [{ label: "x" }] } },
        constraints: { requireDualOn: ["adversary"], crossFamilyRoles: ["adversary"] },
        modelCapabilities: {},
      },
      {
        version: 1,
        roles: { adversary: { model: "ollama-cloud/g", dual: [{}] } },
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
    cfg.modelCapabilities["openai/gpt-5.6-terra"].supportsReasoningEffort = "true";
    const res = validateRouting(cfg);
    assert.equal(res.ok, false);
    assert.match(res.reason, /missing supportsReasoningEffort for openai\/gpt-5\.6-terra/);

    const ok = validateRouting(defaultRouting);
    assert.equal(ok.ok, true);
    assert.equal(defaultRouting.modelCapabilities["openai/gpt-5.6-terra"].supportsReasoningEffort, true);
  });
});
