# Project Memory — Index

One line per durable, reusable, non-obvious project pattern or anti-pattern. The full prose lives in
a topic file next to this index (`<slug>.md`); link it as `- [Title](file.md) — hook`.

This index loads at the start of every session (first 200 lines / 25KB). Topic files load on demand.
The `shipper` commits this directory back so cloud routines accumulate knowledge across runs.

**Never write secrets, credentials, or PII here — this directory is committed to git.**

<!-- index entries go below, e.g.:
- [Auth session lives in KV](auth-session.md) — reuse `getSession()` before adding a new store
-->

- [Dispatch-hand contract](dispatch-hand-contract.md) — truth = git diff + `captured:true` flag, fail-closed; redact-first then truncate; per-dispatch allowedWrites; frozen manifest excludes executor writes; commit before re-freezing/re-spawning on the same file (reconciliation eats uncommitted work); mark.mjs marker stdout must stay visible + fire as standalone calls after the freeze-commit; harness-internal infra writes (version-check cache) excluded from the scope/gitignored-escape sweep by EXACT match only, never prefix
- [Model strategy split](model-strategy-split.md) — `hand_tiers` (Ollama write-roles) vs eye roles (always Claude); shape detection; CLAUDE_ALIASES; ALLOWED_MS_KEYS; legacy `tiers` removed (rejected by validation); prefer high-tier Ollama models (kimi-k2.7-code) over medium (glm-5.2) for surgical/composition-root fixes — observed flakiness
- [Harness repo constraints](harness-repo-constraints.md) — no package.json (node --test only); sandbox blocks .env.* reads in tests (run with sandbox off); dual-mirror edit rule is STALE (harness removed from global ~/.claude/ 2026-06-28 — edit core/ only, no phantom second copy to hunt for; .claude/ itself is still gitignored source-side — existsSync-guard drift tests); import.meta.url path resolution in test files; prompt-rule locked tests on an agent .md must assert co-occurrence within the rule's own section window, never a whole-body token search (vacuous-pass / silent-erosion risk)
- [Independent PR-review phase](independent-pr-review-phase.md) — cron-review.mjs/run-cron-review.mjs replace the editable-PR-body verdict with a fresh stateDir artifact + fail-closed conjunction; spawnReviewSession LIVE; real cross-family (Codex) actuator now WIRED (runCodexRole direct, deriveSecondFamilyVerdict, autoMergeEnabled rollout lock, fail-closed diff-fetch); open risks before flipping autoMergeEnabled=true documented in the topic file
- [Codex cross-family gitignored evidence](codex-cross-family-gitignored-evidence.md) — Codex's own file-search under `codex exec --sandbox read-only` appears to respect `.gitignore`, so it reports a real evidence file under a gitignored path (e.g. `.claude/plans/`) as "does not exist"; inline gitignored-path evidence into the task JSON instead of citing only the path, or verify a Codex "file missing" report directly before trusting it as a refutation
