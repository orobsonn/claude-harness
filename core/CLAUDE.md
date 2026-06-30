# Claude Harness — Entry Policy

This file is vendored into a project's `.claude/CLAUDE.md`. It loads at the start of every
session (local and cloud) and governs how the harness routes work.

## On the first interaction of every session

Run the skill **`triaging-requests`** before doing anything else.

It classifies the request into one of four paths:
- **No ceremony** — question, chat, reading → answer directly.
- **QUICK** — `fix` (obvious hotfix, 1–2 files) **or** `craft` (net-new self-contained visual artifact — page/quiz/landing — routed to an artisan skill), no sensitive path → implement inline / dispatch the artisan skill, run the cheap rails (gates + sensitive-path glob), commit via `committing-changes`.
- **LIGHT** — small feature, clear scope → invoke `orchestrating-delivery` in LIGHT mode.
- **FULL** — multi-file, high severity, or sensitive domain → invoke `orchestrating-delivery` in FULL mode.

`triaging-requests` asks clarifying questions until the classification is certain. It never guesses.

## Two execution modes

The pipeline is the same; what changes is **who occupies the human decision points**.

| Point | LOCAL (operator in the loop) | HEADLESS (cloud routine) |
|---|---|---|
| Entry | `triaging-requests` + operator veto | classifies autonomously, no veto |
| Spec / brainstorm | operator explores | agents simulate exploration + adversary attacks the spec |
| Approve spec | human hard-gate | multi-agent validation, proceeds |
| Approve plan | human hard-gate | `plan-reviewer` + validation, proceeds |
| Demo | operator tests output | auto-generated, auto-validated against the ACs |
| Critical exception | ask the operator | record as an open risk in the PR; do not block |
| Delivery | merge on operator OK | open a **draft PR, never merge** |

**Mode detection:** HEADLESS is active when the session is a cloud routine (env `$CLAUDE_CODE_REMOTE` is set / `claude-code-on-the-web`) **or** the trigger prompt explicitly says to run autonomously. Otherwise LOCAL. `triaging-requests` and `orchestrating-delivery` branch on this signal.

**Headless golden rules** (reinforced by the skills):
1. **Never** use `AskUserQuestion` or plan mode — undefined behavior in the cloud.
2. Human gates become **multi-agent validation** — never "auto-approve blindly".
3. The real human gate is the **PR review** (asynchronous, on GitHub).
4. Durable knowledge is committed in the PR (`.claude/memory/`, `.claude/kaizen.md`) — otherwise it evaporates each run.

## Pipeline trigger

Skills do **not** auto-load in cloud sessions — they load on demand. The pipeline is triggered by
this entry policy plus the routine prompt (and, if confirmed, a `SessionStart` hook in
`settings.json` that injects the entry instruction deterministically). Presence of the skill files
alone does not start the pipeline.

## Sensitive-path allowlist (forces FULL in the plan)

When the planner produces `scope_paths`, a deterministic check forces FULL if any path matches:

```
**/auth/**
**/payment/**
**/billing/**
**/*.sql
**/migrations/**
**/.env*
**/package.json   (when adding or upgrading deps)
```

Judgment on entry (triage). Determinism on the plan (planner → orchestrating-delivery).

## Memory and improvements

The harness uses native, repo-relative knowledge stores so the cloud sees them (see
`CLAUDE-HARNESS-MEMORY-MODEL.md`):

- **Project knowledge** → `.claude/memory/` (committed). The `MEMORY.md` index loads each session;
  topic files load on demand. The `shipper` commits it back so it persists across runs.
- **Harness-improvement proposals** → `.claude/kaizen.md` (committed outbox). Any run that discovers
  a possible improvement to an agent/skill/rule appends here. The human drains it during PR review
  and promotes worthy items to the framework source. **Never auto-applied.**
- **Run buffers** (`findings.md`, `shared_context.md`) are ephemeral and deleted at harvest end; the
  durable audit is git.

Memory and kaizen are committed project artifacts — **never write secrets, credentials, or PII into them.**

## Adversarial posture (non-trivial design)

Before closing a non-trivial technical proposal (architecture, security, multi-tenancy, scalability,
stack choice, blast radius), invoke an agent with an explicit **devil's-advocate** role to attack it,
and present the honest synthesis. Skip for trivial/mechanical tasks.

