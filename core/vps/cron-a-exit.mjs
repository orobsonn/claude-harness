/**
 * @description VPS cron harness — Cron A graceful-exit state machine (task-6). cronAExit() is
 * chained AFTER `claude -p` inside the detached tmux session task-5 spawns
 * (`... ; cron-a-exit <issue> <worktree> <bodyfile> <envfile>`), so it fires on the session's
 * OWN termination — including a successful run that opened a PR, which otherwise nothing would
 * invoke (the reaper recovers only crashed no-PR runs). It is exit-handler LOGIC only; its
 * INVOCATION is wired into the detached-session lifecycle by task-5.
 *
 * Relabel state machine (never leaves the issue stranded in harness:in-progress):
 *   - PR exists on harness/<issue>                              -> harness:in-progress -> harness:in-review
 *                                                               (does NOT reset the attempt counter here;
 *                                                               the done transition + counter reset moved
 *                                                               to the post-merge review phase, HR-3)
 *   - no PR + a recorded deliberate blocking finding             -> harness:blocked (+ `gh issue comment`)
 *   - no PR, no blocking record, attempt counter < retryCeilingK -> harness:ready (re-queue)
 *   - no PR, no blocking record, attempt counter >= retryCeilingK -> harness:blocked (retry ceiling;
 *                                                               a chronically-failing issue leaves the loop)
 *
 * Counter contract: cronAExit is a READ-ONLY comparator of the per-issue attempt counter — it
 * NEVER calls counter.increment() on any exit path (dispatch owns charging attempts), and it no
 * longer calls counter.reset() on any path (the reset moved to the post-merge review phase).
 *
 * Cleanup contract: on EVERY exit path it (a) releases the run-lock with the held acquireTs
 * (ownership guard) and (b) unlinks BOTH the bodyFile (issue body) and envFile (scoped secrets)
 * so neither accumulates on the box. These run in a finally block so a throwing gh seam can never
 * strand the lock or leak the files.
 *
 * The module is also runnable directly as a CLI: `node core/vps/cron-a-exit.mjs <issueNumber>
 * <worktree> <bodyFile> <envFile>`. The CLI derives stateDir from the bodyFile's directory,
 * recovers the held acquireTs from the run-lock holder, and wires real `gh` / counter / prExists
 * / blockingFinding seams. The frozen oracle (cron-a-exit.test.mjs) exercises cronAExit() with
 * every seam INJECTED as a fake; the CLI wrapper is the thin production wiring.
 */
