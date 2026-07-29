/** @description Parity manifesto tests: agents presence, no token reads, single-evaluator routing, vendored smoke. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runParity,
  checkAgentsPresent,
  checkDualConfig,
  checkNoTokenReads,
  checkGatesAndOracle,
  OC_REQUIRED_AGENTS,
} from "./parity-manifest.mjs";

describe("parity-manifest", () => {
  const canonicalRouting = JSON.parse(
    readFileSync(new URL("../core/opencode/harness.routing.json", import.meta.url), "utf8"),
  );
  it("t11-agents: fails when required OC agent file missing unless on skip list", () => {
    const res = checkAgentsPresent("core/opencode", "opencode");
    assert.equal(res.ok, true, `missing OC agents: ${(res.missing || []).join(", ")}`);
    assert.equal(res.missing.length, 0);

    const tmp = mkdtempSync(join(tmpdir(), "parity-agents-"));
    try {
      mkdirSync(join(tmp, "agents"), { recursive: true });
      writeFileSync(join(tmp, "agents", "planner.md"), "# planner\n");
      const bad = checkAgentsPresent(tmp, "opencode");
      assert.equal(bad.ok, false);
      assert.ok(bad.missing.includes("adversary"));
      assert.ok(bad.missing.includes("build"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-canonical-review-agents: single evaluator + alias stubs are mandatory", () => {
    for (const required of [
      "plan-reviewer",
      "adversary",
      "plan-reviewer-family-1",
      "adversary-family-1",
      "plan-reviewer-family-2",
      "adversary-family-2",
    ]) {
      assert.ok(OC_REQUIRED_AGENTS.includes(required), required);
    }
    for (const missing of ["plan-reviewer", "adversary"]) {
      const tmp = mkdtempSync(join(tmpdir(), "parity-canonical-agent-"));
      try {
        mkdirSync(join(tmp, "agents"), { recursive: true });
        for (const agent of OC_REQUIRED_AGENTS.filter((name) => name !== missing)) {
          writeFileSync(join(tmp, "agents", `${agent}.md`), `# ${agent}\n`);
        }
        const result = checkAgentsPresent(tmp, "opencode");
        assert.equal(result.ok, false);
        assert.deepEqual(result.missing, [missing]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("t11-tokens: fails when OC plugins source contains hand auth token reads", () => {
    const clean = checkNoTokenReads("core/opencode");
    assert.equal(clean.ok, true, `token hits: ${JSON.stringify(clean.hits)}`);

    const tmp = mkdtempSync(join(tmpdir(), "parity-tok-"));
    try {
      mkdirSync(join(tmp, "plugin"), { recursive: true });
      writeFileSync(join(tmp, "plugin", "entry-gate.ts"), "export default {}\n");
      writeFileSync(
        join(tmp, "plugin", "evil.ts"),
        'const t = process.env.OLLAMA_HAND_TOKEN;\n',
      );
      const dirty = checkNoTokenReads(tmp);
      assert.equal(dirty.ok, false);
      assert.ok(dirty.hits.length >= 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-routing: asserts single-evaluator routing validates", () => {
    const res = checkDualConfig("core/opencode");
    assert.equal(res.ok, true, res.reason || "single-evaluator routing required");
    assert.equal(canonicalRouting.roles.adversary.model, "openai/gpt-5.6-sol");
    assert.equal(canonicalRouting.roles["plan-reviewer"].model, "openai/gpt-5.6-sol");
    assert.equal(canonicalRouting.roles["test-author"].model, "openai/gpt-5.6-sol");
  });

  it("t11-routing-validator: fails on manipulated model capabilities", () => {
    for (const mutate of [
      (routing) => { routing.roles.build.model = "tampered/missing-capability"; },
      (routing) => { delete routing.roles.adversary.model; },
      (routing) => { routing.roles.adversary.secondEyeModel = "not-a-slug"; },
    ]) {
      const tmp = mkdtempSync(join(tmpdir(), "parity-routing-validator-"));
      try {
        mkdirSync(join(tmp, "plugin"), { recursive: true });
        writeFileSync(join(tmp, "plugin", "entry-gate.ts"), "export {};\n");
        const routing = structuredClone(canonicalRouting);
        mutate(routing);
        writeFileSync(join(tmp, "harness.routing.json"), JSON.stringify(routing));
        const result = checkDualConfig(tmp);
        assert.equal(result.ok, false);
        assert.equal(typeof result.reason, "string");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("t11-smoke: new-clone / project-vendored smoke proves harness works without relying on global ~/.config/opencode (#ac-5.3)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-smoke-"));
    try {
      const home = join(tmp, "home");
      mkdirSync(home, { recursive: true });
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const tgt = join(tmp, "proj");
        mkdirSync(join(tgt, ".opencode/agents"), { recursive: true });
        mkdirSync(join(tgt, ".opencode/plugin"), { recursive: true });
        mkdirSync(join(tgt, ".opencode/shared/lib"), { recursive: true });
        for (const a of OC_REQUIRED_AGENTS) {
          writeFileSync(join(tgt, `.opencode/agents/${a}.md`), `# ${a}\n`);
        }
        writeFileSync(join(tgt, ".opencode/plugin/entry-gate.ts"), "export {}\n");
        writeFileSync(join(tgt, ".opencode/plugin/plan-gate.ts"), "export {}\n");
        writeFileSync(join(tgt, ".opencode/plugin/review-guard.ts"), "export {}\n");
        writeFileSync(join(tgt, ".opencode/shared/lib/capture-oracle.mjs"), "export {}\n");
        writeFileSync(
          join(tgt, ".opencode/harness.routing.json"),
          JSON.stringify(canonicalRouting),
        );
        const gates = checkGatesAndOracle(join(tgt, ".opencode"));
        assert.equal(gates.ok, true);
        const res = runParity([join(tgt, ".opencode")]);
        assert.equal(res.ok, true);
        assert.equal(existsSync(join(home, ".config/opencode")), false);
      } finally {
        process.env.HOME = prevHome;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
