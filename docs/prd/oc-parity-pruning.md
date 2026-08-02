# Poda da lane OpenCode até a paridade com a lane Claude Code

**Status:** plano aprovado, não iniciado
**Data:** 2026-07-28
**Origem:** duas sessões OC reais que não entregaram código (`feed-collapse-spec-adversary` aqui,
`Implementar issue mais antiga` em `aidee-carla-sistema`)

---

## Diagnóstico

A lane OC **nunca foi uma portabilidade** da lane CC. Foi reimplementada com uma arquitetura extra.

| | Claude Code | OpenCode |
|---|---|---|
| Agentes | 9 | 30 |
| Rails (código, sem testes) | 228 KB | 475 KB |
| Módulos dual / loop / adversary-nudge | **0** | **90 KB** |
| Skill `orchestrating-delivery` | 96 KB | 86 KB |

A prosa da OC é **menor** que a da CC — prosa ambígua não é a diferença entre as lanes. Todo o delta
é mecanismo, nascido em `feat: implement ADR-003 dual enforcement for OC gates` e seguido de
**27 commits** de fix na mesma superfície.

### Os dois motores da divergência (são distintos — não confundir)

1. **Plan-review — o dual é o motor.** O loop só fecha quando as duas famílias aprovam na mesma
   rodada. Evidência (`ses_0599b2df`): r1 (f1 aprova, f2 reprova) → r2 (f1 reprova, f2 aprova) →
   r3 (ambos aprovam, f1 com relatório **idêntico** ao da r1).

2. **Spec-adversary — o dual NÃO é o motor.** Em `ses_0599b2df` a family-1 voltou com achado
   pendente nas 7 rodadas: com olho único teria feito as mesmas 7. O motor aqui é *cada rodada
   reescreve a spec e cria superfície nova*, com um teto que avisa e **não recusa**
   (`loop-decide.mjs:389-394`: "The ADVERSARY loop has no deterministic refusal").
   Em `ses_056318bb` o dual **foi** o motor (family-1 limpa nas rodadas 1, 2 e 4, mesmo
   `report_hash`, loop seguiu até 5). Os dois fatores coexistem.

> **Consequência:** tirar as duas famílias resolve o plan-review e **não** resolve o adversary
> sozinho. O adversary exige que o teto passe a recusar.

### O custo observado

O loop não só gasta rodadas — **destrói a spec**. Após 4 reescritas sob ataque, o adversário
reportou *"nenhuma implementação consegue satisfazer as três regras"*; o planner falhou 2× com
`planner returned no parseable full plan`; a run morreu em `delivery-blocked` com zero código.

### Correção de leitura

O orquestrador ignorar o `adversary_nudge` ("ACCEPTED, do NOT re-attack") **não é desobediência
burra**: o nudge é primary-only por design (`secondary-family-never-drives-the-loop`) enquanto o
harness dispara obrigatoriamente uma segunda família dizendo "tem problema". Dois sinais em
conflito; o modelo seguiu o mais conservador.

---

## Decisões do dono (2026-07-28)

1. **Uma única família avaliadora.** Ela **deve** ser de família de modelo diferente do orquestrador
   (orquestrador OpenAI + avaliador Grok, ou o inverso).
2. **Segundo olho: opt-in DESLIGADO**, não removido. É o que a lane CC faz
   (`HARNESS_CODEX_ADVERSARY`, off por padrão) — logo é *mais* paridade, não menos. Campo opcional
   (`roles.<role>.secondEyeModel`), ausente por padrão: nunca despacha, nunca conta rodada, nunca
   bloqueia. ~12 linhas, decisão reversível sem reabrir 90 KB.
3. **`test-author` sobe para o modelo dos olhos.** O teste congelado é o oráculo que torna a mão
   barata segura; quando ele roda, ainda não existe teste que pegue erro dele. A lane CC protege
   esse papel pelo mesmo motivo.
4. Simplificar a lane OC ao máximo de semelhança com a CC, respeitando limitações reais de cada
   plataforma.

