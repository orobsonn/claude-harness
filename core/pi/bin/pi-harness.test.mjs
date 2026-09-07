import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { loadSkills } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";
import { ModelRuntime } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";
import { findInitialModel } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js";
import { SettingsManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";

import {
  buildPiHarnessInvocation,
  parseHarnessResume,
  harnessStateDir,
  materializeRuntime,
  resolvePiDependencyPaths,
  runPiHarnessCli,
} from "./pi-harness.mjs";
import { applyPiAuthPathPatch, PI_AUTH_PATH_ENV, PI_AUTH_PATH_PATCH_MARKER, PI_RESUME_ENV, verifyPiAuthPathPatch } from "../lib/pi-auth-path-patch.mjs";
import { piChildResourceSettings } from "../lib/pi-child-extensions.mjs";

const DEPENDENCIES = {
  piCli: "/npx/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  piPackage: "/npx/node_modules/@earendil-works/pi-coding-agent/package.json",
  subagentsExtension: "/npx/node_modules/@gotgenes/pi-subagents/src/index.ts",
  subagentsPackage: "/npx/node_modules/@gotgenes/pi-subagents/package.json",
};

/** @description Extensões carregadas, na ordem de `-e`. */
function loadedExtensions(args) {
  const loaded = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-e") loaded.push(args[i + 1]);
  return loaded;
}

test("launcher refuses project packages when the dedicated runtime cache is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-no-project-fallback-"));
  try {
    // Even exact-looking packages in the project are not the host runtime authority.
    for (const rel of [
      "@earendil-works/pi-coding-agent/dist/cli.js",
      "@earendil-works/pi-coding-agent/package.json",
      "@gotgenes/pi-subagents/src/index.ts",
      "@gotgenes/pi-subagents/package.json",
    ]) {
      const file = join(root, "node_modules", rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{}");
    }
    assert.throws(() => resolvePiDependencyPaths(root, { cacheRoot: join(root, "empty-cache") }), /runtime|cache/i);
    assert.equal(readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "utf8"), "{}");
    assert.equal(existsSync(join(root, "empty-cache")), false, "resolution must not provision or repair");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("launcher disables discovered project resources and loads only the harness package", () => {
  const root = "/package";
  const invocation = buildPiHarnessInvocation({
    root,
    argv: ["-p", "triage issue"],
    env: {},
    dependencyPaths: DEPENDENCIES,
    userHome: "/operator",
  });

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[0], DEPENDENCIES.piCli);
  assert.deepEqual(invocation.args.slice(1, 4), ["--no-extensions", "--no-skills", "--no-context-files"]);
  const skillFlag = invocation.args.indexOf("--skill");
  assert.deepEqual(invocation.args.slice(skillFlag, skillFlag + 2), ["--skill", join(root, "core/codex/skills")]);
  assert.deepEqual(invocation.args.slice(-2), ["-p", "triage issue"]);
  assert.equal(invocation.env.PI_CODING_AGENT_DIR, resolve(process.cwd(), ".pi/harness/runtime"));
  assert.equal(invocation.env.PI_CODING_AGENT_SESSION_DIR, resolve(process.cwd(), ".pi/harness/sessions"));
  assert.equal(invocation.env[PI_AUTH_PATH_ENV], "/operator/.pi/agent/auth.json");
});

test("launcher starts each new ceremony in an explicit fresh Pi session", () => {
  const invocation = buildPiHarnessInvocation({
    root: "/package",
    argv: ["-p", "triage issue"],
    env: {},
    dependencyPaths: DEPENDENCIES,
    sessionId: "ceremony-uuid",
  });

  const sessionFlag = invocation.args.indexOf("--session-id");
  assert.ok(sessionFlag > 0);
  assert.deepEqual(invocation.args.slice(sessionFlag, sessionFlag + 4), ["--session-id", "ceremony-uuid", "-p", "triage issue"]);
});

