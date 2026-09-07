# The hand family (operator toggle)

Which ladder the HANDS (executor, sniper) run on. Load this file when the operator asks to switch
families, when a dispatch fails with a token/ladder reason, or when you need the exact ladder.

## The two families

| family | low | medium | high | how it dispatches |
|---|---|---|---|---|
| `claude` (default) | `haiku` | `sonnet` | `sonnet` at `effort: xhigh` | `Agent` tool — an ordinary subagent, your own session auth, nothing to configure |
| `ollama` (opt-in) | `gemma4` | `glm-5.2` | `kimi-k2.7-code` | `spawn-hand.mjs` — isolated `claude -p` child, `OLLAMA_HAND_TOKEN`, frozen-test gate, independent capture |

The eyes are unaffected: no eye role ever resolves to a hand model, in either family.

## Dispatching on the `claude` family

The rung resolves to a subagent type plus a model override. The `Agent` tool takes a `model` but no
effort, so the rung whose escalation IS the effort has its own definition (`effort: xhigh` in the
frontmatter) — `executor-high` / `sniper-high`, whose instruction bodies are locked byte-identical
to their base roles by `core/__tests__/hand-rung-agents.test.mjs`.

| tier | dispatch |
|---|---|
| low | `Agent(executor, model: "haiku")` |
| medium | `Agent(executor, model: "sonnet")` |
| high | `Agent(executor-high)` — model and effort both come from the definition |

`descriptor-emitter.mjs`'s `resolveExecutorModel` / `resolveSniperModel` still do the tier
arithmetic and now return `agent_type` alongside `model`, so the orchestrator never picks the
subagent by hand. There is **no descriptor and no run-record** on this path: the emitter REFUSES to
write one for a claude-family rung (its only consumer, `spawn-hand`, would refuse it anyway).

**What this path does NOT have** — say it plainly: the frozen-test Stop hook, the independent
capture and the `capturedVerifiedAt` stamp are properties of the spawn path. On the Agent path the
executor is still gated by the fidelity rail (it cannot run before the test-author's RED locked
test exists), and the orchestrator still runs the frozen test itself at the checkpoint — but the
"never believe the hand's prose" machinery is the ollama family's. This is the same trade the
harness already makes in headless.

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

## Why the claude family is NOT a spawned child

It was built that way first, and measured: to authenticate a spawned `claude -p` child on the
operator's subscription you must either hand it a token or let it inherit `~/.claude`. Inheriting
is not an option — a child that inherits the operator's config also inherits its permission
allowlist and `additionalDirectories`, and was observed running `Bash` despite
`--allowedTools Read,Write,Edit` and writing OUTSIDE the repo, where a git-diff capture cannot see
it. And a token means an API credential the operator does not want to manage. An ordinary subagent
needs neither: it runs on the session that is already authenticated, under the harness's own hooks.

## Escalation

- `ollama`: LOW → MEDIUM → HIGH, then the **Claude hand fallback** (K=1, entry-gate ticket).
- `claude`: LOW (`haiku`) → MEDIUM (`sonnet`) → HIGH (`sonnet` at `effort: xhigh`). There is no
  rung above — the hand already IS Claude — so a HIGH-tier failure goes straight to the **critical
  exception** path, never a fourth dispatch.

## Failure messages you may see (exit 2, `configError`)

- `no OLLAMA_HAND_TOKEN resolved` — the ollama family has no token. Fix: export an Ollama API key
  in the shell rc. Env survives the command-sandbox; a value only in `.dev.vars` does not.
- `dispatches as an ordinary Agent subagent` (from `spawn-hand` or the descriptor-emitter) — a
  claude-family rung was routed to the spawn path. Dispatch it with the `Agent` tool instead.
- `the active hand family is <x>` (on a planner Write) — the plan pinned the other family's ladder.
  Either pin the active one, or switch families before planning.
- `is not in an approved hand ladder` — an id outside both ladders. Changing a ladder is a code
  change (`shared/lib/hand-model-ladder.mjs`), never a plan change.
