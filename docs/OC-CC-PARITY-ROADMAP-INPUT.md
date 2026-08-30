# Roadmap input — paridade OpenCode ↔ Claude Code

> **Nota PR4.2 (2026-07-31):** itens abaixo que citam `ceremony-binding.mjs`,
> `ceremony-transition.mjs`, sidecars/receipts de cerimônia ou recovery do planner entry são
> históricos e foram superados. R10 vigente é `brainstormed === true`, depois
> `adversary_fired === true`, com match da feature classificada e sem sidecar.

**Como usar:** este arquivo é a matéria-prima para criar as issues via a skill `creating-issues`
(form `.github/ISSUE_TEMPLATE/harness-task.yml`, título `[harness] <slug>`, label `harness:ready`,
dependências no bloco `harness-deps`). Cada item abaixo já obedece à regra de sizing do repo
(1 issue = 1 coisa que sobe e reverte sozinha, ≤ ~400 linhas de diff, sensível isolado). A fonte
dos vereditos é `docs/OC-CC-PARITY-REPORT.md` (revisão final, seção 3d pós-adversarial + Lote 1b).
Não existe lint automático para o grafo de dependências: depois de criar o conjunto, confira à mão
que não há ciclo (`#A` → `#B` → `#A`) e que todo `#N` citado existe.

**Fato que governa a sequência:** fix em core/ é INERTE até re-vendorizar. Os itens 5 e 6 (migração)
são o que faz TODOS os outros chegarem a um projeto real — em qualquer geração anterior (13 projetos
vivos, de v0.14.0 a v0.49.8, 3 formatos de stamp), frota ou interativo. Não são limpeza do gestao;
o gestao é um caso de teste.

---

## Trilha A — Config e permissões (paralela à B e à C)

### 1. [harness] oc-secret-read-edit-deny
- **Entrega:** o OpenCode deixa de ser mais frouxo que o Claude Code em leitura de segredo — os 8
  denies de secret-read do CC (settings.json:63-70) viram mapa por-padrão nas chaves globais
  `permission.read`/`permission.edit`. Hoje o build e todos os executores/snipers leem `.env`.
- **Arquivos:** core/opencode/opencode.json.example:40, opencode.json:40 (raiz),
  core/vps/cron-a-dispatch.mjs:470 (`read: "allow"` em HEADLESS_SAFE_PERMISSION_DEFAULTS).
- **Tamanho:** S (~60 linhas).
- **Dependências:** nenhuma.
- **Aceite:** `OPENCODE_CONFIG=... opencode debug config` aceita o mapa (probe já confirmou o schema
  — PermissionRuleConfig é union escalar|mapa para read/edit/bash no 1.18.5); controle negativo com
  ação inválida falha com `Expected PermissionActionConfig`; core/vps/cron-a-dispatch-seed.test.mjs
  verde com caso novo afirmando que o seed carrega os denies de read.
- **Risco:** baixo. Observar: sessão OC comum continua lendo arquivos normais (o `"*": "allow"` fica).
- **Sensível:** sim (segredos).

### 2. [harness] oc-agents-permission-parity
- **Entrega:** os agentes OC ganham as mesmas capacidades dos equivalentes CC — `edit: allow` no
  build (raiz dos heredocs que alimentavam a muralha), bash read-only no plan, `bash: allow` no
  planner e no security (os dois papéis cujo julgamento o operador reclama).
- **Arquivos:** core/opencode/agents/build.md:7 (+prosa :15), plan.md:7-12 (+corpo :50),
  planner.md:6-13, security.md:6-13; testes que afirmam o contrário:
  core/opencode/plugin/eyes-permission-lockdown.test.mjs:86-93,
  core/opencode/agents/plan-conversation-contract.test.mjs:58/:108/:121/:142,
  agents-manifest.test.mjs.
- **Tamanho:** M (~200 linhas, maioria teste).
- **Dependências:** nenhuma.
- **Aceite:** suites acima reescritas e verdes; **`edit: allow` no planner** (decisão do operador
  2026-07-26 — desde o PR #449 quem grava o execution-plan.json é o plugin, então o `deny` não
  protegia mais nada; a integridade do plano continua vindo do caminho de escrita do plugin, não
  desta permissão).
- **Risco:** baixo.
- **Sensível:** não.

### 3. [harness] oc-permission-bash-question-parity
- **Entrega:** o mapa `permission.bash` do OC espelha o do CC 1-pra-1 (allowlist ampla + 6 denies
  git destrutivos) e `question` volta a `allow` — a proibição headless fica onde o CC a mantém
  (prosa); o `question:"deny"` forçado pela frota vira escolha de worktree, não constante que
  reverte config local. **Confirmado pelo operador em 2026-07-26:** o agente pode consultar o
  operador em sessão local; segue proibido apenas no worktree headless, onde não há quem responda.
