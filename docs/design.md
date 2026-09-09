# Desenho atual — um contrato, quatro runtimes

## Problema que o harness resolve

O harness não existe para “fazer o modelo programar”. O modelo já programa. Ele existe para impedir que velocidade de geração seja confundida com entrega confiável.

O operador é responsável por produto: problema, prioridade, comportamento esperado e risco aceito. O sistema assume a disciplina de engenharia: escopo, plano, TDD, implementação, revisão independente, evidência, memória e fechamento.

As falhas que orientam o desenho são recorrentes:

- começar a construir antes de resolver o pedido;
- deixar o autor aprovar o próprio trabalho;
- escrever testes depois da implementação;
- perder decisões e aprendizados entre sessões;
- confiar em prosa sem vínculo com Git e execução;
- gastar o modelo mais forte em volume mecânico;
- criar uma falsa sensação de segurança com hooks que não são sandbox.

## Contrato comum

Os quatro shells preservam o mesmo fluxo conceitual:

```text
pedido
  -> triagem proporcional
  -> descoberta/spec
  -> revisão adversarial da proposta
  -> decisão de produto
  -> plano executável
  -> revisão do plano
  -> teste antes da implementação
  -> implementação
  -> revisão independente
  -> verificação agregada
  -> memória
  -> shipping
```

Portabilidade significa preservar esse contrato usando primitivas reais de cada runtime. Não significa copiar literalmente o motor de outro shell nem anunciar paridade que não foi provada.

## Modelo operacional atual

### Pi é a linha principal de criação e entrega

Pi é o ambiente de uso diário para transformar uma ideia ou issue em software integrado. A sessão pai mantém spec, plano, integração, validação agregada, memória e shipping. Depois da aprovação do plano, cada task de implementação recebe uma sessão local e uma worktree.

O coordenador permite:

- tasks independentes em paralelo;
- dependências liberadas por recibos integrados;
- serialização de scopes conflitantes;
- integração vinculada ao SHA esperado;
- retomada da mesma tentativa após correção;
- recuperação de dependentes depois de corrigir uma ancestral;
- revalidação agregada quando a história do HEAD muda.

Dentro de cada task, o fluxo é TDD: test-author, revisor exclusivo de fidelidade, freeze, executor, captura, revisão e sniper quando necessário. Compliance, adversary e security podem rodar em paralelo, até o limite configurado.

### Codex é a linha local de validação final

Depois que o Pi entrega um HEAD integrado, o Codex é usado para avaliar o produto completo: diff, testes, comportamento executável, integração e experiência. No desktop, ferramentas de browser/computer use podem revelar falhas que não aparecem numa revisão por texto.

Essa divisão é operacional, não estrutural:

- Pi também possui reviews e validação final próprios;
- Codex também é capaz de executar uma entrega completa;
- não existe conversão automática de sessão;
- o estado compartilhado é o repositório e seus artefatos verificáveis.

O objetivo da segunda passada não é repetir mecanicamente os mesmos checks. É usar outra superfície de operação e outra família de contexto para tentar quebrar o que já parece pronto.

### Claude Code e OpenCode continuam como shells suportados

Claude Code mantém a lane histórica de agents, skills, rules, hooks e cloud routines. OpenCode mantém a lane multi-provider com plugins, tools e roteamento próprio. Eles preservam o contrato comum, mas não definem o fluxo diário principal do operador.

## Por que o Pi ganhou pipeline própria

O primeiro port Pi era propositalmente fino: papéis, skills e uma extensão de dispatch sem scheduler próprio. O uso real mostrou que uma entrega grande precisava de uma unidade melhor que “um único agente faz tudo”.

A evolução até `v2.6` introduziu uma pipeline de tasks com:

1. contrato canônico imutável após a admissão da primeira task;
2. worktree e processo por task;
3. recibos duráveis para dependências e integração;
4. fidelity review anterior ao executor;
5. revisão concorrente limitada;
6. correção na mesma tentativa;
7. memória temporária por run;
8. harvest verificável;
9. finalização e release separadas do planejamento.

O host espera processos e valida estado. O modelo não recebe autoridade para inventar que uma task terminou.

## Mãos, olhos e custo

Mãos alteram o produto: test-author, executor e sniper. Olhos avaliam: planner, plan-reviewer, test-reviewer, compliance, adversary, security e harvester. Shipper prepara a entrega depois que os gates foram satisfeitos.

A estratégia de custo é um barbell:

- modelos menores para volume mecânico e tarefas estreitas;
- modelos intermediários para implementação;
- modelos fortes para arquitetura, segurança, revisão e ambiguidade.

Cada runtime mantém sua rota porque nomes, providers, esforços e capacidades não são iguais. O princípio é compartilhado; a tabela concreta é local ao shell.

## TDD e fidelidade

O teste precisa nascer do comportamento esperado, não da implementação existente.

