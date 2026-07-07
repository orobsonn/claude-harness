/**
 * @description Real `gh` CLI executor shared by the VPS cron composition roots
 * (run-cron-a/run-cron-b/run-reaper). Runs `gh <args>` synchronously via spawnSync and
 * normalizes the result so the logic seams get the shape they expect:
 *   - `--json` calls return the parsed JSON (an array for list commands, an object for
 *     `view` commands). A failing invocation returns `[]` — fail-closed so a gh hiccup is
 *     treated as "no issues / no PRs", never as a silent wildcard match.
 *   - `pr diff <n> --name-only` (no `--json`) returns a `string[]` of changed file paths,
 *     blank/trailing lines filtered out. A failing invocation returns the DISTINCT sentinel
 *     `{ ok: false, diffFailed: true }` — fail-closed so a transient diff-fetch failure
 *     signals the failure distinctly and re-queues the PR. A genuinely
 *     empty diff (status 0, empty stdout) stays `[]`.
 *   - `pr diff <n>` (without `--name-only` and without `--json`) returns the full patch as a
 *     STRING on success, or the same `{ ok: false, diffFailed: true }` sentinel on failure.
 *   - other non-JSON, non-diff calls (label create, issue edit, pr merge/comment/ready) return `{ ok }`.
 * Never throws: the logic seams treat a thrown gh as an unexpected crash; a structured
 * `{ ok: false }` / `[]` / `{ ok: false, diffFailed: true }` is the fail-closed contract
 * every caller relies on.
 */
import { spawnSync } from "node:child_process";

/**
 * @description Pure normalization of a gh spawnSync result into the shape each logic seam
 * expects. See file header for the four branches (--json / pr diff --name-only / pr diff <n> / other).
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
    if (!ok) return { ok: false, diffFailed: true };
    if (res.stdout === "") return [];
    return res.stdout.split(/\r?\n/).filter(Boolean);
  }
  if (args[0] === "pr" && args[1] === "diff" && !args.includes("--name-only") && !args.includes("--json")) {
    if (!ok) return { ok: false, diffFailed: true };
    return res.stdout;
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