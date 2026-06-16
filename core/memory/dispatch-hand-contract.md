---
name: dispatch-hand-contract
description: Contract for dispatch-hand.mjs — truth-capture semantics, scope-check, fail-closed rules, and secret hygiene for cheap-hand dispatches
metadata:
  type: project
---

**Why:** Cheap Ollama hands are untrusted. The harness needs a tamper-proof verdict independent of
model prose. Truth = git diff + exit code + a captured JSON flag (`captured: true`). If
`captured !== true` the run fails-closed — the model may have silently dropped the JSON block.
Scope-check and per-dispatch allowed-write sets enforce containment without a git worktree.

**How to apply:**

- `evaluateRun` reads `captured === true` first; any other field is only trusted when this is set.
  Never accept a verdict from model prose ("I succeeded") — exit code + git diff + captured flag only.
- Per-dispatch `allowedWrites` is narrower than `scope_paths`: scope minus the frozen manifest minus
  test-runner config. An out-of-scope write (diff touches a file outside `allowedWrites`) = automatic
  gate failure before the hand completes.
- **Redact first, truncate second** — apply `redactDeep` before `truncateUpstreamError(≤500 chars)`.
  Reversing this order can leak tokens embedded near the truncation boundary.
- `isBenignCountTokens404(err)` absorbs count_tokens 404 (model doesn't support the endpoint) without
  failing the run. Treat all other 4xx/5xx from the external binary as hard errors.
- Frozen manifest = content-hash of every file the test-author created (test file + any fixtures).
  Executor `allowedWrites` must exclude every path in the manifest. A diff that touches a manifest
  path = automatic gate failure — the executor is read-only relative to the frozen test.
- `ANTHROPIC_AUTH_TOKEN` (and any secret from `.dev.vars`) must NEVER appear in the brief, in
  `shared_context.md`, in a commit, or in `hook.log`. `dispatch-hand.mjs` redacts it before logging;
  the brief channel carries only task description + scope + budget.
- The orchestrator NEVER inspects `.dev.vars` directly — no `cat`/`grep`/`head`/`node -e` against it
  to "check the token is set". The single canonical source of the token is `resolveAuthToken` /
  `spawn-hand.mjs`, which resolves env → project `.dev.vars` → global `~/.claude/.dev.vars` internally.
  The token is a GLOBAL credential (lives in `~/.claude/.dev.vars`); a project does not need its own
  `.dev.vars`. Reading the file directly is both pointless (the resolver already does it) and denied
  (`Read(.dev.vars)` baseline blocks any command whose text names the file, while the resolver's
  internal read is unaffected). Token presence is decided ONLY by `spawn-hand.mjs`'s `exit 2` + reason.