**Cross-family eyes (optional `codex-adversary` module).** Not every task has an adversarial
checkpoint, but every checkpoint that runs a critical-judgment **eye** (the `adversary` on spec /
per-task / final dual-review, the `plan-reviewer`, and the `security` auditor) can run on **two model
families** — Claude and a second family (GPT via the Codex CLI) — so each surfaces the problems the
other's priors miss. The **global switch** is the env var `HARNESS_CODEX_ADVERSARY` (set it in
`settings.local.json` → `env` for a per-machine opt-in — what `npx claude-harness init` writes when you
opt in — or in the committed `settings.json` → `env` for a repo-wide default; per-task via
`adversarial.cross_family`). It is **fail-open**: with the module absent, the switch off, in headless
without an `OPENAI_API_KEY`, or with `codex` unreachable, every checkpoint runs **Claude-only exactly
as today** — the second family is never a hard dependency. For the `security` eye specifically, the
SECURE|UNSAFE gate verdict stays Claude-authoritative (a codex-only finding only escalates the gate
after its Claude refute-pass — a gate-state precondition). The second family is always read-only and
Claude-tier (an eye, never a cheap hand). See the vendored `.claude/modules/codex-adversary/`.

## Language convention

- All harness artifacts — skills (`SKILL.md`), agents (`.md`), rules, JSON keys/values, inline
  reasoning — are written in **English**.
- Every message to the operator — checkpoints, demos, questions — is in **the operator's language**,
  product-language (impact, tradeoffs, behavior), never engineering-language.

## Communication (terse)

- Short and direct. No preamble, no conclusion, no summary.
- Do not announce action ("I'll check..."). Show the result. (A skill may emit one short line naming
  itself when it starts — a status signal, not preamble.)
- Do not verbalize chain of thought. Do not justify obvious commands.
- Short lists > paragraphs. Only the essential.

## Naming convention

- Skills: gerund (`triaging-requests`, `orchestrating-delivery`, `creating-plans`).
- Agents: role-noun (`planner`, `executor`, `adversary`, `sniper`, `harvester`).
- **Carrier exception:** a skill that only *carries knowledge* (a taxonomy/reference loaded by other
  roles, not an action) may use a noun phrase — e.g. `canonical-critical-classes`. Action skills stay gerund.

## Operator profile

The operator may be a product manager, not a developer. Decisions presented to the human are always
**product decisions** (impact, tradeoffs, user behavior) — never engineering decisions (code,
architecture, race conditions). Engineering problems are resolved inside the system.

# Compact instructions

When compacting, preserve:
- **phase** — current phase in the harness loop (entry, spec, plan, review, delivery, etc.)
- **mode** — triage classification (no-ceremony, QUICK, LIGHT, FULL)
- **plan path** — absolute path to the execution plan (`.claude/plans/<feature_id>/execution-plan.json`)
- **gate state** — the entry gate state, including `session_id` and the path to `.claude/plans/.state/<session_id>/gate-state.json`
- **re-gate obligation** — any `regate-pending` (HIGH sniper fix) without a matching `regate-passed` (same feature-id + task-id) in the gate-state is a **delivery-blocking precondition**: a grave cheap-hand fix still awaits its mandatory strong-eye re-gate. This obligation survives compaction — never drop it; re-read the gate-state markers and block delivery until every `regate-pending` is matched by a `regate-passed`.

After compaction, re-read these artifacts from disk to resume:
1. The current phase and mode from memory or the execution plan.
2. The gate state from `.claude/plans/.state/<session_id>/gate-state.json` — including any unmatched `regate-pending` (a HIGH sniper fix still awaiting its strong-eye re-gate; delivery-blocking).
3. The execution plan summary from `.claude/plans/<feature_id>/execution-plan.json`.

This allows recovery without losing continuity when the context limit is reached during a harness run.

## Permissions baseline

The shipped `settings.json` is a **conservative baseline** that works on desktop and cloud. It does
not bypass permission prompts. Adapt the allowlist to your environment to give Claude more autonomy
(e.g. allow your project's build/test commands). See `settings.json` and `.claude/modules/` for optional add-ons.
