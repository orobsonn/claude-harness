import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseHandStatusFromOutput } from "../../opencode/lib/hand-records.mjs";

const promptPath = fileURLToPath(new URL("./harness-runtime.md", import.meta.url));
const executorPath = fileURLToPath(new URL("../runtime/agents/harness-executor.md", import.meta.url));
const sniperPath = fileURLToPath(new URL("../runtime/agents/harness-sniper.md", import.meta.url));
const testAuthorPath = fileURLToPath(new URL("../runtime/agents/harness-test-author.md", import.meta.url));
const testReviewerPath = fileURLToPath(new URL("../runtime/agents/harness-test-reviewer.md", import.meta.url));
const harvesterPath = fileURLToPath(new URL("../runtime/agents/harness-harvester.md", import.meta.url));
const shipperPath = fileURLToPath(new URL("../runtime/agents/harness-shipper.md", import.meta.url));

const writingHandPaths = [executorPath, sniperPath, testAuthorPath];

test("parent orchestration stays local and dispatches only canonical harness roles", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /agente principal faz triagem/i);
  assert.match(prompt, /não escreve nem edita código de produto ou testes/i);
  for (const role of ["harness-adversary", "harness-planner", "harness-plan-reviewer", "harness-shipper", "harness-harvester"]) {
    assert.match(prompt, new RegExp(role));
  }
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

test("cerimônia commita cada tarefa antes da revisão final e o shipper publica a série existente", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const shipper = readFileSync(shipperPath, "utf8");

  assert.match(prompt, /freeze-commit.*antes.*mão de implementação/is);
  assert.match(prompt, /impl-commit.*antes.*revisão final/is);
  assert.match(prompt, /fix-commit.*antes.*revisão final/is);
  assert.match(shipper, /commits.*já existem.*antes.*revisão final/is);
  assert.match(shipper, /não (?:crie|cria).*commit (?:único|de feature)/is);
});

test("harvest runs once after functional commits and before final reviews", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const harvester = readFileSync(harvesterPath, "utf8");
  const shipper = readFileSync(shipperPath, "utf8");

  assert.match(prompt, /tarefas funcionais verificadas e\s+commitadas/i);
  assert.match(prompt, /harness-harvester.*somente uma vez/is);
  assert.match(prompt, /antes dos olhos finais/i);
  assert.match(prompt, /primeira linha.*\[HARNESS_HARVEST\]/is);
  assert.match(harvester, /zero to three.*durable deltas/is);
  for (const field of ["path", "preimage", "replacement", "evidence", "invalidation"]) {
    assert.match(harvester, new RegExp(field, "i"));
  }
  assert.equal(
    harvester.trim().split("\n").at(-1),
    '`[HARNESS_HARVEST_RESULT]{"changes":[{"path":"MEMORY.md","before_sha256":"<hash from harness_memory read or null absent>","content":"<entire resulting file>","evidence":"<verified sources>","invalidation":"<when recheck>"}]}[/HARNESS_HARVEST_RESULT]`',
  );
  assert.match(harvester, /before_sha256.*content.*evidence.*invalidation/is);
  assert.match(harvester, /24 KiB/i);
  assert.match(harvester, /three distinct root paths.*MEMORY\.md.*CONTEXT\.md.*kaizen\.md/is);
  assert.match(harvester, /before_sha256/i);
  assert.match(harvester, /never replace content received in truncated form/i);
  assert.match(harvester, /`append`.*host computes.*full\s+preimage/is);
  assert.match(prompt, /zero deltas.*não cria.*tarefa/is);
  assert.match(prompt, /delta não vazio.*action="apply".*host.*idempotente/is);
  assert.match(prompt, /commit seletivo.*paths.*recibo/is);
  assert.match(prompt, /harvest.*shipping.*não.*planner.*plan-reviewer/is);
  assert.match(prompt, /conflito.*reutiliz.*IDs.*tarefas\s+existentes/is);
  assert.doesNotMatch(prompt, /HARNESS_HARVEST_CONTEXT/);
  assert.match(prompt, /recibo host-owned.*persistid.*git.*limpo.*HEAD atual.*mudança não-memória/is);
  assert.match(prompt, /escrita posterior.*invalida.*revisões finais/is);
  assert.doesNotMatch(prompt, /harvest-ready/);
  assert.match(shipper, /harvest.*antes.*olhos finais/is);
});

