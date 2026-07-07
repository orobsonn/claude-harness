/**
 * @description Frozen locked tests for ci-test-commands.mjs — pins #ac-1.1 (enumerate every
 * declared --config variant) and #ac-1.2 (green only if all configs pass).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enumerateCiTestCommands,
  runCiTestCommands,
  ciSuiteExitCode,
} from "./ci-test-commands.mjs";

const PROJECT_ROOT = "/proj";

function makeFs({ packageJson, workflows } = {}) {
  const pkgPath = `${PROJECT_ROOT}/package.json`;
  const workflowsDir = `${PROJECT_ROOT}/.github/workflows`;
  const workflowFiles = workflows || {};

  function workflowNameFor(p) {
    if (!p.startsWith(`${workflowsDir}/`)) return null;
    return p.slice(workflowsDir.length + 1);
  }

  return {
    existsSync(p) {
      if (p === pkgPath) return Boolean(packageJson);
      if (p === workflowsDir) return Boolean(workflows);
      const name = workflowNameFor(p);
      if (name) return Object.prototype.hasOwnProperty.call(workflowFiles, name);
      return false;
    },
    readFileSync(p) {
      if (p === pkgPath) return JSON.stringify(packageJson);
      const name = workflowNameFor(p);
      if (name && Object.prototype.hasOwnProperty.call(workflowFiles, name)) {
        return workflowFiles[name];
      }
      throw new Error(`ENOENT: ${p}`);
    },
    readdirSync(dir) {
      if (dir === workflowsDir) return Object.keys(workflowFiles);
      throw new Error(`ENOENT: ${dir}`);
    },
  };
}

test("package.json scripts declaring vitest run AND vitest run --config vitest.config.node.ts both appear in commands", () => {
  const fs = makeFs({
    packageJson: {
      scripts: {
        test: "vitest run",
        "test:node": "vitest run --config vitest.config.node.ts",
      },
    },
  });

  const result = enumerateCiTestCommands(PROJECT_ROOT, fs);
  const commands = result.commands.map((c) => c.command);

  assert.equal(commands.length, 2);
  assert.ok(commands.includes("vitest run"));
  assert.ok(commands.includes("vitest run --config vitest.config.node.ts"));
});

test("CI workflow with two separate run: steps keeps BOTH — neither is dropped", () => {
  const yaml = [
    "name: CI",
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: vitest run",
    "      - run: vitest run --config vitest.config.node.ts",
    "",
  ].join("\n");
  const fs = makeFs({ workflows: { "ci.yml": yaml } });

  const result = enumerateCiTestCommands(PROJECT_ROOT, fs);
  const commands = result.commands.map((c) => c.command);

  assert.ok(commands.includes("vitest run"));
  assert.ok(commands.includes("vitest run --config vitest.config.node.ts"));
});

test("CI run: steps with --config, --config=, and -c variants produce three distinct entries — none collapse together", () => {
  const yaml = [
    "name: CI",
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: vitest run --config a.ts",
    "      - run: vitest run --config=b.ts",
    "      - run: vitest run -c c.ts",
    "",
  ].join("\n");
  const fs = makeFs({ workflows: { "ci.yml": yaml } });

  const result = enumerateCiTestCommands(PROJECT_ROOT, fs);
  const commands = result.commands.map((c) => c.command);

  assert.equal(commands.length, 3);
  assert.equal(new Set(commands).size, 3);
  assert.ok(commands.some((c) => c.includes("a.ts")));
  assert.ok(commands.some((c) => c.includes("b.ts")));
  assert.ok(commands.some((c) => c.includes("c.ts")));
});

test("CI run: npm run test:node resolves through the package.json script indirection — the literal npm run line is not kept", () => {
  const yaml = [
    "name: CI",
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm run test:node",
    "",
  ].join("\n");
  const fs = makeFs({
    packageJson: {
      scripts: {
        "test:node": "vitest run --config vitest.config.node.ts",
      },
    },
    workflows: { "ci.yml": yaml },
  });

  const result = enumerateCiTestCommands(PROJECT_ROOT, fs);
  const commands = result.commands.map((c) => c.command);

  assert.ok(commands.includes("vitest run --config vitest.config.node.ts"));
  assert.ok(!commands.includes("npm run test:node"));
});

test("node --test is enumerated; a bare node <file>.mjs run: step without --test is not (the flag is required)", () => {
  const yaml = [
    "name: CI",
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: node --test core/x.test.mjs",
    "      - run: node core/skills/scan-secrets.mjs",
    "",
  ].join("\n");
  const fs = makeFs({ workflows: { "ci.yml": yaml } });

  const result = enumerateCiTestCommands(PROJECT_ROOT, fs);
  const commands = result.commands.map((c) => c.command);

  assert.ok(commands.includes("node --test core/x.test.mjs"));
  assert.ok(!commands.includes("node core/skills/scan-secrets.mjs"));
});

test("vitest run declared in BOTH package.json scripts AND a CI run: step appears exactly once — union deduped by normalized string", () => {
  const yaml = [
    "name: CI",
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: vitest run",
    "",
  ].join("\n");
  const fs = makeFs({
    packageJson: { scripts: { test: "vitest run" } },
    workflows: { "ci.yml": yaml },
  });

  const result = enumerateCiTestCommands(PROJECT_ROOT, fs);
  const commands = result.commands.map((c) => c.command);
  const occurrences = commands.filter((c) => c === "vitest run").length;

  assert.equal(occurrences, 1);
});

test("a run: step with an unexpanded ${{ matrix.config }} template goes to unresolved, not commands, and complete is false", () => {
  const yaml = [
    "name: CI",
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: vitest run --config ${{ matrix.config }}",
    "",
  ].join("\n");
  const fs = makeFs({ workflows: { "ci.yml": yaml } });

  const result = enumerateCiTestCommands(PROJECT_ROOT, fs);
  const commands = result.commands.map((c) => c.command);

  assert.ok(!commands.some((c) => c.includes("matrix.config")));
  assert.ok(result.unresolved.some((u) => u.command.includes("matrix.config")));
  assert.equal(result.complete, false);
});

test("runCiTestCommands: both commands exit 0 — results carries both entries and allGreen is true", () => {
  const enumResult = {
    commands: [{ command: "a", source: "ci" }, { command: "b", source: "ci" }],
    unresolved: [],
    complete: true,
  };
  const spawnImpl = () => ({ status: 0 });

  const result = runCiTestCommands(enumResult, spawnImpl);

  assert.deepEqual(result.results, [
    { command: "a", exitCode: 0 },
    { command: "b", exitCode: 0 },
  ]);
  assert.equal(result.allGreen, true);
});

test("runCiTestCommands: a single non-zero exit among multiple commands fails allGreen", () => {
  const enumResult = {
    commands: [{ command: "a", source: "ci" }, { command: "b", source: "ci" }],
    unresolved: [],
    complete: true,
  };
  let call = 0;
  const spawnImpl = () => {
    call += 1;
    return call === 1 ? { status: 0 } : { status: 1 };
  };

  const result = runCiTestCommands(enumResult, spawnImpl);

  assert.equal(result.allGreen, false);
});

test("ciSuiteExitCode is 0 iff both allGreen and complete are true — any single false yields non-zero", () => {
  assert.equal(ciSuiteExitCode({ allGreen: true, complete: true }), 0);
  assert.notEqual(ciSuiteExitCode({ allGreen: false, complete: true }), 0);
  assert.notEqual(ciSuiteExitCode({ allGreen: true, complete: false }), 0);
  assert.notEqual(ciSuiteExitCode({ allGreen: false, complete: false }), 0);
});

test("launcher (npx / pnpm exec) and ENV= prefixes are stripped before matching the runner token; a non-runner (tsc) is rejected", () => {
  const yaml = [
    "name: CI",
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npx vitest run --config a.ts",
    "      - run: pnpm exec vitest run --config b.ts",
    "      - run: NODE_ENV=test vitest run --config c.ts",
    "      - run: npx tsc --noEmit",
    "",
  ].join("\n");
  const fs = makeFs({ workflows: { "ci.yml": yaml } });

  const result = enumerateCiTestCommands(PROJECT_ROOT, fs);
  const commands = result.commands.map((c) => c.command);

  assert.ok(commands.includes("vitest run --config a.ts"));
  assert.ok(commands.includes("vitest run --config b.ts"));
  assert.ok(commands.includes("vitest run --config c.ts"));
  assert.ok(!commands.some((c) => c.includes("tsc")));
});

test("a run: | block scalar with a && chain of two vitest invocations enumerates BOTH commands", () => {
  const yaml = [
    "name: CI",
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Run tests",
    "        run: |",
    "          vitest run && vitest run --config vitest.config.node.ts",
    "",
  ].join("\n");
  const fs = makeFs({ workflows: { "ci.yml": yaml } });

  const result = enumerateCiTestCommands(PROJECT_ROOT, fs);
  const commands = result.commands.map((c) => c.command);

  assert.ok(commands.includes("vitest run"));
  assert.ok(commands.includes("vitest run --config vitest.config.node.ts"));
});
