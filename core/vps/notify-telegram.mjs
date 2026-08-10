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
import { currentAttemptEvents } from "../shared/lib/obs-attempt.mjs";

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
  "pr-review-infra-blocked": "🔴",
  "pr-branch-updated-retry": "🔄",
  "reaper-killed": "⏱️",
  "reaper-recovered": "♻️",
  "reaper-orphan-cleaned": "🧹",
  "reaper-permission-check": "🔐",
  "engine-updated": "⬆️",
  "engine-update-failed": "❗",
  "chain-released": "🔗",
  "chain-stranded": "⛓️‍💥",
  "attempt-started": "🔁",
  "pipeline-type": "🚀",
  "spec-created": "📝",
  "spec-adversary": "🛡️",
  "spec-adversaried": "🗡️",
  "plan-created": "📋",
  "plan-reviewed": "🧐",
  "task-executing": "⚙️",
  "final-review-done": "🏁",
  "hand-ran": "✋",
  eye: "👁️",
  "regate-pending": "🔒",
  "sniper-ran": "🔧",
  "gates-ran": "🚦",
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
    case "pr-branch-updated-retry":
      return `${prefix} PR ${prRef} estava desatualizado com a base — branch sincronizada; nova revisão + merge no próximo ciclo`;
    case "pr-blocked":
      return `${prefix} PR ${prRef} BLOQUEADO${reason}`;
    case "pr-review-infra-blocked":
      return `${prefix} PR ${prRef} — revisão automática falhou repetidamente (sessão travou 3x sem veredito); bloqueado pra você olhar`;
    case "reaper-killed":
      return `${prefix} sessão da issue ${issueRef} morta pelo watchdog`;
    case "reaper-recovered":
      return `${prefix} run da issue ${issueRef} recuperado de crash`;
    case "reaper-orphan-cleaned":
      return `${prefix} worktree órfão da issue ${issueRef} limpo`;
    case "reaper-permission-check": {
      // FLEET-level event with no single project (event.project is absent) — render without a
      // `[<project>]` prefix so the operator never sees a cryptic `[?]`. Names the chat and the
      // remedy: the retention sweep can't clear topics because the bot lacks can_delete_messages,
      // and the operator must grant it in that group.
      const chatId = event.chatId != null ? escapeHtml(String(event.chatId)) : "?";
      return `${emoji} a limpeza de tópicos do grupo ${chatId} não avança — o bot não consegue apagar tópicos; conceda a ele a permissão de apagar mensagens (can_delete_messages) nesse grupo`;
    }
    case "engine-updated": {
      const range = event.from && event.to ? ` (${escapeHtml(String(event.from).slice(0, 7))} → ${escapeHtml(String(event.to).slice(0, 7))})` : "";
      return `${prefix} motor do harness atualizado com a main${range} — próximos crons já rodam a versão nova`;
    }
    case "engine-update-failed": {
      const detail = event.message ? `: ${escapeHtml(truncate(String(event.message)))}` : "";
      return `${prefix} falha ao atualizar o motor do harness${detail} — a VPS segue na versão anterior`;
    }
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
 * @returns {{ notify: (event: object) => Promise<void>, drain: () => Promise<unknown>, drainOutbox: (opts?: object) => Promise<void>, enabled: boolean, heartbeat: boolean, config: object, send?: Function, createTopic?: Function }}
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
        // Per-event threadId override: when event.threadId != null, use it as message_thread_id
        // instead of resolved.threadId (the global default). Falls back to resolved.threadId when
        // event.threadId is absent/undefined/null.
        const config = event.threadId != null ? { ...resolved, threadId: event.threadId } : resolved;
        await sendNotification(event, {
          config,
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
    return result.ok ? { sent: true } : { sent: false, reason: result.reason };
  };

  // Token-bound createTopic seam: wraps the exported createForumTopic with the resolved config so the
  // drain (task-2) can recreate a deleted/closed forum topic without re-plumbing the token. Exposed on
  // the notifier so the production wiring is verifiable WITHOUT the self-heal branch existing yet.
  const createTopic = (input) =>
    createForumTopic(input, {
      config: { token: resolved.token, chatId: resolved.chatId },
      fetch: deps.fetch,
      log: deps.log,
      timeoutMs: deps.timeoutMs,
    });

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
        createTopic,
        // #235/task-4: forward the optional issue-state + clock seams a wired composition root
        // (run-drain.mjs, run-cron-a.mjs, run-cron-review.mjs) passes in via drainOpts. Absent on
        // both -> undefined -> drainTelegramOutbox's own defaults apply (byte-identical today).
        issueOpen: drainOpts.issueOpen,
        now: drainOpts.now,
      },
    );

  return {
    notify,
    drain: () => Promise.allSettled([...pending]),
    drainOutbox,
    enabled: true,
    heartbeat: resolved.heartbeat,
    config: resolved,
    // Exposed SEAMS (production wiring verifiable directly, not only behind injected fakes):
    send,
    createTopic,
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
 * Without fetch+AbortSignal.timeout or without token+chatId → `{ ok:false, reason:"transient" }`
 * with no network call. Any error / non-2xx logs ONLY `{ op, type, status }` — never the URL (carries
 * `/bot<token>/`), token, or body. Resolves to `{ ok:true, data }` on 2xx (data is the parsed Telegram
 * response). On failure resolves `{ ok:false, reason }` where `reason` is a BOUNDED ENUM —
 * `"thread-not-found"` ONLY when the Telegram `description` means the forum topic is gone, else
 * `"transient"` (fail-closed). The raw `description` NEVER reaches a log line nor the returned
 * `reason`.
 * @param {string} method - Telegram Bot API method name (`createForumTopic` / `closeForumTopic`).
 * @param {object} payload - Request body (chat_id + method-specific fields).
 * @param {object} opts - { config, fetch, log, timeoutMs }.
 * @param {string} op - Redacted op label for the failure log.
 * @returns {Promise<{ ok: boolean, data?: object, reason?: string }>}
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
    return { ok: false, reason: "transient" };
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
      return { ok: false, reason: await classifyTelegramError(res) };
    }
    const data = typeof res.json === "function" ? await res.json() : {};
    return { ok: true, data };
  } catch {
    // NEVER log the error message/stack (the rejecting fake in tests carries the token+URL in it).
    log({ op, type: "forum-topic", status: "error" });
    return { ok: false, reason: "transient" };
  }
}

