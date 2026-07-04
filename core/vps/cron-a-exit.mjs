/**
 * @description VPS cron harness — Cron A graceful-exit state machine (task-6). cronAExit() is
 * chained AFTER `claude -p` inside the detached tmux session task-5 spawns
 * (`... ; cron-a-exit <issue> <worktree> <bodyfile> <envfile>`), so it fires on the session's
 * OWN termination — including a successful run that opened a PR, which otherwise nothing would
 * invoke (the reaper recovers only crashed no-PR runs). It is exit-handler LOGIC only; its
 * INVOCATION is wired into the detached-session lifecycle by task-5.
 *
 * Relabel state machine (never leaves the issue stranded in harness:in-progress):
 *   - PR exists on harness/<issue>                              -> harness:in-progress -> harness:done
 *                                                               (and resets the attempt counter)
 *   - no PR + a recorded deliberate blocking finding             -> harness:blocked (+ `gh issue comment`)
 *   - no PR, no blocking record, attempt counter < retryCeilingK -> harness:ready (re-queue)
 *   - no PR, no blocking record, attempt counter >= retryCeilingK -> harness:blocked (retry ceiling;
 *                                                               a chronically-failing issue leaves the loop)
 *
 * Counter contract: cronAExit is a READ-ONLY comparator of the per-issue attempt counter — it
 * NEVER calls counter.increment() on any exit path (dispatch owns charging attempts). The single
 * write it performs is counter.reset() on the done path (attempt_counter_reset_on_success).
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
import { rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";

import { release as releaseLock, readHolder } from "./run-lock.mjs";
import { read as readCounter, reset as resetCounter, increment as incrementCounter } from "./cron-state.mjs";
import { isDirectCli } from "../skills/orchestrating-delivery/references/cli-flags.mjs";

const LABEL_IN_PROGRESS = "harness:in-progress";
const LABEL_DONE = "harness:done";
const LABEL_BLOCKED = "harness:blocked";
const LABEL_READY = "harness:ready";
const DEFAULT_RETRY_CEILING_K = 2;

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
        addLabel = LABEL_DONE;
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

    if (hadPr) {
      // Reset-on-success: a delivered issue re-enters the loop with a zero attempt count. Only
      // run after the relabel to harness:done is confirmed, so a failed relabel never zeroes the
      // retry history of an issue that is still harness:in-progress.
      try {
        counter.reset(issueNumber, { stateDir });
      } catch {
        // best-effort: a counter-store hiccup must not mask a confirmed done relabel
      }
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
function realPrExists(issueNumber) {
  try {
    const { stdout, status } = spawnSync(
      "gh",
      ["pr", "list", "--head", `harness/${issueNumber}`, "--state", "open", "--json", "number"],
      { encoding: "utf8" }
    );
    if (status !== 0) return false;
    const list = JSON.parse(stdout || "[]");
    return Array.isArray(list) && list.length > 0;
  } catch {
    return false;
  }
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
 * @description Parses and validates the CLI argv: `<issueNumber> <worktree> <bodyFile> <envFile>`.
 * @param {string[]} argv - process.argv.slice(2) from the CLI entry.
 * @returns {{ issueNumber: number, worktree: string, bodyFile: string, envFile: string }}
 */
function parseArgv(argv) {
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
  return { issueNumber: issueNum, worktree, bodyFile, envFile };
}

/**
 * @description CLI entry: wires real `gh` / run-lock / counter / prExists / blockingFinding seams
 * and runs the state machine. stateDir is derived from the bodyFile's directory (dispatch writes
 * both bodyFile and envFile into stateDir); acquireTs is recovered from the run-lock holder so the
 * ownership-guarded release targets THIS session's lock, not a newer owner's.
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {void}
 */
export function main(argv) {
  const { issueNumber, worktree, bodyFile, envFile } = parseArgv(argv);
  const stateDir = dirname(bodyFile);
  const holder = readHolder({ stateDir });
  const acquireTs = holder ? holder.acquire_ts : undefined;

  cronAExit(issueNumber, worktree, bodyFile, envFile, {
    gh: realGh,
    runLock: { release: releaseLock },
    counter: { read: readCounter, reset: resetCounter, increment: incrementCounter },
    prExists: realPrExists,
    blockingFinding: () => realBlockingFinding(worktree),
    stateDir,
    acquireTs,
    retryCeilingK: DEFAULT_RETRY_CEILING_K,
  });
}

if (isDirectCli(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`cron-a-exit: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}