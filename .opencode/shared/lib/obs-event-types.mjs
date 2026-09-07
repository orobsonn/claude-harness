/**
 * @description The shared observability event-type vocabulary. Originally the `FEED_ALLOWLIST` that
 * `core/opencode/lib/obs-emit.mjs` and `orchestrating-delivery/SKILL.md` pointed at was documented
 * but never actually defined anywhere — the real constant, `CURATED_FEED_TYPES`, lived unexported
 * inside `core/notify/notify-telegram.mjs`, the Telegram checkpoint renderer that consumed it. That
 * renderer was retired in #834 (no production caller survived the cron engine's removal — see
 * docs/vps-retirement.md) and deleted along with `core/notify/scoped-env.mjs`.
 *
 * The renderer is gone, but the vocabulary it enforced is still real: it is the AGREEMENT between
 * the two shells' independent producers of these event-type strings (`core/claude-code/hooks/
 * stamp-triage.mjs`, `core/opencode/lib/obs-emit.mjs`, and the other producers that stamp into
 * `core/shared/lib/obs-outbox.mjs`) that they emit identical, curated type names. This module is
 * that contract's new, shell-neutral, zero-dep home — inert data with no secret, unlike
 * `notify-telegram.mjs`, which was kept out of `core/shared/` precisely because it read
 * `TELEGRAM_BOT_TOKEN`.
 *
 * IMPORTANT: this module currently has NO consumer that reads the outbox — the observability outbox
 * (`core/shared/lib/obs-outbox.mjs`) now has producers and zero readers in this repo. That is a
 * known, deliberate, out-of-scope consequence of #834 (obs-outbox itself is explicitly out of that
 * issue's scope), not an oversight to "fix" by re-adding a renderer. This module is mirrored into
 * every vendored project (it lands at `.claude/shared/lib/obs-event-types.mjs`) with no importer
 * there either — it earns its place solely because `obs-emit.mjs`'s doc comment must resolve inside
 * a vendored tree, and because `core/__tests__/obs-event-vocabulary.test.mjs` imports it in-repo to
 * keep both shells' producers honest. If a future reader is added, name it here.
 */

/** @description The curated per-run checkpoint vocabulary. Kept verbatim from the retired
 * `CURATED_FEED_TYPES` (`core/notify/notify-telegram.mjs`, pre-#834). Two audit-only types are
 * deliberately NOT members: `regate-pending` (an audit record, never rendered) and `eye`, whose
 * curation is conditional on `event.role` (see `EYE_CURATED_ROLES` below) rather than a flat type
 * membership. */
export const CURATED_EVENT_TYPES = new Set([
  "attempt-started",
  "picked",
  "pipeline-type",
  "spec-created",
  "spec-adversary",
  "spec-adversaried",
  "plan-created",
  "plan-reviewed",
  "task-executing",
  "hand-ran",
  "sniper-ran",
  "gates-ran",
  "final-review-done",
  "pr",
]);

/** @description The `eye` roles curated into the per-task feed (compliance/adversary/security). A
 * `plan-reviewer` eye (or any other/unknown role) is deliberately excluded — its verdict already
 * has a dedicated `plan-reviewed` checkpoint, so a raw `eye` line would duplicate the same fact. */
export const EYE_CURATED_ROLES = new Set(["compliance", "adversary", "security"]);