/**
 * @description Maps an unsuccessful Telegram response to a BOUNDED reason enum. FAIL-CLOSED: only an
 * explicit dead-thread `description` (the topic was deleted/closed) classifies as `"thread-not-found"`;
 * anything unreadable, non-JSON, absent, or unmatched maps to `"transient"`. The error body is read
 * under a guarded `typeof res.json === "function"` + try/catch — the existing test fakes return plain
 * objects with NO `.json`, and a rejecting/throwing `.json` is unclassifiable → fail closed. The raw
 * description string is consumed ONLY here to pick the enum value; it NEVER escapes this function.
 *
 * AMBIGUITY — `"thread-not-found"` means "Telegram could not resolve this thread in THIS chat", which
 * covers BOTH a genuinely deleted topic AND a wrong/mismatched `chat_id` (`message_thread_id` is
 * per-chat, NOT globally unique). It must NEVER, on its own, authorize a caller to discard persisted
 * local state — a caller reading it as "the topic is confirmed gone" while actually operating against
 * the wrong chat would destroy records for a topic that still exists elsewhere.
 *
 * PERMISSION DENIAL — a `not enough rights` / `CHAT_ADMIN_REQUIRED` (the bot lacking
 * `can_delete_messages` / `can_manage_topics`) currently classifies as `"transient"`, indistinguishable
 * from a 429 or a timeout. A caller cannot tell a permission problem from a transient blip here and
 * must detect it out-of-band (e.g. observing that attempts never succeed across cycles).
 * @param {object} res - The fetch response (may be a plain fake with no `.json`).
 * @returns {Promise<"thread-not-found" | "transient">}
 */
async function classifyTelegramError(res) {
  let description = null;
  if (res && typeof res.json === "function") {
    try {
      const body = await res.json();
      if (body && typeof body === "object" && typeof body.description === "string") {
        description = body.description;
      }
    } catch {
      // rejecting/throwing .json, or non-JSON body → unclassifiable → fail closed below
    }
  }
  // Positive gate: ONLY an explicit dead-thread description classifies as thread-not-found.
  return /message thread not found/.test(description) ? "thread-not-found" : "transient";
}

