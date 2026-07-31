/** @description Parity manifesto tests: agents presence, no token reads, single-evaluator routing, vendored smoke. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runParity,
  checkAgentsPresent,
  checkDualConfig,
  checkNoTokenReads,
  checkGatesAndOracle,
  checkPluginLoad,
  checkImportsResolve,
  OC_REQUIRED_AGENTS,
} from "./parity-manifest.mjs";
import {
  harnessOcPluginFiles,
  vendorOpenCode,
} from "../core/claude-code/skills/initializing-projects/references/vendor-core.mjs";

/** @description ESM fixture root so `.js`/`.ts` plugins under it load as modules, not CJS. */
function makeModuleFixture(prefix) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(tmp, "plugin"), { recursive: true });
  return tmp;
}

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

  it("t11-real-gates: gates + oracle and full parity run against the real repo, not a fixture", () => {
    for (const target of ["core/opencode", "core/claude-code"]) {
      const res = checkGatesAndOracle(target);
      assert.equal(res.ok, true, `${target} missing gates/oracle: ${res.missing.join(", ")}`);
    }
    const parity = runParity();
    const broken = Object.entries(parity.results)
      .flatMap(([target, r]) =>
        Object.entries(r)
          .filter(([, check]) => check && check.ok === false)
          .map(([name, check]) => `${target}.${name}: ${JSON.stringify(check)}`),
      );
    assert.deepEqual(broken, []);
    assert.equal(parity.ok, true);
  });

  it("t11-tokens-missing-root: an OC target with no plugin/ fails instead of passing vacuously", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-opencode-empty-"));
    try {
      const res = checkNoTokenReads(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.missingRoots, ["plugin"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load: every auto-globbed plugin of core/opencode imports, default-exports a function, and that factory returns hooks when called", async () => {
    const res = await checkPluginLoad("core/opencode");
    assert.equal(
      res.ok,
      true,
      `failures: ${JSON.stringify(res.failures)} missing: ${res.missing.join(", ")}`,
    );
    assert.ok(res.files.length >= 8, `expected auto-globbed plugins, got ${res.files.length}`);
  });

  it("t11-plugin-load-broken-import: a plugin importing a missing module fails the check (P0 — OC skips it in silence)", async () => {
    const tmp = makeModuleFixture("parity-plugin-broken-");
    try {
      writeFileSync(
        join(tmp, "plugin", "entry-gate.ts"),
        'import "./lib/does-not-exist.mjs";\nexport default function plugin() {}\n',
      );
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false);
      const failure = res.failures.find((f) => f.file === "entry-gate.ts");
      assert.ok(failure, `expected entry-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /import failed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-no-default: a plugin without a function default export fails the check", async () => {
    const tmp = makeModuleFixture("parity-plugin-nodefault-");
    try {
      writeFileSync(join(tmp, "plugin", "entry-gate.ts"), "export const notAPlugin = 1;\n");
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false);
      const failure = res.failures.find((f) => f.file === "entry-gate.ts");
      assert.ok(failure, `expected entry-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /default export is undefined/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-host-value-import-no-default: M1 value host imports cannot skip default-export validation", async () => {
    const tmp = makeModuleFixture("parity-plugin-host-value-nodefault-");
    try {
      for (const entry of harnessOcPluginFiles()) {
        const name = entry.split("/").pop();
        const source = name === "plan-gate.ts"
          ? 'import { Plugin } from "@opencode-ai/plugin";\nexport const notAPlugin = Plugin;\n'
          : 'import { Plugin } from "@opencode-ai/plugin";\nexport default function plugin() { return { Plugin }; }\n';
        writeFileSync(join(tmp, "plugin", name), source);
      }
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false, `M1 silently passed: ${JSON.stringify(res)}`);
      const failure = res.failures.find((f) => f.file === "plan-gate.ts");
      assert.ok(failure, `expected plan-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /default export is undefined/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-host-value-import-factory: M2 value host imports cannot skip factory validation", async () => {
    const tmp = makeModuleFixture("parity-plugin-host-value-factory-");
    try {
      for (const entry of harnessOcPluginFiles()) {
        const name = entry.split("/").pop();
        const source = name === "plan-gate.ts"
          ? 'import { Plugin } from "@opencode-ai/plugin";\nexport default function plugin() { return Plugin ? 1 : 0; }\n'
          : 'import { Plugin } from "@opencode-ai/plugin";\nexport default function plugin() { return { Plugin }; }\n';
        writeFileSync(join(tmp, "plugin", name), source);
      }
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false, `M2 silently passed: ${JSON.stringify(res)}`);
      const failure = res.failures.find((f) => f.file === "plan-gate.ts");
      assert.ok(failure, `expected plan-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /factory returned number/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-missing: an expected harness plugin absent from the auto-glob is reported", async () => {
    const tmp = makeModuleFixture("parity-plugin-missing-");
    try {
      writeFileSync(join(tmp, "plugin", "entry-gate.ts"), "export default function plugin() { return {}; }\n");
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.failures, []);
      assert.ok(res.missing.includes("plan-gate.ts"));
      assert.equal(res.missing.includes("entry-gate.ts"), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-broken-dynamic-import: a factory whose dynamic import is missing fails — the shape a plain module import cannot see", async () => {
    const tmp = makeModuleFixture("parity-plugin-dyn-");
    try {
      writeFileSync(
        join(tmp, "plugin", "entry-gate.ts"),
        "export default async function plugin() {\n" +
          '  await import("./lib/nao-existe.mjs");\n' +
          "  return {};\n}\n",
      );
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false);
      const failure = res.failures.find((f) => f.file === "entry-gate.ts");
      assert.ok(failure, `expected entry-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /factory call failed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-host-package: OpenCode host imports use the deterministic stub and still run factories", async () => {
    const tmp = makeModuleFixture("parity-plugin-host-");
    const names = harnessOcPluginFiles().map((entry) => entry.split("/").pop());
    try {
      for (const name of names) {
        writeFileSync(
          join(tmp, "plugin", name),
          'import { Plugin } from "@opencode-ai/plugin";\n' +
            "export default async function plugin() {\n" +
            '  const { tool } = await import("@opencode-ai/plugin/tool");\n' +
            "  return { Plugin, tool };\n}\n",
        );
      }
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, true, `failures: ${JSON.stringify(res.failures)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-host-package-typo: a package that merely shares the @opencode-ai scope is NOT tolerated", async () => {
    const tmp = makeModuleFixture("parity-plugin-typo-");
    try {
      for (const entry of harnessOcPluginFiles()) {
        writeFileSync(
          join(tmp, "plugin", entry.split("/").pop()),
          "export default async function plugin() {\n" +
            '  await import("@opencode-ai/plgin/tool");\n' +
            "  return {};\n}\n",
        );
      }
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false, "a typo'd package name must not pass as host-provided");
      assert.equal(res.failures.length, harnessOcPluginFiles().length);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-non-object-factory: a factory returning a non-object fails", async () => {
    const tmp = makeModuleFixture("parity-plugin-nonobj-");
    try {
      writeFileSync(join(tmp, "plugin", "entry-gate.ts"), "export default function plugin() { return 1; }\n");
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false);
      const failure = res.failures.find((f) => f.file === "entry-gate.ts");
      assert.ok(failure, `expected entry-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /factory returned number/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-manifest-drift: harnessOcPluginFiles() equals the auto-globbed set on disk, so deleting a plugin is deliberate", () => {
    const declared = harnessOcPluginFiles()
      .map((entry) => entry.split("/").pop())
      .sort();
    const onDisk = readdirSync("core/opencode/plugin")
      .filter((name) => /\.(ts|js)$/.test(name) && !/\.test\.(ts|js)$/.test(name))
      .sort();
    assert.deepEqual(
      declared,
      onDisk,
      "harnessOcPluginFiles() drifted from core/opencode/plugin/: a plugin OpenCode auto-loads is absent from the vendoring manifest (or vice-versa)",
    );
  });

  it("t11-imports-empty-target: a target with no source file fails instead of passing vacuously", () => {
    const missing = checkImportsResolve(join(tmpdir(), "parity-imports-absent-does-not-exist"));
    assert.equal(missing.ok, false);
    assert.equal(missing.scanned, 0);

    const tmp = mkdtempSync(join(tmpdir(), "parity-imports-empty-"));
    try {
      const empty = checkImportsResolve(tmp);
      assert.equal(empty.ok, false);
      assert.equal(empty.scanned, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-imports-dynamic: a literal dynamic import to a missing file is caught (tools/classify.ts shape)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-imports-"));
    try {
      mkdirSync(join(tmp, "tools"), { recursive: true });
      mkdirSync(join(tmp, "plugin", "lib"), { recursive: true });
      writeFileSync(join(tmp, "plugin", "lib", "obs-emit.mjs"), "export const emit = () => {};\n");
      writeFileSync(
        join(tmp, "tools", "classify.ts"),
        'const ok = await import("../plugin/lib/obs-emit.mjs");\n' +
          'const gone = await import("../plugin/lib/planner-state.mjs");\n',
      );
      const res = checkImportsResolve(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.unresolved, [
        { file: join("tools", "classify.ts"), specifier: "../plugin/lib/planner-state.mjs" },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-imports-static-comment-trivia: a broken static import with legal comment trivia fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-imports-static-comment-"));
    try {
      writeFileSync(
        join(tmp, "entry.ts"),
        'import value from /* legal trivia */ "./missing-static.mjs";\nvoid value;\n',
      );
      const res = checkImportsResolve(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.unresolved, [
        { file: "entry.ts", specifier: "./missing-static.mjs" },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-imports-dynamic-options: a broken literal import with options fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-imports-dynamic-options-"));
    try {
      writeFileSync(
        join(tmp, "entry.mjs"),
        'await import("./missing-dynamic.json", { with: { type: "json" } });\n',
      );
      const res = checkImportsResolve(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.unresolved, [
        { file: "entry.mjs", specifier: "./missing-dynamic.json" },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-imports-read-error: an unreadable source fails instead of disappearing from a partial scan", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-imports-read-error-"));
    const unreadable = join(tmp, "unreadable.mjs");
    try {
      writeFileSync(join(tmp, "readable.mjs"), "export {};\n");
      writeFileSync(unreadable, 'import "./missing.mjs";\n');
      chmodSync(unreadable, 0o000);
      const res = checkImportsResolve(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.readErrors.map(({ file }) => file), ["unreadable.mjs"]);
    } finally {
      if (existsSync(unreadable)) chmodSync(unreadable, 0o600);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-imports-real: every relative import under core/opencode resolves on disk", () => {
    const res = checkImportsResolve("core/opencode");
    assert.equal(res.ok, true, `unresolved: ${JSON.stringify(res.unresolved)}`);
    assert.ok(res.scanned > 0, "scanner walked no files");
  });

  it("t11-vendored-positive-load: a fresh real vendoring resolves imports and calls every plugin factory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-vendored-load-"));
    const project = join(tmp, "project");
    const isolatedHome = join(tmp, "home");
    const previousHome = process.env.HOME;
    const previousStdoutWrite = process.stdout.write;
    const previousWarn = console.warn;
    try {
      mkdirSync(project, { recursive: true });
      mkdirSync(isolatedHome, { recursive: true });
      process.env.HOME = isolatedHome;
      process.stdout.write = () => true;
      console.warn = () => {};

      vendorOpenCode({
        coreDir: join(process.cwd(), "core"),
        targetDir: project,
        version: "test",
        stampDate: "2026-07-31",
      });

      const vendored = join(project, ".opencode");
      const imports = checkImportsResolve(vendored);
      assert.equal(imports.ok, true, `unresolved: ${JSON.stringify(imports.unresolved)} read errors: ${JSON.stringify(imports.readErrors)}`);

      const load = await checkPluginLoad(vendored);
      const expected = harnessOcPluginFiles().map((entry) => entry.split("/").pop()).sort();
      assert.equal(load.ok, true, `failures: ${JSON.stringify(load.failures)} missing: ${load.missing.join(", ")}`);
      assert.deepEqual(load.files, expected);
      assert.deepEqual(load.failures, []);
      assert.deepEqual(load.missing, []);
      assert.equal(existsSync(join(isolatedHome, ".config", "opencode")), false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      process.stdout.write = previousStdoutWrite;
      console.warn = previousWarn;
      rmSync(tmp, { recursive: true, force: true });
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
