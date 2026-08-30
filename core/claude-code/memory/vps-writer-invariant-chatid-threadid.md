---
name: vps-writer-invariant-chatid-threadid
description: Every writer of meta.threadId (today only core/shared/lib/obs-outbox.mjs — the Telegram drain was deleted in #834, see docs/vps-retirement.md) must also stamp meta.chatId in the same write — Telegram message_thread_id is per-chat, not globally unique, so a threadId without a matching chatId breaks any cross-tenant/cross-chat gate.
metadata:
  type: project
---

**Why:** Telegram's `message_thread_id` is unique **within a chat**, not globally. Any code that
persists a `threadId` without also persisting the `chatId` it was minted in creates a meta that a
later cross-tenant/cross-chat guard cannot correctly evaluate — a stale or wrong `chatId` paired with
a valid `threadId` can make a guard pass when it should fail closed (e.g. authorizing a delete against
the wrong chat, or matching an unrelated topic after a Telegram-group migration).

**How to apply:**

- `retention-sweep-delete-stale-topics` (#178) found and fixed the SECOND of two `threadId` writers:
  `setupObservability` (`cron-a-dispatch.mjs`, part of the **[RETIRED ENGINE]** deleted in #807 — see
  `docs/vps-retirement.md`) stamped `chatId` from `result.chatId` correctly, but the drain's self-heal
  recreation branch in `drainTelegramOutbox` (deleted in #834) persisted a
  new `threadId` on recreate without stamping the matching `chatId`. A migrate-away-and-back of the
  Telegram group would then leave `meta.chatId = A` paired with a `threadId` freshly minted in chat
  `B` — any cross-tenant gate keyed on `chatId` would pass and act on the wrong chat's topic.
- **Invariant:** `meta.chatId` must always describe the chat where the meta's CURRENT `threadId`
  lives. The live write surface is now ONLY `core/shared/lib/obs-outbox.mjs`
  (`updateMeta` — the SOLE writer of `threadId`/`status`); the second writer,
  `drainTelegramOutbox`'s self-heal recreation branch, was deleted with the notifier in #834
  (`docs/vps-retirement.md`), plus any future recreation path. Grep every `threadId` write site
  before adding a new one, and
  confirm each also stamps `chatId` from the SAME API result (`createForumTopic`'s `result.chatId`) —
  never from `config.notify.chatId`, which is `undefined` on the common `.dev.vars`-only deployment
  (see `vps-notify-telegram.md`).
- When adding a new `threadId`-minting path, add it to this invariant's "every writer" list in the
  same commit — the next reader of this file should not have to re-derive the full writer set from
  scratch.
