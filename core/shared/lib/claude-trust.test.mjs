import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { ensureClaudeTrust } from "./claude-trust.mjs";

test("trust is recorded once for the main repository root, preserving the rest of the config", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-trust-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
  git(repo, "worktree", "add", "-q", "--detach", path.join(dir, "wt"));
  const env = { CLAUDE_CONFIG_DIR: path.join(dir, "cfg") };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  const file = path.join(env.CLAUDE_CONFIG_DIR, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ numStartups: 7, projects: { [repo]: { lastCost: 1 } } }), { mode: 0o600 });
  const result = ensureClaudeTrust(path.join(dir, "wt"), env);
  assert.equal(result.root, repo, "a linked worktree resolves to its main repository");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(config.projects[repo], { lastCost: 1, hasTrustDialogAccepted: true });
  assert.equal(config.numStartups, 7);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the config keeps its mode");
  const again = ensureClaudeTrust(repo, env);
  assert.equal(again.changed, false, "already trusted: nothing is written");
});

test("trust recorded only for a linked parent worktree still records the main repository", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-trust-linked-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const wt = path.join(dir, "wt");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
  git(repo, "worktree", "add", "-q", "--detach", wt);
  const env = { CLAUDE_CONFIG_DIR: path.join(dir, "cfg") };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  const file = path.join(env.CLAUDE_CONFIG_DIR, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ projects: { [wt]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  const result = ensureClaudeTrust(wt, env);
  assert.equal(result.changed, true);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.projects[repo].hasTrustDialogAccepted, true, "the main root covers sibling Orca worktrees");
  assert.equal(config.projects[wt].hasTrustDialogAccepted, true);
});

test("a symlinked Claude config (dotfile manager) keeps its link; the trust lands in the real file", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-trust-link-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const cfg = path.join(dir, "cfg");
  fs.mkdirSync(cfg);
  const real = path.join(dir, "dotfiles-claude.json");
  fs.writeFileSync(real, JSON.stringify({ projects: {} }));
  fs.symlinkSync(real, path.join(cfg, ".claude.json"));
  ensureClaudeTrust(repo, { CLAUDE_CONFIG_DIR: cfg });
  assert.ok(fs.lstatSync(path.join(cfg, ".claude.json")).isSymbolicLink(), "the link survives");
  assert.equal(JSON.parse(fs.readFileSync(real, "utf8")).projects[repo].hasTrustDialogAccepted, true);
});