### Fato de plataforma verificado (derruba a premissa dos 30 agentes)

No OpenCode **1.18.8**, `opencode run` só rejeita `mode === 'subagent'` (`mode: 'all'` passa), e
**`--model` sobrepõe o modelo do agente** — probado ao vivo: agente declarando `gpt-oss:20b`
executado com `--model gemma4:31b` rodou em gemma4. As regras "mode must be primary" e o sufixo
`${base}-spawn` são **convenção do harness, não da plataforma** — é o que `spawn-hand.mjs` da CC já
faz com `claude -p --model`. Os 7 arquivos `-spawn` são removíveis.

**Ressalva:** a tool `task` (dispatch in-session) **não** tem campo `model` — os agentes de mão
mantêm `model:` no frontmatter como fonte de verdade desse caminho, senão o barbell degrada em
silêncio.

---

## Regras duras da poda

Violar qualquer uma destas troca um problema visível por um problema invisível:

- **`loop-guard.ts` NUNCA é deletado.** É o único chamador em runtime de `loop-decide.mjs`
  (`reserveReviewAttempt` :281, `consumeReservation` :295) e o único produtor de `review_outcomes`,
  `adversary_loop_count`, `plan_review_count`, `primary_review_failure_streak` e do K=3 de
  dispatch-failure. Deletá-lo desliga review-cap, primary-failure-cap e reservas atômicas —
  **e os testes continuam verdes**, porque importam a lib direto. Renomear para `review-guard.ts` e
  podar o que é dual *dentro* dele.
- **`review-accounting.test.mjs` (64.8 KB) é REESCRITO single-family, nunca deletado.** É o único
  teste que exercita o review-cap.
- **Os 3 `skill-regate-*.test.mjs` e `skill-obs-paths.test.mjs` são reescritos, nunca deletados.**
  O regate pós-sniper é ortogonal ao dual e continua valendo.
- **`scripts/parity-manifest.mjs` é atualizado, nunca deletado** (roda no CI).
- **`core/shared/lib/merge-verdicts.mjs` NÃO é tocado.** Serve o `codex-adversary` da CC e o
  `review-cross-family.mjs` do VPS, que continuam bi-família por design. O colapso do enum é
  **escopado ao gate-state da OC**.
- **`primary_failure_cap` NÃO é aparato dual** — com um olho continua 100% válido (3 retornos
  inutilizáveis consecutivos). Reescrever em versão single-evaluator, não apagar.
- **Nenhum PR mergeia com contagem de falhas acima da baseline registrada.**

---

## Passo 0 — Pré-condições (BLOQUEANTE, antes de qualquer deleção)

Sem isto, a poda quebra os projetos já vendorizados e o motor do VPS.

1. **`vendor-core.mjs` — o furo dominante.** O vendoring é puramente aditivo: `copyOcTree` (:394)
   nunca apaga arquivo que só existe no destino, e `OC_RETIRED_FILES` (:792) é uma lista hardcoded
   de **dois** itens. Todo arquivo que esta poda deletar **sobrevive** no `.opencode/` de qualquer
   projeto vendorizado após o `updating-harness` — inclusive `loop-guard.ts`, que passaria a
   importar um `dual-merge.mjs` inexistente e derrubaria o registro do plugin inteiro.
   → Adicionar os ~20 paths a `OC_RETIRED_FILES` **antes** de deletá-los do core.
   Este repo também é auto-vendorizado (`.opencode/.harness-version`), então é afetado.

2. **VPS.** `core/vps/cron-a-dispatch.mjs:847` lança em `routing.version !== 1 && !== 2` — runtime
   de produção, não teste. Engine do VPS e harness vendorizado atualizam **independentemente**.
   → Preferir **não bumpar**: manter `version: 2` e tornar `families` opcional no schema
   (`oneOf: roleSimple | roleFamilies`). Se bumpar for inevitável, soltar primeiro um release só
   com adaptadores tolerantes (v3 aceito, ainda não emitido).

