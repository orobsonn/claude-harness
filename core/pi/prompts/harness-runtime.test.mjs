import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseHandStatusFromOutput } from "../../opencode/lib/hand-records.mjs";

const promptPath = fileURLToPath(new URL("./harness-runtime.md", import.meta.url));
const taskPromptPath = fileURLToPath(new URL("./harness-task-runtime.md", import.meta.url));
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

test("task and host explicitly close pending re-gate without repeating accepted work", () => {
  const local = readFileSync(taskPromptPath, "utf8");
  const host = readFileSync(promptPath, "utf8");
  assert.match(local, /missing=\[\].*não registra\s+`regate-passed`/s);
  assert.match(local, /action="regate-passed".*sem fornecer SHA.*ok=true/s);
  assert.match(local, /não repita\s+mãos ou revisões aceitas/);
  assert.match(host, /diário pode estar\s+desatualizado/);
  assert.match(host, /consulta na sessão global não substitui os recibos da filha/);
});

test("spec seal follows its native adversary marker", () => {
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /Depois de tratar o relatório,.*mark.*adversary_fired.*seal_spec_review/);
});

test("shipper waits for the explicit PR with bounded CI observation", () => {
  const shipper = readFileSync(shipperPath, "utf8");
  assert.match(shipper, /gh pr checks <PR> --watch --interval 30/);
  assert.match(shipper, /timeout.*maior.*CI observado/is);
  assert.match(shipper, /no máximo um retry.*checks.*publicados/is);
  assert.match(shipper, /Não faça polling aberto/);
  assert.match(shipper, /não usa Release Please.*não.*PR de release/is);
});

