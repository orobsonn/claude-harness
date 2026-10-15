import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkPiFinalCommands, registerPiCommandEvidence } from "./pi-command-evidence.mjs";
import { checkPiReviewPreparation } from "./pi-review-evidence.mjs";

function fixture(t, commands = ["npm test", "npm run typecheck", "npm run build"]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-final-checks-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  fs.writeFileSync(path.join(root, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(root, "product.txt"), "implemented\n");
  git("add", "."); git("commit", "-qm", "aggregate");
  const sessionId = "final-parent", featureId = "feature";
  const planDir = path.join(root, ".pi/harness/plans", featureId);
  const stateDir = path.join(root, ".pi/harness/state", sessionId);
  fs.mkdirSync(planDir, { recursive: true }); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "execution-plan.json"), JSON.stringify({ feature_id: featureId, tasks: [], final_review: { verification_commands: commands } }));
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId }));
  const handlers = new Map(); registerPiCommandEvidence({ on: (name, fn) => handlers.set(name, fn) });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
  let id = 0;
  async function record(command, { failure = false, during, start = true } = {}) {
    const event = { toolName: "bash", toolCallId: `call-${++id}`, input: { command } };
    if (start) handlers.get("tool_execution_start")({ toolName: event.toolName, toolCallId: event.toolCallId, args: event.input }, ctx);
    during?.();
    return handlers.get("tool_result")({ ...event, isError: failure, content: [{ type: "text", text: failure ? "Command exited with code 1" : "passed" }] }, ctx);
  }
  const input = { projectRoot: root, sessionId, featureId, phase: "final" };
  return { root, git, record, input, check: () => checkPiReviewPreparation(input) };
}

test("final preparation asks only for pending declared checks and keeps task eyes independent", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.check().commands, ["npm test", "npm run typecheck", "npm run build"]);
  assert.deepEqual(checkPiReviewPreparation({ ...f.input, phase: "task" }), { ok: true });
  await f.record("npm test"); await f.record("npm run typecheck");
  assert.deepEqual(f.check().commands, ["npm run build"]);
  await f.record("npm run build", { failure: true });
  assert.deepEqual(f.check().commands, ["npm run build"]);
  const pass = await f.record("npm run build");
  assert.deepEqual(f.check(), { ok: true });
  fs.writeFileSync(pass.details.command_evidence.path, "altered");
  assert.deepEqual(f.check().commands, ["npm run build"], "changed output cannot substitute for a check");
});

test("application changes, a dirty start and a later failure invalidate successful check evidence", async (t) => {
  const f = fixture(t, ["npm test"]);
  await f.record("npm test", { start: false });
  assert.equal(f.check().ok, false, "legacy end-only evidence does not establish the checked tree");
  await f.record("npm test"); assert.equal(f.check().ok, true);
  await f.record("npm test", { failure: true }); assert.equal(f.check().ok, false);
  await f.record("npm test");
  f.git("commit", "--allow-empty", "-qm", "new head");
  assert.equal(f.check().ok, true, "a new commit with identical application inputs retains evidence");
  fs.writeFileSync(path.join(f.root, "product.txt"), "new implementation\n");
  await f.record("npm test", { during: () => { f.git("add", "product.txt"); f.git("commit", "-qm", "during check"); } });
  assert.equal(f.check().ok, false, "a clean result boundary cannot hide dirty execution input");
  await f.record("npm test"); assert.equal(f.check().ok, true);
  assert.equal(checkPiFinalCommands({ ...f.input, sessionId: "other-parent", commands: ["npm test"] }).ok, false);
});

test("memory, operator documentation and vendored runtime commits retain application evidence", async (t) => {
  const f = fixture(t, ["npm test", "npm run typecheck"]);
  await f.record("npm test"); await f.record("npm run typecheck");
  for (const file of ["MEMORY.md", "CONTEXT.md", "kaizen.md", "AGENTS.md", "README.md", ".pi/harness/lib/runtime.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true });
    fs.writeFileSync(path.join(f.root, file), "operational documentation\n");
    f.git("add", "-f", "--", file); f.git("commit", "-qm", `update ${file}`);
    assert.equal(f.check().ok, true, `${file} does not change application inputs`);
  }
  assert.equal(checkPiFinalCommands({ ...f.input, commands: ["npm test"], exactHead: true }).ok, false,
    "harvest structural verification still requires the actual committed memory HEAD");
  await f.record("npm test", { failure: true });
  fs.appendFileSync(path.join(f.root, "MEMORY.md"), "correction\n");
  f.git("add", "MEMORY.md"); f.git("commit", "-qm", "correct memory");
  assert.deepEqual(f.check().commands, ["npm test"], "a later failure on the same application cannot fall back to older green");
});

function validationRuntime(f) {
  const files = {
    "package.json": JSON.stringify({ scripts: {
      pretest: "node .pi/harness/bin/patch.mjs",
      test: "node .pi/harness/bin/runner.mjs",
    } }),
    ".pi/harness/bin/patch.mjs": "export const patched = true;\n",
    ".pi/harness/bin/runner.mjs": 'new URL("./worker.mjs", import.meta.url);\n',
    ".pi/harness/bin/worker.mjs": 'import "../lib/reporter.mjs";\n',
    ".pi/harness/lib/reporter.mjs": "export default class Reporter {}\n",
    ".pi/harness/lib/policy.mjs": "export const operatorPolicy = true;\n",
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true });
    fs.writeFileSync(path.join(f.root, file), content);
    f.git("add", "-f", "--", file);
  }
  f.git("commit", "-qm", "validation uses vendored executables");
}

