# Kaizen — Harness-Improvement Proposals (outbox)

A committed outbox for improvements to the **harness itself** (an agent, skill, or rule) discovered
during a run. This is **not** project memory (that lives in `.claude/memory/`) — it is a queue of
proposals addressed to the human who maintains the framework.

Flow:
1. Any run (local or cloud) that spots a possible harness improvement **appends** a proposal below.
2. In headless mode the proposal travels in the PR — it does not evaporate with the session.
3. The human drains this outbox during PR review and promotes worthy items to the framework source
   (`core/`), from where they are re-vendored into every project on the next init.
4. **Never auto-applied** — promotion is always a human decision.

**Never write secrets, credentials, or PII here — this file is committed to git.**

## Proposals

<!-- append proposals below, e.g.:
### <date> — executor: stricter scope_paths enforcement
- **Observed:** ...
- **Proposed change:** ...
- **Rationale:** ...
-->

### 2026-06-11 — entry-gate hooks: record adversary_fired in PostToolUse, not PreToolUse
- **Observed:** `entry-gate.mjs` sets `adversary_fired` on the PreToolUse allow path — i.e. before the dispatch is permitted/executed. If the operator denies the adversary dispatch at the permission prompt (or it dies immediately), the flag is already true, so the planner later passes Gate 2 without a spec-adversary having actually run.
- **Proposed change:** record `adversary_fired` from a `PostToolUse` matcher on `Agent` (subagent_type=adversary, no agent_id) — proves the adversary actually ran. Requires a 4th hook wiring in `settings.json` + a small handler (can live in `stamp-triage.mjs`).
- **Rationale:** "dispatched" ≠ "ran". Edge case (operator deny mid-mandatory-adversary), recoverable, deferred from the 0.2.0 delivery to avoid a 4th hook under time pressure.

### 2026-06-11 — hook CLIs: robust main-guard against path representation
- **Observed:** all hook CLIs guard the entry with `if (import.meta.url === \`file://${process.argv[1]}\`)`. This is byte-sensitive to path representation — under a symlinked path (e.g. macOS `$TMPDIR` → `/private/...`) the two differ, `main()` never runs, and the hook is SILENTLY INERT (exit 0 = allow). Production paths (CLAUDE_PROJECT_DIR, no symlink) match, so it works — but it is fragile.
- **Proposed change:** compare via `fileURLToPath(import.meta.url) === process.argv[1]` (and consider `realpathSync` on both) instead of string-concatenating `file://`.
- **Rationale:** a silently-inert gate is the worst failure (false sense of enforcement). Cheap hardening across the 5 CLIs.

### 2026-06-11 — gate-lib / stamp-triage: atomic-write tmp path + concurrent lost-update
- **Observed:** (a) `stamp-triage.mjs handle()` writes triage.json with a FIXED `${target}.tmp` (gate-lib writers were pid-suffixed in 0.2.0, but this one was out of that fix's scope). (b) `mergeGateState` read-merge-write is not atomic across concurrent processes; if Claude Code ever fires PostToolUse(Bash mark) and PreToolUse(Agent adversary) as truly parallel node processes, one flag can be lost (auto-corrected by the Gate 2 deny → re-fire, but costs a re-dispatch).
- **Proposed change:** pid-suffix the triage.json tmp too; for the lost-update, either document-as-accepted (serial-hook assumption holds today) or store the two boolean flags in separate single-purpose files (immune by construction).
- **Rationale:** low severity under the current serial-hook model; revisit if parallel tool-call hooks are observed.
