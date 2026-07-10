#!/usr/bin/env node
/**
 * @description VPS cron harness — Cron Review COMPOSITION ROOT (HR-7 / HR-8, #ac-7.1 / #ac-6.2). A
 * crontab invokes this file directly: `node core/vps/run-cron-review.mjs --config <project.json>`.
 * It owns a SEPARATE lock/state scope from cron-a/cron-b — `join(config.stateDir, "review")` — so
 * the independent PR-review phase never blocks, and is never blocked by, the select/merge crons'
 * lock on the base `config.stateDir`.
 *
 * Guard order (checked BEFORE any spawn is ever attempted):
 *   1. Operator kill switch — `config.reviewEnabled === false` returns without touching any other
 *      seam (no lock, no breaker check, no `deps.cronReview` call).
 *   2. Windowed circuit-breaker — `deps.breakerTripped({stateDir: reviewStateDir, now})`. A tripped
 *      breaker emits a `deps.notify({type: "review-breaker-tripped", ...})` event so the stall is
 *      always OBSERVABLE, never silent, and returns without acquiring the lock.
 *   3. The review lock itself (`deps.runLock.acquire` on `reviewStateDir`) — an unacquired lock
 *      (another review cycle still running) returns without calling `deps.cronReview`.
 *
 * `deps.breakerTripped` / `deps.recordReviewSession` DEFAULT to the REAL functions from
 * ./cron-state.mjs, scoped to `reviewStateDir` — never a no-op default — so the real
 * BREAKER_MAX_SESSIONS-per-window cap is what actually gates production spawns.
 *
 * Every other seam cron-review.mjs's `cronReview(opts)` contract needs (`gh`, `isReviewEligible`,
 * `getFreshVerdict`, `alreadyReviewed`, `incrementInfraFailure`, `atInfraFailureCeiling`,
 * `authenticatedUser`) defaults to its real, already-implemented sibling module, wired exactly as
 * cronReview calls it.
 * `mergeAndFinalize` and `reconcile` need MORE context than cronReview's own call site passes
 * through (a `counter`/`recordReviewed` adapter onto ./cron-state.mjs) — this composition root
 * supplies that extra context via a bound closure, mirroring run-cron-b.mjs's `harnessAuthorLogin`
 * composition.
 *
 * Two seams have NO production implementation anywhere in this repo yet — a separate, dedicated
 * task's responsibility, not invented here: `engineKnows` (the secondary machine-origin cross-check)
 * and `routeReject`'s `recordFindings`. Their defaults are documented, fail-closed stubs (see below)
 * rather than a guessed implementation. `spawnReviewSession` IS wired to the real production
 * actuator (./spawn-review-session.mjs), bound with this composition root's `gh`/`spawn`/`notify`
 * seams — it refuses invalid `pr.number`/`pr.headSha` without throwing.
 *
 * @param {object} config
 * @param {string} config.project
 * @param {string} config.owner
 * @param {string} config.repo
 * @param {string} config.projectRoot
 * @param {string} config.stateDir
 * @param {string} config.worktreeRoot
 * @param {string} config.homeDir
 * @param {boolean} [config.reviewEnabled] - operator kill switch; `false` disables the whole phase
 * @param {object} [deps] - Injectable seams; each defaults to the real wiring when omitted.
 * @param {(opts: object) => void} [deps.cronReview] - default: real cronReview from ./cron-review.mjs
 * @param {object} [deps.runLock] - default: real { acquire, release } from ./run-lock.mjs
 * @param {number} [deps.pid] - default: process.pid
 * @param {() => number} [deps.now] - default: epoch-seconds clock
 * @param {(pid: number) => void} [deps.kill] - default: process.kill
 * @param {(sessionId: string) => boolean} [deps.tmuxHasSession] - default: real `tmux has-session` probe
 * @param {(o: {stateDir: string, now?: number}) => boolean} [deps.breakerTripped] - default: real breakerTripped from ./cron-state.mjs
 * @param {(o: {stateDir: string, now?: number}) => void} [deps.recordReviewSession] - default: real recordReviewSession from ./cron-state.mjs
 * @param {(event: object) => void} [deps.notify] - default: no-op
 * @param {(o?: object) => Promise<object|null>} [deps.loadCodexDriver] - optional override for the 2nd-family driver load
 * @returns {Promise<void>}
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cronReview, extractRoot } from "./cron-review.mjs";
import { readMeta, updateMeta as realUpdateMeta } from "./obs-outbox.mjs";
import { spawnReviewSession } from "./spawn-review-session.mjs";
import { acquire, release } from "./run-lock.mjs";
import * as cronState from "./cron-state.mjs";
import { incrementInfraFailure, atInfraFailureCeiling } from "./cron-state.mjs";
import { isReviewEligible } from "./review-origin-gate.mjs";
import { getFreshVerdict } from "./review-verdict-source.mjs";
import { crossFamilyEligible, deriveSecondFamilyVerdict } from "./review-cross-family.mjs";
import { mergeAndFinalize, reconcile } from "./review-merge.mjs";
import { releaseChainedDependents } from "./chain-release.mjs";
import { routeReject, persistReviewFindings } from "./review-routing.mjs";
import { scopedGh, defaultGhExec } from "./gh-exec.mjs";
import { makeNotifier, closeForumTopic as realCloseForumTopic } from "./notify-telegram.mjs";
import { loadConfig } from "./run-cron-a.mjs";
import { drainWithLock } from "./drain-lock.mjs";
// #235/task-7: reuses run-reaper.mjs's gh-scoped makeDefaultIssueClosed for the drain's issueOpen
// seam (no new dependency) — same pattern as run-drain.mjs/run-cron-a.mjs (task-5/task-6).
import { makeDefaultIssueClosed } from "./run-reaper.mjs";

/**
 * @description Real authenticated-gh-user lookup: `gh api user --jq .login`. Returns "" on
 * failure (fail-closed: an empty login makes isReviewEligible's author-match reject every PR).
 * @returns {string}
 */
