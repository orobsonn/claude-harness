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
import { readFileSync } from "node:fs";

import { parseDevVars } from "./scoped-env.mjs";

const TELEGRAM_API = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TEXT = 80;
const TOPIC_NAME_MAX_CODE_POINTS = 128;

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
    case "picked":
      return `${prefix} pegou issue ${issueRef}${title} — sessão iniciada`;
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
 * @returns {{ notify: (event: object) => Promise<void>, drain: () => Promise<unknown>, enabled: boolean, heartbeat: boolean }}
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
    return { notify: async () => {}, drain: async () => {}, enabled: false, heartbeat: false };
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

  return {
    notify,
    drain: () => Promise.allSettled([...pending]),
    enabled: true,
    heartbeat: resolved.heartbeat,
  };
}

// --- task-1: unified checkpoint renderer + forum-topic wrappers.
// Invariants preserved: zero-dep (Node builtins), fail-open (never throw/retry/delay), token only
// from the injected config (read off disk upstream), a failure logs ONLY { op, type, status }.

/**
 * @description PURE. Renders the LOCKED checkpoint HTML format: a bold UPPERCASE title, one blank
 * line, then an italic body whose every line is HTML-escaped and length-bounded (≤80 chars). The
 * title is uppercased but NOT escaped (it is a fixed taxonomy/label, never operator free text). This
 * is the single source of the checkpoint shape — the legacy send path routes through it too.
 * @param {{ title: string, bodyLines: string[] }} input
 * @returns {string}
 */
export function renderCheckpoint({ title, bodyLines } = {}) {
  const head = `<b>${escapeHtml(String(title ?? "").toUpperCase())}</b>`;
  const lines = Array.isArray(bodyLines) ? bodyLines : [];
  const body = `<i>${lines.map((line) => escapeHtml(truncateByCodePoints(line))).join("\n")}</i>`;
  return `${head}\n\n${body}`;
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

/** @description Scaffold — implemented by the task-5 executor (the cron-side outbox drain). */
export function drainTelegramOutbox() {
  throw new Error("not implemented");
}