for (const file of ["bin/patch.mjs", "bin/runner.mjs", "bin/worker.mjs", "lib/reporter.mjs"]) {
  test(`changing consumed runtime ${file} invalidates GREEN, while unused runtime stays peripheral`, async (t) => {
    const f = fixture(t, ["npm test"]);
    validationRuntime(f);
    await f.record("npm test");
    const policy = ".pi/harness/lib/policy.mjs";
    fs.appendFileSync(path.join(f.root, policy), "// operator update\n");
    f.git("add", "-f", "--", policy); f.git("commit", "-qm", "peripheral operator update");
    assert.equal(f.check().ok, true, "unconsumed operator code does not rerun product tests");
    const consumed = `.pi/harness/${file}`;
    fs.appendFileSync(path.join(f.root, consumed), "// validation implementation changed\n");
    f.git("add", "-f", "--", consumed); f.git("commit", "-qm", "change consumed validation runtime");
    assert.deepEqual(f.check().commands, ["npm test"]);
    await f.record("npm test");
    assert.equal(f.check().ok, true);
  });
}

test("dirty consumed runtime cannot become GREEN by committing during the command", async (t) => {
  const f = fixture(t, ["npm test"]);
  validationRuntime(f);
  const file = ".pi/harness/lib/reporter.mjs";
  fs.appendFileSync(path.join(f.root, file), "// uncommitted reporter\n");
  await f.record("npm test", { during: () => {
    f.git("add", "-f", "--", file); f.git("commit", "-qm", "commit runtime during check");
  } });
  assert.equal(f.check().ok, false, "ignored runtime must not hide dirty execution inputs");
  await f.record("npm test");
  assert.equal(f.check().ok, true);
  fs.appendFileSync(path.join(f.root, file), "// dirty again\n");
  assert.equal(f.check().ok, false, "uncommitted consumed runtime invalidates final preparation");
});

test("direct commands and product config references include generated dependencies", async (t) => {
  const command = "node .pi/harness/bin/runner.mjs";
  const f = fixture(t, [command]);
  validationRuntime(f);
  fs.writeFileSync(path.join(f.root, "package.json"), "{}\n");
  f.git("add", "package.json"); f.git("commit", "-qm", "direct command without npm script");
  await f.record(command);
  assert.equal(f.check().ok, true);
  const file = ".pi/harness/lib/reporter.mjs";
  fs.appendFileSync(path.join(f.root, file), "// direct dependency\n");
  f.git("add", "-f", "--", file); f.git("commit", "-qm", "direct dependency changed");
  assert.equal(f.check().ok, false);
  fs.writeFileSync(path.join(f.root, "vitest.config.mjs"), 'import "./.pi/harness/lib/reporter.mjs";\n');
  f.git("add", "vitest.config.mjs"); f.git("commit", "-qm", "product config imports generated code");
  await f.record("npm test");
  const check = () => checkPiFinalCommands({ ...f.input, commands: ["npm test"] });
  assert.equal(check().ok, true);
  fs.appendFileSync(path.join(f.root, file), "// config dependency\n");
  f.git("add", "-f", "--", file); f.git("commit", "-qm", "config dependency changed");
  assert.equal(check().ok, false);
});

test("generated CommonJS helpers are followed through extensionless require and directory index", async (t) => {
  const f = fixture(t, ["npm test"]);
  validationRuntime(f);
  const files = {
    ".pi/harness/bin/worker.mjs": 'require("../lib/support");\n',
    ".pi/harness/lib/support.js": 'require("./nested");\n',
    ".pi/harness/lib/nested/index.js": "module.exports = true;\n",
  };
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true });
    fs.writeFileSync(path.join(f.root, file), source);
    f.git("add", "-f", "--", file);
  }
  f.git("commit", "-qm", "validation uses CommonJS dependencies");
  await f.record("npm test");
  assert.equal(f.check().ok, true);
  const helper = ".pi/harness/lib/nested/index.js";
  fs.appendFileSync(path.join(f.root, helper), "// changed transitive dependency\n");
  f.git("add", "-f", "--", helper); f.git("commit", "-qm", "change nested CommonJS helper");
  assert.equal(f.check().ok, false);
});

test("native start args detect a dirty direct-command helper even when restored before its result", async (t) => {
  const command = "node .pi/harness/bin/runner.mjs";
  const f = fixture(t, [command]);
  validationRuntime(f);
  fs.writeFileSync(path.join(f.root, "package.json"), "{}\n");
  f.git("add", "package.json"); f.git("commit", "-qm", "direct validation without npm references");
  const helper = path.join(f.root, ".pi/harness/lib/reporter.mjs");
  const original = fs.readFileSync(helper);
  fs.appendFileSync(helper, "// dirty when the native tool starts\n");
  await f.record(command, { during: () => fs.writeFileSync(helper, original) });
  assert.equal(f.check().ok, false, "restoring a helper cannot hide dirty native execution inputs");
  await f.record(command);
  assert.equal(f.check().ok, true);
});

