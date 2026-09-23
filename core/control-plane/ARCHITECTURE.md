# General agent control plane

Status: implementação validada offline; piloto real aguarda escolha explícita do
consumer pelo operador.

## Resultado e fronteiras

O módulo oferece um agente Pi opcional, com home privado fora dos consumers, e
uma API determinística estreita para os fluxos do Harness. O agente também tem
as ferramentas nativas do Pi para navegar e operar a VPS. Capacidade técnica
não transfere ownership: uma entrega de produto sempre entra pelo launcher
vendorizado do consumer: `node .pi/harness/pi-harness.mjs`.

```text
operador -> agente geral (home privado; ferramentas Pi nativas)
         -> control plane determinístico
         -> Orca (worktree e terminal identificados)
         -> launcher Pi vendorizado (pai global)
         -> pipeline, tasks, recibos e shipping do consumer
```

Owners preservados:

- o control plane possui cadastro, recomendação, vínculo de entrega, inbox,
  decisões e projeção de portfólio;
- Orca possui worktrees, terminais e automações Orca;
- o launcher Pi possui a identidade e a retomada exata do pai;
- registry, gates e recibos Pi possuem execução e aprovação técnica;
- Git/GitHub possuem artefatos e efeitos remotos;
- o operador continua sendo a única fonte de autorizações reservadas.

Não há planner, scheduler de tasks, dispatcher de mãos/olhos, backend do
FirstMate ou cópia de transcript no control plane.

## Contrato de usabilidade

Isto formaliza a sessão Codex operacional que o operador já usa; não cria uma
nova plataforma. Para o operador existe uma conversa persistente e uma única
superfície. Cadastro, IDs, locks, fences, reconciliação e pós-condições são
detalhes internos. O agente pergunta apenas diante de ambiguidade real ou de
uma autorização reservada ainda ausente.

O onboarding normalmente recebe apenas o nome: o inventário Orca e a navegação
local permitem descobrir o caminho. O owner/repo é derivado do
`origin` GitHub e o ID Orca é resolvido pelo caminho; ambos são cruzados com o
registro real antes de persistir. Valores explícitos continuam aceitos, mas não
são confiados sem a mesma prova. Recomendações, admissões, retomadas e automação
revalidam essa identidade antes de consultar ou produzir efeitos externos.

Há somente três invariantes na porta de uma ação: consumer compatível, uma
única entrega por issue e evidência da sessão/efeito. Elas são verificações
automáticas, não gates conversacionais. Planejamento, review, testes e shipping
continuam sendo gates do pai global já existente; o control plane não acrescenta
uma segunda sequência de aprovação.

## Estado e protocolo

`HARNESS_CONTROL_HOME` seleciona o home. Na ausência, o launcher usa
`$XDG_STATE_HOME/claude-harness/control-plane` ou
`~/.local/state/claude-harness/control-plane`. O diretório é privado (`0700`),
arquivos são `0600`, writes JSON são publicados por rename atômico e mutações
concorrentes usam locks por diretório com identidade de processo. Um caminho
preexistente permissivo ou com conteúdo alheio é recusado sem `chmod`; o home
precisa ser um diretório dedicado, nunca uma raiz ampla escolhida por engano.

O home contém somente:

- `projects/<id>.json`: cadastro e referência da automação existente;
- `recommendations/<id>.json`: issue recomendada e ainda não iniciada;
- `deliveries/<id>/record.json`: projeto, issue, geração e recursos;
- `deliveries/<id>/bridge.json`: binding mínimo lido pelo pai global;
- `deliveries/<id>/events.jsonl`: eventos sequenciados e idempotentes;
- `deliveries/<id>/inbox/` e `handled/`: mensagens duráveis;
- `locks/`: exclusão mútua; e `sessions/`/`runtime/` do agente geral.

