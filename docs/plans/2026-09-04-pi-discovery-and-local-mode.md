# Pi: descoberta local e escolha de cerimônia

## Contrato do operador

Claude Code é a referência. Localmente, pedido explícito de trabalho inline/sem
cerimônia deve ser respeitado na sessão; a cerimônia não é uma decisão irreversível
do modelo. Enquanto ativa, a pipeline é rígida. Headless sempre usa cerimônia.
Segurança, autorização e proteção de credenciais não dependem dessa escolha.
Grill e seu Lavish precisam funcionar no Pi, não apenas ter seus comandos negados.

## Recorte de implementação e evidências

### 1. Portar Grill/Lavish — em verificação

- Fonte comparada: skill e referência do Claude Code; também consultada a lane OC.
- RED real: loader do Pi não descobria `harness-grill`. O launcher só carregava
  skills Codex. Existia o hook Lavish, mas não a entrevista nem sua referência.
- Skill `core/pi/skills/harness-grill` agora inclui o PRD de nove seções, perguntas
  uma por vez, hipóteses separadas, referência Lavish privada, mockup estático
  somente solicitado, no-remote/no-script e handoff `harness-issues` disponível.
- Testes GREEN: loader real source e vendorizado encontram a skill, a referência
  e a skill de handoff. Lavish não aparece como skill independente. O teste
  vendorizado também carrega todas as extensões do cache, sem erro.
- Auditoria rejeitou reutilizar recibos de delivery para discovery. Aceita a
  separação `DELIVERY_ROLES` (10) / `DISCUSSION_ROLES` (1), união somente runtime.
  O olho `harness-discussion-adversary` é Sol/medium e somente leitura, não altera
  schema/model_strategy nem evidencia spec/task/final-review. Shadow da role é
  negado; só pai local pré-cerimônia pode despachá-la. Sem novo selo/scheduler.
- Suíte focada source/roles/dispatch/entry: 48/48 green. Ainda conferir ferramentas
  efetivamente ativas do filho real e ausência de interação indevida com bootstrap.

Auditoria posterior instanciou `createSubagentSession` real com registry, montagem
de prompt, loader e SDK reais, sem chamar um modelo. Mesmo com tools de delivery
registradas, a filha só recebeu `find`, `grep`, `ls`, `read`. Tentar reativar
write/edit/bash/classify/mark/subagent/get_subagent_result/steer_subagent manteve
apenas essas quatro ferramentas. Isso prova o conjunto ativo, não isolamento de
confidencialidade. A auditoria encontrou um fail-open quando o gate-state estava
ilegível; regressão RED e correção GREEN agora negam o olho nessa condição e sem
identidade de sessão, preservando a entrada quando ainda não existe estado.

### 2. Prova comportamental da skill

Ensaios independentes Sol/high, somente leitura, sem modelo Pi, rede ou arquivos
de produto: três cenários iguais com orientação genérica de discovery (controle)
e com a nova skill (avaliação fresh). Não representam uma sessão Lavish live.

| Cenário | Controle sem Grill | Com a skill portada |
| --- | --- | --- |
| Entrevista local com prazo, cansaço e pressão para fechar PRD | Propôs `docs/product/...` e "Se você não responder a tempo, assumirei..." | Uma pergunta de consequência, PRD em `docs/prd/...` com nove seções; não substituiu resposta do operador por prazo |
| Mockup rápido, sem implementar produto | HTML continha `onclick` e feedback JavaScript; servidor Python em `/tmp` | HTML placeholder estático sem scripts/event handlers/URLs remotas, arquivo companheiro correto, comandos Lavish open/poll/end e fallback estático |
| Grill headless "sem perguntar" | "Vou avançar sem interromper" e propôs criar issue com hipóteses | Recusou entrevista automática; nenhum PRD/issue fictício |

Leitura manual dos três resultados confirmou essas diferenças. Sem estimativa de
taxa de sucesso geral a partir de três amostras. O validador Python de skill foi
tentado nos dois runtimes disponíveis, mas não executou por ausência de PyYAML;
o consumidor Pi real carregou o frontmatter e resolveu a referência com sucesso.

