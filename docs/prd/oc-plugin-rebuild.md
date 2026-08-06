# Reconstrução do plugin da lane OpenCode — paridade por FATO, não por contagem

**Status:** aprovado — **Caminho A (cirúrgico)**, decidido pelo dono em 2026-07-30. Critério dele:
"tanto faz cirúrgico ou rasa, o que importa é entregar o `.opencode` funcionando; se o cirúrgico
entrega em menos tempo e gastando menos, melhor". **PAUSADO no PR 1 — ver §0.**
**Data:** 2026-07-30

---

## 0. Onde paramos (2026-07-30, pausa do dono)

**PR 1 implementado, NÃO mergeado, NÃO commitado.** Trabalho vivo no working tree da branch
`feat/oc-parity-safety-net`:

```
 M core/claude-code/skills/initializing-projects/references/vendor-core.mjs   (+1 linha)
 M scripts/parity-manifest.mjs                                                (+244)
 M scripts/parity-manifest.test.mjs                                           (+232)
?? docs/specs/oc-port/baseline-2026-07-30.md                                  (novo)
```

PRs 2–6: **não iniciados**, nenhuma linha escrita.

### O que o PR 1 já entrega

- `parity-manifest` roda contra o repo real (`core/opencode` e `core/claude-code`), não só contra
  fixture — fecha o P6.
- `checkNoTokenReads` deixou de aprovar em vácuo quando o scan root não existe.
- `checkPluginLoad` nova: importa **e chama o factory** de cada plugin auto-globado. Mutação prova
  o fechamento — apagar `entry-decide.mjs`, `dispatch-scope.mjs` ou `hand-records.mjs` passava
  verde antes, agora reprova.
- `checkImportsResolve` nova: resolve todo specifier relativo, **incluindo os dinâmicos literais**
  (`tools/classify.ts:47,230`), com piso `scanned > 0`.
- `harnessOcPluginFiles()` foi de 15 para 16 (`lavish-command-gate.ts` estava fora — apagá-lo
  passava com a rede inteira verde) + drift-guard amarrando a lista ao conteúdo do diretório.

### Erro encontrado no PRD — §5 P5 está errado

**O CI é verde.** Run `30558600276` (workflow CI, PR #606, sha `33d64a6`, árvore bit-idêntica à
main `faded65`, `conclusion: success`):

```
# tests 2997   # pass 2996   # fail 0   # skipped 1
```

As 28 falhas do §5 P5 são artefato **local de macOS**, e a atribuição registrada aqui também está
errada nos três eixos:

| Arquivo | falhas | o §5 P5 cita? |
|---|---|---|
| `core/vps/cron-a-dispatch-obs.test.mjs` | 11 | sim |
| `core/vps/cron-a-dispatch-capture.test.mjs` | 10 | sim |
| `core/vps/cron-a-dispatch-fixmode.test.mjs` | 4 | sim |
| `core/vps/notify-wiring.test.mjs` | 2 | **não** |
| `core/claude-code/.../vendor-core.test.mjs:1037` | 1 | **não** — é `/var` vs `/private/var`, symlink do macOS; ausente no ubuntu |
| `scripts/cutover-preflight.test.mjs` | **0** (passa 6/6) | sim, e não contribui nenhuma |

E a causa declarada ("quebram só no run paralelo, passam isoladas") está **invertida**: elas
reproduzem isoladas, e a atribuição do run paralelo é idêntica à dos isolados.

**Consequência prática:** o critério de merge é **zero falha no CI**, não "28 toleradas" — mais
estrito do que estava escrito. Tolerar 28 licenciaria até 28 regressões reais como "bate com a
baseline". A correção completa, com as três baselines e o critério de aceite nos dois eixos, está
em `docs/specs/oc-port/baseline-2026-07-30.md`. Baseline 1 (`core/opencode` = **742/742/0**) está
certa e foi confirmada.

### Bloqueante aberto — G-A, e é o que trava o merge do PR 1

`scripts/parity-manifest.mjs:308-312`. Quando o `await import()` do **módulo** falha por causa do
pacote do host (`@opencode-ai/plugin`, que não está instalado e o CI não instala), o plugin vai
para `hostProvided` e o loop faz `continue` — **dali em diante nada mais é verificado nesse
arquivo**: nem o default export, nem a chamada do factory. `ok` continua `true`.

