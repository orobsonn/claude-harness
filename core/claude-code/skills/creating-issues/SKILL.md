---
name: creating-issues
description: "Authors well-formed harness issue(s) — a single issue or a dependency-ordered roadmap — from the operator's conversation, from a PRD written by grill (docs/prd/<slug>.md), or from a deepening candidate written by proposing-deepening (docs/architecture/deepening-candidates.md). Applies the small-delivery-unit sizing rule, coaches VERIFIABLE acceptance criteria (the locked_tests derive from them), keeps model assumptions attackable and blocks on open questions, wires harness-deps for order, creates issues harness:ready EXCEPT retrofit issues (local-only, unlabelled, never auto-merged), and runs the DAG lint. Use when the operator wants to create an issue or organize a roadmap."
---

# Creating-Issues — author the pipeline's highest-leverage input

The issue is the **last high-bandwidth human control point**: once it is created, the engine runs
plan → build → review → merge end-to-end with no human touching the work again (under auto-merge the
PR review is post-merge). A few minutes getting the acceptance criteria, scope, size, and
dependencies right decides whether an autonomous run produces gold or burns a whole cycle on garbage
you only discover at the PR. This skill makes that authoring excellent.

**The STANDARD lives in `rules/creating-issues.md` — this skill is the PROCEDURE that applies it.
One source of truth: read that rule, do not restate it here.**

Announce at start (pt-br): "Vou montar a(s) issue(s) no padrão do harness."

