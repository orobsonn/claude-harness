# Unarmed Defects

Universal — no `paths:`, loads in every session.

A review finding carries **two independent axes**: how bad it is if it fires (`severity`) and whether
it fires at all (`armed` / `unarmed`). The harness already ranks severity. This rule adds the second
axis, because a finding with no arming judgment gets ranked by how dramatic it sounds — and the
loudest unreproduced scenario buries the mundane defect that happens every single time.

This rule can only ever **park a fix dispatch**. It never lowers a severity, never closes a finding, and
never removes a defect from a report. It touches exactly two gate inputs, both only for a COMPLETE park
whose tracked issue is already filed: the supervised security eye's `SECURE | UNSAFE` verdict, and the
Phase-3 open-risk flags — because a finding routed away from the fixer would otherwise hold the run at
UNSAFE forever. **It clears nothing on an unattended path.** The auto-merge gate recomputes its verdict
arming-blind by design, so a park never opens a merge nobody watched.

## The axis

- **ARMED** — the trigger is a **consequence of the design**. At the scale the product exists to
  support, ordinary use reaches it. Fix it, even if today there is zero traffic on that path.
- **UNARMED** — the code genuinely does the wrong thing, but the trigger requires a coincidence that
  would not occur **even with the system operating at its intended scale**. `unarmed` is a claim with
  two required parts: the §4 argument with its citation, and the §2 rearm observable. Missing either
  → **ARMED**. In doubt → **ARMED**.

Arming does **not** change severity. An unarmed defect that would corrupt data is still `high` — a
`high` whose trigger needs a coincidence that intended-scale operation does not produce. A parked
`high` is still counted, reported, and gated as a `high`. Parking suppresses the **fix dispatch for
this delivery** and nothing else: it never moves a severity number, a gate verdict, or a P-level.

## The discriminator

The question is **NOT** "does the precondition exist in the current installation?"

Current usage is not a defense. A multi-tenant product with one user today is the same product with
five hundred tomorrow, and the design does not change in between. Sizing the judgment by today's
install makes almost everything look unarmed at launch — which is exactly when the design is still
cheap to fix.

The question is:

> **At the INTENDED scale** — the users, tenants, groups, and concurrent requests the product exists
> to support — is this defect a **consequence of the design**, or does it need an **improbable
> alignment**?

- Consequence of the design → **ARMED**. Fix it.
- Improbable alignment even at intended scale → **UNARMED**. Park it with a rearm trigger.

**Intended scale is quoted, never inferred.** Cite the source: the spec, the PRD, a locked decision,
the product's own sales claim. No source states it → the classification is **ARMED**. "I assumed the
intended scale" is unknown, and unknown is not unarmed. An intended scale that happens to equal the
current install is current-usage bias wearing a different word — seeds, fixtures, and row counts are
not design intent.

## Conventions

### 1. Reproduce before ranking — and never rank BY the reproduction
- Every finding records a **reproduction attempt** and its result in the finding body. Four legal
  results: `reproduced`; `not-reproduced` (ran it, it did not fire); `traced` (no runtime available —
  the path proved statically, citing `file:fn` → `file:fn`); `not-attempted` (name what blocked it).
- **Severity comes from blast radius, never from the repro result.** A missing, failed, or
  static-only reproduction **never lowers** severity — it raises the obligation to investigate. A
  read-only eye with no shell reports `traced` at honest severity; it does not report `low` because
  it could not run anything.
- If it did not reproduce, the finding **says so explicitly** and that scenario **must not lead the
  text**. An unreproduced scenario never outranks or obscures a reproduced defect in the same finding.
- One finding = one defect. When a report bundles a speculative scenario with concrete ones, split
  it: the concrete defects get their own findings at their own severity and never inherit the
  speculative one's rank. **A split never shrinks the report — N defects in, N findings out**, each
  emitted with its own arming line, severity, and repro status.
- "I could not reproduce it" is a reason to **investigate harder**, never evidence of rarity, and
  never grounds for `unarmed`. A finding whose status is `not-attempted` is **never parkable**.

### 2. Parking requires a rearm trigger — never "ignore"
- Every `unarmed` finding records a **concrete observable** that re-arms it: a number or state
  someone can actually watch, not a mood.
