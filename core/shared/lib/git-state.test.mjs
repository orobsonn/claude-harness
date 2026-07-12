/** @description Locked tests for computeGitState. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGitState } from "./git-state.mjs";

test("origin/HEAD path: branch + commitsAhead + defaultBranch main", () => {
  const git = (args) => {
    const key = args.join(" ");
    if (key === "rev-parse --abbrev-ref HEAD") return "feature/x";
    if (key === "symbolic-ref refs/remotes/origin/HEAD")
      return "refs/remotes/origin/main";
    if (key === "rev-list --count origin/main..HEAD") return "3";
    throw new Error(`unexpected ${key}`);
  };
  assert.deepEqual(computeGitState(git), {
    branch: "feature/x",
    commitsAhead: 3,
    defaultBranch: "main",
  });
});

test("fallback origin/master when origin/HEAD fails", () => {
  const git = (args) => {
    const key = args.join(" ");
    if (key === "rev-parse --abbrev-ref HEAD") return "feature/y";
    if (key === "symbolic-ref refs/remotes/origin/HEAD")
      throw new Error("no head");
    if (key === "rev-parse --verify --quiet origin/main")
      throw new Error("no main");
    if (key === "rev-parse --verify --quiet origin/master") return "";
    if (key === "rev-list --count origin/master..HEAD") return "0";
    throw new Error(`unexpected ${key}`);
  };
  const r = computeGitState(git);
  assert.equal(r.defaultBranch, "master");
  assert.equal(r.commitsAhead, 0);
});
