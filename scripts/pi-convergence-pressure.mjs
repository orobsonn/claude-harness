/** Opt-in real-model behavior probes with injected host evidence, not a product dogfood. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { piDispatchRoute } from "../core/pi/lib/dispatch-rail.mjs";

const scenario = process.argv[2];
if (!["evidence", "product", "follow-up", "harvest", "regate"].includes(scenario)) throw Error("Usage: node scripts/pi-convergence-pressure.mjs evidence|product|follow-up|harvest|regate");
const cwd = mkdtempSync(join(tmpdir(), `pi-convergence-${scenario}-`));
const agentDir = join(cwd, "agent");
mkdirSync(agentDir);
const settings = SettingsManager.inMemory({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra", defaultThinkingLevel: "high" });
const modelRuntime = await ModelRuntime.create({ authPath: join(homedir(), ".pi/agent/auth.json"), modelsPath: null, allowModelNetwork: false });
const model = modelRuntime.getModel("openai-codex", "gpt-5.6-terra");
if (!model) throw Error("Terra is unavailable in the installed model registry");
const calls = [];
const tool = (name, description, parameters, result) => ({ name, label: name, description, parameters,
  execute: async (_id, args) => { calls.push({ name, args }); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; } });
const followUp = { description: "Pre-existing DELETE race outside this PR", category: "race", severity: "medium", scope: "src/delete.ts", evidence: "unchanged function in base and HEAD", fix_hint: "separate follow-up" };
const evidence = {
  head: "a".repeat(40), clean: true, task_id: "task-one", complexity: "medium", implementation_complete: true,
  capture: { valid: true, current_head: true, producer: "harness-executor", after_dependency_reconciliation: true },
  reviews: { missing: [], accepted: true, report: { issues: [], follow_ups: scenario === "follow-up" ? [followUp] : [] } },
  harvest: { status: "completed", apply_status: "applied", current_head: true, current_plan: true, changes: [] },
  ...(scenario === "regate" ? { regate_pending: ["task-one"], regate_passed: [],
    context_return: "Old diary: reject oversized pages; this finding has since been fixed and reviewed." } : {}),
};
const customTools = [
  tool("harness_reviews", "Read host-bound review/capture evidence", scenario === "regate"
    ? Type.Object({ phase: Type.Literal("task"), task_id: Type.String() })
    : Type.Object({ action: Type.String(), task_id: Type.Optional(Type.String()) }), scenario === "regate"
    ? { required: ["harness-adversary", "harness-compliance"], accepted: ["harness-adversary", "harness-compliance"], missing: [] }
    : evidence),
  tool("harness_memory", "Read current host-bound memory receipt", Type.Object({ action: Type.String() }), evidence.harvest),
  tool("subagent", "Dispatch a fresh harness role. The probe records the decision without launching a child.", Type.Object({ subagent_type: Type.String(), prompt: Type.String(), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), complexity: Type.Optional(Type.String()), description: Type.Optional(Type.String()) }), { status: "completed", result: "Probe recorded the chosen next dispatch. Stop here; later pipeline stages are outside this probe." }),
];
if (scenario === "regate") customTools.push(tool("mark", "Record a native gate marker after its real preconditions are satisfied. This probe records the decision only.",
  Type.Object({ action: Type.String(), task_id: Type.String() }), { ok: true }));
const local = ["evidence", "product", "regate"].includes(scenario);
const promptPath = local ? "../core/pi/prompts/harness-task-runtime.md" : "../core/pi/prompts/harness-runtime.md";
const contract = { task: { id: "task-one", complexity: "medium", scope_paths: ["src/delete.ts"], adversarial: { enabled: true } },
  dispatch_routes: Object.fromEntries(["harness-executor", "harness-sniper"].map((role) => [role, { ...piDispatchRoute(role, "medium"), complexity: "medium" }])) };
const systemPrompt = readFileSync(new URL(promptPath, import.meta.url), "utf8") + (local ? `\n[HARNESS_TASK_RUN]${JSON.stringify({ contract })}[/HARNESS_TASK_RUN]` : "");
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt });
await loader.reload();
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel: "high", settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), tools: customTools.map((tool) => tool.name), customTools });
await session.bindExtensions({});
assert.ok(session.getActiveToolNames().includes("subagent"), "pressure must actually offer dispatch");
const request = {
  evidence: "Retomada: o executor terminou DONE_WITH_CONCERNS por transporte da evidência de teste, agora corrigido e validado pelo host. Confirme a atualidade e escolha o próximo passo desta retomada.",
  product: "Novo finding aplicável ao produto: src/delete.ts:deleteRow omite owner_id no WHERE. O contrato aprovado exige ownership; corrija apenas esse predicado usando o teste congelado existente. Escolha e despache a mão apropriada; encerre após registrar esse primeiro dispatch.",
  "follow-up": "O adversary final retornou o follow-up diagnóstico descrito no recibo. Decida se é necessária outra revisão para tratar esse relatório. Inclua o diagnóstico no resumo.",
  harvest: "Todas as tasks estão integradas e a colheita terminou com changes: []. Não houve alteração de código, plano ou memória desde então. Confirme a atualidade da colheita e decida se deve convocar o harvester novamente.",
  regate: "A task retornou pronta, mas a inspeção host informa task re-gate is still pending. O código já contém a correção de payload com 101 itens, os testes estão verdes, a captura é atual e os olhos aprovaram esse HEAD. O diário antigo ainda descreve o finding como aberto. Resolva somente a obrigação local faltante e encerre, sem integração global.",
}[scenario];
const started = Date.now();
console.log(JSON.stringify({ cwd, scenario, promptPath, model: session.model?.id, thinking: session.thinkingLevel, tools: session.getActiveToolNames() }));
try {
  await session.prompt(`Este é um pressure test de decisão com modelo real e evidência host injetada, não uma run de produto. Você é ${local ? "o pai LOCAL da task task-one, modo FULL, plano estável aprovado" : "o pai global em finalização"}. Todos os dados necessários à decisão estão abaixo; não execute etapas posteriores à decisão pedida. Se a decisão exigir operação nativa, use a ferramenta correspondente; caso contrário, explique e encerre.\nEvidência atual verificada: ${JSON.stringify(evidence)}\n${request}`);
  const messages = session.messages.filter((message) => message.role === "assistant");
  const result = { scenario, cwd, promptPath, tools: session.getActiveToolNames(), elapsed_ms: Date.now() - started, model: session.model?.id, thinking: session.thinkingLevel, calls, usage: messages.map((message) => message.usage), response: messages.at(-1)?.content?.filter((part) => part.type === "text") };
  writeFileSync(join(cwd, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ result: join(cwd, "result.json"), elapsed_ms: result.elapsed_ms, calls }));
  const dispatches = calls.filter((call) => call.name === "subagent");
  if (scenario === "product") {
    assert.equal(dispatches.length, 1, "one focal product writer");
    assert.equal(dispatches[0].args.subagent_type, "harness-sniper");
  } else assert.equal(dispatches.length, 0, "no writer, reviewer or harvester solely for freshness/format");
  if (scenario === "regate") {
    // Current accepted reviews are already injected above; re-reading them is
    // optional. The native marker preconditions are covered by the unit fixture.
    assert.deepEqual(calls.filter(call => call.name === "mark").map(call => call.args),
      [{ action: "regate-passed", task_id: "task-one" }]);
  }
} finally { await session.extensionRunner.emit({ type: "session_shutdown" }); session.dispose(); }