for (const file of ["product.txt", "src/app.ts", "test/app.spec.ts", "package.json", "package-lock.json", "tsconfig.json", "migrations/001.sql", "public/site.css", "docs/app-content.md"]) {
  test(`application input ${file} invalidates previous evidence`, async (t) => {
    const f = fixture(t, ["npm test"]);
    await f.record("npm test");
    fs.mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true });
    fs.writeFileSync(path.join(f.root, file), "changed input\n");
    f.git("add", "--", file); f.git("commit", "-qm", "change application input");
    assert.equal(f.check().ok, false);
  });
}

test("declared custom commands are archived without executing them and malformed declarations fail closed", async (t) => {
  const f = fixture(t, ["make verify"]);
  const result = await f.record("make verify");
  assert.equal(result.details.command_evidence.status, "available");
  assert.equal(f.check().ok, true);
  assert.equal(checkPiFinalCommands({ ...f.input, commands: "npm test" }).ok, false);
  assert.deepEqual(checkPiFinalCommands({ ...f.input }), { ok: true });
});

test("final npm checks accept only the package proven by every frozen test and task scope", async (t) => {
  const commands = ["npm test -- src/one.test.ts", "npm test -- src/two.test.ts", "npm test"];
  const f = fixture(t, commands);
  fs.mkdirSync(path.join(f.root, "api/src"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "monorepo", private: true }));
  fs.writeFileSync(path.join(f.root, "api/package.json"), JSON.stringify({ name: "api", scripts: { test: "vitest run" } }));
  fs.writeFileSync(path.join(f.root, "api/src/one.test.ts"), "test one\n");
  fs.writeFileSync(path.join(f.root, "api/src/two.test.ts"), "test two\n");
  f.git("add", "."); f.git("commit", "-qm", "add scoped package");
  const planFile = path.join(f.root, ".pi/harness/plans/feature/execution-plan.json");
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  plan.tasks = [
    { scope_paths: ["api/src/one.test.ts"], locked_tests: [{ path: "api/src/one.test.ts", command: commands[0] }] },
    { scope_paths: ["api/src/two.test.ts"], locked_tests: [{ path: "api/src/two.test.ts", command: commands[1] }] },
  ];
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const check = () => checkPiFinalCommands({ projectRoot: f.root, sessionId: f.input.sessionId, commands });
  await f.record("npm test --prefix other -- src/one.test.ts");
  assert.deepEqual(check().commands, commands, "an unrelated package cannot satisfy the plan");
  await f.record("npm test --prefix api -- src/one.test.ts");
  await f.record("npm test --prefix api -- src/two.test.ts");
  await f.record("npm test --prefix api");
  assert.deepEqual(check(), { ok: true });
  await f.record(commands[0], { failure: true });
  assert.deepEqual(check(), { ok: true }, "an impossible root invocation does not erase scoped success");
  await f.record("npm test --prefix api", { failure: true });
  assert.deepEqual(check().commands, ["npm test"], "a later failure of the actual scoped command wins");
  await f.record("npm test --prefix api");
  assert.deepEqual(check(), { ok: true });
  plan.tasks[1].scope_paths = ["dashboard/src/two.test.ts"];
  fs.writeFileSync(planFile, JSON.stringify(plan));
  assert.deepEqual(check().commands, commands, "mixed task scope cannot infer one package cwd");
});

test("official shard-count variation retains full-suite evidence and a later failure revokes it", async t => {
  const f = fixture(t, ["npm test"]);
  const pass = await f.record("HARNESS_TEST_SHARDS=1 npm test");
  assert.equal(f.check().ok, true, JSON.stringify(f.check()));
  const metadata = JSON.parse(fs.readFileSync(pass.details.command_evidence.metadata_path ?? pass.details.command_evidence.path.replace(/\.log$/, '.json'), "utf8"));
  assert.equal(metadata.command, "HARNESS_TEST_SHARDS=1 npm test", "retain the real command in native evidence");
  await f.record("HARNESS_TEST_SHARDS=2 npm test", { failure: true });
  assert.equal(f.check().ok, false, "never fall back to an older success in another shard mode");
  await f.record("HARNESS_TEST_SHARDS=1 npm test");
  assert.equal(f.check().ok, true);
});

test("filters, arbitrary env and lifecycle changes cannot masquerade as a full-suite receipt", async t => {
  for (const command of ["HARNESS_TEST_SHARDS=1 npm test -- one.test.ts", "HARNESS_TEST_SHARDS=0 npm test",
    "HARNESS_TEST_SHARDS=1 npm run test", "NODE_OPTIONS=x npm test", "HARNESS_TEST_SHARDS=1 npm test; true"]) {
    const f = fixture(t, ["npm test"]);
    await f.record(command);
    assert.equal(f.check().ok, false, command);
  }
});
