# OpenCode closure roadmap (por severidade)

**Objetivo:** OC LIGHT/FULL fluido e seguro como CC headless — sem QUICK launder, com capture real e forense de provider.  
**Não fazer:** port wholesale do CC (introduz regressões; OC já é superior em planner/ceremony locks).

## Critério de pronto

1. CI verde no commit consumido.
2. Plugins carregam **uma** vez (OC real, HOME/XDG isolado).
3. `classify` monotônico: replay no-op; só escalate; nunca wipe mid-ceremony.
4. Cap de review **bloqueia delivery** até recovery canônico (não reclassify QUICK).
5. Cada writing-hand task: capture oracle (diff + scope + locked test) bound ao plano.
6. LIGHT E2E real até draft PR **sem** bypass do coordinator.
7. Erros de eye preservam receipt sanitizado (status/model/call).

---

## P0 — fecha o buraco do #72 (hoje)

### P0.1 Classify monotônico + idempotente

| | |
|---|---|
| **Problema** | Re-classify wipe + downgrade LIGHT→QUICK |
| **Fix** | rank `no-ceremony < QUICK < LIGHT < FULL`; same session+feature+mode = no-op byte-neutral; escalate ok preservando ceremony aplicável; downgrade/feature-switch deny; `peak_mode` stamp; obs só em transição real |
| **Files** | `core/shared/lib/classify-stub.mjs`, `core/opencode/tools/classify.ts`, `classify-persist.mjs`, prosa `build.md` / `triaging-requests` |
| **Tests** | matriz 4×4; replay; downgrade deny; escalate preserve ceremony |

### P0.2 Anti-QUICK-launder no delivery

| | |
|---|---|
| **Problema** | Após cap/ceremony, QUICK ship passa |
| **Fix** | `decideBashDelivery`: se mode QUICK e residual elevado (`peak_mode` LIGHT/FULL, brainstormed/adversary, planner attempt, review_status cap, dual leftovers) → **deny** com reason product-safe |
| **Files** | `bash-decide.mjs` + tests |
| **Tests** | QUICK puro allow; QUICK após cap deny; QUICK após brainstormed deny |

### P0.3 Cap de failure bloqueia delivery + hands

| | |
|---|---|
| **Problema** | `primary_failure_cap_reached` só para reviews |
| **Fix** | `decideReviewCapBeforeWriting` e `decideBashDelivery` negam sob ambos caps; recovery = reopen epoch canônico (não classify QUICK) |
| **Files** | `loop-decide.mjs`, `bash-decide.mjs` |
| **Tests** | writing-hand deny; git push deny; reopen path |

### P0.4 Forense de provider

| | |
|---|---|
| **Problema** | bucket cego; 402/429 misturados |
| **Fix** | classes `rate_limited`/`credit`; receipt sanitizado bounded (`status`, `model`, `call_id`, `message` truncado, sem secrets) em `review_outcomes` / `last_provider_diagnostic` |
| **Files** | `loop-decide.mjs`, `loop-guard.ts` |
| **Tests** | 401/402/429/503; receipt shape; no secret leak |

### P0.5 Binding: silence eyes + foreground pending

| | |
|---|---|
| **Problema** | unbound spam; foreground nunca marca pending |
| **Fix** | `cleanupChild` no-op se sem process/pending binding (sem diagnostic); terminal after writing-hand com `metadata.sessionId` → `markDispatchBindingPending` + bind; liveClaims usa token autoritativo |
| **Files** | `obs-hand.ts`, `dispatch-scope.mjs` |
| **Tests** | eye idle silent; foreground bind; double before token |

### P0.6 Docs/prosa recovery

| | |
|---|---|
| **Problema** | “Halt” empurra pro QUICK |
| **Fix** | OD/build: no cap → stop + comment PR / reopen ceremony; **nunca** reclassify down |
| **Files** | `orchestrating-delivery/SKILL.md`, `build.md`, `triaging-requests` |

---

## P1 — paridade de integridade (logo após P0)

### P1.1 Capture oracle no path Task

Portar semântica CC `capture-hand` / OC `run-hand` oracle → `obs-hand` after.  
`Status: DONE` = info, nunca autoridade.  
`marker-authority` exige receipt oracle.

### P1.2 Cobertura multitask no push

Snapshot bound → toda writing task com capture corrente da sessão.

### P1.3 Review lease + snapshot hash

Padrão planner-state em `review_inflight` (token, expires, plan binding). Late result não aprova plano novo.

### P1.4 Coordinator bash write wall (LIGHT/FULL)

Product paths deny via bash no build; allow só artefatos plan/spec/state allowlisted.

### P1.5 Final review em LIGHT

bash-decide exige final-review receipt em LIGHT e FULL (hoje só FULL).

---

## P2 — higiene / distribuição

- Vendor update convergente (prune plugins aposentados).
- Probe OC real `plugin:[]` + single factory.
- Isolar HOME/XDG no headless.
- validate-plan alinhado ao contrato planner.
- Marcar docs 2026-07-17 como histórico.
- E2E LIGHT + FULL em projeto consumidor com falhas injetadas.

---

## Sequência de merge (mínima e segura)

```
1. P0.1 classify monotonic          ← impede wipe/downgrade
2. P0.2 + P0.3 anti-launder + cap   ← impede ship sujo
3. P0.4 provider forensics          ← enxerga a próxima falha xAI
4. P0.5 binding noise + foreground  ← limpa N1 falso positivo
5. P0.6 prosa recovery
6. vendor victor-bot + smoke #72
7. P1.1 capture oracle              ← antes de declarar paridade
```

**Não bloquear smoke #72 em P1.1** se P0.1–P0.3 estiverem verdes — o escape principal fecha sem oracle.  
**Não declarar paridade CC** sem P1.1 + E2E.

---

## O que portar do CC vs reutilizar do OC

| Portar do CC | Reutilizar do OC | Não portar |
|---|---|---|
| Capture independente (diff/test/scope) | Planner claim/lease/fencing | Contador reviewer por dispatch |
| Conceito CI feature-wide (receipt endurecido) | Ceremony generation/bindings | Gate-state sem lock |
| | Dual por fase + REVISE block | Dedupe classify só por tipo no feed |
| | Dispatch-scope locks | Bash amplo fora do write-gate |

---

## Smoke de aceite (pós-P0)

1. Re-vendor victor-bot (`plugin:[]`, routing xai-ollama ou openai-ollama se liberado).
2. Dispatch #72 (ou issue clone).
3. **Pass:** mode permanece LIGHT/FULL; 0 reclassify down; se cap → delivery-blocked sem PR QUICK.
4. **Pass:** scope-terminal sem unbound de eyes/parents.
5. **Pass:** se eye falhar, receipt com status/model no gate-state.
6. **Fail criteria:** PR draft com `mode:QUICK` após ceremony LIGHT; 0 hand-records em LIGHT ship.