- **Arquivos:** core/opencode/opencode.json.example:52-102, opencode.json:52-102,
  core/vps/cron-a-dispatch.mjs:595 (force-overwrite escopado ao worktree).
- **Tamanho:** M (~250 linhas).
- **Dependências:** nenhuma. (O corte da DANGEROUS_BASH_DENYLIST NÃO entra aqui — precisa do ledger
  do item 5; entra no item 6.)
- **Aceite:** cron-a-dispatch-seed.test.mjs e cron-a-dispatch.test.mjs verdes; manual: semear um
  worktree e conferir que o opencode.json resultante tem `question: deny` SÓ no worktree.
- **Risco:** médio (mexe no que a frota semeia). Observar: 1 ciclo de frota após merge.
- **Sensível:** não.

### 4. [harness] merge-gate-state-patch-delta-scope
- **Entrega:** desarma o tripwire latente que pode brickar o hand_quarantine: a validação de
  dual-fields passa a olhar só o delta do patch, não o estado inteiro acumulado (um
  `dual_completed` legado em disco hoje nega qualquer write futuro de quarantine por motivo alheio).
- **Arquivos:** core/shared/lib/gate-state-shape.mjs:358-457 (remover a chamada whole-state em
  :445; estender a disciplina per-key de :380-428 a plan_verdict); caller vivo único:
  core/opencode/hands/run-hand.mjs:307.
- **Tamanho:** S (~80 linhas).
- **Dependências:** nenhuma (mas deve merjar antes/junto do item 5 — o import de gate-state legado
  por projeto migrado é o gatilho mais plausível).
- **Aceite:** teste novo: estado prévio com `dual_completed: true` legado + patch de
  `hand_quarantine` → write aceito; patch que ELE MESMO carrega dual inválido → rejeitado.
- **Risco:** baixo.
- **Sensível:** não.

### 5. [harness] oc-config-migration-lib
- **Entrega:** a peça que faz update chegar a projeto já vendorizado: função única
  `migrateOpencodeConfig` (3 tiers: manifest / ledger por `.harness-version` / fresh), sidecar
  `.opencode/.harness-config-manifest.json` (marcador in-file foi probado e rejeitado — schema
  estrito: `Unrecognized key`), ledger `RETIRED_OC_PERMISSION_ENTRIES` com regra
  valor-igual-remove / valor-diferente-mantém-e-reporta, backup + gate de validação antes do rename.
- **Arquivos:** novo core/shared/lib/opencode-config-migration.mjs;
  core/claude-code/skills/initializing-projects/references/vendor-core.mjs:503-514
  (`writeOpencodeConfig` chama a migração antes do write — path real; NÃO existe
  core/vps/vendor-core.mjs), :515-518 (fallback manual fica); comparador de geração normaliza os 3
  formatos de stamp (SHA puro = geração zero; `vX.Y.Z`; git-describe com strip de `-N-g<sha>`).
  Modelo de código já aceito no repo: routing-adapter.mjs:11-13 (`LEGACY_GROK_SET`) e :26-33
  (`adaptRoutingV1`).
- **Tamanho:** L (~400 linhas com testes; justificativa: é uma unidade — lib + ledger + hook do
  vendor-core não sobem separados sem quebrar o contrato de idempotência).
- **Dependências:** 1, 2, 3 (o harnessSet final precisa estar definido para o manifest da geração
  nova); 4 recomendado antes.
- **Aceite:** testes novos de opencode-config-migration: Tier 1/2/3; idempotência por HASH (2ª
  passada byte-idêntica); mismatch de valor mantém + reporta; os 3 formatos de stamp; parse-fail →
  não renomeia, cai no caminho opencode.harness.json. Manual: update em /root/dev/harness-361
  remove os 3 `npx github:...#*` wildcard; em /root/dev/victor-bot mantém e REPORTA
  `"git pull*"` e `"*":"allow"`.
- **Risco:** médio (escreve config de projeto de terceiros). Observar: primeiro update real com o
  relatório de chaves promovidas/removidas.
- **Sensível:** não (config; não toca package.json nem segredo).

### 6. [harness] oc-fleet-seed-migration
- **Entrega:** a frota para de re-impor o set velho em todo worktree: a base do seed passa pela
  migração antes do enforcement, o ratchet de deny deixa cair chave aposentada (e só ela), e a
  DANGEROUS_BASH_DENYLIST encolhe pros 6 denies git do CC com teste de disjunção contra o ledger.
