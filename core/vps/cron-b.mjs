/**
 * @description Cron B — the VPS cron harness's PR review + AUTO-MERGE phase. Lists open PRs,
 * keeps only harness/-prefixed head branches (harness-originated; a human PR is never touched),
 * and for each PR not yet reviewed at its current head SHA fetches the body FRESH, parses the
 * machine-readable CLEAN/BLOCKED verdict block, and either auto-merges (CLEAN + no open-risk
 * marker) or posts a blocking comment naming the finding — never both. cronB runs NO gate of its
 * own; the verdict block is the pipeline's pre-computed dual-review result, read fail-closed via
 * parseVerdictBlock. Idempotent per head SHA: a PR already recorded as reviewed at its current
 * SHA is a no-op, and cronB acts again only once the head SHA changes.
 *
 * Every external seam (`gh`, `parseVerdictBlock`, `alreadyReviewed`/`recordReviewed`,
 * `openRiskMarker`) is injected so the cron is hermetic under test and runtime-pluggable in
 * production. The real `alreadyReviewed`/`recordReviewed` come from `./cron-state.mjs` and take a
 * trailing `{stateDir}` opts arg; the call site passes it unconditionally.
 */
import { OPEN_TAG } from "./verdict-block.mjs";

/** @description Head-branch prefix marking a harness-originated PR (never a human PR). */
const HARNESS_BRANCH_PREFIX = "harness/";

/** @description Default open-risk sentinel scanned for in the PR body when no marker fn is injected. */
const DEFAULT_OPEN_RISK_MARKER = "<!--harness:open-risk-->";

/**
 * @description Default open-risk detector — true when the PR body carries the harness open-risk
 * sentinel (a delivery-time signal that must block auto-merge even under an otherwise-CLEAN verdict).
 * @param {string} body
 * @param {string} [marker]
 * @returns {boolean}
 */
function defaultOpenRiskMarker(body, marker = DEFAULT_OPEN_RISK_MARKER) {
  return typeof body === "string" && body.includes(marker);
}

/**
 * @description True when a `gh` seam result indicates success. Undefined/null or `{ok:false}` are
 * treated as failure — fail-closed. This handles both conventions used by seam implementations:
 * an explicit `{ok}` return OR a thrown error caught by the caller.
 * @param {{ok?: boolean}|null|undefined} result
 * @returns {boolean}
 */
function isOk(result) {
  return Boolean(result && result.ok);
}

/**
 * @description Default harness-author check. When `harnessAuthorLogin` is configured, queries the
 * PR author via `gh pr view --json author` and requires a case-insensitive match; when unset,
 * falls back to the legacy branch-prefix-only behaviour so existing callers/tests keep passing.
 * Throws are the caller's responsibility and must be treated as an unknown author (fail-closed).
 * @param {{number: number}} pr
 * @param {(args: string[]) => any} gh
 * @param {string} [harnessAuthorLogin]
 * @returns {boolean}
 */
function isHarnessAuthor(pr, gh, harnessAuthorLogin) {
  if (!harnessAuthorLogin) {
    return true;
  }
  const { author } = gh(["pr", "view", String(pr.number), "--json", "author"]) || {};
  const expected = harnessAuthorLogin.toLowerCase();
  if (author && typeof author === "object" && author.login) {
    return String(author.login).toLowerCase() === expected;
  }
  return typeof author === "string" && author.toLowerCase() === expected;
}

/**
 * @description Product-language summary comment posted after a successful auto-merge.
 * @param {{number: number, headRefName: string, headSha: string}} pr
 * @returns {string}
 */
function summaryComment(pr) {
  return [
    "🟢 Auto-merged by harness cron-b.",
    `Branch ${pr.headRefName} @ ${pr.headSha}: pipeline dual-review verdict CLEAN, no open risks.`,
    "No human review was required; the verdict block in this PR body was the gate.",
  ].join(" ");
}

/**
 * @description Comment posted when GitHub rejects the merge or `gh pr ready` fails. Best-effort
 * signal so the operator sees a merge was attempted and rejected.
 * @param {{number: number}} pr
 * @param {string} reason
 * @returns {string}
 */
function mergeFailureComment(pr, reason) {
  return `Cannot auto-merge PR #${pr.number}: ${reason}`;
}

