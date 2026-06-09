---
name: triaging-requests
description: "Classifies the operator's request into QUICK, LIGHT, or FULL delivery mode — or no ceremony at all — and dispatches accordingly. Runs on the first interaction of every session before any implementation begins."
---

# Triaging-Requests — The entry gate of every session

**This skill classifies and dispatches. It does not plan, implement, or review.**

Announce at start (pt-br): "Analisando o pedido para escolher a cerimônia certa."

All identifiers and reasoning stay in English. Every message to the operator is **pt-br, product-language**.

---

## Pipeline

### Step 1 — Is this a dev/build task?

Ask: does the request require writing, changing, or deleting code or configuration?

**If NO** (question, chat, clarification, reading, review of a document) → **no ceremony**. Answer directly and stop here. Do not force a pipeline onto a conversation.

**If YES** → continue to Step 2.

---

### Step 2 — Classify: QUICK / LIGHT / FULL

Classify only once you have enough clarity. **Ask clarifying questions until ambiguity is gone — do not guess.**

Useful questions (ask only what is still unclear):
- "Tem mais de um arquivo ou módulo envolvido?"
- "Toca em algo relacionado a login, pagamento, banco de dados ou segredos?"
- "É uma correção pontual e óbvia, ou envolve um novo comportamento?"

| Mode | When to pick it |
|---|---|
| **QUICK** | Obvious hotfix. 1–2 files max. No ambiguity. No sensitive path. Scope is completely clear without extra context. |
| **LIGHT** | Small feature. Clear scope. No sensitive domain. May touch several files but the change is bounded and well understood. |
| **FULL** | Multi-file change OR high severity OR touches a sensitive domain (auth, payment, billing, SQL, migrations, `.env*`, `package.json` deps). |

---

### Step 3 — Safety rule: only escalate, never downgrade

When in doubt between two modes, **pick the higher one**.

Any mention of a sensitive domain in the operator's message biases toward FULL. The deterministic override happens later — inside `orchestrating-delivery` when the planner defines `scope_paths` — but this skill pre-escalates so the planner receives the right framing.

Sensitive domains that bias toward FULL:
- Authentication / authorization / sessions / tokens
- Payment / billing / subscriptions
- SQL queries / database migrations
- `.env` files / secrets / API keys
- `package.json` dependency additions or upgrades

---

### Step 4 — Human veto (1 sentence, pt-br, before running QUICK or LIGHT)

Before dispatching a QUICK or LIGHT, present a single short confirmation to the operator — it is the one judgment a non-dev can reliably give (business domain, not code):

Examples:
- QUICK: "Vou tratar como correção simples de 1 arquivo — isso tá tocando em login, pagamento ou algo crítico?"
- LIGHT: "Vou tratar como feature pequena — tem algo relacionado a segurança ou dados sensíveis que eu deva saber antes de começar?"

If the operator flags a sensitive concern → escalate the mode; re-classify and proceed.

---

### Step 5 — Dispatch

| Mode | Action |
|---|---|
| **QUICK** | Implement inline. Commit via skill `committing-changes`. Do **not** invoke `orchestrating-delivery`. |
| **LIGHT** | Invoke skill `orchestrating-delivery` in LIGHT mode. |
| **FULL** | Invoke skill `orchestrating-delivery` in FULL mode. |

---

## Mode examples

**QUICK — "Typo no label do botão de login"**
- 1 file, no logic change, zero ambiguity → inline fix + commit. No orchestrating-delivery.

**QUICK — "Corrigir o regex de validação de CPF que rejeita dígitos finais"**
- 1–2 files, obvious bug, scope 100% clear → inline fix + commit.

**LIGHT — "Adicionar campo de apelido no perfil do usuário"**
- New behaviour, a few files (UI + API + schema), but bounded and no sensitive domain → orchestrating-delivery LIGHT.

**FULL — "Adicionar autenticação via Google OAuth"**
- Mentions auth explicitly → bias FULL immediately.
- Even if scope looked small, sensitive-domain rule forces FULL.

**FULL — "Migrar tabela de pagamentos para novo schema"**
- SQL migration + payment domain → FULL without question.

**FULL — "Adicionar novo pacote de internacionalização"**
- `package.json` dep change → FULL (supply-chain risk, even if feature looks small).

**No ceremony — "Como funciona o fluxo de checkout no sistema?"**
- Question, no code change → answer directly, stop.

---

## What this skill is NOT

- It does not implement anything.
- It does not create a plan.
- It does not review code.
- The deterministic sensitive-path override (comparing `scope_paths` against the allowlist) happens **inside `orchestrating-delivery`** after the planner produces the plan — not here. This skill uses judgment; that step uses determinism.
