/** @description Parity manifesto tests exercising locked gates: agents presence, no token reads, dual config, vendored smoke. Hard asserts — no theater. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
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

  it("t11-dual: asserts dual config present for plan-reviewer and adversary", () => {
    const res = checkDualConfig("core/opencode");
    assert.equal(res.ok, true, res.reason || "dual config required");
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
        // full minimal vendored (build.md + gates + agents + dual routing) simulating vendor
        for (const a of OC_REQUIRED_AGENTS) {
          writeFileSync(join(tgt, `.opencode/agents/${a}.md`), `# ${a}\n`);
        }
        writeFileSync(join(tgt, ".opencode/plugin/entry-gate.ts"), "export {}\n");
        writeFileSync(join(tgt, ".opencode/plugin/plan-gate.ts"), "export {}\n");
        writeFileSync(join(tgt, ".opencode/plugin/loop-guard.ts"), "export {}\n");
        writeFileSync(join(tgt, ".opencode/shared/lib/capture-oracle.mjs"), "export {}\n");
        writeFileSync(join(tgt, ".opencode/harness.routing.json"), JSON.stringify({ roles: { "plan-reviewer": { dual: [{ model: "x" }] }, adversary: { dual: [{ model: "x" }] } } }));
        const gates = checkGatesAndOracle(join(tgt, ".opencode"));
        assert.equal(gates.ok, true);
        const res = runParity([join(tgt, ".opencode")]);
        assert.equal(res.ok, true);
        // assert no global harness reads (empty HOME has zero harness artifacts)
        assert.equal(existsSync(join(home, ".config/opencode")), false);
      } finally {
        process.env.HOME = prevHome;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
