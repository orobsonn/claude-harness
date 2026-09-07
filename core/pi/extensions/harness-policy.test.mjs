import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createGrepToolDefinition, createReadToolDefinition, createFindToolDefinition, createLsToolDefinition } from "@earendil-works/pi-coding-agent";

import harnessPolicy from "./harness-policy.ts";
import harnessEntryGate from "./harness-entry-gate.ts";
import { piChildIdentityPath, writePiChildIdentity } from "../lib/pi-child-identity.mjs";

const SESSION = "ses-policy-parent";
const REVIEWER_SESSION = "ses-policy-reviewer";

function fixture(mode = "FULL") {
  const root = mkdtempSync(join(tmpdir(), "pi-policy-extension-"));
  const stateDir = join(root, ".pi", "harness", "state", SESSION);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "gate-state.json"),
    JSON.stringify({ session_id: SESSION, feature_id: "policy-extension", classified: true, mode }),
  );
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

function handler() {
  const registered = new Map();
  harnessPolicy({ on: (name, fn) => registered.set(name, fn) });
  assert.equal(typeof registered.get("tool_call"), "function");
  return registered.get("tool_call");
}

function parentCtx(cwd) {
  return {
    cwd,
    hasUI: true,
    sessionManager: {
      getSessionId: () => SESSION,
      getHeader: () => ({}),
    },
  };
}

