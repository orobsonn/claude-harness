/**
 * @description Real `gh` CLI executor shared by the VPS cron composition roots
 * (run-cron-a/run-cron-b/run-reaper). Runs `gh <args>` synchronously via spawnSync and
 * normalizes the result so the logic seams get the shape they expect:
 *   - `--json` calls return the parsed JSON (an array for list commands, an object for
 *     `view` commands). A failing invocation returns `[]` — fail-closed so a gh hiccup is
 *     treated as "no issues / no PRs", never as a silent wildcard match.
 *   - non-JSON calls (label create, issue edit, pr merge/comment/ready) return `{ ok }`.
 * Never throws: the logic seams treat a thrown gh as an unexpected crash; a structured
 * `{ ok: false }` / `[]` is the fail-closed contract every caller relies on.
 */
import { spawnSync } from "node:child_process";

/**
 * @description Runs `gh <args>` synchronously and normalizes the result. See file header.
 * @param {string[]} args
 * @returns {any}
 */
export function defaultGhExec(args) {
  const res = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ok = res.status === 0 && !res.error;
  if (args.includes("--json")) {
    if (!ok) return [];
    try {
      return JSON.parse(res.stdout);
    } catch {
      return [];
    }
  }
  return { ok };
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