function defaultGetAuthenticatedGhUser() {
  const res = spawnSync("gh", ["api", "user", "--jq", ".login"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0 || res.error) return "";
  return (res.stdout || "").trim();
}

/** @description Real `tmux has-session -t <id>` liveness probe — true iff the session exists. */
function defaultTmuxHasSession(sessionId) {
  const res = spawnSync("tmux", ["has-session", "-t", sessionId], { stdio: "ignore" });
  return res.status === 0 && !res.error;
}

/**
 * @description Secondary machine-origin cross-check has no production implementation yet — fail
 * closed (never confirms), so only the PRIMARY harness/* branch signal (which never calls this)
 * can make a PR review-eligible until a dedicated engine-knowledge module lands.
 */
function defaultEngineKnows() {
  return false;
}

/**
 * @description Loads the vendored Codex cross-family driver ONCE at composition-root setup.
 * Fail-open: any import or runtime failure returns null so an absent/unreachable second family
 * degrades to the Claude-only path instead of crashing review.
 * @returns {Promise<{runCodexRole: Function, checkAvailability: Function, composeRolePrompt: Function, securityVerdict: Function}|null>}
 */
async function defaultLoadCodexDriver() {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const ca = await import(join(root, ".claude/modules/codex-adversary/references/codex-adversary.mjs"));
    const mf = await import(join(root, ".claude/modules/codex-adversary/references/merge-findings.mjs"));
    return {
      runCodexRole: ca.runCodexRole,
      checkAvailability: ca.checkAvailability,
      composeRolePrompt: ca.composeRolePrompt,
      securityVerdict: mf.securityVerdict,
    };
  } catch {
    return null;
  }
}

