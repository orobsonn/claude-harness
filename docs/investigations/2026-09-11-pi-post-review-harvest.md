# Pi: harvest depois da revisão final

Base: `23e35357a25e77badcc0246456fba4101ccc3d84` (v2.6.20).

O operador identificou na dogfood Victor #317 que o harvest ocorria antes dos
olhos finais, portanto antes de possíveis correções. O Pi mandava fazer assim
na prosa e bloqueava olhos sem harvest. Claude Code já possui a ordem desejada:
revisão final, correções/revalidação, harvest e shipper. Este patch segue essa
ordem, sem acrescentar uma etapa de revisão após o commit de memória.

## Ajuste e preservação

Harvest ordinário exige aprovação final atual no início e na conclusão. O recibo
host-owned vincula o input aprovado ao restante do snapshot, excluindo somente os
paths efetivamente alterados pela proposta; no-op não exclui nenhum arquivo.
A validação existente exige proposta exata commitada, hashes atuais, plano intacto
e árvore limpa. Os blobs de HEAD/index e o worktree precisam corresponder ao
`after_sha256`, com arquivos regulares não executáveis.

O commit autorizado de memória preserva os recibos originais, sem reescrevê-los.
`missing roles`, marcador e shipper usam a mesma prova. Novos negativos continuam
superseding; produto, spec/plano e memória fora da proposta não são dispensados.
Finalize guarda ligação mínima de digests no tombstone para replay, não cópia dos
documentos. Preservada a exceção existente de release-only verificada após squash.

Sem novo reconciliador, quotas, tarefas documentais ou writer de memória.
Patch/append hash-bound, limites de 8 KiB/24 KiB e no-op válido permanecem.

## Evidência de teste

- Baseline focal: 132/132 verdes; nova reprodução RED permitia harvest sem olhos.
- Focal recuperado: 222/222 antes da última ampliação dos testes de proveniência.
- Adversary independente reproduziu dois bypasses na implementação intermediária:
  documento fora da proposta omitido do digest e conteúdo commitado diferente do
  worktree sob `assume-unchanged`. Ambos RED antes do ajuste e GREEN depois.
- Revalidação adversary de `425f8c7`: 12/12 verdes, sem finding material restante.
- Compliance anterior: 29 testes de memória/release-only verdes, sem finding.
- Pressure Terra/high real (host injetado, filhos não executados): `final-eyes`
  14,279 s chamou olhos; `post-review-harvest` 14,768 s chamou harvester Luna/high;
  `post-harvest-shipper` 7,208 s chamou shipper sem outra revisão/writer.
- Vendor oficial em fixture: 160 arquivos; agentes materializados na ordem nova,
  scorer/MV preservados, sem auth copiada. Launcher: Pi 0.84.4, subagents 21.2.0,
  11 roles. Package dry-run: 643 arquivos, sem state/sessions/worktrees.

O operador removeu a worktree/branch durante as suítes. Produção recuperada do
artefato materializado; imports de vendor revertidos aos imports canônicos;
testes/probes recuperados e suites reexecutadas. Falhas ENOENT dessas execuções
interrompidas são ambientais, não evidência de regressão de produto. Nenhuma cópia
manual foi feita em consumidor. Resultados finais das suítes e CI constam no PR.

## Dogfood #317 concluída antes deste ajuste

PR Victor #333, squash `f6611bfd08e35c3987f7b25c5139c0795d43db41`, 20:47:05 UTC.
CI `34645259304` verde, 8m22. Suíte final local: 269 arquivos / 2696 testes,
912,01 s, typecheck verde; adversary/compliance/security finais `issues: []`.
Finalize nativo às 20:47:26; pai encerrou às 20:47:30. Sem deploy/migração/Meta.

| Indicador | Baseline #275 | #317 |
| --- | ---: | ---: |
| Custo completo | US$ 66,6475 | US$ 34,86851888 |
| Tokens | 79.179.021 | 53.569.222 |
| Dispatches | 83 | 60 |
| Task launches | 11 | 15 |
| Tasks integradas | 4 | 4 |
| Wall clock | 3h42m56s | 5h56m04s |
| Pai efetivo | Sol/medium | Terra/high |
| Custo só do pai | US$ 24,9502 | US$ 7,1088252 |

Contagem JSONL pai+filhos+dispatches, deduplicada por session/entry. Papéis por
recibo host-owned ou prompt exato do pai, nunca inferidos pelo modelo. Input
5.870.644, output 327.570, cache read 47.371.008; reasoning 138.108 é subconjunto.

Issues diferentes e run assistida: custo menor não é prova causal controlada.
Wall inclui manutenção/release/vendor do harness e não melhorou. Primeiro freeze
aproximadamente 98m06 após início, incluindo pausa de cerca de 65 min no scorer;
baseline desse indicador indisponível por logs removidos. Run iniciou v2.6.16,
tasks pinadas v2.6.17, retomada do pai com launcher oficial v2.6.20. Não foi inteira
na versão final e não valida a nova ordem deste patch; os probes são separados.

### Resultado e limites

- Zero merge real por filhos; uma reconciliação host-owned concluída.
- Zero falso bloqueio por complexity ausente/typecheck seguro; author high Sol/high,
  medium Terra/high; reviewer Luna/xhigh. Scorer real de arquivo e MV utilizados;
  MP ausente fail-open. Scorer exigiu correção adicional antes da retomada.
- Zero executor/sniper só para confirmar HEAD limpo. Um test-author sem delta,
  101,7 s, decorreu de brief incorreto e permanece desperdício real registrado.
- Dois harvests após mudanças materiais, sem full replacement; o primeiro foi
  prematuro segundo a ordem agora corrigida. Sem rerun só para limpar follow-up.
- Achados reais: limite Graph de 101 itens, tipos de fixtures, matchers SQL e
  restauração global de mocks. Corrigidos antes da aprovação/merge.
- Security local da task 4 não teve dispensa expressa justificada no plano;
  security final obrigatório executou e aprovou. Não afirmar dispensa explícita.
- Paradas em marcador/re-gate, barreira de reconciliação e recovery test-only após
  merge foram corrigidas nas releases v2.6.18–v2.6.20, preservando tasks/proveniência.

Fases A/B/C: PRs harness #944/#946/#947. Ajustes operacionais #948/#950/#952/#954.
Release Please #945/#949/#951/#953/#955; última release anterior v2.6.20, vendor
Victor #332. Não declarar validação de várias issues concorrentes: não foi executada.
