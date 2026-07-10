/**
 * @description Reject / chain-depth routing for the independent PR-review phase. A review REJECT
 * for a harness PR never opens a new issue/branch — it routes back onto the SAME `harness/<root>`
 * issue so the repair session picks up where it left off, and it advances a root-keyed chain-depth
 * counter (mirroring cron-state.mjs's increment/atCeiling/reset/read contract) that eventually caps
 * a chronically-failing issue at `harness:blocked` instead of looping forever.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const HARNESS_BRANCH_PATTERN = /^harness\/(\d+)$/;

/**
 * @description Extracts the root issue number from a `harness/<issue>` branch name.
 * @param {string} headRefName
 * @returns {number}
 */
function extractRootIssue(headRefName) {
  const match = HARNESS_BRANCH_PATTERN.exec(headRefName ?? "");
  if (!match) {
    throw new Error(`review-routing: unrecognized harness branch name "${headRefName}"`);
  }
  return Number(match[1]);
}

/**
 * @description Relabels the root issue via the injected `gh` seam.
 * @param {(argv: string[]) => unknown} gh
 * @param {number} root
 * @param {string} removeLabel
 * @param {string} addLabel
 * @returns {void}
 */
function relabelIssue(gh, root, removeLabel, addLabel) {
  gh(["issue", "edit", String(root), "--remove-label", removeLabel, "--add-label", addLabel]);
}

/**
 * @description Routes a review REJECT verdict for a harness PR: relabels straight to
 * `harness:blocked` once the root's chain depth is already at the ceiling (never resetting the
 * chain), otherwise advances the chain depth once and re-queues the SAME `harness/<root>`
 * issue/branch — recording the review findings for the next repair session and relabeling
 * `harness:in-review` -> `harness:ready` so the cron re-dispatches it. A re-enqueue whose head sha
 * is unchanged since the last review (a failed/crashed repair) still advances the chain instead of
 * being silently dropped.
 * @param {{ number: number, headRefName: string }} pr
 * @param {string} sha
 * @param {object} opts
 * @param {(argv: string[]) => unknown} opts.gh
 * @param {{ increment(root: number): void, atCeiling(root: number): boolean, reset(root: number): void, read(root: number): number }} opts.chain
 * @param {{ alreadyReviewed(prNumber: number, sha: string): boolean, recordReviewed(prNumber: number, sha: string): void }} opts.reviewed
 * @param {(root: number, findings: unknown) => void} opts.recordFindings
 * @param {(event: object) => void} opts.notify
 * @param {unknown} opts.findings
 * @returns {void}
 */
export function routeReject(pr, sha, opts) {
  const { gh, chain, reviewed, recordFindings, notify, findings } = opts;
  const root = extractRootIssue(pr.headRefName);

  if (chain.atCeiling(root)) {
    reviewed.recordReviewed(pr.number, sha);
    relabelIssue(gh, root, "harness:in-review", "harness:blocked");
    notify({ type: "blocked", issue: root, pr: pr.number, reason: "chain-ceiling" });
    return;
  }

  reviewed.recordReviewed(pr.number, sha);

  chain.increment(root);
  // Fix-mode findings persistence (Grupo C #ac-1.2): the recordFindings seam is handed the pr + sha
  // + gh so it can read the sha-keyed eye-outputs and derive the authoritative fix scope. A legacy
  // (2-arg) recordFindings simply ignores the ctx — backward compatible.
  recordFindings(root, findings, { pr, sha, gh });
  relabelIssue(gh, root, "harness:in-review", "harness:ready");
}

/**
 * @description Max structured findings persisted for a fix-mode session, and the per-summary
 * character cap. Bounds the size of the untrusted block the dispatcher later re-injects, so an
 * oversized (or adversarially padded) eye output can never blow the fix session's context.
 */
const MAX_FIX_FINDINGS = 20;
const MAX_FIX_SUMMARY = 400;
const MAX_FIX_CHANGED_FILES = 100;

/** @description Validates the review head sha shape BEFORE it is used to build a file path (NEW-3
 * path-safety): only lowercase hex, 7–64 chars — the exact shape spawn-review-session validates. */
