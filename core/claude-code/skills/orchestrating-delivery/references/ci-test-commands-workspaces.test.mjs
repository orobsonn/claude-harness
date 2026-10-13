/**
 * @description Monorepo workspace fan-outs are CI test commands (real app-rc run: `pnpm test` →
 * `pnpm -r run test` made the delivery gate find zero commands and run the gates by hand).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { enumerateCiTestCommands } from "./ci-test-commands.mjs";

const ROOT = "/proj";

function makeFs({ scripts, workflow }) {
  const pkg = `${ROOT}/package.json`;
  const dir = `${ROOT}/.github/workflows`;
  return {
    existsSync: (p) => p === pkg || (workflow !== undefined && (p === dir || p === `${dir}/ci.yml`)),
    readFileSync: (p) => {
      if (p === pkg) return JSON.stringify({ scripts });
      if (p === `${dir}/ci.yml`) return workflow;
      throw new Error(`ENOENT: ${p}`);
    },
    readdirSync: (p) => {
      if (p === dir && workflow !== undefined) return ["ci.yml"];
      throw new Error(`ENOENT: ${p}`);
    },
  };
}

const commandsOf = (fs) => enumerateCiTestCommands(ROOT, fs).commands.map((entry) => entry.command);

test("pnpm test in CI resolving to pnpm -r run test is one test command (deduped with the script)", () => {
  const fs = makeFs({
    scripts: { test: "pnpm -r run test", lint: "pnpm -r run lint", typecheck: "pnpm -r run typecheck" },
    workflow: "jobs:\n  ci:\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm lint\n      - run: pnpm test\n",
  });
  assert.deepEqual(commandsOf(fs), ["pnpm -r run test"]);
});

test("every workspace fan-out form of a test script is recognized; non-test fan-outs are not", () => {
  for (const [script, expected] of [
    ["pnpm --recursive test", true],
    ["pnpm -r test:unit", true],
    ["npm test --workspaces", true],
    ["npm run test -ws", true],
    ["yarn workspaces run test", true],
    ["yarn workspaces foreach -A run test", true],
    ["turbo run test", true],
    ["pnpm -r run lint", false],
    ["pnpm -r run build", false],
    ["npm run test", false],
    ["turbo run build", false],
  ]) {
    const commands = commandsOf(makeFs({ scripts: { ci: script } }));
    assert.equal(commands.includes(script), expected, script);
  }
});
