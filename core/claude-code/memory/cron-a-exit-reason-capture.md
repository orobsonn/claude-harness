---
name: cron-a-exit-reason-capture
description: "[RETIRED ENGINE] cron-a-exit.mjs exit-reason capture (deleted with the VPS cron engine, #807) — the durable lessons are cleanup-in-finally for a more-sensitive artifact, and the coverage boundary of a value-based secret scrubber."
metadata:
  type: project
---

> **[RETIRED ENGINE] — historical.** `core/vps/cron-a-exit.mjs` and its `scrubSecrets` were deleted
> with the VPS cron engine (#807 / PR #830); no module at that path exists today and there is nothing
> to go fix (see `docs/vps-retirement.md`). The record is kept because both lessons below are about
> shapes, not about that file: cleanup-of-the-worse-artifact belongs in a `finally`, and a
> value-based scrubber has a NAMED coverage boundary. Apply them to any new session/log path.

**Why:** `runCronAExitCli` (in `core/vps/cron-a-exit.mjs`) captured the session's exit reason from a
raw `claude -p` capture log, scrubbed it, persisted a summary, then unlinked the raw log. #240 shipped
this with the unlink NOT wrapped in a `try/finally` around the fallible steps (`cronAExit`,
`notifyExit`) — an adversary MEDIUM finding caught it before merge (fixed, pinned by locked test 19).

**How to apply:**

- Any cleanup step that exists specifically to remove a sensitive artifact (here: the unscrubbed raw
  session log) must run in a `finally`, not sequentially after other fallible calls. If `cronAExit`
  threw (e.g. a `gh` relabel failure) or the session died mid-flow, a sequential unlink was skipped and
  the raw log — which is WORSE than the persisted summary, because it is unscrubbed — survived on disk.
  Pattern: `try { await cronAExit(...); await notifyExit(...); } finally { captureExitReason(...); }`
  (captureExitReason is what unlinks the raw log after scrubbing).
- `scrubSecrets` (in the same module) did value-based redaction, not just shape-based: it matched env
  VALUES whose env NAME matched `KEY|TOKEN|SECRET|PASSWORD|AUTH` (case-insensitive), plus shape patterns
  for `ghp_`, `sk-`/`sk-proj-`, `github_pat_`, `glpat-`, JWTs, `Bearer`/`Basic` headers, and an
  `http(s)://user:pass@` URL-credential shape. This was intentionally narrower than "any secret" — a
  downstream project's non-pattern-named secret (`DATABASE_URL`, `REDIS_URL`, `SENTRY_DSN`, or a
  `postgres://user:pass@` DSN) was NOT covered. That gap died with the module — it is recorded here as
  the SHAPE of the mistake (a scrubber's coverage is an enumerated allowlist, not "any secret"), so
  anyone writing the next redactor widens it from the start (the `SECRET_ENV_NAME_PATTERN` equivalent
  should carry `URL|DSN|CONN|DATABASE|REDIS` + a generic `\w+://user:pass@`) instead of rediscovering
  the boundary.
- The raw log read was bounded (tail-read), not a full slurp — an OOM on a huge log skips the
  `finally`-guarded unlink just like any other unhandled crash; this was accepted as a residual risk,
  not a defect, because the finally only protects against ordinary throws, not process death.

**Gotcha:** when adding a new fallible step between the raw-log write and its scrub+unlink, keep the
unlink in the `finally` — do not "just add one more await" sequentially before it.