3. **Baseline.** `node --test "core/opencode/**/*.test.mjs"` hoje: **767 testes, 759 pass, 8 FAIL**
   — justamente na superfície que o passo 5 reescreve:
   `lt-factory-hook-absolute-path-scope`, `JSON envelope escapes newline…`,
   `re-gates match only the same feature/task…`, `expired completed session cleanup…`,
   `concurrent reopen wins…`, `cleanup never renames a foreign child index…`,
   `cleanup discards claimed old own index…`, `session.updated waits for cleanup lifecycle lock…`.
   → Consertar ou quarentenar formalmente, e registrar a baseline no PR do passo 1.

---

## Sequência

### Passo 1 — Consertar o contador do adversary (**não** apertar caps)

> **Proposta anterior REJEITADA pelo dono, com razão.** Eu havia proposto `plan_review.deny` 10→2 e
> `adversary.deny` 4→2. Os dois estavam errados, e a verificação na lane CC provou:
>
> | | Claude Code (funciona) | OpenCode (hoje) |
> |---|---|---|
> | Cap de **adversary** | **nenhum** | `deny: 4`, **run-wide** |
> | Cap de **plan-review** | soft-warn em 3 (`allow: true`), deny em 10 **só interativo** | `warn: 2`, `deny: 10` |
>
> `entry-gate.mjs:884-908`: `PLAN_REVIEW_CAP = 3` **não bloqueia** — injeta um aviso pedindo para
> confirmar que a rodada é descoberta genuína, não churn. O hard stop é
> `PLAN_REVIEW_CEILING = 10`, com o comentário *"runaway backstop, **above the proven-legit 6+**"* —
> 6+ rodadas legítimas já foram observadas na prática. Isso bate com a experiência do dono
> (plan-reviewer rodando 3-5 vezes com achados válidos).
>
> **Conclusão:** o `plan_review` do OC já está em paridade — não mexer nos números. O delta real é o
> adversary, e o alvo de paridade é **não ter cap**, não ter um menor.

**O bug concreto:** `adversary-nudge.mjs:65` lê `state.adversary_loop_count` — que incrementa em
*todo* outcome útil da **run inteira** (spec pass, LIGHT upfront, cada `step d` de task, cada
re-dispatch, review final da Phase 3, passes limpos inclusive). O SKILL.md (:217) manda o contrário,
textualmente: *"The round is NOT `adversary_loop_count` — **never read it off that number**."*
**O código faz o que a própria prosa proíbe.** Com `deny: 4` run-wide, uma run com 2-3 tarefas
dispara o ramo `escalate` antes de qualquer loop ter merecido — a run nasce com data de validade.
Em `ses_056318bb` o contador chegou a 5 **só na fase de spec**, sem uma única tarefa.

**Correção (bug fix, não trilho novo):** o nudge passa a contar rodadas **do loop corrente**, não da
run. Um cap run-wide é destrutivo por construção e nunca deve voltar. O ramo `escalate` continua
sendo conselho (`allow`), nunca recusa — a lane CC não recusa adversary em lugar nenhum, e o próprio
histórico do OC registra que o hard cap *"fired twice on legitimate work"*.

**Não** reduzir `plan_review`. Único ajuste opcional de paridade: poupar o deny em headless, como o
CC faz.

### Passo 2 — Parar de despachar o segundo olho (só prosa, zero rail)
`family-2` já é `optional: true` / `countsLoop: false`; a ausência degrada para
`primary_only_failopen`, estado já suportado. Remover a seção `### Dual-always` do SKILL.md e as
instruções de dispatch em `build.md` / `planner.md`.
**No mesmo PR:** endurecer o prompt do avaliador único (`adversary.md`) com as **duas** passadas que
hoje se dividem entre famílias — (a) consistência interna da spec e (b) confronto contra os call
sites reais em `scope_paths`, com `evidence` obrigatório em `file:function`. Os achados da family-2
eram de classe diferente (ancorados no código), não redundantes.
**Métrica de aceite:** `plan_review_count` médio cai para ≤2 em 2-3 sessões reais. Se
`adversary_loop_count` **não** cair, o problema do adversary é teto/prompt — e os passos 5 e 6 só
entram acompanhados do teto determinístico.