- **Arquivos:** core/vps/cron-a-dispatch.mjs:947 (migrar baseConfig antes de
  enforceOpencodePermissions), :586 (ratchet: deny protegido só quando a chave não está no ledger),
  :436-458 (corte da denylist), :591 (`bash["*"]="allow"` fica worktree-only e entra no ledger como
  resíduo de frota reconhecível — victor-bot é a prova do vazamento).
- **Tamanho:** M (~250 linhas).
- **Dependências:** 5 (importa a lib e o ledger), 3.
- **Aceite:** cron-a-dispatch-seed.test.mjs: worktree semeado de projeto com denies aposentados sai
  limpo; teste de disjunção `keys(DANGEROUS_BASH_DENYLIST) ∩ keys(RETIRED_OC_PERMISSION_ENTRIES)
  === ∅`; chave do operador com deny custom SOBREVIVE ao seed.
- **Risco:** alto (caminho de seed da frota inteira). Observar: 2-3 ciclos de frota no Telegram feed.
- **Sensível:** não.

## Trilha B — Muralha bash (paralela à A e à C)

### 7. [harness] oc-forge-wall-removal
- **Entrega:** o bash do OC volta a se comportar como o do CC — a muralha anti-forgery inteira sai
  (~20 classes negadas antes de qualquer contexto), entra o canal advisory (allow + aviso, a
  capacidade CC cuja ausência fez toda orientação virar deny), e a prosa que ensinava a muralha é
  aposentada (lista fechada de sites com quote e ação — 6 executores, build, planner, plan,
  4 SKILL.md, AGENTS.md) com grep-gate permanente no CI.
- **Arquivos:** core/opencode/plugin/lib/bash-decide.mjs:993-1142 (decideBashForge), :960-987,
  constantes :21-82/:897-908; core/opencode/plugin/entry-gate.ts:263-265 + import :183-188;
  advisory: typedef Decision (bash-decide.mjs:17) + applyAdvisory ao lado de :1636-1640; prosa:
  executor-*.md:44/:47 (6 arquivos), build.md:71/:74/:96/:117, planner.md:68, plan.md:50,
  creating-plans SKILL.md:102, orchestrating-delivery SKILL.md:101/:109/:225/:299/:316/:324,
  grill SKILL.md:96-98, brainstorming SKILL.md:84, AGENTS.md:171 (o :169 fica — nudge legítimo);
  grep-gate em .github/workflows/ci.yml.
- **Tamanho:** L (>400 linhas, justificado: é deleção em bloco + reescrita de teste; partir a
  deleção deixaria a muralha meio-viva com detectores órfãos).
- **Dependências:** nenhuma (paralela à trilha A).
- **Aceite:** bash-decide.test.mjs reescrito (casos forge viram allow); entry-gate.test.mjs; grep-gate
  do CI verde (frases mortas = 0 hits); `npm test` completo.
- **Risco:** médio. Observar: registro de fricção — nenhum comando prescrito do harness pode ser
  negado depois disto.
- **Sensível:** não.

### 8. [harness] oc-command-resolver-removal
- **Entrega:** remove a ferramenta `verify` e o command-resolver, órfãos com a muralha morta —
  **incluindo a entrada no manifesto da frota**, sem a qual todo seed lançaria fail-closed e a
  frota OC morreria com a suite verde (achado da lente de frota).
- **Arquivos:** core/opencode/plugin/command-resolver.ts (deleta);
  core/vps/cron-a-dispatch.mjs:494 (CANONICAL_OC_PLUGINS) — o guard :877-896 lança se ficar;
  plugin-default-export.test.mjs, cron-a-dispatch-seed.test.mjs.
- **Tamanho:** S (~150 linhas, maioria deleção).
- **Dependências:** 7 (os únicos produtores do `denied_class` que ele resolve morrem lá).
- **Aceite:** cron-a-dispatch-seed.test.mjs verde SEM command-resolver.ts no disco;
  plugin-default-export.test.mjs atualizado; grep `command-resolver` em core/ retorna só histórico.
- **Risco:** médio (frota). Observar: 1 seed real pós-merge.
- **Sensível:** não.

### 9. [harness] oc-delivery-gate-alignment
- **Entrega:** o portão de entrega bash do OC fica byte-equivalente ao do CC: 4 trilhos
  (branch/zero-commits, regate, captura, real-file), fail-open em infra, escada de modo inteira
  fora, mais os 2 portes CC (trilho estreito de spawn-hand, gatilho de captura no freeze-commit).