/**
 * @description Names the specific blocking finding for a non-merge case, in product language. The
 * open-risk signal wins over the verdict (a CLEAN block paired with an open-risk marker is still
 * blocked); otherwise a BLOCKED verdict carries its named finding; otherwise a missing verdict
 * block is called out as such.
 * @param {{status: string, finding?: string}} verdict
 * @param {boolean} hasOpenRisk
 * @param {string} body
 * @returns {string}
 */
function blockingFinding(verdict, hasOpenRisk, body) {
  if (hasOpenRisk) {
    return "open risk marker present — auto-merge blocked pending resolution";
  }
  if (verdict && verdict.finding) {
    return verdict.finding;
  }
  if (!body.includes(OPEN_TAG)) {
    return "no verdict block in PR body — cannot confirm a CLEAN pipeline verdict";
  }
  return "blocked verdict with no finding named";
}

/**
 * @description Runs one cron-B pass: review + auto-merge every open harness/-originated PR whose
 * current head SHA has not already been reviewed. See file header for the full safety contract.
 * @param {object} opts
 * @param {(args: string[]) => any} opts.gh injected `gh` seam
 * @param {(body: string) => {status: string, finding?: string}} opts.parseVerdictBlock verdict parser
 * @param {(pr: number, sha: string, o: {stateDir: string}) => boolean} opts.alreadyReviewed
 * @param {(pr: number, sha: string, o: {stateDir: string}) => void} opts.recordReviewed
 * @param {string} opts.stateDir
 * @param {(body: string) => boolean} [opts.openRiskMarker]
 * @param {string} [opts.harnessAuthorLogin]
 * @returns {void}
 */
export function cronB(opts) {
  const {
    gh,
    parseVerdictBlock,
    alreadyReviewed,
    recordReviewed,
    stateDir,
    openRiskMarker = defaultOpenRiskMarker,
    harnessAuthorLogin,
  } = opts;

  const prs = gh(["pr", "list", "--json", "number,headRefName,headSha", "--state", "open"]) || [];

  for (const pr of prs) {
    if (!pr || typeof pr.headRefName !== "string" || !pr.headRefName.startsWith(HARNESS_BRANCH_PREFIX)) {
      continue;
    }

    const number = pr.number;
    const sha = pr.headSha;

    try {
      if (!isHarnessAuthor(pr, gh, harnessAuthorLogin)) {
        continue;
      }

      if (alreadyReviewed(number, sha, { stateDir })) {
        continue;
      }

      const { body } = gh(["pr", "view", String(number), "--json", "body"]) || {};
      const bodyText = body ?? "";
      const verdict = parseVerdictBlock(bodyText);
      const hasOpenRisk = Boolean(openRiskMarker(bodyText));

      if (verdict.status !== "CLEAN" || hasOpenRisk) {
        const finding = blockingFinding(verdict, hasOpenRisk, bodyText);
        gh(["pr", "comment", String(number), `Cannot auto-merge: ${finding}`]);
        recordReviewed(number, sha, { stateDir });
        continue;
      }

      const readyResult = gh(["pr", "ready", String(number)]);
      if (!isOk(readyResult)) {
        gh(["pr", "comment", String(number), mergeFailureComment(pr, "PR could not be marked ready")]);
        recordReviewed(number, sha, { stateDir });
        continue;
      }

      const mergeResult = gh(["pr", "merge", String(number), "--squash", "--match-head-commit", sha]);
      if (!isOk(mergeResult)) {
        gh([
          "pr",
          "comment",
          String(number),
          mergeFailureComment(pr, "merge was rejected by GitHub (head may have moved or branch protection blocked it)"),
        ]);
        recordReviewed(number, sha, { stateDir });
        continue;
      }

      gh(["pr", "comment", String(number), summaryComment(pr)]);
      recordReviewed(number, sha, { stateDir });
    } catch (error) {
      try {
        const message = error instanceof Error ? error.message : String(error);
        gh(["pr", "comment", String(number), `Harness cron-b skipped this PR due to an error: ${message}`]);
      } catch {
        // best-effort comment failed; swallow so one bad PR never blocks the batch
      }
      continue;
    }
  }
}
