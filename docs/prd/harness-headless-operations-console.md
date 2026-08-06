# Console de operações do Harness Headless

- **slug:** harness-headless-operations-console
- **status:** pronto
- **criado:** 2026-07-27 · **atualizado:** 2026-07-28

## Problema

O Harness Headless já consome issues e executa sessões no VPS, mas o operador não tem uma visão única para acompanhar a fila, saber em que etapa uma execução está, pausar trabalho em segurança ou impedir novos consumos por repositório. A operação depende de labels, Telegram e acesso manual ao VPS, o que aumenta o esforço para entender falhas e agir no momento certo.

## Quem se beneficia

O único operador do Harness Headless. Ele administra repositórios já configurados no VPS ou na máquina local e precisa decidir rapidamente se deixa uma execução avançar, interrompe a próxima entrada na fila ou investiga uma execução pausada.

## Requisitos

1. Um comando executado no VPS ou na máquina local do operador deve abrir um painel navegável no terminal, sem URL pública, para mostrar repositórios, issues, execuções e logs do Harness disponíveis naquele ambiente.
2. A tela inicial deve listar exclusivamente os repositórios já configurados para o Harness no ambiente onde o comando roda e, para cada um, mostrar se o consumo de novas issues está ativo ou desativado.
3. Ao desativar o consumo de um repositório, o Harness não deve iniciar uma nova issue nesse repositório; uma execução já iniciada deve continuar até terminar ou receber o comando explícito de parar.
4. Ao ativar o consumo de um repositório, o repositório deve voltar a poder selecionar issues elegíveis na próxima rodada do Harness, sem iniciar uma sessão duplicada.
5. O painel deve mostrar as issues do GitHub elegíveis para consumo e permitir que o operador coloque uma issue na fila ou a retire dela; o GitHub permanece a fonte oficial dessa intenção.
6. Para cada execução ativa, o painel deve mostrar issue, repositório, início, estado atual, etapa mais recente, alerta ou erro relevante e link para o PR quando existir.
7. A linha do tempo da execução deve apresentar eventos equivalentes para Claude Code e OpenCode, incluindo início, fase do fluxo, revisões, bloqueios, criação de PR e término; quando o estado não puder ser confirmado, ela deve mostrar que a execução precisa de revisão, sem inferir sucesso.
8. O operador deve poder abrir, sob demanda, uma visão textual segura das últimas linhas úteis da execução, sem renderizar conteúdo de log como HTML executável e sem depender do texto bruto como fonte de estado.
9. O comando “Parar” deve pedir confirmação, impedir que uma nova execução seja selecionada para aquele repositório durante a transição e resultar visivelmente em `pausada`, `falha ao parar` ou `precisa de revisão`. Antes de encerrar o processo headless, o Harness deve gravar e confirmar uma intenção durável de parada; se isso falhar, ele não deve encerrar o processo e deve mostrar `falha ao parar`.
10. Quando uma execução for pausada, o painel deve preservar o worktree, a branch e os metadados mínimos de inspeção, impedir retomada automática e disponibilizar links ou informações suficientes para o operador inspecionar e decidir uma nova tentativa manual. Preservar não significa manter o processo headless vivo.
11. Execuções concluídas devem reter apenas o resultado essencial e os links para issue e PR; dados detalhados de execuções pausadas, seu worktree e sua branch devem permanecer disponíveis por 72 horas e então ser removidos automaticamente.
12. Toda ação de ativar, desativar, enfileirar, retirar da fila ou parar deve registrar data, ação, repositório, issue quando aplicável e resultado para consulta do operador.
13. A navegação deve começar numa grade de cartões de repositório; abrir um repositório deve mostrar sua fila e sessões; abrir uma sessão deve mostrar fases, eventos relevantes, últimas linhas seguras e ações disponíveis. O operador deve conseguir realizar essa navegação por teclado e também por clique nos terminais que suportam mouse.
14. A tela inicial deve exibir uma única faixa de atenção quando um ou mais repositórios exigirem intervenção. Um repositório entra nesse grupo apenas quando tiver uma issue `harness:blocked`, uma revisão estagnada, o breaker local da revisão ativo ou uma execução recém-encerrada pelo watchdog ainda sem reconciliação. `harness:awaiting-merge`, locks vivos, fila normal e logs brutos não devem acionar essa faixa. Ao abrir a faixa, o operador deve ver uma lista curta dos repositórios afetados e seu motivo principal, sem ser levado automaticamente a um deles; bloqueios terminais vêm antes de incertezas temporárias e, dentro do mesmo grupo, o caso mais antigo vem primeiro.
15. Uma execução só pode ficar `pausada` quando a intenção de parada estiver durável, a execução identificada tiver terminado, os recursos Git tiverem sido preservados e a limpeza dos arquivos efêmeros e sensíveis estiver confirmada. Se qualquer confirmação faltar, o painel deve usar `precisa de revisão`; se o processo permanecer vivo, deve usar `falha ao parar`.
16. Enquanto uma execução estiver pausada, todo avanço automático associado à sua issue deve permanecer bloqueado, inclusive nova execução, recuperação, revisão e merge do PR. O painel deve deixar explícito que esse bloqueio permanece até a análise manual do operador.
17. Enquanto existir uma execução pausada em um repositório, o Harness não deve iniciar outro item da fila nesse repositório. O painel deve mostrar que o repositório está parado para inspeção e só permitir novo consumo após uma ação manual explícita.

