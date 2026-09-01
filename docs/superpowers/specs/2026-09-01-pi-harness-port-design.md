# Spec — Pi Harness Port

## Objetivo

Disponibilizar o harness atual como um pacote Pi utilizável em um terminal do Orca, preservando o contrato operacional: triagem, descoberta, design, plano TDD, execução, revisão independente, evidência e encerramento de uma issue.

## Decisão de portabilidade

Portabilidade 1:1 significa a mesma lógica e os mesmos papéis, não uma cópia literal da implementação do Claude Code. O Pi passa a ser somente o runtime que executa o harness dentro da worktree que o Orca abriu para a issue.

| Harness atual | Pi |
| --- | --- |
| agents TOML | agentes Markdown do `pi-subagents` |
| skills vendored | skills Pi com o mesmo texto e contrato |
| hooks/rails | extensão Pi carregada pelo launcher |
| dispatch nativo | tool `subagent` do `@gotgenes/pi-subagents` |
| worktree por issue | worktree já criada pelo Orca |
| rotina/seleção de issue | Orca continua dono; Pi executa dentro da worktree |

## Escopo v1

1. Pacote Pi na raiz do repositório, instalável por `pi install git:<repo>@<commit>` e também executável localmente por `pi-harness`.
2. Dez papéis canônicos com namespace `harness-`: planner, executor, compliance, adversary, sniper, security, harvester, plan-reviewer, shipper e test-author.
3. Skills do harness reutilizadas sem resumir ou reescrever a política de delivery.
4. Uma extensão fina que admite somente os papéis canônicos, limita a execução a uma árvore rasa e serial, e bloqueia subagents em background. Ela não cria scheduler, fila, receipt ou máquina de estados própria.
5. `@gotgenes/pi-subagents` como dependência pinada. As ferramentas declaradas nos papéis mantêm olhos sem alteração e mãos com alteração; o agente principal mantém as mesmas ferramentas abertas dos demais runtimes do harness.
6. Launcher headless para o Orca: desabilita descoberta de extensões, skills e arquivos de contexto do projeto; carrega apenas as extensões e skills do pacote; usa um `PI_CODING_AGENT_DIR` próprio para os agentes canônicos.
7. Guia de execução no Orca via `orca terminal create --worktree ... --command pi-harness`; o Orca atual suporta contas Claude/Codex, portanto Pi entra como comando de terminal, não como um provider inventado.

## Não objetivos

- Não duplicar scheduler, fleet, persistência de workflow, aprovação ou isolamento de processo.
- Não substituir a seleção, a criação de worktree ou a gestão de terminal do Orca.
- Não alegar que frontmatter, prompts ou hooks são sandbox de sistema operacional.
- Docker não faz parte da v1; é uma opção futura de hardening operacional.

## Limites assumidos

- Pi e extensões rodam com a permissão do processo. As permissões dos papéis são rails de uso do modelo.
- O launcher reduz a superfície de extensões/skills/contextos descobertos. Uma extensão arbitrária no mesmo processo não é uma fronteira de segurança.
- A integridade operacional vem do Orca (worktree por issue), dos papéis, das skills e das verificações do harness.

## Critérios observáveis

1. `npm test -- core/pi/**/*.test.mjs` comprova catálogo de papéis, limites e argv seguro do launcher.
2. `pi-harness --help` carrega Pi e as extensões pinadas sem recorrer à configuração global do operador.
3. Uma sessão Pi em modo headless recebe as skills do harness, enxerga os agentes `harness-*` e o tool `subagent`.
4. O gate recusa papel desconhecido, execução em background e tentativa de role canônica sombreada por `.pi/agents` do projeto.
5. Uma run live, iniciada pelo terminal Orca na worktree de uma issue real do Oráculo, percorre triagem → plano → implementação/testes → revisão → reporte de evidência. O critério é o transcript e os artefatos da issue; não apenas uma resposta textual.

## Riscos aceitos e rearm

O bloqueio de papéis e de parâmetros é uma proteção de workflow, não isolamento. Se o uso passar a aceitar extensões de terceiros, execução fora de worktrees Orca ou automação sem supervisão de custos, este design deve ser reavaliado antes de habilitar o fluxo.
