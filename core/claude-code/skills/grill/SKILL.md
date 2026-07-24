---
name: grill
description: "Pre-implementation interview — turns an idea that is still a shadow into a written PRD at docs/prd/<slug>.md through relentless, one-at-a-time, consequence-framed questioning, then hands off to creating-issues. Runs BEFORE the delivery pipeline (before triage, before any plan) and is LOCAL/interactive only — it refuses in any headless or cron session. Suggest it when the operator arrives with a big or vague idea and there is no written spec yet. It is NOT the session entry gate (triaging-requests owns that) and its output is NOT a source of truth."
---

# Grill — interrogate an idea until it becomes a PRD

The operator shows up with an idea that only exists in his head. This skill turns it into a
**written PRD** by asking questions until nothing that could change a requirement is still open.

Announce at start (pt-br): "Vou te entrevistar até essa ideia virar um PRD."

All reasoning and identifiers stay in English. Every message to the operator is **pt-br,
product-language**. The PRD section headings are pt-br on purpose — the PRD is an operator-facing
artifact.

---

## Where this sits — and what it is not

- **Before the pipeline.** It runs *before* triage, before any spec, before any plan. Its output is
  the input the pipeline later consumes.
- **NOT the entry gate.** `triaging-requests` owns the first action of every session. This skill
  never claims that slot, never says "run me first", never stamps a marker, never calls
  `classify.mjs` or `mark.mjs`, and gates nothing. It is entered only when the operator asks for it
  or accepts a suggestion to use it.
- **NOT a source of truth.** *(the single most important line in this file)* Everything the grill
  produces enters the pipeline later as **ordinary input** — issue text. It is fully attackable and
  re-questionable by the planner, `plan-reviewer`, `adversary`, and `compliance` downstream. **Never
  record grill output as a "locked decision" that downstream roles are obliged to defend.** That
  status belongs to `brainstorming`'s in-pipeline elicitation, not to this interview. A PRD that
  downstream cannot contradict would launder an unreviewed conversation into an unfalsifiable
  constraint.
- **It does not build.** The session ends at issue creation.

---

## Hard precondition — LOCAL only, never headless

An interview *blocks on a question*. In a headless run there is no one to answer, and ending the
turn on a question kills the run. So: **if the session is not interactive, refuse immediately and
say why.**

Check the **union** signal (mirrors `isRoutineSession()` in `core/claude-code/hooks/entry-gate.mjs`):

```bash
printf 'remote=%s notify=%s obs=%s\n' \
  "$CLAUDE_CODE_REMOTE" "$HARNESS_NOTIFY_PROJECT" "$HARNESS_OBSERVABILITY_RUN_PATH"
```

**Any** of the three non-empty → headless → refuse.

> `$CLAUDE_CODE_REMOTE` alone is **not** a sufficient test. The VPS cron dispatcher
> (`core/vps/cron-a-dispatch.mjs`) **deliberately unsets it** so the run stays "headless-local" and
> the cheap hands stay enabled. A skill that keyed only on that variable would happily start an
> interview inside a fully autonomous fleet run.

Also refuse when:
- the trigger prompt says to run **autonomously** / "sem perguntar" / "without asking" (the cron
  dispatcher always prepends a fixed prefix of this shape); or
- you were spawned as a **hand or subagent** with a task brief (executor / sniper / test-author /
  any agent dispatch) — the grill only ever runs in a top-level operator session.

Refusal (pt-br, then stop — do not fall back to "interviewing yourself"):

> "Essa entrevista só funciona com você do outro lado respondendo. Esta sessão é automática, então
> não dá pra rodar aqui. Rode o grill localmente e a issue que sair dele entra na fila normal."

---

## No state, anywhere, except the PRD

The **only** artifact is `docs/prd/<slug>.md`. No `.claude/` state, no session markers, no gate
stamps, no resume file, no decision ledger. Resuming a multi-session grill means **re-reading the
PRD's own `## Em aberto` section** and continuing from there — the file is the memory.

---

## The interview

### 1. Fact vs decision — research facts, ask only judgments

- **Researchable → research it yourself.** Anything answerable from the codebase, the project docs,
  or the web: read it, grep it, fetch it. **Never** spend a question on it. Operator attention is
  the scarce resource.
- **Non-codifiable operator judgment → ask it.** What the product should do, who it is for, what is
  acceptable to lose, what "done" means, what is out of scope.

Everything you derived by yourself goes into the PRD under **`## Suposições do modelo`**, in a
clearly separate block — **never** mixed with `## Decisões travadas`. Wrong research must stay
visible so the operator (and the adversary downstream) can knock it over. Laundering a guess into
"what the operator decided" is the failure this separation exists to prevent.

### 2. One question at a time

Never batch. Multiple questions in one message is bewildering and the operator answers only the
last one — so the rest get silently invented by you later.

### 3. Consequence framing (mandatory)

The operator is a **product / tech-lead persona, not a developer** (see the root `CLAUDE.md`
§ Operator profile). Every question must state, in product terms, what changes for the user or the
business on each branch.