Todo evento carrega `project_id`, `delivery_id`, `session_id`, `generation` e
`sequence`. Repetir a mesma chave com o mesmo conteúdo é no-op; conteúdo
divergente é conflito. Cada tipo possui payload fechado e limitado: campos
extras — inclusive dumps de contexto — são recusados no owner do protocolo, não
apenas na tool. O bridge recusa child sessions, cwd divergente, binding com
link, permissões abertas ou identidade trocada.

O consumer publica `core/pi/control-capabilities.json`. O control plane lê o
documento e o carimbo `.pi/.harness-version` antes de criar recursos. Um
consumer sem o protocolo exigido é incompatível; nunca é atualizado.

## Fluxos

### Recomendação e admissão

`recommend_issue` resolve um único projeto, lê issues e dependências e exclui
issues bloqueadas, incompatíveis ou já vinculadas. Ele persiste uma
recomendação, mas não cria entrega, worktree ou terminal. Repetir a consulta
reutiliza o mesmo vínculo; se a escolha elegível mudar, a nova substitui a
anterior e a anterior não pode ser iniciada. Eligibility reutiliza o contrato
existente: somente `harness:ready`, dependências lidas pelo owner compartilhado
de `harness-deps` e estado de cada dependência confirmado no GitHub. O start
repete a leitura da issue, de todas as dependências e do inventário Orca antes
da reserva.

`start_delivery` exige o ID dessa recomendação. O ID determina uma única
entrega. Antes de cada efeito externo, o record ganha um fence
`*_requested`. Se uma resposta se perde, a retomada busca o marcador único no
inventário Orca. Inventário incompleto ou ausência depois de um request
incerto bloqueiam; não repetem o efeito.

Após criar e validar a worktree, o control plane cria um terminal cujo comando
é o launcher vendorizado. Só informa `started` depois de receber do bridge o
evento `session.started` com a sessão real. Timeout vira `unknown`, não
sucesso. Retomada cria apenas uma nova geração de terminal na mesma worktree e
usa `--harness-resume <session-id>` depois de provar que o terminal anterior
encerrou. Nome e branch continuam no contrato do owner existente,
`harness-<issue>`; a identidade adicional do control plane fica no comentário
Orca, sem quebrar as automações de review/shipping.

### Decisões

O pai publica `decision.opened` com ID e revisão. A resposta do operador é
persistida numa mensagem destinada à mesma entrega, sessão, geração, decisão e
revisão. O terminal recebe apenas uma campainha constante; o texto fica no
inbox.

Estados distintos:

1. `queued`: registro durável criado;
2. `sent`: campainha aceita pelo terminal exato;
3. `received`: o pai leu e confirmou a mensagem;
4. `applied`: o pai publicou confirmação com referência de evidência.

Uma revisão antiga não pode fechar uma revisão nova. Um worker não pode criar
mensagem com origem `operator`; esse campo é escrito somente pelo control
plane. Revisões avançam exatamente uma unidade; se a pergunta for revisada
antes do consumo, a resposta antiga permanece como auditoria durável, mas não
é entregue ao pai nem pode gerar `applied`.

### Observação, automação e rollback

`wait` mantém uma única espera host-side por evento ou saída do terminal Orca,
sem polling por modelo. Enquanto a sessão geral está aberta, a própria extensão
também observa eventos materiais e a saída dos terminais em baixa frequência;
um cursor durável evita alertas repetidos e uma mensagem host-owned desperta a
conversa. Esse observador não produz trabalho, não concede autoridade humana e
não é um scheduler de entregas. Saída sem evento é interrupção com conclusão
das filhas desconhecida; nunca vira sucesso ou falha inventados.
A projeção só apresenta fatos comprovados. `session.stopped` é interrupção ou
estado desconhecido; nunca conclusão. Um PR reportado pelo pai só vira
`pr-available` depois que o host confirma no GitHub URL, draft, head SHA e
estado aberto. A URL também precisa pertencer ao `owner/repo` registrado e o
head precisa ser o `HEAD` da worktree da entrega exata; até lá permanece
`result-unverified`. PR draft disponível não autoriza merge.