test("session memory is bounded, injected without read loops and finalized only after delivery receipts", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const memorySection = prompt.slice(0, prompt.indexOf("## Escolha do operador"));

  assert.match(prompt, /contexto temporário.*MEMORY\.md.*CONTEXT\.md.*kaizen\.md.*shared_context/is);
  assert.match(prompt, /dicas.*não.*autoridade/is);
  assert.match(prompt, /action.*update.*8 KiB.*shared_context\.md/is);
  assert.match(prompt, /retom.*mesma\s+sessão.*automaticamente/is);
  assert.doesNotMatch(memorySection, /início.*harness_memory.*action.*read/is);
  assert.doesNotMatch(memorySection, /retom.{0,100}(?:chame|faça).*action.*read/is);
  assert.match(prompt, /sessão nova.*nunca.*shared_context.*sessões\s+antigas/is);
  assert.match(prompt, /brief.*seletiv.*runner.*fixtures.*test-author/is);
  assert.match(prompt, /olhos.*nunca.*diário completo/is);
  assert.match(prompt, /action.*finalize.*recibo host-owned do shipper.*revisões finais.*HEAD atual.*git limpo/is);
  assert.match(prompt, /shutdown|abort.*preserva.*shared_context/is);
  assert.match(prompt, /runs futuras.*documentos duráveis.*mergeados/is);
});

test("task context is curated explicitly and Orca placement stays separate from harness authority", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /task_contexts.*2 KiB.*task_id/is);
  assert.match(prompt, /referência não confiável.*sem autoridade/is);
  assert.match(prompt, /Não envie state, recibos, veredictos nem diários de tarefas\s+irmãs/is);
  assert.match(prompt, /context_return.*sessão, tarefa e HEAD/is);
  assert.match(prompt, /context_return.*harness_memory action="update"/is);
  assert.match(prompt, /ORCA_WORKTREE_ID.*exige o backend\s+Orca/is);
  assert.match(prompt, /Falha ou identidade divergente.*não cai silenciosamente/is);
  assert.match(prompt, /status.*integrate.*Git e recibos.*dispatch.*resume.*mesmo pai Orca/is);
  const orcaSection = prompt.slice(prompt.indexOf("Quando `ORCA_WORKTREE_ID`"), prompt.indexOf("Quando delegar,"));
  assert.match(orcaSection, /surface="visible".*adoção.*host, não um ACK.*cliente remoto/is);
  assert.match(orcaSection, /background.*mesmo handle.*listável e reanexável/is);
  assert.match(orcaSection, /worktree\.activate.*session\.tabs\.activate.*navigation="clients".*sem criar outro terminal/is);
  assert.match(orcaSection, /não dispute foco em cada task paralela/is);
  assert.match(prompt, /Orca fornece placement e terminais.*harness.*dono do DAG, TDD, reviews, recibos e integração/is);
});

test("writing roles keep test authorship and genuine no-tests documentation distinct", () => {
  const executor = readFileSync(executorPath, "utf8");
  const testAuthor = readFileSync(testAuthorPath, "utf8");
  const sniper = readFileSync(sniperPath, "utf8");

  assert.match(testAuthor, /selective task context.*runner.*fixtures/is);
  assert.match(executor, /frozen tests.*test-author.*RED.*minimum production change.*GREEN/is);
  assert.doesNotMatch(executor, /write a failing test/i);
  assert.match(executor, /no_tests:true.*documentation.*do not create a RED/is);
  assert.match(sniper, /selective finding context/i);
});