import {
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  chmodSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";

import { release as releaseLock, readHolder } from "./run-lock.mjs";
import { read as readCounter, reset as resetCounter, increment as incrementCounter } from "./cron-state.mjs";
import { isDirectCli } from "../skills/orchestrating-delivery/references/cli-flags.mjs";
import { makeNotifier, closeForumTopic as realCloseForumTopic } from "./notify-telegram.mjs";
import {
  appendEvent as defaultAppendEvent,
  readMeta as defaultReadMeta,
  updateMeta as defaultUpdateMeta,
} from "./obs-outbox.mjs";

const LABEL_IN_PROGRESS = "harness:in-progress";
const LABEL_IN_REVIEW = "harness:in-review";
const LABEL_BLOCKED = "harness:blocked";
const LABEL_READY = "harness:ready";
const DEFAULT_RETRY_CEILING_K = 2;

/**
 * @description Injectable clock seam returning epoch SECONDS — matches
 * run-cron-review.mjs's `Math.floor(Date.now()/1000)`. NEVER raw Date.now() milliseconds: a
 * millisecond closedAt passes Number.isFinite and breaks the retention sweep's age gate. Tests
 * inject a fixed `now` so the stamped closedAt is deterministic; production uses the default.
 */
const defaultNow = () => Math.floor(Date.now() / 1000);

/**
 * @description Path the autonomous session writes a deliberate-block marker to (the finding
 * message body). Lives under the worktree's `.claude/` (git-excluded via `.git/info/exclude`, so
 * it never dirties the tracked tree); the exit handler reads it best-effort and treats absence as
 * "no deliberate blocking stop".
 */
function blockingMarkerPath(worktree) {
  return join(worktree, ".claude", "harness-blocked.md");
}

/**
 * @description The graceful-exit state machine. See the module header for the full relabel +
 * counter + cleanup contract. Every external seam (gh, runLock.release, counter.read/reset,
 * prExists, blockingFinding) is injected so the frozen oracle can run hermetic.
 * @param {number} issueNumber - The issue this session was dispatched for.
 * @param {string} worktree - Absolute path to the per-run worktree (harness/<issueNumber>).
 * @param {string} bodyFile - Absolute path to the issue-body file written by dispatch; unlinked
 *   on every exit path.
 * @param {string} envFile - Absolute path to the scoped-env file written by dispatch; unlinked
 *   on every exit path (carries scoped secrets — must never accumulate on disk).
 * @param {object} opts - Injected seams.
 * @param {(args: string[]) => unknown} opts.gh - Records/executes a `gh` argv
 *   (e.g. `["issue","edit","42","--remove-label","harness:in-progress","--add-label","harness:done"]`
 *   or `["issue","comment","42","--body","<finding>"]`).
 * @param {{ release: (opts: { stateDir: string, acquireTs: number }) => void }} opts.runLock -
 *   The run-lock seam; release() is called exactly once, on every exit path, with
 *   { stateDir, acquireTs }.
 * @param {{
 *   read: (issueNumber: number, opts: { stateDir: string }) => number,
 *   reset: (issueNumber: number, opts: { stateDir: string }) => void,
 *   increment: (issueNumber: number, opts: { stateDir: string }) => void
 * }} opts.counter - Per-issue attempt-counter seam (mirrors cron-state.mjs). cronAExit reads it
 *   to compare against retryCeilingK and calls reset() on the done path; it must NEVER call
 *   increment() on any exit path.
 * @param {(issueNumber: number) => boolean} opts.prExists - Whether a PR was opened on
 *   harness/<issueNumber> for this run.
 * @param {(issueNumber: number) => (string|null|false|undefined)} opts.blockingFinding - Falsy
 *   if the run recorded no deliberate blocking stop; otherwise the finding message to post via
 *   `gh issue comment`.
 * @param {string} opts.stateDir - Shared cron state dir (counter files, run-lock holder file).
 * @param {number} opts.acquireTs - acquire_ts of the run-lock holder this session registered
 *   under (ownership guard passed through to runLock.release).
 * @param {number} [opts.retryCeilingK] - Retry ceiling K (default 2); at/above K with no PR and
 *   no blocking record, the issue is relabeled harness:blocked instead of harness:ready.
 * @returns {void}
 */
export function cronAExit(issueNumber, worktree, bodyFile, envFile, opts) {
  const {
    gh,
    runLock,
    counter,
    prExists,
    blockingFinding,
    stateDir,
    acquireTs,
    retryCeilingK = DEFAULT_RETRY_CEILING_K,
  } = opts;

  let addLabel;
  let finding = null;
  let hadPr = false;
  let decisionError = null;
  try {
    try {
      hadPr = Boolean(prExists(issueNumber));
      if (hadPr) {
        // Ensure the harness:in-review label exists before the relabel so --add-label never
        // fails against a nonexistent label (mirrors cron-a-select.mjs:57's harness:blocked pattern).
        gh(["label", "create", "harness:in-review", "--force"]);
        addLabel = LABEL_IN_REVIEW;
      } else {
        finding = blockingFinding(issueNumber) || null;
        if (finding) {
          addLabel = LABEL_BLOCKED;
        } else if (counter.read(issueNumber, { stateDir }) >= retryCeilingK) {
          addLabel = LABEL_BLOCKED;
        } else {
          addLabel = LABEL_READY;
        }
      }
    } catch (err) {
      // Unexpected exception in the outcome-decision seam: fall through to a SAFE relabel to
      // harness:ready so the issue is not left stranded in harness:in-progress. Re-throw after
      // the relabel so the failure still surfaces (CLI exits non-zero).
      addLabel = LABEL_READY;
      decisionError = err;
    }

    const relabelResult = gh([
      "issue",
      "edit",
      String(issueNumber),
      "--remove-label",
      LABEL_IN_PROGRESS,
      "--add-label",
      addLabel,
    ]);
    if (!relabelResult || !relabelResult.ok) {
      throw new Error(
        `cron-a-exit: failed to relabel issue ${issueNumber} from ${LABEL_IN_PROGRESS} to ${addLabel}`
      );
    }

    // A deliberately-blocked issue gets the recorded finding posted as a comment so the operator
    // sees WHY it blocked, not just THAT it blocked. Only on the deliberate-block path (never on
    // the retry-ceiling path, which has no finding message to post).
    if (!hadPr && finding) {
      const commentResult = gh(["issue", "comment", String(issueNumber), "--body", String(finding)]);
      if (!commentResult || !commentResult.ok) {
        throw new Error(`cron-a-exit: failed to comment blocking finding on issue ${issueNumber}`);
      }
    }

    if (decisionError) {
      throw decisionError;
    }

    // Additive structured outcome for the composition root to translate into a notification. Does
    // NOT change any relabel/counter/cleanup side effect above; existing callers ignore the return.
    let outcome;
    if (hadPr) outcome = "done";
    else if (finding) outcome = "blocked";
    else if (addLabel === LABEL_BLOCKED) outcome = "failed";
    else outcome = "requeued";
    return { outcome, issueNumber, hadPr, finding };
  } finally {
    // Release the run-lock with the held acquireTs (ownership guard; idempotent if already gone)
    // and unlink the body + env files on EVERY exit path. These are the non-negotiable cleanups:
    // never leave the lock held, never let the issue body or scoped secrets accumulate on the box.
    try {
      runLock.release({ stateDir, acquireTs });
    } catch {
      // best-effort: never mask the exit or skip the file cleanup below
    }
    try {
      rmSync(bodyFile, { force: true });
    } catch {
      // best-effort: a vanished body file is the desired end state
    }
    try {
      rmSync(envFile, { force: true });
    } catch {
      // best-effort: a vanished env file is the desired end state
    }
  }
}

/**
 * @description Real `gh` seam for the CLI: invokes `gh` with the given argv, ignoring stdio. The
 * frozen tests inject a fake; the CLI wires this. Returns { ok } so callers may inspect status.
 * @param {string[]} args
 * @returns {{ ok: boolean }}
 */
function realGh(args) {
  const { status } = spawnSync("gh", args, { stdio: "ignore" });
  return { ok: status === 0 };
}

/**
 * @description Real prExists seam for the CLI: a PR was opened on `harness/<issueNumber>` iff
 * `gh pr list --head harness/<n>` returns at least one open PR. Fail-closed to false on any gh /
 * parse error so a gh outage never fabricates a done label (the issue falls through to the
 * blocked/ready paths, which surface the failure rather than masking it as success).
 * @param {number} issueNumber
 * @returns {boolean}
 */
/**
 * @description True when a PR body links the issue via a GitHub closing/reference keyword
 * (Closes/Fixes/Resolves/Refs #N). Used to recognize a session's PR even when it delivered on a
 * typed feat/fix/docs branch instead of the per-run harness/<N> branch.
 * @param {string} body
 * @param {number} issueNumber
 * @returns {boolean}
 */
export function prLinksIssue(body, issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref(?:s|erences)?)\\s+#${issueNumber}\\b`, "i").test(
    String(body ?? "")
  );
}