function isValidSha(sha) {
  return typeof sha === "string" && /^[0-9a-f]{7,64}$/.test(sha);
}

/**
 * @description Redacts secret-looking tokens from an eye's free-text before it is persisted (belt;
 * the load-bearing defense is the typed-field projection + size-cap). An eye `evidence` string can
 * quote an offending source line that contains a hardcoded key; scrub it so the secret never rides
 * into the fix-findings file or the fix session's prompt.
 * @param {string} text
 * @returns {string}
 */
function scrubSecrets(text) {
  return String(text)
    // labelled credential — redact the VALUE, keep the label (capture group, not an eager literal)
    .replace(/((?:bearer|authorization|token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    // provider tokens with a separator (sk-ant-, ghp_, slack xox*, gitlab glpat-, …)
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghr|github_pat|xox[baprs]|glpat)[-_][A-Za-z0-9._-]{10,}\b/g, "[REDACTED]")
    // AWS-style key IDs (no separator — the shape the prior regex missed entirely)
    .replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIZA)[0-9A-Za-z]{12,}\b/g, "[REDACTED]")
    // JWTs (three base64url segments)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]")
    // PEM private-key headers
    .replace(/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/g, "[REDACTED]")
    // connection-string credentials (user:pass@host) — redact the password only
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:@/\s]+):[^@/\s]+@/gi, "$1:[REDACTED]@")
    // generic long high-entropy run (belt; a 40+ char unbroken token is a key/hash, never prose)
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "[REDACTED]");
}

/** @description Normalizes an eye severity to the harness enum; unknown → 'medium' (a fail-class
 * finding floors medium anyway, so this never under-tiers a real bug). */
function normalizeFixSeverity(severity) {
  const s = String(severity ?? "").toLowerCase().trim();
  return s === "high" || s === "medium" || s === "low" ? s : "medium";
}

/** @description Projects a raw eye finding onto ONLY the two typed fields carried forward — the
 * injection defense at the source: no raw eye object, no free-form key, survives verbatim. */
function projectFinding(raw) {
  if (!raw || typeof raw !== "object") return null;
  // `evidence` is deliberately EXCLUDED: it verbatim-quotes offending source lines (the channel a
  // hardcoded secret would ride through), while `issue` + `fix_hint` describe the defect and the exact
  // change abstractly — enough for a fix target without carrying quoted source. scrubSecrets is the
  // belt over whatever secret text still slips into those two fields.
  const parts = [raw.issue, raw.fix_hint].filter((p) => typeof p === "string" && p.length);
  const summary = scrubSecrets(parts.join(" — ")).slice(0, MAX_FIX_SUMMARY);
  if (!summary) return null;
  return { severity: normalizeFixSeverity(raw.severity), summary };
}

/** @description Keeps only safe, relative changed-file paths — drops absolute, traversal, or
 * newline-bearing entries so nothing an untrusted source could inject becomes a scope entry. */
function safeChangedFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter((p) => typeof p === "string" && p.length > 0)
    .filter((p) => !p.includes("\n") && !p.includes("\0"))
    .filter((p) => !p.startsWith("/") && !p.split("/").includes(".."))
    .slice(0, MAX_FIX_CHANGED_FILES);
}

/**
 * @description Derives the PR's changed files authoritatively via `gh pr view --json files`.
 * FAIL-CLOSED: any gh error / unexpected shape yields an EMPTY list — the dispatcher then declines
 * fix-mode (never a silent wide/absent scope, which the plan-write-gate would treat as rail-off).
 * @param {(argv: string[]) => any} gh
 * @param {number} prNumber
 * @returns {string[]}
 */
function deriveChangedFiles(gh, prNumber) {
  try {
    const res = gh(["pr", "view", String(prNumber), "--json", "files"]);
    const files = Array.isArray(res?.files) ? res.files.map((f) => f?.path) : [];
    return safeChangedFiles(files);
  } catch {
    return [];
  }
}