/**
 * @description Wraps Telegram `createForumTopic`. The NAME is PLAIN TEXT: truncated to ≤128 code
 * points and NEVER HTML-escaped (Telegram does not parse_mode the topic name). Fail-open: any error
 * → `{ ok:false }` (no chatId, no extra keys), never throws. On success resolves
 * `{ ok:true, threadId, chatId }` — `chatId` is `opts.config.chatId`, the chat the topic was actually
 * minted against (load-bearing for #ac-1.2: on a `.dev.vars`-only deployment `config.notify.chatId`
 * is undefined while the topic is minted against the resolved `TELEGRAM_CHAT_ID` fallback — only the
 * seam's return knows the true chat). The returned `chatId` is exactly the chat the topic was minted
 * against, and exists so callers can persist the `{ threadId, chatId }` pair required by
 * `deleteForumTopic`'s caller contract.
 * @param {{ name: string }} input
 * @param {object} opts - { config, fetch, log, timeoutMs }.
 * @returns {Promise<{ ok: boolean, threadId?: number, chatId?: number|string }>}
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
  return { ok: true, threadId: result.data?.result?.message_thread_id, chatId: opts?.config?.chatId };
}

/**
 * @description Wraps Telegram `closeForumTopic`. Fail-open: any error → `{ ok:false, reason }`,
 * never throws. On success resolves `{ ok:true }`. Mirrors `deleteForumTopic`'s return shape exactly
 * so callers can distinguish a permanent `"thread-not-found"` (the topic is already gone — a caller
 * finalizing terminal state should NOT retry) from a `"transient"` failure (retry later).
 * @param {{ threadId: number|string }} input
 * @param {object} opts - { config, fetch, log, timeoutMs }.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function closeForumTopic({ threadId } = {}, opts = {}) {
  const payload = {
    chat_id: opts?.config?.chatId,
    message_thread_id: threadId,
  };
  const result = await callTelegramMethod("closeForumTopic", payload, opts, "closeForumTopic");
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/**
 * @description Wraps Telegram `deleteForumTopic` — IRREVERSIBLE: it destroys the topic and every
 * message in it. Mirrors `closeForumTopic` EXACTLY (same `callTelegramMethod` seam, same bounded-error
 * classification, same redaction contract). Fail-open: never throws, never retries. Resolves `{ ok:true }`
 * on 2xx, `{ ok:false, reason:"thread-not-found" }` when the topic is already gone, and
 * `{ ok:false, reason:"transient" }` otherwise. A failure logs ONLY `{ op:"deleteForumTopic",
 * type:"forum-topic", status }` — the token/URL/body never reach a log line.
 *
 * CALLER CONTRACT — `message_thread_id` is per-chat and NOT globally unique, so the caller MUST
 * guarantee that `threadId` was minted in the SAME chat as `opts.config.chatId`. The intended
 * mechanism: persist the `{ threadId, chatId }` pair `createForumTopic` returns together, and compare
 * the persisted `chatId` against the currently-resolved one before ever calling this function. This
 * function does NOT and CANNOT verify that pairing — a `threadId` from chat A paired with chat B's
 * `config.chatId` destroys an unrelated topic in chat B, and the operation is irreversible. A
 * `"thread-not-found"` reason is only safe to interpret as "already gone" once the caller has
 * independently established, via that `chatId` equality check, that it is operating in the correct chat.
 * @param {{ threadId: number|string }} input
 * @param {object} opts - { config, fetch, log, timeoutMs }.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function deleteForumTopic({ threadId } = {}, opts = {}) {
  const payload = {
    chat_id: opts?.config?.chatId,
    message_thread_id: threadId,
  };
  const result = await callTelegramMethod("deleteForumTopic", payload, opts, "deleteForumTopic");
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
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
 * review/approval, task loop, models per task (hand-ran), the sniper's fix (sniper-ran), the
 * technical gates (gates-ran), final review, PR. Everything else in the outbox (`regate-pending`,
 * and any lifecycle/reaper/chain events) is audit-only: suppressed at DRAIN/RENDER time, never at
 * append time (the JSONL stays the full audit trail; `criticalSent`/`cursor` indices are positional
 * and must not be renumbered). `eye` is curated CONDITIONALLY on `event.role` — see
 * `isCuratedFeedEvent` — never via this flat type Set, since a `plan-reviewer` role must stay
 * suppressed (its own dedicated `plan-reviewed` checkpoint already covers that fact).
 */
