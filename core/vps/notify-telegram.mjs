/**
 * @description VPS cron harness — one-way Telegram NOTIFICATION module. Zero-dep (Node builtins
 * only). It only NOTIFIES the operator of key lifecycle events (issue picked, PR opened/merged,
 * something needs attention) in a shared group topic — there is NO inbound control. The whole
 * module is best-effort and FAIL-OPEN: a notification failure (missing token, wrong config,
 * Telegram down, 429, timeout, unsupported runtime) NEVER throws and NEVER retries, so it can
 * never crash or delay a cron.
 *
 * Runtime contract (Node ≥18 for global fetch + AbortSignal.timeout): the send path
 * feature-detects both and degrades to a no-op {sent:false, reason:"runtime-unsupported"} on an
 * older runtime rather than throwing a ReferenceError that could become an unhandledRejection.
 *
 * Secret hygiene (non-negotiable): the bot token lives ONLY in ~/.claude/.dev.vars as
 * TELEGRAM_BOT_TOKEN, read from disk at send time. It is NEVER placed in the generated config, the
 * crontab, argv, or any log line — a failure logs ONLY { op, type, project, status }, never the
 * body, the URL (which carries `/bot<token>/`), the token, or the chat_id.
 */
import { join } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";

import { parseDevVars } from "./scoped-env.mjs";
import {
  readEvents as defaultReadEvents,
  readMeta as defaultReadMeta,
  advanceCursor as defaultAdvanceCursor,
  updateMeta as defaultUpdateMeta,
  appendEvent as defaultAppendEvent,
} from "./obs-outbox.mjs";

const TELEGRAM_API = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TEXT = 80;
const TOPIC_NAME_MAX_CODE_POINTS = 128;
/** @description Hard cap on the inter-send pacing delay so a bad `sendDelayMs` can never hang the
 * drain (and thus the cron) unbounded — the cron's exposure to a mid-drain kill stays bounded. */
const MAX_SEND_DELAY_MS = 3000;

/**
 * @description Default bounded sleep used to space out Telegram sends. Zero-dep (setTimeout), never
 * throws. `ms` is clamped to [0, MAX_SEND_DELAY_MS]; ≤0 resolves immediately with no timer. The timer
 * is NOT unref'd on purpose: this sleep sits on the drain's critical path (it is awaited between
 * sends), so it must keep the short-lived cron process alive until it resolves — otherwise node could
 * exit mid-pace and truncate the remaining sends. The ≤3s clamp bounds how long it can hold the loop.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const bounded = Math.min(Math.max(0, Number(ms) || 0), MAX_SEND_DELAY_MS);
    if (bounded <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, bounded);
  });
}

/** @description Event types that must ping the shared main topic before any cosmetic progress. */
const CRITICAL_TYPES = new Set(["blocked", "failed"]);

/** @description Status emoji per event type; a shared destination gets a scannable glyph. */
const EMOJI = {
  idle: "💤",
  picked: "🎯",
  "dispatch-failed": "⚠️",
  "session-done": "✅",
  "session-requeued": "🔁",
  blocked: "🚧",
  failed: "❌",
  "review-started": "🔍",
  "pr-merged": "🟢",
  "pr-awaiting-merge": "🟡",
  "pr-blocked": "🔴",
  "reaper-killed": "⏱️",
  "reaper-recovered": "♻️",
  "reaper-orphan-cleaned": "🧹",
  "chain-released": "🔗",
  "chain-stranded": "⛓️‍💥",
  "pipeline-type": "🚀",
  "spec-created": "📝",
  "spec-adversary": "🛡️",
  "plan-created": "📋",
  "plan-reviewed": "🧐",
  "task-executing": "⚙️",
  "final-review-done": "🏁",
  "hand-ran": "✋",
  eye: "👁️",
  "regate-pending": "🔒",
  pr: "🔗",
};

/**
 * @description Escapes the three HTML-significant characters for `parse_mode:"HTML"`. Applied to
 * EVERY interpolated dynamic value (project, title, reason) so a title like `a<b&c` can never
 * inject markup or break the message.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @description Truncates a string to `max` chars with an ellipsis so no unbounded body/title/reason
 * text ever reaches a message.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function truncate(value, max = MAX_TEXT) {
  const s = String(value);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * @description Truncates a string to at most `max` Unicode CODE POINTS (not UTF-16 code units), with
 * NO ellipsis — the topic NAME contract demands exactly the first `max` code points. Used only for
 * the forum-topic name, which is plain text and MUST NOT be HTML-escaped.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function truncateCodePoints(value, max) {
  return Array.from(String(value ?? "")).slice(0, max).join("");
}

/**
 * @description Truncates a string to at most `max` Unicode CODE POINTS (not UTF-16 code units),
 * adding an ellipsis when truncated. Same approach as `truncateCodePoints` to avoid splitting
 * surrogate pairs, but keeps the ≤80 bound used by the checkpoint body.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function truncateByCodePoints(value, max = MAX_TEXT) {
  const points = Array.from(String(value ?? ""));
  return points.length <= max ? points.join("") : `${points.slice(0, max - 1).join("")}…`;
}

/**
 * @description Renders a `#<ref>` as an HTML link when a url is present, else plain (both escaped).
 * @param {number|string} ref
 * @param {string} [url]
 * @returns {string}
 */