/**
 * @description Reads and structures the sha-keyed eye-outputs artifact the review session wrote,
 * into a typed, size-capped, secret-scrubbed findings list. Missing/corrupt/invalid → empty list
 * (the caller still records the failing-eye name). Only `findings`/`issues` arrays on the three eye
 * keys are read; every other shape degrades to empty. Injected `readFileSync`/`existsSync` for tests.
 * @param {string} reviewStateDir
 * @param {number} prNumber
 * @param {string} sha
 * @param {{readFileSync?: Function, existsSync?: Function}} io
 * @returns {Array<{severity: string, summary: string}>}
 */
function structureEyeFindings(reviewStateDir, prNumber, sha, io = {}) {
  const readFile = io.readFileSync ?? readFileSync;
  const exists = io.existsSync ?? existsSync;
  if (!isValidSha(sha)) return []; // path-safety: never join an unvalidated sha
  const eyesPath = join(reviewStateDir, "session-out", `eyes-${prNumber}-${sha}.json`);
  if (!exists(eyesPath)) return [];
  let eyes;
  try {
    eyes = JSON.parse(readFile(eyesPath, "utf8"));
  } catch {
    return [];
  }
  if (!eyes || typeof eyes !== "object") return [];
  const out = [];
  for (const eyeName of ["adversary", "compliance", "security"]) {
    const eye = eyes[eyeName];
    const raw = Array.isArray(eye?.findings) ? eye.findings : Array.isArray(eye?.issues) ? eye.issues : [];
    for (const f of raw) {
      const projected = projectFinding(f);
      if (projected) out.push(projected);
      if (out.length >= MAX_FIX_FINDINGS) return out;
    }
  }
  return out;
}

/**
 * @description Persists a self-contained fix-mode findings file the dispatcher reads to enter
 * fix-mode (Grupo C #ac-1.2). Replaces the old no-op recordFindings. Writes
 * `<outStateDir>/fix-findings-<root>.json` = `{ root, pr, sha, finding, changedFiles, findings }`:
 *   - `findings` — typed `{severity, summary}[]` from the sha-keyed eye-outputs; the ONLY channel of
 *     untrusted review text, projected to typed fields + secret-scrubbed + size-capped.
 *   - `changedFiles` — the PR's changed files from `gh` (TRUSTED, authoritative). This is the SOLE
 *     source of the fix session's write scope (NEW-1): the untrusted findings NEVER widen it. Empty
 *     on any gh failure so the dispatcher fails closed.
 *   - `sha` — the reviewed head sha; the dispatcher requires it to match the branch tip (anti-stale).
 * Atomic write (tmp + rename), 0600. Best-effort: a write failure is swallowed (fix-mode simply does
 * not engage; the reject still re-queued the issue).
 * @param {number} root - root issue number
 * @param {{status?: string, finding?: string}} canonicalVerdict - the derived canonical verdict
 * @param {object} ctx - { pr, sha, gh, reviewStateDir, outStateDir, writeFileSync?, readFileSync?, existsSync? }
 * @returns {void}
 */
export function persistReviewFindings(root, canonicalVerdict, ctx) {
  const { pr, sha, gh, reviewStateDir, outStateDir } = ctx ?? {};
  if (!pr || typeof pr.number !== "number" || !reviewStateDir || !outStateDir) return;
  const writeFile = ctx.writeFileSync ?? writeFileSync;
  const changedFiles = deriveChangedFiles(gh, pr.number);
  const findings = structureEyeFindings(reviewStateDir, pr.number, sha, ctx);
  const payload = {
    root,
    pr: pr.number,
    sha: isValidSha(sha) ? sha : null,
    finding: typeof canonicalVerdict?.finding === "string" ? canonicalVerdict.finding : null,
    changedFiles,
    findings,
  };
  const outPath = join(outStateDir, `fix-findings-${root}.json`);
  const tmpPath = `${outPath}.tmp-${pr.number}`;
  try {
    writeFile(tmpPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, outPath);
  } catch {
    // best-effort: fix-mode is an optimization; a persist failure simply falls back to a normal
    // re-dispatch (the reject already re-queued the issue).
  }
}
