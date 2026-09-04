/**
 * @description Contrato nativo do pacote Pi: `pi install <pacote>` declara extensões em ordem
 * estável, e a extensão de bootstrap materializa somente os agentes que pertencem ao harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  parseFrontmatter,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import harnessBootstrap from "./harness-bootstrap.ts";
import { RUNTIME_ROLES } from "../lib/roles.mjs";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const PI_CLI = join(PACKAGE_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const PI_INDEX_URL = pathToFileURL(join(PACKAGE_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;
const RUNTIME_PROMPT = readFileSync(join(PACKAGE_ROOT, "core/pi/prompts/harness-runtime.md"), "utf8").trim();

const EXPECTED_EXTENSION_BASENAMES = [
  "harness-policy.ts",
  "harness-bootstrap.ts",
  "index.ts",
  "harness-dispatch.ts",
  "harness-entry-gate.ts",
  "harness-plan-gate.ts",
  "harness-plan-write-gate.ts",
  "harness-marker.ts",
  "harness-classify.ts",
  "harness-spec.ts",
  "harness-lavish-gate.ts",
  "harness-obs.ts",
  "harness-idle-nudge.ts",
  "harness-reinject-state.ts",
  "harness-version-check.ts",
  "harness-context-files.ts",
  "harness-plan-tracker.ts",
];

function nativeEnv(home, agentDir = join(home, "custom-agent")) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), PI_CODING_AGENT_DIR: agentDir };
  delete env.PI_HARNESS_LAUNCHER;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  return env;
}

function nativeHome(t) {
  const home = mkdtempSync(join(tmpdir(), "pi-native-bootstrap-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function register() {
  const handlers = new Map();
  harnessBootstrap({ on: (event, handler) => handlers.set(event, handler) });
  return handlers;
}

function agentPath(agentDir, role) {
  return join(agentDir, "agents", `${role}.md`);
}

function parentCtx(overrides = {}) {
  return { sessionManager: { getHeader: () => ({}) }, ...overrides };
}

function childCtx(overrides = {}) {
  return { sessionManager: { getHeader: () => ({ parentSession: "parent-session" }) }, ...overrides };
}

test("native bootstrap respeita agentDir customizado, materializa RUNTIME_ROLES e injeta a prosa", async (t) => {
  const home = nativeHome(t);
  const agentDir = join(home, "custom-agent");
  const previous = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, launcher: process.env.PI_HARNESS_LAUNCHER };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_HARNESS_LAUNCHER;
  t.after(() => {
    process.env.HOME = previous.home;
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.launcher === undefined) delete process.env.PI_HARNESS_LAUNCHER;
    else process.env.PI_HARNESS_LAUNCHER = previous.launcher;
  });

  const handlers = register();
  const onStart = handlers.get("before_agent_start");
  assert.equal(typeof onStart, "function", "bootstrap nativo deve registrar before_agent_start");
  for (const role of RUNTIME_ROLES) {
    const target = agentPath(agentDir, role);
    assert.equal(existsSync(target), true, `faltou materializar ${role}`);
    const content = readFileSync(target, "utf8");
    const parsed = parseFrontmatter(content);
    assert.match(content, new RegExp(`native-bootstrap.*${role}`));
    assert.equal(typeof parsed.frontmatter.description, "string", `${role} precisa ser anunciável pelo subagents`);
    assert.equal(typeof parsed.frontmatter.tools, "string", `${role} precisa manter suas tools`);
    assert.equal(parsed.frontmatter.max_turns, 144, `${role} precisa manter o teto finito`);
    assert.ok(parsed.body.trim().length > 0, `${role} precisa manter a prosa utilizável pelo subagents`);
  }
  assert.equal(existsSync(join(agentDir, "settings.json")), false);
  assert.equal(existsSync(join(agentDir, "auth.json")), false);
  assert.equal(existsSync(join(agentDir, "subagents.json")), false);

  const injected = await onStart({ systemPrompt: "PROMPT BASE" }, parentCtx());
  assert.match(injected.systemPrompt, /^PROMPT BASE/);
  assert.match(injected.systemPrompt, new RegExp(RUNTIME_PROMPT.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await onStart({ systemPrompt: "PROMPT BASE" }, childCtx()), undefined, "filho não herda a prosa do pai");
});

test("bootstrap permanece inerte somente com o sinal explícito do launcher", (t) => {
  const home = nativeHome(t);
  const previous = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, launcher: process.env.PI_HARNESS_LAUNCHER };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "launcher-runtime");
  process.env.PI_HARNESS_LAUNCHER = "1";
  t.after(() => {
    process.env.HOME = previous.home;
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.launcher === undefined) delete process.env.PI_HARNESS_LAUNCHER;
    else process.env.PI_HARNESS_LAUNCHER = previous.launcher;
  });

  const handlers = register();
  assert.equal(handlers.has("before_agent_start"), false);
  assert.equal(existsSync(join(home, "launcher-runtime", "agents")), false);
});

test("native bootstrap aborta em agent_start e bloqueia dispatch em colisão, preservando os bytes do usuário", (t) => {
  const home = nativeHome(t);
  const agentDir = join(home, "custom-agent");
  const previous = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, launcher: process.env.PI_HARNESS_LAUNCHER };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_HARNESS_LAUNCHER;
  t.after(() => {
    process.env.HOME = previous.home;
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.launcher === undefined) delete process.env.PI_HARNESS_LAUNCHER;
    else process.env.PI_HARNESS_LAUNCHER = previous.launcher;
  });

  const colliding = agentPath(agentDir, RUNTIME_ROLES[0]);
  mkdirSync(dirname(colliding), { recursive: true });
  writeFileSync(colliding, "usuário é dono deste agente\n");
  const handlers = register();

  assert.equal(readFileSync(colliding, "utf8"), "usuário é dono deste agente\n");
  assert.equal(typeof handlers.get("before_agent_start"), "function");
  assert.equal(typeof handlers.get("agent_start"), "function");
  assert.equal(typeof handlers.get("tool_call"), "function");
  let aborted = false;
  const onStart = handlers.get("before_agent_start");
  const diagnostic = onStart({ systemPrompt: "PROMPT BASE" }, parentCtx({ abort: () => { aborted = true; } }));
  assert.equal(aborted, false, "o contexto ainda não tem activeRun durante before_agent_start");
  handlers.get("agent_start")({}, parentCtx({ abort: () => { aborted = true; } }));
  assert.equal(aborted, true, "agent_start aborta o activeRun antes de qualquer tool");
  assert.match(diagnostic.message.content, /native-agent-collision/);
  assert.deepEqual(handlers.get("tool_call")({ toolName: "subagent", input: {} }), {
    block: true,
    terminate: true,
    reason: diagnostic.message.content,
  });
  for (const role of RUNTIME_ROLES.slice(1)) {
    assert.equal(existsSync(agentPath(agentDir, role)), false, `não pode escrever ${role} após colisão`);
  }
});

test("colisão aborta uma sessão SDK real antes de payload ou ferramenta", async (t) => {
  const home = nativeHome(t);
  const agentDir = join(home, "custom-agent");
  const previous = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, launcher: process.env.PI_HARNESS_LAUNCHER };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_HARNESS_LAUNCHER;
  t.after(() => {
    process.env.HOME = previous.home;
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.launcher === undefined) delete process.env.PI_HARNESS_LAUNCHER;
    else process.env.PI_HARNESS_LAUNCHER = previous.launcher;
  });

  const colliding = agentPath(agentDir, RUNTIME_ROLES[0]);
  mkdirSync(dirname(colliding), { recursive: true });
  writeFileSync(colliding, "usuário é dono deste agente\n");

  let payloadEvents = 0;
  let agentStartSignal;
  const loader = new DefaultResourceLoader({
    cwd: PACKAGE_ROOT,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      harnessBootstrap,
      (pi) => {
        pi.on("agent_start", (_event, ctx) => { agentStartSignal = ctx.signal; });
        pi.on("before_provider_request", () => { payloadEvents += 1; });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);

  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("this response must be aborted")]);
  let streamSignal;
  const originalProvider = faux.provider;
  const spyProvider = {
    ...originalProvider,
    stream: (...args) => originalProvider.stream(...args),
    streamSimple: (...args) => {
      streamSignal = args[2]?.signal;
      return originalProvider.streamSimple(...args);
    },
  };
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(spyProvider);
  const { session } = await createAgentSession({
    cwd: PACKAGE_ROOT,
    agentDir,
    resourceLoader: loader,
    modelRuntime: runtime,
    model: faux.getModel(),
    sessionManager: SessionManager.inMemory(PACKAGE_ROOT),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});

  const sessionEvents = [];
  session.subscribe((event) => sessionEvents.push(event));
  await session.prompt("attempt native bootstrap collision", { expandPromptTemplates: false });

  assert.equal(agentStartSignal?.aborted, true, "agent_start recebeu o activeRun e o abortou");
  assert.ok(streamSignal === undefined || streamSignal.aborted, "um provider customizado só pode receber o sinal já abortado");
  assert.equal(payloadEvents, 0, "não monta payload de provider após o abort");
  assert.equal(sessionEvents.some((event) => event.type === "tool_execution_start"), false);
  const assistant = [...session.messages].reverse().find((message) => message.role === "assistant");
  // Nesta versão do SDK o abort antes da chamada do provider é representado como `error`
  // com esta causa literal (não como stopReason `aborted`). O comportamento relevante é o
  // signal já abortado e a ausência de payload/tool executado acima.
  assert.equal(assistant?.stopReason, "error");
  assert.equal(assistant?.errorMessage, "This operation was aborted");
});

test("pi install seguido de DefaultResourceLoader.reload converge para o manifesto nativo", (t) => {
  const home = nativeHome(t);
  const agentDir = join(home, "custom-agent");
  const env = nativeEnv(home, agentDir);
  execFileSync(process.execPath, [PI_CLI, "install", PACKAGE_ROOT], {
    cwd: PACKAGE_ROOT,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

  const probe = [
    `import { DefaultResourceLoader } from ${JSON.stringify(PI_INDEX_URL)};`,
    'import { readdirSync } from "node:fs";',
    'import { join } from "node:path";',
    "const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, '.pi', 'agent');",
    `const loader = new DefaultResourceLoader({ cwd: ${JSON.stringify(PACKAGE_ROOT)}, agentDir });`,
    "await loader.reload();",
    "const first = loader.getExtensions();",
    "await loader.reload();",
    "const result = loader.getExtensions();",
    "const subagents = result.extensions.find((entry) => entry.path.includes('@gotgenes/pi-subagents'));",
    "process.stdout.write(JSON.stringify({ paths: result.extensions.map((entry) => entry.path), firstPaths: first.extensions.map((entry) => entry.path), errors: result.errors, agentFiles: readdirSync(join(agentDir, 'agents')).sort(), hasSubagentTool: subagents?.tools.has('subagent') ?? false }));",
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: PACKAGE_ROOT,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  const loaded = JSON.parse(output);

  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.paths.map((path) => basename(path)), EXPECTED_EXTENSION_BASENAMES);
  assert.deepEqual(loaded.paths, loaded.firstPaths, "reload repetido precisa convergir sem uma instalação adicional");
  assert.equal(loaded.paths.some((path) => basename(path) === "harness-run-hand.ts"), false);
  assert.deepEqual(loaded.agentFiles, RUNTIME_ROLES.map((role) => `${role}.md`).sort());
  assert.equal(loaded.hasSubagentTool, true, "subagents carregou depois de receber os papéis nativos");
});
