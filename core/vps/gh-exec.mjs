/**
 * @description Real `gh` CLI executor shared by the VPS cron composition roots
 * (run-cron-a/run-cron-b/run-reaper). Runs `gh <args>` synchronously via spawnSync and
 * normalizes the result so the logic seams get the shape they expect:
 *   - `--json` calls return the parsed JSON (an array for list commands, an object for
 *     `view` commands). A failing invocation returns `[]` — fail-closed so a gh hiccup is
 *     treated as "no issues / no PRs", never as a silent wildcard match.
 *   - `pr diff <n> --name-only` (no `--json`) returns a `string[]` of changed file paths,
 *     blank/trailing lines filtered out. A failing invocation returns `[]`, which is
 *     INDISTINGUISHABLE from a genuinely empty diff — `touchesGateMachinery([])` then reads
 *     as "no gate-machinery files", so a transient diff-fetch failure silently skips the
 *     HR-9 second pass. This is acceptable only while cross-family auto-merge is disabled
 *     (nothing merges); it MUST be made fail-closed (signal the failure distinctly and force
 *     the 2nd pass / re-queue the PR) before cross-family auto-merge is enabled. See the
 *     review-spawn-wiring open risks.
 *   - other non-JSON calls (label create, issue edit, pr merge/comment/ready) return `{ ok }`.
 * Never throws: the logic seams treat a thrown gh as an unexpected crash; a structured
 * `{ ok: false }` / `[]` is the fail-closed contract every caller relies on.
 */
import { spawnSync } from "node:child_process";

/**
 * @description Pure normalization of a gh spawnSync result into the shape each logic seam
 * expects. See file header for the three branches (--json / pr diff --name-only / other).
 * @param {string[]} args
 * @param {{status?: number, error?: unknown, stdout?: string}} res
 * @returns {any}
 */
export function normalizeGhResult(args, res) {
  const ok = res.status === 0 && !res.error;
  if (args.includes("--json")) {
    if (!ok) return [];
    try {
      return JSON.parse(res.stdout);
    } catch {
      return [];
    }
  }
  if (args[0] === "pr" && args[1] === "diff" && args.includes("--name-only")) {
    if (!ok) return [];
    return res.stdout.split(/\r?\n/).filter(Boolean);
  }
  return { ok };
}

/**
 * @description Runs `gh <args>` synchronously and normalizes the result. See file header.
 * @param {string[]} args
 * @returns {any}
 */
export function defaultGhExec(args) {
  const res = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return normalizeGhResult(args, res);
}

/**
 * @description Builds a `gh` seam scoped to a single configured repo: every call appends
 * `--repo <owner>/<repo>` so a multi-project VPS never acts on the wrong project's repo.
 * @param {string} owner
 * @param {string} repo
 * @param {(args: string[]) => any} [ghExec] - raw executor; defaults to defaultGhExec.
 * @returns {(args: string[]) => any}
 */
export function scopedGh(owner, repo, ghExec = defaultGhExec) {
  const repoFlag = `${owner}/${repo}`;
  return (args) => ghExec([...args, "--repo", repoFlag]);
}