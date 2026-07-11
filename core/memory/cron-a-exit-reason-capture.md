---
name: cron-a-exit-reason-capture
description: cron-a-exit.mjs exit-reason capture — cleanup ordering and scrubSecrets coverage boundary
metadata:
  type: project
---

**Why:** `runCronAExitCli` (in `core/vps/cron-a-exit.mjs`) captures the session's exit reason from a
raw `claude -p` capture log, scrubs it, persists a summary, then unlinks the raw log. #240 shipped this
with the unlink NOT wrapped in a `try/finally` around the fallible steps (`cronAExit`, `notifyExit`) —
an adversary MEDIUM finding caught it before merge (fixed, pinned by locked test 19).

**How to apply:**

- Any cleanup step that exists specifically to remove a sensitive artifact (here: the unscrubbed raw
  session log) must run in a `finally`, not sequentially after other fallible calls. If `cronAExit`
  throws (e.g. a `gh` relabel failure) or the session dies mid-flow, a sequential unlink is skipped and
  the raw log — which is WORSE than the persisted summary, because it is unscrubbed — survives on disk.
  Pattern: `try { await cronAExit(...); await notifyExit(...); } finally { captureExitReason(...); }`
  (captureExitReason is what unlinks the raw log after scrubbing).
- `scrubSecrets` (in the same module) does value-based redaction, not just shape-based: it matches env
  VALUES whose env NAME matches `KEY|TOKEN|SECRET|PASSWORD|AUTH` (case-insensitive), plus shape patterns
  for `ghp_`, `sk-`/`sk-proj-`, `github_pat_`, `glpat-`, JWTs, `Bearer`/`Basic` headers, and an
  `http(s)://user:pass@` URL-credential shape. This is intentionally narrower than "any secret" — a
  downstream project's non-pattern-named secret (`DATABASE_URL`, `REDIS_URL`, `SENTRY_DSN`, or a
  `postgres://user:pass@` DSN) is NOT covered today. Known gap, tracked as an open kaizen item (widen
  `SECRET_ENV_NAME_PATTERN` to add `URL|DSN|CONN|DATABASE|REDIS` + generalize the URL-cred shape to any
  `\w+://user:pass@` scheme) — anyone extending `scrubSecrets` should close that gap rather than
  reintroduce it elsewhere.
- The raw log read is bounded (tail-read), not a full slurp — an OOM on a huge log skips the
  `finally`-guarded unlink just like any other unhandled crash; this is accepted as a residual risk, not
  a defect, because the finally only protects against ordinary throws, not process death.

**Gotcha:** when adding a new fallible step between the raw-log write and its scrub+unlink, keep the
unlink in the `finally` — do not "just add one more await" sequentially before it.
