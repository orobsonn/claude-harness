---
name: proposing-deepening
description: "Architectural retrofit analysis for an EXISTING codebase — walks the code, finds DIRECTORIES of shallow modules, and proposes at most 5 ranked deepening candidates to docs/architecture/deepening-candidates.md. READ-ONLY on source and PROPOSE-ONLY: it never refactors, never opens an issue, never dispatches a delivery agent. LOCAL/interactive only — it refuses in any headless or cron session. A candidate is a model deduction, never a locked decision, and the issue derived from it is created WITHOUT harness:ready: a blind restructure of working code is delivered locally, never auto-merged. Use when a legacy/existing project needs its architecture retrofitted toward deep modules, or when asked to find where the codebase became hard to change."
---

# Proposing deepening — find where the codebase went shallow, propose the fix

An existing codebase was not written under the module-depth rule. This skill finds where that hurts
most and proposes a bounded set of retrofits. It **analyses and proposes; it never changes code.**

Announce at start (pt-br): "Vou varrer o código e trazer no máximo 5 candidatos a reforma."

All reasoning and identifiers in English. Every message to the operator is **pt-br,
product-language** — he decides on impact and risk, never on class names.

---

## Hard precondition — LOCAL only, never headless

The output of this skill is a **question to the operator** ("qual, se algum, vale reformar?"). In a
headless run there is nobody to answer, ending a turn on a question kills the run, and an unanswered
candidate list would be picked up by an autonomous engine as work to do. So: **if the session is not
interactive, refuse immediately and say why.**

Headless is active when **any** of these holds:

- the trigger prompt says to run **autonomously** / "sem perguntar" / "without asking" — the VPS cron
  dispatcher always prepends a fixed prefix of this shape;
- any of the union signals is non-empty:

  ```bash
  printf 'remote=%s notify=%s obs=%s\n' \
    "$CLAUDE_CODE_REMOTE" "$HARNESS_NOTIFY_PROJECT" "$HARNESS_OBSERVABILITY_RUN_PATH"
  ```

> `$CLAUDE_CODE_REMOTE` alone is **not** a sufficient test. The VPS cron dispatcher
> (`core/vps/cron-a-dispatch.mjs`) **deliberately unsets it** so the run stays "headless-local" and
> the cheap hands stay enabled. A skill keyed only on that variable would happily hand a
> restructure-the-codebase list to a fully autonomous fleet run.

Also refuse when you were invoked from inside a subagent/hand with a work brief — this skill only
ever runs in a top-level operator session, after `triaging-requests` returned no-ceremony. Never skip
or pre-empt the entry gate to reach it.

Refusal (pt-br, then stop — do not fall back to "deciding for him"):

> "Essa varredura termina numa escolha sua sobre o que vale reformar. Esta sessão é automática, então
> não dá pra rodar aqui. Rode localmente e a reforma que você escolher entra como entrega local."

---

## Load the standard first

Read `rules/architecture.md` (module depth) and `rules/code-quality.md` (testing surface) before
scanning. They define **deep**, **shallow**, **seam**, the **deletion test**, and *test at the door,
not the furniture*. This skill does not restate them — it applies them.

`rules/architecture.md` is **path-scoped to TS/TSX** (`src/`, `app/`, `worker/`), so it may not be in
context yet and in a non-TS project may never auto-load. **Read the file explicitly**; never assume.
If the project has no such rule, say so and stop: without the standard there is nothing to measure
against.

---

## Hard constraints

- **READ-ONLY on source.** Never edit, move, rename, or delete a single line of project code. The
  only file this skill writes is the candidates file.
- **PROPOSE-ONLY.** Never create a GitHub issue, never invoke `creating-issues` yourself, never
  dispatch a delivery agent. The operator picks; then he runs `creating-issues`.
- **On Claude Code this skill has no permission sandbox.** It runs in the main loop with the full
  toolset, so the propose-only boundary above is prose, not a lock — the real protection is the
  **local-only issue rule** (§ Handoff) plus the operator sitting in front of the session. Treat every
  line above as binding precisely because nothing enforces it. (The OpenCode copy runs inside the
  `plan` agent, where `bash` and source `edit` are denied outright.)
- **NOT a source of truth.** *(the single most important line in this file)* A candidate is 100%
  model deduction — the code was read by the same model that is now judging it. Everything here
  enters the pipeline later as **ordinary, attackable input**. Never record a candidate as a locked
  decision that downstream roles are obliged to defend.
- **Cap: 5 active candidates per scan.** Rank and cut. An unbounded list is a wall nobody reads, and
  the temptation to turn it into 30 issues is the exact failure this cap exists to prevent.
- **Never re-propose what the operator rejected or accepted.** Read the existing candidates file
  first and honour `## Recusados` and `## Aceitos`.

