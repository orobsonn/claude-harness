# Contrato canônico de testes e recuperação de captura legada no Pi

## Contexto observado

A run `pesquisa-pos-evento` expôs duas causas diferentes de retrabalho:

1. o brief de correção entregue ao test-author podia resumir a obrigação aprovada
   de forma mais fraca que a task canônica; o reviewer via o mesmo resumo e podia
   aprovar uma prova insuficiente;
2. após uma correção de produto por sniper, o pai iniciou o test-author antes de
   registrar `capture-verified`. A implementação e a correção de teste terminaram
   válidas, mas o integrador não possuía uma recuperação legítima para a captura
   historicamente ausente.

Na ocorrência sanitizada, o commit de produto foi `41b1947`, o HEAD final foi
`aa4df92`, o delta posterior ao produto continha somente o teste congelado, a
evidência focal estava verde e o compliance estava atual. A task tinha três
lançamentos. Repetir writer, test-author ou reviewer não mudava esses fatos.

## Correção

- O plan gate devolve a task canônica validada. O dispatch do test-author e do
  test-reviewer injeta esse objeto completo em bloco host-owned, substituindo
  qualquer bloco stale ou texto que tente simular o marcador.
- Antes de um test-author corretivo, qualquer executor/sniper elegível ainda sem
  captura bloqueia o dispatch. Isso cobre inclusive a mão que já commitou seu
  próprio delta e portanto não deixa paths sujos.
- A inspeção aceita uma recuperação legada estreita quando a captura pré-author
  nunca foi tentada, existe prova nativa do commit de produto, o primeiro author
  congelou exatamente esse commit, o HEAD final acrescenta somente testes
  congelados e não existe writer posterior. Olhos e evidências finais continuam
  obrigatórios.
- A recuperação não grava marker retroativo, não fabrica writer e não altera a
  fidelidade ordinária. Ela apenas deriva a origem verificável que o integrador
  precisava para avaliar o histórico existente.

## Limites de segurança

A prova de commit usada somente nessa compatibilidade legada reconhece uma forma
fechada: `git commit -m` isolado ou o encadeamento observado de `git add`, commit,
status e log por `&&`, com resumo nativo `[branch sha]`. Shell chain alternativo,
comentário, pipe, redirecionamento, substituição, glob, opção injetável, saída de
`git show/log` e sobreposição temporal com o author são recusados.

Também são recusados: implementação `BLOCKED`, ausência de prova do commit,
inferência HEAD→HEAD, product drift, writer posterior, review negativa/missing,
plano/spec divergente e delta fora dos testes congelados.

## Evidência

- Focais finais: 139/139 verdes.
- Suíte Pi final: 1.250/1.250 verdes, zero falhas, skips ou cancelamentos.
- A fixture sanitizada da run real retorna origem recuperada `41b1947` →
  `aa4df92`, preservando os três lançamentos e o compliance atual.
- Adversary independente: `APPROVE`, após encontrar e exigir o fechamento de
  bypasses por marcador textual, HEAD→HEAD, `BLOCKED`, overlap, comentário,
  chain e glob/output forjado.
- Compliance independente: `APPROVE`, sem gaps materiais.

Essas provas demonstram a recuperação desta classe histórica e impedem a nova
ordenação errada. Não demonstram convergência universal de qualquer run. A run de
produto não foi retomada por esta alteração; retomada ou execução nova permanece
uma decisão explícita de validação após release e vendor oficiais.