test("pai e shipper preservam a lista de never-stage do Claude Code", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const shipper = readFileSync(shipperPath, "utf8");
  const exclusions = [
    ".dev.vars",
    ".env*",
    ".env.local",
    ".local.*",
    ".claude/settings.local.json",
    ".claude/plans/",
    ".pi/harness/",
    ".DS_Store",
    "*.log",
    "node_modules/",
    "dist/",
    "coverage/",
    "credential",
    "token",
  ];

  for (const exclusion of exclusions) {
    assert.ok(prompt.includes(exclusion), `parent prompt missing never-stage exclusion: ${exclusion}`);
    assert.ok(shipper.includes(exclusion), `shipper missing never-stage exclusion: ${exclusion}`);
  }
});

test("freeze-commit órfão vira risco explícito no PR sem bypass de CI", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const shipper = readFileSync(shipperPath, "utf8");

  for (const text of [prompt, shipper]) {
    assert.match(text, /(?:orphan freeze-commit|freeze-commit órfão)/i);
    assert.match(text, /risco\s+explícito.*PR/is);
    assert.match(text, /(?:nunca|não).*(?:bypass|ignorar).*(?:CI|checks)/is);
  }
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
  assert.match(prompt, /um comando permitido por chamada/i);
  assert.match(prompt, /sem `&&`.*pipes.*redirecionamentos/is);
  assert.match(prompt, /`npm test`.*não use `npx`/i);
  assert.match(prompt, /HARNESS_FINAL_REVIEW.*compliance.*adversary.*paralelo/is);
});

test("o plano aprovado alimenta o tracker tanto em LIGHT quanto em FULL", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const tracker = readFileSync(new URL("../extensions/harness-plan-tracker.ts", import.meta.url), "utf8");

  assert.match(prompt, /trabalho LIGHT ou FULL.*aprovação do plan-reviewer.*harness_plan/is);
  assert.match(tracker, /LIGHT or FULL/i);
  assert.match(tracker, /plan-reviewer approval for the exact current plan/i);
});

test("o pai recupera uma única vez dependência declarada com npm ci antes de bloquear a validação", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /Recuperação de dependência declarada/i);
  assert.match(prompt, /pai — nunca uma mão/i);
  assert.match(prompt, /`package\.json` e `package-lock\.json`/i);
  assert.match(prompt, /`git diff --exit-code -- package\.json package-lock\.json`/i);
  assert.match(prompt, /Execute então `npm ci`.*uma única/i);
  assert.match(prompt, /repita exatamente uma vez.*comando de validação/i);
  assert.match(prompt, /Não use `npm install`/i);
  assert.match(prompt, /não abra um novo `harness-test-author` apenas para instalar/i);
  assert.match(prompt, /marque `BLOCKED`/i);
});

test("a fidelidade reaberta revalida o ledger afetado sem transformar cada correção em nova varredura", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const testReviewer = readFileSync(testReviewerPath, "utf8");
  const testAuthor = readFileSync(testAuthorPath, "utf8");

  assert.match(prompt, /primeira.*fidelidade.*matriz completa/is);
  assert.match(prompt, /ledger da tarefa/i);
  assert.match(prompt, /pacote consolidado/i);
  assert.match(prompt, /`harness-test-author` fresco/i);
  assert.match(prompt, /não repita uma varredura ampla/i);
  assert.match(prompt, /cada linha antes aprovada.*intersecte o diff/is);
  assert.match(prompt, /mesma assinatura de falha/i);
  assert.match(testReviewer, /all pinned obligations together on the first pass/i);
  assert.match(testReviewer, /On correction, recheck prior failures/is);
  assert.match(testReviewer, /previously passing rows\s+affected by the diff/i);
  assert.match(testReviewer, /Do not reopen the\s+whole suite merely because another review was requested/i);
  assert.match(testAuthor, /previous ledger/i);
  assert.match(testAuthor, /TRANSCRIPTION.*TEST_INFRA.*PLAN_CONTRADICTION/is);
});