---

## Procedure

### 1. Read the previous scan and the project memory

Open `docs/architecture/deepening-candidates.md` if it exists. Load `## Aceitos` (already ruled on —
never re-propose), `## Recusados` (already refused — never re-propose), `## Fila` (demoted, may
return) and `## Bloqueados`.

Then read the project memory — `.claude/memory/MEMORY.md` plus the topic files it indexes, the nested
`CLAUDE.md` files, and `CONTEXT.md` if it exists. Use `CONTEXT.md`'s vocabulary verbatim in candidate
titles; never invent parallel terms; never edit any of these files (`surveying-codebase` seeds them,
the `harvester` maintains them).

**The inverse risk, stated plainly.** `surveying-codebase` records what the code *actually does* — so
a directory full of shallow forwarders can be written into memory as a **convention**, and the
executor will then faithfully imitate the exact shape this skill exists to remove. That makes memory
and this skill capable of contradicting each other silently. So: if a candidate contradicts a
recorded convention, **say so in the candidate** (`contradiz memória: <arquivo> — <convenção>`) and
tell the operator that accepting it also means that memory entry has to be corrected. Never propose
against recorded law in silence, and never fix the memory yourself.

### 2. Detect shallow clusters — by DIRECTORY, structurally

The symptom is never one file. A single 20-line forwarder is noise; a **directory** of them is the
candidate. Aggregate everything at directory level.

Detect with `read` / `grep` / `glob` only (no shell needed — the OpenCode host has no bash):

- **Shape of the tree** — `glob` the directory: many files with a small average size is the primary
  smell. Combine with a `read` of two or three of them to confirm.
- **Forwarding bodies** — `grep` for exports that only delegate: one-line re-exports, `return
  <inner>.<same-name>(...)`, `module.exports = require(...)`, barrel `index` files that only chain
  other barrels.
- **Import fan-out** — `grep` who imports from *inside* the directory versus from one door. Many
  callers reaching past the door means the door is decorative.
- **Repeated dance** — `grep` for the same 3-call sequence appearing at several call sites; that is
  domain knowledge living in the callers.
- **Reach-through tests** — `grep` the test tree for imports of internal paths under the directory
  rather than its entry point. The interface is in the wrong place.

### 3. Apply the deletion test — as an exclusion filter

For each suspect directory, imagine deleting it. If the complexity vanishes with it, it was a
pass-through (shallow — the proposal is to **remove** it, not to grow it). If the complexity
reappears spread across N callers, it was earning its keep and is **not** a candidate. Only a cluster
whose complexity would **concentrate behind a smaller interface** survives.

### 4. Require an INDEPENDENT characterization oracle — or do not propose it

A retrofit is only safe if something outside the rewrite can tell you the behaviour did not change.
**A test written now by reading the very source you are about to rewrite is not that something.** It
encodes the same understanding as the rewrite, goes green by construction, and blesses whatever the
code does today — bugs included. Writing one and calling the candidate "covered" is the most
dangerous output this skill can produce.

An oracle counts as **independent** only if it exists apart from the source under rewrite:

- **Existing consumer / contract tests** that call the seam from outside and do not import its
  internals.
- **Golden fixtures captured from the running system** — recorded request/response pairs, logged I/O,
  a DB snapshot, a CLI transcript. Capturable *without* editing the module.
- **An external contract** the module must satisfy: an API schema, a wire format, a published fixture,
  a downstream consumer's expectations.

If none of these exists and none can be captured without touching the code, the candidate is **NOT
proposable**. Record it under `## Bloqueados` as `bloqueado: sem oráculo independente`, name what
capture would unblock it, **do not rank it**, and do not count it against the cap of 5.

### 5. Name the slice sequence — parallel change, or it is not proposable

A seam move is inseparable by nature and almost always exceeds the ~400-line delivery unit in
`rules/creating-issues.md`, so "one big refactor issue" has **no legal shape**. Every candidate must
therefore carry a **parallel-change (strangler) sequence** in which each slice merges on its own and
leaves `main` green:

1. **Slice 1 — introduce the new interface alongside the old.** No caller moves. Additive, revertible
   by itself.
2. **Slices 2..N — migrate callers in batches of ≤ ~400 lines**, each independently mergeable. Both
   paths stay live throughout.
3. **Final slice — delete the old path** once nothing references it.

Name the sequence concretely (how many callers, how they group). A candidate that can only be done as
a flag-day move is **flagged, not proposed**: record it as `bloqueado: sem fatiamento` and say what
would make it sliceable.

### 6. Rank by structural leverage — change frequency is only a tie-breaker

