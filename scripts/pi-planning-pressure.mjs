/** Opt-in real-model pressure exercise. Never runs in the ordinary test suite. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import harnessPlanningTools from "../core/pi/extensions/harness-planning-tools.ts";
import { writePiChildIdentity } from "../core/pi/lib/pi-child-identity.mjs";
import { PLANNING_TOOLS } from "../core/pi/lib/planning-tools.mjs";
import { piDispatchRoute } from "../core/pi/lib/dispatch-rail.mjs";

const scenario = process.argv[2];
if (!["max", "atomic-high", "mcp"].includes(scenario)) throw Error("Usage: node scripts/pi-planning-pressure.mjs max|atomic-high|mcp");
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const cwd = mkdtempSync(join(tmpdir(), `pi-pressure-${scenario}-`));
const agentDir = join(cwd, "agent");
mkdirSync(agentDir);
mkdirSync(join(cwd, "src"));
const feature = `pressure-${scenario}`;
const planPath = join(cwd, ".pi/harness/plans", feature, "execution-plan.json");
mkdirSync(resolve(planPath, ".."), { recursive: true });
const branches = scenario === "max" ? 65 : 34;
writeFileSync(join(cwd, "src/workflow.ts"), `export function processRecord(record) {\n${Array.from({ length: branches }, (_, i) => `  if (record.kind === ${i}) record.value += ${i};`).join("\n")}\n  return record;\n}\n`);
const spec = scenario === "max"
  ? "Implement three independently observable outcomes: validate inbound records with explicit invalid-record errors (#ac-1); schedule retry of transient delivery failures preserving idempotency keys (#ac-2); export a read-only delivery audit summary (#ac-3). These have independent contracts and may be delivered after their declared dependencies. A proposed single max task combines all three; reconsider its decomposition. Each may own a separate test file. No fixed task count is required."
  : "Implement atomic claim and fencing-token increment in one database transaction (#ac-1). Reject expired ownership on commit and preserve a concurrent winner (#ac-2). Claim and token update share a single invariant: consumers must never observe one without the other. Splitting would require an artificial intermediate API/state and break the invariant. Keep the minimal behavioral tests together. Assess high complexity and document the atomicity justification; do not invent independent work.";
writeFileSync(join(cwd, "spec.md"), `# Approved specification\n${spec}\nJourney #uj-delivery: deterministic delivery processing.\n`);
const parent = SessionManager.create(cwd, join(cwd, "sessions"));
const child = SessionManager.create(cwd, join(cwd, "sessions"), { parentSession: parent.getSessionId() });
const identity = writePiChildIdentity(cwd, { parentSessionId: parent.getSessionId(), childSessionId: child.getSessionId(), role: "harness-planner", callId: "pressure-planner" });
if (!identity.ok) throw Error(identity.reason);
// The exercise uses the real role identity and tools in an isolated SDK session;
// it does not claim to be a product pipeline run or to satisfy its delivery gates.
const settings = SettingsManager.inMemory({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-sol", defaultThinkingLevel: "high" });
const route = piDispatchRoute("harness-planner");
const modelRuntime = await ModelRuntime.create({ authPath: join(homedir(), ".pi/agent/auth.json"), modelsPath: null, allowModelNetwork: false });
const model = modelRuntime.getModel("openai-codex", route.model.split("/")[1]);
if (!model) throw Error("Planner route unavailable in installed Pi registry");
const asset = readFileSync(join(root, "core/pi/runtime/agents/harness-planner.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: asset,
  extensionFactories: [async (pi) => harnessPlanningTools(pi, scenario === "mcp" ? {} : { call: null })] });
await loader.reload();
const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel: route.thinking, settingsManager: settings, resourceLoader: loader, sessionManager: child, tools: ["read", "grep", "find", "ls", "write", ...PLANNING_TOOLS] });
if (extensionsResult.errors.length) throw Error(JSON.stringify(extensionsResult.errors));
await session.bindExtensions({});
const events = [];
session.subscribe((event) => { if (["tool_execution_start", "tool_execution_end", "message_end"].includes(event.type)) events.push(event); });
const start = Date.now();
console.log(JSON.stringify({ cwd, scenario, model: session.model?.id, thinking: session.thinkingLevel, tools: session.getActiveToolNames() }));
try {
  await session.prompt(scenario === "mcp"
    ? `Stable ceremony mode FULL; feature_id=${feature}; approved spec is spec.md. This is a read-only integration probe before planning. Call mv_recall with query 'atomic transaction idempotency'; if relevant, read one note with mv_get_note. Call mp_retrieve grep with query 'idempotencia'. Do not write any file or memory. Report availability honestly and stop.`
    : `Stable ceremony mode FULL. feature_id=${feature}. The complete approved spec is spec.md. Inspect src/workflow.ts. Use harness_complexity with that file's path to cross-check complexity, then exercise your own judgment about the intended change. MV/MP are deliberately absent for this exercise: their absence must not block. Write the canonical plan to ${planPath}. Do not implement product code or create synthetic source for scoring. Explain the decomposition or atomicity justification in the plan's existing fields.`);
  const messages = session.messages.filter((message) => message.role === "assistant");
  const usage = messages.map((message) => message.usage).filter(Boolean);
  const report = { scenario, cwd, elapsed_ms: Date.now() - start, model: session.model?.id, thinking: session.thinkingLevel, usage, events };
  writeFileSync(join(cwd, "result.json"), JSON.stringify(report, null, 2));
  if (scenario !== "mcp") {
    const calls = events.filter(event => event.type === "tool_execution_start" && event.toolName === "harness_complexity");
    assert.ok(calls.length > 0, "Real planner must exercise file scoring in this pressure test");
    assert.ok(calls.every(event => typeof event.args.path === "string" && !Object.hasOwn(event.args, "source")), "Scoring must receive file paths, never invented source");
    const results = events.filter(event => event.type === "tool_execution_end" && event.toolName === "harness_complexity");
    assert.ok(results.some(event => event.result?.details?.ok && event.result.details.basis === "whole-file-approximation"), "The real file must be read and scored successfully");
  }
  console.log(JSON.stringify({ result: join(cwd, "result.json"), elapsed_ms: report.elapsed_ms, calls: events.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName), response: messages.at(-1)?.content?.filter((part) => part.type === "text").map((part) => part.text) }));
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown" });
  session.dispose();
}