Provado contra cópia do repo real, de duas formas:

- **M1** — `plugin/plan-gate.ts` (um dos três gates do §2) reescrito para não exportar plugin
  nenhum → `load.ok=true`, `runParity.ok=true`. Um gate que deixou de ser plugin, com a rede
  inteira verde. É o P0 literal.
- **M2** — sem refactor nenhum: basta **esquecer a palavra `type`** na linha 15
  (`import type { Plugin, Hooks }` → `import { Plugin, Hooks }`) e o arquivo sai de toda a
  verificação. Superfície do slip: **16 de 16** plugins carregam esse `import type`, e **não há
  tsconfig nem passo de typecheck no CI** — nada além dessa checagem pegaria o slip, e ela é
  justamente o que o slip desliga.

Confirmado independentemente pelos dois revisores (o compliance achou o mesmo caminho e o
classificou como latente; o adversário provou e reprovou).

**Fix já identificado, ~12 linhas, padrão já vendorizado neste repo:**
`core/opencode/plugin/second-eye-coordinator.test.mjs:10-23` já stuba o pacote do host com
`module.registerHooks` + data-URL. Adotando o stub, `HOST_PROVIDED_PACKAGES` **deixa de existir** e
a cobertura vai de 13/16 para 16/16 (medido: 15 dos 16 já carregam com o stub atual; o 16º,
`ceremony-coordinator.ts`, só precisa de `tool.schema.object` no stub — falta no stub, não no
plugin). Mínimo alternativo, 1 linha: nunca tolerar no estágio `import`, só em `stage: "factory"`
— hoje 0 plugins estão no estágio `import`, então não gera falso-vermelho.

### Achados a carregar para quando retomar

- **Deletar plugin exige DOIS pontos de edição** (PRs 3 e 4): `OC_RETIRED_FILES` **e**
  `harnessOcPluginFiles()`. `checkPluginLoad` não consulta o primeiro (diferente de
  `missingHarnessOcPluginFiles`). Falha alto, direção certa, mas custa debug se ninguém souber.
- **O "move dos 6" do PR 2 não é fechado sobre si.** A closure transitiva são **11** arquivos: os
  6 mais `plan-hash.mjs`, `planner-artifact.mjs`, `planner-fallback-config.mjs`, `roles.mjs` e
  `task-dispatch-identity.mjs`. Mover só os 6 deixa `core/opencode/lib/` importando de volta
  `../plugin/lib/` — o acoplamento que o move existe para quebrar continua de pé. Medido: 23
  importadores para os 6 contra 28 para os 11, então mover a closure inteira custa quase nada a
  mais. Externos: `../../../shared/**` (vira `../../shared/**`, é o P1.3) e
  `../../agents/review-catalog.mjs` (vira `../agents/...`).
- **O PR 3 tem uma superfície de prosa maior do que o §4bis registra.** Além de
  `skills-alignment.test.mjs:197,236`, o `orchestrating-delivery/SKILL.md` cita os rails removidos
  em pelo menos 12 pontos (`plan_review_count`, `primary_failure_streak`,
  `primary_failure_cap_reached`, `adversary_nudge`, `revise_nudge`, `LOOP_THRESHOLDS`). Nota de
  paridade: a lane CC **mantém** cap de prosa (`Cap at 2 revision loops`,
  `core/claude-code/skills/orchestrating-delivery/SKILL.md:146`), então cap de prosa que é
  disciplina do orquestrador não viola a regra — o que tem de sair é prosa que referencia rail
  morto.
- **P3 não morde hoje:** `.opencode/plans/.state/` não existe neste repo.
- Ressalva de redação no baseline doc: ele diz "sha `33d64a6`, main". O sha está só em
  `origin/harness/603`, e `gh run list --branch main` devolve `[]` porque o CI dispara só em
  `pull_request`. A árvore é idêntica à main, então o número vale — mas trocar por "run do PR #606"
  evita que alguém procure um run que não existe.

