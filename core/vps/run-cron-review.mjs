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

import { cronReview } from "./cron-review.mjs";
import { spawnReviewSession } from "./spawn-review-session.mjs";
import { acquire, release } from "./run-lock.mjs";
import * as cronState from "./cron-state.mjs";
import { incrementInfraFailure, atInfraFailureCeiling } from "./cron-state.mjs";
import { isReviewEligible } from "./review-origin-gate.mjs";
import { getFreshVerdict } from "./review-verdict-source.mjs";
import { crossFamilyEligible, deriveSecondFamilyVerdict } from "./review-cross-family.mjs";
import { mergeAndFinalize, reconcile } from "./review-merge.mjs";
import { releaseChainedDependents } from "./chain-release.mjs";
import { routeReject } from "./review-routing.mjs";
import { scopedGh, defaultGhExec } from "./gh-exec.mjs";
import { makeNotifier } from "./notify-telegram.mjs";
import { loadConfig } from "./run-cron-a.mjs";
import { drainWithLock } from "./drain-lock.mjs";

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
 * @description routeReject's finding-persistence seam has no production implementation yet.
 * Best-effort no-op: the chain-depth advance and relabel in routeReject still happen; only the
 * findings payload itself is not yet durably stored.
 */
function defaultRecordFindings() {
  // Pending dedicated wiring — intentionally not fabricated here.
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
  // The shared global topic is for ACTIONABLE + ERROR events only — not the normal PR-lifecycle
  // chatter, which would turn it into spam across N projects. These non-actionable types are
  // suppressed from the global topic: `review-started` (pure "began reviewing" noise), `pr-merged`
  // (after-the-fact informational), and `pr-branch-updated-retry` (a self-healing stale-branch refresh
  // that resolves itself next cycle — not a "needs a human" signal). Everything else still pings —
  // crucially `pr-awaiting-merge` (the operator's "merge this" signal) and every error/blocked/failed
  // type. (The richer option — routing the full lifecycle into each run's own topic — needs a
  // topic-lifecycle refactor; tracked separately.)
  const GLOBAL_TOPIC_SUPPRESSED = new Set(["review-started", "pr-merged", "pr-branch-updated-retry"]);
  const safeNotify = (event) => {
    try {
      if (event && GLOBAL_TOPIC_SUPPRESSED.has(event.type)) {
        return undefined; // non-actionable PR-lifecycle chatter — kept out of the shared global topic
      }
      // Inject the project slug so every review-cron notification renders `[<project>]` instead of
      // `[?]` (cronReview's events carry only {type, pr, url}); an event's own project still wins.
      // Returns the underlying notify promise so a caller that needs the send to COMPLETE before a
      // blocking spawn (cronReview's awaited review-started) can await it; fire-and-forget callers
      // simply ignore the return.
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

  const ghExec = deps.ghExec ?? defaultGhExec;
  const gh = deps.gh ?? scopedGh(config.owner, config.repo, ghExec);
  const authenticatedUser = deps.authenticatedUser ?? defaultGetAuthenticatedGhUser;
  const alreadyReviewedFn = deps.alreadyReviewed ?? cronState.alreadyReviewed;

  // mergeAndFinalize / reconcile need MORE context than cronReview's own call site passes through
  // (a counter/recordReviewed adapter) — supplied here via a bound closure.
  const mergeAndFinalizeFn =
    deps.mergeAndFinalize ??
    ((pr, sha, o) => mergeAndFinalize(pr, sha, { ...o, counter: cronState, recordReviewed: cronState.recordReviewed }));
  // The per-cycle reconcile closure does TWO merge-driven things, both keyed on merged-PR ground
  // truth and both merge-mode-agnostic (auto-merge OR operator manual-merge): (1) self-heal any
  // issue whose PR merged but whose done relabel was missed, and (2) release the roadmap's chained
  // dependents whose dependencies have all merged (or strand a subtree under a dead dependency).
  // Chaining lives HERE — not on the auto-merge-only mergeAndFinalize path — so a manual merge (the
  // shipped default) still advances the roadmap. Best-effort: a chaining failure never breaks the
  // self-heal or the review cycle.
  const reconcileFn =
    deps.reconcile ??
    (() => {
      const healed = reconcile({ gh, counter: cronState, stateDir: reviewStateDir });
      try {
        releaseChainedDependents({ gh, notify: safeNotify });
      } catch {
        // fail-open — the roadmap simply doesn't advance this cycle; it retries next cycle
      }
      return healed;
    });

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
  };
  const routeRejectFn =
    deps.routeReject ??
    ((pr, sha, o) =>
      routeReject(pr, sha, {
        ...o,
        chain,
        reviewed,
        recordFindings: deps.recordFindings ?? defaultRecordFindings,
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
      incrementInfraFailure: deps.incrementInfraFailure ?? ((pr, sha, o) => incrementInfraFailure(pr, sha, o)),
      atInfraFailureCeiling: deps.atInfraFailureCeiling ?? ((pr, sha, o) => atInfraFailureCeiling(pr, sha, o)),
      autoMergeEnabled,
    });
  } finally {
    runLock.release({ stateDir: reviewStateDir, acquireTs: lock.acquireTs });
  }
}

/**
 * @description CLI wrapper: builds the REAL best-effort notifier, runs runCronReview with it
 * injected, and awaits drain() so the short-lived cron process does not exit before in-flight
 * notifications settle. A notify failure never affects the cron's exit.
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function mainCronReview(config, deps = {}) {
  const notifier = makeNotifier(config, { homeDir: config.homeDir });
  const runCronReviewFn = deps.runCronReview ?? runCronReview;
  try {
    await runCronReviewFn(config, { notify: notifier.notify });
  } finally {
    // Drain the per-run observability outbox here too (belt alongside the dedicated drain cron and
    // Cron A): a run that finishes between drain ticks still reaches its topic. Shared `drain.lock`
    // (via drainWithLock) means the crons never double-send; fail-open. Injectable seam for tests.
    if (notifier.enabled) {
      await drainWithLock(config, { drainOutbox: deps.drainOutbox ?? notifier.drainOutbox });
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
