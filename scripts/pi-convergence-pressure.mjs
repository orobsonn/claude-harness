/** Opt-in real-model behavior probes with injected host evidence, not a product dogfood. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { piDispatchRoute } from "../core/pi/lib/dispatch-rail.mjs";
import harnessTasks from "../core/pi/extensions/harness-tasks.ts";
import { TASK_ACTION_FIELDS } from "../core/pi/lib/task-coordinator.mjs";

const scenario = process.argv[2];
const recoverableTask = scenario === "recoverable-task";
const twoConcerns = scenario === "two-concerns";
const abandonedResume = scenario === "abandoned-delivery-resume";
const conflictingFix = scenario === "conflicting-fix";
const taskEyes = ["auth-task-eyes", "schema-task-eyes", "internal-task-eyes"].includes(scenario);
if (!recoverableTask && !twoConcerns && !conflictingFix && !taskEyes && !abandonedResume && !["evidence", "product", "follow-up", "harvest", "regate", "final-eyes", "post-review-harvest", "post-harvest-shipper", "fixture-maintenance", "delivery-conflict"].includes(scenario)) throw Error("Unknown convergence scenario");
const cwd = mkdtempSync(join(tmpdir(), `pi-convergence-${scenario}-`));
const agentDir = join(cwd, "agent");
mkdirSync(agentDir);
const settings = SettingsManager.inMemory({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra", defaultThinkingLevel: "high" });
const modelRuntime = await ModelRuntime.create({ authPath: join(homedir(), ".pi/agent/auth.json"), modelsPath: null, allowModelNetwork: false });
const model = modelRuntime.getModel("openai-codex", "gpt-5.6-terra");
if (!model) throw Error("Terra is unavailable in the installed model registry");
const calls = [], rejectedCalls = [];
let taskSchema;
harnessTasks({ on() {}, registerTool(definition) { if (definition.name === "harness_tasks") taskSchema = definition.parameters; } });
const tool = (name, description, parameters, result) => {
  const definition = { name, label: name, description, parameters: name === "harness_tasks" ? taskSchema : parameters,
    execute: async (id, raw) => {
      let args;
      try {
        args = validateToolArguments(definition, { id, name, arguments: raw });
        if (name === "harness_tasks") {
          const fields = args.action === "wait" ? ["action", "task_id"] : TASK_ACTION_FIELDS[args.action];
          if (!fields || Object.keys(args).some(key => !fields.includes(key) && !(args.action === "status" && key === "wait_seconds"))) {
            throw Error(`unexpected task parameters for ${args.action}; allowed: ${fields?.join(', ')}`);
          }
        }
      } catch (error) { rejectedCalls.push({ name, args: raw, error: String(error) }); throw error; }
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    } };
  return definition;
};
const followUp = { description: "Pre-existing DELETE race outside this PR", category: "race", severity: "medium", scope: "src/delete.ts", evidence: "unchanged function in base and HEAD", fix_hint: "separate follow-up" };
const evidence = {
  head: "a".repeat(40), clean: true, task_id: "task-one", complexity: "medium", implementation_complete: true,
  capture: { valid: true, current_head: true, producer: "harness-executor", after_dependency_reconciliation: true },
  reviews: { missing: [], accepted: true, report: { issues: [], follow_ups: scenario === "follow-up" ? [followUp] : [] } },
  harvest: { status: "completed", apply_status: "applied", current_head: true, current_plan: true, changes: [] },
  ...(scenario === "regate" ? { regate_pending: ["task-one"], regate_passed: [],
    context_return: "Old diary: reject oversized pages; this finding has since been fixed and reviewed." } : {}),
  ...(scenario === "fixture-maintenance" ? { implementation_complete: false, capture: null,
    reviews: { accepted: false, missing: ["harness-compliance"] }, harvest: null,
    fixture_delta: "Existing retry test lacks an eligible owner in its setup; its behavioral assertions are unchanged. No hand has edited it in this new task." } : {}),
  ...(["final-eyes", "post-review-harvest"].includes(scenario) ? {
    final_review_done: scenario === "post-review-harvest",
    reviews: { phase: "final", accepted: scenario === "post-review-harvest",
      missing: scenario === "final-eyes" ? ["harness-adversary", "harness-compliance"] : [],
      report: { issues: [] }, current_head: true, rework_and_revalidation_complete: true },
    harvest: { harvestReceipt: null, durableFiles: [{ path: "MEMORY.md", sha256: null, content: null }] },
  } : {}),
  ...(scenario === "post-harvest-shipper" ? {
    head: "b".repeat(40), final_review_done: true,
    reviews: { phase: "final", accepted: true, missing: [], reviewed_head: "a".repeat(40),
      valid_through_host_memory_proof: true, report: { issues: [] } },
    harvest: { status: "completed", apply_status: "applied", current_head: true, current_plan: true,
      base_head: "a".repeat(40), head: "b".repeat(40), changes: [{ path: "MEMORY.md", exact_committed_proposal: true }] },
  } : {}),
  ...(scenario === "delivery-conflict" ? { final_review_done: true, tasks: [{ id: "task-one", status: "integrated" }],
    shipment: { status: "BLOCKED", pr: 42, head: "a".repeat(40), base_sha: "b".repeat(40), mergeable: "CONFLICTING", checks: [] },
    product_delta_requested: false } : {}),
  ...(abandonedResume ? {
    final_review_done: false, reviews: { accepted: false, phase: "final", invalidated_by_resume: true },
    task: { id: "task-one", attempt_id: "attempt-one", head: "c".repeat(40), clean: true,
      status: "blocked", launches: 2, correction_barrier: true,
      original_integration: { intact: true, parent_contains_exact_task: true, reviews_still_valid: true },
      latest_hand: { outcome: "BLOCKED", touchedPaths: [], reason: "task run cannot deliver or integrate globally" },
      resume_reason: "Incorporar main para resolver conflito de MEMORY.md na entrega" },
    base_fetched: true, base_not_merged: true, product_delta_requested: false,
  } : {}),
};
const taskReviewStatus = { required: ["harness-adversary", "harness-compliance"],
  available: ["harness-adversary", "harness-compliance", "harness-security"], accepted: [],
  missing: ["harness-adversary", "harness-compliance"] };
if (taskEyes) Object.assign(evidence, { reviews: taskReviewStatus, harvest: null,
  implementation_delta: scenario === "auth-task-eyes"
    ? "src/lib/shared/auth.ts: API/admin middleware now use crypto.subtle.timingSafeEqual on UTF-8 bytes; tests prove primitive authority, unequal byte lengths, and unchanged 401 responses."
    : scenario === "schema-task-eyes"
      ? "src/lib/plans/validation.ts: public API Zod budget inputs reject 999 and accept 1000, preserving existing ceilings; fixtures and boundary tests pass."
      : "src/sync/plan-executor-cleanup.ts: compare stored internal timestamps numerically instead of lexically. No auth, secrets, external input/client, entrypoint, dependency or log changes; focused tests pass.",
  final_review: { security: scenario !== "internal-task-eyes" },
});
if (conflictingFix) Object.assign(evidence, {
  implementation_complete: false, reviews: { accepted: false, missing: ["harness-security"] }, harvest: null,
  approved_contract: "Persist exact timestamp in local reservation BEFORE the DB write. Resume unfinished reservation after crash. Completed duplicates with only rounded DB timestamp must preserve attribution.",
  failing_fixture: "test/recovery.test.mjs:42 seeds DB row but no local reservation, then expects crash recovery to update attribution. The fixture omits the mandatory pre-DB reservation.",
  finding: "After GC, a replay supplies altered milliseconds within the same stored second and changes attribution on a later alarm.",
  proposed_fix_hint: "Permanently prevent attribution changes for ALL recoveries, including the locally reserved crash case.",
  prior_attempt: "Blindly following that blanket fix broke the approved crash-recovery assertion; it was reverted. Do not repeat the incompatible instruction.",
});
const customTools = [
  tool("harness_reviews", "Read host-bound review/capture evidence", scenario === "regate" || taskEyes
    ? Type.Object({ phase: Type.Literal("task"), task_id: Type.String() })
    : Type.Object({ action: Type.String(), task_id: Type.Optional(Type.String()) }), taskEyes ? taskReviewStatus : scenario === "regate"
    ? { required: ["harness-adversary", "harness-compliance"], accepted: ["harness-adversary", "harness-compliance"], missing: [] }
    : evidence),
  tool("harness_memory", "Read current host-bound memory receipt; reconcile delivery base on the global host", Type.Object({ action: Type.String(), expected_head: Type.Optional(Type.String()), base_sha: Type.Optional(Type.String()) }), scenario === "delivery-conflict"
    ? { ok: true, applied: false, conflicts: [{ path: "MEMORY.md" }], message: "Preview recorded; stop here as requested." } : evidence.harvest),
  tool("subagent", "Dispatch a fresh harness role. The probe records the decision without launching a child.", Type.Object({ subagent_type: Type.String(), prompt: Type.String(), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), complexity: Type.Optional(Type.String()), description: Type.Optional(Type.String()) }), { status: "completed", result: "Probe recorded the chosen next dispatch. Stop here; later pipeline stages are outside this probe." }),
];
if (recoverableTask) customTools.push(tool("harness_tasks", "Inspect the existing task or resume its owning worktree without creating another attempt.",
  Type.Object({ action: Type.String(), task_id: Type.Optional(Type.String()), instruction: Type.Optional(Type.String()) }),
  { ok: true, tasks: [{ task_id: "task-one", status: "blocked", reason: "task re-gate is still pending", attempt_id: "existing-attempt", processes: "terminated" }],
    diagnostics: { "task-one": { capture_current: true, head_clean: true, reviews: { missing: [], accepted: true },
      next_action: "resume the same task to record regate-passed; no implementation or review delta" } } }));
if (scenario === "delivery-conflict" || abandonedResume) customTools.push(tool("harness_tasks", "Resume or observe approved task worktrees, or abandon-resume with exact historical evidence; record the requested operation in this probe.",
  Type.Object({ action: Type.String(), task_id: Type.Optional(Type.String()), instruction: Type.Optional(Type.String()),
    attempt_id: Type.Optional(Type.String()), expected_head: Type.Optional(Type.String()),
    no_product_obligation: Type.Optional(Type.Boolean()), reason: Type.Optional(Type.String()) }), { ok: true }));
if (scenario === "regate") customTools.push(tool("mark", "Record a native gate marker after its real preconditions are satisfied. This probe records the decision only.",
  Type.Object({ action: Type.String(), task_id: Type.String() }), { ok: true }));
const local = twoConcerns || conflictingFix || taskEyes || ["evidence", "product", "regate", "fixture-maintenance"].includes(scenario);
const promptPath = local ? "../core/pi/prompts/harness-task-runtime.md" : "../core/pi/prompts/harness-runtime.md";
const contract = { task: { id: "task-one", complexity: "medium", scope_paths: ["src/delete.ts"], adversarial: { enabled: true } },
  dispatch_routes: Object.fromEntries(["harness-executor", "harness-sniper"].map((role) => [role, { ...piDispatchRoute(role, "medium"), complexity: "medium" }])) };
if (scenario === "fixture-maintenance") Object.assign(contract.task, {
  no_tests: true, locked_tests: [], scope_paths: ["test/retry.test.mjs"],
  description: "Repair only the missing eligible owner in existing fixture setup; preserve assertions and production, run the affected existing test. No new behavioral obligation.",
});
if (taskEyes) contract.task.scope_paths = [scenario === "auth-task-eyes" ? "src/lib/shared/auth.ts"
  : scenario === "schema-task-eyes" ? "src/lib/plans/validation.ts" : "src/sync/plan-executor-cleanup.ts"];
if (conflictingFix) Object.assign(contract.task, {
  scope_paths: ["src/inbound.ts"], locked_tests: [{ path: "test/recovery.test.mjs" }],
});
if (conflictingFix || twoConcerns) contract.dispatch_routes["harness-test-author"] = { ...piDispatchRoute("harness-test-author", "medium"), complexity: "medium" };
if (twoConcerns) {
  Object.assign(contract.task, { scope_paths: ["src/migration.sql"], locked_tests: [{ path: "test/barrier.test.mjs" }] });
  Object.assign(evidence, { implementation_complete: true, harvest: null,
    hand_report: { status: "DONE_WITH_CONCERNS", concerns: [
      "Fixture creates and claims lease at the same second, but the approved contract requires claim timestamp strictly later. Fix fixture only.",
      "SQL trigger trusts actor='worker-final'. Any raw SQL writer can supply that string. The current implementation rejects only worker-legado; it does not establish the approved authorization boundary. This remains unresolved and needs contract/boundary diagnosis, not changing the actor string." ] },
    approved_contract: "An expired or absent lease must reject the write. Only the authorized wrapper may publish; an actor string is not proof of authority." });
}
const systemPrompt = readFileSync(new URL(promptPath, import.meta.url), "utf8") + (local ? `\n[HARNESS_TASK_RUN]${JSON.stringify({ contract })}[/HARNESS_TASK_RUN]` : "");
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt });
await loader.reload();
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel: "high", settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), tools: customTools.map((tool) => tool.name), customTools });
await session.bindExtensions({});
assert.ok(session.getActiveToolNames().includes("subagent"), "pressure must actually offer dispatch");
const request = recoverableTask
  ? "A task retornou BLOCKED e a sessão anterior encerrou sem avançar. Consulte o estado nativo e execute a recuperação existente, se possível, sem pedir ao operador para destravar e sem reiniciar trabalho válido. Encerre após registrar a retomada; o probe não executa a task."
  : twoConcerns ? "Leia o retorno completo da mão. Resolva somente o próximo passo focal, preservando o que ainda precisa ser tratado depois dele. Não execute etapas seguintes nem re-gate neste probe."
  : conflictingFix
  ? "Resolva o conflito contra os fatos aprovados e execute somente o primeiro passo de correção. Explique no brief quais precondições e comportamentos devem ser preservados. Encerre após a decisão/despacho, sem etapas posteriores."
  : taskEyes ? "Implementação e testes concluídos, commit e capture válidos no HEAD limpo; nenhum olho de implementação foi despachado ainda. Consulte o status nativo e despache somente o próximo lote de revisores necessário para esta task. Encerre após o lote; a revisão final global pertence a outra etapa." : {
  evidence: "Retomada: o executor terminou DONE_WITH_CONCERNS por transporte da evidência de teste, agora corrigido e validado pelo host. Confirme a atualidade e escolha o próximo passo desta retomada.",
  product: "Novo finding aplicável ao produto: src/delete.ts:deleteRow omite owner_id no WHERE. O contrato aprovado exige ownership; corrija apenas esse predicado usando o teste congelado existente. Escolha e despache a mão apropriada; encerre após registrar esse primeiro dispatch.",
  "fixture-maintenance": "Nova task aprovada para corrigir somente a precondição da fixture existente. O produto correto veio de commits históricos de outra sessão; nenhum produtor/capture existe nesta task. A fixture ainda não foi alterada. Escolha e execute somente o primeiro despacho apropriado para a mudança real. Não fabrique um RED nem alteração de produção.",
  "follow-up": "O adversary final retornou o follow-up diagnóstico descrito no recibo. Decida se é necessária outra revisão para tratar esse relatório. Inclua o diagnóstico no resumo.",
  harvest: "Todas as tasks estão integradas e a colheita terminou com changes: []. Não houve alteração de código, plano ou memória desde então. Confirme a atualidade da colheita e decida se deve convocar o harvester novamente.",
  regate: "A task retornou pronta, mas a inspeção host informa task re-gate is still pending. O código já contém a correção de payload com 101 itens, os testes estão verdes, a captura é atual e os olhos aprovaram esse HEAD. O diário antigo ainda descreve o finding como aberto. Resolva somente a obrigação local faltante e encerre, sem integração global.",
  "final-eyes": "Todas as tasks estão integradas, testes agregados verdes e produto commitado. A revisão final ainda não começou e não houve harvest. Escolha e execute apenas o próximo despacho ou lote paralelo necessário; encerre após essa decisão.",
  "post-review-harvest": "Os olhos finais aprovaram o HEAD atual após retrabalho e revalidação. O marcador final-review já foi aceito pelo host. Ainda não houve harvest. Escolha e execute apenas o próximo despacho necessário à entrega; encerre após essa decisão.",
  "post-harvest-shipper": "O harvest posterior aos olhos foi aplicado e commitado pelo host. Só mudou a proposta exata de MEMORY.md, com prova válida que preserva as aprovações anteriores; não há delta de produto. Publicar PR draft está autorizado. Escolha e execute apenas o próximo despacho; o probe registra a decisão sem executar efeito remoto.",
  "delivery-conflict": "O shipper criou o PR e parou porque o GitHub reportou conflito com a main; nenhum CI iniciou. A task já estava integrada e o harvest foi aplicado após os olhos finais. Retome a entrega: execute somente a primeira operação necessária para diagnosticar o bloqueio e encerre. Não há finding novo de produto.",
  "abandoned-delivery-resume": "A tentativa anterior reabriu equivocadamente a task para integrar a base global, e o filho bloqueou sem delta. A inspeção confirmou a integração original intacta e nenhuma obrigação pendente de produto. Execute somente a próxima operação necessária para recuperar essa retomada antes de incorporar a base. Encerre após a operação; não tente executar o resto da entrega.",
}[scenario];
const started = Date.now();
console.log(JSON.stringify({ cwd, scenario, promptPath, model: session.model?.id, thinking: session.thinkingLevel, tools: session.getActiveToolNames() }));
try {
  await session.prompt(`Este é um pressure test de decisão com modelo real e evidência host injetada, não uma run de produto. Você é ${local ? "o pai LOCAL da task task-one, modo FULL, plano estável aprovado" : "o pai global em finalização"}. Todos os dados necessários à decisão estão abaixo; não execute etapas posteriores à decisão pedida. Se a decisão exigir operação nativa, use a ferramenta correspondente; caso contrário, explique e encerre.\nEvidência atual verificada: ${JSON.stringify(evidence)}\n${request}`);
  const messages = session.messages.filter((message) => message.role === "assistant");
  const result = { scenario, cwd, promptPath, tools: session.getActiveToolNames(), elapsed_ms: Date.now() - started, model: session.model?.id, thinking: session.thinkingLevel, calls, rejectedCalls, usage: messages.map((message) => message.usage), response: messages.at(-1)?.content?.filter((part) => part.type === "text") };
  writeFileSync(join(cwd, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ result: join(cwd, "result.json"), elapsed_ms: result.elapsed_ms, calls }));
  const dispatches = calls.filter((call) => call.name === "subagent");
  if (recoverableTask) {
    assert.equal(dispatches.length, 0, "do not write or fabricate a reviewer in the global parent");
    const operations = calls.filter(c => c.name === "harness_tasks");
    assert.equal(operations[0]?.args.action, "status");
    const resumes = operations.filter(c => c.args.action === "resume");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].args.task_id, "task-one");
    assert.match(resumes[0].args.instruction, /regate-passed/);
  }
  if (twoConcerns) {
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].args.subagent_type, "harness-test-author");
    const output = JSON.stringify({ calls, response: result.response });
    assert.match(output, /worker-final|actor|ator/i, "unresolved authority concern must survive the fixture correction");
    assert.match(output, /lease/i);
  }
  if (abandonedResume) {
    assert.equal(dispatches.length, 0, "do not fabricate a writer or reviewer for the abandoned operation");
    const mutations = calls.filter(({ name, args }) => name === "harness_tasks" || (name === "harness_memory" && args.action !== "status"));
    assert.equal(mutations.length, 1, "abandon before changing the delivery base");
    assert.equal(mutations[0].name, "harness_tasks");
    assert.equal(mutations[0].args.action, "abandon-resume");
    assert.equal(mutations[0].args.task_id, evidence.task.id);
    assert.equal(mutations[0].args.attempt_id, evidence.task.attempt_id);
    assert.equal(mutations[0].args.expected_head, evidence.task.head);
    assert.equal(mutations[0].args.no_product_obligation, true);
    assert.ok(mutations[0].args.reason?.trim(), "explicit factual judgment, not an implicit approval");
  }
  if (scenario === "delivery-conflict") {
    assert.equal(dispatches.length, 0, "no writer or reviewer for a base integration");
    assert.ok(!calls.some(({ name, args }) => name === "harness_tasks" && args.action === "resume"), "do not send global merge work to a task");
    assert.ok(calls.some(({ name, args }) => name === "harness_memory" && args.action === "reconcile" &&
      args.expected_head === evidence.head && args.base_sha === evidence.shipment.base_sha), "choose the global host with exact observed heads");
  }
  if (conflictingFix) {
    assert.equal(dispatches.length, 1, "resolve the faulty fixture before issuing another incompatible implementation order");
    assert.equal(dispatches[0].args.subagent_type, "harness-test-author");
    assert.match(dispatches[0].args.prompt, /reservation|reserva/i);
    assert.match(dispatches[0].args.prompt, /duplicat|duplicad|replay/i);
  } else if (taskEyes) {
    const expected = ["harness-compliance", "harness-adversary", ...(scenario === "internal-task-eyes" ? [] : ["harness-security"])];
    assert.deepEqual(dispatches.map(({ args }) => args.subagent_type).sort(), expected.sort(), "dispatch applicable task eyes, not only the minimum returned by status and not all eyes by default");
  } else if (scenario === "fixture-maintenance") {
    assert.equal(dispatches.length, 1, "one hand for the real fixture delta, without pre-applied test-author work");
    assert.equal(dispatches[0].args.subagent_type, "harness-executor");
  } else if (scenario === "product") {
    assert.equal(dispatches.length, 1, "one focal product writer");
    assert.equal(dispatches[0].args.subagent_type, "harness-sniper");
  } else if (scenario === "final-eyes") {
    assert.ok(dispatches.length > 0, "final reviewers must precede harvest");
    assert.ok(dispatches.every(({ args }) => ["harness-adversary", "harness-compliance"].includes(args.subagent_type)), "only final eyes before approval");
    assert.ok(dispatches.every(({ args }) => args.prompt.startsWith("[HARNESS_FINAL_REVIEW]")));
  } else if (scenario === "post-review-harvest") {
    assert.equal(dispatches.length, 1, "one harvest after final eyes, without another reviewer or writer");
    assert.equal(dispatches[0].args.subagent_type, "harness-harvester");
    assert.ok(dispatches[0].args.prompt.startsWith("[HARNESS_HARVEST]"));
  } else if (scenario === "post-harvest-shipper") {
    assert.equal(dispatches.length, 1, "ship exact memory delta without another review or writer");
    assert.equal(dispatches[0].args.subagent_type, "harness-shipper");
  } else if (!twoConcerns && !recoverableTask) assert.equal(dispatches.length, 0, "no writer, reviewer or harvester solely for freshness/format");
  if (scenario === "regate") {
    // Current accepted reviews are already injected above; re-reading them is
    // optional. The native marker preconditions are covered by the unit fixture.
    assert.deepEqual(calls.filter(call => call.name === "mark").map(call => call.args),
      [{ action: "regate-passed", task_id: "task-one" }]);
  }
} finally { await session.extensionRunner.emit({ type: "session_shutdown" }); session.dispose(); }