test("release manual follows Claude changelog rotation before merge and does not reopen product tasks", () => {
  const shipper = readFileSync(shipperPath, "utf8");
  assert.match(shipper, /Antes de preparar a branch de release.*`git fetch origin`.*merge funcional confirmado/is);
  assert.match(shipper, /Antes de abrir\/mergear.*PR.*confira.*diff/is);
  assert.match(shipper, /mova o conteúdo de `## \[Unreleased\]`.*`## \[X.Y.Z\] - YYYY-MM-DD`/s);
  assert.match(shipper, /não peça repetição.*tasks funcionais.*metadados/is);
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

test("harvest runs once after final eyes and rework, before shipper", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const harvester = readFileSync(harvesterPath, "utf8");
  const shipper = readFileSync(shipperPath, "utf8");

  assert.match(prompt, /tarefas funcionais verificadas e\s+commitadas/i);
  assert.match(prompt, /harness-harvester.*somente uma vez/is);
  assert.match(prompt, /Colheita durável — depois dos olhos finais/i);
  assert.match(prompt, /retrabalho e a revalidação.*mark action="final-review"/is);
  assert.match(harvester, /after final reviewers approve.*corrections and revalidation.*before shipper/is);
  assert.match(prompt, /primeira linha.*\[HARNESS_HARVEST\]/is);
  assert.match(harvester, /zero to three.*durable deltas/is);
  for (const field of ["path", "preimage", "replacement", "evidence", "invalidation"]) {
    assert.match(harvester, new RegExp(field, "i"));
  }
  assert.equal(
    harvester.trim().split("\n").at(-1),
    '`[HARNESS_HARVEST_RESULT]{"changes":[{"path":"MEMORY.md","before_sha256":"<current hash or null absent>","append":"<small new entry>","evidence":"<verified sources>","invalidation":"<when recheck>"}]}[/HARNESS_HARVEST_RESULT]`',
  );
  assert.match(harvester, /before_sha256.*content.*evidence.*invalidation/is);
  assert.match(harvester, /24 KiB/i);
  assert.match(harvester, /three distinct root paths.*MEMORY\.md.*CONTEXT\.md.*kaizen\.md/is);
  assert.match(harvester, /before_sha256/i);
  assert.match(harvester, /Full replacement.*always forbidden/is);
  assert.match(harvester, /`append`.*host computes.*full\s+preimage/is);
  assert.match(harvester, /8 KiB/);
  assert.match(prompt, /recibo válido.*reutilize.*changes: \[\]/is);
  assert.match(prompt, /resultado intermediário.*não prova.*conteúdo persistido.*blob commitado.*HEAD atual/is);
  assert.match(prompt, /documentos duráveis após `finalize`.*colheita corretiva.*tombstone.*não repita\s+olhos do produto/is);
  assert.match(prompt, /zero deltas.*não cria.*tarefa/is);
  assert.match(prompt, /delta não vazio.*action="apply".*host.*idempotente/is);
  assert.match(prompt, /commit seletivo.*paths.*recibo/is);
  assert.match(prompt, /harvest.*shipping.*não.*planner.*plan-reviewer/is);
  assert.match(prompt, /conflito.*reutiliz.*IDs.*tarefas\s+existentes/is);
  assert.match(prompt, /pai global.*harness_memory action="reconcile"/is);
  assert.match(prompt, /Não use\s+`harness_tasks resume`.*incorporar `main`/is);
  assert.match(shipper, /harness_memory reconcile/);
  assert.doesNotMatch(prompt, /HARNESS_HARVEST_CONTEXT/);
  assert.match(prompt, /recibo host-owned.*persistid.*git.*limpo.*HEAD atual.*mudança não-memória/is);
  assert.match(prompt, /escrita posterior.*invalida.*revisões finais/is);
  assert.doesNotMatch(prompt, /harvest-ready/);
  assert.match(shipper, /harvest ocorre depois dos olhos finais.*antes do shipper/is);
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

test("new fixture maintenance uses canonical no_tests and a real executor delta, not recovery lineage", () => {
  const planner = readFileSync(new URL("../runtime/agents/harness-planner.md", import.meta.url), "utf8");
  const executor = readFileSync(executorPath, "utf8");
  const task = readFileSync(new URL("./harness-task-runtime.md", import.meta.url), "utf8");
  assert.match(planner, /existing test.fixture maintenance.*no_tests: true/is);
  assert.match(planner, /preserve.*assertions.*existing.*tests/is);
  assert.match(executor, /fixture maintenance.*real.*delta/is);
  assert.match(task, /no_tests:true.*locked_tests.*executor/is);
  assert.match(task, /sessão nova.*não herda.*linhagem/is);
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
  assert.match(prompt, /`harness-compliance`\s*=\s*`openai-codex\/gpt-5\.6-terra`\s*\+\s*`high`/);
  assert.match(prompt, /`harness-test-reviewer`\s*=\s*`openai-codex\/gpt-5\.6-luna`\s*\+\s*`xhigh`/);
  assert.doesNotMatch(prompt, /`harness-test-reviewer`\s*=\s*`openai-codex\/gpt-5\.6-terra`/);
  assert.match(prompt, /harness-test-author.*openai-codex\/gpt-5\.6-terra.*high/is);
  assert.match(prompt, /high \(e max legado\) usa\s*`openai-codex\/gpt-5\.6-sol`\s*\+\s*`high`/i);
  assert.match(prompt, /complexity.*omitida.*host\s*herda/is);
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

test("o pai global e o pai local recuperam dependência declarada com npm ci antes de bloquear a validação", () => {
  for (const file of [promptPath, taskPromptPath]) {
  const prompt = readFileSync(file, "utf8");

  assert.match(prompt, /Recuperação de dependência declarada/i);
  assert.match(prompt, /pai — nunca uma mão/i);
  assert.match(prompt, /`package\.json` e `package-lock\.json`/i);
  assert.match(prompt, /`git diff --exit-code -- package\.json package-lock\.json`/i);
  assert.match(prompt, /Execute então `npm ci`.*uma única/i);
  assert.match(prompt, /repita exatamente uma vez.*comando de validação/i);
  assert.match(prompt, /Não use `npm install`/i);
  assert.match(prompt, /não abra um novo `harness-test-author` apenas para instalar/i);
  assert.match(prompt, /marque `BLOCKED`/i);
  }
});

test("a fidelidade segue o contrato aprovado sem burocracia por rodada", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const taskPrompt = readFileSync(taskPromptPath, "utf8");
  const testReviewer = readFileSync(testReviewerPath, "utf8");
  const testAuthor = readFileSync(testAuthorPath, "utf8");

  assert.match(prompt, /pacote consolidado/i);
  assert.match(prompt, /`harness-test-author` fresco/i);
  assert.match(prompt, /não repita uma varredura ampla/i);
  assert.match(testReviewer, /Given\/When\/Then/);
  assert.match(testReviewer, /On correction, recheck.*affected/is);
  assert.match(testReviewer, /Do not emit a verdict.*turn.*requests tools.*provisional/is);
  assert.match(testReviewer, /last assistant response.*review receipt/is);
  assert.match(testReviewer, /repeat.*authoritative verdict.*final response/is);
  assert.match(taskPrompt, /ferramentas primeiro.*resposta final.*Verdict: APPROVE\|REVISE\|BLOCKED/is);
  assert.match(taskPrompt, /não.*comece exatamente.*sem qualificar.*resposta final/is);
  assert.match(taskPrompt, /nunca infira.*APPROVE.*nenhum finding.*verdict provisório/is);
  assert.doesNotMatch(testReviewer, /require the\s+complete prior ledger|preserve every prior row|separate counterexample.*every internal decision/is);
  assert.doesNotMatch(testAuthor, /resolution map for every supplied finding ID and affected PASS/i);
  assert.doesNotMatch(taskPrompt, /ledger factual completo|ledger completo anterior|retorno\s+do test-author deve mapear cada finding e cada PASS/is);
  assert.match(testAuthor, /TRANSCRIPTION.*TEST_INFRA.*PLAN_CONTRADICTION/is);
});

test("o pai local preserva autoridade e só reabre autoria por defeito no contrato de teste", () => {
  const taskPrompt = readFileSync(taskPromptPath, "utf8");
  const testAuthor = readFileSync(testAuthorPath, "utf8");

  assert.match(taskPrompt, /test-author só pode alterar paths literais.*locked_tests.*fixture_paths/is);
  assert.match(taskPrompt, /Nunca peça novamente.*path.*gate já recusou/is);
  assert.match(testAuthor, /path present only in `scope_paths` is not\s+test-author authority/is);
  assert.match(taskPrompt, /Findings de produto seguem diretamente ao sniper, preservando a fidelidade/i);
  assert.match(taskPrompt, /Reabra.*harness-test-author.*somente.*teste\/fixture congelado estiver incorreto.*contrato aprovado mudar.*observável aprovado estiver concretamente sem cobertura/is);
  assert.doesNotMatch(taskPrompt, /Defeito real sem cobertura: autor acrescenta|nunca use um sniper exploratório/i);
});

test("fidelidade resolve bloqueio de evidência sem repetir mão ou comando válido", () => {
  const taskPrompt = readFileSync(taskPromptPath, "utf8");
  const testReviewer = readFileSync(testReviewerPath, "utf8");

  assert.match(taskPrompt, /BLOCKED.*somente.*evidência.*não abra test-author.*reexecute/is);
  assert.match(taskPrompt, /resume.*proibido.*revalidação nova e compacta/is);
  assert.match(taskPrompt, /evidência atual nomeada/is);
  assert.match(testReviewer, /BLOCKED.*missing current evidence/i);
});

test("olhos pós-implementação revalidam a correção sem rituais de findings", () => {
  const taskPrompt = readFileSync(taskPromptPath, "utf8");

  assert.match(taskPrompt, /adversary.*compliance.*security.*lote consolidado/is);
  assert.match(taskPrompt, /positivo ancestral por task.*manter satisfeita a obrigação.*não certifica o novo HEAD/is);
  assert.match(taskPrompt, /revalide o olho que o produziu e somente outros olhos\s+cuja obrigação ou trigger explícito foi afetado/is);
  assert.doesNotMatch(taskPrompt, /repita todos os\s+olhos já ativados/is);
  for (const role of ["adversary", "compliance", "security"]) {
    const instructions = readFileSync(new URL(`../runtime/agents/harness-${role}.md`, import.meta.url), "utf8");
    assert.doesNotMatch(instructions, /stable finding ID|LATE_FINDING|equivalence class|incomplete inspection, or an unresolved concern/i, role);
    assert.match(instructions, /re-gate.*correction.*affected/is, role);
  }
});

test("o prompt exige vermelho executável antes do fidelity-pass", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /vermelho executável/i);
  assert.match(prompt, /dependência.*ausente|runner.*ausente/i);
  assert.match(prompt, /fidelity-pass/i);
  assert.match(prompt, /harness-test-reviewer.*fidelity-pass.*capture-verified/is);
  assert.match(prompt, /\[HARNESS_CANONICAL_TASK\].*plano estável.*nunca substitui nem resume/is);
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

test("erro estrutural do plano volta ao planner antes de qualquer reviewer", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /plano.*inválido.*lista exata.*erros.*novo.*harness-planner/is);
  assert.match(prompt, /não despache.*plan-reviewer.*plano.*validar/is);
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
  assert.match(prompt, /Em LIGHT, não despache olhos de implementação por tarefa/);
  assert.match(prompt, /Em FULL, despache compliance, adversary somente quando `task.adversarial.enabled` for `true`/);
  assert.match(prompt, /re-gate.*regate-passed.*papéis em `missing`.*olho que produziu o finding.*saudáveis no HEAD da correção.*irmãos já aceitos/is);
  assert.doesNotMatch(prompt, /Depois de cada mão de implementação, faça a revisão adversarial|após esse adversary concluir saudável/);
});

test("concorrência limitada preserva barreira, fallback serial e retomada por recibos atuais", () => {
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /maxParallelEyes.*1.*3/is);
  assert.match(prompt, /harness_reviews/);
  assert.match(prompt, /aguarde todos.*antes.*corrigir.*commit/is);
  assert.match(prompt, /test-fidelity.*continuam seriais/is);
  assert.match(prompt, /somente.*missing/is);
  for (const source of [prompt, readFileSync(taskPromptPath, "utf8")]) {
    assert.match(source, /`missing` são obrigações ainda não satisfeitas, inclusive por negativo ou despacho\s+posterior/);
    assert.match(source, /despache somente papéis em `missing`/);
    assert.match(source, /`affected_roles`/);
    assert.match(source, /`affected_reason`/);
    assert.match(source, /Enquanto (?:existir|houver) papel\s+em `missing`.*não (?:use `affected_roles` para |pode )?reabrir um irmão\s+aceito/is);
    assert.match(source, /commit\s+posterior e separado.*(?:obrigação ou trigger|obrigação.*trigger)/is);
    assert.doesNotMatch(source, /`missing`[^;\n]*recibo corrente saudável/);
  }
});

test("os três revisores retornam relatório estruturado somente em task ou final", () => {
  for (const role of ["adversary", "compliance", "security"]) {
    const instructions = readFileSync(new URL(`../runtime/agents/harness-${role}.md`, import.meta.url), "utf8");
    assert.match(instructions, /HARNESS_FINAL_REVIEW/);
    assert.match(instructions, /HARNESS_TASK_REVIEW/);
    assert.match(instructions, /\{"issues":\[\]\}/);
    assert.match(instructions, /specifically required evidence.*unavailable/i);
    assert.match(instructions, /fix_hint/);
    assert.match(instructions, /exactly six keys.*no additional keys/i);
    assert.match(instructions, /optional `follow_ups`/);
    assert.match(instructions, /Never put an applicable current defect there to approve/);
  }
});

test("finding de produto preserva fidelidade e autoria só reabre por contrato de teste", () => {
  const prompt = readFileSync(promptPath, "utf8");
  const sniper = readFileSync(sniperPath, "utf8");

  assert.match(prompt, /finding de produto segue ao sniper sem repetir fidelidade/);
  assert.match(prompt, /Reabra test-author somente por teste\/fixture congelado incorreto, mudança do contrato aprovado ou observável aprovado concretamente sem cobertura/);
  assert.match(prompt, /hand-finished.*capture-verified.*rail de dispatch nega test-author.*eventos nativos.*DONE.*commit de produto.*descendente estrito/is);
  assert.doesNotMatch(prompt, /defeito real sem cobertura pede regressão focal/);
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