### 3. Instalação nativa — implementação e prova SDK concluídas

`pi install` antes só carregava extensões parciais: ordem não canônica, run_hand
registrado, zero roles e zero prosa runtime. Manter suporte, não trocar a promessa
por "use só launcher". Manifest ordenado, bootstrap com ownership/preflight só das
roles namespaced e prosa, sem sobrescrever settings/auth/subagents.json globais,
sem npm/rede no startup. Cada role tem teto próprio 144 no native. Verificar
install→loader→roles/tools/prompt, colisão preservada e repetição convergente.

Launcher e bootstrap agora se distinguem por `PI_HARNESS_LAUNCHER=1`, substituído
pelo launcher. A variável pública `PI_CODING_AGENT_DIR` não identifica o launcher:
instalações nativas com diretório personalizado continuam funcionando. Suíte
conjunta atual: 26/26. A prosa do pai não é injetada nos filhos. Em colisões, a
auditoria demonstrou que abortar em `before_agent_start` era cedo demais; a correção
aborta em `agent_start`. O ensaio SDK real viu signal abortado e zero eventos de
provider request ou tool execution. Pi registrou `stopReason: error` com
`This operation was aborted`, não o rótulo `aborted`. Não se promete conter um
adapter customizado que ignore seu signal. Os bytes da colisão são preservados.

### 4. Modo local/headless — integrado, auditoria em andamento

Não confundir complexidade com escolha de cerimônia. Uma flag ortogonal de
suspensão local pode preservar mode/peak e arquivos/recibos da cerimônia, liberar
trabalho inline e impedir marcar delivery concluída durante a suspensão. Filhos
não podem suspendê-la. Headless não aceita suspensão. Retorno à cerimônia exige
revalidar evidências após trabalho inline; não reaproveitar captura/review obsoleto.
`classify` agora expõe `suspend-inline` somente ao pai local; o mesmo pai também
pode executar `resume-ceremony` ao voltar em headless;
dispatch em voo impede a suspensão. Um baseline HEAD+dirty detecta mudanças inline,
inclusive sem commit. Delta exige reconciliação planner/reviewer; nova chamada de
resume volta ativa depois de todos os paths terem dono no plano. Os regates armados
seguem pendentes para a pipeline normal — esperar GREEN dentro de reconciling
bloquearia as próprias mãos necessárias às correções. Testes intactos preservam
fidelity; testes/fixtures alterados a reabrem seletivamente. Prosa explica regressão
controlada isolada, sem exigir rollback de produção saudável para fabricar RED.

Headless usa o contexto do próprio Pi e os sinais de automação existentes. Prova
real encontrou RPC com `hasUI=true`; agora `mode=rpc` também força headless. Print,
JSON e SDK sem interface ficam headless, TUI sem sinais permanece local. A allowlist
de shell continua exatamente a do Claude por decisão explícita do operador: não
é uma fronteira read-only (node/scripts podem mutar), e a prosa não promete sandbox.

### 5. Smokes reais adicionais

- Lavish 0.1.64 abriu/renderizou fixture estática, recebeu feedback sintético via
  browser e devolveu-o em poll. `end` retornou ended; como o servidor persistiu, o
  processo exclusivo identificado foi encerrado, porta conferida livre e aba fechada.
  Nenhum PRD/produto real, publicação ou hook instalado; fixture própria removida.
- Pi 0.84.4 chamou `openai-codex/gpt-6-astra` com `--thinking high` e respondeu
  `ASTRA_OK`, exit 0, sem tools. O catálogo não contém o ID e usa o fallback custom
  ID; o evento confirma provider/model reais. Nenhum login/config foi alterado.

### 6. Candidato empacotado e descoberta live posterior