Rank on **how much complexity concentrates behind the smaller interface** (the deletion-test result):
forwarding hops removed, callers freed from knowing the internal order, places where the same domain
knowledge stops being re-derived. That is the leverage, and it is structural — it does not need git.

**Do not rank by change frequency.** The heuristic is anti-correlated with the actual problem: the
worst module in a codebase is often the one **nobody touches because everybody is afraid of it**, and
a frequency metric structurally cannot see it — its signal is exactly zero.

So run a deliberate **second lens for the feared module**: no tests around it, oversized files or
functions, "legacy"/"não mexer"/"TODO" comments, and — the strongest signal — **new code that
duplicates its job elsewhere** rather than changing it. Ask the operator one direct question, since
this is a product-level answer he owns: *"Tem alguma parte do sistema que todo mundo evita mexer?"*

Change signal is a **secondary tie-breaker only**, and it is optional context, never the axis. If you
gather it on Claude Code (there is no shell in the OpenCode host):

```bash
git log --no-merges --since='12 months ago' --name-only --pretty=format: -- . \
  | grep -vE '(package-lock|yarn\.lock|pnpm-lock|\.snap$|CHANGELOG|^dist/|^vendor/|node_modules/|generated)' \
  | sort | uniq -c | sort -rn | head -40
```

Read it with the caveats: a **squash-merge repo collapses a whole PR into one commit**, so churn
understates activity; **paths that no longer exist on disk must not be counted** (deletions still
appear in `--name-only`); and lockfiles, snapshots, generated and vendored trees are noise.

Push down anything that crosses a sensitive path (auth, payment, billing, SQL, migrations) — it costs
a FULL delivery with a security auditor and must be a deliberate choice, never a by-product of a
sweep. **That demotion does NOT make the top candidate low-risk** — see the routing note next.

### 7. Escalate the route on every candidate

A deepening candidate's risk axis is **blast radius**, not domain sensitivity. The sensitive-path
allowlist cannot see it: restructuring perfectly ordinary, non-sensitive, *working* code is exactly
the case that routes to the cheapest ceremony while touching the most surface. That inversion is the
single most expensive mistake available here.

So every candidate carries `rota: FULL-equivalente`, and the derived local issue is authored for that
scrutiny — `size: L` (or an explicit justification for smaller), a careful-review note, and a
security note where any data path is involved — **even when `sensível: não`**.

### 8. Write the candidates file

Merge into `docs/architecture/deepening-candidates.md`. **APPEND-ONLY: never regenerate the file.**
Read it, keep `## Recusados` and `## Aceitos` byte-for-byte, and edit only `## Ativos`, `## Fila` and
`## Bloqueados`. The rejection history is the only memory of the operator's rulings; regenerating the
file silently re-opens every decision he already closed.

**Status machine:** `proposto` → `aceito` (operator picked it; issue exists) → `feito` (delivered).
Also `bloqueado` (no oracle / no slicing) and `recusado`. An accepted candidate **moves out of
`## Ativos` into `## Aceitos`** — leaving it in `## Ativos` is what makes a file re-propose the same
work forever.

**Cap and demotion:** the cap of 5 counts only `## Ativos` entries with status `proposto`. When a new
scan would exceed it, rank the old actives and the new finds **together** and keep the top 5; each
demoted entry moves to `## Fila` with one line saying what outranked it. Never let `## Ativos` grow
past 5 by accumulation.

**Commit it.** `docs/architecture/` is outside any delivery scope, and the `shipper` never runs here —
nothing auto-stages this file. Commit it yourself via `committing-changes`. Uncommitted, the next scan
reads nothing and re-proposes everything the operator already rejected.

```markdown
# Candidatos a aprofundamento

- **atualizado:** YYYY-MM-DD · **varredura sobre:** <short sha ou branch>

## Ativos

### C-N — <título curto, em linguagem de produto>
- **o que fica mais fácil e pra quem:** <a mudança que hoje dói e quem sente>
- **o que custa / o que quebra:** <fatias, esforço, o que para de funcionar no pior caso, como reverter>
- **não fazer nada:** <o custo honesto de conviver com isso — inclusive "quase nada", quando for>
- **onde:** <diretório(s)>
- **sintoma:** <o que dói hoje, em termos de mudar o código>
- **oráculo independente:** <teste de consumidor existente | fixture gravada do sistema rodando | contrato externo>
- **fatias:** 1) interface nova ao lado da antiga · 2..N) migra <N> chamadores (≤400 linhas cada) · última) apaga a antiga
- **rota:** FULL-equivalente (raio de explosão) · **sensível:** não | <área>
- **contradiz memória:** não | <arquivo — convenção>
- **status:** proposto

#### Detalhe técnico (pode pular)
- **teste de deleção:** <o que acontece se apagar — por que passou no teste>
- **interface proposta:** <a interface menor que ficaria no lugar>
- **raio de explosão:** <o que depende disso>

## Aceitos (não re-propor)

| candidato | data | issue | status |
|---|---|---|---|

## Fila (rebaixados pelo teto de 5 — podem voltar)

| candidato | data | perdeu para |
|---|---|---|

## Bloqueados (não ranqueados, não contam no teto)

| candidato | data | motivo |
|---|---|---|

## Recusados (não re-propor)

| candidato | data | motivo |
|---|---|---|
```