/**
 * @description Picks the PR this session produced for the issue from a PR list: preferring the
 * per-run branch `harness/<N>`, else any PR whose body links the issue. Returns {number,url} or null.
 * @param {Array<{number:number,headRefName?:string,url?:string,body?:string}>} prs
 * @param {number} issueNumber
 * @returns {{number:number,url:string}|null}
 */
export function pickSessionPr(prs, issueNumber) {
  if (!Array.isArray(prs)) return null;
  const byBranch = prs.find((p) => p && p.headRefName === `harness/${issueNumber}`);
  const match = byBranch || prs.find((p) => p && prLinksIssue(p.body, issueNumber));
  return match ? { number: match.number, url: match.url } : null;
}

/**
 * @description Real PR lookup: lists open/merged PRs and picks this session's one by branch
 * (harness/<N>) or issue link. Fail-soft → null on any gh/parse error.
 * @param {number} issueNumber
 * @returns {{number:number,url:string}|null}
 */
function realPrLookup(issueNumber) {
  try {
    const { stdout, status } = spawnSync(
      "gh",
      ["pr", "list", "--state", "all", "--json", "number,headRefName,url,body", "--limit", "50"],
      { encoding: "utf8" }
    );
    if (status !== 0) return null;
    return pickSessionPr(JSON.parse(stdout || "[]"), issueNumber);
  } catch {
    return null;
  }
}