O pacote SHA256 `50be7c9b79d425b422ea94a8c2e5a1e5bb20261bce4ebc34ec90385730abcacd`
instalou os quatro provedores por default em fixture Mac com cache frio (16,1s).
O loader real carregou as oito tools do harness sem erros; o projeto não recebeu
`package.json` nem `node_modules`, e a segunda leitura do cache funcionou sem npm.
Isso não aprovou o comportamento do modelo: duas sessões reais, sem override de
modelo no comando, escolheram Anthropic em vez de Sol e encerraram com erro antes
de executar qualquer tool. O SDK exige `defaultProvider` e `defaultModel` separados;
o asset antigo trazia somente um `defaultModel` combinado e foi ignorado na seleção.
O candidato fica reprovado até correção, regressão com o seletor real e repetição
das provas live. Exit 0 do processo não foi tratado como conclusão saudável.

O sucessor SHA256 `ed16bb1ae75259a124260a7dc871b6d673175077c3cc2cb8ae007c09db2cce6d`
separa provider/model e migra somente os defaults legados conhecidos do harness.
Regressão RED observada; 25 testes do launcher GREEN, incluindo `SettingsManager`,
catálogo real do Pi e `findInitialModel` com credencial sintética em memória e rede
desabilitada. Duas novas runs live selecionaram Sol sem override no comando.

| Prova do pacote corrigido | Mac arm64 / Node 22.22.2 | VPS x64 / Node 22.23.1 |
| --- | --- | --- |
| Primeiro vendor, cache frio, default quatro provedores | 17,251s | 19,554s |
| Segundo vendor, árvore byte-idêntica | 4,026s | 3,613s |
| Pi / pi-subagents | 0.84.4 / 21.2.0 | 0.84.4 / 21.2.0 |
| Loader real e pacote | 17 extensões sem erro, Grill, 11 roles nativas | Mesmo resultado |
| Dependências no produto | Nenhum package.json/node_modules | Nenhum package.json/node_modules |

O smoke separado do Orca real passou na VPS (2/2, zero skip). Na suíte local
pós-correção, 3.126/3.127 passaram; a falha foi esse smoke porque o app Orca estava
fechado (`runtime_unavailable`). Não se alterou o teste nem se abriu o aplicativo
para esconder essa condição; a prova equivalente foi executada no host disponível.
O scanner de segredos do pacote também passou. As runs live de update e retomada
continuam sendo condições de fechamento, não presumidas a partir destes testes.

### 7. Candidato final: Astra no filho real e update inline

O smoke CLI de Astra não bastava: o resolvedor estrito de `pi-subagents` consulta
o catálogo disponível e recusou a primeira revisão live. O bootstrap passou a
registrar Astra pelo resolvedor público do Pi, preservando provider, autenticação
e overrides do operador. Regressão e filha SDK reais passaram; suíte focada final
43/43 GREEN. A compatibilidade do catálogo não é uma afirmação de preços ou
limites oficiais do modelo. As revisões live posteriores chamaram Astra de fato,
inclusive retornando REVISE com problemas concretos antes de APPROVE.

Pacote final SHA256
`0e1b32ccbf0fbb82b945e1ee4bc4abaa4d43e4a1bc761a66f3f497657c5e6dd8`:

| Prova final | Mac arm64 / Node 22.22.2 | VPS x64 / Node 22.23.1 |
| --- | --- | --- |
| Vendor frio, quatro provedores por default | 15,421s | 24,934s |
| Segundo vendor byte-idêntico | 3,925s | 2,343s |
| Loader real | 17 extensões, zero erro; Grill e 11 roles | Mesmo resultado |
| Cache sem npm / dependências ausentes do produto | Confirmado | Confirmado |

A TUI real, sem `-p` nem override de modelo, selecionou Sol e completou
`update-harness` inline na sessão `cae60e00-2526-45c4-ab02-f5fa1cdcd391`.
O ensaio pré-release usou `vendor-core` do pacote local aprovado; não simulou o
CLI público, que seleciona release remota. O transcript registra classificação
`no-ceremony`, zero subagentes, duas atualizações dos quatro provedores e
`pi-harness --verify` saudável. A segunda atualização convergiu; o Git da fixture
ficou limpo e o comentário de configuração do operador permaneceu byte-idêntico
(SHA256 `202e0ea1e72f8ab98229c835657695f39ad12c320c6ae0d24fc83d67b1ad0955`).
Não houve commit, PR, push ou publicação pelo Pi. Encerramento normal com exit 0
removeu o lock. A suíte completa de vendor tentada pela TUI excedeu 180s; isso foi
reportado, não convertido em sucesso. O teste comportamental focado de default
all/convergência passou (1/1, zero skip), além do CI completo verde do candidato.

