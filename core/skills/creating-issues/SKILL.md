---
name: creating-issues
description: "Authors well-formed harness issue(s) — a single issue or a dependency-ordered roadmap — that feed the autonomous pipeline. Applies the small-delivery-unit sizing rule, coaches VERIFIABLE acceptance criteria (the locked_tests derive from them), wires harness-deps for order, creates every issue harness:ready, and runs the DAG lint. Use when the operator wants to create an issue or organize a roadmap."
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
- Invoked directly (`/creating-issues`) or when the entry-gate advisory nudges toward the form.
- NOT for triaging an already-existing request into a delivery mode — that is `triaging-requests`.

## Interactive vs headless

- **INTERACTIVE (local):** ask the clarifying questions below before creating anything.
- **HEADLESS (cloud):** never `AskUserQuestion`; derive from the trigger prompt, proceed, and record
  any unresolved question inside the issue body rather than blocking.

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