- Good: `>= 1 grupo vinculado`, `>= 2 usuarios ativos no mesmo tenant`, `fila com backlog > 0`.
- Bad: "under concurrency", "when it grows", "at scale", "if usage increases".
- The observable must be **false today, and verified false** — record the query, count, or command that
  checked it. Already true → the defect is **ARMED**; parking it is a mislabel, not a park.
- **Verifying it is the ACCEPTER's obligation, not the finder's.** A read-only eye has no shell: it
  PROPOSES `UNARMED` with a candidate `REARM:` observable, and that proposal is complete work. The
  orchestrator, which can run commands, verifies the observable is false and only then accepts the park.
  An unverified proposal is not yet a park — it is also not a reason to inflate the finding to `high`
  "to be safe"; it stays at its honest severity, awaiting acceptance.
- The observable must be watchable with a signal that **already exists** — name the query, metric, or
  dashboard. A number nobody can obtain is as unwatchable as "under concurrency".
- The threshold sits **just above the current state, never above the design ceiling**. A number
  beyond the intended scale is "never" wearing numeric clothing.
- No rearm observable → the finding is **not** parkable. Fix it or keep it open.
- Parking is a **record**, not a deletion: it produces an operator warning plus a tracked issue
  carrying the trigger precondition and the rearm observable. Without that, "unarmed" decays into
  "forgotten" — this repo carried 68 type errors and a broken `npm ci`, each one a "later I'll look
  at it" nobody ever looked at, and CI found both in 12 seconds the day it started existing.

### 3. Deterministic is never unarmed
- If the code is wrong **100% of the times the path executes**, the precondition is "somebody uses
  the feature". That is **scope**, not rarity, and this rule cannot park it.
- A precondition **one party can satisfy alone** — enabling a flag, buying the plan, holding the
  admin role, importing a file, clicking the rarely-used button — is scope, not coincidence. A
  coincidence needs at least two independent parties or a timing window.
- Any trigger that is a normal step of a supported journey — a second user sending a message, a turn
  being abandoned, a retry after a timeout — is ordinary use, not a coincidence.

### 4. Unarmed is an affirmative claim, never an absence of evidence
- To classify `unarmed`, state **which coincidence** the trigger needs and **why** intended-scale
  operation does not produce it. Without that argument there is no classification.
- The **why cites evidence**: a unique index, a lock, a config value, a schema constraint, a locked
  decision, a `file:fn`. Narrative alone is an assertion; the citation is the classification.
- Two ordinary events occurring together is not a coincidence. At intended scale, concurrency,
  retries, and reconnects are the **default condition**, not an alignment.
- Failure to reproduce, failure to understand the code path, and "no time to check" are all the
  **same thing**: unknown. Unknown is not unarmed.
- **Cost is not an input.** Arming is a property of the trigger, never of the diff. "Big fix", "needs
  a migration", "outside `scope_paths`", "not this delivery's scope", "no budget left" → the finding
  stays **ARMED** and becomes an open blocker or an escalation. Parking is for defects that do not
  fire, never for fixes nobody wants to pay for.

### 5. Who may classify
- The finder **proposes** arming; the finder never parks. Parking is accepted by the orchestrator, on
  the record, or it does not happen. The finder is judged on the quality of the proposal — the
  coincidence, the citation, the candidate observable — never on evidence only a shell could produce.
- The investigator whose reproduction attempt failed is not the actor who parks that finding —
  non-reproduction lands on the investigator, so the same hand never cashes it in as a park.
- The fixer (`sniper`) never reclassifies. It fixes, or it escalates. A hand does not park.
- Flipping an `armed` finding to `unarmed` requires the full §4 argument plus the named actor and
  reason in the finding body. Silent downgrades between reports do not exist.
