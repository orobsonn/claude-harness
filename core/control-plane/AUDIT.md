# Auditoria de conclusão

Esta matriz liga os requisitos comportamentais à evidência atual. Ela não é um
gate de runtime: serve para revisão e para impedir que testes estreitos sejam
usados como prova de uma afirmação mais ampla.

## Critérios mínimos

| # | Resultado exigido | Evidência offline autoritativa |
| --- | --- | --- |
| 1 | Perguntar qual issue apenas recomenda. | `Given a project question, recommendation is durable and causes no dispatch` |
| 2 | “Inicialize essa” usa a recomendação vinculada. | `Given an exact recommendation, start binds one issue, worktree, terminal and real session idempotently` |
| 3 | Retry não duplica entrega, pai ou worktree. | `Lost Orca responses reconcile by unique markers and never duplicate resources`; `Delivery replay repairs a recommendation receipt lost after reservation` |
| 4 | O pai começa pelo launcher vendorizado. | O teste de início inspeciona o comando e `launcher.test.mjs` fecha a superfície do agente geral. |
| 5 | Projeto, issue, sessão, worktree e terminal permanecem ligados. | O teste de início confere os cinco campos depois de `session.started`. |
| 6 | Ativar cron não cria scheduler concorrente. | `Existing cron activation is verified and repeated activation is a no-op without creating a scheduler`; testes de concorrência, identidade e falso positivo. |
| 7 | Cron já ativo é no-op verificável. | Mesmo teste de ativação, com uma única escrita na primeira chamada. |
| 8 | Sessão interrompida é reportada sem duplicação. | Testes de interrupção, geração rasgada e resposta perdida do novo terminal. |
| 9 | Resposta chega apenas à decisão/sessão exatas. | `Decision answer is bound to exact revision...`; `A newly revised decision never receives...`. |
| 10 | Enviada e aplicada são estados distintos. | Teste de lifecycle `queued/sent/received/applied` e bridge Pi global-parent-only. |
| 11 | Reinício reconstrói execuções e decisões. | `Restart reconstructs delivery and draft PR without merge authority` e testes de cursor/recibos rasgados. |
| 12 | PR draft é resultado, não merge. | Testes de pós-condição GitHub, owner/repo, `HEAD` da worktree exata e ausência de superfície de merge. |
| 13 | Consumer incompatível é recusado. | Testes antes da recomendação, antes da reserva e capability/preflight vendorizados. |
| 14 | Contexto não cruza projetos. | `Project-scoped portfolio does not leak another project's delivery`, schemas fechados e ausência de transcript global. |
| 15 | Desabilitar preserva operação direta. | `Disabling the general agent preserves delivery state and refuses control mutations`. |

## Requisitos transversais

- O cadastro mínimo recebe nome e caminho; GitHub e ID Orca são descobertos e
  cruzados antes de persistir. Drift é recusado antes de issues, entrega,
  retomada ou automação.
- A sessão geral recebe `harness_control` e as ferramentas nativas do Pi;
  resources, skills, prompts e extensões externas continuam desativados. O pai
  global recebe a bridge somente quando o launcher fornece um binding privado.
- Eventos têm identidade, geração, sequência, payload fechado e hash. Replay
  igual é no-op; conteúdo divergente conflita.
- O observador usa processo host e cursor durável. Ele não executa inferência
  até existir mudança material e nunca concede autoridade do operador.
- Não existem operações de merge, deploy, compra, credencial, teardown,
  descarte, limpeza ou criação de scheduler na API.
- FirstMate foi referência conceitual na revisão fixa documentada; não é
  dependência de runtime e nenhuma arquitetura de frota foi incorporada.

## Evidência ainda necessariamente real

Fixtures não provam que uma instalação específica do Orca está pareada, que um
consumer real recebeu esta versão vendorizada ou que o provedor de inferência
está disponível. Isso exige escolher um consumer fora deste repositório-fonte.
O primeiro passo do piloto é somente leitura; vendor/update e inferência são
autorizações separadas. Cron, merge e deploy ficam fora do piloto.

Comando do oráculo focado:

```bash
node --test core/control-plane/*.test.mjs core/control-plane/extensions/*.test.mjs core/pi/extensions/harness-control-plane.test.mjs
```
