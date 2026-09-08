# Relatório de implementação da pipeline Pi

Estado: implementação concluída no código fonte e validação FULL real em andamento.
O PR funcional ainda aguarda a prova completa, merge e release pelo release-please.

## Comportamento final

Uma run LIGHT/FULL com `task_pipeline_version: 1` mantém spec, plano e aprovação na
sessão global. Depois da aprovação nativa do plano, `harness_tasks` cria uma sessão pai
local para cada task pronta. Cada sessão recebe somente o contrato focal, executa a
sequência TDD nativa e devolve um resultado verificável. O pai global conserva o DAG,
integra SHAs aprovados e executa testes agregados, harvest, olhos finais e entrega.

O grant da task é ligado à sessão, feature, hashes atuais de spec/plano, branch, base e
dependências integradas. Recibos de dependências são revalidados contra o registry do
pai; uma task já admitida pode reconhecer o recibo histórico correto após uma correção
ancestral, mas uma admissão nova exige a integração corrente. Retomadas preservam a
mesma tentativa e recusam identidade estrangeira, artefato alterado ou processo vivo
incompatível.

Dentro da task, test-author, executor e sniper permanecem sequenciais. O freeze commit
é linear, limpo e restrito a testes/fixtures autorizados; fidelity referencia esse
commit real. Captura e hand-record continuam fatos distintos. Os olhos de implementação
revisam um HEAD imutável: adversary usa `HARNESS_TASK_CONTEXT`; compliance e security
usam `HARNESS_TASK_REVIEW` antes do contexto para adquirir leases paralelas. Compliance
de fidelidade continua serial. Os modelos, esforço e complexidade vêm das rotas Pi do
próprio grant, sem consultar o routing do Codex.

Os relatórios de plan-reviewer e dos olhos usam o JSON canônico validado pelo host.
Prosa, tokens `APPROVE`, PIDs encerrados ou estado alegado pelo modelo não criam
evidência. A integração registra intenção antes do merge e só aceita retorno atual,
árvore limpa, escopo autorizado, receipts saudáveis e parentage esperado. Correções
invalidam os gates agregados que dependem do HEAD anterior.

O `shared_context` usa o memory-cycle existente. O pai pode admitir até 2 KiB de brief
curado por task; esse conteúdo é referência não confiável e não transfere autoridade,
reviews ou diário de siblings. A task mantém seu diário local e pode devolver um
`context_return` ligado à sessão, task e HEAD. O pai revalida e cura explicitamente o
que deve entrar em sua memória.

No Orca, a worktree filha parte do SHA global e registra parent, repo, host, projeto e
setup. O registry guarda worktree, terminal, tab e presentation. Tasks novas executam a
TUI nativa do Pi no PTY do Orca; o mesmo processo grava eventos estruturados por uma
extensão do harness. O worker supervisiona timeout e término sem substituir a TUI por
um renderer textual.

Inventário e `surface` não equivalem a confirmação no cliente remoto. A CLI pública do
Orca 1.4.177 navega `terminal focus` somente no host. A pipeline conserva handles e
reporta `visible` ou `background`; a confirmação de que um cliente do usuário exibiu a
aba continua sendo uma observação separada.

## Correções incorporadas

- Locks e retomadas distinguem owner vivo, PID reutilizado e abandono comprovado. Um
  crash antes do provider não deixa uma admissão falsa que impeça retry.
- A identidade e os recursos da task são instalados também nos filhos nativos. Gates
  bloqueiam cerimônia global, outras tasks, entrega e mutação fora do contrato local.
- Criação Orca com resposta perdida é reconciliada pelo marcador único da tentativa;
  ela não autoriza criar outra worktree ou terminal.
- A recuperação global aceita uma spec draft legítima e o checkpoint selado anterior
  ao plano sem promover gates. Plano presente continua sujeito à validação completa;
  progresso real impede tratar um plano removido como ausência inicial.
- O planejamento Pi verifica se o RED é coletável na base da task. Test-author não cria
  scaffold de produção para satisfazer import; componentes novos podem ser reunidos na
  task que os torna testáveis por uma entrada existente.
- O plan-reviewer agora pede o mesmo JSON `{verdict, findings}` exigido pelo parser. Os
  demais revisores também documentam as chaves exatas aceitas pelo schema.
- O grant inclui `dispatch_routes` das seis roles locais, derivados da mesma função que
  o gate usa. Isso remove a dedução incorreta por tiers ou por cópias vendorizadas do
  routing Codex.
- Fidelity de task passa a referenciar o freeze commit real, posterior à mão do
  test-author. O prompt explicita a ordem, exige SHA completo observado e checagem de
  tipagem/sintaxe antes do freeze.
- O prompt task-local distingue olhos de implementação de compliance de fidelidade. O
  runtime paralelo já estava correto; prompts context-first faziam compliance/security
  parecer dispatches exclusivos e colidir com adversary.
