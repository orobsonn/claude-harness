# Pi: evidência estrutural de planejamento após pesquisa-pos-evento

## Decisão

Adicionar `harness_plan_analysis({ feature_id })` exclusivamente ao planner e
plan-reviewer, pela extensão de ferramentas de planejamento já existente. A tool
é read-only, local, advisory e não depende de MCP. Não muda scorer, rotas,
aprovação, receipts, grants, ownership ou a política de retomada.

Problema observado: a run pesquisa-pos-evento retornou repetidamente à task 1.
Isso incluiu defeitos reais, contradições de fixture, escopo insuficiente e a
parada de continuação corrigida no PR #987/v3.0.7. Um mapa de relações não elimina
essas causas, mas reduz o levantamento manual de dependências e proprietários.

## Contrato e limites

Entrada: ID da feature; caminho derivado por `piExecutionPlanPath`. O planner
primeiro grava seu rascunho no caminho canônico. Não precisa de aprovação para
analisá-lo. Identidade e disponibilização dos papéis reutilizam o bootstrap e a
política existentes; o reviewer não ganha escrita nem Bash.

Saída:

- hash do plano e hashes dos arquivos lidos; base explicitamente no checkout atual;
- dependências e ancestrais declarados, não dependências inferidas do produto;
- paths compartilhados, com scope/allowed_writes/frozen separados e indicação de
  ordenação transitiva; ciclos não contam como ownership sequencial válido;
- donos dos testes/fixtures, inclusive cobertura de diretórios pelo mesmo
  `checkScope` usado no runtime;
- critérios compartilhados e paths de provas declarados por task — **não** uma
  associação assertion→critério que o schema não fornece;
- referências lexicais exatas a paths declarados, com arquivo/linha e donos;
- cobertura, ausências, exclusões, limites e omissões explícitas.

Referência lexical não é import resolvido. Pode estar num comentário ou fixture.
A tool não resolve aliases, imports sem extensão, paths computados, chamadas ou
SQL sem path literal. Não lê código arbitrário nem tenta inferir contratos de
arquivos futuros. Ausência de referência não prova independência. Permissão para
escrever um arquivo não prova que a task realmente vai alterá-lo.

O validador compartilhado é reutilizado com a estratégia do plano, como no gate
Pi atual. Seu resultado é diagnóstico; erros de rascunho não impedem o mapa. IDs
duplicados/ambíguos ou JSON inválido retornam indisponibilidade advisory. Não se
criou segundo schema de aprovação. O roteamento canônico continua com sua
autoridade atual, não com este relatório.

Orçamento técnico, não quota de engenharia: plano até 1 MiB, 128 tasks e 512
paths declarados; leitura de até 128 arquivos regulares, 256 KiB por arquivo e
8 MiB totais; 256 referências e 48 KiB de resposta. Acima de 1.024 claims de
testes/fixtures, a validação diagnóstica pareada é omitida explicitamente para
não monopolizar CPU; o mapa continua. Limites não reprovam nem obrigam split.
O truncamento usa redução por seção/busca binária, não serialização quadrática.

Leitura reutiliza a política dos eyes e recusa symlinks, arquivos especiais,
secrets e runtime interno. Não expande diretórios nem varre o repositório inteiro.
`O_NOFOLLOW` e checagem dos ancestrais cobrem symlinks estáticos; isso não é um
sandbox contra um processo hostil trocando diretórios concorrentemente.

## Alternativas rejeitadas

- Outro score de qualidade arquitetural: falsa precisão, sem oráculo objetivo.
- AST/import graph novo: dependência/parser inexistente no harness e insuficiente
  para fixtures que leem SQL por caminho. Referências lexicais delimitadas bastam
  nesta primeira versão; não são anunciadas como análise semântica.
- Busca global de referências ou path-scoped policy engine: escopo e custo maiores
  que o defeito observado. O modelo mantém `grep/read` para investigação focal.
- Reprovar shared paths/criteria automaticamente: ownership sequencial e provas
  em camadas são frequentemente corretos.
- Replanejar a run admitida com base no mapa: destruiria ownership e evidências.

## Aplicação real, retrospectiva

Execução read-only no checkout do pai da run pausada, sem chamar modelos,
vendorizar ou retomar a sessão:

