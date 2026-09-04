import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const promptPath = fileURLToPath(new URL("./harness-runtime.md", import.meta.url));
const sniperPath = fileURLToPath(new URL("../runtime/agents/harness-sniper.md", import.meta.url));

test("parent orchestration stays local and dispatches only canonical harness roles", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /agente principal faz triagem/i);
  assert.match(prompt, /não escreve, edita nem commita produto/i);
  assert.match(prompt, /adversary.*planner.*plan-reviewer.*shipper.*harvester/is);
  assert.match(prompt, /harness_spec_write.*harness-adversary.*seal_spec_review.*mark.*brainstormed.*planner/is);
  assert.match(prompt, /Nunca reutilize uma spec de sessão anterior/i);
  assert.match(prompt, /funciona igual no TUI e headless/i);
  assert.match(prompt, /harness-planner/);
  assert.match(prompt, /harness_plan/);
  assert.match(prompt, /validação própria/);
  assert.match(prompt, /harness-executor/);
  assert.match(prompt, /harness-test-author.*, `harness-executor` ou `harness-sniper`/is);
  assert.match(prompt, /primeira linha de `prompt` deve ser exatamente `\[HARNESS_TASK_CONTEXT\]\{\"task_id\":\"<id da tarefa canônica>\"\}\[\/HARNESS_TASK_CONTEXT\]`/i);
  assert.match(prompt, /Não use uma frase informal como `Task/i);
  assert.match(prompt, /max_turns.*ausente.*144 turns/is);
  assert.match(prompt, /Ao fim de \*\*todo\*\* despacho de planner.*leia o plano canônico/is);
  assert.match(prompt, /plan-reviewer.*REVISE/is);
  assert.doesNotMatch(prompt, /Delegue somente aos agentes `harness-\*`/);
});

test("o prompt fornece ids literais de modelo para todo despacho", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /harness-planner.*openai-codex\/gpt-5\.6-sol.*high/is);
  assert.match(prompt, /harness-plan-reviewer.*openai-codex\/gpt-6-astra.*high/is);
  assert.doesNotMatch(prompt, /`harness-plan-reviewer`\s*=\s*`openai-codex\/gpt-5\.6-sol`/);
  assert.match(prompt, /harness-adversary.*openai-codex\/gpt-5\.6-sol.*medium/is);
  assert.match(prompt, /harness-test-author.*openai-codex\/gpt-5\.6-terra.*high/is);
  assert.match(prompt, /incluindo `harness-test-author`, inclua também o campo estruturado de topo `complexity`/i);
  assert.match(prompt, /harness-executor.*low.*openai-codex\/gpt-5\.6-luna.*high/is);
});

test("o prompt descreve os rails que existem e não promete sandbox", () => {
  const prompt = readFileSync(promptPath, "utf8");

  // A frase antiga era falsa depois do porte: há, sim, negação por ferramenta.
  assert.doesNotMatch(prompt, /não existe aprovação por ferramenta/i);
  assert.match(prompt, /rails determinísticos/i);
  assert.match(prompt, /gh pr merge/);
  assert.match(prompt, /harness:ready/);
  assert.match(prompt, /\.pi\/harness\/state\//);
  assert.match(prompt, /lavish-axi/);
  assert.match(prompt, /não sandbox|não é sandbox/i);
  assert.match(prompt, /execution-plan\.json/);
  assert.match(prompt, /cada.*tarefa.*plano canônico/is);
  assert.match(prompt, /um comando de leitura por chamada/i);
  assert.match(prompt, /sem `&&`.*pipes.*redirecionamentos/is);
  assert.match(prompt, /`npm test`.*não use `npx`/i);
  assert.match(prompt, /HARNESS_FINAL_REVIEW.*compliance.*adversary.*serialmente/is);
});

test("o prompt exige vermelho executável antes do fidelity-pass", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /vermelho executável/i);
  assert.match(prompt, /dependência.*ausente|runner.*ausente/i);
  assert.match(prompt, /fidelity-pass/i);
  assert.match(prompt, /compliance.*fidelity.*capture-verified/is);
});

test("o prompt obriga o orquestrador a tratar achados de olhos sem criar burocracia artificial", () => {
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /adversary, security e compliance.*antes de avançar/is);
  assert.match(prompt, /não descarte achado em silêncio/i);
  assert.match(prompt, /não transforme sugestões de baixo impacto em burocracia automática/i);
});

test("REVISE do plano replaneja com evidência do pai, sem retomar filho", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /plan-reviewer.*REVISE.*leia.*relatório/i);
  assert.match(prompt, /comandos de leitura.*solicitados.*novo.*harness-planner/is);
  assert.match(prompt, /\[HARNESS_PLAN_REVIEW_CONTEXT\]/);
  assert.match(prompt, /novo.*harness-planner.*nunca `resume`/i);
});

test("retomada do pai só aceita envelope validado e não revive filhos", () => {
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /HARNESS_PARENT_RECOVERY/);
  assert.match(prompt, /mesma sessão pai.*mesma worktree/is);
  assert.match(prompt, /não repita.*triagem.*spec.*planner.*plan-reviewer/is);
  assert.match(prompt, /legacy-plan-reviewer-sol.*planner.*model_strategy\.plan-reviewer.*Astra.*nova hash/is);
  assert.match(prompt, /nunca use `resume` em uma role do harness/i);
});

test("o pedido explícito de autonomia nunca fica esperando uma escolha humana", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /pedido explícito de execução autônoma.*não pare para perguntar/i);
  assert.match(prompt, /ambiguidade de produto não bloqueante/i);
  assert.match(prompt, /menor caminho defensável, seguro e reversível/i);
  assert.match(prompt, /sem ampliar escopo/i);
  assert.match(prompt, /registre a suposição.*resolved_judgments.*PR draft/is);
  assert.match(prompt, /autorização.*segredo.*efeito externo irreversível.*migração.*financeira.*segurança/is);
  assert.doesNotMatch(prompt, /quando exigir decisão, pare e peça direção/i);
});

test("revisão adversarial por tarefa é serial e identifica a tarefa canônica", () => {
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /adversary.*pós-implementação.*HARNESS_TASK_CONTEXT/is);
  assert.match(prompt, /serialmente.*nunca no mesmo lote.*compliance.*security/is);
  assert.match(prompt, /re-gate.*adversary.*mesmo HEAD/is);
});

test("achado tardio que pede nova cobertura volta ao autor de testes, não ao sniper", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const sniper = readFileSync(sniperPath, "utf8");

  assert.match(prompt, /achado.*novo.*teste.*congelado.*harness-test-author.*fidelity/is);
  assert.match(sniper, /never edit.*frozen acceptance test/i);
  assert.match(sniper, /return.*parent.*harness-test-author/is);
});