### 8. Retomada exata após aprovação: prova concluída

A sessão FULL `63309b3e-ab13-4708-b190-eff99c2297f5` foi retomada após revendor do
candidato final. Astra revisou de fato o plano, pediu correções de escopo/TDD e
finalmente aprovou; o processo encerrou normalmente antes de qualquer mão. Uma
segunda retomada pelo launcher usou o mesmo arquivo, header, ID, cwd e histórico,
sem sessão substituta. O plano aprovado permaneceu com SHA256
`d3ced5a11f0fdd53831aaf1044b6e8ab93289da3d2f481b0bb76b2a83d19d010` e a spec selada
com `d52f607fbcdb5787c03079643f747bf85ad705b399a5a2e0163c4648c4a69c3d`.

O pai despachou Luna para a task-0 canônica `no_tests`, um scaffold real separado
do ciclo TDD da task-1. O encerramento final foi exit 0, sem lock e sem iniciar
task-1. A mão terminou DONE, somente `src/normalize-title.mjs` mudou, sem violação
de escopo/frozen; captura independente e regate foram registrados e o adversário
aprovou o resultado atual. Não houve commit, remote ou PR. Esta prova cobre
retomada exata do pai FULL existente, não adoção de plano por sessão virgem, resume
LIGHT ou entrega integral da fixture.

O ensaio também expôs atrito real: a prosa da mão omitia a linha terminal que o
parser compartilhado exige. Resultado sem linha, ou `Outcome: DONE`, foi tratado
como BLOCKED; `Status: DONE` foi reconhecido. Não se alterou recibo manualmente.
A correção pré-release explicitou esse contrato nos três consumidores reais
(executor, sniper e test-author) e na orientação do pai. O parser e os gates não
mudaram. Relatório inválido continua BLOCKED: não se cria novo produtor apenas
para corrigir texto nem se pede alteração cosmética no produto. Expected RED
válido pode concluir a tarefa do test-author, sem declarar o produto GREEN.
TDD observou falhas antes da alteração; focal 12/12, captura/roles 69/69 e
integração/preflight 10/10 passaram. O pacote também passou na verificação
independente prosa/parser (21/21) e no scanner de segredos. A redução geral de loops não foi quantificada por
este ensaio; houve revisões legítimas e esse atrito evitável de formato.

### 9. Pacote após a correção de prosa

SHA256 `a05641cc97f8a49332184d272e317272fff5d4050f27068deef21c32ef4e52fb`.
Repetição fria final: Mac 16,403s/4,060s; VPS como usuário `orca`
17,147s/1,672s (primeira/segunda atualização). Nos dois hosts a árvore convergiu
byte a byte, os quatro marcadores estavam presentes e o produto não recebeu
dependências. Cache hit sem npm, Pi 0.84.4, subagents 21.2.0, 17 extensões sem
erro, Grill e 11 roles nativas confirmados novamente. O pacote ainda usa 2.2.1
como versão pré-release; o release-please permanece responsável pelo bump.

O probe final chamou `createSubagentSession` e `DefaultResourceLoader` reais com
o asset executor desse pacote, Luna/high e um pedido genérico para criar/verificar
um módulo ESM. O pedido não citou Status, Outcome ou formato. O agente produziu
somente o arquivo solicitado, verificou sintaxe/import/valor e encerrou com
`Status: DONE`, reconhecido pelo parser real, sem abort/steer. Uma tentativa
anterior cujo test double descartava o system prompt foi diagnosticada e excluída
da evidência. A prova válida usou nova fixture e o loader real.

## Fechamento técnico

Completion audit independente aprovado, incluindo a correção final de prosa e
seus limites. Cache/pacote Mac+VPS, update live inline, Astra real e retomada exata
após aprovação foram verificados. As alterações e evidências seguem por PR/CI e
release-please; esta auditoria não substitui o sucesso desses passos de publicação.
A qualidade funcional da issue 17 fica para revisão do operador.
