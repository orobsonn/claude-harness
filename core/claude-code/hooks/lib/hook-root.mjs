/**
 * @description The project root a parent-session hook acts on. Claude Code's Bash keeps its cwd
 * between calls, and hooks run in that cwd: after `cd packages/api` a hook that trusted
 * process.cwd() would look for the task registry in the wrong place and fail open (adversarial
 * review of #1107). The root is CLAUDE_PROJECT_DIR (set by Claude Code for every hook), else the
 * Git toplevel of the cwd, else the cwd itself.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function hookProjectRoot(env = process.env, cwd = process.cwd()) {
  const declared = env.CLAUDE_PROJECT_DIR;
  if (typeof declared === "string" && path.isAbsolute(declared)) {
    try {
      return fs.realpathSync(declared);
    } catch { /* fall through */ }
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    if (top) return fs.realpathSync(top);
  } catch { /* not a Git checkout */ }
  return cwd;
}
