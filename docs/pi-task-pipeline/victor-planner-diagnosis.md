# Retornos ao planner na run Victor

Inspeção somente leitura em 8 de setembro de 2026, até 13:05:45 UTC, da sessão Pi
`1158ce78-e11c-42ad-ad8a-4e022c0841e2`, feature `issue-222`, na worktree
`/home/orca/orca/workspaces/victor-pipeline-dados-mcp/harness-navegador-para-de-converter-video`.
O plano tem duas tasks: upload direto de vídeo e remoção de COEP, a segunda dependente
da primeira. O runtime instalado é v2.5.0, sem a nova pipeline de task-dispatch.

## O que provocou os retornos

Foram quatro chamadas ao planner e cinco ao plan-reviewer. Não foram cinco rejeições
independentes do plano: duas chamadas do reviewer precisaram ser repetidas por saída
fora do contrato ou vazia.

| Evidência | Motivo observado | Consequência |
| --- | --- | --- |
| Revisão inicial do plano | Lacunas sobre limite de arquivo, COOP, HEIC e verificações finais | Revisão necessária do plano |
| Revisão de fidelidade | Um locked test previsto no plano estava ausente | Correção do contrato/testes antes de implementar |
| Executor `76860740-00cc-41d` | `src/lib/sandbox/video-transcode.ts` estava em `fixture_paths`, embora a implementação precisasse editá-lo | O runtime congelou o arquivo e bloqueou a edição |
| Mesmo ciclo de implementação | O teste exigia `const selectedFile = a.file` e seu detector tratava essa declaração como reatribuição proibida | Oráculo contraditório; implementação correta não conseguiria passar |
| Reviewers `6bdf6def` e `d5d60687` | Resposta em prosa sem veredito reconhecido e resposta vazia, respectivamente | Repetições por contrato/transporte, sem novo defeito técnico demonstrado |

Os planners foram `700d5a4a`, `43b6e693`, `55e12eb2` e `d1f0a074`. O último executou
de 12:59:46 a 13:05:36 UTC. O reviewer `e1c784d8` havia aprovado o plano anterior;
isso não aprova automaticamente a versão corrigida.

## Inconsistência de estado e limite da correção

O plano corrigido tem SHA-256
`272be436bd08d310ea8e36350bd75f0b544f3a40d2fbfd9ff989d46f14709a6f`.
Depois dessa alteração, o gate-state legado ainda continha `fidelity_pass` e
`capture_verified` de `task-1-direct-video-upload` no commit `f6dfe884...`, sem
`plan_review_evidence` ligado ao hash corrente. Esses markers não provam fidelidade
ao plano novo. Observar a escrita do plano produz um evento; não invalida esses
markers por si só.

Na nova pipeline, aprovação, grant, admissão, ferramentas da task e integração
conferem os hashes correntes de plano/spec. O fluxo oficial fixa o plano após a primeira
admissão; uma alteração externa invalida o binding da tentativa. Esses mecanismos não
migram retroativamente a sessão legada do Victor. Não há substituição do plano na mesma
sessão após admissão: mudar esse contrato exige nova sessão e aprovação, preservando
as worktrees e evidências existentes. A mensagem do gate e a skill passaram a explicitar
esse limite; concluir as tasks não esvazia o registry nem libera uma nova revisão.

O ajuste de prosa deste PR explicita ao planner e ao plan-reviewer que
`fixture_paths` é incluído no freeze. Um arquivo de produção que precisa ser editado
não pode estar nessa lista. A mera sobreposição com um diretório amplo de
`scope_paths` não constitui defeito. O reviewer deve apontar contradições demonstradas
pelo plano e pelas evidências disponíveis, sem inventar conteúdo de testes futuros.

## Continuação correta da sessão observada

O plano corrigido precisa de nova revisão; o autor de testes precisa corrigir o
oráculo e produzir a evidência RED aplicável, seguida de revisão de fidelidade e
novo freeze. Só então cabe outro executor, preservando a implementação parcial
existente. Reutilizar os markers antigos como aprovação do plano novo seria incorreto.

Nenhum arquivo, processo ou estado dessa run foi alterado durante o diagnóstico.
As fontes locais são `execution-plan.json`, `gate-state.json` e o JSONL público da
sessão em `.pi/harness/sessions/2026-09-08T11-32-37-326Z_1158ce78-e11c-42ad-ad8a-4e022c0841e2.jsonl`,
com seus resultados de subagentes. O comportamento de freeze foi conferido em
`core/pi/lib/pi-state-records.mjs`; o de binding atual, em `task-run.mjs`,
`task-coordinator.mjs` e `extensions/harness-task-run.ts`.