Pais globais iniciados fora do control plane são descobertos somente quando
Orca, o worktree de issue, o terminal conectado, o lock do pai, o PID/start
token, o cabeçalho de sessão e o `gate-state` concordam. `track_run` persiste
essa identidade como `external-readonly`; o observador passa a vigiar a saída
do terminal exato. Não há bridge retroativo, portanto inbox, decisão e resume
são recusados em vez de simulados. Mensagens operacionais explícitas usam um
outbox idempotente e o terminal exato; o retorno do Orca prova apenas envio,
não aplicação.

Para sessões externas, os registros host-owned `child-identity` identificam os
subagentes em voo, e o registro canônico `task-runs` mais a identidade viva do
processo identifica task workers independentes. Enquanto houver filho ativo, a ociosidade
visual do pai continua sendo `running` e não desperta o modelo. Sem filhos, uma
mudança semântica no preview ocioso — após remover spinner e status transitório
— gera `session.attention-needed`; timestamp ou animação isolados não geram
evento. O agente faz no máximo uma leitura limitada e classifica pergunta,
bloqueio, falha, conclusão aparente ou desconhecido. A ociosidade sozinha não
é convertida em bloqueio, e waits externos são limitados a 30 segundos para não
prender a conversa.

`automation_enable` só habilita um produtor existente e encontrado. Um selector
canônico ainda não cadastrado é localizado sem pergunta adicional quando há
exatamente um config que prova a identidade do projeto; o vínculo é persistido
sob lock durante a ativação autorizada. Zero ou vários candidatos são recusados
com diagnóstico. Antes da mutação, o inventário recusa produtores concorrentes.
Um produtor já ativo é no-op, seguido da mesma verificação. O módulo não possui
operação de criar scheduler.

“Produtor” não significa “qualquer automação do mesmo repositório”. O harness
mantém também uma automação Orca de revisão de PR, que não cria entregas. No
protocolo v1 entram no inventário somente os selectors `select-and-dispatch`
cujo config prova o projeto e, quando configurada, a automação Orca de ID exato
registrada como produtora. O alvo dessa automação é validado pelo campo atual
`runContext.repoId` (com o legado `projectId` aceito). Assim o reviewer não vira
um gate falso, mas um produtor registrado no repositório errado continua sendo
recusado.

Desabilitar o control plane impede suas mutações, esperas ativas, verificações
persistentes e notificações. Consultas de cadastro/estado continuam puramente
locais, e consumers, sessões, worktrees, terminais e estado são preservados.
Não há operação de merge, deploy, teardown, descarte, credencial ou limpeza de
worktree.

## Reaproveitamento seletivo do FirstMate

A revisão fixa `6f0f139962eadaea29487cafead418a0eb2ec6e4` foi usada como
referência conceitual para home privado, locks conservadores, inbox durável com
campainha, acknowledgement separado, eventos silenciosos e recusa de controle
sem pós-condição. A implementação é nova e não copia porções substanciais do
FirstMate. `no-mistakes`, treehouse, Relay, secondmates, backends múltiplos,
dispatch de modelos e sincronização de frota ficaram fora.

## Revisão adversarial e correções