function refLink(ref, url) {
  const label = `#${ref}`;
  return url ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

/**
 * @description Extracts a short one-line "what is being implemented" summary from an issue body:
 * the first substantive prose line, skipping markdown headers (`#`), bold metadata (`**Source:**`)
 * and bare list markers, with emphasis/backticks stripped and truncated. '' when nothing suitable.
 * @param {string} body
 * @param {number} [max]
 * @returns {string}
 */
export function summarizeIssueBody(body, max = 180) {
  for (const raw of String(body ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue; // blank / markdown header
    if (line.startsWith("**")) continue; // bold metadata (**Source:**, **Tier 3** —, **needs-investigation**)
    const clean = line.replace(/^[-*]\s+/, "").replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (clean.length >= 12) return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  }
  return "";
}

/**
 * @description PURE. Builds the short HTML message string for an event — `<emoji> [<project>]
 * <line>`. Multi-project safe: the `[<project>]` prefix is always present. Carries no issue body,
 * no secret, no token, no chat_id. Dynamic text is HTML-escaped and length-bounded.
 * @param {object} event
 * @param {string} event.type - One of the taxonomy keys (see EMOJI).
 * @param {string} event.project - Project slug (prefix).
 * @param {number} [event.issue] - Issue number.
 * @param {string} [event.issueTitle] - Issue title (truncated ≤80, escaped).
 * @param {number} [event.pr] - PR number.
 * @param {string} [event.reason] - Short reason (truncated ≤80, escaped).
 * @param {string} [event.url] - GitHub link (rendered as `<a href>`).
 * @param {string} [event.mergeSha] - Merge commit SHA (appended as a one-line revert instruction for pr-merged).
 * @returns {string}
 */
export function formatEvent(event = {}) {
  const { type, project } = event;
  const emoji = EMOJI[type] ?? "🔔";
  const prefix = `${emoji} [${escapeHtml(project ?? "?")}]`;
  const issueRef = event.issue != null ? refLink(event.issue, event.url) : null;
  const prRef = event.pr != null ? refLink(event.pr, event.url) : null;
  const title = event.issueTitle ? ` “${escapeHtml(truncate(event.issueTitle))}”` : "";
  const reason = event.reason ? `: ${escapeHtml(truncate(event.reason))}` : "";

  switch (type) {
    case "idle":
      return `${prefix} nenhuma issue pronta — nada a fazer`;
    case "picked": {
      const summaryLine = event.summary ? `\n<i>${escapeHtml(truncate(event.summary, 180))}</i>` : "";
      return `${prefix} pegou issue ${issueRef}${title} — sessão iniciada${summaryLine}`;
    }
    case "dispatch-failed":
      return `${prefix} falha ao despachar issue ${issueRef} — re-enfileirada`;
    case "session-done":
      return `${prefix} issue ${issueRef} concluída → PR ${prRef ?? "aberto"}`;
    case "session-requeued":
      return `${prefix} issue ${issueRef} — sessão terminou sem PR, re-enfileirada pra nova tentativa`;
    case "blocked":
      return `${prefix} issue ${issueRef} BLOQUEADA — precisa de input humano${reason}`;
    case "failed":
      return `${prefix} issue ${issueRef} falhou — retentativas esgotadas`;
    case "review-started":
      return `${prefix} revisando PR ${prRef} — análise independente iniciada (olhos frescos)`;
    case "pr-merged": {
      const revert = event.mergeSha ? `\ngit revert -m 1 ${escapeHtml(event.mergeSha)}` : "";
      return `${prefix} PR ${prRef} revisado CLEAN → merged${revert}`;
    }
    case "pr-awaiting-merge":
      return `${prefix} PR ${prRef} revisado CLEAN → aguardando seu merge manual${reason}`;
    case "pr-blocked":
      return `${prefix} PR ${prRef} BLOQUEADO${reason}`;
    case "reaper-killed":
      return `${prefix} sessão da issue ${issueRef} morta pelo watchdog`;
    case "reaper-recovered":
      return `${prefix} run da issue ${issueRef} recuperado de crash`;
    case "reaper-orphan-cleaned":
      return `${prefix} worktree órfão da issue ${issueRef} limpo`;
    case "chain-released": {
      const deps = Array.isArray(event.deps) && event.deps.length ? ` (dependências #${event.deps.join(", #")} merjadas)` : "";
      return `${prefix} issue ${issueRef} liberada da fila → pronta pra execução${deps}`;
    }
    case "chain-stranded": {
      const deps = Array.isArray(event.deps) && event.deps.length ? ` (depende de #${event.deps.join(", #")})` : "";
      return `${prefix} issue ${issueRef} encalhada — uma dependência morreu (blocked)${deps}; a corrente abaixo dela não avança`;
    }
    default:
      return `${prefix} ${escapeHtml(type ?? "evento")}`;
  }
}

/**
 * @description Best-effort one-shot send. NEVER throws, NEVER retries. Resolves the fetch impl
 * from the injected seam or global fetch; if neither exists (or AbortSignal.timeout is missing) →
 * `{sent:false, reason:"runtime-unsupported"}` with no network call. Without a token+chatId →
 * `{sent:false, reason:"not-configured"}` with no network call. Otherwise POSTs the Telegram
 * sendMessage payload under an AbortSignal.timeout; any error / non-2xx logs ONLY
 * `{ op, type, project, status }` and returns `{sent:false, reason}`.
 * @param {object} event
 * @param {object} [opts]
 * @param {{ token: string, chatId: number|string, threadId?: number|string }} [opts.config]
 * @param {typeof fetch} [opts.fetch] - Injected fetch (tests pass a fake; prod uses global fetch).
 * @param {(entry: object) => void} [opts.log] - Internal logger (redacted payload only).
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendNotification(event = {}, opts = {}) {
  const { config, fetch: fetchImpl, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const type = event?.type;
  const project = event?.project;

  const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  const canTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
  if (typeof doFetch !== "function" || !canTimeout) {
    return { sent: false, reason: "runtime-unsupported" };
  }

  if (!config || !config.token || config.chatId == null || config.chatId === "") {
    return { sent: false, reason: "not-configured" };
  }

  try {
    const url = `${TELEGRAM_API}/bot${config.token}/sendMessage`;
    const payload = {
      chat_id: config.chatId,
      message_thread_id: config.threadId,
      // Legacy events ride the unified renderer shape (<b>UPPERCASE TITLE</b>\n\n<i>body</i>) so the
      // border/ping path honors the LOCKED format. formatEvent already HTML-escapes its dynamic values
      // AND renders intentional <a href> links, so its output is inserted verbatim — never re-escaped
      // or run through the body truncator.
      text: `<b>${escapeHtml(String(type ?? "evento").toUpperCase())}</b>\n\n<i>${formatEvent(event)}</i>`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) {
      const status = res && res.status != null ? res.status : "no-response";
      log({ op: "notify", type, project, status });
      return { sent: false, reason: `status-${status}` };
    }
    return { sent: true };
  } catch {
    // NEVER log the error message/stack (could carry the URL with the token) or the URL/body/token.
    log({ op: "notify", type, project, status: "error" });
    return { sent: false, reason: "error" };
  }
}

/**
 * @description Default safe file reader — returns '' on any error (missing/unreadable file). Mirror
 * of scoped-env-fromdisk's readFileSafe so a missing ~/.claude/.dev.vars never throws.
 * @param {string} path
 * @returns {string}
 */
function defaultReadFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * @description Reads the Telegram bot token from `~/.claude/.dev.vars` at runtime, reusing the
 * canonical parseDevVars from scoped-env.mjs (no second env parser). Returns '' when absent or on
 * any error — never throws. The token lives ONLY here at send time.
 * @param {object} opts
 * @param {string} opts.homeDir - Operator home dir (where ~/.claude/.dev.vars lives).
 * @param {(path: string) => string} [opts.readFileSafe]
 * @returns {string}
 */
export function readTelegramToken({ homeDir, readFileSafe = defaultReadFileSafe }) {
  try {
    const content = readFileSafe(join(homeDir ?? "", ".claude", ".dev.vars"));
    return parseDevVars(content)["TELEGRAM_BOT_TOKEN"] || "";
  } catch {
    return "";
  }
}

/**
 * @description Resolves the effective notify config from a project/fleet config's
 * `notify:{ chatId, threadId, heartbeat? }` block plus the disk token. Returns null (→ the notifier
 * becomes a no-op) when notify is absent, chatId is missing, or the token is empty.
 * @param {object} config
 * @param {object} deps
 * @param {string} deps.homeDir
 * @param {(path: string) => string} [deps.readFileSafe]
 * @returns {{ chatId: number|string, threadId?: number|string, token: string, heartbeat: boolean } | null}
 */
export function resolveNotifyConfig(config, deps = {}) {
  const readFileSafe = deps.readFileSafe ?? defaultReadFileSafe;
  let vars = {};
  try {
    vars = parseDevVars(readFileSafe(join(deps.homeDir ?? "", ".claude", ".dev.vars")));
  } catch {
    vars = {};
  }
  const token = vars.TELEGRAM_BOT_TOKEN || "";
  if (!token) {
    return null;
  }
  // chatId/threadId: the per-project config.notify wins; otherwise fall back to ~/.claude/.dev.vars
  // (TELEGRAM_CHAT_ID / TELEGRAM_THREAD_ID) so putting ALL Telegram values in .dev.vars just works —
  // the operator does not have to duplicate the destination into every project config.
  const notify = config?.notify ?? {};
  const chatId =
    notify.chatId != null && notify.chatId !== ""
      ? notify.chatId
      : vars.TELEGRAM_CHAT_ID !== undefined && vars.TELEGRAM_CHAT_ID !== ""
        ? Number(vars.TELEGRAM_CHAT_ID)
        : undefined;
  if (chatId == null || Number.isNaN(chatId)) {
    return null;
  }
  const threadId =
    notify.threadId != null && notify.threadId !== ""
      ? notify.threadId
      : vars.TELEGRAM_THREAD_ID
        ? Number(vars.TELEGRAM_THREAD_ID)
        : undefined;
  // Heartbeat (the "nada a fazer" idle ping) defaults ON — opt-OUT via an explicit `heartbeat: false`.
  const heartbeat = notify.heartbeat !== false;
  return { chatId, threadId, token, heartbeat };
}

/**
 * @description Builds the bound notifier used by the composition roots. Resolves the notify config
 * ONCE; when unconfigured returns a no-op `{ notify, drain, enabled:false }` so the engine is
 * byte-identically unaffected. `notify(event)` is fire-and-forget — it starts the send and pushes
 * the (already-swallowed) promise into a pending set WITHOUT blocking the cron's critical path;
 * `drain()` = Promise.allSettled(pending) is awaited by the CLI main wrapper before the short-lived
 * cron process exits (bounded by the send timeout) so notifications are not dropped on exit.
 * @param {object} config
 * @param {object} [deps]
 * @param {string} [deps.homeDir] - Defaults to config.homeDir.
 * @param {(path: string) => string} [deps.readFileSafe]
 * @param {typeof fetch} [deps.fetch]
 * @param {(entry: object) => void} [deps.log]
 * @param {number} [deps.timeoutMs]
 * @returns {{ notify: (event: object) => Promise<void>, drain: () => Promise<unknown>, drainOutbox: (opts?: object) => Promise<void>, enabled: boolean, heartbeat: boolean, config: object }}
 */
export function makeNotifier(config, deps = {}) {
  const homeDir = deps.homeDir ?? config?.homeDir;
  let resolved = null;
  try {
    resolved = resolveNotifyConfig(config, { homeDir, readFileSafe: deps.readFileSafe });
  } catch {
    resolved = null;
  }

  if (!resolved) {
    return {
      notify: async () => {},
      drain: async () => {},
      drainOutbox: async () => {},
      enabled: false,
      heartbeat: false,
      config: null,
    };
  }

  const pending = new Set();
  const notify = (event) => {
    const p = (async () => {
      try {
        await sendNotification(event, {
          config: resolved,
          fetch: deps.fetch,
          log: deps.log,
          timeoutMs: deps.timeoutMs,
        });
      } catch {
        // belt-and-suspenders: sendNotification already never throws, but a notify() must be
        // impossible to reject so a fire-and-forget call can never become an unhandledRejection.
      }
    })();
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };

  const send = async ({ event, text, chatId: msgChatId, threadId: msgThreadId }) => {
    const result = await sendRenderedMessage({
      config: { token: resolved.token, chatId: msgChatId, threadId: msgThreadId },
      text,
      fetch: deps.fetch,
      log: deps.log,
      timeoutMs: deps.timeoutMs,
    });
    return { sent: result.ok };
  };

  const drainOutbox = (drainOpts = {}) =>
    drainTelegramOutbox(
      {
        stateDir: drainOpts.stateDir ?? config?.stateDir,
        homeDir: drainOpts.homeDir ?? homeDir,
        chatId: drainOpts.chatId ?? resolved.chatId,
        threadId: drainOpts.threadId ?? resolved.threadId,
        limitPerMinute: drainOpts.limitPerMinute ?? resolved.limitPerMinute ?? 20,
        sendDelayMs: drainOpts.sendDelayMs ?? resolved.sendDelayMs ?? 0,
      },
      {
        readEvents: defaultReadEvents,
        readMeta: defaultReadMeta,
        advanceCursor: defaultAdvanceCursor,
        updateMeta: defaultUpdateMeta,
        appendEvent: defaultAppendEvent,
        send,
      },
    );

  return {
    notify,
    drain: () => Promise.allSettled([...pending]),
    drainOutbox,
    enabled: true,
    heartbeat: resolved.heartbeat,
    config: resolved,
  };
}

// --- task-1: unified checkpoint renderer + forum-topic wrappers.
// Invariants preserved: zero-dep (Node builtins), fail-open (never throw/retry/delay), token only
// from the injected config (read off disk upstream), a failure logs ONLY { op, type, status }.

/**
 * @description PURE. Renders a checkpoint as a SINGLE line: a bold `<emoji> <label>` title followed
 * by ` — <info>` when the body carries any info (`🚀 Classificação — modo LIGHT`), or the title
 * alone when it does not (`📝 Spec criada`). The title keeps its natural case (it already carries the
 * emoji + pt-br label from `checkpointTitle`). Every body line is HTML-escaped and length-bounded
 * (≤80 code points); empty lines are dropped so the ` — ` joiner never doubles. This is the single
 * source of the checkpoint shape — the critical path routes through it too.
 * @param {{ title: string, bodyLines: string[] }} input
 * @returns {string}
 */
export function renderCheckpoint({ title, bodyLines } = {}) {
  const head = `<b>${escapeHtml(String(title ?? ""))}</b>`;
  const lines = Array.isArray(bodyLines) ? bodyLines : [];
  const info = lines
    .map((line) => truncateByCodePoints(line))
    .filter((line) => line.length > 0)
    .map((line) => escapeHtml(line))
    .join(" — ");
  return info ? `${head} — ${info}` : head;
}

/**
 * @description Shared best-effort one-shot POST for the forum-topic methods. NEVER throws, NEVER
 * retries. Mirrors sendNotification's seam (injected fetch/log) and runtime/abort feature-detect.
 * Without fetch+AbortSignal.timeout or without token+chatId → `{ ok:false }` with no network call.
 * Any error / non-2xx logs ONLY `{ op, type, status }` — never the URL (carries `/bot<token>/`),
 * token, or body. Resolves to `{ ok:true, data }` on 2xx (data is the parsed Telegram response).
 * @param {string} method - Telegram Bot API method name (`createForumTopic` / `closeForumTopic`).
 * @param {object} payload - Request body (chat_id + method-specific fields).
 * @param {object} opts - { config, fetch, log, timeoutMs }.
 * @param {string} op - Redacted op label for the failure log.
 * @returns {Promise<{ ok: boolean, data?: object }>}
 */
async function callTelegramMethod(method, payload, opts = {}, op) {
  const { config, fetch: fetchImpl, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  const canTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
  if (
    typeof doFetch !== "function" ||
    !canTimeout ||
    !config ||
    !config.token ||
    config.chatId == null ||
    config.chatId === ""
  ) {
    return { ok: false };
  }
  try {
    const url = `${TELEGRAM_API}/bot${config.token}/${method}`;
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) {
      const status = res && res.status != null ? res.status : "no-response";
      log({ op, type: "forum-topic", status });
      return { ok: false };
    }
    const data = typeof res.json === "function" ? await res.json() : {};
    return { ok: true, data };
  } catch {
    // NEVER log the error message/stack (the rejecting fake in tests carries the token+URL in it).
    log({ op, type: "forum-topic", status: "error" });
    return { ok: false };
  }
}

/**
 * @description Wraps Telegram `createForumTopic`. The NAME is PLAIN TEXT: truncated to ≤128 code
 * points and NEVER HTML-escaped (Telegram does not parse_mode the topic name). Fail-open: any error
 * → `{ ok:false }`, never throws. On success resolves `{ ok:true, threadId }` with the new topic's
 * message_thread_id.
 * @param {{ name: string }} input
 * @param {object} opts - { config, fetch, log, timeoutMs }.
 * @returns {Promise<{ ok: boolean, threadId?: number }>}
 */
export async function createForumTopic({ name } = {}, opts = {}) {
  const payload = {
    chat_id: opts?.config?.chatId,
    name: truncateCodePoints(name, TOPIC_NAME_MAX_CODE_POINTS),
  };
  const result = await callTelegramMethod("createForumTopic", payload, opts, "createForumTopic");
  if (!result.ok) {
    return { ok: false };
  }
  return { ok: true, threadId: result.data?.result?.message_thread_id };
}

/**
 * @description Wraps Telegram `closeForumTopic`. Fail-open: any error → `{ ok:false }`, never
 * throws. On success resolves `{ ok:true }`.
 * @param {{ threadId: number|string }} input
 * @param {object} opts - { config, fetch, log, timeoutMs }.
 * @returns {Promise<{ ok: boolean }>}
 */
export async function closeForumTopic({ threadId } = {}, opts = {}) {
  const payload = {
    chat_id: opts?.config?.chatId,
    message_thread_id: threadId,
  };
  const result = await callTelegramMethod("closeForumTopic", payload, opts, "closeForumTopic");
  return result.ok ? { ok: true } : { ok: false };
}

// --- task-5: cron-side outbox drain.
// Invariants preserved: zero-dep, fail-open (never throw/retry/delay a cron), token only from the
// resolved notify config, a failure logs only { op, type, status }.

/** @description Simple per-minute token bucket for outbound Telegram sends. */
const outboxRateLimiter = { limit: 0, tokens: 0, lastRefill: 0 };

/** @description Refills the per-minute send budget from the module-global token bucket. */
function refillBudget(limitPerMinute) {
  if (typeof limitPerMinute !== "number" || limitPerMinute <= 0) return Infinity;
  const now = Date.now();
  if (outboxRateLimiter.limit !== limitPerMinute) {
    outboxRateLimiter.limit = limitPerMinute;
    outboxRateLimiter.tokens = limitPerMinute;
    outboxRateLimiter.lastRefill = now;
    return limitPerMinute;
  }
  const elapsedMinutes = (now - outboxRateLimiter.lastRefill) / 60000;
  outboxRateLimiter.tokens = Math.min(
    limitPerMinute,
    outboxRateLimiter.tokens + elapsedMinutes * limitPerMinute,
  );
  outboxRateLimiter.lastRefill = now;
  return Math.floor(outboxRateLimiter.tokens);
}

/** @description Consumes one token from the module-global send bucket (no-op when empty). */
function consumeBudget() {
  if (outboxRateLimiter.tokens > 0) outboxRateLimiter.tokens -= 1;
}

/**
 * @description The curated per-run checkpoint feed: ONLY these types reach the Telegram topic. The
 * operator's wished milestones — session start, classify, spec, spec-adversary, plan, plan
 * review/approval, task loop, models per task (hand-ran), final review, PR. Everything else in the
 * outbox (raw `eye`, `regate-pending`, and any lifecycle/reaper/chain events) is audit-only:
 * suppressed at DRAIN/RENDER time, never at append time (the JSONL stays the full audit trail;
 * `criticalSent`/`cursor` indices are positional and must not be renumbered).
 */
const CURATED_FEED_TYPES = new Set([
  "picked",
  "pipeline-type",
  "spec-created",
  "spec-adversary",
  "plan-created",
  "plan-reviewed",
  "task-executing",
  "hand-ran",
  "final-review-done",
  "pr",
]);

/** @description True when an event belongs in the curated Telegram feed (case-insensitive). */
function isCuratedFeedEvent(event) {
  const type = String(event?.type ?? "").toLowerCase();
  return CURATED_FEED_TYPES.has(type);
}

/** @description True for events that must take the separate critical path (blocked/failed lifecycle
 * alerts). `regate-pending` is deliberately NOT critical for the feed — the operator does not want it,
 * and its delivery-blocking obligation is gate-state-enforced (entry-gate), independent of any ping. */
function isCriticalEvent(event) {
  if (!event || typeof event.type !== "string") return false;
  return CRITICAL_TYPES.has(event.type);
}

/** @description Operator-facing pt-br label per curated checkpoint type. */
const CHECKPOINT_LABELS = {
  picked: "Sessão iniciada",
  "pipeline-type": "Classificação",
  "spec-created": "Spec criada",
  "spec-adversary": "Adversarial da spec",
  "plan-created": "Plano criado",
  "plan-reviewed": "Revisão do plano",
  "task-executing": "Tarefa",
  "hand-ran": "Tarefa implementada",
  "final-review-done": "Revisão final concluída",
  pr: "PR aberto",
};

/** @description Title for an outbox checkpoint message: status emoji + friendly pt-br label (falls
 * back to the UPPERCASE taxonomy key for any non-curated type that still reaches the renderer). */
function checkpointTitle(event) {
  const type = String(event?.type ?? "evento").toLowerCase();
  const emoji = EMOJI[type] ?? "🔔";
  const label = CHECKPOINT_LABELS[type] ?? type.toUpperCase();
  return `${emoji} ${label}`;
}

/** @description Body lines for a run's cosmetic checkpoint. The fallback/shared path prefixes the
 * first line with `#<issue>` so interleaved runs stay legible. */
function cosmeticBodyLines(event, meta, isFallback) {
  const issue = meta.issueNumber;
  const lines = [];
  // Normalize so cron-a-exit's {type:'PR'} (task-9) and the drain test's {type:'pr'} (task-5) both
  // render the PR line — without this, 'PR' fell through to the default 'checkpoint' branch.
  const type = String(event?.type ?? "").toLowerCase();
  switch (type) {
    case "pipeline-type":
      lines.push(`modo ${event.mode ?? "?"}`);
      break;
    case "spec-created":
      // No info line: the label ("Spec criada") already says everything → title-only checkpoint.
      break;
    case "spec-adversary":
      // No info line: the label ("Adversarial da spec") already says everything → title-only.
      break;
    case "plan-created":
      lines.push(`${event.tasks ?? "?"} tarefas`);
      break;
    case "plan-reviewed": {
      const verdictLabel =
        event.verdict === "APPROVE"
          ? "aprovado"
          : event.verdict === "REVISE"
            ? "requer revisão"
            : "revisado";
      // `round` (1-based) is stamped by the obs-eye-append producer per plan-reviewer return so the
      // operator sees "revisão 1", "revisão 2"… A plan-reviewed without a round (legacy / mark.mjs
      // fallback) renders the verdict alone.
      const round = Number(event.round);
      lines.push(Number.isInteger(round) && round > 0 ? `revisão ${round} — ${verdictLabel}` : verdictLabel);
      break;
    }
    case "task-executing":
      lines.push(`tarefa ${event.n ?? "?"}/${event.total ?? "?"}`);
      break;
    case "hand-ran":
      lines.push(
        `${event.task ?? "tarefa"}${event.role ? " (" + event.role + ")" : ""} — modelo ${event.model ?? "?"}`
      );
      break;
    case "final-review-done":
      // No info line: the label ("Revisão final concluída") already says everything → title-only.
      break;
    case "pr":
      lines.push(`PR ${event.pr ?? ""}`);
      if (event.url) lines.push(String(event.url));
      break;
    case "picked":
      // No info line: the label ("Sessão iniciada") already says everything → title-only.
      break;
    case "eye":
      lines.push(`${event.role ?? "eye"} returned`);
      break;
    default:
      lines.push("checkpoint");
  }
  if (event.reason) lines.push(String(event.reason));
  // Fallback (shared topic): prefix the run identity so interleaved runs stay legible — even for a
  // title-only checkpoint with no info line (seed the `#<issue>` so identity is never lost).
  if (isFallback) {
    if (lines.length) lines[0] = `#${issue} ${lines[0]}`;
    else lines.push(`#${issue}`);
  }
  return lines;
}

/** @description Body lines for a critical ping: references the run topic so the operator can jump. */
function criticalBodyLines(event, meta) {
  const issue = meta.issueNumber;
  const thread = meta.threadId ?? "shared";
  const lines = [`Run #${issue} (topic ${thread})`];
  if (event.reason) lines.push(String(event.reason));
  return lines;
}

/** @description Sends a pre-rendered HTML message through the Telegram sendMessage endpoint. */
async function sendRenderedMessage({ config, text, fetch: fetchImpl, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const payload = {
    chat_id: config?.chatId,
    message_thread_id: config?.threadId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  const result = await callTelegramMethod("sendMessage", payload, { config, fetch: fetchImpl, log, timeoutMs }, "sendMessage");
  return { ok: result.ok };
}

/** @description Derives the two cron-sourced border checkpoints from the run's worktree and
 * appends them idempotently (append-if-absent) to the events JSONL. */
function deriveBorderCheckpoints(metaPath, meta, seams) {
  const read = seams.readEvents ?? defaultReadEvents;
  const append = seams.appendEvent ?? defaultAppendEvent;
  const events = read(metaPath);
  const worktreePath = meta?.worktreePath;
  if (typeof worktreePath !== "string" || !worktreePath) return;

  const plansDir = join(worktreePath, ".claude", "plans");
  let hasSpec = false;
  let taskCount = null;
  try {
    const entries = readdirSync(plansDir);
    for (const entry of entries) {
      const subPath = join(plansDir, entry);
      let st;
      try {
        st = statSync(subPath);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;

      const specPath = join(subPath, "spec.md");
      try {
        if (statSync(specPath).isFile()) hasSpec = true;
      } catch {}

      const planPath = join(subPath, "execution-plan.json");
      try {
        const raw = readFileSync(planPath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.tasks)) taskCount = parsed.tasks.length;
      } catch {}
    }
  } catch {
    // fail-open: missing or unreadable plans dir is not an error
  }

  if (hasSpec && !events.some((event) => event.type === "spec-created")) {
    append(metaPath, { type: "spec-created" });
  }
  if (taskCount != null && !events.some((event) => event.type === "plan-created")) {
    append(metaPath, { type: "plan-created", tasks: taskCount });
  }
}

/** @description Best-effort send with swallowed exceptions (429 / network failure / throwing fake). */
async function trySend(send, message) {
  try {
    const result = await send(message);
    return result && result.sent === true;
  } catch {
    return false;
  }
}

/**
 * @description Cron-side outbox drain. Enumerates every obs-<issue>.json in stateDir, derives
 * border checkpoints from the run worktree, then sends unsent events. Critical events (blocked /
 * failed / unmatched regate-pending / sniper-HIGH) are sent FIRST on a separate best-effort path to
 * the shared main topic; cosmetic events advance the contiguous cursor only after an ack
 * (`{sent:true}`). A fallback run (or any run without a threadId) routes every message to the
 * shared config threadId and prefixes each body with `#<issue>`. A closed run with a remaining
 * cursor is still drained. Fail-open: never throws and never delays the cron.
 *
 * @param {{ stateDir: string, homeDir: string, chatId: number|string, limitPerMinute?: number, sendDelayMs?: number }} opts
 * @param {{ readEvents?: Function, readMeta?: Function, advanceCursor?: Function, updateMeta?: Function, appendEvent?: Function, send?: Function, sleep?: Function }} seams
 * @returns {Promise<void>}
 */
export async function drainTelegramOutbox(opts = {}, seams = {}) {
  const { stateDir, chatId, limitPerMinute, threadId: sharedThreadId } = opts;
  const readEvents = seams.readEvents ?? defaultReadEvents;
  const readMeta = seams.readMeta ?? defaultReadMeta;
  const advanceCursor = seams.advanceCursor ?? defaultAdvanceCursor;
  const updateMeta = seams.updateMeta ?? defaultUpdateMeta;
  const appendEvent = seams.appendEvent ?? defaultAppendEvent;
  const send = seams.send ?? (async () => ({ sent: false }));
  const sleep = typeof seams.sleep === "function" ? seams.sleep : defaultSleep;

  if (!stateDir || chatId == null || chatId === "") return;

  // Space consecutive sends (critical AND cosmetic) so a burst never trips the Telegram ~1 msg/s
  // per-chat / ~20 msg/min per-group limit — the rate-limit that made the last send of a burst time
  // out AFTER Telegram already delivered it, jamming the contiguous cursor into a re-send next tick.
  // Opt-in via opts.sendDelayMs (the cron passes it; tests default to 0 = no spacing, so the frozen
  // drain tests stay fast). Clamped to MAX_SEND_DELAY_MS in the drain itself, never trusting the seam.
  const sendDelayMs = typeof opts.sendDelayMs === "number" ? opts.sendDelayMs : 0;
  let sendsAttempted = 0;
  const pace = async () => {
    if (sendsAttempted > 0 && sendDelayMs > 0) {
      await sleep(Math.min(sendDelayMs, MAX_SEND_DELAY_MS));
    }
    sendsAttempted += 1;
  };

  let budget = refillBudget(limitPerMinute);
  const runs = [];

  try {
    for (const file of readdirSync(stateDir)) {
      if (!file.startsWith("obs-") || !file.endsWith(".json")) continue;
      const metaPath = join(stateDir, file);
      const meta = readMeta(metaPath);
      if (!meta) continue;
      deriveBorderCheckpoints(metaPath, meta, { readEvents, appendEvent });
      const events = readEvents(metaPath);
      runs.push({ metaPath, meta, events });
    }
  } catch {
    return;
  }

  // Critical-first pass: shared main topic (config chatId, shared threadId).
  for (const { metaPath, meta, events } of runs) {
    const sent = Array.isArray(meta.criticalSent) ? [...meta.criticalSent] : [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!isCriticalEvent(event)) continue;
      if (sent.includes(i)) continue;
      if (budget <= 0) break;
      const text = renderCheckpoint({ title: checkpointTitle(event), bodyLines: criticalBodyLines(event, meta) });
      await pace();
      const ack = await trySend(send, { event, text, chatId, threadId: sharedThreadId });
      if (ack) {
        consumeBudget();
        budget -= 1;
        sent.push(i);
        try {
          updateMeta(metaPath, { criticalSent: sent });
        } catch {
          // best-effort marker; a lost update may cause a duplicate critical ping
        }
      }
    }
  }

  // Cosmetic pass: contiguous cursor advances only on ack.
  for (const { metaPath, meta, events } of runs) {
    const isFallback = meta.status === "fallback" || meta.threadId == null;
    const runThreadId = isFallback ? sharedThreadId : meta.threadId;
    const startCursor = typeof meta.cursor === "number" ? meta.cursor : 0;
    let newCursor = startCursor;

    for (let i = startCursor; i < events.length; i++) {
      const event = events[i];
      if (isCriticalEvent(event)) continue;
      // Suppress non-curated checkpoints (raw eye / regate-pending / lifecycle events) from the feed but
      // ACK by advancing the cursor — a contiguous cursor that skipped WITHOUT advancing would jam the
      // outbox and starve every later milestone. The JSONL audit trail is never rewritten.
      if (!isCuratedFeedEvent(event)) {
        newCursor = i + 1;
        continue;
      }
      if (budget <= 0) break;
      const text = renderCheckpoint({ title: checkpointTitle(event), bodyLines: cosmeticBodyLines(event, meta, isFallback) });
      await pace();
      const ack = await trySend(send, { event, text, chatId, threadId: runThreadId });
      if (ack) {
        consumeBudget();
        budget -= 1;
        newCursor = i + 1;
      } else {
        break;
      }
    }

    if (newCursor !== startCursor) {
      try {
        advanceCursor(metaPath, newCursor);
      } catch {
        // fail-open: a cursor write failure must not propagate
      }
    }
  }
}
