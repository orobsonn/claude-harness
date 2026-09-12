# Pi Harness — fechamento pós-dogfood e marco 3.0.0

Data: 12/09/2026. O operador solicitou explicitamente a versão 3.0.0 depois de
validar o fechamento das correções. Este marco consolida o runtime v2.6.26;
não introduz outra implementação ou inventa uma quebra de API.

Status: #207 mergeada e sessão finalizada; condição de publicação da 3.0.0 satisfeita.

## Entregas e regressões

As fases A/B/C foram entregues separadamente, conforme a orientação posterior do
operador: [#944](https://github.com/orobsonn/claude-harness/pull/944),
[#946](https://github.com/orobsonn/claude-harness/pull/946) e
[#947](https://github.com/orobsonn/claude-harness/pull/947), todas com CI e revisões
independentes aprovadas. Release Please #945 publicou v2.6.16. Dogfoods revelaram
defeitos adicionais, corrigidos nas releases seguintes; não são runs sem assistência.

Últimos fixes:

- #962/v2.6.24: reconciliação global de base/memória e recuperação de task integrada
  indevidamente reaberta, preservando proveniência sem writer fictício.
- #964/v2.6.25: fechamento LIGHT com captura válida e nenhum olho de implementação
  obrigatório, sem inventar uma aprovação para limpar re-gate.
- [#966](https://github.com/orobsonn/claude-harness/pull/966)/v2.6.26: a operação
  global existente pode incorporar a base antes do primeiro final review. Remove
  somente a pré-condição circular, mantendo pai global, SHAs exatos, árvore limpa,
  preview, paths seguros e patches pequenos vinculados ao hash.

No #966: baseline52/52; dois casos novos RED→GREEN; focal130/130
(118 de memória/adapter/recibos +12 de assets executados separadamente);
Pi1160/1160 (315,037s); repositório3748/3748 (479,226s), sem skips locais.
Adversary e compliance independentes aprovaram após 14 casos cada. CI34708043394
verde6m23s (3746PASS/2smokes Orca SKIP, ambos verdes na VPS). Package644arquivos,
vendor160arquivos, bootstrap Pi0.84.4/subagents21.2.0/11papéis, agentes
materializados, scan de secrets e diff-check verificados. A extensão distribuída
foi carregada pelo Pi e fez merges reais em fixtures, antes/depois de final review.

Release Please967 mergeou a v2.6.26 em
`0eb891834f3baaabe209bf12e6d2dcfa1a595875`; tag e GitHub Release latest confirmadas,
package/lock/manifest/changelog coerentes. CI34708689123 verde4m49s.
Vendor oficial Victor [#345](https://github.com/orobsonn/victor-pipeline-dados-mcp/pull/345)
mergeou em `8b82c857ca2c350c6b804b58d2cd311635bacefd`, após CI34709042210
verde8m56s,275arquivos/2830testes. Main e pai #207 sincronizados por lifecycle,
stamp idêntico; arquivos locais do operador e estado nativo preservados.

## Resultado contra o briefing

| Obrigação | Evidência e limite |
| --- | --- |
| Reconciliação no host | Dependências e merges globais reutilizam as operações existentes. #206/#208/#210 resolveram memória no host; #207 incorporou base antes dos olhos, sem child merge/writer. Logs originais #275 apagados: causa exata dos três briefs históricos não recuperada. |
| Complexidade canônica | Ausência no test-author herda; mismatch explícito rejeita. Low/medium Terra/high; high/max legado Sol/high. #207 medium Terra e #210 high Sol comprovados em dispatch real. |
| Scorer do Claude | Mesma lógica `analyzeSource`, ferramenta recebe path de arquivo real e explicita aproximação de arquivo inteiro. Planner e reviewer usaram na dogfood; pressure max decompôs, high atômico justificado permaneceu inteiro. |
| MV/MP | Read-only/advisory/fail-open, reviewer somente INITIAL. Autenticação MV e leitura real de nota comprovadas; ausência/timeout não bloqueia. #207 consultou MV autenticado; resultados pouco pertinentes não são aprendizado alegado. |
| Prosa de planejamento/testes | Menor prova fiel, corte por responsabilidades, sem quotas de tasks/ataques/rodadas. Preservada atomicidade e propriedade exclusiva de paths congelados. |
| Typecheck | Formas argv seguras cobertas, injeção de shell negada. Prova real XOR TypeScript: correto passa, mutante falha, restauração passa. |
| Parecer e follow-up | Negativo recente supersede aprovação; follow-up diagnóstico preserva aprovação. #208 e #207 reais mantiveram follow-up sem revisor extra para reformatação. |
| Fidelidade/test-only | Duas recuperações consecutivas, commit→capture→reviews e olhos não afetados preservados. #208 corrigiu fixture sem writer de produto; LIGHT #207 integrou sem aprovação artificial. |
| Writers | #207 recuperou integração/reconciliação sem novo executor/sniper. No-op antigo da #208 continua contabilizado, não apagado da história. |
| Memória | Full replacement negado; patch/append pequeno com hash atual ou no-op. #207 fez append depois dos olhos finais, sem revisão humana e sem novo ciclo de olhos pelo delta exato de memória. |
| Leitura/evidência | Repo e pacote canônico legíveis, globs legítimos, ENOENT distinto de acesso negado e symlink para secrets recusado; sem Bash amplo para eyes. |
| Pai e rotas | Terra/high efetivo em Orca. A prova histórica untrusted é a #317 iniciada com `--no-approve`, não uma afirmação de trust instrumentado em todas as cinco runs. Override nativo preservado; planner Sol/high, reviewer Astra/high, compliance Terra/high e test-reviewer Luna/xhigh mantidos. |

## Dogfoods recentes: custos e tempo

JSONL nativos pai+filhos+dispatches deduplicados, tokens incluindo cache. Excluem o
trabalho Codex de desenvolvimento do harness. Dispatches são tentativas registradas,
incluindo chamadas recusadas antes de consumir modelo quando houver registro.

| Issue | PR | US$ | Tokens | Dispatches | Launches | Parede | Até freeze |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| #206 | #341 | 11,58201684 | 17.830.509 | 26 | 4 | 3h17m14s | 16m30s |
| #208 | #342 | 11,74605156 | 17.274.398 | 25 | 3 | 4h04m45s | 17m54s |
| #210 | #340 | 8,13044756 | 12.116.624 | 19 | 2 | 3h47m04s | 17m04s |
| #212 | #338 | 6,67190900 | 9.151.508 | 15 | 1 | 49m05s | 21m07s |
| #207 antiga, sem produto | — | 3,45978792 | 4.067.292 | 6 | 2 | interrompida | — |
| #207 nova | #346 | 6,32220700 | 10.001.784 | 15 | 3 | 2h22m11s | 13m09s |

#207 total, incluindo a tentativa antiga: US$9,78199492,14.069.076tokens,
21dispatches e5launches. As cinco issues completas, incluindo essa tentativa:
US$47,91241988,70.442.115tokens,106dispatches e15launches; não são um único
escopo equivalente à baseline. Na nova #207: um executor63,699s; harvester15,296s;
shipper663,023s, majoritariamente CI. Nenhum novo launch/writer na recuperação v2.6.26.

Tempos de parede incluem pausas para corrigir/revisar/publicar/vendorizar o harness.
Freeze usa timestamp Git do primeiro commit com fidelidade validada, precisão de
segundos. A baseline não informa primeiro freeze e seus logs não estão disponíveis.

Baseline #275 fornecida:3h42m56s,79.179.021tokens,US$66,6475,83dispatches,
11launches,4tasks. Sol custou US$54,8937 em todos os papéis; o pai custou
US$24,9502. Não atribuir todo o custo Sol exclusivamente ao orquestrador.
As issues recentes têm escopos menores/diferentes: não inferir redução causal
de custo/tempo de uma comparação direta. A evidência relevante é a convergência
dos fluxos corrigidos, sem ocultar overhead anterior ou assistência operacional.

## Fechamento nativo #207

Sessão preservada `2cdf20c3-23b8-4167-81ea-ce28afa4d4f8`, mesma task/captura.
v2.6.25 integrou task-1 às17:07:06 sem novo launch. v2.6.26 retomou às17:56:36,
preview17:56:59 e merge global17:57:02 no HEAD
`718b46048afe604aa4f2f6222d7cd435c45e4582`, sem conflitos ou writer.
Cleanup14/14, upstream auth/cancel24/24 e typecheck verdes. Final compliance31,3s
e adversary45,9s aprovaram17:59:14. Follow-up preexistente ficou não bloqueante.
Harvest15,3s propôs append hash-bound, aplicado17:59:53 e commitado em `5ecddd4`.
Shipper começou18:00:31 e terminou18:11:36. CI34709927901 verde8m54s:
275arquivos/2831testes,505,51s de suíte. PR346 mergeado18:11:17 em
`260a54ddd2a217742de3d18cb15bbafe712efd54`. Finalização nativa confirmou
`finalized:true` às18:11:47.576; mensagem final18:11:51.993, árvore limpa.
O PR não tinha closing keyword; o monitor fechou a issue como concluída após
confirmar merge/CI/finalize, sem alterar produto ou recibos.

## Desvios e limites explícitos

- As cinco runs não foram integralmente livres de bugs: parser/omissão de security
  em tasks v2.6.22, no-op38,868s e tentativa de rebase recusada da #208 antiga,
  recuperação de memória, deadlock LIGHT e pré-condição circular da #207 estão
  no histórico/custo. As correções são posteriores e não reescrevem esse histórico.
- A TUI antiga não registrou um input de retomada. Encerrar o processo e abrir um
  terminal novo com a mesma sessão resolveu operacionalmente; causa exata não
  estabelecida. Orca não confirmou foco visual da aba, mas o log comprova execução.
- `git rev-parse HEAD` foi recusado pelo Bash rail; o pai usou `git log -1 --format=%H`
  e seguiu sem writer. Overhead não bloqueante, não tentativa de child merge.
- Race SELECT/UPDATE do cleanup é preexistente e fora do delta temporal. Mantida
  como follow-up no receipt/relatório, sem automação de issue nem correção disfarçada.
- Conector local `victor-mcp` inacessível: não atualizado nem validado ponta a ponta
  com Meta real. Nenhuma campanha, banco ou deploy foi alterado.
- Avisos npm de vulnerabilidades preexistentes não equivalem a auditoria ou correção
  dessas dependências. Não houve mudança de dependências nesta entrega.
- Não há garantia de zero bugs ou paralelismo ilimitado. VPS2vCPU/~8GiB;
  concorrência de suítes completas afeta latência e deve ser observada separadamente.

## Publicação 3.0.0

Fechamento real #207 confirmado. A versão será declarada via `Release-As: 3.0.0`
no squash de PR normal; Release Please é o dono de versionamento, changelog e tag.
Não há alteração de runtime adicional em relação à v2.6.26. Atualização de consumidor
continua exclusivamente pelo lifecycle/vendor oficial, sem estado de sessões.
