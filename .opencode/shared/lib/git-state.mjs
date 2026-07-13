/**
 * @description Pure computeGitState — origin/HEAD then origin/main then origin/master.
 * No fs; inject git runner.
 */

/**
 * @param {(args: string[]) => string} git
 * @returns {{ branch: string|null, commitsAhead: number|null, defaultBranch: string|null }}
 */
export function computeGitState(git) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

  let base = null;
  try {
    const headRef = git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    base = headRef.replace(/^refs\/remotes\//, "");
  } catch {
    for (const fallback of ["origin/main", "origin/master"]) {
      try {
        git(["rev-parse", "--verify", "--quiet", fallback]);
        base = fallback;
        break;
      } catch {
        // next
      }
    }
  }

  const defaultBranch = base ? base.replace(/^[^/]+\//, "") : null;

  let commitsAhead = null;
  if (base !== null) {
    try {
      const count = Number.parseInt(git(["rev-list", "--count", `${base}..HEAD`]), 10);
      commitsAhead = Number.isNaN(count) ? null : count;
    } catch {
      commitsAhead = null;
    }
  }

  return { branch: branch || null, commitsAhead, defaultBranch };
}
