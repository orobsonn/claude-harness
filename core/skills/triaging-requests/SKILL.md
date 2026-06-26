---
name: triaging-requests
description: "Classifies the operator's request into QUICK (fix or craft), LIGHT, or FULL delivery mode — or no ceremony at all — and dispatches accordingly. QUICK-craft is the fast lane for self-contained visual artifacts (page/quiz/landing) routed to an artisan skill. Runs on the first interaction of every session before any implementation begins."
---

# Triaging-Requests — The entry gate of every session

**This skill classifies and dispatches. It does not plan, implement, or review.**

Announce at start (pt-br): "Analisando o pedido para escolher a cerimônia certa."

All identifiers and reasoning stay in English. Every message to the operator is **pt-br, product-language**.

---

## Execution mode — interactive vs headless

Detect the mode **first**; it changes whether you may ask questions or wait for a human.

- **INTERACTIVE (local):** an operator is present. Default. Clarifying questions and the human veto (Step 4) are available.
- **HEADLESS (cloud routine):** no operator is reachable. Active when the session is a cloud routine (env `$CLAUDE_CODE_REMOTE` is set / `claude-code-on-the-web`) **or** the trigger prompt explicitly says to run autonomously. Confirm with a quick `echo "$CLAUDE_CODE_REMOTE"` if unsure.

In **HEADLESS** mode the golden rules apply (see the root `CLAUDE.md`): never `AskUserQuestion`, never plan-mode, never wait for a human. Steps 2 and 4 below have an explicit headless branch.

---

## Pipeline

### Step 1 — Is this a dev/build task?

Ask: does the request require writing, changing, or deleting code or configuration?

**If NO** (question, chat, clarification, reading, review of a document) → **no ceremony**. Answer directly and stop here. Do not force a pipeline onto a conversation.

**If YES** → continue to Step 2.

---

### Step 2 — Classify: QUICK / LIGHT / FULL

**INTERACTIVE:** classify only once you have enough clarity. **Ask clarifying questions until ambiguity is gone — do not guess.**

Useful questions (ask only what is still unclear):
- "Tem mais de um arquivo ou módulo envolvido?"
- "Toca em algo relacionado a login, pagamento, banco de dados ou segredos?"
- "É uma correção pontual e óbvia, ou envolve um novo comportamento?"

**HEADLESS:** there is no one to answer. Classify **deterministically from the trigger text** (the issue/PR body or routine prompt). **Default to FULL on any ambiguity or any sensitive-domain mention** — never guess into a lighter mode. If the request is so underspecified that even FULL cannot be scoped safely, do **not** proceed: stop and report the blocking question as a PR comment or a new issue (the human resolves it asynchronously). Never run a destructive action on a guess.

| Mode | When to pick it |
|---|---|
| **QUICK** | Inline, no `orchestrating-delivery`. Two entry shapes: **`fix`** — obvious hotfix, 1–2 files, no sensitive path, scope fully clear. **`craft`** — net-new self-contained **visual artifact** (page, quiz, landing, component, static section) routed to an artisan skill; no novel integration, no sensitive path, any file count. See **Step 2.1**. |
| **LIGHT** | Small feature. Clear scope. No sensitive domain. May touch several files but the change is bounded and well understood. |
| **FULL** | Multi-file change OR high severity OR touches a sensitive domain (auth, payment, billing, SQL, migrations, `.env*`, `package.json` deps). |

---

### Step 2.1 — QUICK-craft: the fast lane for self-contained visual artifacts

A net-new **visual artifact** (page, quiz, landing, component, static section) carries near-zero *integration* risk — the heavy pipeline (executor → compliance → adversary → sniper) exists for integration risk, so forcing it here is pure friction. The real review of one visual artifact is the operator looking at it in the browser, not four LLM agents.

**Enter `QUICK-craft` only when ALL hold:**
- Net-new, self-contained UI artifact — deletable without breaking the existing system.
- Routed to an **artisan skill** (`quiz`, `copy`, `blog-post`) or an inline UI build.
- **No novel integration:** does not wire into existing auth/session, payment/billing, SQL/DB writes, or existing business-logic modules; does not add or upgrade a dependency.
- **No sensitive path** (the allowlist below).

**Lead capture (known-pattern rule).** Quizzes/landings capture leads (PII → endpoint + tracking pixel) — that *is* the product. When the capture uses the **pattern already baked into the artisan skill** (its standard endpoint + pixel), it is **pre-vetted** — the security review was done once when the skill was authored — and stays in `QUICK-craft`. A **novel or custom** capture target (a new endpoint, a different integration) is novel integration → **escalate to LIGHT** (which runs the `security` agent).

**Dispatch:** route to the matching artisan skill (or build inline), then **before commit** run the two cheap deterministic rails, then commit via `committing-changes`. Do **not** invoke `orchestrating-delivery`.

**Rail 1 — cheap gates (deterministic, no LLM).** Run the project's cheap gates on the produced files where they exist: `tsc --noEmit`, lint, and the build. This catches the #1 failure of hand-built pages — a broken import or a typo — that the artisan skills only "test mentally."