const CURATED_FEED_TYPES = new Set([
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
const EYE_CURATED_ROLES = new Set(["compliance", "adversary", "security"]);

/** @description True when an event belongs in the curated Telegram feed (case-insensitive). `eye`
 * is special-cased on `event.role` (see `EYE_CURATED_ROLES`) rather than being a flat member of
 * `CURATED_FEED_TYPES`. */
export function isCuratedFeedEvent(event) {
  const type = String(event?.type ?? "").toLowerCase();
  if (type === "eye") {
    return EYE_CURATED_ROLES.has(String(event?.role ?? "").toLowerCase());
  }
  return CURATED_FEED_TYPES.has(type);
}

/** @description True for events that must take the separate critical path (blocked/failed lifecycle
 * alerts). `regate-pending` is deliberately NOT critical for the feed — the operator does not want it,
 * and its delivery-blocking obligation is gate-state-enforced (entry-gate), independent of any ping. */
export function isCriticalEvent(event) {
  if (!event || typeof event.type !== "string") return false;
  return CRITICAL_TYPES.has(event.type);
}

/** @description Operator-facing pt-br label per curated checkpoint type. `eye` and `gates-ran` are
 * NOT here — their label depends on `event.role` / `event.result` respectively, resolved by
 * `resolveCheckpointLabel`. */
const CHECKPOINT_LABELS = {
  picked: "Sessão iniciada",
  "pipeline-type": "Classificação",
  "spec-created": "Spec criada",
  "spec-adversary": "Adversarial da spec",
  "spec-adversaried": "Spec atacada",
  "plan-created": "Plano criado",
  "plan-reviewed": "Revisão do plano",
  "task-executing": "Tarefa",
  "hand-ran": "Tarefa implementada",
  "sniper-ran": "Correção cirúrgica",
  "final-review-done": "Revisão final concluída",
  pr: "PR aberto",
};

/** @description Operator-facing pt-br label per `eye` role — compliance/adversary/security, the
 * three roles `EYE_CURATED_ROLES` lets through. A `plan-reviewer` (or any other/unknown) role never
 * reaches here in production (isCuratedFeedEvent denies it before rendering); the UPPERCASE type
 * fallback below exists only as a defensive backstop, never a real label the operator sees. */
const EYE_ROLE_LABELS = {
  compliance: "Conformidade",
  adversary: "Adversarial da tarefa",
  security: "Segurança",
};

/** @description Resolves a checkpoint's operator-facing pt-br label. Two types carry a
 * dynamic label instead of a flat `CHECKPOINT_LABELS` entry: `eye` (keyed by `event.role`) and
 * `gates-ran` (keyed by `event.result`, pass|fail). Every other curated type resolves through the
 * static map, falling back to the UPPERCASE taxonomy key for any type that reaches the renderer
 * without a curated label (defensive — should not happen for a curated event in practice).
 * @param {string} type - Lowercased event type.
 * @param {object} event
 * @returns {string}
 */
function resolveCheckpointLabel(type, event) {
  if (type === "attempt-started") {
    return `Tentativa ${event?.attempt ?? "?"}`;
  }
  if (type === "eye") {
    return EYE_ROLE_LABELS[String(event?.role ?? "").toLowerCase()] ?? type.toUpperCase();
  }
  if (type === "gates-ran") {
    return event?.result === "fail" ? "Portões: FALHOU" : "Portões: OK";
  }
  return CHECKPOINT_LABELS[type] ?? type.toUpperCase();
}

/** @description The operator's timezone — checkpoint clock times render in São Paulo local time
 * regardless of the VPS host timezone, so `14:32` means 14:32 for the operator. */
const CHECKPOINT_TZ = "America/Sao_Paulo";

/**
 * @description PURE. Formats an event's ISO `ts` as `HH:MM` in the operator's timezone. Returns "" for
 * a missing/invalid ts (so a legacy event with no `ts` renders exactly as before — no prefix). Fail-open:
 * any Intl error yields "". This is the seam that makes a checkpoint show the REAL event instant
 * (stamped at append) instead of the batched drain time.
 * @param {string} ts - ISO timestamp stamped by appendEvent.
 * @returns {string}
 */
export function formatCheckpointTime(ts) {
  if (typeof ts !== "string" || !ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: CHECKPOINT_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return "";
  }
}

/** @description Title for an outbox checkpoint message: real event time (`HH:MM` from `event.ts`, when
 * present) + status emoji + friendly pt-br label (falls back to the UPPERCASE taxonomy key for any
 * non-curated type that still reaches the renderer). */
function checkpointTitle(event) {
  const type = String(event?.type ?? "evento").toLowerCase();
  const emoji = EMOJI[type] ?? "🔔";
  const label = resolveCheckpointLabel(type, event);
  const time = formatCheckpointTime(event?.ts);
  return `${time ? `${time} ` : ""}${emoji} ${label}`;
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
    case "plan-created": {
      const n = event.tasks;
      lines.push(Number(n) === 1 ? "1 tarefa" : `${n ?? "?"} tarefas`);
      break;
    }
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
    case "spec-adversaried": {
      const n = event.findings;
      const findingsLabel = Number(n) === 1 ? `${n} achado` : `${n} achados`;
      const verdictLabel = event.verdict === "SHIP" ? "aprovado" : event.verdict === "BLOCK" ? "bloqueado" : "...";
      lines.push(`${findingsLabel} — ${verdictLabel}`);
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
    case "sniper-ran":
      lines.push(`tarefa ${event.task ?? "?"} — severidade ${event.severity ?? "?"}`);
      break;
    case "gates-ran":
      // Scope hedge (deliberate, not filler): this reflects the frozen-test capture — the single
      // structural, delivery-blocking gate — NOT the orchestrator's separate tsc/lint pass, which
      // has no per-task observability today (see the stamp-triage.mjs producer comment). Naming
      // "teste travado" here keeps a quick Telegram glance from reading "Portões: OK" as "build +
      // lint + tests all green" when only the locked test was verified.
      lines.push(`tarefa ${event.task ?? "?"} (teste travado)`);
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
      // No info line: the role-specific label (Conformidade/Adversarial da tarefa/Segurança,
      // resolved by resolveCheckpointLabel) already says everything → title-only checkpoint.
      break;
    default:
      lines.push("checkpoint");
  }
  if (event.reason) lines.push(String(event.reason));
  // Fallback routes to the SHARED global topic (per-run topic creation failed), which mixes every
  // project — so prefix `[<project>] #<issue>` so interleaved runs stay attributable, even for a
  // title-only checkpoint with no info line (the identity is never lost).
  if (isFallback) {
    const ident = `${meta.project ? `[${meta.project}] ` : ""}#${issue}`;
    if (lines.length) lines[0] = `${ident} ${lines[0]}`;
    else lines.push(ident);
  }
  return lines;
}

/** @description Body lines for a critical ping. These land in the SHARED global topic, which mixes
 * error/extraordinary events from EVERY project — so the line leads with `[<project>]` to name the
 * owner, then references the run topic so the operator can jump. */
function criticalBodyLines(event, meta) {
  const issue = meta.issueNumber;
  const thread = meta.threadId ?? "shared";
  const project = meta.project ? `[${meta.project}] ` : "";
  const lines = [`${project}Run #${issue} (topic ${thread})`];
  if (event.reason) lines.push(String(event.reason));
  return lines;
}

/**
 * @description Sends a pre-rendered HTML message through the Telegram sendMessage endpoint. EXPORTED
 * so the bounded-error classification contract is unit-testable. Returns `{ ok, reason }`: on success
 * `{ ok:true }`; on failure `{ ok:false, reason }` where `reason` is the bounded enum classified by
 * `callTelegramMethod` (`"thread-not-found"` only for an explicit dead-thread description, else
 * `"transient"`). The raw Telegram `description` never reaches the returned `reason` nor any log line.
 * @param {object} input - { config, text, fetch, log, timeoutMs }.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function sendRenderedMessage({ config, text, fetch: fetchImpl, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const payload = {
    chat_id: config?.chatId,
    message_thread_id: config?.threadId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  const result = await callTelegramMethod("sendMessage", payload, { config, fetch: fetchImpl, log, timeoutMs }, "sendMessage");
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/** @description Derives the two cron-sourced border checkpoints from the run's worktree and
 * appends them idempotently (append-if-absent) to the events JSONL. */
function deriveBorderCheckpoints(metaPath, meta, seams) {
  const read = seams.readEvents ?? defaultReadEvents;
  const append = seams.appendEvent ?? defaultAppendEvent;
  const stat = seams.statSync ?? statSync;
  const events = currentAttemptEvents(read(metaPath));
  const worktreePath = meta?.worktreePath;
  if (typeof worktreePath !== "string" || !worktreePath) return;

  // Runtime-aware: Claude uses .claude/plans; OpenCode uses .opencode/plans (scan both).
  const plansDirs = [
    join(worktreePath, ".claude", "plans"),
    join(worktreePath, ".opencode", "plans"),
  ];
  let hasSpec = false;
  let specPathForTimestamp = null;
  let specTimestamp = null;
  let taskCount = null;
  let planPathForTimestamp = null;
  let planTimestamp = null;
  for (const plansDir of plansDirs) {
    try {
      const entries = readdirSync(plansDir);
      for (const entry of entries) {
        if (entry === ".state" || entry.startsWith(".")) continue;
        const subPath = join(plansDir, entry);
        let st;
        try {
          st = stat(subPath);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;

        const specPath = join(subPath, "spec.md");
        try {
          const specStats = stat(specPath);
          if (specStats.isFile()) {
            hasSpec = true;
            if (!specPathForTimestamp) {
              specPathForTimestamp = specPath;
              specTimestamp = specStats.mtime.toISOString();
            }
          }
        } catch {}

        const planPath = join(subPath, "execution-plan.json");
        let detectedPlanTimestamp;
        try {
          detectedPlanTimestamp = stat(planPath).mtime.toISOString();
        } catch {}
        try {
          const raw = readFileSync(planPath, "utf8");
          const parsed = JSON.parse(raw);
          // Full plan only (mirror isFullExecutionPlan) — never sticky plan-created from classify stub.
          if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
            const n = parsed.tasks.length;
            // Prefer the largest full plan if multiple dirs exist (avoid last-wins wrong count).
            if (taskCount == null || n > taskCount) {
              taskCount = n;
              planPathForTimestamp = planPath;
              planTimestamp = detectedPlanTimestamp;
            }
          }
        } catch {}
      }
    } catch {
      // fail-open: missing or unreadable plans dir is not an error
    }
  }

  // Re-stat at append time so a removal or rewrite after detection falls back to appendEvent's
  // current-time stamp instead of producing a checkpoint from one artifact version with another's
  // mtime. The checkpoint remains fail-open in either case.
  const timestampFor = (path, detectedTimestamp) => {
    try {
      return detectedTimestamp && stat(path).mtime.toISOString() === detectedTimestamp ? detectedTimestamp : undefined;
    } catch {
      return undefined;
    }
  };

  if (hasSpec && !events.some((event) => event.type === "spec-created")) {
    const ts = timestampFor(specPathForTimestamp, specTimestamp);
    append(metaPath, ts ? { type: "spec-created", ts } : { type: "spec-created" });
  }
  if (taskCount != null && !events.some((event) => event.type === "plan-created" && (event.tasks ?? null) === taskCount)) {
    const ts = timestampFor(planPathForTimestamp, planTimestamp);
    append(metaPath, ts ? { type: "plan-created", tasks: taskCount, ts } : { type: "plan-created", tasks: taskCount });
  }
}

/**
 * @description Best-effort send with swallowed exceptions (429 / network failure / throwing fake).
 * Surfaces `{ ack, reason }`: `ack` is true ONLY when the send succeeded; `reason` carries the
 * bounded classified reason on failure (undefined on success / when the send fake omits it). The
 * reason is surfaced here so the drain (and task-2's self-heal branch) can consume it without
 * re-deriving classification. Never throws.
 * @param {Function} send - The drain's send seam.
 * @param {object} message - The message payload passed to the seam.
 * @returns {Promise<{ ack: boolean, reason?: string }>}
 */
async function trySend(send, message) {
  try {
    const result = await send(message);
    if (result && result.sent === true) {
      return { ack: true };
    }
    return { ack: false, reason: result && result.reason };
  } catch {
    return { ack: false };
  }
}

/** @description Hard cap on the number of topic recreations attempted in a single `drainTelegramOutbox`
 * invocation (a drain CYCLE). Bounds a mass-deletion burst so a forum purge cannot mint an unbounded
 * flock of fresh topics in one cron tick. The COUNTER that enforces it is a LOCAL of each invocation
 * (zeroed every call) — NEVER a module-global like `outboxRateLimiter`, which would refuse recreation
 * forever after 3 cumulative recreations and flake the shared-process frozen tests. */
const MAX_RECREATIONS_PER_CYCLE = 3;

/**
 * @description Injectable clock seam returning epoch SECONDS — mirrors cron-a-exit.mjs's/reaper.mjs's
 * defaultNow so a closedAt stamped by this module's self-heal finalize path is comparable across
 * modules and satisfies the retention sweep's Number.isFinite(closedAt) gate. NEVER raw
 * Date.now() milliseconds. Tests inject a fixed value for determinism; production uses the default.
 */
const defaultNow = () => Math.floor(Date.now() / 1000);

/** @description Per-RUN lifetime cap on topic recreations, PERSISTED across drain cycles on the run's
 * meta (`healAttempts`). `MAX_RECREATIONS_PER_CYCLE` only bounds a single tick; without a persisted
 * counter a run whose recreated topic keeps being reported dead (the chat is no longer a forum, or the
 * new topic is deleted as fast as it is minted) re-mints one topic EVERY cron tick, unbounded over
 * time. After this many lifetime heals the run is routed to the shared topic (status:"fallback") — the
 * same terminal escape already used for the no-usable-threadId and unconfirmed-persist paths. */
const MAX_HEAL_ATTEMPTS = 3;

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
 * @param {{ readEvents?: Function, readMeta?: Function, advanceCursor?: Function, updateMeta?: Function, appendEvent?: Function, statSync?: Function, send?: Function, sleep?: Function, createTopic?: Function }} seams
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
  // task-1 seam: a token-bound createTopic (recreate a deleted/closed forum topic). Consumed by the
  // cosmetic-pass self-heal branch on `reason === "thread-not-found"` (task-2). Default no-op returns
  // {ok:false} so an unconfigured / unbound drain never touches the network.
  const createTopic = seams.createTopic ?? (async () => ({ ok: false }));
  // #235/task-4: optional issue-state gate for the self-heal re-mint branch below. ABSENT (the
  // default) preserves today's behavior byte-identically — createTopic fires unconditionally past
  // the existing ownsTopic/thread-not-found guard, exactly as before this feature. When PRESENT it
  // is consulted ONLY inside that rare re-mint branch, never per-run on every tick (#ac-1.3).
  const issueOpen = seams.issueOpen;
  const now = seams.now ?? defaultNow;

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
      deriveBorderCheckpoints(metaPath, meta, { readEvents, appendEvent, statSync: seams.statSync });
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
      const sendResult = await trySend(send, { event, text, chatId, threadId: sharedThreadId });
      if (sendResult.ack) {
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
  // The recreation cap counter is a LOCAL of THIS invocation — zeroed every call so a second
  // consecutive drain still heals, never a module-global that refuses forever.
  let recreationsThisCycle = 0;
  for (const { metaPath, meta, events } of runs) {
    // #235: a run finalized closed via a CONFIRMED-dead topic (topicConfirmedGone, stamped above)
    // is fallback-routed too — its threadId is provably gone, so retrying against it forever
    // (the pre-fix behavior) would waste a send every tick and never deliver the event anywhere.
    // A run closed via a NORMAL successful close (closeForumTopic {ok:true} — the topic itself is
    // merely archived, not deleted) is deliberately NOT included here: Telegram can still accept a
    // message on a closed-but-existing topic, so that case keeps targeting meta.threadId (#10 in
    // drain-outbox.test.mjs pins this — a bare status:'closed' alone must stay live-topic-routed).
    const isFallback =
      meta.status === "fallback" || meta.threadId == null || meta.topicConfirmedGone === true;
    let runThreadId = isFallback ? sharedThreadId : meta.threadId;
    // A run OWNS its topic only in a LIVE status — an explicit ALLOWLIST (`active` or
    // `awaiting-review`), never a denylist. `orphan` (spawn died, topic-close failed), `fallback` and
    // `closed` do NOT own a topic, so a dead/orphan run never self-heals and mints a fresh topic. A
    // denylist here failed open on every status added later (`orphan` today, the next one tomorrow) —
    // dangerous on a trigger that MINTS a remote resource. `isFallback` still governs ROUTING (a
    // closed run with a remaining cursor keeps draining to the shared topic); `ownsTopic` governs
    // SELF-HEAL, so neither a closed nor an orphan run races cron-a-dispatch to create a second topic.
    const ownsTopic =
      (meta.status === "active" || meta.status === "awaiting-review") && meta.threadId != null;
    const startCursor = typeof meta.cursor === "number" ? meta.cursor : 0;
    let newCursor = startCursor;
    let recreatedThisRun = false;

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
      const sendResult = await trySend(send, { event, text, chatId, threadId: runThreadId });
      if (sendResult.ack) {
        consumeBudget();
        budget -= 1;
        newCursor = i + 1;
        continue;
      }

      // Self-heal branch (task-2): ONLY a per-run topic that OWNS its thread (ownsTopic — neither
      // fallback nor closed, with a non-null threadId) and died (reason === "thread-not-found") is
      // recreated. POSITIVE gate — a bare {sent:false} with NO reason (the shape the 30 frozen
      // drain-outbox tests inject) or any other/transient reason falls to the else and behaves
      // EXACTLY as before: break, cursor unadvanced, no recreation. At most ONE recreation per run per
      // cycle (recreatedThisRun) plus a per-CYCLE cap (recreationsThisCycle).
      if (
        ownsTopic &&
        !recreatedThisRun &&
        recreationsThisCycle < MAX_RECREATIONS_PER_CYCLE &&
        sendResult.reason === "thread-not-found"
      ) {
        // #235/task-4/#ac-1.3/#ac-1.4: only re-mint (createTopic) when the underlying issue is
        // confirmed still OPEN. issueOpen is OPTIONAL — absent, this check is skipped entirely and
        // behavior stays byte-identical to before this feature (backward-compat for every caller
        // that does not wire the seam). When present it returns a TRI-STATE: `true` (confirmed
        // OPEN) proceeds to mint; `false` (confirmed CLOSED) finalizes the run terminal; anything
        // else — `null` (unknown, e.g. a gh outage/timeout) or a throw (wrapped below) — is
        // UNCERTAIN and does NEITHER: never mint (fail-closed for the mint decision) AND never
        // finalize (an uncertain state must not be mistaken for "confirmed closed" — that would
        // wrongly terminate a genuinely active run on a transient gh blip). The drain itself never
        // throws or delays on any of these outcomes (fail-open for the cron).
        if (typeof issueOpen === "function") {
          let state;
          try {
            state = issueOpen(meta.issueNumber, meta.project);
          } catch {
            state = null;
          }
          if (state !== true) {
            if (state === false) {
              // Confirmed closed/merged: the topic is gone and staying gone. Finalize terminal.
              // topicConfirmedGone flags the NEXT tick's isFallback computation (below) so any
              // remaining cosmetic event for this run routes to the shared topic instead of
              // retrying forever against this now-provably-dead threadId.
              try {
                updateMeta(metaPath, { status: "closed", closedAt: now(), topicConfirmedGone: true });
              } catch {
                // fail-open: a failed finalize write never blocks the drain
              }
            }
            // state === null (unknown/uncertain): neither mint nor finalize — retry next tick.
            break;
          }
        }
        // Per-RUN lifetime cap (persisted on the meta): once this run has already minted
        // MAX_HEAL_ATTEMPTS topics over its life, stop re-minting and route to the shared topic —
        // otherwise a topic that keeps being reported dead re-mints one fresh topic every cron tick.
        const healAttempts = typeof meta.healAttempts === "number" ? meta.healAttempts : 0;
        if (healAttempts >= MAX_HEAL_ATTEMPTS) {
          try {
            updateMeta(metaPath, { status: "fallback" });
          } catch {
            // fail-open
          }
          break;
        }
        recreatedThisRun = true;
        recreationsThisCycle += 1;
        const topicName = `${meta.project ? `[${meta.project}] ` : ""}#${meta.issueNumber}`;
        let createResult;
        try {
          createResult = await createTopic({ name: topicName });
        } catch {
          createResult = null;
        }
        if (!createResult || !createResult.ok) {
          // genuine failure: no topic was created, safe to retry next cycle
          break;
        }
        if (createResult.threadId == null) {
          // ok:true means a topic MAY exist on Telegram but its id is unusable — retrying would mint a
          // fresh orphan every cycle. Route the run to the shared topic instead.
          try {
            updateMeta(metaPath, { status: "fallback" });
          } catch {
            // fail-open
          }
          break;
        }
        // meta.chatId MUST always describe the chat where the CURRENT threadId lives — a stale
        // pairing (chatId A + threadId minted in B) authorizes an irreversible deleteForumTopic of
        // an unrelated topic in the wrong chat, since message_thread_id is per-chat, not global.
        const healPartial = { threadId: createResult.threadId, healAttempts: healAttempts + 1 };
        if (createResult.chatId != null) healPartial.chatId = createResult.chatId;
        try {
          updateMeta(metaPath, healPartial);
        } catch {
          // fail-open: updateMeta never throws, but never let a writer propagate
        }
        // READ BACK to confirm the persist landed — updateMeta is fail-open and returns void, so a
        // silently-dropped threadId would otherwise mint a fresh orphan topic on every later cycle.
        let confirmed = null;
        try {
          confirmed = readMeta(metaPath);
        } catch {
          confirmed = null;
        }
        if (!confirmed || confirmed.threadId !== createResult.threadId) {
          // Unconfirmed persist: do NOT re-send; switch the run to the shared topic then stop.
          try {
            updateMeta(metaPath, { status: "fallback" });
          } catch {
            // fail-open
          }
          break;
        }
        // Confirmed: rebind the loop-local send target so this run's remaining events in the SAME
        // cycle go to the new thread, then re-send the SAME event (cursor advances by exactly one,
        // no event skipped).
        runThreadId = createResult.threadId;
        await pace();
        const resendResult = await trySend(send, { event, text, chatId, threadId: runThreadId });
        if (resendResult.ack) {
          consumeBudget();
          budget -= 1;
          newCursor = i + 1;
        } else {
          break;
        }
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
