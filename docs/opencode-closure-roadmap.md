# OpenCode closure roadmap (pós-smoke #72 verde)

**Atualizado:** 2026-07-19 (após #400–#412 + smoke headless #72 → draft PR #81)  
**Objetivo residual:** endurecer forense, custo de tool e edges de review — **não** relitigar o path LIGHT que já fecha.

**Estado pós-#412:** A1 (forense: `gate_blocked` + `upstream_5xx`) e A2 (prosa custo) fechados. A3/A4 já estavam verdes no OpenCode. **Único item vivo: A5** (capture multitask no push) — deferido de propósito até a 1ª run FULL real (armar bloqueio cego num caminho não-testado quebraria a run). Próximo passo natural: **rodar 1 smoke FULL** e então armar A5.

**Não fazer:** port wholesale do CC; reabrir P0s marcados DONE sem evidência nova de run.

---

## Prova de vida (aceite operacional)

| Check | Resultado |
|---|---|
| Issue | Syntifai-AI/victor-bot-atendimento **#72** |
| Runtime | OpenCode headless, routing xai-ollama-dual |
| Harness | #400–#411 em `main` (auto-bind + heredoc/`$DIR` = #410/#411) |
| Gate | `mode:LIGHT`, `planner_status:usable`, `plan_verdict:APPROVE` |
| Hands | hand-record task-1 **DONE** + `capturedVerifiedAt` |
| Ship | draft PR **#81** · issue **`harness:in-review`** |
| Deny `$` expansion | **0** na run de aceite |

Isso invalida como “blocker de sessão” a maior parte do inventário antigo (hand-record zero, capture impossível, QUICK launder, plan_pending_write eterno, `$` no spec mata run).

---

## DONE — não reabrir sem evidência nova

| ID | Tema | Onde fechou |
|---|---|---|
| D1 | Double-load plugins | #402 `plugin:[]` + auto-glob |
| D2 | Classify monotônico / anti-downgrade / peak_mode | #403 + prosa |
| D3 | Anti-QUICK-launder no delivery | #403 bash-decide residue |
| D4 | Cap bloqueia delivery (não vira QUICK ship) | #403 |
| D5 | Classify só top-level build | #405 |
| D6 | Planner primary-only (sem lease kill / fallback ladder) | #406 |
| D7 | Retry K=3 + dedupe callId | #407 #408 |
| D8 | Capture/ship nativo OC (Task hand, não spawn CC) | #409 |
| D9 | Auto-bind `execution-plan.json` → usable | #410 |
| D10 | Heredoc quotado + `$DIR` plan/spec (false deny) | #410 #411 |
| D11 | LIGHT E2E headless até draft PR | smoke #72 → PR #81 |
| D12 | Forense provider: `gate_blocked` (deny interno ≠ provider) + `upstream_5xx` distinto | #412 (grounded em `ses_084fd366`) |

Docs históricos (mapa 2026-07-17, findings #72 pré-fix): **arquivo**, não backlog ativo. Ver § Histórico.

---

## AINDA FAZ SENTIDO — backlog ativo

Ordenado por **impacto em custo/$ ou risco de merge sujo**, não por nostalgia da vistoria.

### A1 — Forense de provider (ex-P0.4 / R1–R2) · **✅ DONE #412**

| | |
|---|---|
| **Por quê** | Eye `provider_error` genérico → cego; 402/429 misturados; run anterior perdeu HTTP no wipe de log |
| **Feito** | 401/402/429/503 + receipt sanitizado já existiam (27 testes). #412 fecha o residual: 5xx → classe distinta `upstream_5xx` (`provider_error` fica só como fallback desconhecido) **+ achado de produção**: denies internos do harness (`[plan-gate]`/`[loop-guard]`/`[entry-gate]`/`[money-preflight]`) eram engolidos em `provider_error` — agora classe `gate_blocked`, checada antes de qualquer status/pattern |
| **Evidência** | `ses_084fd366` gravava 2× `[plan-gate] plan_pending_write` como `provider_error`, poluindo `review_failure_counts` + streak. Nenhum run bateu o cap (inofensivo na prática) |
| **Files** | `core/opencode/plugin/lib/loop-decide.mjs` + `review-accounting.test.mjs` (3 testes novos) |

### A2 — Custo de tool: denys residuais bobos · **✅ DONE #412 (prosa)**

| | |
|---|---|
| **Por quê** | Smoke #72 ainda teve 1× `npx vitest` (`package_launcher`) — contornou, mas queima turno |
| **Evidência** | Log #72 inteiro: **1 deny real** `npx vitest` (o resto dos matches de `package_launcher`/`429`/`402` é conteúdo de teste/hash logado). Marginal |
| **Feito** | Prosa no `build` agent: preferir `node --test`/`verify`/binário local a `npx`/`npm run <script> <path>` ad-hoc; recovery de targeted-Vitest só via `verify` |
| **Deferido** | Carve-out de allowlist + métrica gateDeny por classe no exit-reason — só se o custo reaparecer em run futura (não vale complexidade agora) |

### A3 — Validate-plan + contrato do planner · **✅ já verde no OpenCode (nada a fazer)**

| | |
|---|---|
| **Por quê** | Schemas `locked_tests` triplos / example-plan inválido / tool `validate-plan` ausente (vistoria 07-17) |
| **Estado real** | OpenCode: `core/shared/lib/validate-plan.mjs` = schema canônico único; `tools/validate-plan.ts` importa dele; `core/opencode/skills/creating-plans/references/example-plan.json` valida **0 erros**; 12 testes verdes |
| **CC (não mexer)** | O harness CC usa `test_path` legado (schema próprio, auto-consistente) e **funciona bem, inclusive headless** (confirmado pelo operador). Forçar convergência arriscaria quebrar um CC saudável — fora de escopo |

### A4 — Edges de review: REVISE / dual / malformed cap · **✅ revalidado verde**

| | |
|---|---|
| **Por quê** | Histórico: REVISE útil + dual=both liberava executor; malformed sem consumir cap; dual_status global |
| **Estado real** | Rails #393/#400 verdes nos testes herméticos (`review-accounting`, `dual-enforcement`, `dual-merge`, `dual-runtime`). REVISE bloqueia writing-hand, malformed consome cap, dual por fase — todos cobertos |
| **Pendente** | 1 smoke **FULL** real ainda não rodado — revalidar quando houver (não codar sem vermelho) |

### A5 — Capture multitask + push coverage · **✅ DONE #413**

| | |
|---|---|
| **Por quê** | #72 tinha 1 task. N tasks: push deve exigir evidência de entrega **de cada** writing task do plano bound |
| **Gap fechado** | Push casava `hand_finished`↔`capture_verified` mas **não cruzava contra os writing-tasks do plano bound** — orchestrator carimbava só `[t1]` num plano de 2 → t2 escapava → feature multi-tarefa subia pela metade (e em headless auto-mergeava) |
| **Fix (#413)** | `bound-plan.mjs` (leitor do snapshot selado, path-guarded, fail-open) + step 8b em `decideBashDelivery`: cada writing-task (com `scope_paths`) exige **evidência = hand-record OU capture**. `entry-gate.ts` injeta o `boundPlan` só em delivery. Fail-open se o plano não for enumerável |
| **Adversarial** | Achado HIGH corrigido: v1 exigia capture de toda writing-task → travaria `DONE_WITH_CONCERNS` (shippable, nunca capture-stampado). v2 usa evidência=record-OU-capture, consistente com steps 7/9 |
| **Aceite** | 10 testes: silent-skip → deny; both-captured → allow; DONE_WITH_CONCERNS → allow; fail-open; path-traversal guard |
| **Residual** | MEDIUM (snapshot sem hash-verify / symlink léxico) mitigado pelo seal do `planner_plan_binding`; validar em campo na 1ª run FULL multitask |

### A6 — Final review receipt em LIGHT · **P2**

| | |
|---|---|
| **Por quê** | Roadmap antigo: final dual só FULL no bash-decide. Smoke #72 fez dual na prática — confirmar se host **exige** receipt ou só prosa |
| **Fix** | Se só prosa: gate determinístico em LIGHT também |
| **Aceite** | LIGHT sem final-review receipt → push deny |

### A7 — Regate / harvest-guard / harvester path · **P2**

| | |
|---|---|
| **Por quê** | Vistoria: regate raro; harvest-guard tool nome morto; harvester path sem sessionID |
| **Fix** | Armar regate na skill+host pós-sniper HIGH; harvest-guard no tool real; path canônico `sessionId-featureId` |
| **Aceite** | 1 teste host + 1 run com sniper HIGH gera regate_pending→passed |

### A8 — Docs históricos · **P2 chore**

| | |
|---|---|
| **Fix** | Banner no topo de `opencode-runtime-gaps-2026-07-17*.md` e `opencode-smoke-72-findings.md`: “histórico pré-#411; backlog vivo = este roadmap” |

---

## Critério de pronto (atualizado)

Já satisfeito pelo smoke #72 (não re-provar do zero):

1. ~~Plugins single-load~~  
2. ~~Classify monotônico / anti-QUICK~~  
3. ~~LIGHT E2E draft PR~~  
4. ~~Hand + capture no path Task~~  

Fechado (A1–A5):

5. ~~Forense provider com receipt no gate-state (A1)~~ → #412 (`gate_blocked` + `upstream_5xx`)  
6. ~~Validate-plan canônico (A3)~~ → já verde no OpenCode (12 testes)  
7. ~~Multitask capture no push (A5)~~ → #413 (evidência=record-OU-capture, fail-open, adversarial HIGH corrigido)  
8. ~~Edges REVISE/dual revalidados (A4)~~ → hermético verde  
9. ~~Custo: denys residuais sob controle (A2)~~ → #412 prosa (1 deny real no #72)

Ainda aberto: **nenhum item de código** — só validação de campo.

---

## Sequência de implementação (próxima sessão)

```
1. Rodar 1 smoke FULL real       ← validar A5 em campo: task pulada → deny; DONE_WITH_CONCERNS → não trava
2. A6–A8 polish                  ← quando sobrar ciclo
3. (infra) main já vermelho no CI — 8 falhas ambientais herdadas (#411): limpar num PR próprio
```

**Feito nesta sessão (#412):** A1 forense (`gate_blocked`/`upstream_5xx`, grounded em `ses_084fd366`) · A2 prosa custo · A8 banners históricos.

**Smoke de regressão (barato):** re-dispatch clone do #72 ou issue LIGHT pequena após cada batch; pass = LIGHT + usable + ≥1 capture + draft PR; fail = QUICK mid-run / 0 hands / deny `$` expansion >0.

---

## O que portar do CC vs reutilizar do OC

| Portar ideia do CC | Já no OC (manter) | Não portar |
|---|---|---|
| Receipt de provider sanitizado | Planner claim/bind/auto-bind | spawn-hand CC wholesale |
| Capture multitask no ship | Ceremony locks, dual por fase | Gate-state sem lock |
| | Task nativo + host-hand-capture | Bash amplo / npm run genérico |

---

## Histórico

| Doc | Papel |
|---|---|
| `docs/opencode-smoke-72-findings.md` | Forense do **primeiro** #72 (QUICK launder) — contexto, não backlog |
| `docs/opencode-runtime-gaps-2026-07-17*.md` | Mapa pré-#400 — vários P0 **DONE**; usar só para caçar edges A3/A4/A7 |
| Este arquivo | **Fonte de verdade** do que falta pós-#411 |