**Rail 2 — sensitive-path glob (deterministic).** This replaces the planner's `scope_paths` override (there is no planner in QUICK). Glob the touched + untracked files against the sensitive-path allowlist; **any match aborts the fast lane and escalates to LIGHT.**

```bash
git status --porcelain | awk '{print $2}' \
  | grep -E '(^|/)(auth|payment|billing|migrations)/|\.sql$|(^|/)\.env|(^|/)package\.json$' \
  && echo "SENSITIVE → abort QUICK-craft, escalate to LIGHT" \
  || echo "clean → run gates, then commit"
```

Allowlist (same as the planner override): `**/auth/**`, `**/payment/**`, `**/billing/**`, `**/*.sql`, `**/migrations/**`, `**/.env*`, `**/package.json` (deps).

**Escalate-out (mid-build):** if the artifact turns out to need integration beyond its frozen template, stop the fast lane and re-classify as LIGHT.

**Known limit:** detecting a *novel endpoint* relies on entry judgment + an explicit signal in the request, not a deterministic network allowlist — Rail 2 only catches sensitive **file paths**. If a request names a new/custom capture target, treat it as novel integration.

---

### Step 3 — Safety rule: only escalate, never downgrade

When in doubt between two modes, **pick the higher one**.

**Operator override is escalate-only.** Words like "caprichada", "revisada", "com cuidado" always force the mode **up** (e.g. to LIGHT) — escalation is always safe. Words like "rápido", "inline", "sem plano" may select `QUICK-craft` **only inside the safe envelope** (Step 2.1) — they NEVER downgrade a request that hits a sensitive path or a novel integration. "rápido" is a tone word, not consent to skip security; the operator is non-technical and trusts the system to hold this line.

Any mention of a sensitive domain in the operator's message biases toward FULL. The deterministic override happens later — inside `orchestrating-delivery` when the planner defines `scope_paths` — but this skill pre-escalates so the planner receives the right framing.

Sensitive domains that bias toward FULL:
- Authentication / authorization / sessions / tokens
- Payment / billing / subscriptions
- SQL queries / database migrations
- `.env` files / secrets / API keys
- `package.json` dependency additions or upgrades

---

### Step 4 — Human veto (INTERACTIVE only)

**INTERACTIVE:** before dispatching a QUICK or LIGHT, present a single short confirmation to the operator — it is the one judgment a non-dev can reliably give (business domain, not code):

Examples:
- QUICK: "Vou tratar como correção simples de 1 arquivo — isso tá tocando em login, pagamento ou algo crítico?"
- LIGHT: "Vou tratar como feature pequena — tem algo relacionado a segurança ou dados sensíveis que eu deva saber antes de começar?"

If the operator flags a sensitive concern → escalate the mode; re-classify and proceed.

**HEADLESS:** skip the veto entirely (no human to answer). The Step 3 safety rule already pre-escalated; the deterministic sensitive-path override inside `orchestrating-delivery` is the backstop.

---

### Step 5 — Execute classify.mjs (before delivery dispatch)

**Run classify.mjs BEFORE invoking orchestrating-delivery — the entry gate denies any delivery dispatch until triage.json exists.**

For **LIGHT** and **FULL** modes only (QUICK does not gate on triage state):

Run the triaging marker to stamp the chosen mode and feature_id into the gate's precondition state. Execute:

```bash
node .claude/hooks/classify.mjs --mode <MODE> --feature-id <feature-id>
```

Where:
- `<MODE>` is the mode chosen in Step 2 (`LIGHT` or `FULL`)
- `<feature-id>` is a kebab-case identifier derived from the feature name (e.g. `user-auth`, `checkout-flow`, `audit-logging`)

This command outputs a JSON stamp that the PostToolUse hook (session context, not model-visible) recognizes and writes to `.claude/plans/.state/<session_id>/triage.json`. It is the gate's record of what was triaged.

---

### Step 6 — Dispatch

| Mode | Action |
|---|---|
| **QUICK** | Implement inline (`fix`) or route to the artisan skill (`craft` — see Step 2.1). Run the cheap rails (gates + sensitive-path glob) before commit; any sensitive-path hit escalates to LIGHT. Commit via skill `committing-changes`. Do **not** invoke `orchestrating-delivery`. |
| **LIGHT** | Invoke skill `orchestrating-delivery` in LIGHT mode. |
| **FULL** | Invoke skill `orchestrating-delivery` in FULL mode. |

---

## Mode examples

**QUICK — "Typo no label do botão de login"**
- 1 file, no logic change, zero ambiguity → inline fix + commit. No orchestrating-delivery.

**QUICK — "Corrigir o regex de validação de CPF que rejeita dígitos finais"**
- 1–2 files, obvious bug, scope 100% clear → inline fix + commit.

**QUICK-craft — "Cria uma landing pro lançamento" / "Faz um quiz de diagnóstico"**
- Net-new self-contained visual artifact, capture no padrão do skill → route to `copy`/`quiz`, run cheap gates + sensitive-path glob, commit. No orchestrating-delivery.

**LIGHT (escalated from craft) — "Faz um quiz que salva o lead num endpoint novo da API X"**
- Novel capture target = novel integration → leaves the fast lane, LIGHT with the `security` agent.

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
