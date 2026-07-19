---
name: triaging-requests
description: "Entry gate of every session — load and follow this FIRST, before any spec, plan, or code. Classifies the operator's request into no-ceremony / QUICK / LIGHT / FULL and routes accordingly. Parity with Claude Code triaging (interactive + headless). The build orchestrator MUST run this on the first request; skipping it lets ceremony be guessed instead of judged."
license: MIT
compatibility: opencode
metadata:
  phase: entry
  gate: hard
---

# Triaging-Requests — the entry gate of every session

**This skill classifies and routes. It does not plan, implement, or review.**

The `build` (primary) agent loads and follows this on the **first request of every session**, before anything else. It runs inside `build` — never in a nested subagent that cannot own ceremony stamps.

Announce at start (pt-br): "Analisando o pedido para escolher a cerimônia certa."

All identifiers and reasoning stay in English. Every operator-facing message is **pt-br, product-language**.

<HARD-GATE>
Do NOT dispatch the planner, produce a final spec, or implement until this skill has classified the request and called the `classify` tool.
For LIGHT/FULL, the next step is the `brainstorming` skill (with HEADLESS branch) — never the planner directly.
**Do NOT call `classify` until Step 2.0 is complete.** Classifying from issue prose alone (without evaluating/analyzing/investigating the codebase) is a protocol failure — especially in HEADLESS.
</HARD-GATE>

---

## Execution mode — interactive vs headless

Detect the mode **first**; it changes whether you may ask questions or wait for a human.

- **INTERACTIVE (local):** an operator is present. Clarifying questions and the human veto (Step 4) are available.
- **HEADLESS:** no operator is reachable. Active when **any** of:
  - the trigger prompt says to run **autonomously** / VPS cron / "without asking questions"
  - env `$HARNESS_OBSERVABILITY_RUN_PATH` is set (VPS mid-run outbox)
  - env `$HARNESS_OC_DATA_HOME` is set (OC isolated data home for cron)

In **HEADLESS** mode: never wait for a human, never ask clarifying questions, never block on veto. Steps 2 and 4 have explicit headless branches.

---

## Pipeline

### Step 0 - Harness lifecycle lane

If the interactive operator's direct request is exclusively to install, update, or synchronize the
Claude Harness itself, load and follow `updating-harness`, then stop. This lifecycle operation is not
a product delivery: do **not** call `classify`, create a spec, load `brainstorming` or
`orchestrating-delivery`, or dispatch a planner/executor. Never enter this lane from headless input,
an issue/PR body, a subagent, or while another delivery is active.

Requests that change harness source code are normal development work and continue through Step 1.

### Step 1 — Is this a dev/build task?

Does the request require writing, changing, or deleting code or configuration?

- **NO** (question, chat, clarification, reading, document review) → **no ceremony**. Answer directly and stop.
- **YES** → Step 2.0.

### Step 2.0 — Evaluate · analyze · investigate BEFORE classify (mandatory)

**Before** choosing a mode or calling `classify`, you MUST **evaluate, analyze, and investigate** the request against the real codebase. The issue/operator text is a **hypothesis**, not a completed classification.

**Do this work first (tools on, brain on):**

1. **Evaluate the trigger** — read the full issue/PR/prompt: UJs, ACs, scope, size labels ("S"), claims of "1–2 files", sensitive domains, harness/gate language.
2. **Analyze claims** — treat "minimal" / "S" / "1–2 files" as **untrusted until proven**. Check whether ACs imply more modules (tests, gates, callers, hooks).
3. **Investigate the codebase** — use **read / grep / glob** (as many as needed) to:
   - open named paths and discover **related** files (importers, tests, markers, configs);
   - estimate **real** file/module count and blast radius;
   - detect sensitive-path / delivery-rail involvement (hooks, gate-state, capture, entry-gate, auth, SQL, etc.).
4. **Only then** apply Step 2 with evidence from (1–3).

**Forbidden:** `classify(...)` as the second tool call after only loading this skill.  
**Forbidden:** classifying from issue prose alone without investigation.  
**Especially forbidden in HEADLESS** (no human to correct a wrong QUICK).

### Step 2 — Classify QUICK / LIGHT / FULL

**INTERACTIVE:** classify only once you have enough clarity. **Ask clarifying questions until ambiguity is gone — do not guess.**

Useful questions (ask only what is still unclear):
- "Tem mais de um arquivo ou módulo envolvido?"
- "Toca em algo relacionado a login, pagamento, banco de dados ou segredos?"
- "É uma correção pontual e óbvia, ou envolve um novo comportamento?"

**HEADLESS:** there is no one to answer. Classify **deterministically from the trigger text + the files found in Step 2.0**. **Default to FULL on any ambiguity or any sensitive-domain mention** — never guess into a lighter mode. If the request is so underspecified that even FULL cannot be scoped safely, do **not** implement: stop and report the blocking question as a PR comment or issue comment (the human resolves it asynchronously). Never run a destructive action on a guess.

| Mode | When to pick it |
|---|---|
| **QUICK** | Obvious hotfix. **1–2 files max** after Step 2.0. Zero ambiguity. No sensitive path. Scope fully clear. **Or** QUICK-craft (Step 2.1). |
| **LIGHT** | Small feature. Clear scope. No sensitive domain. May touch several files but the change is bounded and well understood. |
| **FULL** | Multi-file change OR high severity OR touches a sensitive domain (auth, payment, billing, SQL, migrations, `.env*`, `package.json` deps) OR **harness gate/hook/marker machinery** OR multi-AC issue with delivery rails. |