### Passo 3 — Extrair utilitários genéricos (refactor puro, pode ser o 1º merge)
São **8** importadores de `dual-enforcement.mjs`, não 5 — faltavam `entry-gate.ts` (o gate central),
`plan-gate.ts` e `obs-eye.ts` — e **4** utilitários, não 3: `isTaskTool` + `extractSubagentType` →
`task-dispatch-identity.mjs`; `extractHookTaskContext` → `hook-identity.mjs` (já existe);
`isSafeSessionIdSegment` → `path-helpers`; `loadGateStateFromDisk` → `gate-state.mjs`.
Inventário: `grep -rn "dual-enforcement.mjs" --include='*.mjs' --include='*.ts' core/ | grep -v '\.test\.'`

### Passo 4 — Colapsar routing e catálogo para avaliador único
`roles.{adversary,plan-reviewer}` viram `{ model: "openai/gpt-5.6-sol" }` — **mantém o Sol**, que é
o avaliador mais forte. O Grok vira o `secondEyeModel` opcional (decisão 2), exatamente o papel do
Codex na lane CC. Deletar `crossFamilyRoles` / `requireDualOn`.

> **Furo do adversário REJEITADO.** Ele alegou que colapsar no Sol faria "o planner revisar o próprio
> plano" e exigiu Grok. Verificação na lane CC: `planner: opus`, `adversary: opus`,
> `plan-reviewer: opus` — **todos o mesmo modelo**. Avaliador igual ao planner é o comportamento
> normal do CC, que funciona. O invariante `adversary.model !== planner.model` **não** deve ser
> criado; o que garante independência de família é o segundo olho opcional, como na CC.
**Aliases invertidos, não deletados:** existem planos bound em disco com
`"adversary": "adversary-family-1"`. `REVIEW_AGENT_ALIASES` passa a mapear `adversary-family-{1,2}`
e `adversary-openai` → `adversary`, com `removeIn` 2 releases à frente.
**Arquivos esquecidos pelo plano original:** `scripts/parity-manifest.mjs` (+ test, roda no CI),
`core/shared/lib/review-report-schema.mjs:118-143` (parâmetro `expectedFamily`),
`creating-plans/SKILL.md:238-240` e `references/example-plan.json:11-13`,
`plugin/lib/ceremony-transition.mjs` (hardcode `role === "adversary-family-1"`),
`plugin/lib/agent-catalog-health.mjs` (`EXPECTED_HARNESS_AGENTS`).
**Decisão superada pela PR4.2:** `ceremony-transition.mjs` foi removido; o marker host-owned
grava os booleans R10 diretamente, em ordem, sem capturar output do adversário em sidecar.
**Decisão superada pela PR4.2:** esta entrada fica como registro histórico; a saúde dinâmica do
catálogo era um advisory OC-only e foi removida, não reimplementada no `version-check`.
**Reescrever** `model-routing.test.mjs` com o invariante novo:
`roles.adversary.model !== roles.planner.model`.

### Passo 5 — Remover o bloco dual do plugin
Deletar `dual-merge.mjs`, `dual-nudge.mjs`, `dual-runtime.mjs` e o `dual-enforcement.mjs` já
esvaziado. **`loop-guard.ts` é renomeado para `review-guard.ts` e podado por dentro** (regra dura).
**`marker-seal.mjs` só pode sair junto com a reescrita do `loop-decide`** — o import é estático
(`loop-decide.mjs:12`) e usado em :136 e :190; deletá-lo antes deixa o repo quebrado *entre*
commits. `adversary-nudge.mjs` **não é deletado**: poda-se só a linha 48
(`secondary-family-never-drives-the-loop`), mantendo accept/revise/escalate — é o único freio do
loop de spec.
`revise-nudge.mjs` é **reclassificado para manter**: o próprio SKILL.md (:156) o declara o canal
*autoritativo* do orçamento e a prosa como não-confiável. O caminho é reduzir o `deny` (passo 1),
não apagar o relógio.