export async function runCronReview(config, deps = {}) {
  // Kill switch — checked FIRST, before touching any other seam (no lock, no breaker, no spawn).
  if (config.reviewEnabled === false) {
    return;
  }

  const reviewStateDir = join(config.stateDir, "review");
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const notify = deps.notify ?? (() => {});

  // Add a base-stateDir obs-reader seam for resolving run thread IDs
  const resolveRunThreadId = deps.resolveRunThreadId ?? ((rootIssue) => {
    try {
      const meta = readMeta(join(config.stateDir, `obs-${rootIssue}.json`));
      return meta && meta.threadId != null ? meta.threadId : null;
    } catch {
      return null;
    }
  });

  // Normal lifecycle event types that should be routed to run topics when possible
  const NORMAL_LIFECYCLE_TYPES = new Set([
    "review-started",
    "pr-awaiting-merge",
    "pr-merged",
    "pr-branch-updated-retry"
  ]);

  const safeNotify = (event) => {
    try {
      // Check if this is a normal lifecycle event that should be routed to a run topic
      const root = event && (event.root ?? extractRoot(event.headRefName));
      if (event && NORMAL_LIFECYCLE_TYPES.has(event.type) && root != null) {
        // Try to resolve the threadId for this root issue
        let threadId;
        try {
          threadId = resolveRunThreadId(root);
        } catch {
          // fail-open: if resolveRunThreadId throws, fall through to global notification
          threadId = null;
        }

        // If we successfully resolved a threadId, route the event to that run topic ONLY
        // (suppress from global topic - this is the new routing rule)
        const routed = threadId != null;
        if (routed) {
          // Notify with threadId so it gets routed to the run topic ONLY
          return notify({ project: config.project, ...event, threadId });
        }
        // If we didn't resolve a threadId, fall through to global notification (H2 requirement)
      }

      // All other events (including unrouted normal lifecycle events) go to global topic
      return notify({ project: config.project, ...event });
    } catch {
      // fail-open — a notify failure never masks the breaker's stall or blocks the cycle
      return undefined;
    }
  };

  const breakerTrippedFn = deps.breakerTripped ?? cronState.breakerTripped;
  const recordReviewSessionFn = deps.recordReviewSession ?? cronState.recordReviewSession;

  // Circuit-breaker gate BEFORE acquiring the lock — a tripped breaker must never spawn, and the
  // stall must always be observable via notify, never silent.
  // `now` is kept as a `() => number` clock function for run-lock.acquire below, but cron-state's
  // breakerTripped/recordReviewSession expect a NUMERIC now — so it is INVOKED (`now()`) at this
  // boundary, never passed through as the function itself (that degraded the window-rollover
  // comparison to NaN and left the breaker unable to ever recover).
  if (breakerTrippedFn({ stateDir: reviewStateDir, now: now() })) {
    safeNotify({ type: "review-breaker-tripped", project: config.project, stateDir: reviewStateDir });
    return;
  }

  const runLock = deps.runLock ?? { acquire, release };
  const pid = deps.pid ?? process.pid;
  const kill = deps.kill ?? process.kill;
  const tmuxHasSession = deps.tmuxHasSession ?? defaultTmuxHasSession;

  const lock = runLock.acquire({ stateDir: reviewStateDir, pid, now, kill, tmuxHasSession });
  if (!lock.acquired) {
    return;
  }

  const codexDriver = await (deps.loadCodexDriver ?? defaultLoadCodexDriver)();

  // Close-on-merge helper: reads base obs meta and closes forum topic when merged and not already closed.
  // `notifyConfig` is the RESOLVED notifier config (carrying the real bot token), never the token-less
  // project `config` — closeForumTopic -> callTelegramMethod early-returns {ok:false} without a network
  // call when `!config.token`, so passing the bare project config makes the close a guaranteed no-op.
  const closeForumTopic = deps.closeForumTopic ?? realCloseForumTopic;
  const notifyConfig = deps.notifyConfig ?? makeNotifier(config, { homeDir: config.homeDir }).config;
  const readMetaBound = (metaPath) => {
    try {
      return (deps.readMeta ?? readMeta)(metaPath);
    } catch {
      return null;
    }
  };
  const updateMeta = deps.updateMeta ?? realUpdateMeta;

  // Close is CONFIRMED before persisting 'closed': closeForumTopic is async and fail-open
  // ({ok:false} on 429/timeout/network/no-token). Persisting 'closed' unconditionally on a
  // transient send failure would leave the topic OPEN forever while the meta lies 'closed' — the
  // reaper skips a status:'closed' meta, so that PR would never be re-closed. An explicit {ok:true}
  // settlement OR a permanent {ok:false, reason:'thread-not-found'} (#235/#ac-1.1: the topic is
  // already gone — this run's PR just merged, arguably the single most likely trigger for a stale
  // dead topic) writes the terminal status; any OTHER failure (transient, or a throw) leaves the
  // meta as-is ('awaiting-review') so a later reconcile/reaper sweep can retry the close (#ac-1.2).
  const closeRunTopicOnMerge = async (issueNumber, { fetch, log } = {}) => {
    try {
      const metaPath = join(config.stateDir, `obs-${issueNumber}.json`);
      const meta = readMetaBound(metaPath);

      // Idempotent: only close when status is not 'closed' AND threadId is present
      if (meta && meta.status !== 'closed' && meta.threadId != null) {
        // Fail-open: wrap in try/catch so a close/update failure never throws
        try {
          const res = await closeForumTopic({ threadId: meta.threadId }, { config: notifyConfig, fetch, log });
          if (res && (res.ok === true || res.reason === 'thread-not-found')) {
            // #235/final-review: a thread-not-found close here is the SAME "confirmed dead topic"
            // signal notify-telegram.mjs's self-heal finalize stamps topicConfirmedGone for — flag it
            // identically so drainTelegramOutbox's isFallback routes any remaining cosmetic event to
            // the shared topic on the next tick instead of retrying this now-dead threadId forever.
            // An ok:true close (the topic is merely archived, not confirmed gone) does NOT set it —
            // that topic still exists and keeps receiving sends to its own thread (no regression).
            const partial = { status: 'closed', closedAt: now() };
            if (res.reason === 'thread-not-found') partial.topicConfirmedGone = true;
            updateMeta(metaPath, partial);
          }
        } catch {
          // Silent fail - never break reconcile/chain-release/the cycle
        }
      }
    } catch {
      // Silent fail - never break reconcile/chain-release/the cycle
    }
  };

  const ghExec = deps.ghExec ?? defaultGhExec;
  const gh = deps.gh ?? scopedGh(config.owner, config.repo, ghExec);
  const authenticatedUser = deps.authenticatedUser ?? defaultGetAuthenticatedGhUser;
  const alreadyReviewedFn = deps.alreadyReviewed ?? cronState.alreadyReviewed;

  // mergeAndFinalize / reconcile need MORE context than cronReview's own call site passes through
  // (a counter/recordReviewed adapter) — supplied here via a bound closure.
  // For auto-path close-on-merge: collect auto-merged issues so the post-loop close (in the
  // `finally` below) fires for them too. This wraps the RESOLVED mergeAndFinalize — whether
  // `deps.mergeAndFinalize` was injected OR the default real one — so an injected mergeAndFinalize
  // (as the test fakes do) still gets its {merged:true} results collected.
  const autoMergedIssues = [];
  const resolvedMergeAndFinalize =
    deps.mergeAndFinalize ??
    ((pr, sha, o) => mergeAndFinalize(pr, sha, { ...o, counter: cronState, recordReviewed: cronState.recordReviewed }));
  const mergeAndFinalizeFn = (pr, sha, o) => {
    const result = resolvedMergeAndFinalize(pr, sha, o);
    if (result && result.merged === true) {
      const rootIssue = extractRoot(pr.headRefName);
      if (rootIssue !== null) {
        autoMergedIssues.push(rootIssue);
      }
    }
    return result;
  };
  // The per-cycle reconcile closure does TWO merge-driven things, both keyed on merged-PR ground
  // truth and both merge-mode-agnostic (auto-merge OR operator manual-merge): (1) self-heal any
  // issue whose PR merged but whose done relabel was missed, and (2) release the roadmap's chained
  // dependents whose dependencies have all merged (or strand a subtree under a dead dependency).
  // Chaining lives HERE — not on the auto-merge-only mergeAndFinalize path — so a manual merge (the
  // shipped default) still advances the roadmap. Best-effort: a chaining failure never breaks the
  // self-heal or the review cycle. Close-on-merge runs ONCE per issue here — never double-wrapped
  // on top of an injected `deps.reconcile`, since this closure already honors that seam.
  const reconcileFn = async () => {
    const healed = deps.reconcile
      ? await deps.reconcile()
      : reconcile({ gh, counter: cronState, stateDir: reviewStateDir });

    // Close run topics for manually merged issues (close-on-merge, shipped default path)
    // Iterate the healed list which contains merged issues [{issue, from}]. AWAITED so the close
    // send actually settles (and the meta transition is observable) before reconcile resolves.
    if (Array.isArray(healed)) {
      for (const { issue } of healed) {
        await closeRunTopicOnMerge(issue, { fetch: globalThis.fetch, log: () => {} });
      }
    }

    try {
      releaseChainedDependents({ gh, notify: safeNotify });
    } catch {
      // fail-open — the roadmap simply doesn't advance this cycle; it retries next cycle
    }
    return healed;
  };

  // crossFamilyEligible is fail-open ONLY on a genuinely absent verdict (no Codex result at all —
  // driver absent, head drift, empty diff): the operator accepted that trade-off (Codex budget does
  // not sustain running it on every PR). A verdict that actually ran always governs, and an INFRA
  // failure (the diff-fetch sentinel below) is forced fail-CLOSED — flaky infra must never hand out a
  // no-second-family auto-merge. The default closure runs the vendored Codex 2nd family synchronously
  // per PR, writes a sibling artifact, and returns a plain boolean. The driver is loaded ONCE above;
  // the closure itself stays sync so the cron-review boolean conjunction never truthy-coerces a Promise.
  const crossFamilyEligibleFn =
    deps.crossFamilyEligible ??
    ((pr, { changedFiles, sha, stateDir: sd }) => {
      const writeArtifact = (obj) => {
        try {
          mkdirSync(sd, { recursive: true });
          writeFileSync(join(sd, `review-${pr.number}-${sha}.crossfamily.json`), JSON.stringify(obj));
        } catch {
          // best-effort artifact; eligibility is still decided by the boolean return
        }
      };

      const avail = codexDriver?.checkAvailability({});
      if (!codexDriver || !avail?.ok) {
        writeArtifact({ available: false, verdict: null, adversaryClean: false, securitySecure: false });
        return crossFamilyEligible(pr, { available: false, secondFamilyVerdict: null });
      }

      const view = gh(["pr", "view", String(pr.number), "--json", "headRefOid"]);
      const currentHead = view && view.headRefOid;
      if (currentHead !== sha) {
        writeArtifact({ available: false, verdict: null, adversaryClean: false, securitySecure: false });
        return crossFamilyEligible(pr, { available: false });
      }

      const patch = gh(["pr", "diff", String(pr.number)]);
      // A transient patch-fetch failure (gh-exec's {ok:false, diffFailed:true} sentinel) is an INFRA
      // failure, NOT the operator's accepted "Codex never ran" absence — it must stay fail-CLOSED, or a
      // flaky `gh` call would silently make a PR auto-merge-eligible with zero second-family check.
      if (patch && patch.diffFailed) {
        writeArtifact({ available: false, verdict: null, adversaryClean: false, securitySecure: false, diffFailed: true });
        return false;
      }
      if (typeof patch !== "string" || patch.length === 0) {
        writeArtifact({ available: false, verdict: null, adversaryClean: false, securitySecure: false });
        return crossFamilyEligible(pr, { available: false });
      }

      const boundSpawn = (bin, a, o) => spawnSync(bin, a, { ...o, timeout: 120000, killSignal: "SIGKILL" });
      const HAND_TOKEN_ENV_KEYS = ["OLLAMA_HAND_TOKEN", "ANTHROPIC_AUTH_TOKEN"];
      const scrubbedEnv = { ...process.env };
      for (const k of HAND_TOKEN_ENV_KEYS) delete scrubbedEnv[k];

      const advPrompt = codexDriver.composeRolePrompt({ role: "adversary", taskJson: patch });
      const adv = codexDriver.runCodexRole({ role: "adversary", prompt: advPrompt, availability: avail, spawn: boundSpawn, env: scrubbedEnv });
      const secPrompt = codexDriver.composeRolePrompt({ role: "security", taskJson: patch });
      const sec = codexDriver.runCodexRole({ role: "security", prompt: secPrompt, availability: avail, spawn: boundSpawn, env: scrubbedEnv });

      const advIssues = Array.isArray(adv.output?.issues) ? adv.output.issues : null;
      const secIssues = Array.isArray(sec.output?.issues) ? sec.output.issues : null;
      // An eye counts as a genuine pass ONLY if it ran, returned a valid issues[] array, and did not
      // explicitly declare UNSAFE. A malformed / verdict-UNSAFE output fails CLOSED (treated as absent).
      const advOk = adv.available === true && advIssues !== null && String(adv.output?.verdict ?? "").trim().toUpperCase() !== "UNSAFE";
      const secOk = sec.available === true && secIssues !== null && String(sec.output?.verdict ?? "").trim().toUpperCase() !== "UNSAFE";
      const codexEyes = {
        adversary: { available: advOk, issues: advIssues ?? [] },
        security: { available: secOk, issues: secIssues ?? [] },
      };

      const verdict = deriveSecondFamilyVerdict(codexEyes, { securityVerdict: codexDriver.securityVerdict });
      const available = Boolean(advOk && secOk);
      const adversaryClean = advOk && codexDriver.securityVerdict(advIssues ?? []) === "SECURE";
      const securitySecure = secOk && codexDriver.securityVerdict(secIssues ?? []) === "SECURE";

      // RAW execution signal — did the eye actually RUN (spawn ok + status 0 + parseable)? This is the
      // codex-adversary `available` flag STRAIGHT off runCodexRole, NOT the collapsed advOk/secOk (which
      // conflate "did not run" with "ran and failed UNSAFE"). Absence must be decided on "did it run?".
      const advRan = adv.available === true;
      const secRan = sec.available === true;
      // A Codex eye BLOCKS only if it RAN and is not FULLY clean — includes an UNSAFE verdict, a HIGH
      // issue behind a SECURE verdict (securityVerdict of the issues), or a malformed output.
      const advFlagged = advRan && !adversaryClean;
      const secFlagged = secRan && !securitySecure;

      if (advFlagged || secFlagged) {
        // A Codex eye ran and flagged a real problem — a genuine second-family BLOCK. Preserve today's
        // behavior: write the derived (BLOCKED) verdict + available:false → crossFamilyEligible blocks.
        writeArtifact({ available, verdict: verdict.status, adversaryClean, securitySecure });
        return crossFamilyEligible(pr, { available, secondFamilyVerdict: verdict });
      }

      if (adversaryClean && securitySecure) {
        // Both eyes ran FULLY clean — a real cross-family CLEAN.
        writeArtifact({ available, verdict: verdict.status, adversaryClean, securitySecure });
        return crossFamilyEligible(pr, { available, secondFamilyVerdict: verdict });
      }

      // Otherwise: NO eye produced a real (blocking) opinion, and it is not a full clean pass — i.e. at
      // least one eye FAILED TO RUN (rate-limit / timeout / hang / auth) and no eye flagged anything.
      // This is a GENUINE ABSENCE of a second-family opinion, indistinguishable from switch-off / no-sub.
      // Fail-OPEN exactly like the true-absence branches above (verdict:null): a Codex that can't run on
      // the operator's subscription budget must NOT hold auto-merge hostage. Safety: a real UNSAFE always
      // carries available:true (runCodexRole line 342 is the only available:true return), so this path
      // can never swallow a real finding. verdict:null is written DIRECT — NOT through
      // deriveSecondFamilyVerdict (which never returns null), or the fail-open would be unreachable.
      writeArtifact({ available: false, verdict: null, adversaryClean: false, securitySecure: false });
      return crossFamilyEligible(pr, { available: false, secondFamilyVerdict: null });
    });

  const autoMergeEnabled = config.autoMergeEnabled === true;

  const chain = {
    increment: (root) => cronState.incrementChain(root, { stateDir: reviewStateDir }),
    atCeiling: (root) => cronState.atCeiling(root, { stateDir: reviewStateDir }),
    reset: (root) => cronState.resetChain(root, { stateDir: reviewStateDir }),
    read: (root) => cronState.readChain(root, { stateDir: reviewStateDir }),
  };
  const reviewed = {
    alreadyReviewed: (prNumber, sha) => cronState.alreadyReviewed(prNumber, sha, { stateDir: reviewStateDir }),
    recordReviewed: (prNumber, sha) => cronState.recordReviewed(prNumber, sha, { stateDir: reviewStateDir }),
  };
  const routeRejectFn =
    deps.routeReject ??
    ((pr, sha, o) =>
      routeReject(pr, sha, {
        ...o,
        chain,
        reviewed,
        recordFindings:
          deps.recordFindings ??
          ((root, findings, ctx) =>
            persistReviewFindings(root, findings, {
              ...ctx,
              reviewStateDir,
              outStateDir: config.stateDir,
            })),
        notify: safeNotify,
      }));

  const cronReviewFn = deps.cronReview ?? cronReview;

  try {
    await cronReviewFn({
      gh,
      isReviewEligible: deps.isReviewEligible ?? isReviewEligible,
      getFreshVerdict: deps.getFreshVerdict ?? getFreshVerdict,
      crossFamilyEligible: crossFamilyEligibleFn,
      mergeAndFinalize: mergeAndFinalizeFn,
      reconcile: reconcileFn,
      routeReject: routeRejectFn,
      spawnReviewSession:
        deps.spawnReviewSession ??
        ((pr, meta) =>
          spawnReviewSession(pr, meta, {
            projectRoot: config.projectRoot,
            gh,
            spawn: spawnSync,
            notify: safeNotify,
          })),
      notify: safeNotify,
      stateDir: reviewStateDir,
      authenticatedUser,
      engineKnows: deps.engineKnows ?? defaultEngineKnows,
      recordReviewSession: recordReviewSessionFn,
      breakerTripped: breakerTrippedFn,
      alreadyReviewed: alreadyReviewedFn,
      recordReviewed: deps.recordReviewed ?? cronState.recordReviewed,
      stalledNotified: deps.stalledNotified ?? ((pr, sha) => cronState.stalledNotified(pr, sha, { stateDir: reviewStateDir })),
      recordStalledNotified:
        deps.recordStalledNotified ?? ((pr, sha) => cronState.recordStalledNotified(pr, sha, { stateDir: reviewStateDir })),
      incrementInfraFailure: deps.incrementInfraFailure ?? ((pr, sha, o) => incrementInfraFailure(pr, sha, o)),
      atInfraFailureCeiling: deps.atInfraFailureCeiling ?? ((pr, sha, o) => atInfraFailureCeiling(pr, sha, o)),
      autoMergeEnabled,
    });
  } finally {
    // AUTO path close-on-merge: iterate autoMergedIssues and call closeRunTopicOnMerge for each —
    // in `finally` so a cronReviewFn rejection (e.g. reconcile()'s gh throws) never orphans an
    // already-merged (irreversible) issue's forum topic. Own try/catch so a close failure never
    // masks the lock release below.
    try {
      for (const issue of autoMergedIssues) {
        await closeRunTopicOnMerge(issue, { fetch: globalThis.fetch, log: () => {} });
      }
    } catch {
      // fail-open — the close is best-effort and must never block the lock release
    }
    runLock.release({ stateDir: reviewStateDir, acquireTs: lock.acquireTs });
  }
}