- **Arquivos:** core/opencode/plugin/entry-gate.ts:272-274/:289-297;
  bash-decide.mjs:1292-1308/:1321-1430/:1447-1457/:1502-1512/:1514-1559/:1567-1588/:1597-1629;
  is-delivery-command.mjs:11-29; portes: espelho de entry-gate.mjs:451-521 e :530-554.
- **Tamanho:** L (>400 linhas, justificado: espelhamento caso-a-caso de uma suite inteira; os
  trilhos mantidos 1:1 não são tocados).
- **Dependências:** 7 (o branch bash de entry-gate.ts é reescrito lá primeiro).
- **Aceite:** suite delivery de bash-decide.test.mjs espelhando entry-gate.test.mjs e
  entry-gate-corrupt-regate.test.mjs do CC caso a caso; repro gestao: commit em feature branch +
  `.state/` vazio → entrega permitida; regate-pending não-absolvido → negada NOS DOIS runtimes.
- **Risco:** médio-alto (é o portão de push). Observar: primeiro push real de pipeline OC.
- **Sensível:** não.

## Trilha C — Superfície de dispatch (a prioridade nº 1 pela alcançabilidade)

### 10. [harness] oc-plan-gate-conditional
- **Entrega:** mata a parede nº 1 do trilho de dispatch (plan-gate.ts:111 — primeira negação no
  repro do gestao E no fix-mode da frota): o bloco requiresFullPlan vira condicional à existência
  do binding (ausente → skip fail-open, igual CC que não tem gate de plano em dispatch; presente →
  snapshot + mismatch positivo + injeção do plano). Inclui o par atômico T14+T17: marcador de
  prompt deixa de ser exigido e o obs-hand para de negar dispatch (3 sites → shadow-record
  preservando todos os writes de evidência).
- **Arquivos:** core/opencode/plugin/plan-gate.ts:82-150 (bloco condicional; `if (!sid) return`;
  reconciliação ilegível → log+return; :85/:103/:105-109/:137 saem; :127/:130/:141 só no branch
  artefato-presente); obs-hand.ts:234/:237/:247 (shadow-record; writes :238-254/:276-278/:341-343
  preservados) e os 7 after/event por higiene.
- **Tamanho:** L (~400 linhas com testes).
- **Dependências:** nenhuma dura (independente das trilhas A/B — pode começar já).
- **Aceite:** plan-gate.test.mjs: sniper/executor com gate-state VAZIO → permitido (o caso
  fix-mode); binding presente + snapshot divergente → deny; envelope featureId conflitante com
  artefato presente → deny, ausente → skip. obs-hand tests: claim rejeitado ainda gera hand-record
  + capture_verified no after-hook. Nota consciente no PR: single-flight de mão de escrita
  abandonada (paridade — CC não tem; serialização real da frota é o run-lock).
- **Risco:** alto (coração da pipeline). Observar: primeiro run LIGHT/FULL completo em OC.
- **Sensível:** não.