| Área | Falha do desenho inicial | Correção incorporada |
| --- | --- | --- |
| Segurança | Um env path livre permitiria escrita ampla pelo consumer. | Binding aponta para diretório privado precriado; bridge valida owner, modos, links, cwd e IDs, e só escreve eventos/inbox próprios. |
| Filesystem | Um `HARNESS_CONTROL_HOME` digitado como diretório amplo poderia ter permissões alteradas durante a inicialização. | Home preexistente precisa ser privado e dedicado; o inicializador nunca corrige `chmod` de caminho escolhido pelo operador. |
| Isolamento | Um resumo ou transcript global poderia atravessar projetos; um home configurado dentro do consumer misturaria ownership. | Não há armazenamento de transcript compartilhado; APIs retornam projeções por projeto e cadastro recusa qualquer sobreposição entre home e repositório. |
| Duplicação | Retry após resposta perdida poderia criar outro pai/worktree/terminal. | Fence persistido antes do efeito, marcador Orca único, reconciliação e recusa quando a ausência não prova falha. |
| Eligibility | Um parser local e uma lista limitada poderiam liberar dependência aberta ou issue não pronta. | Reuso de `parseDependsOn`, filtro `harness:ready`, `issue view` fail-closed e revalidação imediatamente antes da reserva. |
| Recuperação | “Última sessão”, uma geração persistida pela metade ou resposta perdida do terminal poderiam retomar errado ou prender a entrega. | Apenas o `session_id` ligado ao record é aceito; geração, recibo de recomendação e terminal são reconciliados, e retry continua o mesmo resume pendente. |
| Decisões | Uma resposta enviada à revisão anterior poderia chegar depois que o pai revisasse a pergunta. | Revisões são monotônicas; inbox antigo não é entregue e `applied` exige a resposta recebida da revisão corrente. |
| Supervisão | Um turno encerrado não conseguiria avisar sozinho sobre uma queda ou decisão. | Observador host-side desperta a sessão somente para eventos materiais, com cursor durável e sem polling pelo modelo. |
| Concorrência | Dois chats poderiam admitir a mesma recomendação. | Lock por recomendação/projeto e delivery ID determinístico. |
| Cadastro | O mesmo consumer sob dois IDs permitiria duas admissões; identidades GitHub/Orca divergentes consultariam outro projeto; uma base branch poderia parecer opção de CLI. | Caminho, GitHub e identidade Orca são descobertos/cruzados e únicos; drift é revalidado antes de efeitos; base branch usa linguagem conservadora de refs. |
| Automação | Tratar toda automação Orca do repo como produtora bloquearia o review; confiar em substring/ID poderia ativar uma linha ou repo alheio. | Só o selector no formato canônico, com config que prova o projeto, ou o ID Orca explicitamente registrado entram no inventário; peers de review não são inferidos. |
| Credenciais | Brief/evento poderia capturar env ou token. | Schemas fechados, campos secretos recusados e nenhum env/terminal output persistido. |
| Autoridade | Worker poderia afirmar aprovação humana ou terminal fechado virar sucesso. | Origem `operator` é host-owned; eventos de saída nunca são conclusão; resultado exige evento explícito/evidência. |
| Compatibilidade | Um nome próprio de worktree quebraria o selector de PR já existente. | Worktree/branch preservam `harness-<issue>`; delivery e geração usam o comentário Orca. |
| Monólito/usabilidade | Control plane poderia replicar pipeline, reviews e scheduler ou expor cada fence como um gate. | Uma tool fechada, invariantes automáticos e nenhuma aprovação intermediária; pipeline continua no pai global. |

## Fases

1. Contratos offline: storage privado, registro, issues, idempotência, eventos,
   decisões e automações com seams injetáveis.
2. Ponte Pi: capabilities, identidade real, inbox e eventos no pai global.
3. Agente geral: launcher isolado, ferramentas Pi nativas e tool estruturada do control plane.
4. Piloto autorizado: um consumer compatível, sem merge/deploy/cron real.
5. Interrupção/retomada e segundo projeto; promoção somente após isolamento e
   pós-condições observados.

## Próxima decisão operacional

A implementação e os testes offline não alteram consumers nem sessões reais.
O próximo passo é escolher explicitamente um consumer de piloto e autorizar,
se necessário, seu vendor/update e uma execução com inferência. O piloto não
inclui ativação de cron, merge ou deploy. Até essa escolha, o módulo permanece
opcional e inativo.