---
**Origem:** A/B controlado + probe de plataforma nesta data. Sucede `oc-parity-pruning.md`, cujos 9
passos **foram executados** (13 PRs, #580–#606) e **não resolveram**.

---

## 1. Por que existe outro plano se a poda já foi feita

O `oc-parity-pruning.md` diz "aprovado, não iniciado". O git desmente: os 9 passos foram entregues
entre 28 e 30/07. Ainda assim, o braço `.opencode` do A/B de hoje — rodando `v0.51.0-16-gfaded65`,
o HEAD **pós-poda completa** — travou em 10 tool calls e morreu sozinho.

A poda mirou no **dual** (despachar duas famílias avaliadoras). O dual era um caso particular do
problema. O problema é **o gate decidir por julgamento contínuo em vez de por fato verificável** —
e esse ficou inteiro.

### Evidência que sustenta o novo alvo

| Fato | Como foi medido |
|---|---|
| OpenCode **não executa** hook do `.claude/settings.json` | probe com sentinela em SessionStart/PreToolUse/PostToolUse: sessão iniciou, Bash rodou, sentinela vazio |
| Só a prosa da CC entrega | issue #100 no `victor-bot`: ciclo completo, PR #131 mergeado (+747/−24) em 46 min, zero motor rodando |
| A prosa dispara o gate de entrada sozinha | prompt cru sem citar pipeline → primeira tool = `skill triaging-requests`, em `gpt-5.6-sol` **e** em `gpt-5.6-terra`; o terra ainda classificou FULL num flaky test (viés é **over**-ceremony) |
| A lane OC trava em headless | A/B mesma issue #113, mesmo prompt, mesmo modelo, mesma memória: `.claude` 35 tools + diff real; `.opencode` 10 tools, travou numa pergunta ao operador, morreu |
| O agente combate o gate por contagem | 7 sessões de entrega por lane → `.opencode` **9** manipulações de `gate-state`, `.claude` **0**. Numa run real: editou o JSON via Python, sobrescreveu selos com `tee`, apagou com `rm -f`, escreveu teste dentro do plugin pra justificar |

Nenhuma das duas lanes valida selo HMAC (`bash-decide.mjs:23-26`, removido em #484). Com proteção
igual a zero dos dois lados, a diferença de 9 × 0 não vem de proteção — vem de **o gate ser
satisfazível com uma ação do próprio agente**.

---

## 2. A spec: 16 regras, extraídas do código da lane que funciona

Levantamento sobre `entry-gate.mjs` (1263), `plan-write-gate.mjs` (432) e `lavish-command-gate.mjs`.
25 branches de deny colapsam em 16 rails.

- **14 regras bloqueiam por FATO** — artefato existe? carimbo existe? branch certa? commit é
  ancestral? path dentro do escopo?
- **1 regra bloqueia por CONTAGEM** — `plan-reviewer` na 11ª rodada, e **só em modo interativo**
- **1 regra acessória** — backstop de um skill, fora do pipeline

### Os três princípios que a CC aplica e a OC viola

Estão comentados em `entry-gate.mjs:858-864`:

1. **Contagem avisa, não bloqueia.** `count > 3` → allow + aviso visível. *"cross-family discovery
   past round 2 found real bugs"*.
2. **O que bloqueia, bloqueia só interativo.** `count > 10` → deny **`&& !headless`**, porque
   *"headless não tem operador para escalar, um hard-deny travaria um run cloud com plano não
   aprovado → headless stays warn-only forever"*.
3. **Fail-open em qualquer erro de infra.** Uma exceção deliberada só (`regate_pending` não-array).

A OC hoje: `adversary {deny: 4}` bloqueia por contagem; `plan_review {deny: 10}` sem ressalva de
headless; `loop-decide` fail-closed em vários pontos. Os três violados.

### A autoridade é git, não criptografia

A CC não usa HMAC. Um carimbo só vale como `<feature>/<task>@<sha>`, validado com
`git merge-base --is-ancestor <sha> HEAD`. Entrada sem `@sha` conta como **ausente**. O agente pode
escrever o arquivo de estado; não pode inventar um commit. Isso resolve o dilema de manter estado
persistido depois que o `marker-authority` foi removido.

### Fora da spec (a CC não tem — não portar)

Cap de rodada de adversary · accounting/quórum entre revisores · HMAC nos markers · exigência de
evidência positiva de captura (`requireCaptureEvidence` existe em `shared/lib/real-file-capture-rail.mjs:198`
mas o adapter da CC **não passa a flag**).

---

## 3. O que existe hoje no plugin

55 arquivos, 10.191 linhas.

| Veredito | Arquivos | Linhas |
|---|---|---|
| Renasce sem mudança | 29 | 5.204 (51%) |
| Dúvida — decidir caso a caso | 15 | 2.989 (29%) |
| Morre | 11 | 1.998 (20%) |

**Morrem:** `loop-decide.mjs` (770) · `review-guard.ts` (436) · `second-eye-authority.mjs` (201) ·
`second-eye-coordinator.ts` (129) · `adversary-nudge.mjs` (154) · `revise-nudge.mjs` (90) ·
`review-restart.mjs` (51) · `ceremony-coordinator.ts` (59) · `scope-runtime-composition.mjs` (37) ·
`bound-plan.mjs` (40, órfão) · `obs-test-isolation.mjs` (31, órfão).

**Só 2 arquivos produzem deny por contagem** — `review-guard.ts:336` e `loop-decide.mjs:373,390`
(mais um parcial em `planner-state.mjs:119`). Os outros ~45 pontos de deny já são FATO.

`primary_failure_streak` **não é separável**: vive no mesmo `if` que `inflightEvaluator`
(`loop-decide.mjs:373`). Preservá-lo exige reescrevê-lo fora de `reserveReviewAttempt`.

---

## 4. Dois furos de origem — correção obrigatória, não melhoria

**F1 — a âncora de git só vale metade do caminho.** `entry-gate.ts:449` não passa `isAncestorFn`
para `decideEntryTask`; `entry-decide.mjs:181-186` documenta a consequência: o match de regate no
dispatch cai para **prefixo puro, ignorando o `@sha`**. Vale no `git push`, não no dispatch.
Correção: uma linha.

**F2 — a captura independente é auto-certificada.** `host-hand-capture.mjs:134-148` escreve
`hand_finished` **e** `capture_verified` na **mesma transação de lock**. O rail que depois cobra
"a mão terminou sem captura verificada" nunca pode falhar.

F2 é o mais grave do documento. A tese *strong eyes, cheap hands* depende de dois trilhos: teste
congelado **+ captura independente**. Na lane OC o segundo não existe. **A mão barata é segura na
lane CC e não é na lane OC.** Na CC os passos são separados: `spawn-hand.mjs` escreve o run-record
incondicionalmente e `markHandRecordCaptured` é **no-op se o record não existir** — não há como
carimbar captura de uma execução que não aconteceu.

---

## 4bis. Duas lacunas — DECIDIDAS: as duas saem

**Decisão do dono, 2026-07-30:** *"se a CC não tem e o OpenCode funcionou com ela desse jeito,
tira. Não quero mais correr o risco de criar outro monstro, quero só o mínimo que funciona."*
Regra de paridade aplicada sem exceção — foi violá-la que produziu o monstro. **Ambas removidas.**

**Evidência que sustenta a decisão** (as 5 runs OC+`.claude` de 2026-07-30, onde nenhum cap
executou porque o motor da CC não roda no OpenCode): o spec-adversary convergiu **sozinho** em
todas — #21 spec 1 em 3 rodadas, #21 spec 2 em 4, #105 em 7, as três fechando `SHIP`. O loop de 7
rodadas que destruiu a spec em `ses_0599b2df` ocorreu **com o dual ligado**: o motor era o dual não
deixar fechar, não a ausência de teto.

**Risco residual aceito, nomeado:** um avaliador que devolva JSON ilegível repetidamente entra em
redispatch sem limite — nada mais implementa esse corte, e a regra de contagem que sobra é cega a
ele (`loop-decide.mjs:527-529` só incrementa no ramo `useful`). Em sessão interativa é visível e o
operador mata na mão; em fleet headless seria pior, mas o fleet está fora de escopo. Se o sintoma
aparecer, a correção certa é reintroduzir **um** rail de FATO ("3 retornos ilegíveis do mesmo
avaliador"), nunca o `loop-decide` de volta.

**Consequências no plano:**
- `LOOP_THRESHOLDS` sai inteiro — `adversary` e `plan_review`, não só o `deny`
- `adversary-nudge.mjs` e `revise-nudge.mjs` **entram na poda**; `vendor-core.test.mjs:658-670`
  (que os protege como *kept on purpose*) é reescrito, e a justificativa registrada ali é
  substituída por esta decisão
- `primary_failure_streak` **não é readotado**; `core/shared/lib/agent-retry.mjs` fica órfão e
  acompanha a poda
- `__tests__/skills-alignment.test.mjs:236` (que amarrava o número da prosa ao do rail) **inverte**:
  passa a provar que a prosa não cita número nenhum. `:197` (`rules.length >= 4`) é reescrito
- Sem `LOOP_THRESHOLDS`, some a última dependência de contagem — as 16 regras viram **15 de FATO
  + 1 acessória**, zero de contagem

**Resgate barato identificado:** `plugin/eyes-permission-lockdown.test.mjs` (6 testes) **não tem
dependência de código do plugin** — varre `agents/*.md` + `opencode.json` procurando override que
reconceda bash a olho read-only (issue #516, 12 agentes corrigidos). Mora no plugin por acidente.
Mover o arquivo preserva a cobertura inteira.

<details>
<summary>Análise original das duas lacunas (mantida para rastreabilidade da decisão)</summary>

**L1 — `primary_failure_streak` fica descoberto, e a CC não cobre.** `grep AGENT_RETRY_K
core/claude-code/` = vazio. O cap de 3 retornos ilegíveis do avaliador (`loop-decide.mjs:373,499`)
não tem contraparte na lane CC. E a regra de CONTAGEM das 16 (11ª rodada de plan-review) é **cega
para esse modo de falha por construção**: o incremento de `plan_review_count`
(`loop-decide.mjs:527-529`) está no ramo `useful`, **depois** do `return` do ramo `failure`
(`:484-521`). Um avaliador devolvendo JSON quebrado nunca incrementa o contador — logo nunca chega
na 11ª rodada, e fica em redispatch indefinido com todo contador em zero. Nenhuma das 14 regras por
FATO enxerga isso, porque nenhuma olha para a *qualidade* do retorno do avaliador.

O streak **não é separável** do resto: vive no mesmo `if` que `inflightEvaluator`
(`loop-decide.mjs:373`). Preservá-lo é reescrevê-lo fora de `reserveReviewAttempt`, não salvar o
arquivo. Junto com ele vão a distinção *deny-do-harness vs falha-do-provider* (`:487-495` — sem ela
um `[plan-gate] Blocked` queima orçamento por causa própria) e o ceiling interativo de runaway
(`:659,674-713`). `core/shared/lib/agent-retry.mjs` (9,5 KB) fica **órfão de chamador** — decidir se
acompanha os 11 ou se o plugin novo o readota.

**Decisão sugerida:** readotar. É FATO (o avaliador devolveu lixo 3 vezes), não julgamento sobre o
trabalho — cabe no princípio do §7. A CC não ter é lacuna dela, não virtude a copiar.

**L2 — `adversary-nudge` é o único freio do loop de spec.** A CC não tem cap de adversary; o
`oc-parity-pruning.md:36-38` já havia registrado que *"o motor do spec-adversary é cada rodada
reescrever a spec, com um teto que avisa e não recusa"* e que **tirar as famílias não resolve o
adversary**. Matar o nudge sem substituto reabre o loop que destruiu a spec em `ses_0599b2df`
(7 rodadas, planner morto, run com zero código).

**Decisão sugerida:** manter o nudge (é aviso, não deny). — **SUPERADA: o dono decidiu remover.**

</details>

---

## 5. Pré-condições bloqueantes

**P0 — o modo de falha que governa tudo: plugin quebrado é PULADO, em silêncio.**
Provado ao vivo (`opencode 1.18.10`, projeto-sonda com um plugin importando módulo inexistente):
`EXIT=0`, os outros plugins carregam normalmente, e com `--log-level DEBUG` **zero** menção ao
arquivo quebrado ou à palavra "plugin". Corrobora
`docs/specs/oc-port/inventory/probe-results-2026-07-12-oc-gates.md:14-15` — *"plan-gate fail load;
executor-low task completed without dual"*.

> **Apagar o plugin não gera erro. Gera um harness que parece funcionar e não bloqueia mais nada.**

Nenhum check de runtime verifica "os gates carregaram" — `missingHarnessOcPluginFiles` só roda no
vendoring, nunca no boot. **Toda etapa deste plano precisa de verificação positiva de carga**, não
de ausência de erro.

**P1 — seis módulos do plugin são dependência de código que fica (não quatro).**

```
tools/lib/classify-persist.mjs:6  → plugin/lib/gate-state.mjs        (estático — morre no load)
hands/run-hand.mjs:27             → plugin/lib/gate-state.mjs
hands/run-hand.mjs:28             → plugin/lib/entry-decide.mjs
hands/run-hand.mjs:29             → plugin/lib/dispatch-scope.mjs
hands/run-hand.mjs:30             → plugin/lib/hand-records.mjs
tools/classify.ts:47              → plugin/lib/planner-state.mjs     (dinâmico — explode na CHAMADA)
tools/classify.ts:230             → plugin/lib/obs-emit.mjs          (dinâmico)
scripts/probe-oc-gates-headless.mjs:22 → plugin/plan-gate.ts
```

Os dois imports dinâmicos de `classify.ts` são piores que os estáticos: a tool **registra normal** e
só explode no meio do triage.

**P1.1 — o destino do move não existe para o vendoring.** `core/opencode/lib/` **não é copiado**:
`OC_FRAMEWORK_OWNED` (`vendor-core.mjs:83`) = `["agents","command","docs","skills","plugin","tools","hands","rules"]`,
e `OC_RUNTIME_DIRS` (`cron-a-dispatch.mjs:755`) idem. Mover para lá sem tocar nessas duas listas
produz import para arquivo que nunca chega ao projeto — e, por P0, em silêncio.
→ Adicionar `"lib"` às **duas** listas, no mesmo commit do move.

**P1.2 — rename não é tratado pelo vendoring.** Não há mapa de rename; `copyOcTree`
(`vendor-core.mjs:394-414`) nunca diffa contra o destino. Os 6 paths antigos entram em
`OC_RETIRED_FILES` junto com o move, senão o projeto fica com duas cópias divergentes.

**P1.3 — `rewriteSharedImportsForVendor` é depth-aware** (`vendor-core.mjs:364-386`): calcula os
`../` pela profundidade. Sair de `plugin/lib/` (depth 2) para `lib/` (depth 1) muda a contagem.
Conferir cada um dos 6 antes do move — `gate-state.mjs` é o candidato a quebrar.

**P2 — `mark-gate.mjs` tem o path hardcoded fora do plugin.** Aparece em `opencode.json.example`
(2 entradas de allowlist), `skills/orchestrating-delivery/SKILL.md:262,265,268,271,347`,
`agents/build.md:80`, `AGENTS.md:169` e `vendor-core.mjs:367-370`. Apagar deixa allowlist apontando
para o vazio e 5 instruções de skill falhando em runtime.

**P3 — estado durável sobrevive à deleção.** `dispatch-scope.mjs` escreve
`active-dispatch-cleanup-pending.json`, e `plan-write-gate.ts:190` **nega toda escrita** quando esse
arquivo existe (`hasCleanupPending` é `fs.existsSync` puro). Se o gate renascer com a checagem e
sobrar um arquivo de sessão anterior, a sessão **nasce travada** — e o reconciliador que limparia
(`reconcileCleanupPending`) teria sido apagado junto. → Varrer `.opencode/plans/.state/` antes.

**P4 — seis projetos vendorizados expostos.** `aidee-carla-sistema` (v0.51.0) · `aidee-dani`
(v0.49.0) · `gestao` (v0.51.0) · `proj-guilherme` (v0.49.8-20) · `victor-pipeline-dados-bot`
(v0.51.0) · `victor-pipeline-dados-mcp` (v0.49.8-20). O vendoring é aditivo: arquivo que some da
fonte **sobrevive no destino** e passa a importar módulo inexistente, derrubando o registro do
plugin inteiro. O mecanismo de retirada existe e já foi usado (`OC_RETIRED_FILES`, 8 entradas hoje;
`sweepRetired` em `vendor-core.mjs:839-845`). → Toda deleção entra nessa lista **na release
anterior** à que apaga.

**P5 — baseline. ⚠️ ERRADO, ver §0** — o CI é verde (0 falhas); as 28 abaixo são artefato local de
macOS e a atribuição está errada. Fonte corrigida: `docs/specs/oc-port/baseline-2026-07-30.md`.
`node --test "core/opencode/**/*.test.mjs"` → **742 testes, 742 pass, 0 fail**
(medido 2026-07-30). No escopo real do CI (`ci.yml:29` = `core/** + modules/** + scripts/**`) são
**2997 testes com 28 já falhando** — todas em `core/vps/cron-a-dispatch*` e `scripts/cutover-preflight`
(tmux/env, quebram só no run paralelo). Pré-existente, fora deste escopo. Registrar as duas no
primeiro PR; nenhum PR mergeia acima delas.

**P6 — a rede que deveria pegar esse tipo de buraco é de papel.** `scripts/parity-manifest.mjs`
roda no CI, mas `checkGatesAndOracle` e `runParity` **nunca são exercitados contra o repo real** —
`parity-manifest.test.mjs:138-140` só os invoca sobre fixture sintético. Contra `core/opencode`
real rodam apenas `checkAgentsPresent`, `checkNoTokenReads` e `checkDualConfig`. **A deleção passa
verde (6/6).** Pior: `checkNoTokenReads` vira aprovação vácua — `walkFiles`
(`parity-manifest.mjs:63`) retorna cedo em diretório inexistente. Consertar o manifesto é
pré-requisito, não follow-up.

**P7 — dois testes documentam decisão contrária à poda.** `vendor-core.test.mjs:658-670` protege
`plugin/lib/adversary-nudge.mjs` e `plugin/lib/revise-nudge.mjs` como *kept on purpose*, com a
justificativa registrada: **`adversary-nudge` é o único freio do loop de spec**, e a lane CC **não
tem cap de adversary para substituí-lo**. Ver §4bis — decidir explicitamente, não atropelar.

**Fora de escopo:** VPS / fleet headless (o dono confirmou que não há nada ativo).

---

## 6. Os dois caminhos

Ambos começam pelas pré-condições (§5) e terminam nas 16 regras (§2) + os dois furos (§4).

### Caminho A — cirúrgico

**PR 1 — rede de segurança primeiro** (P0 + P6). Fazer `parity-manifest` rodar contra o repo real,
não contra fixture; adicionar verificação **positiva** de carga dos gates (o plugin quebrado é
pulado em silêncio, então "sem erro" não prova nada). Registrar as duas baselines (742/742 e
2997/28-fail). Sem isto, todo PR seguinte mergeia verde sem provar nada.

**PR 2 — o move** (P1, P1.1, P1.2, P1.3). Mover os **6** módulos de `plugin/lib/` para
`core/opencode/lib/`: `gate-state`, `entry-decide`, `dispatch-scope`, `hand-records`,
`planner-state`, `obs-emit`. No **mesmo commit**: `"lib"` em `OC_FRAMEWORK_OWNED`
(`vendor-core.mjs:83`) e em `OC_RUNTIME_DIRS` (`cron-a-dispatch.mjs:755`); os 6 paths antigos em
`OC_RETIRED_FILES`; conferir a profundidade dos imports de `shared/`. Refactor puro — comportamento
idêntico, testes verdes.

**PR 3 — a poda.** Apagar os **11 inteiros** (§4bis: `adversary-nudge` e `revise-nudge` incluídos)
mais `core/shared/lib/agent-retry.mjs`, órfão de chamador. `LOOP_THRESHOLDS` sai por completo — sem
`adversary`, sem `plan_review`, sem `primary_failure_streak`. Podar a contagem de
`review-guard.ts:336`. Antes de apagar, mover `plugin/eyes-permission-lockdown.test.mjs` (6 testes
que não dependem do plugin). Reescrever `vendor-core.test.mjs:658-670` e
`__tests__/skills-alignment.test.mjs:197,236`. Todos os paths removidos entram em
`OC_RETIRED_FILES` **no mesmo PR** — uma release basta (pré-declarar é no-op, porque a guarda só
apaga o que já sumiu da fonte).

**Resultado:** zero gates por contagem no plugin. Restam 15 regras de FATO + 1 acessória.

**PR 4 — as 15 dúvidas**, uma a uma contra as 16 regras. Fica só o que serve a uma regra de FATO.

**PR 5 — os dois furos** (§4). F1: passar `isAncestorFn` em `entry-gate.ts:449`. F2: separar
`hand_finished` de `capture_verified` em `host-hand-capture.mjs:134-148`, espelhando a CC — o
carimbo de captura vira no-op se não houver run-record.

**PR 6 — permissões: a liberdade do Auto Mode no OpenCode.**

Pedido do dono: *"quero que no OpenCode funcione como o auto-mode do Claude Code; acabo ficando
aprovando um monte de besteira"*.

**Este é o único item do plano que NÃO é paridade literal — e é deliberado.** A CC não é mais
permissiva na config; ela tem um **classificador de risco em runtime** (Auto Mode) decidindo na
hora. O OpenCode não tem equivalente. Copiar `settings.json` ao pé da letra não resolve: a
allowlist estática continuaria perguntando tudo que não foi previsto.

| | Claude Code | OpenCode hoje | OpenCode alvo |
|---|---|---|---|
| Edição | `defaultMode: "acceptEdits"` + `Edit`/`Write` em `allow` | `edit: {"*": "allow"}` | mantém, **+ deny em `plans/.state/**`** |
| Bash | allowlist + Auto Mode julga o resto | `bash: {"*": "ask"}` + allowlist → **tudo não previsto vira prompt** | `bash: {"*": "allow"}` + denylist |
| Leitura | deny de `.env*`, `.dev.vars`, `~/.ssh`, `~/.aws` | idem | mantém |

**Consequência assumida:** o alvo é **mais permissivo que a CC**, não igual — sem classificador, é
o único jeito de obter a mesma fluidez. Mitigação: a denylist cobre o que importa
(`git reset --hard`, `git push --force`, `git clean -f`, `rm -rf`, secrets) **e ganha o que
nenhuma das duas lanes tem hoje**: `".opencode/plans/.state/**": "deny"` no `permission.edit`,
fechando o furo por onde vieram as 9 forjaria de `gate-state`.

Fechar também `node -e` / `sed` / `tee` sobre paths de estado — sem isso, o deny de `edit` é
contornável por Bash (é assim que a forjaria aconteceu: `python3` + `tee` + `rm -f`).

Limpar a permissão órfã de `mark-gate.mjs` via `RETIRED_OC_PERMISSION_ENTRIES`
(`core/shared/lib/opencode-config-migration.mjs:24`) — presente nos 6 projetos.

Tocar `core/opencode/opencode.json.example` **e** o `opencode.json` da raiz do repo.

**Depois:** `updating-harness` nos 6 projetos + **reiniciar a sessão do OpenCode** em cada (sem
restart, o plugin antigo segue carregado).

Reescreve ~2.000 linhas. Mantém 5.204 que já estão certas.

### Caminho B — tabula rasa

1. P1: mover os 4 módulos para `core/opencode/lib/`
2. Registrar baseline; `OC_RETIRED_FILES` com o `plugin/` inteiro; **release**
3. Apagar `core/opencode/plugin/`
4. Escrever do zero os entrypoints das 16 regras, com fail-open e sem contagem
5. F1 e F2 nascem corrigidos
6. Igual ao A6

Reescreve ~10.000 linhas, das quais 5.204 provavelmente voltam parecidas. Garante zero entulho.

### Recomendação

**A**, com uma ressalva honesta: B é mais satisfatório depois de duas semanas de monstro, e o custo
dele agora está medido — não é um salto no escuro. O que **não** muda entre os dois é o que
realmente importa: as 16 regras, os três princípios (§2) e as correções F1/F2.

Se o objetivo for "nunca mais quero olhar pra esse código", B. Se for "quero a lane funcionando
rápido e sem quebrar 6 projetos", A.

---

## 7. Princípio que governa

> Determinismo só sobre o que o agente **pode produzir** e o gate **pode verificar num arquivo**.
> Nunca sobre contagem de rodada, concordância entre avaliadores, ou qualquer coisa que o agente só
> possa satisfazer esperando.

O corolário, medido: gate satisfazível gera cooperação (0 forjarias em 7 sessões); gate por
julgamento contínuo gera sabotagem (9 forjarias em 7 sessões) — com a mesma proteção nos dois casos,
que é nenhuma.