| Forbidden (engineering) | Required (consequence) |
|---|---|
| "Usa fila ou processa síncrono?" | "Se o envio demorar 30s, prefere segurar o usuário na tela ou avisar por e-mail depois?" |
| "Estado no servidor ou no localStorage?" | "Se ele fechar a aba no meio do formulário, prefere perder o lead ou salvar o parcial e retomar depois?" |
| "Soft delete ou hard delete?" | "Quando o cliente apaga a conta, você ainda precisa dos dados dele pra cobrança ou some tudo?" |

**Questions that require ranking architectures are forbidden.** If a branch is architectural,
reframe it as the outcome the operator can actually rule on (see § Architectural forks).

### 4. Exhaustion scaled to risk

- Small, reversible, cheap to change later → a handful of questions is enough. Stop.
- **Money, login/auth, user data, anything irreversible** → keep going until every branch that
  could change a requirement is closed.

Rationale, stated so it is not mistaken for laziness: **the binding constraint is operator fatigue,
not model capability.** You could always ask twenty more questions. A gate the human learns to
rubber-stamp is worse than no gate — so spend the question budget where a wrong answer is expensive
to reverse, and spend almost none where it is not.

### 5. Dependency ordering — walk the tree, not a checklist

Answer N changes which questions N+1..M **even exist**. Never run a flat pre-written list: after
each answer, recompute what is still open, drop the questions the answer just made irrelevant, and
add the ones it just created.

### 6. Project glossary

If a `CONTEXT.md` exists at the repo root, read it and use its terms **verbatim** in your questions
and in the PRD. Do not invent parallel vocabulary; do not create the file.

### 7. Adversary mid-interview

You **may** attack the requirements while they are still forming — this is cheaper here than after
the code exists.

**Never dispatch the `adversary` agent here.** `adversary` is a delivery role: entry-gate Gate 1
denies any delivery-agent dispatch until a triage exists with mode LIGHT|FULL, and its deny message
tells you to classify — the exact ceremony this skill promises never to create. Dispatch a
**`general-purpose` agent with an explicit devil's-advocate brief** instead (read-only, no ceremony,
not gated). Also run a read-only **risk lens** over the codebase: *"does this break what already
exists?"* — importers, existing flows, data already stored.

Turn each surviving finding into either a new question for the operator (if it is a product
judgment) or a line under `## Riscos conhecidos` (if it is a technical risk to carry forward).

### 8. Architectural forks

When a branch is an architecture decision that is expensive to reverse, you **may** fan out
independent designers (blind to each other) and have the adversary attack their alternatives.

**What reaches the operator is ONE recommendation plus the product-level tradeoff he can actually
rule on.** Never present N architectures for the operator to choose between — that is handing an
engineering decision to someone who cannot evaluate it, and the "choice" becomes a coin flip you
will later cite as his decision.

---

## The PRD contract

Path: **`docs/prd/<slug>.md`** (`<slug>` kebab-case). Write it with `Write`. Sections, in this
exact order:

```markdown
# <título>

- **slug:** <kebab-case>
- **status:** rascunho | pronto | substituído
- **criado:** YYYY-MM-DD · **atualizado:** YYYY-MM-DD

## Problema
## Quem se beneficia
## Requisitos            <- numerados, verificáveis; viram os critérios de aceite das issues
## Decisões travadas     <- o que o operador decidiu, com o porquê
## Suposições do modelo  <- o que o modelo deduziu sozinho; ATACÁVEL, não é decisão do operador
## Em aberto             <- perguntas não resolvidas; é daqui que uma próxima sessão retoma
## Fora de escopo
## Riscos conhecidos     <- saída do adversário, se rodou
```

Use `date +%F` for the dates. `status: rascunho` while `## Em aberto` is non-empty; `pronto` only
when it is empty or holds nothing that could still change a requirement.

**`## Requisitos` is the load-bearing section.** `creating-issues` converts each numbered
requirement into an `#ac-N.M` acceptance criterion, and those become the pipeline's `locked_tests`.
So each requirement must assert an **observable effect with a concrete value** — a response body, a
persisted state, an emitted error, a rendered outcome — never "funciona bem" or "é rápido". Vague
here means the whole pipeline aims at the wrong target.

---

## Handoff

1. Write the PRD.
2. Show the operator the `## Requisitos`, `## Suposições do modelo` and `## Em aberto` sections in
   pt-br and ask if anything is wrong. Fix and rewrite the file if so.
3. Invoke the `creating-issues` skill with the PRD as its input — same session.

**One feature per session is enforced downstream** (`core/shared/lib/classify-stub.mjs` denies a
feature switch once a session has classified). So the grill session **stops at issue creation** —
it does not implement. Building happens in a fresh session, entered normally through
`triaging-requests`.

---

## Done when

- `docs/prd/<slug>.md` exists with all nine sections, the model's own deductions isolated under
  `## Suposições do modelo`, and requirements that are observable and verifiable.
- Every branch that could change a requirement is either closed or explicitly parked under
  `## Em aberto`.
- The issue(s) are created via `creating-issues`.
