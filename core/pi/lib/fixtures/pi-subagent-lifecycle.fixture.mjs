// Isolated native lifecycle regression fixture. Uses only a deterministic local provider.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULES = fileURLToPath(new URL("../../../../node_modules/", import.meta.url));
const packageRoot = process.argv[2];
const scenario = process.argv[3];

if (!packageRoot || !["binder-throw", "bound-throw", "abort-on-created", "abort-in-preflight", "ordinary"].includes(scenario)) {
  throw new Error("usage: lifecycle-probe.mjs <pi-subagents-package-root> <scenario>");
}

const { createJiti } = await import(
  pathToFileURL(join(MODULES, "@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-static.mjs"))
);
const sdk = await import(
  pathToFileURL(join(MODULES, "@earendil-works/pi-coding-agent/dist/index.js"))
);
const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(
  pathToFileURL(join(MODULES, "@earendil-works/pi-ai/dist/index.js"))
);
const jiti = createJiti(import.meta.url, { moduleCache: true, tsconfigPaths: true });
const native = await jiti.import(join(packageRoot, "src/index.ts"), { default: true });

const fixture = mkdtempSync(join(tmpdir(), `pi-lifecycle-${scenario}-`));
const agentDir = join(fixture, "agent");
const enteredPath = join(fixture, "preflight-entered");
const releasePath = join(fixture, "preflight-release");
const factPath = join(fixture, "fact.txt");
process.chdir(fixture);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PROBE_PREFLIGHT_ENTERED = enteredPath;
process.env.PROBE_PREFLIGHT_RELEASE = releasePath;

mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(
  join(agentDir, "agents", "probe-eye.md"),
  "---\ndescription: lifecycle probe\ntools: read\ninherit_context: false\n---\nPROBE_CHILD: return the controlled fact.\n",
);
writeFileSync(
  join(agentDir, "subagents.json"),
  JSON.stringify({ maxConcurrent: 1, defaultMaxTurns: 6, graceTurns: 1 }),
);
writeFileSync(factPath, "controlled lifecycle fact\n");

if (scenario === "abort-in-preflight") {
  const extensionDir = join(fixture, ".pi", "extensions");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(
    join(extensionDir, "probe.ts"),
    `import { existsSync, writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("input", async () => {
    writeFileSync(process.env.PROBE_PREFLIGHT_ENTERED, "entered\\n");
    while (!existsSync(process.env.PROBE_PREFLIGHT_RELEASE)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { action: "continue" };
  });
}
`,
  );
}

const abortController = new AbortController();
const lifecycle = [];
let subagentTool;
let childModelCalls = 0;
const faux = fauxProvider();
const model = faux.getModel();
const respond = async (context) => {
  const isChild = String(context.systemPrompt ?? "").includes("PROBE_CHILD");
  if (!isChild) return fauxAssistantMessage("unexpected parent model call");
  childModelCalls++;
  const last = context.messages.at(-1);
  if (last?.role === "user") {
    return fauxAssistantMessage(
      fauxToolCall("read", { path: factPath }, { id: `child-read-${childModelCalls}` }),
      { stopReason: "toolUse" },
    );
  }
  return fauxAssistantMessage("controlled child complete");
};
faux.setResponses(Array.from({ length: 12 }, () => respond));

const loader = new sdk.DefaultResourceLoader({
  cwd: fixture,
  agentDir,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  extensionFactories: [
    (pi) => {
      const events = {
        on: (channel, handler) => pi.events.on(channel, handler),
        emit: (channel, data) => {
          lifecycle.push({ channel, data });
          if (channel === "subagents:child:session-created") {
            if (scenario === "abort-on-created") abortController.abort("abort-on-created");
            if (scenario === "binder-throw") throw new Error("controlled binder rejection");
          }
          if (channel === "subagents:child:bound" && scenario === "bound-throw") {
            throw new Error("controlled bound observer rejection");
          }
          pi.events.emit(channel, data);
        },
      };
      native({
        ...pi,
        events,
        registerTool: (tool) => {
          if (tool.name === "subagent") subagentTool = tool;
          pi.registerTool(tool);
        },
      });
    },
  ],
});

let session;
let toolResult;
let toolError;
let toolSettled = false;
let preflightEntered = false;
const startedAt = Date.now();

try {
  await loader.reload();
  const extensionErrors = loader.getExtensions().errors;
  if (extensionErrors.length > 0) throw new Error(JSON.stringify(extensionErrors));

  const runtime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  ({ session } = await sdk.createAgentSession({
    cwd: fixture,
    agentDir,
    resourceLoader: loader,
    modelRuntime: runtime,
    model,
    sessionManager: sdk.SessionManager.inMemory(fixture),
    settingsManager: sdk.SettingsManager.inMemory(),
  }));
  await session.bindExtensions({});
  if (!subagentTool) throw new Error("native subagent tool was not registered");

  const run = subagentTool.execute(
    "lifecycle-probe-call",
    {
      subagent_type: "probe-eye",
      description: "Lifecycle probe",
      prompt: "Read the controlled fact.",
      max_turns: 6,
    },
    abortController.signal,
    undefined,
    {},
  );

  if (scenario === "abort-in-preflight") {
    const deadline = Date.now() + 4000;
    while (!existsSync(enteredPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    preflightEntered = existsSync(enteredPath);
    if (!preflightEntered) throw new Error("child input preflight did not enter");
    abortController.abort("abort-in-preflight");
    writeFileSync(releasePath, "release\n");
  }

  try {
    toolResult = await run;
  } catch (error) {
    toolError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  toolSettled = true;
} finally {
  if (session?.extensionRunner) {
    await session.extensionRunner.emit({ type: "session_shutdown" });
  }
  session?.dispose();
}

await new Promise((resolve) => setTimeout(resolve, 25));
const count = (suffix) => lifecycle.filter((event) => event.channel === `subagents:child:${suffix}`).length;
const boundPayload = lifecycle.find((event) => event.channel === "subagents:child:bound")?.data;
const outputText = toolResult?.content
  ?.filter((part) => part.type === "text")
  .map((part) => part.text)
  .join("");
const activeHandles = process
  ._getActiveHandles()
  .map((handle) => handle?.constructor?.name ?? "unknown")
  .filter((name) => !["Socket", "WriteStream", "ReadStream"].includes(name));

const result = {
  scenario,
  packageRoot,
  counts: {
    created: count("session-created"),
    bound: count("bound"),
    completed: count("completed"),
    disposed: count("disposed"),
    childModelCalls,
    childToolUses: toolResult?.details?.toolUses ?? 0,
  },
  toolSettled,
  toolError: toolError ?? null,
  toolStatus: toolResult?.details?.status ?? null,
  outputText: outputText?.slice(0, 240) ?? null,
  preflightEntered,
  parentSignalAborted: abortController.signal.aborted,
  durationMs: Date.now() - startedAt,
  activeHandles,
  boundResources: boundPayload ? {
    extensions: boundPayload.extensions,
    skills: boundPayload.skills,
  } : null,
};

console.log(JSON.stringify(result));
rmSync(fixture, { recursive: true, force: true });
