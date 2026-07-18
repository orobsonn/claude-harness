/** @description Trusted plugin authorization, immutable snapshot, descriptor-only coordinator, and retry state tests. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { semanticPlanHash } from "./lib/planner-artifact.mjs";
import { bindAdapterSession } from "./lib/dispatch-scope.mjs";

const stub = `const v={optional(){return this},describe(){return this}}; export const tool=(d)=>d; tool.schema={string(){return Object.create(v)}};`;
registerHooks({ resolve(specifier, context, nextResolve) { if (specifier === "@opencode-ai/plugin/tool") return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }; return nextResolve(specifier, context); } });
const { createCommandResolverPlugin } = await import("./command-resolver.ts");

const PARENT = "ses-parent-343";
const CHILD = "ses-child-343";
const FEATURE = "recover-denial";

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-plugin-"));
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "a.test.ts"), "test");
  fs.writeFileSync(path.join(root, "tests", "b.test.ts"), "test");
  const plan = { feature_id: FEATURE, kind: "full", mode: "full", tasks: [{ id: "task-1", severity: "medium", complexity: "medium", scope_paths: ["src/a.ts"], criterion_refs: ["#ac-1"], locked_tests: [{ id: "lt-1", path: "tests/a.test.ts", assertion: "a" }, { id: "lt-2", path: "tests/b.test.ts", assertion: "b" }] }] };
  const hash = semanticPlanHash(plan);
  const stateDir = path.join(root, ".opencode", "plans", ".state", PARENT);
  const snapshot = path.join(stateDir, "bound-plans", `${hash}.json`);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, JSON.stringify(plan));
  const active = { session_id: PARENT, feature_id: FEATURE, task_id: "task-1", role: "executor-low", snapshot_hash: hash, call_id: "task-call", claim_token: "token", status: "active" };
  const statePath = path.join(stateDir, "gate-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ session_id: PARENT, feature_id: FEATURE, planner_status: "usable", planner_plan_binding: { session_id: PARENT, feature_id: FEATURE, snapshot_path: path.relative(root, snapshot), snapshot_hash: hash }, active_dispatch: { ...active, ...overrides.active } }));
  return { root, statePath, snapshot, read: () => JSON.parse(fs.readFileSync(statePath, "utf8")), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function identity(_root, input) {
  if (input.sessionID === CHILD) return { ok: true, parentSessionId: PARENT, runtimeSessionId: CHILD, callId: "task-call", token: "token", role: "executor-low" };
  return { ok: false, notWritingSession: true, runtimeSessionId: PARENT, reason: "top-level" };
}

async function runtime(run, extra = {}) {
  const plugin = await createCommandResolverPlugin(run.root, { resolveRuntimeIdentity: identity, runPinnedVitest: extra.runPinnedVitest ?? (() => ({ ok: true, status: "passed", exit_code: 0 })) });
  return {
    plugin,
    async call(sessionID, args, callID = `verify-${Math.random()}`) {
      const input = { tool: "verify", sessionID, callID };
      const output = { args };
      await plugin["tool.execute.before"](input, output);
      const value = await plugin.tool.verify.execute(args, { sessionID, callID });
      await plugin["tool.execute.after"](input, value);
      return value;
    },
  };
}

const args = () => ({ feature_id: FEATURE, task_id: "task-1", denied_class: "package_launcher", denied_command: "npx vitest run tests/a.test.ts", test_path: "tests/a.test.ts" });

test("trusted top-level coordinator resolves descriptor but never executes", async () => {
  const run = fixture();
  let executions = 0;
  try {
    const rt = await runtime(run, { runPinnedVitest: () => { executions += 1; return { ok: true, status: "passed" }; } });
    const out = await rt.call(PARENT, args());
    assert.equal(out.metadata.status, "resolved", out.output);
    assert.deepEqual(out.metadata.descriptor, { tool: "verify", registry_id: "vitest.targeted.v1", test_path: "tests/a.test.ts" });
    assert.equal(executions, 0);
    assert.doesNotMatch(JSON.stringify(out.metadata), /explore|general/);
  } finally { run.cleanup(); }
});

test("bound child hand consumes descriptor and executes once", async () => {
  const run = fixture();
  let executions = 0;
  try {
    const rt = await runtime(run, { runPinnedVitest: () => { executions += 1; return { ok: true, status: "passed", exit_code: 0 }; } });
    await rt.call(PARENT, args(), "descriptor-call");
    const out = await rt.call(CHILD, args(), "child-verify");
    assert.equal(out.metadata.status, "passed", out.output);
    assert.equal(executions, 1);
    assert.equal(run.read().command_resolutions.length, 1);
    const repeated = await rt.call(CHILD, { ...args(), denied_command: "  npx   vitest run tests/a.test.ts  " }, "child-repeat");
    assert.equal(repeated.metadata.repeated, true);
    assert.equal(executions, 1);
  } finally { run.cleanup(); }
});

test("claimed descriptor path cannot be swapped before execute", async () => {
  const run = fixture();
  try {
    const rt = await runtime(run);
    const callArgs = args();
    const input = { tool: "verify", sessionID: CHILD, callID: "swap-call" };
    await rt.plugin["tool.execute.before"](input, { args: callArgs });
    callArgs.test_path = "tests/b.test.ts";
    const out = await rt.plugin.tool.verify.execute(callArgs, { sessionID: CHILD, callID: "swap-call" });
    assert.equal(out.metadata.status, "rejected");
    assert.match(out.metadata.reason, /mismatched/);
    assert.equal(run.read().command_resolutions, undefined);
  } finally { run.cleanup(); }
});

test("each unique canonical locked path receives one independent known-equivalent attempt", async () => {
  const run = fixture();
  let executions = 0;
  try {
    const rt = await runtime(run, { runPinnedVitest: () => { executions += 1; return { ok: true, status: "passed", exit_code: 0 }; } });
    const a = { feature_id: FEATURE, task_id: "task-1", denied_class: "targeted_vitest", test_path: "tests/a.test.ts" };
    const b = { ...a, test_path: "tests/b.test.ts" };
    assert.equal((await rt.call(CHILD, a, "path-a")).metadata.status, "passed");
    assert.equal((await rt.call(CHILD, b, "path-b")).metadata.status, "passed");
    assert.equal((await rt.call(CHILD, { ...b }, "path-b-repeat")).metadata.repeated, true);
    assert.equal(executions, 2);
    assert.equal(run.read().command_resolutions.length, 2);
  } finally { run.cleanup(); }
});

test("official client metadata resolves child to parent and proves acting role", async () => {
  const run = fixture();
  try {
    assert.equal(bindAdapterSession(run.root, { parentSessionId: PARENT, runtimeSessionId: CHILD, token: "token" }).ok, true);
    const client = {
      session: {
        async get({ path: requestPath }) { return { data: requestPath.id === CHILD ? { id: CHILD, parentID: PARENT } : { id: PARENT } }; },
        async messages() {
          return { data: [
            { info: { id: "user", sessionID: CHILD, role: "user", agent: "executor-low" }, parts: [] },
            { info: { id: "assistant", sessionID: CHILD, role: "assistant", parentID: "user", mode: "executor-low" }, parts: [{ type: "tool", tool: "verify", callID: "official-call", sessionID: CHILD, messageID: "assistant" }] },
          ] };
        },
      },
    };
    const plugin = await createCommandResolverPlugin(run.root, { client, runPinnedVitest: () => ({ ok: true, status: "passed", exit_code: 0 }) });
    const input = { tool: "verify", sessionID: CHILD, callID: "official-call" };
    const callArgs = args();
    await plugin["tool.execute.before"](input, { args: callArgs });
    const out = await plugin.tool.verify.execute(callArgs, { sessionID: CHILD, callID: "official-call" });
    assert.equal(out.metadata.status, "passed", out.output);
  } finally { run.cleanup(); }
});

test("active call, task, role, and snapshot mismatch fail before execution", async () => {
  for (const active of [{ call_id: "other" }, { task_id: "other" }, { role: "sniper-low" }, { snapshot_hash: "bad" }]) {
    const run = fixture({ active });
    try {
      const rt = await runtime(run);
      await assert.rejects(() => rt.call(CHILD, args()), /active dispatch call\/task\/role\/snapshot mismatch/);
    } finally { run.cleanup(); }
  }
});

test("mutable plan is ignored; snapshot locked target remains authoritative", async () => {
  const run = fixture();
  try {
    const mutable = path.join(run.root, ".opencode", "plans", `${PARENT}-${FEATURE}`, "execution-plan.json");
    fs.mkdirSync(path.dirname(mutable), { recursive: true });
    fs.writeFileSync(mutable, JSON.stringify({ feature_id: FEATURE, tasks: [{ id: "task-1", locked_tests: [{ path: "evil.test.ts" }] }] }));
    const rt = await runtime(run);
    const out = await rt.call(PARENT, args());
    assert.equal(out.metadata.status, "resolved");
  } finally { run.cleanup(); }
});

test("no-equivalent is terminal per denied class/task across command variations", async () => {
  const run = fixture();
  try {
    const rt = await runtime(run);
    const first = await rt.call(PARENT, { ...args(), denied_class: "shell_source", denied_command: "source one.sh" }, "unknown-one");
    const second = await rt.call(PARENT, { ...args(), denied_class: "shell_source", denied_command: "source two.sh" }, "unknown-two");
    assert.equal(first.metadata.status, "no_equivalent");
    assert.equal(second.metadata.repeated, true);
    assert.equal(run.read().command_resolutions.length, 1);
    assert.equal(run.read().command_resolutions[0].denied_class, "shell_source");
  } finally { run.cleanup(); }
});

test("no-equivalent class terminal blocks a later valid-looking equivalent", async () => {
  const run = fixture();
  try {
    const rt = await runtime(run);
    const first = await rt.call(PARENT, { ...args(), denied_command: "npx vitest run tests/a.test.ts --watch" }, "invalid-first");
    const later = await rt.call(PARENT, args(), "valid-later");
    assert.equal(first.metadata.status, "no_equivalent");
    assert.equal(later.metadata.repeated, true);
    assert.equal(later.metadata.status, "no_equivalent");
    assert.equal(run.read().command_resolutions.length, 1);
  } finally { run.cleanup(); }
});

test("two authorized child attempts share one atomic claim and terminal remains immutable", async () => {
  const run = fixture();
  let executions = 0;
  try {
    const rt = await runtime(run, { runPinnedVitest: () => { executions += 1; return { ok: false, status: "failed", exit_code: 1 }; } });
    const [one, two] = await Promise.all([rt.call(CHILD, args(), "concurrent-one"), rt.call(CHILD, args(), "concurrent-two")]);
    assert.equal(executions, 1);
    assert.deepEqual([one.metadata.status, two.metadata.status].sort(), ["failed", "failed"]);
    assert.equal([one.metadata.repeated, two.metadata.repeated].filter(Boolean).length, 1);
    assert.equal(run.read().command_resolutions[0].status, "failed");
  } finally { run.cleanup(); }
});

test("setup_missing is terminal and never retries the local binary proof", async () => {
  const run = fixture();
  let executions = 0;
  try {
    const rt = await runtime(run, { runPinnedVitest: () => { executions += 1; return { ok: false, status: "setup_missing", reason: "missing" }; } });
    const first = await rt.call(CHILD, args(), "missing-one");
    const second = await rt.call(CHILD, args(), "missing-two");
    assert.equal(first.metadata.status, "setup_missing");
    assert.equal(second.metadata.repeated, true);
    assert.equal(executions, 1);
  } finally { run.cleanup(); }
});
