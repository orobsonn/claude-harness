# The hand family (operator toggle)

Which ladder the HANDS (executor, sniper) run on. Load this file when the operator asks to switch
families, when a dispatch fails with a token/ladder reason, or when you need the exact ladder.

## The two families

| family | low | medium | high | token key (env) |
|---|---|---|---|---|
| `claude` (default) | `haiku` | `sonnet` | `sonnet` + `--effort xhigh` | `CLAUDE_HAND_TOKEN` (from `claude setup-token`) |
| `ollama` (opt-in) | `gemma4` | `glm-5.2` | `kimi-k2.7-code` | `OLLAMA_HAND_TOKEN` |

The eyes are unaffected: no eye role ever resolves to a hand model, in either family.

## Switching

```bash
node .claude/shared/lib/hand-model-ladder.mjs show          # which family is active
node .claude/shared/lib/hand-model-ladder.mjs use ollama    # switch — operator ask only
```

The choice persists in the project at `.claude/hand-config/hands.json` (committed, so a headless
run sees it). Absent file → `claude`.

**Never** write `.claude/hand-config/` with Write/Edit — the plan-write gate denies it. A party
that can rewrite that file picks the ladder its own gate approves (and `test-runner.json`, beside
it, picks the command that proves its work green).

## Read at plan-write time, never at dispatch time

The toggle decides what a **new** plan may pin in `model_strategy.hand_tiers` — the plan-write gate
enforces equality with the active family's ladder (a flat `sonnet/sonnet/sonnet` is refused: three
rungs, one model, zero escalation). After that the **plan is the contract**: `spawn-hand` derives
the endpoint, the token key and the effort from the model ids already frozen into it. Flipping
families mid-delivery therefore never strands a run in flight — it only changes the next plan.

A tier missing from a plan's ladder falls back INSIDE that plan's own family (announced via
`modelFallbackUsed`), never across transports.

## Why both families need a token

The `claude` family authenticates with `CLAUDE_HAND_TOKEN` (mapped to `CLAUDE_CODE_OAUTH_TOKEN` in
the child env only), NOT by inheriting the operator's own Claude Code config. Measured on a real
child: a hand that inherits `~/.claude` also inherits its permission allowlist and
`additionalDirectories` — it runs `Bash` despite `--allowedTools Read,Write,Edit`, and writes
OUTSIDE the repo, where the capture rail (a git diff of the project) cannot see it. Keeping the
ephemeral `CLAUDE_CONFIG_DIR` for both families keeps that shut, and keeps the fail-closed
"no token → no hand" guard un-bypassable by an env var.

## Escalation

- `ollama`: LOW → MEDIUM → HIGH, then the **Claude hand fallback** (K=1, entry-gate ticket).
- `claude`: LOW (`haiku`) → MEDIUM (`sonnet`) → HIGH (`sonnet` at `--effort xhigh`). There is no
  rung above — the hand already IS Claude — so a HIGH-tier failure goes straight to the **critical
  exception** path, never a fourth dispatch.

## Failure messages you may see (exit 2, `configError`)

- `no CLAUDE_HAND_TOKEN resolved` / `no OLLAMA_HAND_TOKEN resolved` — the ACTIVE dispatch's family
  has no token. Fix: `claude setup-token` (claude) or an Ollama API key, exported in the shell rc.
  Env survives the command-sandbox; a value only in `.dev.vars` does not.
- `the active hand family is <x>` (on a planner Write) — the plan pinned the other family's ladder.
  Either pin the active one, or switch families before planning.
- `is not in an approved hand ladder` — an id outside both ladders. Changing a ladder is a code
  change (`shared/lib/hand-model-ladder.mjs`), never a plan change.