/** @description Finite timeout (ms) + kill signal applied to every gh spawnSync the issueOpen seam
 * below issues — #235/#ac-1.4: a hung gh process must NEVER block the review cron's drain. */
const GH_SPAWN_TIMEOUT_MS = 5000;

/**
 * @description Builds a real issueOpen(issueNumber) seam for this project's single-repo config,
 * reusing run-reaper.mjs's existing gh-scoped makeDefaultIssueClosed (no new dependency). Returns a
 * TRI-STATE: `true` = confirmed OPEN (authorizes a self-heal re-mint), `false` = confirmed CLOSED
 * (authorizes finalizing the run terminal), `null` = UNKNOWN (a gh outage/timeout — authorizes
 * NEITHER a mint nor a finalize; collapsing an outage into "closed" would wrongly terminate a
 * genuinely active run on a transient blip). The spawn's finite timeout keeps the cron itself
 * fail-open (never blocked by a hung gh).
 * @param {{ owner: string, repo: string }} config
 * @param {{ spawn?: Function }} [deps] - test seam; defaults to the real spawnSync
 * @returns {(issueNumber: number) => boolean | null}
 */
export function makeIssueOpen(config, deps = {}) {
  const spawn = deps.spawn ?? spawnSync;
  const spawnWithTimeout = (cmd, args, opts) =>
    spawn(cmd, args, { ...opts, timeout: GH_SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" });
  const issueClosed = makeDefaultIssueClosed(spawnWithTimeout, config.owner, config.repo);
  return (issueNumber) => {
    const closed = issueClosed(issueNumber);
    if (closed === true) return false;
    if (closed === false) return true;
    return null;
  };
}

/**
 * @description CLI wrapper: builds the REAL best-effort notifier, runs runCronReview with it
 * injected, and awaits drain() so the short-lived cron process does not exit before in-flight
 * notifications settle. A notify failure never affects the cron's exit. Wires a real issueOpen seam
 * (#235/#ac-1.3) into the drain so the self-heal branch never re-mints a topic for a closed issue.
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function mainCronReview(config, deps = {}) {
  const notifier = makeNotifier(config, { homeDir: config.homeDir });
  const runCronReviewFn = deps.runCronReview ?? runCronReview;
  try {
    await runCronReviewFn(config, { notify: notifier.notify, notifyConfig: notifier.config });
  } finally {
    // Drain the per-run observability outbox here too (belt alongside the dedicated drain cron and
    // Cron A): a run that finishes between drain ticks still reaches its topic. Shared `drain.lock`
    // (via drainWithLock) means the crons never double-send; fail-open. Injectable seam for tests.
    if (notifier.enabled) {
      const issueOpen = makeIssueOpen(config, { spawn: deps.spawn });
      const baseDrainOutbox = deps.drainOutbox ?? notifier.drainOutbox;
      await drainWithLock(config, { drainOutbox: (opts) => baseDrainOutbox({ ...opts, issueOpen }) });
    }
    try {
      await notifier.drain();
    } catch {
      // fail-open
    }
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = process.argv[2];
  const configPath = arg === "--config" ? process.argv[3] : arg;
  mainCronReview(loadConfig(configPath)).catch((err) => {
    console.error(`run-cron-review: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
