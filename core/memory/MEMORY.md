# Project Memory — Index

One line per durable, reusable, non-obvious project pattern or anti-pattern. The full prose lives in
a topic file next to this index (`<slug>.md`); link it as `- [Title](file.md) — hook`.

This index loads at the start of every session (first 200 lines / 25KB). Topic files load on demand.
The `shipper` commits this directory back so cloud routines accumulate knowledge across runs.

**Never write secrets, credentials, or PII here — this directory is committed to git.**

<!-- index entries go below, e.g.:
- [Auth session lives in KV](auth-session.md) — reuse `getSession()` before adding a new store
-->

- [Dispatch-hand contract](dispatch-hand-contract.md) — truth = git diff + `captured:true` flag, fail-closed; redact-first then truncate; per-dispatch allowedWrites; frozen manifest excludes executor writes
- [Model strategy split](model-strategy-split.md) — `hand_tiers` (Ollama write-roles) vs eye roles (always Claude); shape detection; CLAUDE_ALIASES; ALLOWED_MS_KEYS; legacy `tiers` removed (rejected by validation)
