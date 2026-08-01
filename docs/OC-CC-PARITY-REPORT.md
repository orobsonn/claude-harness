# Paridade OpenCode ↔ Claude Code — Relatório final de auditoria

**Data:** 2026-07-26
**Decisão que este relatório executa (operador):**

> "o claude code ele tanto funciona eu no loop como sem eu no loop, seja headless ou nao,
> eu so quero que o opencode tenha o mesmo harness do claude code"

O runtime Claude Code (`core/claude-code/`) é a **especificação**. Este relatório não propõe
meio-termo: é o delta que leva o harness OpenCode (`core/opencode/`) à paridade. Onde o Claude
Code permite, o OpenCode permite; onde o Claude Code nega, o OpenCode nega do mesmo jeito, no
mesmo ponto, com a mesma postura fail-open.

---

## 1. Veredito

- **A decisão do operador está citada acima e é o critério único.** O Claude Code roda hoje com
  operador no loop e sem operador no loop (frota autônoma na VPS, auto-merge após review) com o
  mesmo conjunto de trilhos. O OpenCode tem que ter exatamente esse conjunto — nem mais, nem menos.
- **Por que o OpenCode ficou inutilizável:** ele ganhou uma muralha que o Claude Code nunca teve —
  ~20 classes de comando bash negadas incondicionalmente, antes de qualquer contexto carregar
  (`decideBashForge`, core/opencode/plugin/lib/bash-decide.mjs:993-1142), mais um portão de entrega
  com 14+ checagens fail-closed (decideBashDelivery, :1252-1630) onde o Claude Code tem 4 checagens
  fail-open (core/claude-code/hooks/entry-gate.mjs:529-696, contrato "fail-open... never brick" nas
  linhas 4-6). Todo registro de fricção com repro concreto foi a muralha negando os **próprios
  comandos prescritos do harness** (typecheck do commit, instalador do update, escrita de spec,
  criação do PR de entrega) — nenhum registro mostra ela parando uma forja real.
- **O tamanho do delta:** 42 regras a **remover** (só existem no OpenCode), 38 a **alinhar**
  (existem nos dois, o OpenCode é mais estrito ou está no lugar errado), 4 capacidades a **portar**
  do Claude Code (o canal de aviso-sem-negar, o gatilho antecipado de captura, o trilho estreito de
  spawn-hand, e o **mapa de deny de leitura de segredo** — nisto o OpenCode é mais FROUXO que o
  Claude Code hoje), e **3** divergências mantidas de propósito.
- **A segunda muralha, que só esta revisão mediu:** o gate de **dispatch de agente**. O Claude Code
  tem **um** hook no matcher `Agent` com **8** denies (settings.json:88-95); o OpenCode encadeia
  **cinco** plugins com **~55** sites de deny, mais 16 em duas ferramentas nativas. A análise de
  alcançabilidade desta revisão final (seção 2) mostra que **43** desses sites são alcançáveis de um
  único dispatch, só **10** podem ser a primeira negação, e **2** explicam toda a inusabilidade
  observada (plan-gate.ts:111 e entry-gate.ts:377). Consertar só o bash entrega paridade de commit e
  push — não de pipeline, que é o que anda por dispatch (seção 3d).
- **A garantia da frota não muda:** a proteção real do merge autônomo é maquinaria Node
  independente de runtime — sessão de review fixa `claude -p` (core/vps/spawn-review-session.mjs:204),
  veredito canônico fail-closed derivado em Node (:42-56), merge com guarda TOCTOU
  (core/vps/review-merge.mjs). Nada em core/vps lê gate-state, marker_seals ou os trilhos removidos.
  Aliás: o **fix-mode** da frota (reusar branch após BLOCK de review, sem re-cerimônia) é
  estruturalmente impossível sob os trilhos atuais do OpenCode — a remoção é **pré-condição** de
  paridade de capacidade da frota, não só ganho de usabilidade.
- **A mudança estrutural que resolve a maior parte:** o caminho bash do OpenCode passa a fazer
  exatamente o que o do Claude Code faz — nada em comando não-de-entrega, e nos comandos de entrega
  apenas os 4 trilhos (branch/commits, regate, captura, real-file), fail-open em erro de infra —
  **e o caminho de dispatch passa a negar as mesmas 4 coisas que o Claude Code nega** (triagem
  ausente, cerimônia do planner, regate pendente no shipper, fidelity/hand-routing), falhando aberto
  em tudo que é infra.

---

## 2. A régua

Quantificação do desvio, medida no código:

