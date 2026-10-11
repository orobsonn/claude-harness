/**
 * @description Records Claude Code's per-project trust ("Do you trust this folder?") for a
 * repository the harness is about to run an interactive Claude session in, so an autonomous run
 * (an Orca-dispatched global parent, a TUI task lane) never waits on that prompt. The trust is
 * recorded for the MAIN repository root: Claude Code applies it to every linked worktree of that
 * repository (claude-parallel-tasks spike §15). Shared by the Claude Code task coordinator and the
 * Orca issue dispatcher.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Read-modify-write of Claude Code's global config with an atomic rename, re-read to confirm (a
 * concurrent Claude Code write can race; it is retried). `env` selects CLAUDE_CONFIG_DIR/HOME.
 */
export function ensureClaudeTrust(parentRoot, env = process.env) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: parentRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const mainRoot = path.basename(common) === ".git" ? path.dirname(common) : parentRoot;
  const file = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
    ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(env.HOME || os.homedir(), ".claude.json");
  const trusted = (config) => [mainRoot, parentRoot].some((key) => config?.projects?.[key]?.hasTrustDialogAccepted === true);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let config = {};
    let mode = 0o600;
    if (fs.existsSync(file)) {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
      mode = fs.statSync(file).mode & 0o777;
    }
    if (trusted(config)) return { file, root: mainRoot, changed: attempt > 0 };
    config.projects ??= {};
    config.projects[mainRoot] = { ...(config.projects[mainRoot] ?? {}), hasTrustDialogAccepted: true };
    const temporary = `${file}.harness-${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode });
    fs.renameSync(temporary, file);
  }
  const final = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!trusted(final)) throw new Error(`could not record Claude Code project trust for ${mainRoot} in ${file}; open Claude Code there once and accept the trust prompt`);
  return { file, root: mainRoot, changed: true };
}

