---
name: triaging-requests
description: "Entry gate of every session — load and follow this FIRST, before any spec, plan, or code. Classifies the operator's request into no-ceremony / QUICK / LIGHT / FULL and routes accordingly. The build orchestrator MUST run this on the first request; skipping it lets ceremony be guessed instead of judged."
license: MIT
compatibility: opencode
metadata:
  phase: entry
  gate: hard
---

# Triaging-Requests — the entry gate of every session

**This skill classifies and routes. It does not plan, implement, or review.**

The `build` (primary) agent loads and follows this on the **first request of every session**, before anything else. It runs inside `build` (it asks the operator and waits) — never in a headless subagent.

Announce at start (pt-br): "Analisando o pedido para escolher a cerimônia certa."

All identifiers and reasoning stay in English. Every operator-facing message is **pt-br, product-language**.

<HARD-GATE>
Do NOT dispatch the planner, produce a spec, or write code until this skill has classified the request. For LIGHT/FULL, the next step is the `brainstorming` skill — never the planner directly.
</HARD-GATE>

---

## Pipeline

### Step 1 — Is this a dev/build task?

Does the request require writing, changing, or deleting code or configuration?

- **NO** (question, chat, clarification, reading, document review) → **no ceremony**. Answer directly and stop. Do not force a pipeline onto a conversation.
- **YES** → Step 2.

### Step 2 — Classify QUICK / LIGHT / FULL

Classify only once you have clarity. **Ask clarifying questions until ambiguity is gone — do not guess.** Useful (ask only what is unclear): "Mais de um arquivo/módulo?" · "Toca login, pagamento, banco ou segredos?" · "Correção pontual e óbvia, ou novo comportamento?"

| Mode | When to pick it |
|---|---|
| **QUICK** | Obvious hotfix. 1–2 files max. Zero ambiguity. No sensitive path. Scope fully clear without extra context. |
| **LIGHT** | Small feature. Clear scope. No sensitive domain. May touch several files but the change is bounded and well understood. |
| **FULL** | Multi-file change OR high severity OR touches a sensitive domain (auth, payment, billing, SQL, migrations, `.env*`, `package.json` deps). |

**Bright-line rule (overrides file count):**
- A request that **introduces new behavior** — new param, new validation, new feature, or any **product decision** — is **LIGHT minimum**, regardless of file count.
- A **pure fix** of existing behavior, ≤2 files, **zero decision** → may be **QUICK**.

### Step 3 — Safety rule: only escalate, never downgrade

When in doubt between two modes, **pick the higher one**. Any mention of a sensitive domain biases toward **FULL**. The deterministic override happens later (the `build` loop compares `scope_paths` against the allowlist) — this skill pre-escalates so the framing is right.

Sensitive domains that bias toward FULL: authentication/authorization/sessions/tokens · payment/billing/subscriptions · SQL/migrations · `.env`/secrets/API keys · `package.json` dep add/upgrade.

### Step 4 — Human veto (1 short pt-br sentence, before QUICK or LIGHT)

Present a single short confirmation — the one judgment a non-dev gives reliably (business domain, not code):
- QUICK: "Vou tratar como correção simples de 1 arquivo — isso toca login, pagamento ou algo crítico?"
- LIGHT: "Vou tratar como feature pequena — tem algo de segurança ou dado sensível que eu deva saber antes?"

If the operator flags a concern → escalate the mode, re-classify, proceed.

### Step 5 — Route

| Mode | Action |
|---|---|
| **QUICK** | `build` implements inline (single executor dispatch + gates), commits via `committing-changes`. **No** brainstorming, no planner, no full loop. |
| **LIGHT** | `build` proceeds to the **`brainstorming` skill**, then the LIGHT loop. |
| **FULL** | `build` proceeds to the **`brainstorming` skill**, then the FULL loop. |

### Step 6 — Terminal: record classification artifact

After the final mode is confirmed (including any escalation from Step 4), call as the **last action** of this skill:

```
classify({ mode, feature_id })
```

- `mode`: the final classified value — `no-ceremony`, `QUICK`, `LIGHT`, or `FULL`.
- `feature_id`: a kebab-case slug derived from the operator's request (e.g., `"fix-cpf-regex"`, `"add-nickname-field"`). Derive the most descriptive slug from the request; confirm with the operator only if the subject is genuinely ambiguous.

The entry-gate and plan-gate depend on this runtime artifact. Do not skip.

---

## What this skill is NOT

- It does not implement, plan, or review.
- The deterministic sensitive-path override (comparing `scope_paths` against the allowlist) happens **inside the `build` loop** after the planner produces the plan — not here. This skill uses judgment; that step uses determinism.