1. O plano declara a observação que prova a task.
2. O test-author cria o teste e demonstra o vermelho real.
3. Um revisor exclusivo confere suficiência, escopo e fidelidade.
4. O teste e sua closure são congelados.
5. O executor implementa contra esse contrato.
6. A captura independente reconstrói diff e resultado.

Teste verde pré-existente, mock que não toca a fronteira, skip ou redução do critério não são evidência.

## Memória

Há três classes de informação:

- **temporária da run:** shared context, payloads e recibos necessários para retomar;
- **durável do projeto:** fatos verificados em `MEMORY.md`;
- **melhoria do harness/produto:** hipóteses em `kaizen.md`, ainda sujeitas a revisão.

O harvester propõe deltas depois que a implementação está verificada. A aplicação exige paths e hashes esperados. Uma run incompleta preserva o buffer; uma run concluída o finaliza depois dos recibos finais.

Memória nunca supera o pedido atual, a spec, o plano ou o repositório. Segredos e PII não entram.

## Rails e fronteira de segurança

Hooks, plugins, regras e extensões são rails de workflow. Eles ajudam a bloquear:

- operações destrutivas conhecidas;
- acesso direto a caminhos de segredo;
- escrita fora de escopo;
- dispatch com papel/modelo inválido;
- avanço sem artefato obrigatório;
- integração de SHA divergente.

Eles não são isolamento de sistema operacional. Um processo do mesmo usuário compartilha permissões, rede, credenciais e recursos do host. Comando ofuscado, ferramenta não coberta ou extensão comprometida pode escapar de um matcher.

A fronteira de segurança é o sandbox e a política de aprovação nativos do ambiente, quando existem. No Pi, que roda com a permissão do usuário, a higiene do host e da worktree é ainda mais importante.

## Concorrência

Existem duas concorrências diferentes:

- **implementações:** processos e worktrees separados por task;
- **revisões:** até três olhos na mesma worktree/processo da task.

Concorrência reduz espera, mas aumenta RAM, CPU e disputa de quota do provider. Scopes conflitantes são serializados. Se houver contenção, a revisão pode cair para dois olhos ou modo serial.

Nenhuma fila paralela autoriza o pai a corrigir, commitar ou atualizar gates enquanto os filhos ainda executam.

## Orca: ambiente, não segundo motor

São **duas camadas, não dois motores**:

1. Orca seleciona a issue, cria a worktree, abre o terminal e mostra a run.
2. O runtime vendorizado no repositório executa a pipeline.

O selector `core/orca/select-and-dispatch.mjs` é integração de ambiente. O Pi pode ser lançado como comando do terminal do Orca; seleção e scheduling continuam pertencendo ao Orca.

## Fonte, vendor e ownership

O repositório `orobsonn/claude-harness` é a fonte. Cada shell vive em `core/<runtime>/`. Projetos consumidores recebem cópias versionadas.

Regras:

- nunca vendorizar o harness dentro da própria fonte;
- nunca editar um runtime vendorizado para mudar o framework;
- preservar configuração e memória do projeto;
- atualizar apenas paths registrados no manifesto de ownership;
- recusar diretório estrangeiro sem manifesto;
- reiniciar a sessão depois de atualizar definições carregadas no boot.

O guard do PR #927 transforma a primeira regra em recusa explícita.

## Modos de execução

| Modo | Operador | Saída |
|---|---|---|
| Pi TUI local | acompanha decisões e execução | branch/HEAD integrado |
| Pi headless | contrato da issue governa; sem perguntas rotineiras | entrega autônoma verificável |
| Codex local | valida, depura ou entrega | achados, correções e evidências |
| Claude Code cloud | assíncrono | PR draft para revisão |
| OpenCode | interativo ou headless conforme host | entrega pelo shell OC |

Headless não significa ausência de gates. Significa que decisões já registradas na issue/spec governam a execução e que qualquer necessidade de nova autoridade bloqueia o avanço.

## Não objetivos

- esconder um segundo motor de estado atrás de prompts;
- afirmar que hooks provam identidade ou isolam processos;
- transformar todo pedido em cerimônia pesada;
- exigir que todos os runtimes tenham a mesma implementação;
- usar memória como contexto mutável que supera o repositório;
- automatizar um handoff Pi → Codex sem um artefato verificável;
- trocar validação independente por voto de maioria.

## Evidência

O design atual é sustentado por:

- testes unitários e de integração dos runtimes;
- vendoring novo + segunda execução convergente;
- smokes reais de launcher;
- runs Pi completas em projetos consumidores;
- recibos vinculados a SHA e histórico de integração;
- relatórios em [`docs/pi-task-pipeline/`](pi-task-pipeline/);
- matriz explícita de capacidades Codex em [`core/codex/capability-matrix.json`](../core/codex/capability-matrix.json).

Limitações observadas continuam documentadas; uma run bem-sucedida não vira promessa universal de performance, custo ou isolamento.