```sh
node --input-type=module -e '
import { analyzePiPlan } from "./core/pi/lib/plan-analysis.mjs";
console.log(JSON.stringify(analyzePiPlan({root: process.argv[1], featureId: "issue-19"}), null, 2));
' /caminho/do/checkout/harness-pesquisa-pos-evento
```

Plano: SHA-256
`eac8235603e75177b26060f99292e8b07c6c9af40a83959eb3743fcdf04798ea`.
Medição local observada: aproximadamente 240 ms; resposta compacta 36.787 bytes;
76 arquivos/1.162.320 bytes lidos, 27 paths ausentes, sem truncamento de saída.
Variação de tempo é esperada; não é benchmark universal. Nenhum token de modelo
foi gasto para calcular o mapa; fornecê-lo a um modelo tem custo de contexto.

Nove tasks em cadeia; cinco arquivos compartilhados, todos ordenados:

| Arquivo | Tasks declaradas |
| --- | --- |
| `src/worker.ts` | 1, 2, 7, 8, 9 |
| `src/db/index.ts` | 1, 7 |
| `src/db/criar-pesquisa.ts` | 1, 3 |
| `src/db/ativar-pesquisa.ts` | 1, 4 |
| `src/db/registrar-resposta-pesquisa.ts` | 1, 5 |

**Correção de uma hipótese inicial:** a migration não está declarada como arquivo
compartilhado entre tasks 1/4/6. Aquela ilustração não era um fato do plano.

Onze critérios compartilhados. Relações relevantes para investigar:

- `#ac-answer-protocol`: tasks 1, 5, 8;
- `#ac-revision-authoring`: tasks 1, 3, 5;
- `#ac-bounded-jobs`: tasks 1, 2, 3.

A task 1 tem seis critérios declarados e cinco paths congelados únicos. Esses
números não determinam excesso. A questão de engenharia é se ela precisa provar
protocolos de consumidores posteriores antes de suas fronteiras existirem.

Vinte e duas referências lexicais exatas encontradas. Por exemplo,
`src/db/pesquisa-criacao.spec.ts:24` (task 3) referencia
`migrations/0009_pesquisa_pos_evento.sql` (task 1). O teste de migration da task 1
também referencia esse SQL. Isso torna visível uma relação de consumo; não prova
que ambas as tasks devam editar o SQL nem que o teste esteja errado.

## Ajudaria?

**Sim, como evidência focal:** mostra ao planner/reviewer os contratos distribuídos
em camadas, seus donos e quem mantém a prova quando um consumidor revela uma
divergência. A prosa agora pede distinguir atomicidade de rollout de atomicidade
de desenvolvimento e conferir onde o contrato é implementado, provado e corrigido.

**Não comprovamos prevenção dos 13 launches ou economia em dólares.** A aplicação
foi feita após implementação/revisões, não na baseline original do primeiro planner.
Os 27 arquivos ausentes impedem uma análise completa dos futuros consumidores.
Contradições semânticas de tests e bugs SQL (como NULL em guards) exigem inspeção e
provas comportamentais. A tool não os resolve. Validar melhora comportamental
exigirá outra execução controlada; a run cara permanece pausada por ordem do operador.

## Revisão e regressões

Desenho submetido a adversarial independente read-only. O adversário corrigiu a
hipótese de migration compartilhada e encontrou um bug de cobertura de fixture
de diretório; implementada a mesma semântica de prefixo do runtime com regressão.
Testes incluem rascunho, grafo transitivo/ciclo, donos concorrentes, paths glob vs
literal, duplicata de assertion no mesmo dono, fixture-dir, missing vs denied,
symlink final/intermediário, byte/file/output/reference budgets, estratégia Pi,
ausência de MCP, identidade dos dois papéis e ausência de mutação de estado.
Bootstrap/vendor verificam a ferramenta nos agentes materializados, não apenas
nos templates. Não foram alterados testes ou plano do projeto consumidor.

Validação final local: suíte completa 3.819/3.819; pacote dry-run 653 arquivos sem
estado/sessões indevidos; vendor temporário 164 arquivos e `--verify` verde.
Revisão adversarial final sem findings materiais. O A/B real de quatro reviewers
está em [retrabalho além do planejamento](2026-09-15-pesquisa-rework-beyond-planning.md).
O sinal de benefício foi fraco; por isso a prosa final deixa seu uso opcional,
focal a perguntas de dependência/ownership, não obrigatório por rotina.