All identifiers/reasoning in English. Every message to the operator is **pt-br, product-language**
(what ships, what's verifiable) — never engineering.

## When to use

- The operator wants to create an issue, or organize a **roadmap** (several ordered/related issues).
- Invoked directly (`/creating-issues`), by `grill` at the end of a PRD interview, or when the
  entry-gate advisory nudges toward the form.
- NOT for triaging an already-existing request into a delivery mode — that is `triaging-requests`.

## Interactive vs headless

- **INTERACTIVE (local):** ask the clarifying questions below before creating anything.
- **HEADLESS (cloud):** never `AskUserQuestion`; derive from the trigger prompt, proceed, and record
  any unresolved question inside the issue body rather than blocking.

## Input: a conversation, a PRD from `grill`, or a deepening candidate

The source is the operator's conversation, a **PRD at `docs/prd/<slug>.md`** written by `grill`, or a
**deepening candidate** at `docs/architecture/deepening-candidates.md` written by
`proposing-deepening`. With a written source, do not re-interview and do not re-derive its content —
map it:

| PRD section | Where it lands |
|---|---|
| `## Requisitos` | the `#ac-N.M` acceptance criteria |
| `## Quem se beneficia` | the `#uj-N` user journeys |
| `## Problema` | the issue summary — the context and why it matters |
| `## Fora de escopo` | the explicit non-goals in `scope` ("must NOT touch / must NOT do") |
| `## Riscos conhecidos` | informs `sensitive` and `priority` |
| `## Decisões travadas` | issue body — constraints the implementation must respect |
| `## Suposições do modelo` | issue body — labelled as **assumptions**, never as decisions |
| `## Em aberto` | **blocks** the dependent slice — see below |

The other structured source is a **deepening candidate** at `docs/architecture/deepening-candidates.md`,
written by `proposing-deepening`. It maps the same way, with two non-negotiable differences:

| Candidate field | Where it lands |
|---|---|
| `o que fica mais fácil e pra quem` | the `#uj-N` user journeys |
| `sintoma` + `não fazer nada` | the issue summary — context and why it matters |
| `fatias` | **one issue per slice**, ordered with `harness-deps` |
| `oráculo independente` | the `#ac-N.M` criteria — the oracle IS the verification |
| `rota: FULL-equivalente` | `size` + a careful-review / security note, even when `sensível: não` |
| every other candidate field | `Suposições do modelo (atacáveis)` — **never** `Decisões travadas` |

1. **A candidate is 100% model deduction**, so ALL of it is an assumption. The only locked decision is
   the operator's "sim, vale reformar isso" — a decision to do the work, never a decision about how.
2. **A retrofit issue is created WITHOUT `harness:ready`** — see § Retrofit issues are local-only.

**Requirement → AC traceability.** PRD requirement `N` becomes `#ac-N.M`. Keep the PRD's numbering so
every criterion traces back to one requirement, and name the source PRD (`docs/prd/<slug>.md`) in the
issue body. The requirements were already authored to be observable and verifiable — carry them across
in substance, do not re-invent or re-word them into something vaguer. Split one requirement into
several `#ac-N.M` only when it asserts more than one observable effect.

**Decisions and assumptions are TWO blocks, never one.** `## Decisões travadas` are the operator's
rulings: downstream the `adversary` DEFENDS them. `## Suposições do modelo` are the model's own
deductions: the adversary must stay FREE TO ATTACK them. Write both into the issue body, each under
its own explicit label:

```
Decisões travadas (do operador — respeitar):
- ...

Suposições do modelo (deduzidas pelo modelo, NÃO decididas pelo operador — atacáveis):
- ...
```

Collapsing them into one list is the specific failure this handoff exists to prevent — it launders a
guess into a constraint nobody downstream is allowed to challenge.

**`## Em aberto` blocks issue creation for whatever depends on it.** An unresolved open question is a
decision the autonomous engine would otherwise invent at 3am and merge unsupervised. For every
requirement that depends on an open item:

1. **Default — leave that slice out of this batch.** It stays parked in the PRD's `## Em aberto`,
   which is exactly where a later `grill` session resumes.
2. **Only with the operator's explicit authorization** — a tracking-only record with **no `harness:*`
   label at all**. `cron-a-select` picks only open `harness:ready`, so an unlabelled issue is inert.
   This means bypassing the issue form, which always stamps `harness:ready`; do it deliberately or not
   at all. Never hand-apply `harness:queued` or `harness:blocked` — both are engine-owned.

Then tell the operator, in pt-br, which slices were held back and which open question holds each.

## Retrofit issues are local-only — never `harness:ready`

An issue derived from a **deepening candidate** is created **WITHOUT the `harness:ready` label**. It is
delivered **locally, with the operator watching the result**, because a blind restructure of working
code must never auto-merge. This reuses the inert path already documented above: `cron-a-select` picks
only open `harness:ready`, so an unlabelled issue is invisible to the engine and never dispatched. It
means bypassing the issue form (which always stamps the label) — do it deliberately. Never invent a
new label and never hand-apply `harness:queued` or `harness:blocked`; both are engine-owned.

Why this and not "just be careful": a retrofit's risk axis is **blast radius**, not domain
sensitivity, so the sensitive-path allowlist cannot see it — a large restructure of ordinary,
non-sensitive, *working* code would otherwise route to the cheapest ceremony and merge unattended.
Author it for FULL-equivalent scrutiny and tell the operator, in pt-br, that it will not run itself.

**A PRD does not authorize a bigger issue.** A PRD that produces N slices maps to N issues under the
sizing rule below, unchanged. "It is all one PRD, all one theme" is theme-cohesion, not
delivery-cohesion — the exact rationalization `rules/creating-issues.md` already warns about.

## Project glossary

If `CONTEXT.md` exists at the project root, use its terms **verbatim** in issue titles and bodies. Do
not invent parallel vocabulary; do not create or edit the file (`surveying-codebase` seeds it, the
`harvester` maintains it).

## Procedure

### 1. Split the work into DELIVERY units (sizing)

Apply the rule's sizing standard. Operator-checkable test: **if you can name two things that could
merge separately, they are two issues.**

- One independently-shippable, independently-revertible outcome ≤ ~400 lines → **ONE** issue.
- Bundled but separable outcomes → **SPLIT** (name each). Order them with `harness-deps` (step 2).
- **Always split** when: crosses a sensitive path (auth/payment/secret/SQL — isolate so only it takes
  FULL), > ~400 lines, mixes unrelated concerns, or a part is independently valuable.
- **Consolidate** only when the parts are inseparable (one cannot merge without breaking main) **AND**
  the total is ≤ ~400 lines **AND** they share the same risk profile. Theme-cohesion ≠ delivery-cohesion.

Why small is the default: retry (ceiling per issue), partial delivery (all-or-nothing per issue), and
merge blast radius (per-PR whole diff) are ALL per-issue — the planner's internal per-task
decomposition buys build quality, not these three.

### 2. Author each issue to QUALITY

Produce the form fields for each unit:

- **Title** `[harness] <slug>` — kebab-case, ≤ ~40 chars, names the scope (never `[harness] fix`).
- **`#uj-N`** — who benefits and how.
- **`#ac-N.M`** — the QUALITY LEVER. Each acceptance criterion must assert an **observable EFFECT**
  (response body, persisted state, emitted error, file content) with a **concrete value** — never
  just a status code or "it works". These become the `locked_tests` verbatim; a vague AC mis-aims the
  entire pipeline. Coach the operator: turn "o login funciona" into "quando a senha expira, a resposta
  é 401 com `{error:'session_expired'}`". Given/When/Then with real values.
- **`scope`** — tight: the files/areas it MAY touch, and what it must NOT.
- **`sensitive`** — classify honestly (anything ≠ "não" forces FULL mode + the security auditor).
- **`priority`** (P0/P1/P2), **`size`** (prefer small).
- **Roadmap only** — declare prerequisites in a fenced ` ```harness-deps ` block, one `#N` per line.

### 3. Create the issue(s)

- Every issue is created **`harness:ready`** — NEVER `harness:queued` by hand. The engine gates order
  itself (a dependent is held until its prerequisites' PRs merge) and serializes (one build at a time).
  **Two exceptions, both unlabelled and inert:** a slice blocked by the PRD's `## Em aberto`, and any
  issue derived from a deepening candidate (local delivery — see above).
- Prefer the vendored issue form (`.github/ISSUE_TEMPLATE/harness-task.yml`). If you must use the CLI,
  replicate the form structure exactly — bare `gh issue create` bypasses the form silently and drops
  the issue off the routine's radar.

### 4. Validate a roadmap

- After creating a roadmap, run `node core/vps/chain-validate.mjs --config <project.json>` — it catches
  the two authoring mistakes the runtime cannot self-heal: **dependency cycles** and **non-existent
  references** (a typo'd `#N`), which would otherwise strand an issue queued forever in silence.
- Report to the operator, in product terms: the resolved build order, and which prerequisite holds
  each queued issue.

## Done when

- Each intended outcome is exactly one small, revertible issue with verifiable ACs, correct scope and
  sensitivity, and (for a roadmap) valid `harness-deps` — and `chain-validate` is clean.
- From a PRD: every criterion traces back to a numbered requirement, decisions and model assumptions
  are two separately labelled blocks, and nothing depending on `## Em aberto` went out `harness:ready`.
- From a deepening candidate: every candidate field landed under `Suposições do modelo (atacáveis)`,
  one issue per slice, and **nothing** went out `harness:ready`.