test("o prompt exige vermelho executável antes do fidelity-pass", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /vermelho executável/i);
  assert.match(prompt, /dependência.*ausente|runner.*ausente/i);
  assert.match(prompt, /fidelity-pass/i);
  assert.match(prompt, /harness-test-reviewer.*fidelity-pass.*capture-verified/is);
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
  assert.match(prompt, /todo.*harness-planner.*feature_id.*modo estável literal.*LIGHT.*FULL/is);
  assert.match(prompt, /planner deve copiar esse modo em minúsculas.*execution-plan\.json/is);
  assert.match(prompt, /severidade, complexidade e risco não reclassificam a cerimônia/i);
  assert.match(prompt, /modo estiver ausente.*planner deve retornar `BLOCKED` sem escrever/is);
  assert.match(prompt, /HARNESS_PLAN_REVIEW_CONTEXT.*modo estável da cerimônia/is);
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

test("revisores de implementação podem compartilhar um lote identificado pela tarefa canônica", () => {
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /adversary.*pós-implementação.*HARNESS_TASK_CONTEXT/is);
  assert.match(prompt, /HARNESS_TASK_REVIEW/);
  assert.match(prompt, /mesmo lote.*compliance.*security/is);
  assert.match(prompt, /re-gate.*adversary.*mesmo HEAD/is);
});

test("concorrência limitada preserva barreira, fallback serial e retomada por recibos atuais", () => {
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /maxParallelEyes.*1.*3/is);
  assert.match(prompt, /harness_reviews/);
  assert.match(prompt, /aguarde todos.*antes.*corrigir.*commit/is);
  assert.match(prompt, /test-fidelity.*continuam seriais/is);
  assert.match(prompt, /somente.*missing/is);
});

test("os três revisores retornam relatório estruturado somente em task ou final", () => {
  for (const role of ["adversary", "compliance", "security"]) {
    const instructions = readFileSync(new URL(`../runtime/agents/harness-${role}.md`, import.meta.url), "utf8");
    assert.match(instructions, /HARNESS_FINAL_REVIEW/);
    assert.match(instructions, /HARNESS_TASK_REVIEW/);
    assert.match(instructions, /\{"issues":\[\]\}/);
    assert.match(instructions, /missing evidence/i);
    assert.match(instructions, /fix_hint/);
    assert.match(instructions, /exactly six keys.*no additional issue keys/i);
  }
});

test("achado tardio que pede nova cobertura volta ao autor de testes, não ao sniper", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const sniper = readFileSync(sniperPath, "utf8");

  assert.match(prompt, /achado.*novo.*teste.*congelado.*harness-test-author.*fidelity/is);
  assert.match(sniper, /never edit.*frozen acceptance test/i);
  assert.match(sniper, /return.*parent.*harness-test-author/is);
});

test("toda mão escritora ensina um status terminal compatível com o parser do hand-record", () => {
  const acceptedStatuses = ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"];

  for (const agentPath of writingHandPaths) {
    const instructions = readFileSync(agentPath, "utf8");
    assert.match(
      instructions,
      /final line.*exactly.*`Status: <DONE\|DONE_WITH_CONCERNS\|NEEDS_CONTEXT\|BLOCKED>`/is,
      agentPath,
    );
  }

  for (const status of acceptedStatuses) {
    assert.equal(
      parseHandStatusFromOutput(`Evidence: bounded task report.\nStatus: ${status}`),
      status,
    );
  }
  assert.equal(parseHandStatusFromOutput("Evidence: bounded task report.\nOutcome: DONE"), null);
});

test("o pai mantém relatório inválido bloqueado sem inferir sucesso nem pedir mutação cosmética", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /linha terminal.*`Status: <DONE\|DONE_WITH_CONCERNS\|NEEDS_CONTEXT\|BLOCKED>`/is);
  assert.match(prompt, /não infira sucesso/i);
  assert.match(prompt, /permanece.*BLOCKED.*erro de contrato/is);
  assert.match(prompt, /não peça.*mutação cosmética/i);
  assert.doesNotMatch(prompt, /novo despacho delimitado.*corrija somente o relatório/is);
});