- O transporte `tui` preserva stdin/stdout no PTY, duplica stderr para o arquivo de
  diagnóstico e fornece ao recorder somente o descritor efetivo. O arquivo de eventos
  é privado, confinado ao diretório do job e criado sem seguir symlink. Jobs antigos
  continuam no modo JSON.

## Prova FULL corrente

O projeto escolhido é **orobsonn/proj-lainny**, issue
[#47 — escritor-publico-lead](https://github.com/orobsonn/proj-lainny/issues/47), já
implementada no PR #56. Os critérios vêm da issue e dos artefatos normativos históricos.
A prova parte da base anterior `84b946d5e12b516952c9cdb8696fbab6382ef813` e não copia
código, receipts ou aprovações do PR antigo. Cloudflare, deploy, push e publicação do
produto ficam fora desta execução.

Nessa base, a baseline do produto passou 699 testes em 80 arquivos, typecheck, audit
sem achados e docs-check de três PRDs.

A run corrente usa:

- worktree `/home/orca/orca/workspaces/proj-lainny/pi-harness-full-lainny-47`;
- sessão global `228d1aaf-1bbe-48d3-8c2f-574b7c7485b1`;
- feature `escritor-publico-lead-tui`, modo FULL e `task_pipeline_version: 1`;
- source `a5cb415983b106d51182aaaa5babfe7affcbabd8`;
- bootstrap da worktree `41f63723b50338d20015356a2275e25abcedcf9b`;
- runtime imutável `8db003b17cd55d1b3d15353b850743a65e2dd92e722787eb99dc13eb5c870a87`;
- terminal `term_3628621d-98c2-48e0-a06a-824e36a93a85`, título
  `RUN REAL · Pi TUI FULL · Lainny #47`;
- job `/tmp/pi-full-lainny-47-orca-tui-run-2`.

Às 02:42 UTC de 8 de setembro, o processo estava vivo na TUI nativa. O gate registrava
uma spec nova em draft, SHA
`69275224fdb09550947dc0543190b2876a7ade4a7e2ea53feec5d4f1f1f92871`, e o adversary
nativo dessa draft havia sido despachado. Ainda não havia `plan_review_evidence`, task
admitida ou integração. O escopo prevê três tasks a executar depois da aprovação; esse
fato não é apresentado como plano aprovado.

O CI do source `a5cb415` é o
[run 34179909715](https://github.com/orobsonn/claude-harness/actions/runs/34179909715):
**3512 testes, 3510 passaram, nenhum falhou e 2 foram ignorados**. O smoke de TUI no
host Orca confirmou Pi nativo em PTY, renderização, eventos estruturados e término com
código zero. A execução FULL corrente também tem snapshot legível do terminal e
navegação despachada, mas o Orca retornou `surface: background` e ainda não há ACK de
renderização no cliente do usuário. Esses fatos comprovam processo e transporte, não
aprovação FULL nem visibilidade remota.

## Diagnóstico preservado

A sessão anterior `b2681197-8aa4-4ebb-856e-a35898d5c4bb` chegou a despachar T1 e T2 e
revelou os conflitos de fidelity/freeze, rotas e prefixos descritos acima. Nenhuma das
duas tasks foi integrada. Ambas foram removidas pela operação oficial do Orca, com as
branches preservadas:

- `orobsonn/harness-task-task-1-data-idempotency-ceiling-ba901361-aa36-428b-af98-6cbf7ca32a58`
  em `391c7d6934084c1fafd8078c2e1d0b42ad0a0c4a`;
- `orobsonn/harness-task-task-2-public-input-allowlist-3812d701-d5ef-45f6-bfd2-9b407e00f852`
  em `4f7d5092d589ee050aa7d62a561567704ce63dd4`.

Os patches, estados e o bundle Git estão em
`/tmp/pi-full-lainny-47-old-diagnostics`, incluindo
`old-local-branches.bundle`. Esse material é diagnóstico e não pode autorizar ou
completar a sessão nova. A tentativa anterior no Victor também foi removida e arquivada;
ela não conta como prova desta pipeline.

## Fechamento pendente

- concluir spec, aprovação do plano, as três tasks, integrações e testes agregados da
  sessão corrente;
- colher memória, olhos finais e aprovação FULL no HEAD agregado;
- fechar e integrar o [PR funcional #903](https://github.com/orobsonn/claude-harness/pull/903);
- deixar o release-please produzir changelog, versão e tag, sem edição manual.

Contrato oficial consultado: [worktrees](https://www.onorca.dev/docs/model/worktrees),
[CLI](https://www.onorca.dev/docs/cli/reference) e
[código Orca v1.4.177](https://github.com/stablyai/orca/tree/v1.4.177).