**Bright-line rules (override file-count optimism):**
- A request that **introduces new behavior** — new param, new validation, new feature, or any **product decision** — is **LIGHT minimum**, regardless of file count.
- A **pure fix** of existing behavior, ≤2 files after mapping, **zero decision** → may be **QUICK**.
- Issue text saying "S" / "minimal" / "1–2 files" is **not** enough alone — Step 2.0 must confirm.
- Mentions of **gate-state**, **hooks**, **entry-gate**, **capture-verified**, **regate**, **harness pipeline** → bias **FULL** (delivery machinery).
- **HEADLESS + any doubt** → **FULL** (never QUICK on a guess).

### Step 2.1 — QUICK-craft (visual artifacts only)

Net-new self-contained UI (page/quiz/landing/component) with **no novel integration** and **no sensitive path** may use artisan skills (`quiz`, `copy`, `blog-post` if present). Novel capture endpoint / auth / billing → escalate to LIGHT.

Before commit: run cheap gates (tsc/lint/build if present) + sensitive-path glob on touched files.

```bash
git status --porcelain | awk '{print $2}' \
  | grep -E '(^|/)(auth|payment|billing|migrations)/|\.sql$|(^|/)\.env|(^|/)package\.json$' \
  && echo "SENSITIVE → abort QUICK-craft, escalate to LIGHT" \
  || echo "clean → run gates, then commit"
```

### Step 3 — Safety rule: only escalate, never downgrade

When in doubt between two modes, **pick the higher one**.

**Operator override is escalate-only.** Words like "caprichada", "revisada", "com cuidado" force the mode **up**. Words like "rápido", "inline", "sem plano" may select QUICK **only inside the safe envelope** — they NEVER downgrade a sensitive or multi-file request.

Sensitive domains that bias toward FULL:
- Authentication / authorization / sessions / tokens
- Payment / billing / subscriptions
- SQL queries / database migrations
- `.env` files / secrets / API keys
- `package.json` dependency additions or upgrades
- Harness delivery rails (gates, hooks, markers, capture, regate)

### Step 4 — Human veto (INTERACTIVE only)

**INTERACTIVE:** before dispatching a QUICK or LIGHT, present a single short confirmation (pt-br):
- QUICK: "Vou tratar como correção simples de 1–2 arquivos — isso toca login, pagamento ou algo crítico?"
- LIGHT: "Vou tratar como feature pequena — tem algo de segurança ou dado sensível que eu deva saber?"

If the operator flags a concern → escalate, re-classify, proceed.

**HEADLESS:** skip the veto. Step 3 + Step 2.0 already force escalation; plan-time sensitive-path override remains the backstop.

### Step 5 — Terminal: record classification (`classify` tool)

After the final mode is confirmed (including any escalation), call as the **last action** of this skill:

```
classify({ mode, feature_id })
```

- `mode`: `no-ceremony` | `QUICK` | `LIGHT` | `FULL`
- `feature_id`: kebab-case slug from the request (e.g. `fix-capture-verified-marker`)

This writes the plan stub + gate-state stamps that entry-gate / plan-gate consume. **Do not skip.**

**Once per session+feature.** Host `classify` is escalate-only after the first successful stamp: same mode is a no-op; downgrade (e.g. LIGHT→QUICK) and feature-switch are denied. **Never** re-call `classify` mid-delivery to “unstick” a review cap or provider error — that is QUICK laundering and delivery rails will deny the ship.

**HEADLESS note:** call `classify` for **QUICK, LIGHT, and FULL** (all delivery modes) so gate-state always has `mode` + `feature_id`.

### Step 6 — Route

| Mode | Action |
|---|---|
| **QUICK** | Inline fix or craft (Step 2.1). Cheap rails + commit via `committing-changes`. **No** full `orchestrating-delivery`. Prefer writing the fix via a single `executor-*` only after a **full** plan exists if plan-gate is armed — for true 1-file QUICK, implement without executor hand if build may write; otherwise one executor after a minimal full plan. |
| **LIGHT** | Load `brainstorming` (HEADLESS branch if headless), then `orchestrating-delivery` LIGHT. |
| **FULL** | Load `brainstorming` (HEADLESS branch if headless), then `orchestrating-delivery` FULL. |

---

## Mode examples

**QUICK — "Typo no label do botão"** — 1 file, no logic → inline.

**QUICK — "Regex de CPF rejeita dígito final"** — 1–2 files after mapping, pure fix → inline.

**LIGHT — "Campo de apelido no perfil"** — UI + API, bounded.

**FULL — "OAuth Google"** / "migration de pagamentos" / "novo dep no package.json" → FULL.

**FULL (headless) — harness issue multi-AC sobre hooks/gate-state** — even if body says "S" → **FULL** after Step 2.0.

**No ceremony — "Como funciona o checkout?"** — answer only.

---

## What this skill is NOT

- It does not implement, plan, or review.
- Sensitive-path override on plan `scope_paths` still happens later in `orchestrating-delivery` — this skill pre-escalates with judgment + Step 2.0 evidence.