### 9. Report to the operator — two fields he can actually rule on

Lead every candidate with the **two** fields a non-developer can decide, in pt-br, honestly and
without advocacy:

1. **O que fica mais fácil e pra quem** — a concrete change he wants to make and who feels the
   difference. Never "reduz acoplamento".
2. **O que custa e o que quebra se der errado** — number of slices, worst case, how it is reverted,
   **plus the "não fazer nada" baseline**: what it costs to keep living with it.

If the honest answer is that doing nothing is fine, **say that**. A candidate the operator should
refuse is a useful output; talking him into a restructure is not.

Everything else — deletion test, proposed interface, oracle, blast radius — goes into a clearly
marked **"detalhe técnico (pode pular)"** block. He decides on impact and risk, never on class names.

Close with one question: which, if any, he wants to turn into work. **Stop there.**

### 10. Handoff contract — what the accepted candidate becomes

If he picks one, **he** runs `creating-issues`; you do not. When it is authored, this mapping holds:

| Candidate field | Where it lands in the issue |
|---|---|
| `o que fica mais fácil e pra quem` | the `#uj-N` user journeys |
| `sintoma` + `não fazer nada` | the summary — context and why it matters |
| `fatias` | **one issue per slice**, ordered with `harness-deps` |
| `oráculo independente` | the `#ac-N.M` criteria — the oracle IS the verification |
| `rota: FULL-equivalente` | `size` + the careful-review/security note |
| `raio de explosão`, `contradiz memória` | `Suposições do modelo (atacáveis)` |
| everything else in the candidate | `Suposições do modelo (atacáveis)` |

**EVERY candidate field enters the issue under `Suposições do modelo (atacáveis)` — NEVER under
`Decisões travadas`.** The only locked decision available here is the operator's own "sim, vale
reformar isso", and that is a decision to do the work, not a decision about how. A candidate promoted
to a locked decision would make the `adversary` defend a model deduction instead of attacking it.

**The derived issue is created WITHOUT `harness:ready`.** `cron-a-select` picks only open
`harness:ready`, so an unlabelled issue is inert and never dispatched — the same tracking-only path
`creating-issues` already documents. This is deliberate: **a blind restructure of working code must
never auto-merge at 3am.** The work is delivered **locally, with the operator watching the result**.
Never hand-apply `harness:queued` or `harness:blocked` — both are engine-owned.

---

## Anti-patterns

- **Refactoring anything.** The moment you edit source, this skill has failed. Propose only.
- **Opening an issue** — and above all opening a `harness:ready` one. The cap exists because the
  sweep must not become an issue factory; the label rule exists because it must not become an
  unattended one.
- **A characterization test written by reading the source about to be rewritten.** Tautology: it goes
  green by construction and canonizes today's behaviour, bugs included. Independent oracle or no
  candidate.
- **A candidate with no slice sequence.** A refactor that can only land as one flag-day commit has no
  legal issue shape and no green `main` in the middle.
- **Proposing a layer in a flat codebase.** `rules/architecture.md` defaults to FLAT; a speculative
  `domain/application/infrastructure` skeleton with no invariant to protect is the anti-pattern, not
  the fix.
- **Ranking file-by-file.** One forwarder is not a cluster. The unit of the symptom is the directory.
- **Deepening something with neither change nor fear.** No changes, no avoidance, nobody complaining,
  nobody afraid of it → leave it alone. But **zero change frequency alone is not that signal**: the
  module everyone routes around also reads as zero.
- **Metric theatre** — ranking by file count, line count, or git churn. Depth is measured at the
  interface; counting lines rewards padding and counting commits rewards the code that was never
  scary enough to avoid.

---

## Done when

- `docs/architecture/deepening-candidates.md` holds at most 5 active candidates, each with the
  deletion test applied, an **independent** oracle named, a slice sequence named, blast radius named,
  route escalated, and sensitivity classified — and it is **committed**.
- Everything without an independent oracle or without a slicing path is under `## Bloqueados`, not
  ranked; everything previously accepted or rejected is untouched and was not re-proposed.
- The operator got two decidable fields per candidate (benefit, cost + do-nothing baseline) before any
  technical detail.
- No project source file was modified, no issue was created, and nothing was labelled `harness:ready`.
