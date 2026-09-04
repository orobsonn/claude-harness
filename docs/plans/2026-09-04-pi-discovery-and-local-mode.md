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

## Fechamento ainda obrigatório

Verificar cache/pacote final Mac+VPS após bootstrap e novos recursos; exclusividade
do pai; retomada live/virgem de plano aprovado; tarefas sem testes/parent-only;
redução de loops com evidência; run live de update-harness instalando os quatro;
completion audit, commit/CI e release pelo regime do projeto. Estes subtestes não
encerram o objetivo de paridade.