## Decisões travadas

- O painel é privado e atende apenas ao operador conectado ao VPS ou à sua máquina local. A primeira versão não terá URL pública, login web nem gestão de contas.
- A interface será um painel navegável no terminal. Isso prioriza velocidade e leitura direta dos dados locais sobre uma experiência visual no navegador.
- Antes do console real, será criado um protótipo visual navegável para validar a hierarquia: repositórios → sessões do repositório → detalhe da sessão.
- Na versão inicial, cada máquina mostra e controla somente as execuções que rodam nela, além da fila do GitHub. A conexão SSH existente não será usada pelo painel ainda.
- O GitHub permanece a fonte oficial da fila. O painel administra as labels e apresenta a fila, sem criar uma fila concorrente.
- A visão principal é uma linha do tempo curada, mais rica que o Telegram; logs brutos são detalhe sob demanda, não a interface padrão.
- Parar preserva o trabalho parcial e pausa a issue para inspeção. O painel não descarta nem reenvia automaticamente esse trabalho.
- Desativar um repositório bloqueia somente novos consumos. Parar a execução atual exige uma ação separada e explícita.
- A primeira versão preserva uma execução pausada para inspeção e decisão, mas não tenta retomá-la automaticamente pelo painel.
- Repositórios entram na configuração do ambiente, não pelo painel. A primeira versão opera apenas os já preparados.
- O histórico detalhado de execuções pausadas dura 72 horas. Execuções bem-sucedidas mantêm apenas um resumo e links externos.
- O acesso acontece pelo ambiente já protegido do VPS; a primeira versão não cria senha, login ou URL própria.
- A navegação não depende apenas de atalhos de teclado: clique deve estar disponível como alternativa nos terminais compatíveis, sem remover o caminho completo por teclado.
- A direção visual inicial é a de terminal técnico: fundo escuro, tipografia monoespaçada, cartões compactos de repositório e progressão explícita entre repositórios, fila e detalhe da sessão. As alternativas de quadro operacional e leitura calma foram rejeitadas para a primeira versão.
- A faixa de atenção é calculada por repositório, não por sessão isolada. Ela resume apenas bloqueios terminais ou incertezas operacionais canônicas; merge manual pendente continua visível como ação no cartão, mas não compete com um bloqueio real.
- A faixa de atenção abre uma lista para escolha explícita do operador; ela não redireciona automaticamente para o primeiro repositório afetado.
- A lista de atenção prioriza bloqueios terminais e só depois incertezas temporárias; empates são ordenados pelo caso mais antigo.
- Parar uma sessão segue dois passos: o botão da tela de detalhe abre uma confirmação contextual; somente a confirmação executa a parada. Não será exigida uma frase digitada nesta primeira versão.
- Preservar uma execução pausada significa manter o worktree, a branch e metadados mínimos para inspeção; a sessão headless em si é encerrada e não tem retomada automática.
- Parar uma execução congela todo avanço automático da sua issue, inclusive análise e merge de PR, até inspeção manual do operador.
- Uma execução pausada também mantém o repositório parado: nenhum outro item da sua fila começa até decisão manual explícita.
- A versão 0 não terá uma ação de limpeza manual: após 72 horas de pausa, o histórico detalhado, worktree e branch são removidos automaticamente.
- A retenção de 72 horas e sua limpeza automática existem apenas para pausas explícitas. Execuções ativas não são limpas pelo painel; execuções concluídas e demais estados continuam no ciclo normal do Harness.