- **"On the record" names a record.** A park exists only once it is written in two places that
  survive the run: the finding body (which the run's `findings.md` carries) and the tracked issue.
  A park that lives only in the conversation was never a park — it was a finding somebody dropped.

## Patterns

- **Finding declaration** — every `adversary` / `security` finding opens its `description` with the
  axis and the reproduction status, so nothing is ranked before it is armed-checked. **The status is
  bounded by the role's own tooling, never by the defect.** A read-only eye with no shell (the
  `adversary` in both harnesses) can only ever legitimately write `traced` — and writes it at honest
  severity:

  ```
  ARMED · REPRO: traced — the second message in a conversation overwrites the first: the handler
  writes on a fixed key (`src/chat/handler.ts:saveTurn` -> `src/db/chat.ts:putTurn`, no per-message
  id), so turn 2 replaces turn 1 on the same row.
  ```

  A role that can execute (`security`, the orchestrator) runs it and records the result:

  ```
  ARMED · REPRO: reproduced — two concurrent POSTs to /messages against a real DB: row count 1,
  expected 2.
  ```

  ```
  UNARMED · REPRO: traced — cross-tenant key reuse needs two tenants provisioned on the same shard
  inside one key-rotation window; rotation is keyed per tenant (`src/keys/rotate.ts:rotateForTenant`,
  unique index on `(tenant_id, shard_id)`), so the windows cannot overlap. Intended scale: 500
  tenants (PRD §2). REARM: >= 2 tenants on one shard — `SELECT shard_id FROM tenants GROUP BY 1
  HAVING count(*) > 1` → 0 rows today.
  ```

- **Parked-defect record** — the issue-body block that makes a parked defect auditable later:

  ```
  Defeito desarmado (parqueado — nao corrigido nesta entrega):
  - Severidade honesta: <low|medium|high — inalterada pelo parqueamento>
  - Precondicao do gatilho: <the coincidence the trigger requires>
  - Escala pretendida (fonte): <the document that states it>
  - Por que a escala pretendida nao produz o gatilho: <file:fn / index / lock / config / locked decision>
  - Observavel de rearme: <the concrete number/state to watch>
  - Verificado falso hoje: <command/query run + result>
  - Tentativa de reproducao: <reproduced | not-reproduced | traced | not-attempted> — <what was run>
  - Parqueamento aceito por: <actor>
  ```

## Gotchas

- **"Did not reproduce" read as "rare"**: the most likely lazy misreading of this whole rule, and the
  one that turns it into an excuse. Non-reproduction is a gap in the investigation, and it lands on
  the investigator — not on the defect.
- **Capping by tooling**: "I have no shell, so I cannot reproduce, so it is `low`". The tool list of
  the investigator is not a property of the defect. `traced` is the honest status; the severity stays,
  and so does every gate and re-gate that severity triggers.
- **Classifying what you did not understand**: the real risk is not parking too much, it is parking a
  defect nobody managed to trace. If the reason for `unarmed` is "the code path is confusing", the
  honest output is `armed` with an admitted-uncertainty note, or more investigation.
- **Sizing by today's install**: "we have zero groups and one user" is the current-usage bias. Ask
  what the design does at the scale the product is sold at, not at the seed install.
- **Intended scale invented on the spot**: the repo seeds one tenant, so the agent declares the
  intended scale is one tenant and parks the cross-tenant bug. Design intent comes from a document.
- **Parking by budget**: the arming axis reached for exactly when the fix got expensive. If your
  reason mentions the diff, the deadline, or the scope, you are not classifying arming.
- **Feature-gate laundering**: folding "the feature is enabled" into the trigger to turn a
  100%-deterministic bug into a coincidence. Enabling a supported feature is somebody using the
  product.
- **Drama leading the finding**: the unreproduced worst case written first, the deterministic bugs
  buried underneath, and the whole thing stamped `P0` by the part that never happened. Lead with what
  reproduced.
- **Split-and-drop**: the speculative half keeps the attention, the concrete half is split off "for
  its own finding" and never written. If you split, count the outputs.
- **Rearm already true / nobody can query it / set to never**: three ways to write a concrete-looking
  observable that can never fire. Verify it is false today, name the signal that reads it, and keep
  the threshold below the design ceiling.
- **Downgrade by the back door**: parking the `high` and then reporting the delivery as "no highs".
  The park is a routing note; the severity in every count stays `high`.
- **Unarmed treated as closed**: a parked defect with no issue and no rearm observable is just a
  deleted finding with extra steps.