function reviewerFixture(t) {
  const f = fixture();
  const root = realpathSync(f.root);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-policy-reviewer-outside-")));
  const aliasDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-policy-reviewer-alias-")));
  const alias = join(aliasDir, "project");
  symlinkSync(root, alias, "dir");
  assert.equal(writePiChildIdentity(root, {
    parentSessionId: SESSION,
    childSessionId: REVIEWER_SESSION,
    role: "harness-adversary",
    callId: "call-reviewer",
  }).ok, true);
  t.after(() => {
    rmSync(aliasDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    f.close();
  });
  return { root, outside, alias };
}

function childCtx(cwd, { childSessionId = REVIEWER_SESSION, parentSessionId = SESSION } = {}) {
  return {
    cwd,
    hasUI: true,
    sessionManager: {
      getSessionId: () => childSessionId,
      getHeader: () => ({ parentSession: parentSessionId }),
    },
  };
}

function reviewerCtx(cwd) {
  return childCtx(cwd);
}

async function executeNativeGrep(root, input) {
  const result = await createGrepToolDefinition(root).execute("grep-reviewer-policy", input, undefined, undefined, {});
  return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}

test("the three reviewers cannot use extra mutation or dispatch tools even if exposed by the runtime", (t) => {
  const f = fixture();
  t.after(f.close);
  writeFileSync(join(f.root, "ordinary.txt"), "readable synthetic fixture");
  const calls = [
    { toolName: "bash", input: { command: "pwd" } },
    { toolName: "write", input: { path: "ordinary.txt", content: "changed" } },
    { toolName: "edit", input: { path: "ordinary.txt", oldText: "fixture", newText: "changed" } },
    { toolName: "subagent", input: { subagent_type: "harness-executor" } },
    { toolName: "mark", input: { action: "final-review" } },
    { toolName: "unexpected_tool", input: {} },
  ];
  const onToolCall = handler();
  for (const role of ["harness-adversary", "harness-compliance", "harness-security"]) {
    const childSessionId = `child-${role}`;
    assert.equal(writePiChildIdentity(f.root, { parentSessionId: SESSION, childSessionId, role, callId: `call-${role}` }).ok, true);
    const ctx = childCtx(f.root, { childSessionId });
    assert.equal(onToolCall({ toolName: "read", input: { path: "ordinary.txt" } }, ctx), undefined);
    for (const call of calls) {
      const decision = onToolCall(call, ctx);
      assert.equal(decision?.block, true, `${role} must refuse exposed ${call.toolName}`);
      assert.match(decision.reason, /read.only|reviewer/i);
    }
  }
});

test("adaptador consulta o gate-state e bloqueia escrita nativa do pai em FULL, aplicando a allowlist literal do Claude", () => {
  const f = fixture();
  try {
    const onToolCall = handler();
    for (const event of [
      { toolName: "write", input: { path: "src/app.ts" } },
      { toolName: "edit", input: { path: "tests/app.test.mjs" } },
      { toolName: "bash", input: { command: "printf x > src/app.ts" } },
    ]) {
      const decision = onToolCall(event, parentCtx(f.root));
      assert.equal(decision.block, true);
      assert.match(decision.reason, /parent orchestrator/i);
    }
    assert.equal(onToolCall({ toolName: "bash", input: { command: "npm test" } }, parentCtx(f.root)), undefined);
    assert.equal(onToolCall({ toolName: "bash", input: { command: "git commit -am delegated-hand" } }, parentCtx(f.root)), undefined);
  } finally {
    f.close();
  }
});

test("policy e entry-gate permitem ao pai criar a série real de commits seletivos antes da revisão final", async () => {
  const f = fixture();
  try {
    execFileSync("git", ["init", "-q", "-b", "feat/task-commits"], { cwd: f.root });
    execFileSync("git", ["config", "user.name", "Pi Test"], { cwd: f.root });
    execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: f.root });

    const listeners = [];
    const api = {
      on: (name, fn) => { if (name === "tool_call") listeners.push(fn); },
      events: { on: () => {} },
      registerTool: () => {},
    };
    harnessPolicy(api);
    harnessEntryGate(api);
    const runHooks = async (command) => {
      for (const listener of listeners) {
        const decision = await listener(
          { toolName: "bash", toolCallId: `call-${listeners.indexOf(listener)}`, input: { command } },
          parentCtx(f.root),
        );
        assert.notEqual(decision?.block, true, `${command}: ${decision?.reason ?? "blocked"}`);
      }
    };

    mkdirSync(join(f.root, "tests"), { recursive: true });
    writeFileSync(join(f.root, "tests", "app.test.mjs"), "// locked test\n");
    await runHooks("git add -- tests/app.test.mjs");
    execFileSync("git", ["add", "--", "tests/app.test.mjs"], { cwd: f.root });
    await runHooks('git commit -m "test(app): freeze locked test for task-1"');
    execFileSync("git", ["commit", "-q", "-m", "test(app): freeze locked test for task-1"], { cwd: f.root });

    mkdirSync(join(f.root, "src"), { recursive: true });
    writeFileSync(join(f.root, "src", "app.ts"), "export const ready = true;\n");
    await runHooks("git add -- src/app.ts");
    execFileSync("git", ["add", "--", "src/app.ts"], { cwd: f.root });
    await runHooks('git commit -m "feat(app): implement task-1"');
    execFileSync("git", ["commit", "-q", "-m", "feat(app): implement task-1"], { cwd: f.root });

    const subjects = execFileSync("git", ["log", "--format=%s", "--reverse"], { cwd: f.root, encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(subjects, [
      "test(app): freeze locked test for task-1",
      "feat(app): implement task-1",
    ]);
    const residue = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: f.root,
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    assert.ok(residue.length > 0, "the runtime state fixture remains untracked");
    assert.ok(residue.every((line) => line.startsWith("?? .pi/harness/")), residue.join("\n"));
  } finally {
    f.close();
  }
});

test("headless parent cannot write inline before classification while the local parent can", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-headless-unclassified-"));
  try {
    const onToolCall = handler();
    const event = { toolName: "write", input: { path: "src/app.ts", content: "example" } };
    assert.equal(onToolCall(event, parentCtx(root)), undefined);
    const blocked = onToolCall(event, { ...parentCtx(root), hasUI: false });
    assert.equal(blocked?.block, true);
    assert.equal(onToolCall({ toolName: "bash", input: { command: "npm test" } }, { ...parentCtx(root), hasUI: false }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suspended ceremony permits local native editing but cannot dispatch or mark delivery", () => {
  const f = fixture();
  try {
    const statePath = join(f.root, ".pi/harness/state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, ceremony_status: "suspended-inline" }));
    const run = (toolName, input = {}, context = parentCtx(f.root)) => handler()({ toolName, input }, context);
    assert.equal(run("write", { path: "src/app.ts", content: "example" }), undefined);
    assert.equal(run("write", { path: "src/app.ts" }, { ...parentCtx(f.root), hasUI: false })?.block, true);
    for (const toolName of ["subagent", "mark", "harness_spec_write", "seal_spec_review"]) assert.equal(run(toolName)?.block, true, toolName);
    assert.equal(run("harness_plan", { action: "update" })?.block, true);
    assert.equal(run("harness_plan", { action: "show" }), undefined);
    assert.equal(run("classify", { mode: "QUICK", feature_id: "replacement" })?.block, true);
    assert.equal(run("classify", { action: "resume-ceremony" }), undefined);
  } finally { f.close(); }
});

test("reconciling permits plan reconciliation but no execution, shipping or final approval", () => {
  const f = fixture();
  try {
    const statePath = join(f.root, ".pi/harness/state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, ceremony_status: "reconciling" }));
    const run = (toolName, input = {}) => handler()({ toolName, input }, parentCtx(f.root));
    assert.equal(run("write", { path: "src/app.ts" })?.block, true);
    for (const role of ["harness-planner", "harness-plan-reviewer"]) {
      assert.equal(run("subagent", { subagent_type: role }), undefined, role);
    }
    for (const role of ["harness-executor", "harness-sniper", "harness-shipper", "harness-harvester", "harness-discussion-adversary", "harness-test-author"]) {
      assert.equal(run("subagent", { subagent_type: role })?.block, true, role);
    }
    assert.equal(run("mark", { action: "final-review" })?.block, true);
    assert.equal(run("mark", { action: "demo-done" })?.block, true);
    assert.equal(run("mark", { action: "regate-passed", task_id: "task1" })?.block, true);
  } finally { f.close(); }
});

test("unreadable ceremony state never becomes permission for local inline mutation", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, ".pi/harness/state", SESSION, "gate-state.json"), "{broken");
    const run = (toolName, input = {}) => handler()({ toolName, input }, parentCtx(f.root));
    for (const toolName of ["write", "edit", "bash", "subagent", "mark", "classify"]) {
      assert.equal(run(toolName, { path: "src/app.ts", command: "node script.mjs" })?.block, true, toolName);
    }
    assert.equal(run("read", { path: "README.md" }), undefined);
  } finally { f.close(); }
});

test("reviewer identity confines every native read tool to the canonical project root", (t) => {
  const f = reviewerFixture(t);
  mkdirSync(join(f.root, "src"), { recursive: true });
  writeFileSync(join(f.root, "src", "public.txt"), "reviewable\n");
  writeFileSync(join(f.outside, "outside.txt"), "outside\n");
  symlinkSync(join(f.outside, "outside.txt"), join(f.root, "linked-outside.txt"));
  const onToolCall = handler();

  const observed = ["read", "grep", "find", "ls"].map((toolName) => ({
    toolName,
    safeRelative: onToolCall({ toolName, input: { path: "src/public.txt" } }, reviewerCtx(f.alias))?.block === true,
    directEscape: onToolCall({ toolName, input: { path: join(f.outside, "outside.txt") } }, reviewerCtx(f.alias))?.block === true,
    symlinkEscape: onToolCall({ toolName, input: { path: "linked-outside.txt" } }, reviewerCtx(f.alias))?.block === true,
  }));

  assert.deepEqual(observed, ["read", "grep", "find", "ls"].map((toolName) => ({
    toolName,
    safeRelative: false,
    directEscape: true,
    symlinkEscape: true,
  })));
});

test("reviewer identity denies synthetic credential paths inside and outside the project", (t) => {
  const f = reviewerFixture(t);
  const relativeSecrets = [
    ".pi/agent/auth.json",
    ".env",
    ".env.review",
    "nested/.env",
    "nested/.env.review",
    ".dev.vars",
    "nested/.dev.vars",
    ".ssh/id_synthetic",
    "nested/.ssh/id_synthetic",
    ".aws/credentials",
    "nested/.aws/credentials",
  ];
  for (const rel of relativeSecrets) {
    mkdirSync(join(f.root, rel, ".."), { recursive: true });
    mkdirSync(join(f.outside, rel, ".."), { recursive: true });
    writeFileSync(join(f.root, rel), "SYNTHETIC_ONLY\n");
    writeFileSync(join(f.outside, rel), "SYNTHETIC_ONLY\n");
  }
  const onToolCall = handler();
  const observed = [];
  for (const toolName of ["read", "grep", "find", "ls"]) {
    for (const rel of relativeSecrets) {
      observed.push({ toolName, location: `inside:${rel}`, blocked: onToolCall(
        { toolName, input: { path: rel } }, reviewerCtx(f.alias),
      )?.block === true });
      observed.push({ toolName, location: `outside:${rel}`, blocked: onToolCall(
        { toolName, input: { path: join(f.outside, rel) } }, reviewerCtx(f.alias),
      )?.block === true });
    }
  }

  assert.equal(observed.length, 88);
  assert.deepEqual(observed.filter(({ blocked }) => !blocked), []);
});

test("reviewer recursive native grep keeps broad coverage while one hook guard excludes every secret class", async (t) => {
  const f = reviewerFixture(t);
  const canary = "SYNTHETIC_REVIEW_CANARY";
  const files = [
    "public.txt",
    ".pi/agent/auth.json",
    ".env",
    ".env.review",
    "nested/.env",
    "nested/.env.review",
    ".dev.vars",
    "nested/.dev.vars",
    ".ssh/id_synthetic",
    "nested/.ssh/id_synthetic",
    ".aws/credentials",
    "nested/.aws/credentials",
  ];
  for (const rel of files) {
    mkdirSync(join(f.root, rel, ".."), { recursive: true });
    writeFileSync(join(f.root, rel), `${canary}\n`);
  }
  const event = { toolName: "grep", input: { pattern: canary, literal: true } };
  const decision = handler()(event, reviewerCtx(f.alias));
  const output = await executeNativeGrep(f.root, event.input);

  assert.equal(decision, undefined);
  assert.equal(output, `public.txt:1: ${canary}`);
});

test("reviewer direct reads and native broad grep deny known secret paths regardless of letter case", async (t) => {
  const f = reviewerFixture(t);
  const canary = "SYNTHETIC_CASE_INSENSITIVE_CANARY";
  const secretPaths = [
    ".ENV",
    ".DEV.VARS.PRODUCTION",
    ".PI/AGENT/AUTH.JSON",
    ".SSH/KEY",
    ".AWS/CREDENTIALS",
  ];
  for (const rel of [...secretPaths, "ordinary.txt"]) {
    mkdirSync(join(f.root, rel, ".."), { recursive: true });
    writeFileSync(join(f.root, rel), `${canary}\n`);
  }
  const onToolCall = handler();
  const direct = [];
  for (const toolName of ["read", "grep", "find", "ls"]) {
    for (const path of secretPaths) {
      direct.push({
        toolName,
        path,
        blocked: onToolCall({ toolName, input: { path } }, reviewerCtx(f.alias))?.block === true,
      });
    }
  }
  const event = { toolName: "grep", input: { pattern: canary, literal: true } };
  const decision = onToolCall(event, reviewerCtx(f.alias));
  const output = await executeNativeGrep(f.root, event.input);

  assert.deepEqual({
    exposedDirectPaths: direct.filter(({ blocked }) => !blocked).map(({ toolName, path }) => `${toolName}:${path}`),
    decision,
    output,
  }, {
    exposedDirectPaths: [],
    decision: undefined,
    output: `ordinary.txt:1: ${canary}`,
  });
});

test("reviewer direct reads and native broad grep deny standard credential files", async (t) => {
  const f = reviewerFixture(t);
  const canary = "SYNTHETIC_CREDENTIAL_FAMILY_CANARY";
  const credentialPaths = [
    ".npmrc",
    ".netrc",
    ".pypirc",
    ".git-credentials",
    ".codex/auth.json",
    ".git/config",
  ];
  for (const rel of [...credentialPaths, "ordinary.txt"]) {
    mkdirSync(join(f.root, rel, ".."), { recursive: true });
    writeFileSync(join(f.root, rel), `${canary}\n`);
  }
  const onToolCall = handler();
  const direct = [];
  for (const toolName of ["read", "grep", "find", "ls"]) {
    for (const path of credentialPaths) {
      direct.push({
        toolName,
        path,
        blocked: onToolCall({ toolName, input: { path } }, reviewerCtx(f.alias))?.block === true,
      });
    }
  }
  const event = { toolName: "grep", input: { pattern: canary, literal: true } };
  const decision = onToolCall(event, reviewerCtx(f.alias));
  const output = await executeNativeGrep(f.root, event.input);

  assert.deepEqual({
    exposedDirectPaths: direct.filter(({ blocked }) => !blocked).map(({ toolName, path }) => `${toolName}:${path}`),
    decision,
    output,
  }, {
    exposedDirectPaths: [],
    decision: undefined,
    output: `ordinary.txt:1: ${canary}`,
  });
});

test("reviewer direct reads and native broad grep exclude snapshot credential filenames", async (t) => {
  const f = reviewerFixture(t);
  const canary = "SYNTHETIC_SNAPSHOT_CREDENTIAL_CANARY";
  const credentialPaths = [
    "auth.json",
    "nested/auth.json",
    "credentials",
    "nested/credentials",
    "credentials.json",
    "nested/credentials.json",
  ];
  for (const rel of [...credentialPaths, "ordinary.json"]) {
    mkdirSync(join(f.root, rel, ".."), { recursive: true });
    writeFileSync(join(f.root, rel), `${canary}\n`);
  }
  const onToolCall = handler();
  const exposedDirectPaths = [];
  for (const toolName of ["read", "grep", "find", "ls"]) {
    for (const path of credentialPaths) {
      if (onToolCall({ toolName, input: { path } }, reviewerCtx(f.alias))?.block !== true) {
        exposedDirectPaths.push(`${toolName}:${path}`);
      }
    }
  }
  const event = { toolName: "grep", input: { pattern: canary, literal: true } };
  const decision = onToolCall(event, reviewerCtx(f.alias));
  const output = await executeNativeGrep(f.root, event.input);
  const safeDirectBlocked = onToolCall(
    { toolName: "read", input: { path: "ordinary.json" } },
    reviewerCtx(f.alias),
  )?.block === true;

  assert.deepEqual({ exposedDirectPaths, safeDirectBlocked, decision, output }, {
    exposedDirectPaths: [],
    safeDirectBlocked: false,
    decision: undefined,
    output: `ordinary.json:1: ${canary}`,
  });
});

test("reviewer direct read and grep deny descendants of generic credential directories", (t) => {
  const f = reviewerFixture(t);
  const canary = "SYNTHETIC_NESTED_CREDENTIAL_CANARY";
  const credentialPaths = [
    "AUTH.JSON/service-account.json",
    "nested/Credentials/service-account.json",
    "nested/CREDENTIALS.JSON/service-account.json",
  ];
  const safePath = "config/service-account.json";
  for (const rel of [...credentialPaths, safePath]) {
    mkdirSync(join(f.root, rel, ".."), { recursive: true });
    writeFileSync(join(f.root, rel), `${canary}\n`);
  }
  const onToolCall = handler();
  const exposedDirectPaths = [];
  for (const toolName of ["read", "grep"]) {
    for (const path of credentialPaths) {
      if (onToolCall({ toolName, input: { path } }, reviewerCtx(f.alias))?.block !== true) {
        exposedDirectPaths.push(`${toolName}:${path}`);
      }
    }
  }

  assert.deepEqual({
    exposedDirectPaths,
    safeReadBlocked: onToolCall({ toolName: "read", input: { path: safePath } }, reviewerCtx(f.alias))?.block === true,
    safeGrepBlocked: onToolCall({ toolName: "grep", input: { path: safePath, pattern: canary } }, reviewerCtx(f.alias))?.block === true,
  }, {
    exposedDirectPaths: [],
    safeReadBlocked: false,
    safeGrepBlocked: false,
  });
});

test("child read tools fail closed when the exact dispatch identity is absent or corrupt", (t) => {
  const f = fixture();
  t.after(f.close);
  writeFileSync(join(f.root, "ordinary.txt"), "reviewable\n");
  const corruptChild = "ses-policy-corrupt-child";
  const corrupt = piChildIdentityPath(f.root, SESSION, corruptChild);
  assert.equal(corrupt.ok, true);
  mkdirSync(join(corrupt.path, ".."), { recursive: true });
  writeFileSync(corrupt.path, "{broken");
  const onToolCall = handler();
  const observed = [];

  for (const [identityState, childSessionId] of [
    ["absent", "ses-policy-absent-child"],
    ["corrupt", corruptChild],
  ]) {
    for (const toolName of ["read", "grep", "find", "ls"]) {
      observed.push({
        identityState,
        toolName,
        blocked: onToolCall(
          { toolName, input: { path: "ordinary.txt" } },
          childCtx(f.root, { childSessionId }),
        )?.block === true,
      });
    }
  }

  assert.deepEqual(observed.filter(({ blocked }) => !blocked), []);
});

test("child read tools reject an identity bound to a different parent context", (t) => {
  const f = reviewerFixture(t);
  writeFileSync(join(f.root, "ordinary.txt"), "reviewable\n");
  const wrongParent = "ses-policy-wrong-parent";
  const onToolCall = handler();

  const allowed = ["read", "grep", "find", "ls"].filter((toolName) =>
    onToolCall(
        { toolName, input: { path: "ordinary.txt" } },
        childCtx(f.alias, { parentSessionId: wrongParent }),
      )?.block !== true,
  );

  assert.deepEqual(allowed, []);
});

test("a valid writer child identity preserves ordinary project reads", (t) => {
  const f = fixture();
  t.after(f.close);
  const writerChild = "ses-policy-executor";
  writeFileSync(join(f.root, "ordinary.txt"), "reviewable\n");
  assert.equal(writePiChildIdentity(f.root, {
    parentSessionId: SESSION,
    childSessionId: writerChild,
    role: "harness-executor",
    callId: "call-executor",
  }).ok, true);
  const onToolCall = handler();

  for (const toolName of ["read", "grep", "find", "ls"]) {
    assert.equal(
      onToolCall(
        { toolName, input: { path: "ordinary.txt" } },
        childCtx(f.root, { childSessionId: writerChild }),
      ),
      undefined,
      toolName,
    );
  }
});

test("reviewer recursive grep with a model glob fails closed because the native tool accepts only one glob", (t) => {
  const f = reviewerFixture(t);
  const event = { toolName: "grep", input: { pattern: "needle", path: ".", glob: "**/*.txt" } };
  const decision = handler()(event, reviewerCtx(f.alias));

  assert.equal(decision?.block, true);
  assert.equal(event.input.glob, "**/*.txt", "a denied call must not disguise the model-supplied glob");
});

test("reviewer recursive native grep cannot expose Pi auth when its search root is inside .pi", async (t) => {
  const f = reviewerFixture(t);
  const canary = "SYNTHETIC_NARROW_ROOT_CANARY";
  for (const rel of [".pi/agent/auth.json", ".pi/agent/public.txt", "nested/.pi/agent/auth.json", "nested/.pi/agent/public.txt"]) {
    mkdirSync(join(f.root, rel, ".."), { recursive: true });
    writeFileSync(join(f.root, rel), `${canary}\n`);
  }
  for (const searchRoot of [".pi", ".pi/agent", "nested/.pi", "nested/.pi/agent"]) {
    const event = { toolName: "grep", input: { pattern: canary, path: searchRoot, literal: true } };
    const decision = handler()(event, reviewerCtx(f.alias));
    assert.equal(decision, undefined, "safe neighboring files must remain searchable");
    const output = await executeNativeGrep(f.root, event.input);
    assert.equal(output, `${searchRoot.endsWith("/agent") ? "" : "agent/"}public.txt:1: ${canary}`, searchRoot);
  }
});

test("reviewer reads and native search exclude environment-specific .dev.vars credentials", async (t) => {
  const f = reviewerFixture(t);
  const canary = "SYNTHETIC_ENV_VARIANT_CANARY";
  const secrets = [".dev.vars.production", "nested/.dev.vars.staging"];
  for (const rel of [...secrets, "public.txt"]) {
    mkdirSync(join(f.root, rel, ".."), { recursive: true });
    writeFileSync(join(f.root, rel), `${canary}\n`);
  }
  const direct = secrets.map((path) => handler()({ toolName: "read", input: { path } }, reviewerCtx(f.alias))?.block === true);
  const event = { toolName: "grep", input: { pattern: canary, literal: true } };
  assert.equal(handler()(event, reviewerCtx(f.alias)), undefined);
  const output = await executeNativeGrep(f.root, event.input);
  assert.deepEqual({ direct, output }, { direct: [true, true], output: `public.txt:1: ${canary}` });
});

test("reviewer native grep preserves a model glob for an explicit safe project file", async (t) => {
  const f = reviewerFixture(t);
  writeFileSync(join(f.root, "public.txt"), "SAFE_EXPLICIT_CANARY\n");
  const event = {
    toolName: "grep",
    input: { pattern: "SAFE_EXPLICIT_CANARY", path: "public.txt", glob: "*.txt", literal: true },
  };
  const decision = handler()(event, reviewerCtx(f.alias));
  const output = await executeNativeGrep(f.root, event.input);

  assert.deepEqual({ decision, glob: event.input.glob, output }, {
    decision: undefined,
    glob: "*.txt",
    output: "public.txt:1: SAFE_EXPLICIT_CANARY",
  });
});


test("reviewer path checks agree with native tools for normalized path spellings", async (t) => {
  const f = reviewerFixture(t);
  const marker = "SYNTHETIC_PATH_RESOLUTION_FIXTURE";
  const file = "path-resolution-fixture.txt";
  writeFileSync(join(f.outside, file), marker);
  const aliases = [`@${f.outside}`, pathToFileURL(f.outside).href, "normalized\u00a0directory"];
  symlinkSync(f.outside, join(f.root, "normalized directory"), "dir");
  for (const alias of aliases) {
    mkdirSync(join(f.root, alias), { recursive: true });
    writeFileSync(join(f.root, alias, file), "ordinary decoy");
  }
  const factories = {
    read: createReadToolDefinition, grep: createGrepToolDefinition,
    find: createFindToolDefinition, ls: createLsToolDefinition,
  };
  const observations = [];
  for (const alias of aliases) {
    for (const [toolName, create] of Object.entries(factories)) {
      const input = { path: toolName === "read" ? `${alias}/${file}` : alias,
        ...(toolName === "grep" ? { pattern: marker, literal: true } : {}),
        ...(toolName === "find" ? { pattern: file } : {}),
      };
      const decision = handler()({ toolName, input }, reviewerCtx(f.root));
      let output = "";
      if (!decision?.block) {
        const result = await create(f.root).execute("path-resolution", input, undefined, undefined, {});
        output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      }
      observations.push({ toolName, blocked: decision?.block === true, externalResult: output.includes(marker) || output.includes(file) });
    }
  }
  assert.deepEqual(observations, aliases.flatMap(() => Object.keys(factories).map((toolName) => ({
    toolName, blocked: true, externalResult: false,
  }))));
  // Never access the real home: exercise only the denial decision for the tilde alias.
  mkdirSync(join(f.root, "~"), { recursive: true });
  writeFileSync(join(f.root, "~", file), "ordinary decoy");
  for (const toolName of Object.keys(factories)) {
    assert.equal(handler()({ toolName, input: { path: `~/${file}` } }, reviewerCtx(f.root))?.block, true);
  }
});