### Passo 6 — `loop-decide` single-family
Remover either-REVISE-wins, `reservation.family`, `dualState`, e a condição de arquivar época só com
as duas gerações. **Manter** reservas atômicas, review-cap, épocas e terminal accounting.
`dual_status` colapsa para `done|pending` **com leitura tolerante**, e o teste vem **antes** da
mudança, usando os `gate-state.json` reais em `.opencode/plans/.state/` como fixtures.
Leitores reais fora do bloco dual: `session-state.mjs:229`, `gate-state-shape.mjs` e
`merge-verdicts.mjs` (este **não é tocado**). `reinject-state.ts` **não** lê `dual_status` — o plano
original errou nesse ponto.

### Passo 7 — Prosa volta ao formato CC
Cortar ~57 KB de 84 KB do SKILL.md: `### Adversary re-dispatch stop-rule` (24.6 KB), `Escalation
ladder` (Axis 1/2 → "1 tier acima, 1 vez"), `Post-hand capture path` (3 ramos → 1),
`PLANNER_SESSION_DISPATCH_CEILING`. Termos como `stagnation`, `Axis 1`, `primary_failure_cap`,
`adversary_loop_count` não aparecem **nenhuma vez** no SKILL.md da CC.
Antes: `grep -rln 'SKILL.md' --include='*.test.mjs' core/opencode/` (11 arquivos) e mapear cada
âncora.

### Passo 8 — Eliminar os agentes `-spawn`
`validateSpawnAgent` aceita `mode: 'all'`, `spawnAgentName()` devolve o próprio role, comando ganha
`--model <tier>`. Deletar os 7 `-spawn.md`.
**Cuidado:** os gêmeos diferem em mais que `mode` — o in-session tem bloco `permission:`, o `-spawn`
tem bloco `tools:`; fundir exige reconciliar os dois. `mode: 'all'` torna a mão selecionável como
**primary** com `edit: allow` → adicionar `tools.task: false` e um teste em
`agents-manifest.test.mjs`. Incluir `eyes-permission-lockdown.test.mjs` (19 KB) na lista de testes
a ajustar. Validar o probe de `--model` com os agentes **vendorizados**, não ad-hoc — gate
bloqueante de merge.

### Passo 9 — `test-author` no modelo dos olhos
`roles.test-author.model`: `ollama-cloud/glm-5.2` → tier dos olhos, propagado ao frontmatter via
`configuring-model-routing`. (Decisão 3 — não é opcional.)

---

## Risco maior

**Desligar os contadores em silêncio, com o CI verde.** `loop-guard.ts` é o único chamador em runtime
de `loop-decide.mjs`; deletá-lo (ou esvaziá-lo demais) desliga review-cap, primary-failure-cap e
reservas atômicas — e `review-accounting.test.mjs` continua passando porque importa a lib direto,
sem passar pelo hook. O sintoma volta com outra cara e sem nada que denuncie.

Note que "loop sem teto" **não** é o risco: a lane CC não tem teto de adversary e converge. O que
não pode acontecer é o OC perder os contadores de *observabilidade e reserva* achando que perdeu só
o dual.

## Princípio que governa esta poda

**Paridade é o alvo; determinismo não é.** Cada rail candidato a mudança responde a uma pergunta
só: *a lane CC tem isso?*

- Não tem → o OC também não deve ter (ex.: cap de adversary).
- Tem, mais frouxo → copiar o número da CC, nunca apertar além dele (ex.: plan-review).
- Tem em forma de aviso → manter como aviso, jamais promover a recusa.

O histórico do OC já registra a dor de apertar: o hard cap do adversary *"fired twice on legitimate
work"* e a lane praticamente não rodava. Toda proposta de "alinhar o rail" que resulte em número
**menor** que o da CC deve ser rejeitada por padrão.