/**
 * @description prExists seam: a PR (branch harness/<N> OR issue-linked) exists for the issue.
 * @param {number} issueNumber
 * @returns {boolean}
 */
function realPrExists(issueNumber) {
  return realPrLookup(issueNumber) !== null;
}

/**
 * @description Real blockingFinding seam for the CLI: reads the deliberate-block marker the
 * autonomous session writes at `<worktree>/.claude/harness-blocked.md`. Absent/empty → null (no
 * deliberate blocking stop), else the trimmed finding message to post via `gh issue comment`.
 * @param {string} worktree
 * @returns {string | null}
 */
function realBlockingFinding(worktree) {
  try {
    const text = readFileSync(blockingMarkerPath(worktree), "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
/**
 * @description Translates the cron-a-exit structured outcome into the run's terminal lifecycle
 * signal. Two paths, existsSync-guarded on HARNESS_OBSERVABILITY_RUN_PATH:
 *
 *   OBSERVABILITY PATH (guard set — HARNESS_OBSERVABILITY_RUN_PATH points at a live obs-<issue>.json):
 *     (a) PRODUCE the run's terminal checkpoint into the outbox via appendEvent, BEFORE the close:
 *           - 'done'     -> { type:'PR', pr, url }     (border checkpoint, routed by the drain to the run topic)
 *           - 'blocked'  -> { type:'blocked', reason } (CRITICAL — the drain sends it first to the shared topic)
 *           - 'failed'   -> { type:'failed' }         (CRITICAL — same critical-first path as 'blocked')
 *         This REPLACES the legacy direct sendNotification: the run-cron-a drain delivers it
 *         exactly-once through the cursor, so NO direct notify() is issued here. cron-a-exit
 *         NEVER drains (single-drainer invariant) — the closed forum topic stays admin-bot-writable
 *         so the drain still delivers the PR event on the next tick.
 *     (b) THEN close the run's forum topic reading the threadId from obs-<issue>.json (NEVER the
 *         session) and set status 'closed' via obs-outbox updateMeta. The close token is resolved via
 *         makeNotifier(config, { homeDir }) reading ~/.claude/.dev.vars at runtime — NEVER from the
 *         session env-file or a threaded secret (mirrors the task-4 token judgment).
 *
 *   LEGACY PATH (guard unset): byte-identical to the pre-observability behavior — a direct
 *   sendNotification (session-done / blocked / failed / session-requeued) + drain. Backward compatible.
 *
 * Entirely wrapped: an append/close/notify/gh/drain failure NEVER changes the exit handler's outcome
 * (the critical relabel/lock-release/cleanup already ran synchronously inside cronAExit). Numeric
 * coercion keeps chat_id typed like the module path.
 *
 * @param {{ outcome: string, issueNumber: number, finding: string|null }} outcome
 * @param {object} [deps]
 * @param {object} [deps.env]
 * @param {(issueNumber: number) => ({ number: number, url: string } | null)} [deps.prLookup]
 * @param {(config: object, deps: object) => object} [deps.makeNotifier]
 * @param {(metaPath: string, event: object) => void} [deps.appendEvent]
 * @param {(input: { threadId: number|string }, opts: object) => Promise<{ ok: boolean }>} [deps.closeForumTopic]
 * @param {(metaPath: string) => object|null} [deps.readMeta]
 * @param {(metaPath: string, partial: object) => void} [deps.updateMeta]
 * @param {() => number} [deps.now] - clock seam returning epoch SECONDS (default
 *   `() => Math.floor(Date.now()/1000)`). Stamped as `closedAt` on every status:'closed' write so
 *   the retention sweep can measure age; inject a fixed value in tests for determinism.
 * @param {typeof fetch} [deps.fetch]
 * @param {(entry: object) => void} [deps.log]
 * @returns {Promise<void>}
 */
export async function notifyExit(outcome, deps = {}) {
  const env = deps.env ?? process.env;
  const nowFn = deps.now ?? defaultNow;
  const prLookup = deps.prLookup ?? realPrLookup;
  const makeNotifierFn = deps.makeNotifier ?? makeNotifier;
  const appendEventFn = deps.appendEvent ?? defaultAppendEvent;
  const closeForumTopicFn = deps.closeForumTopic ?? realCloseForumTopic;
  const readMetaFn = deps.readMeta ?? defaultReadMeta;
  const updateMetaFn = deps.updateMeta ?? defaultUpdateMeta;
  try {
    if (!outcome) return;

    const runPath = env.HARNESS_OBSERVABILITY_RUN_PATH;
    const obsEnabled = typeof runPath === "string" && runPath.length > 0 && existsSync(runPath);

    // The notify config block is built from the (non-secret) HARNESS_NOTIFY_* env vars the dispatch
    // step threaded; the token is resolved by makeNotifier from ~/.claude/.dev.vars at runtime.
    const chatId = env.HARNESS_NOTIFY_CHATID;
    const config = {
      homeDir: env.HOME,
      notify: chatId
        ? {
            chatId: Number(chatId),
            threadId: env.HARNESS_NOTIFY_THREADID ? Number(env.HARNESS_NOTIFY_THREADID) : undefined,
          }
        : undefined,
    };

    if (obsEnabled) {
      // A 'requeued' run is NON-terminal (it will retry): keep status 'active' and the topic OPEN so
      // the next createRun reuses this run (pending events are drained before the retry). Closing here
      // would make the next createRun truncate the events log — erasing undelivered events (incl. a
      // possible critical) — and churn a fresh topic per retry. The legacy notify for requeued (guard
      // unset) stays as-is; this gate is observability-path only.
      if (outcome.outcome === "requeued") return;
      // The close token comes from makeNotifier(config,{homeDir}) reading ~/.claude/.dev.vars — never
      // the session env-file. Built here (obs path) so the LEGACY path's project guard still gates
      // makeNotifier for an unconfigured session (no project threaded, no run-path guard).
      const notifier = makeNotifierFn(config, { homeDir: env.HOME });

      // (a) PRODUCE the terminal checkpoint into the outbox BEFORE the close. cron-a-exit NEVER
      // drains — the run-cron-a tick is the single drainer.
      const metaPath = runPath;
      try {
        if (outcome.outcome === "done") {
          const pr = prLookup(outcome.issueNumber);
          appendEventFn(metaPath, { type: "PR", pr: pr?.number, url: pr?.url });
        } else if (outcome.outcome === "blocked") {
          appendEventFn(metaPath, { type: "blocked", reason: outcome.finding });
        } else if (outcome.outcome === "failed") {
          appendEventFn(metaPath, { type: "failed" });
        }
      } catch {
        // fail-open: an append failure never blocks the close or the exit.
      }

      // (b) Close the run's forum topic reading the threadId from obs-<issue>.json (never the
      // session), then set status 'closed' via obs-outbox updateMeta. No double-close: skip when
      // already closed.
      try {
        const meta = readMetaFn(metaPath);
        if (meta && meta.status !== "closed") {
          // Split by outcome:
          // (1) When outcome.outcome==='done', set status to 'awaiting-review' and do NOT close the topic
          // (2) When outcome.outcome is 'blocked' or 'failed', keep today's behavior
          if (outcome.outcome === "done") {
            // Keep the forum topic OPEN and set status to 'awaiting-review'
            updateMetaFn(metaPath, { status: "awaiting-review" });
          } else if (outcome.outcome === "blocked" || outcome.outcome === "failed") {
            // Keep EXACTLY today's behavior for blocked/failed outcomes
            if (meta.threadId != null) {
              const closeResult = await closeForumTopicFn(
                { threadId: meta.threadId },
                { config: notifier?.config ?? null, fetch: deps.fetch, log: deps.log }
              );
              // #235/#ac-1.1: a permanent thread-not-found (the topic is already gone) finalizes the
              // run as closed exactly like a successful close — there is nothing left to retry. A
              // transient failure (reason !== 'thread-not-found') preserves today's behavior: the meta
              // is left at its prior status for a later retry, never prematurely marked closed.
              if (closeResult && (closeResult.ok || closeResult.reason === "thread-not-found")) {
                // topicConfirmedGone (only on the thread-not-found branch, mirroring
                // notify-telegram.mjs's self-heal finalize and run-cron-review.mjs's
                // closeRunTopicOnMerge) so drainTelegramOutbox's isFallback routes any remaining
                // cosmetic event to the shared topic instead of retrying this dead threadId forever.
                // An ok:true close leaves the topic intact (merely archived) — no flag, own thread.
                const partial = { status: "closed", closedAt: nowFn() };
                if (closeResult.reason === "thread-not-found") partial.topicConfirmedGone = true;
                updateMetaFn(metaPath, partial);
              }
            } else {
              // No forum topic was created for this run (createForumTopic failed at dispatch): nothing
              // to close, but the run is terminal — mark it closed so the reaper orphan sweep skips it.
              updateMetaFn(metaPath, { status: "closed", closedAt: nowFn() });
            }
          }
        }
      } catch {
        // fail-open: a close failure never blocks the exit.
      }
      return;
    }

    // LEGACY path (guard unset) — byte-identical to the pre-observability behavior: direct
    // sendNotification + drain. Backward compatible.
    const project = env.HARNESS_NOTIFY_PROJECT;
    if (!project) return; // not an engine-dispatched session (no project threaded) — no-op
    const { notify, drain } = makeNotifierFn(config, { homeDir: env.HOME });
    try {
      if (outcome.outcome === "done") {
        const pr = prLookup(outcome.issueNumber);
        notify({ type: "session-done", project, issue: outcome.issueNumber, pr: pr?.number, url: pr?.url });
      } else if (outcome.outcome === "blocked") {
        notify({ type: "blocked", project, issue: outcome.issueNumber, reason: outcome.finding });
      } else if (outcome.outcome === "failed") {
        notify({ type: "failed", project, issue: outcome.issueNumber });
      } else if (outcome.outcome === "requeued") {
        // Every run finish is reported so the operator always knows what happened — including the
        // transient "session ended without a PR, will retry" case.
        notify({ type: "session-requeued", project, issue: outcome.issueNumber });
      }
    } finally {
      await drain();
    }
  } catch {
    // fail-open: notification must never affect the graceful-exit handler.
  }
}

/**
 * @description Secret-shaped substring patterns replaced by scrubSecrets(), applied in sequence.
 * Covers: Anthropic keys, JWTs, GitHub token/PAT prefixes, URL-embedded userinfo credentials,
 * Authorization: Basic headers, generic sk- prefixed keys (superset of sk-ant), GitLab tokens,
 * Bearer headers, and KEY|TOKEN|SECRET|PASSWORD assignments in both `=` and colon (JSON/YAML)
 * form — the shapes most likely to leak into a `gh`/curl-heavy session's raw output log. This is
 * SHAPE-based; scrubSecrets() also applies a VALUE-based pass (see below) for arbitrary-value
 * secrets that have no distinguishing shape.
 */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /gh[opsu]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bhttps?:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  /Basic\s+[A-Za-z0-9+/=]+/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgl(?:pat|ptt|rt)-[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[^\s"',]+/gi,
];
const SECRET_REDACTION_MARKER = "[REDACTED]";

/**
 * @description Name pattern for env vars whose VALUE is treated as a secret for the value-based
 * redaction pass, regardless of shape (e.g. OLLAMA_HAND_TOKEN, ANTHROPIC_AUTH_TOKEN).
 */
const SECRET_ENV_NAME_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i;

/**
 * @description Minimum length an env value must have to be eligible for value-based redaction —
 * short values (e.g. flags, single chars) are not redacted to avoid blanking ordinary log content.
 */
const MIN_SECRET_VALUE_LENGTH = 6;

/**
 * @description Redacts secret-shaped substrings from session output before it is persisted, THEN
 * redacts the literal VALUE of every env var whose name matches SECRET_ENV_NAME_PATTERN and whose
 * value is at least MIN_SECRET_VALUE_LENGTH long — this catches arbitrary-value secrets (no
 * distinguishing shape) that the pattern list alone would miss. Value matching is a literal
 * split/join (never a dynamically-built RegExp) so a value containing regex metacharacters can
 * never throw. Best-effort: any error during the value-based pass never propagates. A non-string
 * `text` input returns an empty string rather than throwing.
 * @param {string} text
 * @param {Record<string, string | undefined>} [env] - Defaults to process.env in production;
 *   tests always pass an explicit env object.
 * @returns {string}
 */
export function scrubSecrets(text, env = process.env) {
  if (typeof text !== "string") return "";
  let scrubbed = SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, SECRET_REDACTION_MARKER), text);
  try {
    const source = env && typeof env === "object" ? env : {};
    for (const [name, value] of Object.entries(source)) {
      if (!SECRET_ENV_NAME_PATTERN.test(name)) continue;
      if (typeof value !== "string" || value.length < MIN_SECRET_VALUE_LENGTH) continue;
      scrubbed = scrubbed.split(value).join(SECRET_REDACTION_MARKER);
    }
  } catch {
    // best-effort: value-based redaction must never throw
  }
  return scrubbed;
}

/**
 * @description Categorizes a non-PR exit for the diagnostic reason file: exitCode===0 is the
 * dominant graceful requeue (`no-pr-produced`), any other numeric exitCode is `tool-error`, and a
 * missing/unparseable exitCode is `unknown`.
 * @param {number|undefined} exitCode
 * @returns {"no-pr-produced"|"tool-error"|"unknown"}
 */
function categorizeExit(exitCode) {
  if (exitCode === 0) return "no-pr-produced";
  if (typeof exitCode === "number" && !Number.isNaN(exitCode)) return "tool-error";
  return "unknown";
}

/**
 * @description Max number of trailing bytes read from a raw log to derive the last-200-lines
 * summary. Bounds memory regardless of log size — a whole-file read on a huge agentic log can OOM,
 * and an OOM mid-read would skip the finally-unlink, leaving the raw unscrubbed log on disk.
 */
const LOG_TAIL_MAX_BYTES = 256 * 1024;

/**
 * @description Reads only the last `maxBytes` of a file (or the whole file when smaller) via
 * statSync + openSync/readSync into a bounded Buffer — never loads the full file into memory.
 * @param {string} path
 * @param {number} maxBytes
 * @returns {string} The trailing slice of the file, decoded as utf8.
 */
function readTail(path, maxBytes) {
  const { size } = statSync(path);
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

/**
 * @description Best-effort persists the diagnostic exit-reason file for a non-PR session exit;
 * NEVER throws and never alters the exit. On a 'done' (PR-produced) outcome it writes nothing.
 * On any non-'done' outcome it reads the last 200 lines of `logPath` (when present/readable),
 * scrubs secrets from the summary, categorizes the exit, and writes
 * `stateDir/issue-<issueNumber>-exit-reason.json` (mode 0o600). On EVERY outcome, including
 * 'done', it best-effort unlinks the raw log at `logPath` in a finally so unscrubbed session
 * output never persists.
 * @param {object} args
 * @param {string} args.stateDir
 * @param {{ outcome: string, issueNumber: number, hadPr: boolean, finding: string|null }} args.outcome
 * @param {number|undefined} args.exitCode
 * @param {string|undefined} args.logPath
 * @param {() => number} [args.now] - clock seam returning epoch SECONDS.
 * @returns {void}
 */
export function captureExitReason({ stateDir, outcome, exitCode, logPath, now = defaultNow }) {
  try {
    if (outcome && outcome.outcome !== "done") {
      let summary = "";
      if (logPath) {
        try {
          const rawLog = readTail(logPath, LOG_TAIL_MAX_BYTES);
          const lines = rawLog.split("\n");
          const last200 = lines.slice(Math.max(0, lines.length - 200));
          summary = scrubSecrets(last200.join("\n"), process.env);
        } catch {
          summary = "";
        }
      }

      const reasonFile = join(stateDir, `issue-${outcome.issueNumber}-exit-reason.json`);
      const payload = {
        outcome: outcome.outcome,
        timestamp: now(),
        category: categorizeExit(exitCode),
        summary,
      };
      try {
        // Remove any pre-existing reason file first so the create-fresh writeFileSync mode 0o600
        // actually applies from the start — otherwise a stale permissive file could briefly hold
        // the new summary before chmodSync tightens it.
        rmSync(reasonFile, { force: true });
        writeFileSync(reasonFile, JSON.stringify(payload), { mode: 0o600 });
        chmodSync(reasonFile, 0o600);
      } catch {
        // best-effort: a write failure never blocks the exit or throws
      }
    }
  } catch {
    // best-effort: capture must never affect the exit handler
  } finally {
    if (logPath) {
      try {
        rmSync(logPath, { force: true });
      } catch {
        // best-effort: a vanished/unreadable raw log is the desired end state
      }
    }
  }
}

/**
 * @description Parses and validates the CLI argv: `<issueNumber> <worktree> <bodyFile> <envFile>
 * [logPath] [exitCode]`. The throw-guard applies ONLY to the original first 4 args, so an
 * in-flight OLD 4-arg session still exits cleanly; `logPath`/`exitCode` are optional additions.
 * @param {string[]} argv - process.argv.slice(2) from the CLI entry.
 * @returns {{ issueNumber: number, worktree: string, bodyFile: string, envFile: string, logPath: string|undefined, exitCode: number|undefined }}
 */
export function parseArgv(argv) {
  const [issueNumber, worktree, bodyFile, envFile] = argv;
  if (!issueNumber || !worktree || !bodyFile || !envFile) {
    throw new Error(
      `cron-a-exit: expected 4 args <issueNumber> <worktree> <bodyFile> <envFile>, got: ${JSON.stringify(argv)}`
    );
  }
  const issueNum = Number(issueNumber);
  if (!Number.isInteger(issueNum)) {
    throw new Error(`cron-a-exit: issueNumber must be an integer, got: ${JSON.stringify(issueNumber)}`);
  }
  return {
    issueNumber: issueNum,
    worktree,
    bodyFile,
    envFile,
    logPath: argv[4],
    exitCode: argv[5] !== undefined ? Number(argv[5]) : undefined,
  };
}

/**
 * @description Testable CLI orchestration: parseArgv -> cronAExit -> notifyExit ->
 * captureExitReason, with every seam injectable via `deps` and defaulting to the real production
 * bindings. `main()` calls this with real deps so the composition root itself is hermetically
 * testable — a fake-injecting unit test on the helpers alone could pass while leaving
 * captureExitReason unwired in production.
 * @param {string[]} argv - process.argv.slice(2).
 * @param {object} [deps] - Injectable seams; each defaults to the real binding.
 * @returns {Promise<void>}
 */
export async function runCronAExitCli(argv, deps = {}) {
  const parseArgvFn = deps.parseArgv ?? parseArgv;
  const cronAExitFn = deps.cronAExit ?? cronAExit;
  const notifyExitFn = deps.notifyExit ?? notifyExit;
  const captureExitReasonFn = deps.captureExitReason ?? captureExitReason;
  const readHolderFn = deps.readHolder ?? readHolder;
  const ghFn = deps.gh ?? realGh;
  const runLockObj = deps.runLock ?? { release: releaseLock };
  const counterObj = deps.counter ?? { read: readCounter, reset: resetCounter, increment: incrementCounter };
  const prExistsFn = deps.prExists ?? realPrExists;
  const retryCeilingK = deps.retryCeilingK ?? DEFAULT_RETRY_CEILING_K;
  const nowFn = deps.now ?? defaultNow;

  const { issueNumber, worktree, bodyFile, envFile, logPath, exitCode } = parseArgvFn(argv);
  const stateDir = dirname(bodyFile);
  const blockingFindingFn = deps.blockingFinding ?? (() => realBlockingFinding(worktree));

  let acquireTs = deps.acquireTs;
  if (acquireTs === undefined) {
    const holder = readHolderFn({ stateDir });
    acquireTs = holder ? holder.acquire_ts : undefined;
  }

  const outcome = cronAExitFn(issueNumber, worktree, bodyFile, envFile, {
    gh: ghFn,
    runLock: runLockObj,
    counter: counterObj,
    prExists: prExistsFn,
    blockingFinding: blockingFindingFn,
    stateDir,
    acquireTs,
    retryCeilingK,
  });

  // Best-effort notification AFTER the synchronous relabel/lock-release/cleanup already completed
  // inside cronAExit. A rejection here is swallowed by notifyExit and never escapes.
  await notifyExitFn(outcome);

  // Reason capture runs LAST, after notifyExit resolves — never inside cronAExit (keeps it
  // byte-identical) and never before the notification it describes.
  captureExitReasonFn({ stateDir, outcome, exitCode, logPath, now: nowFn });
}

/**
 * @description CLI entry: delegates to runCronAExitCli with real deps (parseArgv, cronAExit,
 * notifyExit, captureExitReason, gh, run-lock, counter, prExists, blockingFinding all default to
 * their production bindings).
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {Promise<void>}
 */
export async function main(argv) {
  await runCronAExitCli(argv, {});
}

if (isDirectCli(import.meta.url)) {
  // main is async: await it and catch so a notify/gh/drain rejection can never become an
  // unhandledRejection that crashes the detached session, and never changes the exit code after
  // the critical cleanup already ran.
  main(process.argv.slice(2)).catch((err) => {
    console.error(`cron-a-exit: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}