test("launcher exposes Grill and its private Lavish reference through the real Pi skill loader", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const fixture = mkdtempSync(join(tmpdir(), "pi-grill-discovery-"));
  try {
    const invocation = buildPiHarnessInvocation({root, argv: [], env: {}, dependencyPaths: DEPENDENCIES});
    const skillPaths = invocation.args.filter((arg, index) => invocation.args[index - 1] === "--skill");
    const loaded = loadSkills({cwd: fixture, agentDir: fixture, skillPaths, includeDefaults: false});
    const grill = loaded.skills.find(skill => skill.name === "harness-grill");
    assert.ok(grill, "Pi must discover the interview skill, not merely load a Lavish deny hook");
    assert.ok(existsSync(join(grill.baseDir, "references/lavish-usage.md")));
    assert.equal(loaded.skills.some(skill => /lavish/i.test(skill.name)), false, "Lavish is a private reference, not a standalone skill");
    assert.ok(loaded.skills.some(skill => skill.name === "harness-issues"), "Grill handoff skill is available");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("launcher rejects every external Pi session selector in favor of exact harness resume", () => {
  for (const argv of [
    ["--continue"], ["-c"], ["--resume", "prior"], ["-r", "prior"],
    ["--session", "prior"], ["--session=prior"], ["--session-id", "chosen"],
    ["--session-id=chosen"], ["--fork", "prior"], ["--fork=prior"],
    ["--no-session"], ["--session-dir", "/other"], ["--session-dir=/other"],
  ]) {
    const parsed = parseHarnessResume(argv);
    assert.equal(parsed.ok, false, `argv ${JSON.stringify(argv)}`);
    assert.match(parsed.reason, /--harness-resume <exact-session-id>/);
  }
});

test("informational, export and admin invocations remain outside session selection", () => {
  for (const argv of [["--help"], ["--version"], ["--list-models"], ["--export", "run.html"], ["auth"]]) {
    assert.deepEqual(parseHarnessResume(argv), { ok: true, resumeSessionId: null, argv });
  }
});

test("a session-control-looking prompt after -- still starts a fresh ceremony", () => {
  const invocation = buildPiHarnessInvocation({
    root: "/package",
    argv: ["--", "explique --continue para mim"],
    env: {},
    dependencyPaths: DEPENDENCIES,
    sessionId: "fresh-after-double-dash",
  });

  assert.equal(invocation.args.includes("fresh-after-double-dash"), true);
});

test("--harness-resume separa a identidade para validação antes de selecionar o arquivo", () => {
  assert.deepEqual(parseHarnessResume(["--harness-resume", "ses-approved", "-p", "continue"]), {
    ok: true, resumeSessionId: "ses-approved", argv: ["-p", "continue"],
  });
  assert.deepEqual(parseHarnessResume(["--", "--harness-resume", "ses-approved"]), {
    ok: true, resumeSessionId: null, argv: ["--", "--harness-resume", "ses-approved"],
  });
  assert.deepEqual(parseHarnessResume(["--harness-resume", "ses-approved", "--continue"]), {
    ok: false,
    reason: "Pi session controls are disabled by the harness; use --harness-resume <exact-session-id>",
  });
});

test("retomada não permite desviar o diretório da sessão validada", () => {
  for (const flags of [["--session-dir", "/another-store"], ["--session-dir=/another-store"]]) {
    assert.equal(parseHarnessResume(["--harness-resume", "ses-approved", ...flags]).ok, false);
  }
  assert.equal(parseHarnessResume(["--harness-resume", "ses-approved", "--", "--session-dir=/prompt"]).ok, true);
});

test("retomada abre o arquivo exato e nunca pede criação por id ao Pi", () => {
  const invocation = buildPiHarnessInvocation({
    root: "/package", argv: ["-p", "continue"], env: {}, dependencyPaths: DEPENDENCIES,
    resumeSessionFile: "/worktree/.pi/harness/sessions/exact.jsonl", sessionId: "expected-parent",
  });
  assert.deepEqual(invocation.args.slice(-4), ["--session", "/worktree/.pi/harness/sessions/exact.jsonl", "-p", "continue"]);
  assert.equal(invocation.args.includes("--session-id"), false);
  assert.equal(JSON.parse(invocation.env[PI_RESUME_ENV]).id, "expected-parent");
});

test("missing exact resume exits without building or spawning a replacement session and releases the worktree", () => {
  const events = [];
  const result = runPiHarnessCli(["--harness-resume", "missing-session"], {
    cwd: "/worktree",
    env: {},
    packageRoot: "/package",
    runtimePrompt: "runtime",
    acquireParentLockFn: () => ({ ok: true, release: () => events.push("release") }),
    recoverParentSessionFn: () => ({ ok: false, reason: "resume session file missing" }),
    buildInvocationFn: () => { events.push("build"); throw new Error("must not build"); },
    materializeRuntimeFn: () => events.push("materialize"),
    spawnSyncFn: () => { events.push("spawn"); return { status: 0 }; },
    errorSink: (message) => events.push(message),
  });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(events, [
    "Pi harness: cannot resume ceremony: resume session file missing",
    "release",
  ]);
});

test("lock contention exits cleanly without trying to release an unacquired lock", () => {
  const events = [];
  const result = runPiHarnessCli(["--harness-resume", "active-session"], {
    cwd: "/worktree",
    env: {},
    packageRoot: "/package",
    runtimePrompt: "runtime",
    acquireParentLockFn: () => ({ ok: false, reason: "parent orchestrator already active for worktree" }),
    errorSink: (message) => events.push(message),
  });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(events, [
    "Pi harness: cannot resume ceremony: parent orchestrator already active for worktree",
  ]);
});

test("fresh launcher releases the worktree lock after setup failure", () => {
  const events = [];
  const result = runPiHarnessCli(["-p", "deliver"], {
    cwd: "/worktree",
    env: {},
    packageRoot: "/package",
    runtimePrompt: "runtime",
    randomSessionIdFn: () => "fresh-session",
    acquireParentLockFn: (_root, options) => {
      events.push(`lock:${options.sessionId}`);
      return { ok: true, release: () => events.push("release") };
    },
    buildInvocationFn: () => ({ command: "node", args: [], env: { PI_CODING_AGENT_DIR: "/runtime" } }),
    materializeRuntimeFn: () => { throw new Error("setup failed"); },
    spawnSyncFn: () => { events.push("spawn"); return { status: 0 }; },
    errorSink: (message) => events.push(message),
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(events, ["lock:fresh-session", "Pi harness: setup failed", "release"]);
});

test("an authorized dispatched child does not contend with the parent worktree lock", () => {
  const events = [];
  const result = runPiHarnessCli(["-p", "child", "--mode", "json"], {
    cwd: "/worktree",
    env: { HARNESS_DISPATCH_PARENT_SESSION_ID: "parent", HARNESS_DISPATCH_CALL_ID: "call" },
    packageRoot: "/package",
    runtimePrompt: "runtime",
    randomSessionIdFn: () => "child-session",
    acquireParentLockFn: () => { events.push("lock"); return { ok: false, reason: "unexpected" }; },
    buildInvocationFn: ({ sessionId }) => ({ command: "node", args: [sessionId], env: { PI_CODING_AGENT_DIR: "/runtime" } }),
    materializeRuntimeFn: () => events.push("materialize"),
    spawnSyncFn: (_command, args) => { events.push(`spawn:${args[0]}`); return { status: 0 }; },
    errorSink: (message) => events.push(message),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(events, ["materialize", "spawn:child-session"]);
});

test("every ported gate is loaded, policy first and the UI tracker last", () => {
  const root = "/package";
  const loaded = loadedExtensions(
    buildPiHarnessInvocation({ root, argv: [], env: {}, dependencyPaths: DEPENDENCIES }).args,
  );
  const bridge = join(root, "core/pi/extensions/harness-subagents.ts");

  assert.deepEqual(loaded, [
    join(root, "core/pi/extensions/harness-policy.ts"),
    join(root, "core/pi/extensions/harness-task-run.ts"),
    join(root, "core/pi/extensions/harness-bootstrap.ts"),
    bridge,
    join(root, "core/pi/extensions/harness-dispatch.ts"),
    join(root, "core/pi/extensions/harness-memory.ts"),
    join(root, "core/pi/extensions/harness-tasks.ts"),
    join(root, "core/pi/extensions/harness-entry-gate.ts"),
    join(root, "core/pi/extensions/harness-reviews.ts"),
    join(root, "core/pi/extensions/harness-plan-gate.ts"),
    join(root, "core/pi/extensions/harness-plan-write-gate.ts"),
    join(root, "core/pi/extensions/harness-marker.ts"),
    join(root, "core/pi/extensions/harness-classify.ts"),
    join(root, "core/pi/extensions/harness-spec.ts"),
    join(root, "core/pi/extensions/harness-lavish-gate.ts"),
    join(root, "core/pi/extensions/harness-obs.ts"),
    join(root, "core/pi/extensions/harness-idle-nudge.ts"),
    join(root, "core/pi/extensions/harness-reinject-state.ts"),
    join(root, "core/pi/extensions/harness-version-check.ts"),
    join(root, "core/pi/extensions/harness-context-files.ts"),
    join(root, "core/pi/extensions/harness-plan-tracker.ts"),
  ]);
  assert.equal(loaded.filter((extension) => extension === bridge).length, 1, "the harness bridge loads exactly once");
  assert.equal(
    loaded.includes(DEPENDENCIES.subagentsExtension),
    false,
    "the launcher must not bypass the bridge by loading the native factory separately",
  );
});

test("the dispatch rails load after the harness bridge registers the native subagent tool", () => {
  const root = "/package";
  const loaded = loadedExtensions(
    buildPiHarnessInvocation({ root, argv: [], env: {}, dependencyPaths: DEPENDENCIES }).args,
  );
  const subagents = loaded.indexOf(join(root, "core/pi/extensions/harness-subagents.ts"));

  assert.ok(subagents > 0, "the bridge is not the first extension");
  for (const rel of ["harness-dispatch.ts", "harness-entry-gate.ts", "harness-plan-gate.ts"]) {
    assert.ok(
      loaded.findIndex((path) => path.endsWith(rel)) > subagents,
      `${rel} must load after pi-subagents`,
    );
  }
});

test("launcher never injects a provider default of its own", () => {
  const invocation = buildPiHarnessInvocation({
    root: "/package",
    argv: [],
    env: { PATH: "/usr/bin" },
    dependencyPaths: DEPENDENCIES,
  });

  assert.equal(invocation.args.includes("--model"), false);
  assert.equal(
    Object.keys(invocation.env).some((key) => key.startsWith("ANTHROPIC_")),
    false,
  );
});

test("launcher replaces inherited agent state instead of accepting it", () => {
  const invocation = buildPiHarnessInvocation({
    root: "/package",
    argv: [],
    env: { PI_CODING_AGENT_DIR: "/untrusted", PI_HARNESS_LAUNCHER: "0", [PI_AUTH_PATH_ENV]: "/untrusted/auth.json", [PI_RESUME_ENV]: "forged", KEEP_ME: "yes" },
    dependencyPaths: DEPENDENCIES,
    userHome: "/operator",
  });

  assert.equal(invocation.env.PI_CODING_AGENT_DIR, resolve(process.cwd(), ".pi/harness/runtime"));
  assert.equal(invocation.env.PI_HARNESS_LAUNCHER, "1");
  assert.equal(invocation.env[PI_AUTH_PATH_ENV], "/operator/.pi/agent/auth.json");
  assert.equal(invocation.env.KEEP_ME, "yes");
  assert.equal(Object.hasOwn(invocation.env, PI_RESUME_ENV), false);
});

test("pinned Pi overlay keeps one global auth path for parent and subagents", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-auth-path-overlay-"));
  const source = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent");
  const subagentsSource = join(process.cwd(), "node_modules/@gotgenes/pi-subagents");
  const runtime = join(directory, "node_modules/@earendil-works/pi-coding-agent");
  const subagentsRuntime = join(directory, "node_modules/@gotgenes/pi-subagents");
  for (const rel of [
    "package.json",
    "dist/config.js",
    "dist/core/auth-storage.js",
    "dist/core/agent-session.js",
    "dist/core/session-manager.js",
    "dist/core/agent-session-services.js",
    "dist/core/sdk.js",
    "dist/migrations.js",
    "dist/package-manager-cli.js",
  ]) {
    const destination = join(runtime, rel);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    cpSync(join(source, rel), destination);
  }
  for (const rel of [
    "package.json",
    "src/index.ts",
    "src/lifecycle/create-subagent-session.ts",
    "src/lifecycle/subagent-session.ts",
  ]) {
    const destination = join(subagentsRuntime, rel);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    cpSync(join(subagentsSource, rel), destination);
  }

  const packagePath = join(runtime, "package.json");
  const subagentsPackagePath = join(subagentsRuntime, "package.json");
  const sessionManager = join(runtime, "dist/core/session-manager.js");
  // Restore this test copy to the exact published 0.84.4 bytes, even if another
  // test/launcher already patched node_modules. The digest was checked against
  // npm's original tarball; never accept an already-patched fixture as pristine.
  const pristineSessionManager = readFileSync(sessionManager, "utf8")
    .replace(/^\/\/ CLAUDE_HARNESS_EXACT_RESUME_PATCH_v1\nimport .* from "node:fs";\n/, "")
    .replace(/        \/\/ Only the exact recovered parent[\s\S]*?        if \(\(resume && this.sessionFile === resume.file\) \|\| existsSync\(this.sessionFile\)\) \{/, "        if (existsSync(this.sessionFile)) {")
    .replace(/\n$/, "");
  assert.equal(createHash("sha256").update(pristineSessionManager).digest("hex"),
    "f0912a8b585263cc9793b38d97f01d19b0617c67b56d7f790bbb81a27d916a3c");
  writeFileSync(sessionManager, pristineSessionManager);
  const before = verifyPiAuthPathPatch(packagePath);
  assert.deepEqual(before, { ok: false, reason: "unpatched:dist/core/session-manager.js" });
  assert.equal(applyPiAuthPathPatch(packagePath, subagentsPackagePath).ok, true);
  assert.deepEqual(verifyPiAuthPathPatch(packagePath, subagentsPackagePath), { ok: true });
  const config = readFileSync(join(runtime, "dist/config.js"), "utf8");
  const authStorage = readFileSync(join(runtime, "dist/core/auth-storage.js"), "utf8");
  assert.match(config, new RegExp(PI_AUTH_PATH_PATCH_MARKER));
  assert.match(config, /CODING_AGENT_AUTH_PATH/);
  assert.match(authStorage, /getAuthPath\(\)/);
  assert.doesNotMatch(authStorage, /getAgentDir\(\), "auth\.json"/);
  const subagentIndex = readFileSync(join(subagentsRuntime, "src/index.ts"), "utf8");
  assert.match(subagentIndex, /PI_CODING_AGENT_AUTH_PATH/);
  assert.match(subagentIndex, /process\.env.*AUTH_PATH/);
  assert.doesNotMatch(subagentIndex, /authPath: join\(rest\.agentDir, "auth\.json"\)/);
  assert.equal(applyPiAuthPathPatch(packagePath, subagentsPackagePath).ok, true, "patch is idempotent");
  writeFileSync(sessionManager, `${readFileSync(sessionManager, "utf8")}\n// altered despite marker\n`);
  assert.deepEqual(verifyPiAuthPathPatch(packagePath, subagentsPackagePath), { ok: false, reason: "altered-patch:dist/core/session-manager.js" });
  assert.throws(() => applyPiAuthPathPatch(packagePath, subagentsPackagePath), /altered patched bytes/);
});

test("runtime defaults select Sol from Pi's real registry without a CLI model override", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-runtime-test-"));
  const runtimeDir = join(directory, "runtime");
  try {
    materializeRuntime(process.cwd(), runtimeDir);

    assert.equal(existsSync(join(runtimeDir, "subagents.json")), true);
    assert.equal(existsSync(join(runtimeDir, "agents/harness-planner.md")), true);
    assert.equal(existsSync(join(runtimeDir, "auth.json")), false);

    const settingsManager = SettingsManager.create(directory, runtimeDir);
    const modelRuntime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory({
        "openai-codex": {
          type: "oauth",
          access: "synthetic-test-access",
          refresh: "synthetic-test-refresh",
          expires: Date.now() + 60_000,
        },
      }),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: true,
    });
    const selected = await findInitialModel({
      scopedModels: [],
      isContinuing: false,
      defaultProvider: settingsManager.getDefaultProvider(),
      defaultModelId: settingsManager.getDefaultModel(),
      modelRuntime,
    });

    assert.equal(settingsManager.getDefaultProvider(), "openai-codex");
    assert.equal(settingsManager.getDefaultModel(), "gpt-5.6-sol");
    assert.ok(modelRuntime.getModels("openai-codex").some((model) => model.id === "gpt-5.6-sol"), "the installed Pi catalog contains Sol");
    assert.deepEqual(selected.model && { provider: selected.model.provider, id: selected.model.id }, {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("runtime já materializado atualiza os agentes travados sem tocar em autenticação", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-agents-refresh-"));
  const runtimeDir = join(directory, "runtime");
  materializeRuntime(process.cwd(), runtimeDir);
  const plannerPath = join(runtimeDir, "agents/harness-planner.md");
  writeFileSync(plannerPath, "stale planner", "utf8");

  materializeRuntime(process.cwd(), runtimeDir);

  assert.equal(readFileSync(plannerPath, "utf8"), readFileSync(join(process.cwd(), "core/pi/runtime/agents/harness-planner.md"), "utf8"));
  assert.equal(existsSync(join(runtimeDir, "auth.json")), false);
});

test("shipper vendorizado é olho de entrega e não recebe tools de escrita", () => {
  const shipper = readFileSync(join(process.cwd(), "core/pi/runtime/agents/harness-shipper.md"), "utf8");
  assert.match(shipper, /^tools: read, grep, find, ls, bash$/m);
  assert.doesNotMatch(shipper, /^tools:.*\b(?:edit|write)\b/m);
});

test("the harness state root exists before the first gate reads it", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-state-test-"));
  const runtimeDir = join(directory, ".pi/harness/runtime");
  materializeRuntime(process.cwd(), runtimeDir);

  assert.equal(harnessStateDir(runtimeDir), join(directory, ".pi/harness/state"));
  assert.equal(existsSync(join(directory, ".pi/harness/state")), true);
});

test("runtime já materializado migra somente o antigo default do harness para o formato do Pi", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-settings-migration-"));
  try {
    for (const legacyDefault of ["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-sol"]) {
      const runtimeDir = join(directory, legacyDefault.endsWith("terra") ? "terra" : "sol");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(join(runtimeDir, "settings.json"), JSON.stringify({ defaultModel: legacyDefault, retained: true }));

      materializeRuntime(process.cwd(), runtimeDir);

      assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir, "settings.json"), "utf8")), {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.6-sol",
        httpIdleTimeoutMs: 900_000,
        retained: true,
        ...piChildResourceSettings(process.cwd()),
        harnessChildResources: { version: 1, ...piChildResourceSettings(process.cwd()) },
      });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("runtime já materializado preserva um default explícito compatível do operador", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-explicit-settings-"));
  const runtimeDir = join(directory, ".pi/harness/runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "settings.json"), JSON.stringify({
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.6-terra",
    retained: true,
  }));

  materializeRuntime(process.cwd(), runtimeDir);

  assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir, "settings.json"), "utf8")), {
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.6-terra",
    httpIdleTimeoutMs: 900_000,
    retained: true,
    ...piChildResourceSettings(process.cwd()),
    harnessChildResources: { version: 1, ...piChildResourceSettings(process.cwd()) },
  });
});

test("runtime já materializado recebe o novo teto de turns sem perder campos próprios", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-turns-migration-"));
  const runtimeDir = join(directory, ".pi/harness/runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "subagents.json"), JSON.stringify({
    maxConcurrent: 2,
    defaultMaxTurns: 48,
    retained: true,
  }));

  materializeRuntime(process.cwd(), runtimeDir);

  assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir, "subagents.json"), "utf8")), {
    maxConcurrent: 2,
    defaultMaxTurns: 144,
    retained: true,
  });
});
