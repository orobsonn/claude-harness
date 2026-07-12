# Cross-family eyes (optional `codex-adversary` module) — full mechanism

> Loaded on demand by `orchestrating-delivery`. The SKILL.md carries the resident summary + the
> load-bearing tokens; this file holds the full per-checkpoint mechanism so the maestro doc stays lean.
> **Fail-open, never a hard dependency:** module absent, switch off, headless without `OPENAI_API_KEY`,
> or `codex` unreachable → every checkpoint runs **Claude-only exactly as today**.

An EYE judges better when a *second model family* judges alongside it — each family surfaces the
failure modes the other's priors miss. When the `codex-adversary` module is installed AND
`adversarial.cross_family` is not `false` (planner default: `true`) AND the second family is available
(the global switch `HARNESS_CODEX_ADVERSARY` is on and `codex` is reachable), run the eye on BOTH
families and merge — at **every** checkpoint that runs an eye. The module is vendored under
`.claude/modules/codex-adversary/` (the orchestrator runs from the repo root):

- **adversary** (spec attack, per-task, final dual-review): dispatch the Claude `adversary` as today AND
  `node .claude/modules/codex-adversary/references/cross-family.mjs --task <task.json> --claude <claude-issues.json>`.
  The driver returns `findings` (ship to the sniper now), `pendingClaudeRefutation` (codex-only findings
  whose refutation belongs to a native Claude `adversary` refute-pass — run it, then fold survivors in),
  and `dropped` (audit). Cross-check is **policy B**: a single-family finding is kept unless the other
  family refutes it — never majority voting.
- **plan-reviewer**: dispatch a Claude `plan-reviewer` AND a Codex one (`runCodexRole` role `plan-reviewer`)
  on the SAME plan to catch DISTINCT engineering problems, then merge with `merge-verdicts.mjs`
  (**either-REVISE-wins** + union of concerns).
- **security** (per-task step 3b, final dual-review): dispatch the Claude `security` auditor as today AND
  `node .claude/modules/codex-adversary/references/cross-family.mjs --role security --task <task.json> --claude <claude-issues.json>`.
  Same **policy B**, with a severity-based dedup (security issues carry no `category`). The driver returns
  a `verdict` (SECURE|UNSAFE) computed ONLY from `findings` (Claude + agreed + claude-only survivors) —
  codex-only findings sit in `pendingClaudeRefutation` and do **NOT** escalate the gate until their Claude
  refute-pass runs and survivors are folded in. **Determinism (gate precondition):** a non-empty
  `pendingClaudeRefutation` is a **delivery-blocking precondition** — record it like a `regate-pending`
  marker in gate-state; the gate does not pass until every pending codex-only finding has had its Claude
  refute-pass and the verdict is recomputed. This makes the second family's catch first-class (it CAN
  gate, once Claude has weighed in) while a codex false-high can never flip the gate behind the
  orchestrator's back, and a forgotten refute-pass blocks rather than silently passing.

This is **fail-open and never a hard dependency**: module absent, switch off, headless without
`OPENAI_API_KEY`, or `codex` unreachable → the checkpoint runs **Claude-only exactly as today** (for
security, the verdict is then Claude's alone). The second family is always read-only (`--sandbox
read-only`) — an EYE, never a hand. It does **not** relax the "no eye on Ollama" constraint:
cross-family adds a second *Claude-tier* family, not a cheap hand.

## Deterministic nudge (`codex-eye-nudge.mjs` — PostToolUse[Agent] hook)

Rather than relying on the orchestrator to remember from prose, the harness injects the cross-family
invocation deterministically. When the orchestrator dispatches an eligible eye (`adversary`, `security`,
or `plan-reviewer`) with `HARNESS_CODEX_ADVERSARY` on and the module present, the PostToolUse[Agent]
hook `codex-eye-nudge.mjs` fires automatically after the Claude eye returns and injects an
`additionalContext` reminder to run the second family. **Sequencing (critical):** the nudge is an
obligation to honour AFTER the Claude eye has returned — capture the eye's findings/verdict into the
`--claude` input file FIRST, THEN run
`node .claude/modules/codex-adversary/references/cross-family.mjs --role <role> --task <task.json> --claude <claude-input.json>`,
THEN merge. **Never run `cross-family.mjs` against an empty `--claude` file** — that produces a
degenerate merge with no Claude signal. **Coverage:** the nudge fires by `subagent_type` at every eye
checkpoint (spec-adversary, per-task, plan-review, final dual-review) — not only the final ones.
**Advisory, never a gate:** the nudge never blocks; switch off, module absent, headless, or `codex`
unreachable → the hook skips silently and the checkpoint runs Claude-only exactly as today (fail-open).
**Idempotence (residual accepted):** duplicate nudges are expected (final dual-review = 2 eyes → 2
nudges; a re-gate → another); an eye whose cross-family step is already merged is satisfied; the Claude
refute-pass for codex-only findings MUST be dispatched as a general Claude agent — **NOT** as
`subagent_type adversary/security` — otherwise it re-triggers the nudge in a loop. The `plan-reviewer`
cross-family step runs verdict-shaped via `cross-family.mjs --role plan-reviewer` (new route alongside
the existing `--role security`).