### 11. [harness] oc-planner-dispatch-unbrick
- **Entrega:** mata a parede nº 2 (entry-gate.ts:377 + cascata de auto-envenenamento S1b, a forma
  do stall #82): o loop de ceremony-recovery sai, o portão do planner vira o deny instrutivo
  CC-shaped que o OC já tinha morto (entry-decide.mjs:95-110), o featureMismatch do CC é portado, e
  o lifecycle do claim é reparado (claim de call morto → reconciliar/adotar sob lock — sem isso o
  planner rodaria a sessão inteira e o plano seria descartado como stale).
- **Arquivos:** core/opencode/plugin/entry-gate.ts:356-381 (deleta o loop);
  lib/entry-decide.mjs:95-110 (+featureMismatch, espelho de entry-gate.mjs:944-947);
  planner-recovery.ts:131/:137/:167 (allow+log; :141 fica); lib/planner-state.mjs (reconcile/adopt
  de claim morto; hoje expires_at:null em :147-148 e o descarte silencioso em :158-159 →
  planner-recovery.ts:257).
- **Tamanho:** M (~300 linhas).
- **Dependências:** nenhuma dura; recomendado na mesma janela do 10.
- **Aceite:** repro: planner com `.state/` vazio → deny instrutivo CEREMONY_PROOF_REQUIRED (NÃO
  allow — o CC também nega; a linha antiga do Lote 4 esperava o verde errado); 2º dispatch após o
  1º negado → o MESMO deny instrutivo (cascata morta); claim de call morto + dispatch novo → plano
  retornado BINDA (accepted:true). Suites: entry-gate.test.mjs (OC), entry-decide.test.mjs,
  planner-recovery tests, ceremony-recovery.test.mjs.
- **Risco:** médio. Observar: sessão OC interativa fria consegue chegar ao planner via classify.
- **Sensível:** não.

### 12. [harness] oc-entry-gate-dispatch-failopen
- **Entrega:** o entry-gate OC (último da cadeia) fica fail-open como o CC: gate-state ilegível não
  nega, o teto-de-teto gate-blocked sai, **o retry K=3 do mesmo agente sai também (decisão do
  operador 2026-07-26: paridade total — o teto real de custo já vive no motor da frota,
  `cron-a-exit.mjs:116` retryCeilingK por issue e `cron-review.mjs:84` por pr:sha, exatamente onde o
  Claude Code põe o dele; o K=3 in-session era um segundo freio redundante)**, o congelamento
  de mãos de escrita por review-cap sai, e o loop-guard alinha warn>3/deny>10 com o sinal de
  headless espelhando o CC byte a byte e o warn entregue por prompt-append (hoje é string morta).
- **Arquivos:** core/opencode/plugin/entry-gate.ts:334-336/**:339-354 (o bloco inteiro do
  `decideAgentRetryAllowed` + `decideGateBlockedDispatchAllowed` sai)**/:401-404;
  `core/shared/lib/agent-retry.mjs` fica órfão (nenhum arquivo de core/claude-code o importa) —
  remover ou deixar morto, decidir no PR;
  lib/loop-decide.mjs:18-23/:646-648/:660-676 (decideReviewCapBeforeWriting sai);
  loop-guard.ts:259-270 (warn por prompt-append; reserveReviewAttempt em repo frio → allow);
  sinal: `Boolean(env.CLAUDE_CODE_REMOTE)` exato (espelho entry-gate.mjs:116-118 — NUNCA
  HARNESS_NOTIFY_PROJECT etc.: a frota deleta CLAUDE_CODE_REMOTE em cron-a-dispatch.mjs:1372 e a
  frota CC MANTÉM o hard-stop >10; keying errado tiraria da frota OC um teto que a CC tem).
  Drive-bys de carona: catch-alls mortos entry-decide.mjs:142-148 e dual-enforcement.mjs:408-418 →
  allow+log.
- **Tamanho:** M (~350 linhas).
- **Dependências:** 10 (as expectativas de teste do trilho mudam com o plan-gate condicional).
- **Aceite:** executor com `review_cap_reached` → permitido; plan-review rodada 5 → warn (visível
  no prompt), rodada 11 interativa → deny, rodada 11 com CLAUDE_CODE_REMOTE set → warn-only; env
  com cara de frota (HARNESS_NOTIFY_PROJECT set, CLAUDE_CODE_REMOTE ausente) → deny>10 MANTIDO;
  adversary em repo frio → não morre em identity-mismatch de reserva. Suites:
  review-accounting.test.mjs, entry-gate.test.mjs, loop-guard tests.
- **Risco:** médio. Observar: convergência de review na frota (chain-ceiling do Node segue sendo o
  teto real).
- **Sensível:** não.

### 13. [harness] oc-dual-gate-to-recording
- **Entrega:** o gate de dual/plan_verdict sai da superfície de dispatch de hand (T2 ampliado — a
  primeira rodada só alinhava o throw de infra e deixava ~7 denies vivos por default; era o que
  congelava mãos de escrita em rodada REVISE). Dual-enforcement sobrevive como GRAVAÇÃO; a
  disciplina volta a ser prosa+orquestração, como no CC.
- **Arquivos:** core/opencode/plugin/lib/dual-enforcement.mjs:228-418/:705-711 (decide vira
  record-only no caminho de hand); plan-gate.ts:152 e entry-gate.ts:415 (call sites — o segundo já
  é sombreado e sai).
- **Tamanho:** M (~250 linhas).
- **Dependências:** 10 (mesmo arquivo plan-gate.ts).
- **Aceite:** executor dispatch com dual_status pendente/REVISE → permitido; a GRAVAÇÃO de
  dual_status/plan_verdict continua íntegra (testes de recording); ausência e corrupção de
  gate-state comportam-se igual. Suites: dual-enforcement*.test.mjs.
- **Risco:** médio. Observar: um ciclo FULL com plan-review REVISE → o orquestrador (não o gate)
  segura a mão.
- **Sensível:** não.

### 14. [harness] oc-cc-gate1-gate3-fidelity
- **Entrega:** fecha a paridade na direção contrária no dispatch (3 denies CC sem contraparte OC):
  Gate 1 estrito (papel de entrega/hand só sob modo LIGHT/FULL — hoje QUICK/no-ceremony deixa
  executor/sniper/planner passarem onde o CC nega), Gate 3 do shipper (regate corrompido
  fail-closed + pending sem absolvição, com a mensagem instrutiva do CC), e fidelity alinhado
  (sniper ISENTO como no CC; match por feature `startsWith`, não por task exata — a 2ª parede do
  fix-mode).
- **Arquivos:** core/opencode/plugin/lib/entry-decide.mjs:69-92 (predicado de modo), branch shipper
  novo (espelho de entry-gate.mjs:997-1028; helpers regate-classify.mjs já em core/shared/lib),
  :122 (isSniperRole sai) e :33-35 (feature-level).
- **Tamanho:** M (~300 linhas).
- **Dependências:** 10 e 12 (entry-decide.mjs empilha mudanças).
- **Aceite:** executor sob carimbo QUICK → deny instrutivo (igual CC); shipper com regate_pending
  corrompido → deny fail-closed (a ÚNICA exceção deliberada de fail-open, contrato
  entry-gate.mjs:7-15); sniper de fix-mode (sessão nova, fidelity vazio) → permitido; executor
  headless com fidelity de OUTRA task da mesma feature → permitido. Suites: entry-decide.test.mjs +
  caso novo em cron-a-dispatch-fixmode.test.mjs (dispatch do sniper atravessa a cadeia).
- **Risco:** médio. Observar: fix-mode da frota converge (BLOCK → re-dispatch → verde) — era
  logicamente impossível antes de 10+14.
- **Sensível:** não.

### 15. [harness] oc-seal-binding-identity-removal
- **Entrega:** remove o seal HMAC por processo (o auto-brick do #423 — todo restart invalida toda
  cerimônia anterior), o session-binding, e o identity-alias que lança em todo tool; derruba a
  muralha bash do plan-write-gate durante hand ativa. Integridade de marker que fica: a ferramenta
  nativa marker-authority (divergência consciente onde o OC é MELHOR que o CC).
- **Arquivos:** core/opencode/plugin/lib/marker-seal.mjs (morre quando `grep -rn marker_seals
  core/opencode` só retornar teste); sites de leitura entry-gate.ts:277-281/:382-388,
  plan-gate.ts:105, ceremony-transition.mjs:134, ceremony-binding.mjs:38-50 (edições DENTRO do
  módulo — 5 consumidores preservados); writers marker-authority.ts:169-177, regate-arm.mjs:94-102,
  ceremony-transition.mjs:152-160, host-hand-capture.mjs:127-176; hook-identity.mjs:25-31
  (tolerante, `subagent_type` primeiro na ordem de alias) + entry-gate.ts:234;
  plan-write-gate.ts:230-256 e :164-166/:187-194.
- **Tamanho:** L (~400 linhas).
- **Dependências:** 10 (plan-gate.ts é tocado pelos dois — ordem de merge).
- **Aceite:** cerimônia criada num processo → dispatch/entrega verificam num processo NOVO
  (restart não bricka mais); marker-authority.test.mjs, marker-security.test.mjs,
  plan-write-gate.test.mjs, hook-identity.test.mjs, ceremony-*.test.mjs,
  plugin-default-export.test.mjs (plugin carrega).
- **Risco:** médio-alto (mexe em 5 consumidores de um módulo). Observar: run FULL sobrevivendo a um
  restart de OpenCode no meio.
- **Sensível:** não.

## Trilha D — Itens independentes (paralelos a tudo)

### 16. [harness] oc-plugin-order-explicit
- **Entrega:** a ordem da cadeia de plugins (planner-recovery → plan-gate → obs-hand → loop-guard →
  entry-gate) deixa de ser herança não-documentada do readdir do filesystem e vira contrato — hoje
  qual deny o operador vê depende de glob sem sort (upstream v1.18.5) + ordem de diretório ext4, e
  um rename de arquivo reordena os portões silenciosamente.
- **Arquivos:** teste novo em core/opencode/plugin/ afirmando a ordem observada; doc da ordem no
  AGENTS.md ou README do plugin dir.
  **Mecanismo decidido (engenharia, 2026-07-26): teste de regressão apenas, NÃO renomear agora.**
  As trilhas B e C reescrevem exatamente estes arquivos; prefixar nomes durante a reescrita geraria
  conflito de merge e risco sem ganho imediato. O teste já elimina o modo de falha real (a ordem
  mudar sem ninguém notar). Reavaliar prefixo numérico/loader único DEPOIS que as trilhas B e C
  fecharem, ou assim que um sexto plugin entrar na cadeia — o que vier primeiro.
- **Tamanho:** S (~100 linhas).
- **Dependências:** nenhuma.
- **Aceite:** teste que falha se a ordem de descoberta divergir da documentada (mesmo glob+opções
  do upstream).
- **Risco:** baixo.
- **Sensível:** não.

### 17. [harness] oc-version-check-stale-signal
- **Entrega:** projeto OC-vendorizado ganha o sinal de "harness desatualizado" que o lado Claude já
  tem — hoje core/opencode/plugin/version-check.ts, apesar do nome, tem ZERO ocorrência de
  `harness-version` (só checa presença do catálogo de agentes); harness-361 e o próprio .opencode
  deste repo estão stale desde 2026-07-12 sem sinal algum.
- **Arquivos:** core/opencode/plugin/version-check.ts (porta a lógica de
  core/claude-code/hooks/version-check.mjs:128 — lê `.opencode/.harness-version`, resolve a última
  release com cache, emite aviso pelo canal de prosa do plugin).
- **Tamanho:** S (~150 linhas).
- **Dependências:** nenhuma.
- **Aceite:** teste com stamp antigo + release nova mockada → aviso emitido; stamp atual → silêncio;
  gh indisponível → silêncio (fail-soft). Os 3 formatos de stamp parseiam.
- **Risco:** baixo.
- **Sensível:** não.

### 18. [harness] cc-settings-migration
- **Entrega:** fecha o buraco espelho do lado CLAUDE, o pior achado do levantamento: `writeSettings`
  nunca atualiza um `.claude/settings.json` existente (escreve `settings.harness.json` "pra merge
  manual" que nunca aconteceu — 4 projetos com o órfão; ass-fin-app roda SEM os denies de
  secret-read desde v0.18.7). Mesmo modelo do item 5: merge das chaves harness-owned no update, com
  relatório e backup.
- **Arquivos:** core/claude-code/skills/initializing-projects/references/vendor-core.mjs:1271-1281
  (+ reconciliação dos settings.harness.json órfãos encontrados).
- **Tamanho:** M (~250 linhas).
- **Dependências:** 5 (reusa o padrão manifest/ledger; pode adaptar, não copiar).
- **Aceite:** update em projeto com settings.json existente injeta os denies de secret-read
  preservando permissões do operador; órfão settings.harness.json é consumido/removido; 2ª passada
  idempotente. Manual: ass-fin-app ganha `Read(.env)` denies após update.
- **Risco:** médio. **Sensível: sim** (mexe em permissões de segredo de projetos reais).

### 19. [harness] oc-revendor-fleet-smoke (fecha o programa)
- **Entrega:** a paridade chega aos projetos: re-vendor dos 13 projetos do levantamento (gestao
  como caso de teste, harness-361/victor-bot como casos de migração), e o dry-run de fix-mode
  CORRIGIDO — exercitando o DISPATCH do sniper com gate-state vazio através da cadeia de 5 plugins
  (a versão antiga só testava o push, que nunca era onde o fix-mode morria).
- **Arquivos:** nenhum código novo além de casos de teste
  (core/vps/cron-a-dispatch-fixmode.test.mjs: sniper Task dispatch em estado vazio sobrevive);
  execução: `updating-harness`/`oc-updating-harness` por projeto.
- **Tamanho:** M (mão de obra + ~100 linhas de teste).
- **Dependências:** 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 17 (tudo que precisa estar no core antes de
  vendorizar).
- **Aceite:** manifest sidecar presente nos 13; harness-361 sem os npx wildcard; victor-bot com
  relatório das chaves mantidas; 1 ciclo real da frota OC no Telegram feed com
  BLOCK→fix-mode→convergência de ponta a ponta; repro original do gestao fechado (commit + push +
  pipeline por dispatch).
- **Risco:** médio. Observar: a primeira semana de frota OC pós-paridade.
- **Sensível:** não.

---

### 20. [harness] force-with-lease-allow-both-runtimes
- **Entrega:** libera explicitamente `git push --force-with-lease*` (o comando COM trava de
  segurança, que só sobrescreve se ninguém tiver mexido depois) nos dois runtimes, mantendo o
  `--force` cru negado. Hoje o glob `git push --force*` derruba os dois juntos — e a recovery de PR
  obsoleto em branch per-run prescreve justamente o seguro, então a frota fica sem saída quando cai
  nesse caso (negação viva registrada no log do OpenCode).
- **Arquivos:** core/claude-code/settings.json:72 (allow explícito ACIMA do deny);
  core/opencode/opencode.json.example:90; o `opencode.json` rastreado deste repo;
  core/vps/cron-a-dispatch.mjs:437 (DANGEROUS_BASH_DENYLIST). A ordem importa: o allow do padrão
  mais específico tem de preceder o deny do glob mais largo em cada um dos quatro.
- **Tamanho:** S (~20 linhas).
- **Dependências:** nenhuma. Pode andar a qualquer momento. Se o item 1 ou 3 mexer nos mesmos
  blocos de permissão, coordenar para não haver conflito de merge.
- **Aceite:** `--force-with-lease` permitido e `--force` cru negado, verificado nos quatro arquivos;
  suíte de permissão do cron-a-dispatch verde (cron-a-dispatch.test.mjs, cron-a-dispatch-seed.test.mjs).
- **Risco:** baixo. Observar: nenhum `--force` cru deve passar a ser aceito por efeito colateral da
  reordenação.
- **Sensível:** não.
- **Origem:** decisão do operador 2026-07-26 (risco compartilhado 6.2 do relatório — corrigido nos
  DOIS runtimes ao mesmo tempo, nunca só no OpenCode).

---

## Sequência e paralelismo

```
Trilha A: 1, 2, 3 (paralelos) → 5 → 6
Trilha B: 7 → 8, 9 (paralelos entre si)
Trilha C: 10, 11 (paralelos) → 12 → 13, 14 (paralelos) → 15
Trilha D: 4, 16, 17, 20 a qualquer momento; 18 depois de 5
Fecho:    19 depois de tudo
```

As três trilhas A/B/C são independentes entre si — três pares de mãos podem andar em paralelo.
**Se só uma coisa puder andar primeiro, é a trilha C (10 e 11):** pela alcançabilidade, são as duas
únicas paredes que o operador de fato encontra (plan-gate.ts:111 e entry-gate.ts:377); tudo o mais
é invisível até elas caírem.

**Descartado como churn (não criar issue):** os catch-alls mortos T3/T4 (viram drive-by no item
12), dual-enforcement.mjs:400 (inalcançável por enum fechado), entry-decide.mjs:100/:107 (código
morto que o item 11 revive ao deletar o loop), entry-gate.ts:234 no Task e :415 inteiro
(sombreados — resolvidos de carona nos itens 15 e 13).

---

## Decisões — TODAS TOMADAS em 2026-07-26

- **Projeto só-frota fica stale: aceito.** Nada de update autônomo. Esses projetos são atualizados
  manualmente quando o operador passar por eles. Consequência assumida: um projeto tocado apenas
  pela frota pode rodar meses na versão antiga sem ninguém perceber. O item 17
  (`oc-version-check-stale-signal`) fica ainda mais importante — é o único aviso que resta.
  (Itens 5/6/19 seguem como estão; nenhum ganha caminho autônomo.)
- **`--force-with-lease`: liberar nos DOIS runtimes.** Vira o item 20 abaixo. O `--force` cru
  continua negado nos dois.
- **Retry K=3 do mesmo agente: TIRAR e não repor.** Paridade total com o Claude Code. Verificado
  antes de fechar a decisão: o teto de custo real NÃO é o K=3 in-session — é o motor da frota
  (`core/vps/cron-a-exit.mjs:116`, contador por issue ≥ retryCeilingK → `harness:blocked`; e
  `core/vps/cron-review.mjs:84`, teto de falha de infra por pr:sha). É exatamente onde o Claude Code
  põe as dele, fora da sessão e independente do modelo se comportar. O K=3 era um segundo freio,
  redundante. (Absorvido pelo item 12.)

- **`question`: allow em sessão local, deny só no worktree headless.** O agente volta a poder
  consultar o operador quando há operador; segue proibido onde não há quem responda. (Item 3.)
- **`edit` do planner: allow.** A proibição não protegia mais nada desde o PR #449. (Item 2.)
- **Teto >10 de plan-review: manter idêntico ao Claude Code.** Nenhuma mudança de calibração; se um
  dia mudar, muda nos dois runtimes juntos. (Risco compartilhado 6.3 do relatório.)
- **Ordem dos plugins: teste de regressão, sem renomear agora** — decisão de engenharia tomada pelo
  sistema, registrada no item 16 com o gatilho de reavaliação.

## Decisões de operador AINDA ABERTAS

Nenhuma. Todas as decisões de produto estão tomadas; o roadmap está pronto para virar issues.
