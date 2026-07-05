/**
 * @description Merge-driven release of chained roadmap issues for the VPS cron harness. This is the
 * mechanism that makes a roadmap of dependency-ordered issues advance AUTOMATICALLY as PRs merge,
 * WITHOUT a dependent ever being implemented before its dependencies' code is on main.
 *
 * A dependent issue is held with the `harness:queued` label (invisible to cron-a-select, which only
 * picks `harness:ready`). Every review cycle, releaseChainedDependents scans the queued issues and,
 * per dependent, decides from GROUND TRUTH — the merged PR on each dependency's `harness/<dep>`
 * branch, never the lossy `harness:done` label (which lags a failed post-merge relabel):
 *   - EVERY declared dependency has a merged PR  -> relabel `harness:queued` -> `harness:ready`
 *     (released; cron-a picks it up on the next tick). This is re-evaluated across ALL deps every
 *     cycle, so a diamond dependency releases only once its LAST dependency merges.
 *   - ANY declared dependency is `harness:blocked` (dead: retry ceiling / deliberate block / gate
 *     2nd-pass) -> the dependent can never be satisfied, so cascade it `harness:queued` ->
 *     `harness:blocked` and NOTIFY. This is the explicit stop + observability that stops a dead
 *     mid-chain dependency from silently stranding its whole downstream subtree forever.
 *   - otherwise (some dependency still pending) -> leave it `harness:queued`.
 *
 * A queued issue with NO parseable dependency is left untouched here (skipped) — creation-time DAG
 * validation (a separate slice) is what guarantees a queued issue always declares its holds; acting
 * on a possibly-typo'd empty block at runtime would be the wrong place to decide.
 *
 * Runs inside the review cron's per-cycle reconcile closure (merge-mode-agnostic: it fires whether
 * a PR was auto-merged or an operator merged it manually), keyed on merged-PR truth exactly like
 * review-merge.mjs's reconcile(). Every `gh`/notify seam is injected, following this repo's
 * seam-injection style — no real process is spawned from the logic.
 */
import { parseDependsOn as defaultParseDependsOn } from "./chain-deps.mjs";

const LABEL_QUEUED = "harness:queued";
const LABEL_READY = "harness:ready";
const LABEL_BLOCKED = "harness:blocked";

/**
 * @description True when a `gh` mutation seam result indicates success. Undefined/null or
 * `{ok:false}` are failure — fail-closed, so a failed relabel is never counted as released/stranded.
 * @param {{ok?: boolean}|null|undefined} result
 * @returns {boolean}
 */
function isOk(result) {
  return Boolean(result && result.ok);
}

/**
 * @description Ground-truth "is this dependency satisfied" check: a merged PR exists on the
 * dependency's `harness/<dep>` branch. Mirrors review-merge.mjs's reconcile() (`gh pr list --head`
 * --state merged) rather than the lossy `harness:done` label. A gh hiccup returns `[]` (fail-closed)
 * → treated as NOT merged, so a transient failure never prematurely releases a dependent.
 * @param {(args: string[]) => any} gh
 * @param {number} dep
 * @returns {boolean}
 */
function dependencyMerged(gh, dep) {
  const merged = gh(["pr", "list", "--head", `harness/${dep}`, "--state", "merged", "--json", "number"]);
  return Array.isArray(merged) && merged.length > 0;
}

/**
 * @description "Is this dependency dead" check: the dependency issue carries `harness:blocked`. A gh
 * hiccup returns `[]` (fail-closed) → `.labels` undefined → treated as NOT blocked, so a transient
 * failure never cascades a false strand.
 * @param {(args: string[]) => any} gh
 * @param {number} dep
 * @returns {boolean}
 */
function dependencyBlocked(gh, dep) {
  const view = gh(["issue", "view", String(dep), "--json", "labels"]);
  const labels = view && Array.isArray(view.labels) ? view.labels : [];
  return labels.some((label) => (label && (label.name ?? label)) === LABEL_BLOCKED);
}

/**
 * @description Scans the open `harness:queued` issues and releases / strands each per the contract
 * in the module header. Idempotent per cycle: an issue that stays pending is left untouched, so a
 * repeat pass only acts on a newly-satisfied or newly-dead dependency.
 * @param {object} opts
 * @param {(args: string[]) => any} opts.gh injected `gh` seam
 * @param {(event: object) => void} [opts.notify] best-effort operator notification (default no-op)
 * @param {(body: string) => number[]} [opts.parseDependsOn] default: real parser from ./chain-deps.mjs
 * @returns {{released: number[], stranded: number[], skipped: number[]}}
 */
export function releaseChainedDependents(opts) {
  const { gh, notify = () => {}, parseDependsOn = defaultParseDependsOn } = opts;

  const queued = gh(["issue", "list", "--label", LABEL_QUEUED, "--state", "open", "--json", "number,body"]) || [];

  const released = [];
  const stranded = [];
  const skipped = [];
  let blockedLabelEnsured = false;

  for (const issue of queued) {
    const deps = parseDependsOn(issue.body);

    // A queued issue with no declared dependency is not ours to promote or strand here — leave it
    // for creation-time validation to have prevented (and the long-queued sweep to surface).
    if (deps.length === 0) {
      skipped.push(issue.number);
      continue;
    }

    // Dead-dependency check FIRST: a single blocked dependency strands the dependent regardless of
    // whether its other dependencies merged — the roadmap subtree below a dead node cannot proceed.
    if (deps.some((dep) => dependencyBlocked(gh, dep))) {
      if (!blockedLabelEnsured) {
        gh(["label", "create", LABEL_BLOCKED, "--force"]);
        blockedLabelEnsured = true;
      }
      const edit = gh([
        "issue",
        "edit",
        String(issue.number),
        "--remove-label",
        LABEL_QUEUED,
        "--add-label",
        LABEL_BLOCKED,
      ]);
      if (isOk(edit)) {
        stranded.push(issue.number);
        notify({ type: "chain-stranded", issue: issue.number, deps });
      }
      continue;
    }

    if (deps.every((dep) => dependencyMerged(gh, dep))) {
      const edit = gh([
        "issue",
        "edit",
        String(issue.number),
        "--remove-label",
        LABEL_QUEUED,
        "--add-label",
        LABEL_READY,
      ]);
      if (isOk(edit)) {
        released.push(issue.number);
        notify({ type: "chain-released", issue: issue.number });
      }
    }
    // else: some dependency still pending — stay queued.
  }

  return { released, stranded, skipped };
}