| Dimensão | Claude Code (spec) | OpenCode (hoje) |
|---|---|---|
| Gate bash em comando comum | **zero** — `return { allow: true }` (entry-gate.mjs:564) | ~20 classes negadas incondicionalmente antes de carregar contexto (bash-decide.mjs:993-1142) |
| Gate bash em comando de entrega | **4 trilhos**: branch protegida/zero-commits (:578-609), regate (:628-651), captura (:652-674), real-file (:681-695) | **14+ checagens** (bash-decide.mjs:1252-1630): as 4 do CC **mais** load fail-closed, seal por processo, binding de cerimônia, escada de modo, review-cap, dual, final-review, demo, planner_status, delivery_status, A5, feature-id obrigatório… |
| **Gate de dispatch de agente (Task/Agent)** — *a superfície por onde a pipeline realmente anda* | **1 hook, 8 denies** — `entry-gate.mjs` é o ÚNICO PreToolUse no matcher `Agent` (settings.json:88-95): triagem ausente (:834), teto de plan-review (:898), planner sem cerimônia (:952/:967/:981), shipper com regate pendente (:1020), executor headless sem fidelity (:1088), hand-routing (:1147). Os hooks observadores (stamp-triage, obs-*, mark) têm **zero** `permissionDecision` — são PostToolUse, não podem negar | **5 plugins encadeados, ~55 denies** — todo dispatch atravessa entry-gate.ts (10 throws: :234, :335, :347, :353, :358, :375, :377, :387, :399, :403) → entry-decide.mjs (6 denies, :75-138 + catch-all :142-148) → dual-enforcement.mjs (10: :236/:280/:299/:317/:332/:346/:365/:400/:412 + throw :710) → plan-gate.ts (11: :73/:85/:89/:103/:109/:111/:121/:127/:130/:137/:141) → loop-guard.ts (:168, :259) → obs-hand.ts (10 throws). Fora do Task, mais **16** nas duas ferramentas nativas privilegiadas: command-resolver.ts (9) e marker-authority.ts (7). Nenhuma delas tem equivalente CC |
| Postura em erro de infra | **fail-open** — "exits 0 on ANY infra error… never brick" (entry-gate.mjs:4-6; implementado em :614-623) | **fail-closed** — exceção interna vira deny opaco (bash-decide.mjs:1135-1141 e :1623-1629); gate-state ilegível nega a entrega (entry-gate.ts:272-274) **e o dispatch de Task** (entry-gate.ts:334-336; dual-enforcement.mjs:705-711); e a decisão de Task tem catch-all de deny própria (entry-decide.mjs:142-148) |
| Leitura de segredo (paridade na direção CONTRÁRIA — o OC é mais FROUXO) | **8 denies de leitura por config**: `Read(.env)`, `Read(.env.*)`, `Read(//**/.env)`, `Read(//**/.env.*)`, `Read(.dev.vars)`, `Read(//**/.dev.vars)`, `Read(~/.ssh/**)`, `Read(~/.aws/**)` (settings.json:63-70) | `"read": "allow"` global, **sem nenhum deny** (opencode.json.example:40; opencode.json:40; e `read: "allow"` em HEADLESS_SAFE_PERMISSION_DEFAULTS, cron-a-dispatch.mjs:470). Só 3 agentes têm mapa de leitura seguro (plan.md:18-24, discussion-adversary.md, harness-config.md) — `build` e **todos os executores/snipers leem `.env` hoje** |
| Permission map | ~55 prefixos allow + **6** denies git destrutivos (settings.json:3-61, :71-76) | allow estreito + 12 denies no template (opencode.json.example:52-102) + **21 denies congelados em código** que a frota força em todo worktree (cron-a-dispatch.mjs:436-458) |
| Escrita de arquivo pelo agente principal | Edit/Write permitidos (settings.json:4-5); QUICK implementa inline (core/CLAUDE.md) | `edit: deny` no agente `build` (core/opencode/agents/build.md:7) — todo write vira heredoc bash, que a muralha então nega |
| Pergunta ao operador | nunca negada por config (proibição headless é prosa, core/CLAUDE.md regra de ouro #1) | `"question": "deny"` global (opencode.json.example:51 e opencode.json:51) |
| Regras OpenCode-only (sem NENHUM equivalente CC) | — | **36** (seção 3) |
| Trilhos já 1:1 (não mexer) | — | 9 (branch, zero-commits, regate corrompido, regate não-absolvido, hand-finished não-capturado, e os 4 do módulo compartilhado real-file-capture-rail.mjs) |

A assimetria foi **fundacional e admitida**: o PR #281 (commit 3ed4ad1) construiu o
decideBashDelivery fail-closed declarando "paridade CC" como objetivo e registrando no próprio
corpo, como follow-up nunca resolvido, que o CC era fail-open sem session_id. O PR #292
(commit 953373c) ergueu a muralha anti-forgery validada apenas por um adversário simulado
em sessão — nenhum incidente de produção citado. No dia seguinte, a issue #300 registra a
muralha quebrando os fluxos de rotina do próprio harness.

### Alcançabilidade do trilho de dispatch (fecha o item aberto da seção 8)

A contagem de ~55 era um `grep` por `throw`/`decision:"deny"`; esta revisão final mediu a
**alcançabilidade** de cada site a partir de um único Task dispatch. Resultados:

- **Ordem real dos plugins.** Os plugins do harness nunca entram em `plugin[]`
  (opencode.json:37 = `[]`; contrato afirmado em plugin-default-export.test.mjs:32-33) — o OpenCode
  os descobre por glob **sem sort** (upstream v1.18.5, packages/opencode/src/config/plugin.ts:21 →
  node-glob 13.0.5), e a ordem de walk medida (3x, byte-idêntica) é **alfabética reversa**. A cadeia
  de Task que trabalha de verdade fica, na ordem de execução:
  **planner-recovery → plan-gate → obs-hand → loop-guard → entry-gate**. O primeiro throw vence
  (upstream: trigger sem try/catch por hook). Consequência: **entry-gate.ts — o plugin que este
  relatório tratava como O portão — roda por ÚLTIMO**; para executor/sniper/test-author/plan-reviewer,
  plan-gate.ts nega 4 posições antes e o operador nunca vê uma razão do entry-gate. Qualquer fix
  aplicado só no entry-gate.ts é invisível no trilho de dispatch. E essa ordem é herdada do readdir
  do filesystem, **não é contrato** — se ela é estrutural (é), precisa ficar explícita, não herdada.
- **Contagem honesta.** 67 sites brutos nos 8 arquivos do trilho (+16 nas duas ferramentas nativas).
  **43 alcançáveis** de um único Task dispatch. **10** podem ser a primeira negação
  (plan-gate.ts:73/:85/:89/:111, dual-enforcement.mjs:236, planner-recovery.ts:131/:137/:141,
  entry-gate.ts:377, loop-guard.ts:259). **Dois** explicam todos os cenários que o operador
  encontra em repo frio ou fix-mode: **plan-gate.ts:111** (mãos de escrita + todo fix-mode da frota)
  e **entry-gate.ts:377** (planner). Não alcançáveis, em três classes distintas: (a) **hook errado**
  — 10 sites contados como deny de dispatch vivem em `tool.execute.after`/event (obs-hand.ts
  :321/:325/:338/:343/:355/:362/:368, planner-recovery.ts:199/:256, loop-guard.ts:168); o blast
  radius real do obs-hand é **3** denies (:234/:237/:247), não 10; (b) **superfície errada** — os 16
  denies das ferramentas nativas ficam atrás de early-returns (marker-authority.ts:222,
  command-resolver.ts:89) e são estruturalmente invisíveis a um Task dispatch; (c) **mortos ou
  subsumidos** — 7 sites (dual-enforcement.mjs:400 inalcançável pelo enum fechado de
  gate-state-shape.mjs:18-24/:42-49; os catch-alls :412 e entry-decide.mjs:146 com corpo de try que
  não lança; entry-decide.mjs:100/:107 sombreados pelo loop de recovery entry-gate.ts:356-380;
  entry-gate.ts:234 sombreado por plan-gate.ts:73 no Task; o dual inteiro de entry-gate.ts:415
  sombreado por plan-gate.ts:152).
- **A mensagem instrutiva é inalcançável para quem mais precisa dela.** entry-decide.mjs:80 ("run
  oc-triaging-requests and classify") é a única mensagem do trilho que diz ao operador o que fazer —
  e é sombreada por plan-gate.ts:111 para as mãos de escrita e por entry-gate.ts:377 para o planner.
- **Cascata de auto-envenenamento no planner.** O 1º dispatch de planner em repo frio escreve
  `planner_active_attempt` (planner-recovery.ts:145) **antes** de entry-gate.ts:377 negar o mesmo
  dispatch (ordem dos plugins); o 2º dispatch morre mais cedo e pior em planner-state.mjs:93
  ("planner attempt already active") — a forma exata do stall #82. Ver T7+T18 na seção 3d.

---

## 3. O que TIRAR

Regras que só existem no OpenCode. Todas morrem. A coluna "o que se perde" tem a resposta
esperada: **nada — o Claude Code também não tem**, e a frota CC roda sem operador com auto-merge
exatamente assim.

### 3a. A muralha anti-forgery inteira (`decideBashForge` + família de detectores)

Deleção agregada: `decideBashForge` (bash-decide.mjs:993-1142), `isStateForgeCommand` (:960-987),
a chamada `throwIfBashDenied(decideBashForge({ command }))` em entry-gate.ts:265 e o import em
:183-188, mais as constantes FORGE_ALLOWLIST (:21), HARNESS_MARKER_RELATIVE (:27-30),
CC_MARKER_PATH_RE (:36-37), NATIVE_MARK_AUTHORITY_RE (:40-41), ORACLE_PATH_RE (:45-46),
TMP_SCRIPT_RE (:49-50), SHELL_BINARIES (:53-63), ALLOWED_TOOLING_SCRIPTS (:69-72),
FROZEN_BASH_PATH_RES (:75-79), TEST_ROOT_RE (:82), NPM_OVERRIDE_FLAGS (:897-908) e os testes
correspondentes em bash-decide.test.mjs. Detector por detector:

| Regra | Onde (arquivo:linha) | O que impede hoje | O que o CC faz no mesmo ponto | O que se perde | Risco |
|---|---|---|---|---|---|
| complex-env | bash-decide.mjs:1017-1024 (detector :180-184) | `env \| sort`, `env -u NODE_OPTIONS npm test` | permite (entry-gate.mjs:564) | nada — CC também não tem | baixo |
| node-preload (`-r`/`--require`/`--import`) | :1026-1033 (detector :522-544; teste operativo :537) | **quebrado**: casa `-r` em qualquer lugar — `grep -r`, `cp -r`, `rm -r` negados como "node preload" | allowlist `grep:*` (settings.json:27), `cp:*` (:42), `node:*` (:60) | nada | baixo |
| eval one-liner (`node -e`, `python -c`) | :1034-1041 (detector :292-308) | o probe diagnóstico mais barato; até `docker run -e NODE_ENV=…` nega | `Bash(node:*)` (settings.json:60) | nada | baixo |
| nested shell `-c` | :1042-1049 (detector :341-370) | `bash -c '<pipeline>'`, `timeout 30 bash -c '…'` | permite | nada | baixo |
| script shell / pipe pra shell | :1050-1057 (detector :565-578) | `bash scripts/setup.sh`, `curl … \| sh` | permite | nada | baixo |
| source / stdin | :1058-1065 (detector :681-695) | `source .venv/bin/activate`; já negou a palavra inglesa "source" em prosa de spec e **bloqueou a criação do PR de entrega** (issue #434) | permite | nada | baixo |
| expanding-redirect (4 sub-regras: heredoc sem quote :593-594, oracle path :602, var opaca :604-613, default-deny :614-624) | :1066-1073 (detector :590-624) | `echo "$V" > VERSION.txt`, `sed -i "s/$OLD/$NEW/"`, escrever spec com `$` no corpo — **matou o run headless #72** (issues #410/#411) | allowlist echo/sed/cp/mv (settings.json:31/34/42/43) | nada | baixo |
| archive-unpack (tar :633-638, git apply :639, zip/gunzip/7z :640-646) | :1074-1081 (detector :630-648) | `tar -xzf`, `git apply --check` (dry-run que não escreve nada), `unzip -l` (só lista) | permite | nada | baixo |
| package-launcher (npm run/npx/make/pnpm/bunx) | :1082-1092 (detectores :833-862, :916-950) | **a regra que sozinha inviabiliza desenvolvimento**: `npm run build`, `npx vitest`, `make`; só 4 strings literais exatas passam (:943-948) — negou o `npx tsc --noEmit` do próprio committing-changes e o instalador do updating-harness (issue #300) | allowlist da classe inteira: `npm test:*`, `npm run:*`, `pnpm run:*`, `bun run:*`, `vitest:*`, `jest:*` (settings.json:44-56) | nada | médio (reescrever testes) |
| frozen-path bash-write | :1093-1100 (detector :656-674, paths :75-79) | substring no TEXTO: `sed -n '1,40p' mark-gate.mjs` (leitura) nega por citar o arquivo | trilho de plano só em Write\|Edit (plan-write-gate.mjs:8-12, settings.json:114-122); bash livre | um write bash em mark-gate.mjs — que o CC também permite hoje em .claude/hooks/ | baixo |
| tmp-script-runner | :1101-1108 (detector :315-328) | `node /tmp/probe.mjs` — o repro descartável padrão de debugging | `Bash(node:*)` | nada | baixo |
| direct-script-exec | :1109-1116 (detector :551-558) | `./bin/cli.mjs --help` no CLI do próprio projeto | permite | nada | baixo |
| unauthorized-interpreter | :1117-1125 (detector :476-515) | qualquer interpretador fora de 2 scripts allowlisted + `*.test.*` sob 3 roots deste repo — num projeto Python/Deno é o toolchain inteiro | `Bash(node:*)` e nenhum detector de interpretador | nada | médio |
| node --test path/reporter | :502-507, :428-467, :435-437, :542 | 100% dos testes de um projeto comum irrodáveis (roots core/\|modules/\|.opencode/ não existem fora deste repo); `--test-reporter` (saída TAP/JSON) banido 2x | `Bash(node:*)` — qualquer forma, qualquer path | nada | baixo |
| CC-marker-CLI path | :1008-1015 (regex :36-37) | num repo dual-vendored, nem `cat core/claude-code/hooks/classify.mjs` roda — exatamente o debugging cross-runtime desta auditoria | permite; wrong-tool no CC é ADVISORY, nunca deny (entry-gate.mjs:555-563) | nada — marker CC sob OC é write no-op, não forja | baixo |
| native-marker-authority path | :1000-1006 (regex :40-41) | `cat core/opencode/plugin/marker-authority.ts` (ler o contrato) nega | permite | nada — a emissão host-side da capability (entry-gate.ts:277-281 → marker-capability.mjs) é a enforcement real e fica | baixo |
| oracle-path catchall (gate-state/triage no texto) | :1126-1134 (isStateForgeCommand :960-987, teste :976-986) | **auto-sabotagem**: a sessão bloqueada pelo portão fail-closed não pode nem `cat .opencode/plans/.state/<sid>/gate-state.json` pra diagnosticar por quê | gate-state é arquivo comum, legível com `cat:*`/`ls:*` (settings.json:21-22); enforcement mora nos trilhos de entrega | bash poder escrever .state — postura idêntica à do CC hoje, com a frota auto-mergeando em cima | médio |
| catch-all fail-closed do forge | :1135-1141 | bug em ~900 linhas de detector = todo bash da sessão negado com "state-forge decision failed" | contrato inverso: "A buggy gate must never brick delivery work" (entry-gate.mjs:4-6) | nada | baixo |

### 3b. Trilhos de entrega e cerimônia OpenCode-only

| Regra | Onde | O que impede hoje | O que o CC faz no mesmo ponto | O que se perde | Risco |
|---|---|---|---|---|---|
| identity-alias-conflict lança em TODO tool | entry-gate.ts:234 (resolver hook-identity.mjs:25-31) | duas grafias do mesmo campo divergirem derruba a chamada | não reconcilia nada — lê `tool_input.subagent_type` cru (entry-gate.mjs:800) | nada; a precedência trusted-sobre-untrusted (:42-50) fica e já é mais forte que o CC | médio |
| marker-seal por instância de processo | entry-gate.ts:277-281 **e** :382-388; plan-gate.ts:105 (import :51); ceremony-transition.mjs:134; ceremony-binding.mjs:38-50; segredo em marker-seal.mjs:6 | secret `randomBytes(32)` no load do módulo → todo marker de processo anterior fica **permanentemente inverificável**: crash/reboot/sessão do dia seguinte = feature inentregável pra sempre (incidente real: issue #423, LIGHT preso re-despachando task-2) | **nenhuma assinatura de marker existe** — gate-state é JSON puro lido em entry-gate.mjs:620 e comparado como booleans/arrays (:628-674) | nada | alto se remover só 1 dos 3 sites de validação — **remover nos 3 + strip dos writers** (marker-authority.ts:169-177, regate-arm.mjs:94-102, ceremony-transition.mjs:152-160, host-hand-capture.mjs:127-176), depois `grep -rn marker_seals core/opencode` só pode retornar teste |
| ceremony session-binding (session_id ≠) | ceremony-binding.mjs:22 (chamado de entry-gate.ts:282-287) | terminal caiu → sessão reconectada não entrega o que acabou de construir | lê gate-state do diretório da própria sessão (stateDirFor) — não existe o que comparar | nada | médio — editar **dentro** do módulo (ver 3c) |
| required-marker binding (sidecar de brainstormed/adversary) | ceremony-binding.mjs:28-53 (argumento `required` em entry-gate.ts:285 e :397, review-restart.mjs:27) | gate-state de versão anterior do harness (boolean sem sidecar) = inentregável | checa os booleans crus `brainstormed === true` / `adversary_fired === true` (entry-gate.mjs:939-940), sem sidecar, sem seal | nada | médio |
| NO-CEREMONY nega entrega | bash-decide.mjs:1321-1328 | sessão triada corretamente como no-ceremony (typo de README) nunca pusha nada | gate bash do CC nunca inspeciona `mode` | nada | médio |
| exigência de carimbo de cerimônia (`!classified && !mode`) | bash-decide.mjs:1330-1337 | **o repro vivo**: /root/dev/gestao, commit em feature branch, `.state/` vazio → push negado | triage.json só é exigido em dispatch de Agent com papel de entrega; o caminho bash vai direto dos trilhos git pros trilhos regate/captura (entry-gate.mjs:612-696) | nada — num run real de pipeline o gate-state existe e os trilhos regate/captura/real-file continuam disparando | alto (é o coração do fix) |
| review-cap trava o ship | bash-decide.mjs:1340-1352 | cap atingido = sessão inteira inentregável; recovery documentado = re-cerimônia completa | o CC **não tem cap de ship nenhum**. No dispatch do agente plan-reviewer: **deny só acima de 10 rounds E só interativo** (entry-gate.mjs:893-907 — `count > PLAN_REVIEW_CEILING && !headless`, definidos em :884-885), e acima de 3 é **allow + additionalContext de aviso** (:908-922). Headless nunca é negado. Trabalho já commitado sempre embarca | nada **no bash** — mas o cap que fica na superfície de dispatch do OC é MAIS estrito que o do CC e precisa de alinhamento próprio (seção 3d) | médio |
| QUICK-launder residue | bash-decide.mjs:1354-1366 (detector :94-115) | LIGHT abandonado encalha a sessão | não existe detecção de downgrade em lugar nenhum do CC | o guard monotônico classify-side (classify-authority.mjs, chamado em entry-gate.ts:252 e classify.ts:101-115) **fica** — é ele a correção real do incidente #403, e é mais forte que qualquer coisa que o CC tem | médio |
| FULL exige dual gravado | bash-decide.mjs:1385-1393 (isRecordedDual :133) | plan-review com só `plan_verdict: APPROVE` = FULL inentregável | conceito de dual-enforcement não existe no entry-gate CC; cross-family é fail-open por política (core/CLAUDE.md) | nada | médio |
| delivery_status = "delivery-blocked" | bash-decide.mjs:1396-1407 | uma string carimbada = sessão permanentemente inentregável, deny sem caminho de limpeza | conceito não existe | nada — parar de escrever o campo se ficar sem leitor | médio |
| planner_status ≠ "usable" nega ship | bash-decide.mjs:1408-1421 | plano que existe e foi executado inentregável se o write do status raceou o lock | CC nunca lê planner_status; trilhos de ship são regate/captura/real-file/git apenas | **atenção — a promessa não é o que parece**: a MESMA precondição sobrevive intacta em plan-gate.ts:110-112 (`planner usable bound artifact required`), aplicada a TODO dispatch de plan-reviewer/test-author/executor/sniper. O modo de falha do victor-bot #82 (sessão morta em `plan_pending_write`) mora **nessa** superfície, não no bash — remover só a linha do bash **não destrava o #82**. O veredito de plan-gate.ts:110-112 é dado na seção 3d | médio |
| mode inválido (else terminal da escada) | bash-decide.mjs:1423-1430 | typo ou modo novo (variante craft) bloqueia sem instrução de reparo | sem validação de modo na superfície bash | nada | baixo |
| A5 cobertura multitask do plano | bash-decide.mjs:1514-1559 (writingTaskIdsFromPlan :1221-1236; boundPlan :1248; wiring entry-gate.ts:196-199, :312) | entrega parcial deliberada (shipar tasks 1-3, dropar a 4 pós-review) impossível | nenhum trilho de cobertura de plano em nenhuma superfície; evidência de ship é por-registro | só "task planejada que nunca foi despachada" — que o CC nunca detectou, em nenhum modo; real-file e captura continuam pegando todo o resto | médio |
| FULL exige final_review_done | bash-decide.mjs:1597-1607 | review final gravado com nome de operação levemente diferente (ou em processo anterior, via seal) = FULL inentregável pra sempre | sem precondição de final-review no bash; gate do shipper checa só o re-gate (entry-gate.mjs:997+) | nada — o dual review final segue como passo de orquestração nos dois runtimes | médio |
| FULL exige demo (interativo) | bash-decide.mjs:1608-1618 (detector headless :1197-1211) | pior: a detecção de headless usa CLAUDE_CODE_REMOTE/OPENCODE_HEADLESS, e a frota headless-local **deliberadamente não seta** CLAUDE_CODE_REMOTE (entry-gate.mjs:120-136) — run não-assistido espera pra sempre uma demo que nenhum humano vai dar | sem trilho de demo em caminho bash algum | nada — demo segue checkpoint de operador na skill, como no CC | médio |
| muralha bash do plan-write-gate durante active_dispatch | plan-write-gate.ts:230-256 (guard de metacaractere :235 — `const simple = … !/[\|;&><\`$]/`; padrões ancorados :238-242; deny :255); throws de identidade :164-166, :187-194 | durante QUALQUER hand de escrita ativa, todo bash nega salvo 5 padrões ancorados sem metacaractere — nem `grep`, nem `npm test`, nem os gates que o build.md:72 manda o orquestrador rodar; o `npx vitest run` allowlisted aqui (:240) era negado pela muralha forge — as duas paredes nunca foram reconciliadas | plan-write-gate do CC é Write\|Edit apenas (settings.json:114-122); bash fica 100% usável durante spawn-hand | nada — o enforcement de escopo em write/patch (:258+) fica, que é a superfície do CC; identidade falha → shadow-record, não throw | médio |

### 3c. Nota de mecânica (dos ataques adversariais — muda o COMO, não o veredito)

- **marker-seal:** remover a validação nos **três** sites de leitura (entry-gate.ts:277-281 e
  :382-388, plan-gate.ts:105) mais ceremony-transition.mjs:134 e ceremony-binding.mjs:38-50, e
  só então remover os writers e o módulo. Remover só o site bash deixa vivo o bricking do #423 no
  dispatch de Task — uma porta antes do ship.
- **ceremony-binding.mjs tem CINCO consumidores** (entry-gate.ts:178 chamado em :282 e :394-399;
  plan-gate.ts:50/:97; review-restart.mjs:5/:27; ceremony-coordinator.ts:6/:43). As deleções são
  **dentro do módulo** (loop :28-54 e comparação de session :22-24), mantendo o export com a
  comparação residual de feature pras superfícies Task/plan. Deletar o módulo com um só call-site
  atualizado quebra o load do plugin inteiro — inclusive os 4 trilhos que ficam.

### 3d. A superfície Task/dispatch — o trilho por onde a pipeline realmente anda

**Esta seção passou pelo ciclo adversarial completo nesta revisão final** — três lentes (mecânica,
fidelidade de paridade nas duas direções, capacidade da frota) mais o mapa de alcançabilidade da
seção 2. Os vereditos abaixo **não são mais propostas de primeira rodada**: cada um foi atacado e
o resultado do ataque está incorporado (veredito corrigido, mecanismo corrigido, ou site dropado
como código morto).

Consertar só o bash entrega paridade de **commit e push**, não de **pipeline**. A pipeline do
harness não anda por bash: ela anda por dispatch de agente. Nessa superfície o Claude Code tem
**um** hook e **8** denies (settings.json:88-95 → entry-gate.mjs), e o OpenCode tem **cinco**
plugins encadeados (na ordem real de execução: planner-recovery → plan-gate → obs-hand →
loop-guard → **entry-gate por último**) com 43 denies alcançáveis, mais 16 nas duas ferramentas
nativas (fora do trilho de Task — early-return).

**Prioridade corrigida pela alcançabilidade:** T10 (plan-gate.ts:111) não é um item entre vinte —
é a **raiz**: primeira negação em dois dos três cenários reais (repo frio, fix-mode da frota) e o
site que torna o fix-mode logicamente insatisfazível (cron-a-dispatch.mjs:245-247 proíbe rodar o
planner que :111 exige). Um roadmap que sequencia os catch-alls antes de T10/T7 entrega seis lotes
e deixa o repro do gestao vivo.

Regra de leitura: o CC nega no dispatch **exatamente quatro coisas** — triagem ausente, cerimônia
do planner (brainstormed/adversary/feature), regate pendente no shipper, e fidelity/hand-routing —
e **falha aberto em tudo que é infra** (session_id ausente :810-813, inseguro :814-817, leitura de
triagem que lança :821-826, leitura de gate-state que lança :872-876/:1001-1003).

| # | Deny OC | Onde | Comportamento CC equivalente | Veredito |
|---|---|---|---|---|
| T1 | gate-state ilegível nega o dispatch (fail-closed) | entry-gate.ts:334-336 | fail-open: gate-state ilegível vira `{}` e o dispatch segue (entry-gate.mjs:1001-1003, :872-876) | **A** (sobreviveu ao ataque) — `loaded.ok ? loaded.state : {}` sem throw. Nota de sequência: para executor/sniper/test-author/plan-reviewer este site é sombreado por plan-gate.ts:85/:89 quatro plugins antes — observável só para compliance/security/harvester/shipper/adversary/planner até o lado plan-gate (T11/T12) sair |
| T2 | gate-state ilegível nega o dual — **e os denies SUBSTANTIVOS do dual, que a primeira rodada não adjudicou** | dual-enforcement.mjs:705-711 (infra) **+ :236/:280/:299/:317/:332/:346/:365** (substantivos, todos via plan-gate.ts:152 — o call do entry-gate.ts:415 é sombreado) | não existe conceito de dual/plan_verdict em NENHUMA superfície de dispatch do CC; cross-family é fail-open por política (core/CLAUDE.md) | **A, ampliado pelo ataque** — alinhar só o throw de infra deixava ~7 denies vivos por default (DEFAULT_REQUIRE_DUAL_ON = plan-reviewer/adversary, dual-enforcement.mjs:38-41): um executor OC ainda exigiria dual gravado + plan_verdict APPROVE onde o CC permite, e :365 é o que congela mãos de escrita numa rodada REVISE. Veredito: **o gate de dual sai da superfície de dispatch de hand inteiro** — dual-enforcement sobrevive como GRAVAÇÃO (recording), a disciplina dual/verdict volta a ser prosa+orquestração como no CC. Consistência: arquivo AUSENTE já resolve `{}` (:628-631) — corrupção não pode ficar mais permissiva que ausência |
| T3 | catch-all de deny na decisão de Task | entry-decide.mjs:142-148 | contrato inverso: "A buggy gate must never brick delivery work" (entry-gate.mjs:4-6); o wrapper de produção engole exceção e permite (:1211-1214) | **A, rebaixado a drive-by (churn)** — o corpo do try é leitura pura de propriedades sobre JSON já parseado: **não lança nada hoje**. Alinhar a allow+log é paridade de contrato correta, mas não compra de volta nenhum dispatch — entra como edição de carona dentro do Lote 4, não como entregável nomeado |
| T4 | catch-all de deny na decisão de dual | dual-enforcement.mjs:408-418 | idem | **A, rebaixado a drive-by (churn)** — duplamente morto: o catch guarda um try de leituras puras, e o fallthrough :398-407 é inalcançável (enum fechado de gate-state-shape.mjs:18-24/:42-49 torna isRecordedDualAttempt sempre true após :329+:343). Carona no Lote 4 |
| T5 | retry K=3 do mesmo agente nega o 4º dispatch | entry-gate.ts:339-348 → agent-retry.mjs:51-64 | **não existe no CC** — `agent-retry.mjs` mora em core/shared/lib mas é importado só pelo OpenCode (entry-gate.ts:342, loop-guard.ts:35, loop-decide.mjs:16, planner-state.mjs:7 — zero importadores em core/claude-code) | **K** — manter, mas **só** este: é o anti-runaway de custo da frota OC e não bloqueia trabalho legítimo (reseta no sucesso, agent-retry.mjs:88-116). Documentar como divergência consciente |
| T6 | teto separado de dispatch negado por gate (K=3) | entry-gate.ts:349-355 → agent-retry.mjs:155-168 | não existe | **R** — é teto de teto: com T1/T3/T4 alinhados a fail-open, o contador que ele protege quase não incrementa mais; manter os dois é o que produz o deadlock "precondição nunca satisfeita" |
| T7 | loop de ceremony-recovery com 2 throws no dispatch do planner | entry-gate.ts:356-381 (`CEREMONY_PERSIST_FAILED` :375; erro de recovery :377) | o CC lê os booleans crus e nega **com instrução de reparo**, sem tentar mutar o estado (entry-gate.mjs:947-988) | **A, mecanismo corrigido pelo ataque** — amaciar os throws mantém o loop, e **o loop é a própria não-paridade**: ele muta estado no dispatch do planner e é o que torna entry-decide.mjs:100/:107 (os denies instrutivos CC-shaped que o OC JÁ TEM) código morto. Veredito: **deletar o loop** (entry-gate.ts:356-381); entry-decide.mjs:95-110 vira o portão do planner, exatamente onde o CC o mantém; :375 (persistência) deixa de existir com o loop. **Adicionar no mesmo lote o featureMismatch do CC** (entry-gate.mjs:944-947 — cerimônia velha de outra feature → re-instruir), ausente de entry-decide.mjs:95-110 e devido pela seção 4 sem site de pouso. E o repro esperado é **deny instrutivo, não allow** — o CC também nega planner com estado vazio (Gate 1, entry-gate.mjs:829-842); a linha de verificação do Lote 4 estava errada e foi corrigida. **Atômico com T18** — sem o reparo do claim, o 2º dispatch morre antes na cascata S1b |
| T8 | review-cap CONGELA toda mão de escrita | entry-gate.ts:401-404 → loop-decide.mjs:660-676 (deny quando `review_status` é `review_cap_reached` ou `primary_failure_cap_reached`) | **o CC não congela mão nenhuma** — não existe `review_status` no gate CC; acima do cap ele só avisa (entry-gate.mjs:908-922) | **A** — remover o congelamento. O cap continua onde o CC o põe: no dispatch do próprio plan-reviewer |
| T9 | thresholds do loop-guard mais estritos que o CC | loop-decide.mjs:18-23 (`plan_review` deny=5, `adversary` deny=4, `primary_failure_streak` deny=K) + deny incondicional em :646-648 (sem isenção headless), fiado em loop-guard.ts:268; **mais a família reserveReviewAttempt sem veredito** (loop-guard.ts:259 → loop-decide.mjs:290-296/:303-312/:337-349) | CC: warn acima de **3**, deny acima de **10**, e **só interativo** (entry-gate.mjs:884-885, :893-907); warn entregue por additionalContext em ALLOW (:908-922) | **A, mecanismo especificado pelo ataque (3 defeitos):** (1) **o sinal de headless é exatamente `Boolean(env.CLAUDE_CODE_REMOTE)`** (espelho de entry-gate.mjs:116-118) — nunca os marcadores de rotina da frota (HARNESS_NOTIFY_PROJECT etc.): a frota DELETA CLAUDE_CODE_REMOTE (cron-a-dispatch.mjs:1372), então a frota CC MANTÉM o hard-stop >10; keying nos marcadores tiraria da frota OC um teto que a frota CC tem. Teste: env com cara de frota → deny>10; env cloud (CLAUDE_CODE_REMOTE set) → warn-only. (2) **o warn>3 precisa de canal**: before-hook OC não tem additionalContext e o warn atual do decideLoopGuard é string morta (loop-guard.ts:261-269 só consome deny) — entregar por **prompt-append** (padrão já provado de plan-gate.ts:144-149). (3) **reserveReviewAttempt em repo frio cai pra allow**: o identity-mismatch (:303-312) dispara em qualquer repo frio pro adversary (que o plan-gate não gateia) com deny não-instrutivo; contabilidade de reserva só se aplica quando cerimônia existe. Nota: o deny=4 do adversary é código morto (:646 só nega `plan_review_count`) — metade da premissa original de T9 já era inerte |
| T10 | plan-gate exige `planner_status === "usable"` + binding em TODO downstream | plan-gate.ts:110-122 (bloco requiresFullPlan :82-150) | o CC não tem plan-gate de dispatch NENHUM: a única precondição de plano é o trilho Write\|Edit (plan-write-gate.mjs:8-12), que o OC já espelha em plan-write-gate.ts | **A, veredito corrigido pelo ataque (a proposta original estava errada duas vezes).** (1) A premissa "o status é o campo que raceia" é falsa em código: `planner_status='usable'` e `planner_plan_binding` são escritos **atomicamente** na mesma mutação lockada (planner-state.mjs:235/:242 dentro de bindPlannerArtifact, sob withGateStateLock em planner-artifact.mjs:140-155) — não há janela de race entre os dois. (2) Derrubar só o status deixava `!state.planner_plan_binding` (:110) e o `!artifact` (:115-121) negando idênticos em estado vazio — a parede só descia 10 linhas, e S1a (gestao) e S3 (fix-mode) sobreviviam aos seis lotes. **Veredito corrigido: o bloco inteiro fica condicional à EXISTÊNCIA do binding** — sem `planner_plan_binding`/artefato → skip total (fail-open, igual ao CC que não tem gate de plano no dispatch); com binding presente → verificar o snapshot (:115-122), rodar os checks de mismatch positivo (T13) e injetar HARNESS_BOUND_PLAN no prompt (:144-149) como hoje. Efeito colateral que restaura a paridade do deny #1 do CC: com :111 fora do caminho frio, a primeira negação de repo frio vira o deny instrutivo de entry-decide.mjs:75-82 — o mesmo primeiro deny do CC (entry-gate.mjs:829-842). **É a raiz do fix-mode:** cron-a-dispatch.mjs:245-247 proíbe o planner que :111 exige; sem esta correção o fix-mode OC nunca converge e cada BLOCK queima uma sessão inteira na mesma linha |
| T11 | plan-gate exige session-binding do planner | plan-gate.ts:85 | CC lê o gate-state do diretório da própria sessão — não há o que comparar | **R** — mesma família do ceremony-binding da seção 3b |
| T12 | plan-gate: reconciliação de artefato ilegível nega | plan-gate.ts:89 (e o sid ausente de :85, com T11) | fail-open é **short-circuit return** no CC (entry-gate.mjs:810-813) | **A, controle de fluxo especificado pelo ataque** — "allow + log" ambíguo era a armadilha: continuar no bloco com estado `{}` morre uma linha depois nos checks retidos, e o deny só migra de site. Especificação: `if (!sid) return` e `if (!reconciled.ok) { log; return }` — **pular o bloco inteiro**, nunca continuar com estado vazio. Sob o T10 corrigido (bloco condicional ao binding) isto vira o comportamento natural do branch ausente |
| T13 | plan-gate: cerimônia + seal + conflitos de feature/task (5 denies) | plan-gate.ts:103, :109, :127, :130, :141 | cerimônia é precondição do **planner** apenas (entry-gate.mjs:947-988); seal não existe; **o CC não tem NENHUM check de feature/task-membership no dispatch de executor/sniper/test-author** — featureMismatch vive só no planner (:944-947), e o próprio CC declara binding por prompt inviável (:1032-1034) | **R** para o seal (:109, seção 3c) e :103 (duplica entry-gate.ts:394-399; e é vácuo em estado vazio — só dispara mid-pipeline como brick de restart). Para :127/:130/:141, **veredito reconciliado pelo ataque**: eles **não têm contraparte CC nesta superfície** e não compilam contra o T10 corrigido fora do branch com artefato — sobrevivem **apenas dentro do branch artefato-presente**, como deny de **mismatch POSITIVO** de identidade vinda do runtime-envelope (dado host-trusted que o CC não tem) contra um artefato presente; **ausência de envelope ou de artefato → skip, nunca exigência**. Espelha o padrão positive-mismatch-only do próprio CC (freshness, entry-gate.mjs:1133-1137) |
| T14 | plan-gate: marcador de task obrigatório no prompt | plan-gate.ts:137 | o CC reconhece que binding por prosa de prompt é inviável e **não tenta** (entry-gate.mjs:1032-1034) | **R** (sobreviveu) — com uma restrição de shipping verificada: obs-hand.ts:233 exige o MESMO marcador um plugin depois; remover só :137 move o deny para obs-hand.ts:234. **T14 e T17 são uma mudança atômica**, não itens independentes. Verificado que a cadeia de evidência sobrevive: maybeWriteTaskHandRecord (obs-hand.ts:82-111) lê do envelope, não do claims map |
| T15 | identity-alias lança em TODO tool (inclui Task) | entry-gate.ts:234; plan-gate.ts:73 | CC lê `tool_input.subagent_type` cru (entry-gate.mjs:800) | **R** (sobreviveu) — o fix é no resolver (hook-identity.mjs:25-31, únicos consumidores são os dois call-sites), não deleção de site: no Task só plan-gate.ts:73 é observável (entry-gate.ts:234 sombreado), mas :234 segue vivo na superfície bash. Precisão: "retorna o primeiro valor" tem que ser determinístico por ordem de alias com `subagent_type` (o campo canônico que o CC lê) primeiro; a precedência trusted-sobre-untrusted (:42-50) fica |
| T16 | seal de marker no dispatch | entry-gate.ts:382-388; plan-gate.ts:105-109 | não existe assinatura de marker no CC | **R** — os dois sites entram no Lote 5 junto com o site bash (seção 3c) |
| T17 | obs-hand nega o dispatch da mão de escrita | obs-hand.ts:234, :237, :247 (**os únicos 3 no trilho de dispatch** — :321/:325/:338/:343/:355/:362/:368 são after/event hooks, fora do trilho; converter também é certo, mas por outro motivo: um throw no after envenena o resultado da tool) | o observador equivalente do CC é `stamp-triage.mjs`, um **PostToolUse** — `grep -c permissionDecision` retorna **0**: ele não tem como negar nada, por construção | **A** (sobreviveu, blast radius corrigido de 10 → 3) — converter em shadow-record + log **preservando TODOS os writes** (claim/token :238-254, hand-record :276-278, cleanup no finally :341-343): eles produzem o hand_finished/capture_verified que o trilho de captura MANTIDO 1:1 consome — se os writes forem junto com os throws, todo push da frota OC vira deny de captura. Teste exigido: claim rejeitado ainda gera hand-record + capture_verified no after-hook. **Consequência consciente**: :247 era o único serializador de mão de escrita (dispatch-scope.mjs single-slot :214-226); removê-lo abre mão da single-flight por construção — **é paridade** (o CC também não tem serializador de dispatch; sequência é comportamento do orquestrador nos dois) e mata o break S2 #1 (cleanup perdido → deny na task seguinte). Registrado na seção 8 como troca deliberada |
| T18 | planner-recovery nega o dispatch do planner | planner-recovery.ts:131, :137, :141, :167 (**:199/:256 são after-hooks, fora do trilho**) | nenhum equivalente CC (o planner do CC passa pelo Gate 2 e mais nada); :131 ≡ fail-open CC em ids ausentes (entry-gate.mjs:810-813); :141 é diferença mecânica real (OC resolve provider/model do papel em harness.routing.json no dispatch — o CC não tem resolução que possa falhar) | **A, mecanismo corrigido pelo ataque** — manter só :141 continua certo, mas **allow+log em :167 sozinho quebra a cadeia de autoria do plano**: o claim nunca expira (expires_at:null, planner-state.mjs:147-148) e sob claim envenenado o planner rodaria a sessão Opus inteira e o after-hook descartaria o plano como STALE (call_id ≠, planner-state.mjs:158-159 → accepted:false → planner-recovery.ts:257 return silencioso) — deadlock persiste a custo cheio. **O fix mora na semântica do claim (planner-state.mjs), não no throw:** num claim rejection cujo attempt ativo pertence a um call morto, reconciliar/adotar (limpar ou re-keyar planner_active_attempt para o novo callId dentro do mesmo withGateStateLock) antes de permitir, para o completePlannerAttempt casar e o plano retornado bindar. É isto que desfaz a cascata de auto-envenenamento S1b (a forma do stall #82). **Atômico com T7** |
| T19 | ferramentas nativas privilegiadas negam por identidade exata | marker-authority.ts:225, :227, :229, :232, :234, :237, :241; command-resolver.ts:91, :92, :95, :99, :101, :103, :105, :107, :113 | o CC carimba marker por **CLI comum** (`mark.mjs`, zero `permissionDecision`) e não tem resolver nenhum | **marker-authority: K** (é a emissão host-side da capability, a única integridade real de marker que o OC tem — ver seção 3a, linha native-marker-authority). **command-resolver: R** — ver abaixo |

**`command-resolver.ts` + a ferramenta nativa `verify` ficam órfãos.** Elas existem **só** como
recuperação sancionada dos denies da muralha: bash-decide.mjs:1087 (`denied_class: package_launcher,
resolver: verify`) e :1121 (`denied_class: interpreter`) são os dois únicos produtores do
`denied_class` que o resolver consome. Morta a muralha (seção 3a), `npx vitest run <path>` volta a
ser um comando bash comum e não há mais o que resolver. Veredito: **R** — remover
command-resolver.ts, desregistrar a ferramenta `verify`, e aposentar a prosa que manda chamá-la
(build.md:71, planner.md:68, creating-plans SKILL.md:102, orchestrating-delivery SKILL.md:101 e
:225, e os 6 executores — lista completa na seção 4).

**Correção da lente de frota (obrigatória no mesmo PR):** a remoção como especificada **brickava a
frota OC inteira na semeadura** — CANONICAL_OC_PLUGINS (cron-a-dispatch.mjs:490-506) ainda lista
`./.opencode/plugin/command-resolver.ts` em :494, e `ensureOcPluginPathsExist` (:877-896) verifica
cada arquivo listado e **lança fail-closed** (:890-894) quando um falta — todo dispatch da frota
morreria antes de qualquer sessão nascer, com a verificação do Lote 2 verde (o throw vive no seed
path, exercitado só por cron-a-dispatch-seed.test.mjs, que o Lote 2 não rodava). O mesmo PR que
deleta command-resolver.ts **tem que** remover a entrada de CANONICAL_OC_PLUGINS e atualizar
cron-a-dispatch-seed.test.mjs + plugin-default-export.test.mjs; cron-a-dispatch-seed.test.mjs entra
na lista de verificação do Lote 2.

#### Denies do CC sem contraparte OC pós-fix (paridade na direção contrária — achados da revisão adversarial)

A lente 2 varreu os 8 denies do matcher Agent do CC contra o OC pós-correção. Três não têm site de
pouso vivo e um está presente mas MAIS ESTRITO que a spec — deixar o OC mais frouxo (ou mais
estrito) que o CC também é defeito, pela decisão do operador:

| # | Deny do CC | Onde no CC | Situação no OC pós-fix | Veredito |
|---|---|---|---|---|
| T20 | Gate 1 estrito: TODO papel de entrega/hand negado salvo modo ∈ {LIGHT, FULL} | entry-gate.mjs:828-842 (hands deliberadamente não early-allowed :797-801, :1041-1042) | entry-decide.mjs:69-92 aceita `classified/triaged` SEM checar modo e trata QUICK/no-ceremony como carimbo válido; o backstop QUICK (:86-91) só bloqueia compliance/security/harvester/shipper — executor, sniper, test-author, planner, plan-reviewer e adversary ficam despacháveis sob QUICK onde o CC nega todos | **A** — alinhar o predicado: dispatch de papel de entrega/hand exige modo ∈ {LIGHT, FULL} (case-normalizado); carimbo QUICK/no-ceremony → o mesmo deny instrutivo de :75-82. Se a isenção do executor sob QUICK for design deliberado, tem que ir pra seção 6 com razão — hoje é frouxidão herdada, a mesma categoria do precedente secret-read |
| T21 | Gate 3 do shipper: regate_pending corrompido (o ÚNICO fail-closed deliberado do contrato, :7-15) e regate_pending sem absolvição | entry-gate.mjs:1006-1008 e :1015-1027 (matchesAbsolution :1014) | **NADA na superfície Task** (grep em entry-gate.ts/plan-gate.ts/entry-decide.mjs: zero lógica de regate) — só o trilho bash de entrega carrega (bash-decide.mjs:1437-1445/:1459-1476, mantido 1:1). O OC permitiria um dispatch de shipper que o CC nega; a proteção sobra só na hora do push, sem a mensagem instrutiva do ponto de dispatch ("Dispatch the fresh-virgin adversary and stamp regate-passed") | **P** — portar o Gate 3 verbatim no branch shipper de decideEntryTask: classifyRegatePending + deny fail-closed de corrupção + matchesAbsolution sobre regate_passed, com a mensagem do CC. Barato: os helpers já vivem em core/shared/lib (regate-classify.mjs, já importado pelo trilho bash) |
| T22 | featureMismatch do planner: cerimônia velha carimbada pra outra feature → re-instruir | entry-gate.mjs:944-947 | ausente de entry-decide.mjs:95-110 (verificado); devido pela seção 4 mas implementado por nenhum veredito | **P** — entra no lote de T7 (é o mesmo branch do planner) |
| T23 | Fidelity headless: executor sem fidelity_pass DE FEATURE; **sniper e test-author isentos por design** | entry-gate.mjs:1083-1098; match por feature `startsWith` (:1080-1082); isenções :1051-1064 ("Only the executor consumer is gated") | presente mas MAIS ESTRITO em dois eixos: entry-decide.mjs:122 gateia também o **sniper**, e :33-35 exige entrada EXATA `feature/task` quando há taskId no envelope (CC destrava por feature). **É a segunda parede do fix-mode**: caída plan-gate.ts:111, o sniper do fix-mode (sessão nova, fidelity_pass vazio) morre em entry-decide.mjs:130-138 pra sempre | **A** — remover isSniperRole de :122 (sniper nunca fidelity-gateado, como test-author em :118-120) e tornar hasFidelityPass feature-level (`startsWith`), com o match exato no máximo como accept adicional, nunca como exigência mais estreita. A alegação "mesma regra" da seção 6 estava errada — a diferença sancionada é só de SUPERFÍCIE; a regra tem que ser idêntica |

Nota de contrato (uma linha, sem veredito): o CC permite incondicionalmente dispatch com `agent_id`
presente (subagentes aninhados nunca gateados, entry-gate.mjs:792-794); no OC um Task aninhado
re-entra a cadeia de 5 plugins com o próprio sessionID — pós-fix (fail-open, sem paredes de estado
frio) converge para allow, mas é diferença de contrato digna de registro.

---

## 4. O que ALINHAR (o coração do relatório)

Regras que os dois runtimes têm, onde o OpenCode é mais estrito ou está na superfície errada.
O comportamento do Claude Code é a especificação.

| Regra | Onde no OC | Comportamento CC que vira spec | Mudança exata |
|---|---|---|---|
| Estrutura do caminho bash | entry-gate.ts:263-325 | decideBash só olha dispatch de hand e comando de entrega; resto = `{allow:true}` (entry-gate.mjs:398-565, allow em :564) | deletar a chamada ao forge (:263-265) e o import (:183-188); branch bash vai direto ao load de gate-state (:271) e ao decideBashDelivery (:315) |
| gate-state ilegível em entrega | entry-gate.ts:272-274; bash-decide.mjs:1292-1299 | fail-open: "Cannot load state without a safe session_id → fail-open (never brick)" (entry-gate.mjs:614-617); throw de leitura vira `{}` (:619-623) | deletar o throw :272-274, manter `loaded.ok ? loaded.state : {}` (:275); deletar o deny gateStateLoadOk (:1292-1299) e o campo do contrato (:1243) |
| session_id ausente/inseguro | bash-decide.mjs:1301-1308 (validador dual-enforcement.mjs:89) | fail-open (entry-gate.mjs:614-617) | trocar o deny por `return { ok:true, decision:"allow" }` **depois** dos trilhos git (:1289), mesma ordem do CC (:578-617) |
| catch-all da decisão de entrega | bash-decide.mjs:1623-1629 | fail-open em erro de infra (entry-gate.mjs:4-6, :619-623); só o regate_pending corrompido é fail-closed deliberado (:7-15) | catch retorna allow + log stderr; o deny de regate corrompido (:1438-1445) fica — é levantado antes do catch, não por ele |
| catch-all da decisão de **Task** (o terceiro, que a triagem anterior não viu) | entry-decide.mjs:142-148 | não existe catch-all de deny em superfície nenhuma do CC; o contrato é o inverso (entry-gate.mjs:4-6) e o wrapper de produção engole exceção e permite (:1211-1214) | `catch` retorna `{ ok:true, decision:"allow" }` + log stderr — mesmo padrão dos outros dois |
| catch-all da decisão de **dual** | dual-enforcement.mjs:408-418 | idem | idem — allow + log |
| catch-all do forge | bash-decide.mjs:1135-1141 | mesmo contrato | morre com decideBashForge; o branch bash de entry-gate.ts (263-325) ganha wrap que engole exceção inesperada (allow), reservando throw pros denies deliberados — espelho do processInput do CC (entry-gate.mjs:1211-1214, :1252-1260) |
| feature-binding no ship | ceremony-binding.mjs:25 (via entry-gate.ts:282-287) | CC aplica featureMismatch no dispatch do **planner** (entry-gate.mjs:944-947), nunca no bash de entrega | tirar do branch bash; manter/garantir o equivalente no dispatch do planner em entry-decide.mjs |
| brainstormed obrigatório no ship | bash-decide.mjs:1369-1376 | precondição do dispatch do planner apenas (entry-gate.mjs:939, deny :962-974) | deletar do ship; confirmar/adicionar no dispatch do planner (entry-decide.mjs) |
| adversary_fired obrigatório no ship | bash-decide.mjs:1377-1384 | idem (entry-gate.mjs:940, :976-988) | idem |
| imutabilidade do plano via bash | entry-gate.ts:289-297 (helper :72-80) | trilho de plano é Write\|Edit apenas (plan-write-gate.mjs:8-12, settings.json:114-122) | deletar o branch bash e `mutatesExecutionPlan`; plan-write-gate.ts segue como superfície única |
| arrays corrompidos (hand_finished/capture_verified/regate_passed) | bash-decide.mjs:1447-1457 (classifyArrayMarker :1159-1164) | coerção silenciosa a `[]` (entry-gate.mjs:633, :655-656); só regate_pending fica fail-closed | deletar o loop; `coerceArray` (:1148) cuida dos três; deletar classifyArrayMarker e corruptArrayMarkerReason (:1171-1188) quando sem referência |
| feature_id ausente em LIGHT/FULL | bash-decide.mjs:1502-1512 | ausente = pula o trilho, não nega: `if (featureId !== null) { … }` (entry-gate.mjs:681-682) | deletar o deny; guard em :1566 vira `featureId !== null` |
| real-file com flags extras | bash-decide.mjs:1584-1588 | adapter CC passa só listHandRecordsForFeatureFn + isAncestorFn (entry-gate.mjs:183-187, chamado em :683) — sem requireCaptureEvidence, sem requiredSessionId | dropar as duas flags da chamada; LIGHT inline sem hand (zero registros) e run retomado com session id anterior voltam a embarcar; todo deny por-registro do trilho compartilhado continua idêntico |
| listFn indisponível | bash-decide.mjs:1567-1575 | mesmo trilho compartilhado emite a mesma razão (real-file-capture-rail.mjs:70) | deletar o pré-check local redundante |
| escopo do detector de comando de entrega | is-delivery-command.mjs:11-29 | casa as 3 regex na string inteira (entry-gate.mjs:254-272) — CC é marginalmente mais amplo em compostos | dropar o split por `&&`/`\|\|`/`;`; byte-a-byte com o CC |
| permission map (config) | opencode.json.example:52-102 **+ 3 alvos que a triagem não viu** | ~55 allows + 6 denies git (settings.json:3-61, :71-76) — o `rm -rf /*` do OC é glob que casa QUALQUER delete absoluto recursivo (10 negações de limpeza de worktree no log) | reescrever o map espelhando o CC 1-pra-1 em **(a)** opencode.json.example:52-102, **(b)** o opencode.json rastreado na raiz deste repo (:52-102 — é ele o config operativo aqui), **(c)** vendor-core.mjs:479-518 (`writeOpencodeConfig`): o branch de update (:501-514) passa a fazer merge das chaves harness-owned `permission.bash`, **`permission.read`** e `question` em todo re-vendor (hoje só reescreve `plugin[]` — o map velho sobrevive pra sempre em projeto já vendorizado, ex.: gestao), **(d)** cortar DANGEROUS_BASH_DENYLIST (cron-a-dispatch.mjs:436-458) pros 6 do CC — senão a frota re-impõe os denies deletados em todo worktree semeado (enforceOpencodePermissions :569-600, deny-always-wins). Manter o `"*":"allow"` forçado por último (:581-591) que faz o headless --auto funcionar. **(e) A união é deny-first e a base vence (:582-590): ela NUNCA remove um deny já presente no `opencode.json` do projeto.** Num projeto já vendorizado (gestao), cortar a denylist do código **não limpa nada** — o re-vendor do Lote 6 também não, porque `writeOpencodeConfig` só reescreve `plugin[]` no branch de update (vendor-core.mjs:501-514) e nunca toca `permission`. Sem um passo de migração explícito (reescrever `permission` no update, ou um one-shot que apague os denies aposentados do config do projeto), **o repro do gestao continua vivo depois dos seis lotes** |
| **permission map de LEITURA (o OC é mais FROUXO — paridade na direção contrária)** | opencode.json.example:40; opencode.json:40; cron-a-dispatch.mjs:470 (`read: "allow"` em HEADLESS_SAFE_PERMISSION_DEFAULTS) | **8 denies de leitura de segredo** (settings.json:63-70): `.env`, `.env.*`, `//**/.env`, `//**/.env.*`, `.dev.vars`, `//**/.dev.vars`, `~/.ssh/**`, `~/.aws/**` | portar o mapa de READ do CC pros **três** alvos, na forma de mapa por-padrão que o OC já suporta e que 3 agentes já usam (plan.md:18-24, discussion-adversary.md, harness-config.md): `read: { "*": allow, "**/.env*": deny, "**/.dev.vars": deny, "**/.ssh/**": deny, "**/.aws/**": deny, "**/*.pem": deny, "**/*.key": deny }`. Hoje o agente `build` e **todos os executores/snipers leem `.env`**. Somar `read` (e `question`) às chaves harness-owned que vendor-core.mjs:501-514 passa a fazer merge no update — senão a correção nunca chega a projeto já vendorizado |
| `"question": "deny"` global | opencode.json.example:51; opencode.json:51; **e hardcoded na frota: cron-a-dispatch.mjs:595 grava `question: "deny"` em todo worktree semeado, force-overwrite, ignorando o config de origem** | CC nunca nega a capability; proibição headless é prosa (core/CLAUDE.md golden rule #1) — o próprio triaging-requests OC manda perguntar (SKILL.md:87, :136-142) e o config proíbe | `question: allow` nos dois arquivos **e** trocar o force-overwrite de cron-a-dispatch.mjs:595 (a frota headless pode manter `deny` explicitamente, mas isso tem que ser uma escolha de config da frota, não uma constante que reverte a mudança em toda sessão local); proibição headless fica onde o CC a mantém: prosa |
| `edit: deny` no agente build | core/opencode/agents/build.md:7 (prosa :15) | Edit/Write permitidos ao top-level (settings.json:4-5); QUICK implementa inline (core/CLAUDE.md) — o edit-deny é a raiz que empurrou todo write pra heredoc bash, alimentando os piores falsos-positivos da muralha (#410/#411) | `edit: allow`; proteção de plano já mora em plan-write-gate.ts. Reescrever a prosa dependente no mesmo PR: build.md:15, orchestrating-delivery SKILL.md:109/:127, brainstorming SKILL.md:84, grill SKILL.md:96-97, linha QUICK de triaging-requests SKILL.md:167 |
| bash negado no agente plan | core/opencode/agents/plan.md:7-12 (`"*": deny`, `bash: deny`) | descoberta no CC tem o allowlist read-only inteiro (settings.json:6-41); grill/deepening OC decidem "do prompt" sem sonda (grill SKILL.md:70, proposing-deepening SKILL.md:62) | map bash read-only no plan.md (`git status*`/`git log*`/`git diff*`/`ls*`/`cat*`/`wc*`/`find*`/`rg*`/`grep*`: allow, `*`: deny); deletar as concessões "no shell probe" das duas skills |
| `bash: deny` + `edit: deny` no agente planner | core/opencode/agents/planner.md:6-13 | o planner do CC tem **Read, Glob, Grep, Bash, Write, Skill** (core/claude-code/agents/planner.md:5-12) — nenhuma diferença mecânica de host justifica o corte | `bash: allow` no planner.md. Sobre `edit`: desde o PR #449 é o **plugin** que grava o `execution-plan.json` (memória oc-plan-authored-by-plugin-not-orchestrator), então `edit: deny` não é mais o que protege o plano — decidir conscientemente, e se ficar `deny`, dizer por quê aqui e não por herança |
| `bash: deny` no agente security | core/opencode/agents/security.md:6-13 | o security do CC tem **Read, Glob, Grep, Bash** (core/claude-code/agents/security.md:5-10) | `bash: allow`. Resto do catálogo de olhos está de fato em paridade — adversary, plan-reviewer, test-author e sniper também não têm Bash no CC; o delta é exatamente estes dois arquivos, e são justamente os papéis cujo julgamento o operador reclama |
| identity-alias | hook-identity.mjs:25-31 | CC não reconcilia (entry-gate.mjs:800) | `oneIdentity` retorna o primeiro valor em vez de `{ok:false}` (tier trusted já vence via :42-50); o throw em entry-gate.ts:234 vira inalcançável e sai |
| prosa que ensina a muralha morta | **Checklist completo (21 sites).** Já mapeados: build.md:70-71,:74; creating-plans SKILL.md:102; orchestrating-delivery SKILL.md:101,:109,:299,:316,:324; grill SKILL.md:96-97; brainstorming SKILL.md:84,:101; AGENTS.md:169,:171. **Faltavam — e são as mãos que escrevem código, o pior lugar pra deixar prosa que recusa comando legítimo:** executor-low.md:44, executor-medium.md:44, executor-high.md:44, executor-low-spawn.md:47, executor-medium-spawn.md:47, executor-high-spawn.md:47 (todas as 6 com o mesmo parágrafo `denied_class: "targeted_vitest"` + "Never use package launchers… or interpreter workarounds"), planner.md:68 (proíbe `npx`/`npm exec`/`bunx`/`pnpm dlx` no plano), orchestrating-delivery SKILL.md:225 ("do not use a package launcher" no passo de gates) e o **corpo do plan.md** (:50 "`bash` stays denied… é o que torna estrutural", :63) | o modelo obedece prosa como obedece hook — planner pós-fix ainda recusaria `npx vitest` no plano, executor ainda reportaria BLOCKED em vez de rodar o teste, grill ainda evitaria `$` em PRD | aposentadoria de prosa é **entregável do mesmo PR** que deleta os detectores, e o entregável é **a lista acima**, não a rede. Gate de verificação (rede, não substituto): `grep -rn 'package_launcher\|denied_class\|verify(' core/opencode/skills core/opencode/agents core/opencode/AGENTS.md` só pode retornar referências intencionais; AGENTS.md:169 vira nudge advisory estilo CC; AGENTS.md:171 (parágrafo do seal HMAC) sai |

Trilhos **já 1:1** — não mexer: branch protegida (bash-decide.mjs:1262-1278 ≡ entry-gate.mjs:578-596),
zero-commits (:1279-1288 ≡ :597-609), regate corrompido (:1438-1445 ≡ :628-631, a exceção
fail-closed deliberada dos dois), regate não-absolvido (:1459-1476 ≡ :636-651), hand-finished sem
captura (:1478-1500 ≡ :659-674), e os 4 denies do módulo compartilhado
core/shared/lib/real-file-capture-rail.mjs (:122-132, :149-161, :163-173, :175-185).

---

## 5. O que COLOCAR

Capacidades que o Claude Code TEM e o OpenCode não:

| O que | Onde no CC | Onde entra no OC | Por quê |
|---|---|---|---|
| **Canal advisory (allow + contexto, sem negar)** | decideBash retorna `{allow:true, hookSpecificOutput:{additionalContext}}` (entry-gate.mjs:555-563), produzido por adviseIssueForm (:364) e emitido por processInput (:1216-1223) | estender o typedef Decision (bash-decide.mjs:17) com `advisory?: string` em allow; `applyAdvisory(decision, output)` ao lado de throwIfDenied (:1636-1640) escrevendo em `output.metadata` (único canal de prosa da API de plugin OC de volta ao modelo); fiar no branch bash de entry-gate.ts; portar adviseIssueForm como primeiro consumidor. Fail-open: erro ao montar o aviso = engole e permite | a AUSÊNCIA deste canal é o motivo de todo "prefira a ferramenta X" do OC ter virado deny duro — sem como avisar, o autor só sabia bloquear. É o que torna as remoções da seção 3 seguras de revisar: a orientação sobrevive, a negação não |
| **Gatilho antecipado de captura no freeze-commit** | em `git commit` cuja mensagem casa "freeze locked tests for" (entry-gate.mjs:537-554), roda o real-file rail uma task MAIS CEDO — advisory/checkpoint natural; a entrega continua sendo o único ponto mandatório | mesmo padrão no branch bash não-de-entrega do OC, pós-remoções | pega uma captura não resolvida uma task antes do portão de entrega, barato e sem negar comando comum |
| **Trilho estreito de spawn-hand no bash** | dispatch `node .claude/hooks/spawn-hand.mjs --descriptor …` gateado em entry-gate.mjs:451-521: sem `--descriptor` = allow (cat/grep passam, :453-455); descriptor ilegível = deny (:468-486); sem fidelity-pass carimbado = deny (:504-519) | portar verbatim no caminho bash sobrevivente do OC, disparando SÓ quando `command.includes('spawn-hand.mjs')` | achado do adversário: em repo dual-vendored, o bash OC pode rodar o mesmo binário; hoje é negado por acidente pela muralha de interpretador — deletada a muralha, o OC ficaria MAIS permissivo que o CC na única classe não-de-entrega que o CC deliberadamente gateia. Custo de usabilidade zero (não casa nada além do dispatch literal). O trilho Task-side do OC fica, mas ALINHADO por T23 (sniper isento, match por feature) |
| **Gate 3 do shipper na superfície Task** (T21) | entry-gate.mjs:1006-1008 (regate_pending corrompido — o fail-closed deliberado do contrato :7-15) e :1015-1027 (pending sem absolvição, matchesAbsolution :1014) | branch shipper de decideEntryTask (entry-decide.mjs), reusando classifyRegatePending/matchesAbsolution de core/shared/lib (o trilho bash já os importa) | parity na direção contrária: pós-fix o OC permitiria um dispatch de shipper que o CC nega; a proteção sobraria só no push, sem o deny instrutivo do ponto de dispatch. A obrigação de re-gate é delivery-blocking e sobrevive a compaction pela entry policy — o consumidor no dispatch é parte da spec |
| **featureMismatch no dispatch do planner** (T22) | entry-gate.mjs:944-947 (cerimônia velha de outra feature → re-instruir) | branch planner de entry-decide.mjs:95-110 (ausente hoje; verificado por grep) | é o deny CC #3; a seção 4 o devia ("manter/garantir o equivalente") mas nenhum veredito o implementava — sem este porte ele não tem site de pouso. Entra no lote de T7/T18 |
| **Gate 1 estrito (modo LIGHT/FULL) no dispatch de entrega/hand** (T20) | entry-gate.mjs:828-842 | predicado de entry-decide.mjs:69-92 (site existe, está mais frouxo — tecnicamente A, listado aqui por ser cobertura de deny CC) | sob QUICK/no-ceremony o CC nega executor/sniper/test-author/planner/plan-reviewer/adversary; o OC hoje os deixa passar — frouxidão herdada, mesma categoria do secret-read |

---

## 6. O que fica DIFERENTE de propósito

Três divergências sobrevivem. A primeira por diferença mecânica de host, provada em código; as
outras duas por decisão consciente da frota (seção 3d), não por herança:

- **Rail de hand backgrounded (CC-only).** O CC nega dispatch de spawn-hand com
  `run_in_background: true` porque um Bash job em background não re-invoca o assistente sob
  `claude -p` e mata a sessão (entry-gate.mjs:405-435, lendo `payload?.tool_input?.run_in_background`
  em :415). Prova da diferença: `run_in_background` tem **zero ocorrências** sob core/opencode; a
  extração de argumento bash do plugin OC lê apenas `command`/`cmd` (entry-gate.ts:64-70) — não
  existe o parâmetro a inspecionar, e hands OC são Task in-session
  (host-hand-capture.mjs:1). Não portar. Reavaliar se o OpenCode um dia ganhar bash em background.
- **Retry K=3 do mesmo agente (OC-only).** `decideAgentRetryAllowed` (core/shared/lib/agent-retry.mjs:51-64,
  chamado em entry-gate.ts:339-348) não tem equivalente no Claude Code — o módulo mora em
  core/shared/lib mas **nenhum arquivo de core/claude-code o importa**. Fica porque é o anti-runaway
  de custo da frota OC e não taxa trabalho legítimo: o contador reseta em cada sucesso
  (agent-retry.mjs:88-116). O teto irmão (`decideGateBlockedDispatchAllowed`, :155-168) **sai** — é
  teto de teto e produz o deadlock "precondição nunca satisfeita".
- **`marker-authority` como ferramenta nativa privilegiada (OC-only).** Os 7 denies de
  marker-authority.ts:225-241 não têm equivalente no CC porque o CC carimba marker por CLI comum
  (`mark.mjs`, zero `permissionDecision`). Aqui a divergência é o OC ficando **melhor**: é a única
  integridade de marker que sobra depois de matar o seal (seção 6, risco 1), e ela é host-side, não
  pattern-matching de texto bash.

E a diferença sancionada de **superfície** (não de garantia): a precondição de fidelity-pass do
hand vive no bash no CC (entry-gate.mjs:451-521, porque o hand É um comando bash lá) e na
superfície Task no OC (entry-decide.mjs:130-138, porque o hand é um Task lá). **Correção da revisão
adversarial: a alegação anterior de "mesma regra" era falsa** — o OC gateia também o sniper (que o
CC isenta por design, entry-gate.mjs:1058-1064) e exige match exato por task onde o CC destrava por
feature (`startsWith`, :1080-1082). A sanção vale só pra SUPERFÍCIE; a regra é alinhada por T23.
Complementada pelo porte da seção 5 pro caso residual dual-vendored.

### Riscos que o Claude Code também corre

Lacunas dos **dois** runtimes, registradas como decisão futura separada do operador —
explicitamente **não** são motivo pra segurar o OpenCode:

1. **Gate-state é forjável via bash nos dois runtimes.** Pós-paridade (e **hoje**, no CC em
   produção): nada impede `echo '{"brainstormed":true,…}' > .claude/plans/.state/<sid>/gate-state.json`
   — settings.json:31/34/42/60 permitem echo/sed/cp/node, entry-gate.mjs:564 permite o resto, e os
   trilhos comparam booleans/arrays sem assinatura. A integridade da evidência de cerimônia nas duas
   frotas é boa-fé do modelo + o olho de review do PR (com auto-merge como amplificador de
   irreversibilidade). Se um dia quiser integridade real: estado guardado pelo host fora da árvore,
   ou verificação de proveniência no cron-review — **nunca** pattern-matching de texto bash, que o
   registro de fricção desta auditoria mostra falhando.
2. **`git push --force-with-lease` negado nos dois.** O glob `git push --force*` (settings.json:72;
   opencode.json.example:90; cron-a-dispatch.mjs:437) nega o comando que a própria recovery da frota
   prescreve pra PR obsoleto em branch per-run (memória per-run-branch-stale-pr-force-push; negação
   viva no log, opencode.log:84870). Corrigir **nos dois ao mesmo tempo** (allow explícito de
   `git push --force-with-lease*` acima do deny, nos 3 arquivos) ou aceitar conscientemente e rotear
   a recovery via `gh api`. Nunca corrigir só no OC.
3. **A frota headless-local roda o caminho "interativo" do teto de plan-review nos DOIS runtimes.**
   O guard interativo do CC lê `Boolean(env.CLAUDE_CODE_REMOTE)` (entry-gate.mjs:116-118), e a
   frota VPS **deleta** essa var deliberadamente (cron-a-dispatch.mjs:1372) — logo a frota CC mantém
   o hard-stop >10 (proteção anti-runaway, dado que o olho family-2 do OC já roda sem teto — memória
   oc-family2-eye-has-no-ceiling). A calibração é peculiar mas idêntica nos dois; **não divergir
   para "consertar" isso no alinhamento de T9** — o sinal de headless do OC tem que espelhar o CC
   byte a byte (Boolean(CLAUDE_CODE_REMOTE)), nunca os marcadores de rotina da frota. Decisão futura
   do operador, junta pros dois runtimes.

---

## 7. Ordem de execução

Sete lotes (o 1b entrou nesta revisão), cada um shippável sozinho, o mais arriscado por último.
Verificação nomeada por lote.

**Fato que governa a sequência inteira:** um fix merjado em core/ é **INERTE** até o projeto
re-vendorizar (memória fleet-runtime-is-vendored-claude-not-core — este repo já se queimou com
isso). E o mecanismo de update de hoje **não atualiza config**: `writeOpencodeConfig`
(core/claude-code/skills/initializing-projects/references/vendor-core.mjs:503-514 — este é o path
real; versões anteriores citavam core/vps/vendor-core.mjs, que não existe) só reescreve `plugin[]`
num opencode.json existente e nunca lê nem poda `permission` (prova empírica: o re-vendor de hoje
do gestao, commit 7aa14a6, tocou opencode.json com exatamente +1/−17 — só o `plugin[]`). O Lote 1b
é portanto **o entregável que faz todos os outros lotes chegarem a projetos reais** — qualquer
projeto vendorizado, em qualquer geração anterior (o levantamento achou 13 projetos, 9 versões
distintas de v0.14.0 a v0.49.8, em 3 formatos de stamp incompatíveis), dirigido por frota ou
puramente interativo, incluindo este repo (cujas duas shells estão em gerações diferentes:
.opencode em v0.40.0-3-g0167be3, .claude em v0.45.4). Não é limpeza do diretório gestao — o gestao
é um caso de teste.

**Lote 1 — Config e agentes (zero código de gate).**
Reescrever permission.bash espelhando o CC em opencode.json.example:52-102 **e** no
opencode.json rastreado (:52-102); portar o **mapa de READ** do CC (settings.json:63-70) pros dois
configs e pro HEADLESS_SAFE_PERMISSION_DEFAULTS (cron-a-dispatch.mjs:469-481), na forma de mapa
por-padrão na **chave global** — premissa **CONFIRMADA** pelo probe de schema desta revisão
(OpenCode 1.18.5: `PermissionRuleConfig = Union[ação escalar, Record<padrão,ação>]` vale pra
`read`, `edit` e `bash` igualmente; probe positivo ecoou o mapa verbatim em `opencode debug
config`, probe negativo com valor inválido falhou com `Expected PermissionActionConfig` apontando
o padrão exato — validação estrutural real, não passthrough; sem necessidade de replicar por
agente nos ~32 arquivos); `question: allow` nos dois (:51) **e** trocar o `question: "deny"`
hardcoded em cron-a-dispatch.mjs:595, que hoje reverte a mudança em todo worktree semeado;
`edit: allow` em build.md:7; map bash read-only em plan.md:7-12; `bash: allow` em planner.md:6-13
(e decisão consciente sobre `edit`) e em security.md:6-13. O corte de DANGEROUS_BASH_DENYLIST e a
migração de projeto vendorizado saem deste lote e viram o **Lote 1b** (o corte sem o ledger de
aposentadoria re-ressuscita denies no caminho double-fault).
*Verificação:* `npm test` com core/vps/cron-a-dispatch-seed.test.mjs,
core/vps/cron-a-dispatch.test.mjs, testes de vendor-core, **core/opencode/plugin/eyes-permission-lockdown.test.mjs**
(:86-93 afirma hoje `bash: deny` em security.md **e** planner.md — quebra com este lote),
**core/opencode/agents/plan-conversation-contract.test.mjs** (:58 afirma `bash: deny` no agente plan;
:108 e :121 afirmam a **prosa** do corpo — "`bash` stays denied"; :142 afirma o mesmo pro
harness-config) e core/opencode/agents/agents-manifest.test.mjs; manual: semear um worktree e
conferir o opencode.json resultante.

**Lote 1b — Migração de config de projeto vendorizado (novo nesta revisão; o desenho que faltava).**
O item que a seção 8 declarava sem desenho, agora fechado. Peças:
- **Marcador de geração em SIDECAR, não in-file** — probado e rejeitado o marcador dentro do
  opencode.json: o schema do OpenCode é ESTRITO em chave desconhecida top-level (`Unrecognized key:
  harness`; `$harness`/`_comment` idem). O sidecar é `.opencode/.harness-config-manifest.json`
  (comitado — o `.opencode/.gitignore` só exclui `plans/` etc., e o `cp -a` da frota o carrega de
  graça), com `{ generation, owned: { "permission.bash": [...], "permission.read": [...], plugin:
  [...] } }` — o modelo de ownership do bloco AGENTS.md (vendor-core.mjs:114-115, :527-548), movido
  pra fora do arquivo porque o JSON não aceita marcador.
- **`migrateOpencodeConfig(existing, manifest, harnessSet, generation)`** — função pura única em
  `core/shared/lib/opencode-config-migration.mjs`, importada pelos DOIS escritores:
  `writeOpencodeConfig` (vendor-core.mjs:503-514, caminho de update) e o seed da frota
  (cron-a-dispatch.mjs:941-953). Três tiers, modelo `adaptRoutingV1` (routing-adapter.mjs:26-33):
  **Tier 1** (manifest presente): `operator_extra = keys(existing) − keys(manifest.owned)`;
  `final = harnessSet ∪ operator_extra` — todo deny harness aposentado morre porque estava no
  manifest e não está no set novo. **Tier 2** (sem manifest, `.harness-version` presente — TODOS os
  13 projetos hoje): reconciliar contra o ledger congelado `RETIRED_OC_PERMISSION_ENTRIES`
  (`{ chave → { retired_in, shipped_value, shipped_through_generation } }`, construído do
  `git log -p` do opencode.json.example — mesmo shape do `LEGACY_GROK_SET`,
  routing-adapter.mjs:11-13, que o codebase já confia pra exatamente este trabalho). Regra de
  remoção: remove **sse** está no ledger E `shipped_through_generation ≥` a geração do projeto E o
  **valor atual é IGUAL ao que aquela geração shipou** — valor diferente = o operador mexeu →
  MANTÉM, promove a operator_extra e lista no relatório do update. Chave fora do ledger =
  autoria do operador → mantém. O comparador de geração normaliza os 3 formatos de stamp em campo
  (SHA puro `01279b7` = geração zero → ledger aplica inteiro; `vX.Y.Z`; git-describe
  `v0.40.0-3-g0167be3` → strip do sufixo `-N-g<sha>`). **Tier 3** (sem `.harness-version`): nada a
  migrar; escreve o set + manifest.
- **Idempotência e rollback:** run 2 pega o Tier 1 com operator_extra vazio → arquivo
  byte-idêntico (os dois escritores já serializam igual: `JSON.stringify(cfg,null,2)`+newline —
  teste de aceite por hash). Rollback em 3 camadas: git (opencode.json é rastreado em todo projeto
  checado), `opencode.json.pre-migration.bak` escrito uma vez só quando o Tier 2 removeu algo, e
  **gate de validação antes do rename** (shape-check + `opencode debug config` quando o binário
  está no PATH; falhou → não renomeia, cai no caminho manual já existente de
  vendor-core.mjs:515-518). O temp+rename atômico de :511-513 fica.
- **Frota deixa de re-impor o set velho:** cron-a-dispatch lê o opencode.json do projeto como base
  do seed (:917-918/:941-945) e o ratchet de deny (:586 `normalized === "deny" || !(key in bash)`)
  **nunca** deixa um deny da base cair — (a) rodar `migrateOpencodeConfig` na base ANTES do
  enforcement (:947), (b) estreitar o ratchet: deny protegido de overwrite **só quando a chave não
  está no ledger** (proteção de chave do operador fica), (c) cortar DANGEROUS_BASH_DENYLIST
  (:436-458) pros 6 do CC **com teste de disjunção** `keys(DANGEROUS_BASH_DENYLIST) ∩
  keys(RETIRED_OC_PERMISSION_ENTRIES) === ∅` — a constante é espelho hand-synced documentado
  (:426-428) e ressuscita qualquer chave esquecida no caminho double-fault. Reconciliação
  frota/interativo: `bash["*"]="allow"` forçado (:591) fica **só no worktree** e entra no ledger
  (o vazamento pro root do victor-bot vira resíduo reconhecido, não intenção do operador);
  `question:"deny"` idem (com Lote 1).
- **Sinal de projeto stale (gap histórico, já fechado):** o CC tem
  (core/claude-code/hooks/version-check.mjs:128 lê `.claude/.harness-version` e emite
  systemMessage). Na época desta auditoria, o OC não tinha o check e só checava catálogo. O check
  de staleness foi portado depois; a PR4.2 removeu o advisory OC-only de saúde do catálogo e manteve
  `version-check` estritamente dedicado a versão, sempre fail-open.
- **O mesmo buraco existe do lado CLAUDE, pior:** `writeSettings` (vendor-core.mjs:1271-1281)
  NUNCA atualiza um `.claude/settings.json` existente — escreve `settings.harness.json` "pra merge
  manual" que nunca acontece (4 projetos com o órfão; ass-fin-app roda SEM os denies de secret-read
  desde v0.18.7). Item próprio no roadmap (mesma família, superfície CC).
- **Limite declarado:** nada disto ATUALIZA um projeto dirigido só pela frota — a migração roda no
  update interativo (`npx … init`/`oc-updating-harness`, que se auto-bloqueia em headless,
  SKILL.md:28-29) e no seed do worktree (que não escreve de volta no projeto). Projeto só-frota fica
  stale no disco indefinidamente → decisão do operador (seção 8).
- **Correção de fato:** o repro do gestao NÃO é causado por denies stale no opencode.json (o
  permission block do gestao é byte-idêntico ao example atual) — é causado pelos denies da camada
  de plugin + gate-state ausente (seções 3d/2). A migração continua obrigatória, mas quem ela
  resgata de config stale são victor-bot e harness-361; a frase anterior da seção 8 ("sem ele o
  repro do gestao sobrevive") atribuía o mecanismo errado.
*Verificação:* testes novos de opencode-config-migration (Tier 1/2/3, idempotência por hash,
mismatch-de-valor mantém+reporta, os 3 formatos de stamp); cron-a-dispatch-seed.test.mjs (ratchet
estreitado; disjunção ledger×denylist); vendor-core tests; manual: rodar o update em harness-361
(perde os 3 npx wildcard + os 15 paths de `plugin[]`) e no victor-bot (mantém e REPORTA
`"git pull*"` e `"*":"allow"`), duas vezes — segunda passada byte-idêntica.

**Lote 2 — Derrubar a muralha forge + portar o advisory + aposentar a prosa.**
Deletar decideBashForge/isStateForgeCommand/detectores/constantes (seção 3a) e a chamada em
entry-gate.ts:263-265 + import :183-188; adicionar advisory channel + adviseIssueForm (seção 5);
remover command-resolver.ts e desregistrar a ferramenta nativa `verify` (seção 3d — os dois únicos
produtores do `denied_class` que ela resolve são bash-decide.mjs:1087 e :1121, e morrem aqui) —
**no MESMO PR, remover a entrada de CANONICAL_OC_PLUGINS (cron-a-dispatch.mjs:494)**: sem isso
`ensureOcPluginPathsExist` (:877-896) lança fail-closed no seed e a frota OC inteira morre antes de
qualquer sessão nascer, com a suite deste lote verde; checklist de prosa da seção 4 — **os 21
sites nomeados** (a varredura final desta revisão produziu a lista fechada com quote e ação por
site — delete vs reescrita advisory), incluindo os 6 executores, planner.md:68,
orchestrating-delivery SKILL.md:225 e o corpo do plan.md — com o grep-gate no test plan e no CI
(guard permanente, não só no PR).
*Verificação:* core/opencode/plugin/lib/bash-decide.test.mjs reescrito (casos forge viram casos
allow), core/opencode/plugin/entry-gate.test.mjs, testes de command-resolver,
**core/vps/cron-a-dispatch-seed.test.mjs** (o seed sobrevive sem command-resolver.ts) e
plugin-default-export.test.mjs, grep-gate de prosa verde, `npm test` completo.

**Lote 3 — Alinhar o portão de entrega ao CC.**
Fail-open no load (entry-gate.ts:272-274; bash-decide.mjs:1292-1299), session-id fail-open
(:1301-1308), deletar a escada de modo inteira (:1321-1430), coerção de arrays (:1447-1457),
feature-id vira skip (:1502-1512 + guard :1566), dropar flags do real-file (:1584-1588), deletar
A5 (:1514-1559 + wiring), final-review/demo (:1597-1618), catch fail-open (:1623-1629), detector
de entrega string-inteira (is-delivery-command.mjs:11-29), branch bash de plano
(entry-gate.ts:289-297); mover feature/brainstormed/adversary_fired pro dispatch do planner
(entry-decide.mjs); portar o trilho estreito de spawn-hand e o gatilho de freeze-commit.
*Verificação:* suite delivery de bash-decide.test.mjs espelhando caso a caso
core/claude-code/hooks/entry-gate.test.mjs e entry-gate-corrupt-regate.test.mjs;
is-delivery-command.test.mjs; repro do gestao (commit em feature branch, `.state/` vazio →
entrega permitida; regate-pending não-absolvido → negada nos DOIS runtimes).

**Lote 4 — Alinhar a superfície Task/dispatch ao CC (seção 3d, vereditos pós-adversarial).**
Sem este lote a paridade entregue é só de bash e a pipeline continua tão travada quanto hoje.
A alcançabilidade manda a ordem interna: **plan-gate primeiro** (é o que o operador vê), depois o
par planner, depois o resto.
- **plan-gate.ts (T10 corrigido + T12 + T13):** o bloco requiresFullPlan (:82-150) vira condicional
  à existência do binding — ausente → skip total (fail-open); presente → snapshot (:115-122) +
  mismatches positivos de identidade envelope (:127/:130/:141, ausência pula) + injeção do plano
  (:144-149). `if (!sid) return` e reconciliação ilegível → log + return (nunca continuar com
  `{}`). Remover :85, :103, :105-109 e :137 (**atômico com obs-hand :234** — T14+T17 são uma
  mudança só).
- **Planner (T7+T18+T22, uma unidade):** deletar o loop de recovery (entry-gate.ts:356-381);
  entry-decide.mjs:95-110 vira o portão vivo do planner; adicionar o featureMismatch do CC
  (entry-gate.mjs:944-947) nesse branch; reparo de lifecycle do claim em planner-state.mjs (claim de
  call morto → reconciliar/adotar sob o mesmo lock antes de permitir) — allow+log em
  planner-recovery.ts:167 sem isso queima sessão Opus com plano descartado como stale. Manter só
  :141.
- **entry-gate.ts:** fail-open no load (:334-336); remover o teto gate-blocked (:349-355) e manter
  só o retry K=3 (:339-348); remover o congelamento de mãos de escrita (:401-404 →
  loop-decide.mjs:660-676).
- **loop-guard (T9 especificado):** warn>3 / deny>10 / deny só quando `!Boolean(CLAUDE_CODE_REMOTE)`
  (espelho de entry-gate.mjs:116-118 — NUNCA os marcadores da frota); warn entregue por
  prompt-append (padrão plan-gate.ts:144-149); reserveReviewAttempt cai pra allow em estado sem
  binding de sessão (repo frio) pra deixar o deny instrutivo do entry-decide aparecer.
- **dual (T2 ampliado):** o gate de dual sai da superfície de dispatch de hand; dual-enforcement
  vira gravação; drive-bys: catch-alls (entry-decide.mjs:142-148, dual-enforcement.mjs:408-418)
  alinhados a allow+log (código morto, paridade de contrato).
- **obs-hand (T17 corrigido):** os 3 denies de dispatch (:234/:237/:247) viram shadow-record
  **preservando todos os writes** (claim/token/hand-record/cleanup); os 7 after/event idem, por
  higiene.
- **Portes de cobertura CC (T20-T23):** Gate 1 estrito (modo ∈ {LIGHT,FULL} pra papel de
  entrega/hand em entry-decide.mjs:69-92); Gate 3 do shipper (regate no branch shipper de
  decideEntryTask, helpers de core/shared/lib); fidelity alinhado (sniper fora de :122; match
  feature-level em :33-35).
*Verificação:* core/opencode/plugin/entry-gate.test.mjs, plan-gate.test.mjs,
lib/entry-decide.test.mjs, lib/dual-enforcement*.test.mjs, lib/loop-decide/review-accounting.test.mjs,
obs-hand/planner-recovery tests; repros (corrigidos pela revisão adversarial): dispatch de planner
com `.state/` vazio → **deny instrutivo CEREMONY_PROOF_REQUIRED** (o CC também nega — a versão
anterior desta linha esperava "permitido" e estava errada); 2º dispatch de planner após o 1º negado
→ o MESMO deny instrutivo (cascata S1b morta); **dispatch de SNIPER via plan-gate com gate-state
vazio → permitido** (o caso fix-mode, que o dry-run do Lote 6 tem que exercitar no dispatch, não só
no push); dispatch de executor com `review_cap_reached` → permitido; plan-review na rodada 5 →
warn, não deny; env com cara de frota (HARNESS_NOTIFY_PROJECT set, CLAUDE_CODE_REMOTE ausente) →
deny>10 mantido; env cloud → warn-only; claim rejeitado em obs-hand ainda gera hand-record +
capture_verified.

**Lote 5 — Seal, binding, identidade, muralha do plan-write-gate.**
Remover validação de seal nos 3 sites + ceremony-transition.mjs:134 + ceremony-binding.mjs:38-50;
strip dos 4 writers; deletar marker-seal.mjs quando `grep -rn marker_seals core/opencode` só
retornar teste; edições **dentro** de ceremony-binding.mjs (:22-24, :28-54) preservando os 5
consumidores; oneIdentity tolerante (hook-identity.mjs:25-31) + remover o throw entry-gate.ts:234;
deletar o branch bash do plan-write-gate.ts:230-256 e converter os throws de identidade
(:164-166, :187-194) em shadow-record.
*Verificação:* marker-authority.test.mjs, marker-security.test.mjs, plan-write-gate.test.mjs,
plan-gate.test.mjs, entry-gate.test.mjs (OC), hook-identity.test.mjs, ceremony-recovery.test.mjs,
ceremony-coordinator.test.mjs, plugin-default-export.test.mjs (plugin carrega).

**Lote 6 — Re-vendor e fumaça de frota.**
`updating-harness` nos projetos vivos (gestao como caso de teste, depois os 12 restantes do
levantamento — lembrete permanente: fix em core/ é **inerte** até re-vendorizar); conferir que a
migração do Lote 1b rodou (manifest sidecar presente; em harness-361/victor-bot os denies
aposentados saíram ou foram reportados); dry-run de fix-mode OC — **corrigido pela lente de
frota: o dry-run tem que exercitar o DISPATCH do sniper com gate-state vazio atravessando a cadeia
de 5 plugins, não só o push** (a versão anterior só verificava o push, que nunca era onde o
fix-mode morria — plan-gate.ts:111 mata o dispatch antes).
*Verificação:* core/vps/cron-a-dispatch-fixmode.test.mjs (**com caso novo: sniper Task dispatch em
estado vazio sobrevive a cadeia**), cron-review.test.mjs, cron-review.automerge.test.mjs,
cron-a-select.automerge.test.mjs; observação de 1 ciclo real da frota OC com o Telegram feed,
incluindo um BLOCK→fix-mode→convergência de ponta a ponta.

---

## 8. Riscos aceitos e cobertura

**O que a paridade deliberadamente troca:**
- Detecção de "task planejada nunca despachada" (A5) — o CC nunca teve, em nenhum modo.
- Assinatura de markers (seal) — o CC nunca teve; a troca elimina o auto-bricking do #423.
- Qualquer muralha de forma-de-comando — o registro mostra que ela só parou trabalho legítimo;
  a exposição de forja que sobra é idêntica à que o CC carrega em produção (seção 6, risco 1).
- Precondições de brainstorm/adversary/feature no ship — movem pra onde o CC as põe (dispatch do
  planner), onde são acionáveis.
- Congelamento de mãos de escrita por review-cap e thresholds de loop mais apertados (seção 3d,
  T8/T9) — o CC avisa e segue; a convergência passa a depender do nudge + escalação ao operador,
  como no CC.
- Denies de dispatch de obs-hand e planner-recovery viram shadow-record — a evidência continua
  sendo gravada, só deixa de derrubar a chamada. É a categoria que o CC não tem: no CC o observador
  é PostToolUse e **não pode** negar.
- **Serialização de mão de escrita (single-flight) — abandonada conscientemente.** O claim
  single-slot de obs-hand.ts:247 (dispatch-scope.mjs:214-226) era o único serializador de writing
  hands do OC; convertê-lo em shadow-record remove a single-flight por construção. É paridade — o
  CC também não tem serializador de dispatch; a sequência é comportamento do orquestrador nos dois
  runtimes, e na frota a serialização real é o run-lock por projeto (run-lock.mjs) — e elimina o
  modo de falha "cleanup perdido → deny duro na task seguinte".
- **O gate de dual/plan_verdict sai da superfície de dispatch** (T2 ampliado) — a disciplina volta
  a ser prosa+orquestração como no CC; dual-enforcement sobrevive como gravação.

**Divergências que o relatório mantém de propósito (além da seção 6):**
- **retry K=3 do mesmo agente** (agent-retry.mjs:51-64, importado só pelo OC) — anti-runaway de
  custo da frota; reseta no sucesso, não bloqueia trabalho legítimo.
- **marker-authority.ts** (7 denies) — é a emissão host-side da capability, a única integridade de
  marker que sobra depois de matar o seal. O CC não tem equivalente porque o CC não tem integridade
  de marker nenhuma (seção 6, risco 1) — aqui o OC fica melhor, não pior.

**Superfícies auditadas (nenhuma dropada por capacidade):** bash-forge-rail, bash-delivery-rail,
task-dispatch-rail (medido nesta versão: entry-gate.ts, entry-decide.mjs, plan-gate.ts,
dual-enforcement.mjs, loop-guard.ts/loop-decide.mjs, obs-hand.ts, planner-recovery.ts,
command-resolver.ts, marker-authority.ts, agent-retry.mjs), dual-enforcement, dispatch-scope,
plan-write-gate, loop-guard, ceremony-state-machine, permissions-config (bash **e read**),
agents-catalog, aux-plugins, entry-policy-and-rules, skills-catalog, vps-fleet-oc-automerge-gate,
marker-authority-tool-binding, ceremony-coordinator-tool,
oc-agent-frontmatter-permission-matrix-volume, test-only-described-catalog-contracts.

**Fechado por esta revisão final (era aberto, não é mais):**
- **A seção 3d passou pelo ciclo adversarial completo** — 3 lentes (mecânica, fidelidade nas duas
  direções, capacidade de frota) sobre T1-T19 + as ferramentas nativas. Resultado incorporado:
  T10/T7/T18/T9/T2/T12/T13 corrigidos, T3/T4 rebaixados a drive-by (código morto), T20-T23
  adicionados (cobertura de deny CC que faltava). Os vereditos de 3d são fechados.
- **Alcançabilidade medida** (seção 2): 43 alcançáveis de 67 brutos; 10 possíveis primeiras
  negações; 2 dominam tudo (plan-gate.ts:111, entry-gate.ts:377); ordem real dos plugins é
  alfabética reversa com entry-gate POR ÚLTIMO; blast radius do obs-hand é 3, não 10; 7 sites
  mortos/subsumidos; 16 fora da superfície de Task.
- **A migração de projeto vendorizado tem desenho** (Lote 1b): sidecar de manifest (marcador
  in-file probado e rejeitado — schema estrito), função única `migrateOpencodeConfig` nos dois
  escritores, ledger de chaves aposentadas com regra valor-igual-remove/valor-diferente-mantém-e-
  reporta, ratchet da frota estreitado, idempotência por hash, rollback em 3 camadas.
- **`permission.read`/`permission.edit` aceitam mapa por-padrão na chave global — CONFIRMADO** por
  probe de schema (OpenCode 1.18.5, positivo + controle negativo com validação estrutural real). O
  Lote 1 não precisa de fallback por-agente.
- **mergeGateStatePatch triado** — o risco é real mas estreito: o único caller vivo de
  mergeGateState é o write de `hand_quarantine` (run-hand.mjs:307), e `validateGateStateDualFields`
  roda sobre o estado MERGED inteiro (gate-state-shape.mjs:445), então um dual_completed/enum
  legado já em disco (ex.: gate-state pré-refatoração importado por projeto migrado — exatamente o
  cenário do Lote 1b) brickaria o hand_quarantine por motivo alheio. Entra no roadmap como item
  próprio (escopar a validação ao delta do patch — a própria opção 2 do kaizen.md:953 — + sanitizar
  gate-state legado no update), fora dos lotes de paridade mas antes/junto do Lote 1b.
- **Prosa da muralha morta: lista fechada** — a varredura final produziu os sites com quote e ação
  (delete vs reescrita advisory) e o grep-gate vira guard permanente de CI no Lote 2.
- O verdict truncado `cc-only-freeze-commit-early-capture-advisory` foi reconstruído do código CC
  (entry-gate.mjs:530-554) e entra como porte (seção 5).

**Ainda aberto (honestidade):**
- **Postura de julgamento do orquestrador OC** — o experimento controlado (mesma issue #82: OC
  parou no plan-review rodada 2/5 com orçamento sobrando e nenhum deny registrado; Claude aprovou
  e entregou) mostra que parte do gap é comportamento do modelo/prompt, não gate. Paridade de
  trilhos **não** conserta isso; fica como acompanhamento separado.
- **Olho family-2 sem teto** (malformed contado como sucesso no K=3, memória
  oc-family2-eye-has-no-ceiling) — defeito real, fora do escopo de paridade de trilhos.
- **A ordem dos plugins é herdada do readdir, não é contrato** (seção 2). Depois da paridade ela
  continua estrutural (define qual deny o operador vê); precisa virar explícita — item de roadmap,
  ainda não desenhado (opções: prefixo numérico nos arquivos, loader único, ou asserção de ordem em
  teste).
- **Projeto dirigido só pela frota fica stale no disco indefinidamente** — a migração roda no
  update interativo e no seed do worktree; nada escreve de volta no projeto, e `oc-updating-harness`
  se auto-bloqueia em headless. Precisa de decisão do operador (aceitar, ou criar um caminho de
  update autônomo com PR).
- **O buraco espelho do lado Claude** — `writeSettings` nunca atualiza settings.json existente; 4
  projetos com settings.harness.json órfão, ass-fin-app sem os denies de secret-read desde v0.18.7.
  Item próprio de roadmap; não bloqueia a paridade OC mas é a mesma classe de defeito.
- **O ledger de aposentadoria é curado à mão** a partir do git log do example — uma geração
  esquecida deixa resíduo em projeto antigo (mitigado pelo teste de disjunção e pela regra
  fail-safe "não reconhecido → mantém e reporta", nunca remove errado).
- A varredura de prosa foi por grep dirigido; pode haver referência residual em skill não listada —
  o grep-gate do Lote 2 é a rede.

---

## 9. Apêndice — tabela completa de vereditos finais

Legenda: **R** = remover · **A** = alinhar ao CC · **P** = portar do CC · **K** = manter divergente · **=** = já 1:1, não mexer.

| # | Regra | Local OC | Final |
|---|---|---|---|
| 1 | forge-rail-runs-before-any-context | entry-gate.ts:263-265 | A |
| 2 | node-preload-flag-catchall | bash-decide.mjs:1026-1033 (det. 522-544) | R |
| 3 | package-launcher-deny | :1082-1092 (det. 833-862) | A (governança → permission map) |
| 4 | prescribed-package-command-exact-form-only | :916-950 | A (globs de prefixo no config) |
| 5 | unauthorized-interpreter-script | :1117-1125 (det. 476-515) | A |
| 6 | node-test-unauthorized-path | :502-507, 428-467, 413-420, 82 | A |
| 7 | node-test-reporter-deny | :435-437, :542 | R |
| 8 | eval-one-liner-deny | :1034-1041 (det. 292-308) | R |
| 9 | nested-shell-c-deny | :1042-1049 (det. 341-370) | R |
| 10 | shell-script-or-pipe-to-shell-deny | :1050-1057 (det. 565-578) | R |
| 11 | source-or-shell-stdin-deny | :1058-1065 (det. 681-695) | R |
| 12 | expanding-redirect-unquoted-heredoc | :593-594 | R |
| 13 | expanding-redirect-oracle-path | :602 (ORACLE_PATH_RE 45-46) | R |
| 14 | expanding-redirect-opaque-var-target | :604-613 | R |
| 15 | expanding-redirect-default-deny | :614-624 | R |
| 16 | archive-unpack-tar | :633-638 | R |
| 17 | archive-unpack-git-apply | :639 | R |
| 18 | archive-unpack-zip-and-decompress | :640-646 | R |
| 19 | tmp-script-runner-deny | :1101-1108 (det. 315-328) | R |
| 20 | direct-script-exec-deny | :1109-1116 (det. 551-558) | R |
| 21 | complex-env-deny | :1017-1024 (det. 180-184) | R |
| 22 | frozen-path-bash-write-deny | :1093-1100 (det. 656-674) | R |
| 23 | cc-marker-cli-under-oc-deny | :1008-1015 (regex 36-37) | R (nudge vira advisory) |
| 24 | native-marker-authority-exec-deny | :1000-1006 (regex 40-41) | R |
| 25 | oracle-path-substring-catchall | :1126-1134 (960-987) | R |
| 26 | forge-decision-exception-fail-closed | :1135-1141 | A (fail-open no branch sobrevivente) |
| 27 | execution-plan-immutable-via-bash | entry-gate.ts:289-297 (helper 72-80) | A (fica só em plan-write-gate.ts) |
| 28 | oc-config-bash-default-ask | opencode.json.example:52-102 **+ opencode.json:52-102 + vendor-core.mjs:503-514 + cron-a-dispatch.mjs:436-458** | A |
| 29 | cc-advisory-allow-plus-context | bash-decide.mjs:1636-1640 (ausência) | P |
| 30 | identity-alias-conflict-throws-on-every-tool | entry-gate.ts:234; hook-identity.mjs:25-31 | R (resolver tolerante) |
| 31 | delivery-gatestate-unreadable-failclosed | entry-gate.ts:272-274; bash-decide.mjs:1292-1299 | A |
| 32 | delivery-marker-seal-process-instance | entry-gate.ts:277-281 **e 382-388**; plan-gate.ts:105; ceremony-transition.mjs:134; ceremony-binding.mjs:38-50; marker-seal.mjs | R (todos os sites + writers) |
| 33 | delivery-ceremony-session-binding-mismatch | ceremony-binding.mjs:22-24 | R (dentro do módulo) |
| 34 | delivery-ceremony-feature-binding-mismatch | ceremony-binding.mjs:25 | A (→ dispatch do planner) |
| 35 | delivery-required-marker-binding-brainstorm-adversary | ceremony-binding.mjs:28-53 | R (dentro do módulo; 5 consumidores preservados) |
| 36 | delivery-no-ceremony-mode | bash-decide.mjs:1321-1328 | R |
| 37 | delivery-requires-ceremony-stamp | :1330-1337 | R |
| 38 | delivery-review-cap-reached | :1340-1352 | R — **mas o cap que fica é mais estrito que o do CC**: vive em loop-decide.mjs:18-23/:646-648/:660-676 (não em entry-decide.mjs) e precisa do alinhamento próprio de 3d/T8+T9 |
| 39 | delivery-quick-launder-residue | :1354-1366 (det. 94-115) | R (guard monotônico classify-side fica) |
| 40 | delivery-brainstormed-required | :1369-1376 | A (→ dispatch do planner) |
| 41 | delivery-adversary-fired-required | :1377-1384 | A (→ dispatch do planner) |
| 42 | delivery-full-requires-recorded-dual | :1385-1393 | R |
| 43 | delivery-status-blocked | :1396-1407 | R |
| 44 | delivery-planner-status-usable | :1408-1421 | R — **não destrava o #82 sozinho**: a mesma precondição sobrevive em plan-gate.ts:110-112 (ver #79) |
| 45 | delivery-invalid-mode-stamp | :1423-1430 | R |
| 46 | delivery-corrupt-regate-pending | :1438-1445 | = |
| 47 | delivery-corrupt-array-markers | :1447-1457 | A (coerção a []) |
| 48 | delivery-unmatched-regate-pending | :1459-1476 | = |
| 49 | delivery-unmatched-hand-finished | :1478-1500 | = |
| 50 | delivery-lightfull-requires-feature-id | :1502-1512 (+guard :1566) | A (skip, não deny) |
| 51 | delivery-multitask-writing-coverage-a5 | :1514-1559 (+1221-1236, +wiring) | R |
| 52 | delivery-listfn-unavailable | :1567-1575 | A (deletar pré-check redundante) |
| 53 | realfile-done-record-unresolved-freeze | real-file-capture-rail.mjs:122-132 | = |
| 54 | realfile-ancestor-undetermined | :149-161 | = |
| 55 | realfile-scope-frozen-violation | :163-173 | = |
| 56 | realfile-done-without-capture-stamp | :175-185 | = |
| 57 | realfile-no-capture-evidence-session-scoped | :198-209 via bash-decide.mjs:1584-1588 | A (dropar as flags) |
| 58 | delivery-full-final-review-missing | bash-decide.mjs:1597-1607 | R |
| 59 | delivery-full-demo-missing-interactive | :1608-1618 (det. 1197-1211) | R |
| 60 | delivery-decision-catch-all | :1623-1629 | A (fail-open) |
| 61 | delivery-command-detector-scope | is-delivery-command.mjs:11-29 | A (string inteira) |
| 62 | delivery-protected-branch | bash-decide.mjs:1262-1278 | = |
| 63 | delivery-zero-commits-ahead | :1279-1288 | = |
| 64 | cc-only-backgrounded-hand-dispatch | sem equivalente OC (CC: entry-gate.mjs:405-435) | K |
| 65 | cc-only-spawn-hand-fidelity-rail (bash residual) | sem equivalente OC bash (Task: entry-decide.mjs:119-136) | P (trilho estreito verbatim) |
| 66 | cc-only-freeze-commit-early-capture-advisory | sem equivalente OC (CC: entry-gate.mjs:530-554) | P |
| 67 | oc-build-agent-edit-deny | agents/build.md:7 | A |
| 68 | oc-config-question-deny | opencode.json.example:51; opencode.json:51 | A |
| 69 | plan-write-gate-active-dispatch-bash-wall | plan-write-gate.ts:230-256 (+164-166, 187-194) | R |
| 70 | plan-lane-bash-deny | agents/plan.md:7-12 | A (bash read-only) |
| 71 | stale-prose-refusal-rails | build.md, 6 executores, planner.md:68, plan.md (corpo), SKILL.md's, AGENTS.md — **21 sites, lista completa na seção 4** | A (aposentadoria com grep-gate) |

**Superfície Task/dispatch (medida nesta revisão — seção 3d):**

| # | Regra | Local OC | Comportamento CC | Final |
|---|---|---|---|---|
| 72 | task-gatestate-unreadable-failclosed | entry-gate.ts:334-336 | fail-open (entry-gate.mjs:1001-1003) | A |
| 73 | dual-gatestate-unreadable-failclosed | dual-enforcement.mjs:705-711 | sem conceito de dual no gate | A |
| 74 | task-decision-catch-all | entry-decide.mjs:142-148 | sem catch-all de deny (entry-gate.mjs:4-6, :1211-1214) | A (fail-open; **código morto — drive-by, não entregável nomeado**) |
| 75 | dual-decision-catch-all | dual-enforcement.mjs:408-418 | idem | A (fail-open; **duplamente morto — :398-407 inalcançável pelo enum fechado; drive-by**) |
| 76 | same-agent-retry-k3 | entry-gate.ts:339-348 → agent-retry.mjs:51-64 | sem equivalente (zero importadores CC) | K |
| 77 | gate-blocked-dispatch-k3 | entry-gate.ts:349-355 → agent-retry.mjs:155-168 | sem equivalente | R |
| 78 | ceremony-recovery-loop-throws | entry-gate.ts:356-381 (:375, :377) | deny instrutivo sem mutar estado (entry-gate.mjs:947-988) | A (**corrigido: deletar o loop; entry-decide.mjs:95-110 vira o portão; atômico com #88 e o porte #98**) |
| 79 | plan-gate-planner-status-usable | plan-gate.ts:110-122 (bloco :82-150) | sem plan-gate de dispatch NENHUM | A (**corrigido: bloco inteiro condicional à existência do binding — ausente pula, presente verifica; status+binding são escritos atomicamente, a proposta "só o campo" não destravava nada; raiz do fix-mode**) |
| 80 | plan-gate-planner-session-binding | plan-gate.ts:85 | sem comparação (estado é da própria sessão) | R |
| 81 | plan-gate-artifact-unreadable | plan-gate.ts:89 | fail-open | A |
| 82 | plan-gate-ceremony-seal-and-id-conflicts | plan-gate.ts:103, :105-109, :127, :130, :141 | cerimônia só no planner (entry-gate.mjs:947-988); seal inexistente; CC sem check feature/task em dispatch downstream | R (:103, :105-109) · A (:127/:130/:141 **só dentro do branch artefato-presente, mismatch positivo de envelope; ausência pula**) |
| 83 | plan-gate-task-prompt-marker-required | plan-gate.ts:137 | CC não tenta binding por prosa (entry-gate.mjs:1032-1034) | R (**atômico com #87 — obs-hand.ts:233 exige o mesmo marcador um plugin depois**) |
| 84 | task-marker-seal | entry-gate.ts:382-388; plan-gate.ts:105-109 | sem assinatura de marker | R (com #32) |
| 85 | review-cap-freezes-writing-hands | entry-gate.ts:401-404 → loop-decide.mjs:660-676 | não congela mão nenhuma; warn acima do cap (entry-gate.mjs:908-922) | A (remover o congelamento) |
| 86 | loop-guard-thresholds-stricter | loop-decide.mjs:18-23, :646-648 (via loop-guard.ts:268) | warn>3, deny>10, deny só interativo (entry-gate.mjs:884-885, :893-907) | A (**sinal = Boolean(CLAUDE_CODE_REMOTE) espelhado; warn por prompt-append; adversary deny=4 é código morto**) |
| 87 | obs-hand-observer-denies-dispatch | obs-hand.ts:234, :237, :247 (**os 7 restantes são after/event, fora do trilho**) | observador CC é PostToolUse com **zero** `permissionDecision` (stamp-triage.mjs) | A (shadow-record + log, **preservando todos os writes**; serialização single-slot abandonada conscientemente — seção 8) |
| 88 | planner-recovery-denies | planner-recovery.ts:131, :137, :141, :167 (**:199/:256 são after-hooks**) | sem equivalente | A (manter só :141; **:167 exige o reparo de lifecycle do claim em planner-state.mjs, não só allow+log — atômico com #78**) |
| 89 | command-resolver-and-verify-tool | command-resolver.ts:91-113 (9 throws) + ferramenta nativa `verify` | sem equivalente; existe só pra recuperar dos denies da muralha (bash-decide.mjs:1087, :1121) | R (morre com a muralha, Lote 2 — **no mesmo PR: remover de CANONICAL_OC_PLUGINS, cron-a-dispatch.mjs:494, senão o seed da frota lança fail-closed em :890-894**) |
| 90 | marker-authority-native-tool | marker-authority.ts:225-241 (7 throws) | CC carimba por CLI comum (mark.mjs, zero deny) | K |
| 91 | oc-config-read-allow-no-secret-deny | opencode.json.example:40; opencode.json:40; cron-a-dispatch.mjs:470 | 8 denies de leitura de segredo (settings.json:63-70) | **P** (portar o mapa de READ do CC) |
| 92 | fleet-hardcodes-question-deny | cron-a-dispatch.mjs:595 | CC nunca nega a capability | A (com #68 — senão #68 é revertido em todo worktree) |
| 93 | legacy-denies-survive-revendor | cron-a-dispatch.mjs:582-590 (união deny-first, base vence); vendor-core.mjs:501-514 (update só reescreve `plugin[]`) | n/a — o CC re-vendoriza `settings.json` inteiro | A (passo de migração explícito no Lote 1) |
| 94 | oc-planner-agent-bash-edit-deny | agents/planner.md:6-13 | planner CC tem Read/Glob/Grep/**Bash**/**Write**/Skill (agents/planner.md:5-12) | A |
| 95 | oc-security-agent-bash-deny | agents/security.md:6-13 | security CC tem Read/Glob/Grep/**Bash** (agents/security.md:5-10) | A |

**Adicionados pela revisão adversarial final (seção 3d pós-ataque):**

| # | Regra | Local OC | Comportamento CC | Final |
|---|---|---|---|---|
| 96 | task-gate1-mode-strictness (QUICK/no-ceremony deixa hands passarem) | entry-decide.mjs:69-92 | nega TODO papel de entrega/hand salvo modo ∈ {LIGHT,FULL} (entry-gate.mjs:828-842) | A (T20) |
| 97 | shipper-regate-task-surface-missing | ausente de entry-decide.mjs (só bash) | Gate 3: corrupção fail-closed :1006-1008; pending sem absolvição :1015-1027 | P (T21) |
| 98 | planner-feature-mismatch-missing | ausente de entry-decide.mjs:95-110 | entry-gate.mjs:944-947 | P (T22, no lote de #78/#88) |
| 99 | fidelity-gates-sniper-and-exact-task | entry-decide.mjs:122, :33-35 | sniper isento (:1058-1064); match por feature (:1080-1082) | A (T23) |
| 100 | reserve-review-attempt-cold-repo-deny | loop-guard.ts:259 → loop-decide.mjs:303-312 | sem contabilidade de reserva antes do Gate 1 | A (repo frio → allow; contabilidade só com cerimônia existente) |
| 101 | dual-substantive-denies-on-hand-dispatch | dual-enforcement.mjs:236/:280/:299/:317/:332/:346/:365 via plan-gate.ts:152 | sem conceito de dual em dispatch | R (T2 ampliado — dual vira gravação) |
| 102 | oc-stale-project-no-signal | version-check.ts (zero `harness-version`) | version-check.mjs:128 emite systemMessage | P (Lote 1b) |
| 103 | legacy-config-migration-design | vendor-core.mjs:503-514; cron-a-dispatch.mjs:582-590/:436-458 | CC re-vendoriza settings? **não — mesmo buraco** (writeSettings :1271-1281 nunca atualiza) | P/A (Lote 1b; lado CC vira item próprio de roadmap) |
| 104 | merge-gate-state-patch-whole-state-validation | gate-state-shape.mjs:445 (único caller vivo: run-hand.mjs:307) | n/a | A (escopar ao delta do patch; item próprio, junto do Lote 1b) |

**Contagem final:** 43 remover · 43 alinhar · 7 portar · 3 manter divergente · 9 já em paridade.
(Antes desta revisão: 36 · 23 · 3 · 1 · 9; a revisão intermediária mediu a superfície Task/dispatch
e chegou a 42 · 38 · 4 · 3 · 9; esta revisão final incorporou o ciclo adversarial de 3d — 9
vereditos novos #96-104, T2 ampliado, T10/T7/T18 corrigidos de mecanismo.)
