# Avaliação comportamental do revisor de testes

Esta avaliação verifica a prosa de `harness-test-reviewer` com casos pequenos
derivados da prova FULL da issue Lainny #47. Ela complementa a
[auditoria das revisões de fidelity](test-fidelity-review-audit.md), que explica
por que T1 precisou de 19 pareceres enquanto T2 foi aprovada na primeira rodada.

O prompt avaliado tem SHA-256
`bba18a60858e069a32a5d87fc80782ea673befcc861f4521dad169945aff5bab`;
o corpo após o frontmatter tem SHA-256
`d92fced28be568033747a09a2168c504dda3ba16479d57cf42ab57038802033a`.

## Método

Cada caso abriu um processo efêmero do Pi 0.84.4 com
`openai-codex/gpt-5.6-terra`, thinking `high`, a role como system prompt e o
brief do caso como única mensagem. As execuções usaram `--no-session`, sem
tools, arquivos de contexto, extensions, skills, templates ou themes. A opção
`--offline` desativou operações de startup; a inferência autorizada continuou
remota. Não houve ciclo automático. Cada chamada partiu de contexto novo.

Os briefs forneceram inline o contrato aprovado, a forma relevante do teste e
saída/exit status como dados de entrada da avaliação. São recortes de casos reais,
não uma reexecução integral das fixtures históricas. Assim, avaliam a decisão descrita pela
role sem tocar produto, worktree da FULL, gates ou provider externo do projeto.

## Casos e resultados públicos

| Caso | Entrada essencial | Esperado | Resultado público | Tokens | Custo API-equivalente |
|---|---|---|---|---:|---:|
| T2 com baseline PASS e RED alvo | `Reflect.get` do export ausente falha por `undefined`; exact Set, negativos e allowlists internas estão assertados; typecheck e diff-check passam | APPROVE | `Verdict: APPROVE` | 1.759 | US$ 0,006218 |
| Fixtures mascaram duas obrigações | teto usa `maximo:0` e passa por validação antes do guard; reread aceita a SELECT preflight como se fosse pós-conflito | REVISE consolidado | `Verdict: REVISE`; os dois defeitos vieram juntos, com correções mínimas | 1.998 | US$ 0,009166 |
| Regressão forward-only | erro cru da releitura falhava antes da correção; teste atual e produção corrigida estão GREEN, sem rollback artificial | APPROVE | Sem resposta final em duas amostras; timeouts de 600 s e 90 s | desconhecido | desconhecido |
| Código parece fiel, comandos ausentes | brief traz source/diff, mas somente a alegação do autor, sem output, status, coleta ou typecheck observado | BLOCKED | `Verdict: BLOCKED`; não inventou defeito de teste | 1.529 | US$ 0,006768 |
| Cap direto e comportamento controlável | relação direta com o cap, generic chunk já entregue sem append/copy/decode e BYOB limitado; nenhum analisador geral exigido | APPROVE | `Verdict: APPROVE` | 6.221 | US$ 0,060402 |
| Oracle Compiler API impossível | inspeciona propriedades do `Promise` em vez do tipo awaited; uma declaração exatamente conformante falha | REVISE | `Verdict: REVISE`; pede obter o awaited type e manter o RED na assinatura ausente | 3.856 | US$ 0,033052 |

Foram iniciadas sete chamadas: seis casos e uma única segunda amostra do caso
forward-only depois que o transporte voltou a responder. Cinco produziram uma
resposta pública final, e as cinco coincidiram com o resultado esperado. O caso
forward-only não foi repetido uma terceira vez e permanece sem evidência
comportamental; os timeouts, sozinhos, não demonstram um defeito da prosa.

O uso conhecido soma 15.363 tokens e US$ 0,115606. Esse valor é a estimativa
API-equivalente emitida pelo Pi, não uma afirmação de cobrança da assinatura.
As duas chamadas sem `message_end` não forneceram usage, portanto o total real
dessas tentativas é desconhecido.

## O que a amostra demonstra

Nos resultados concluídos, a role:

- encerrou a revisão com aprovação quando representação, fixture, RED e checks
  eram suficientes;
- consolidou dois defeitos de fixture numa única resposta;
- separou evidência de comando ausente de um defeito demonstrado no teste;
- não exigiu controle sobre alocação do produtor nem um analisador de fluxo
  geral para o cap;
- rejeitou um oracle que também rejeitava uma declaração conformante.

## Limites

Esta é uma amostra por cenário, não uma prova de determinismo. A role foi
executada diretamente como system prompt, sem o wrapper `subagent`; o teste não
mede gates, enforcement de routing, receipts, concorrência ou navegação real por
tools. Os fatos inline não foram reexecutados pelo modelo. A regra forward-only
continua sem veredito observado; a causa dos dois timeouts não foi determinada.

Durante a avaliação, respostas públicas finais e usage foram extraídos dos
eventos Pi. Deltas internos de raciocínio não foram preservados. Os artefatos
locais da execução ficaram em `/tmp/pi-test-reviewer-eval/`; este documento
conserva os fatos necessários para revisão do source.