## Suposições do modelo

- O Harness já possui dados suficientes para uma visão inicial: labels de fila no GitHub, lock por repositório, metadados por issue, eventos JSONL e saída de sessão capturada.
- A interface precisará de um registro local de execução e reconciliação com GitHub e processos do VPS; labels sozinhas não são suficientes para impedir duplicidade ou refletir uma parada em andamento.
- Eventos produzidos pelo próprio Harness devem ser a fonte canônica do estado. O parser de logs de Claude Code e OpenCode deve enriquecer o diagnóstico, nunca declarar sucesso por conta própria.
- O painel será iniciado por comando no VPS ou na máquina local e consumirá os arquivos de estado e logs do ambiente atual, além do GitHub; ele não deve expor terminal, diretórios de estado ou comandos arbitrários.
- Claude Code e OpenCode não oferecem o mesmo nível de detalhe no log bruto da sessão principal. A visão comum será composta por eventos estruturados do Harness; as últimas linhas sanitizadas do log serão apenas evidência complementar.
- Pela implementação atual do motor, `harness:blocked` é o sinal terminal e canônico de que uma issue não deve ser retomada automaticamente: ele cobre teto de tentativas, cadeia de correções esgotada e falhas repetidas da revisão. Um painel pode elevar um repositório para atenção quando ao menos uma de suas issues carregar essa label.
- Outros sinais que hoje justificam atenção temporária, mas não devem ser confundidos com o bloqueio terminal, são: uma revisão já marcada como feita que permaneceu em `harness:in-review` (`pr-review-stalled`), o breaker local da revisão ativo e uma sessão recém-encerrada pelo watchdog antes de sua reconciliação. Lock vivo, `harness:ready`, `harness:in-progress`, `harness:queued` e falhas transitórias de consulta não são alerta.
- `harness:awaiting-merge` impede redispatch da mesma issue, mas representa uma entrega revisada aguardando merge manual — caminho normal quando auto-merge está desligado — e não deve sozinho acionar o alerta de bloqueio. Ele pode aparecer como ação disponível no cartão do repositório.
- Hoje não há operação de pausa: o único atuador disponível é encerrar a sessão tmux. Isso não executa o encerramento normal e, sem um novo estado durável, o reaper trata a morte como crash, podendo reenfileirar a issue ou remover worktree e branch. A pausa exige um estado canônico próprio antes da interrupção.
- O estado de pausa precisa guardar a identidade estável da execução e seus recursos (repositório, issue, worktree, branch, sessão e registros de observabilidade) para que cron e reaper distingam uma parada deliberada de um crash. O holder atual do lock guarda apenas pid, instante e id da sessão, portanto não basta.

## Em aberto

## Fora de escopo

- Cadastro de repositórios pelo painel.
- Gestão de múltiplos operadores, clientes ou permissões por equipe.
- Terminal remoto via rede, edição de código, alteração do corpo de issues ou merge de PRs pelo painel.
- Retomar automaticamente uma execução pausada.
- Histórico detalhado de execuções concluídas após o resumo final.
- Acompanhar ou controlar sessões do VPS a partir da máquina local via SSH.

## Riscos conhecidos

- Parar uma sessão não é instantâneo nem perfeitamente reversível: pode haver operações de Git ou subprocessos em curso. O produto precisa assumir estados de falha e revisão manual.
- Logs podem conter segredos ou texto malicioso. Eles exigem filtragem, renderização textual segura e retenção curta.
- Reinícios do VPS ou do serviço podem deixar uma sessão sem confirmação de vida. A interface precisa distinguir esse caso de uma execução ativa.
- Branches e worktrees preservados por pausas acumulam disco e contexto abandonado; a limpeza automática só pode ocorrer depois das 72 horas da janela de inspeção.
- GitHub pode atrasar, duplicar sinais ou ficar indisponível. A reconciliação não pode iniciar uma segunda execução para a mesma issue.
- Parar o tmux não prova que subprocessos tenham terminado. O sistema não pode declarar `pausada` sem confirmar o encerramento da execução identificada; timeout ou identidade ambígua exige `precisa de revisão`.
- A preservação de worktree pode conflitar com a remoção de arquivos temporários e segredos. Falha na limpeza deve impedir o estado `pausada` e exigir revisão.
