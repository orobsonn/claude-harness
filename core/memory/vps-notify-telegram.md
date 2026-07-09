# VPS cron notify — Telegram one-way (`core/vps/notify-telegram.mjs`)

Durable patterns from the `vps-notify-telegram` feature (v0.22.0). **Promoted to `core/` (tracked) on
2026-07-09 by the `retention-sweep-delete-stale-topics` (#178) harvest** — this topic previously
existed only in the gitignored `.claude/memory/` dogfood mirror and was invisible to CI/fresh-clone/PR
review. See `core/kaizen.md`'s dogfood-mirror-drift entry for the general gap this closes.

## Best-effort / fail-open notify pattern (reusable for any cron-side side effect)

- `makeNotifier(config, deps)` returns `{ notify, drain, enabled, heartbeat }`. `notify(event)` is
  **fire-and-forget** — it starts the send and pushes the (already-swallowed) promise into a
  `pending` Set WITHOUT blocking the cron's critical path. `drain()` = `Promise.allSettled(pending)`
  is awaited by the CLI `main*` wrapper in a `finally` before the short-lived cron process exits, so
  notifications are not dropped on exit (bounded by the send timeout).
- The whole send body (`sendNotification`) is inside a single try/catch AND feature-detects
  `fetch` + `AbortSignal.timeout` (Node ≥18) → returns `{sent:false, reason:"runtime-unsupported"}`
  instead of throwing a ReferenceError that could become an unhandledRejection and crash the cron
  process that does real PR merges / lock releases. NEVER retries (429 swallowed).
- Every root wraps its `notify(event)` in try/catch too, and each `isMain` async wrapper ends with
  `.catch(...)` (mirror `cron-a-exit.mjs`). Roots take `deps.notify ?? (() => {})` (a no-op default)
  so injected spies are observable in tests and an unconfigured project is byte-identical.

## Secret hygiene (the token never leaves the box)

- `TELEGRAM_BOT_TOKEN` lives ONLY in `~/.claude/.dev.vars`, read at send time via the exported
  `parseDevVars` from `scoped-env.mjs` (do NOT hand-roll a second env parser). It is NEVER in the
  config, crontab, argv, or any log. A send failure logs ONLY `{op,type,project,status}` — never
  `err.message`/stack (the `/bot<token>/` URL would leak), never the URL/body/chat_id.

## How notify config reaches the DETACHED cron-a-exit session (non-obvious)

- `cron-a-exit` runs inside the tmux session AFTER `claude -p`, in the same shell that already did
  `set -a; . <envfile>; set +a`. So `dispatch` writes the **non-secret** `HARNESS_NOTIFY_CHATID/
  THREADID/PROJECT` into that env-file and `cron-a-exit`'s `notifyExit` reads them from `process.env`
  (+ the token from disk). The token is NEVER threaded through the env-file/argv. No `--config` flag
  change to the session command was needed.

## install-crons frozen-oracle rule (repeats a prior gotcha)

- `generateProjectConfig` has exact-key frozen tests — do NOT add `notify` inside it. Layer the
  optional `notify` block AFTER the call (in `installProject`) and into the fleet base (in
  `reconcileFleet`). `validateInstallCoordinates` validates `notify:{chatId,threadId,heartbeat}`
  (numeric/boolean). See [[harness-repo-constraints]].

## Additive-return wiring (pure logic → root translates)

- The pure cron functions gained ADDITIVE returns the roots translate to events: `cronAExit` →
  `{outcome,issueNumber,hadPr,finding}`; `cronB` → `[{number,outcome:merged|blocked,finding?,url}]`;
  `reaper` → `[{project,issueNumber,action}]`. Their existing tests assert on recorded calls, never
  on the return, so additive returns are frozen-oracle-safe. Reaper's `<project>` prefix comes from
  the per-worktree action entry (shared cron over many projects), never a single fleet value.

## Producer/consumer event-shape is an implicit cross-task contract (vps-run-observability, 2026-07-06)

- The per-run observability outbox has MANY producers (per-task emitters landing in separate plan
  tasks) and ONE renderer (`notify-telegram.mjs` formats each checkpoint's text). Every producer's
  event `type` needs a matching renderer case, and every producer's field NAMES/CASING must match what
  the renderer reads — this recurred **three separate times in one delivery**: (1) task-6's producer
  emitted `{type:'task-executing', n, total}` while the already-shipped consumer read `event.task`
  (checkpoint arrived empty); (2) task-9's producer used `'PR'` where the renderer's switch matched
  `'pr'` (content-free done-ping, link lost); (3) the feature-wide final review found the SAME
  casing/shape bug in 3 MORE types (`pipeline-type`/`hand-ran`/`eye`) that no single per-task review
  had scope to see.
- **A FOURTH recurrence, in `retention-sweep-delete-stale-topics` (#178):** the `reaper-permission-check`
  event — the operator's ONLY signal that retention is silently failing on a missing
  `can_delete_messages` right — had no `formatEvent` case and rendered as the raw fallback
  `🔔 [?] reaper-permission-check` instead of an actionable pt-br line. Caught only by the
  feature-wide final adversary review, not by the per-task frozen test (which asserted the event was
  SENT, never that it rendered non-generically). This is exactly the class this section already
  documents — recorded here again because it recurred a run after this file existed, just in the
  gitignored mirror where the next feature's context could not see it.
- **Why per-task frozen tests miss it:** the locked test typically asserts the event was SENT (the
  Telegram API mock received a call), never that the RENDERED TEXT is correct/non-empty for that
  specific type. A producer/consumer pair can be green on both sides independently while the
  operator-facing message is silently blank or garbled.
- **How to apply next time this file (or its producers) change:** (1) pin the full event-type ↔
  renderer-case enumeration in ONE place (this file, or a table in `notify-telegram.mjs`'s own
  header) that both a new producer task and the renderer's tests must reference; (2) when
  adding/changing a producer type mid-feature, add a render-assertion test (not just a
  send-assertion) for that type; (3) at final review, enumerate ALL emitted event types across ALL
  tasks and confirm each has a non-empty rendered case — a per-task review cannot, by construction,
  see the full producer set; only a feature-wide enumeration does.
