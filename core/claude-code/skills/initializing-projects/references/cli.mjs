#!/usr/bin/env node
/**
 * @description Thin CLI dispatcher for `npx claude-harness`. Two commands:
 *   - `setup-local` (alias: `init`) — vendors the harness into ./.claude on a dev machine
 *     (delegates to vendor-core.mjs).
 *   - `setup-vps` — interactive wizard (setup-vps.mjs) run ON the VPS: configures the autonomous
 *     engine + Telegram notifications (token → ~/.claude/.dev.vars, then install-crons).
 * Node builtins only.
 */

import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";

import { runSetupVps } from "./setup-vps.mjs";

export const SOURCE_URL = "https://github.com/orobsonn/claude-harness.git";

/** @description Env key that turns the cross-family (Codex/GPT) eyes on. */
export const CROSS_FAMILY_ENV = "HARNESS_CODEX_ADVERSARY";

/**
 * Creates an independent clone at the current remote default tip for a lifecycle operation.
 * The caller may be on an old branch or have product work staged; neither becomes lifecycle input.
 * @param {string} cwd
 * @returns {{ directory: string, defaultBranch: "main"|"master", cleanup: () => void }}
 */
export function createLifecycleClone(cwd) {
  const git = (args, options = {}) => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  git(["fetch", "origin"]);
  const originHead = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
  const match = originHead.match(/^origin\/(main|master)$/);
  if (!match) throw new Error(`origin/HEAD must name main or master, got ${originHead || "none"}`);
  const defaultBranch = /** @type {"main"|"master"} */ (match[1]);
  const remote = git(["remote", "get-url", "origin"]).trim();
  if (!remote) throw new Error("origin has no URL for lifecycle clone");

  const directory = mkdtempSync(join(tmpdir(), "claude-harness-lifecycle-"));
  try {
    execFileSync("git", ["clone", "--no-checkout", remote, directory], { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["-C", directory, "checkout", "-B", defaultBranch, `origin/${defaultBranch}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    directory,
    defaultBranch,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** @param {string} cwd @param {string[]} args */
function gitAt(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** @param {string} cwd @param {string[]} args */
function ghAt(cwd, args) {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** @param {string} source @param {string} target */
function copyGitIdentity(source, target) {
  for (const key of ["user.name", "user.email"]) {
    try {
      const value = gitAt(source, ["config", "--get", key]).trim();
      if (value) gitAt(target, ["config", key, value]);
    } catch {
      // A global identity is already inherited by the clone; a missing project override is fine.
    }
  }
}

/** @param {unknown} value */
function normalizedLifecyclePath(value) {
  if (typeof value !== "string") throw new Error("invalid lifecycle ownership manifest path");
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !path || path.startsWith("/") || path === "." || path === ".." || path.startsWith("../") ||
    path.endsWith("/.") || path.endsWith("/..") || path.includes("/../")
  ) {
    throw new Error(`unsafe lifecycle ownership manifest path: ${String(value)}`);
  }
  return path;
}

/** @param {string} directory @param {"claude"|"opencode"|"both"} runtimeTarget */
function vendoredOwnershipPaths(directory, runtimeTarget) {
  const manifests = runtimeTarget === "both"
    ? [".opencode/.harness-owned-files.json", ".claude/.harness-owned-files.json"]
    : [runtimeTarget === "opencode" ? ".opencode/.harness-owned-files.json" : ".claude/.harness-owned-files.json"];
  const paths = new Set();
  for (const manifest of manifests) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(directory, manifest), "utf8"));
    } catch {
      throw new Error(`missing or invalid lifecycle ownership manifest: ${manifest}`);
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) {
      throw new Error(`missing or invalid lifecycle ownership manifest: ${manifest}`);
    }
    for (const path of parsed.files) paths.add(normalizedLifecyclePath(path));
  }
  if (paths.size === 0) throw new Error("lifecycle ownership manifest declares no files");
  return paths;
}

/** @param {string} directory */
function lifecycleChangedPaths(directory) {
  const tracked = gitAt(directory, ["diff", "--name-only", "-z", "HEAD"]).split("\0").filter(Boolean);
  const untracked = gitAt(directory, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  return new Set([...tracked, ...untracked].map(normalizedLifecyclePath));
}

/**
 * The clone is known-clean before vendoring, so the current vendor manifests are the only authority
 * needed to make the lifecycle commit. This stays independent of either runtime's local helper.
 * @param {string} directory
 * @param {"claude"|"opencode"|"both"} runtimeTarget
 */
function prepareVendoredLifecycle(directory, runtimeTarget) {
  const owned = vendoredOwnershipPaths(directory, runtimeTarget);
  const changed = lifecycleChangedPaths(directory);
  if (changed.has("opencode.harness.json")) {
    throw new Error("opencode.harness.json requires manual config repair and is never lifecycle cargo");
  }
  const paths = [...owned].filter((path) => changed.has(path)).sort();
  const defaultBranch = gitAt(directory, ["branch", "--show-current"]).trim();
  if (paths.length === 0) return { action: "noop", branch: defaultBranch, paths };

  const lifecycleBranch = `chore/harness-lifecycle-updating-harness-${Date.now()}`;
  gitAt(directory, ["switch", "-c", lifecycleBranch]);
  const present = paths.filter((path) => existsSync(join(directory, path)));
  const removed = paths.filter((path) => !existsSync(join(directory, path)));
  if (present.length > 0) gitAt(directory, ["add", "--", ...present]);
  if (removed.length > 0) gitAt(directory, ["add", "-u", "--", ...removed]);
  gitAt(directory, ["commit", "--only", "-m", "chore: sincroniza harness vendored", "--", ...paths]);

  const committed = gitAt(directory, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])
    .split("\0").filter(Boolean).map(normalizedLifecyclePath);
  const foreign = committed.filter((path) => !owned.has(path));
  if (foreign.length > 0) throw new Error(`lifecycle commit contains paths outside the vendor ownership manifest: ${foreign.join(", ")}`);
  return { action: "committed", branch: lifecycleBranch, paths: committed };
}

/**
 * Ships a lifecycle-only commit that was prepared in the isolated clone. A repository with no
 * Actions workflow is explicit compatibility data, not an inference from a momentarily empty check list.
 * @param {{ directory: string, defaultBranch: string, prepared: { action: string, branch?: string, paths?: string[], url?: string } }} input
 */
function shipPreparedLifecycle({ directory, defaultBranch, prepared }) {
  if (prepared.action === "noop" || prepared.action === "merged") return prepared;
  if (prepared.action !== "committed" && prepared.action !== "resume") {
    throw new Error(`unsupported lifecycle preparation result: ${prepared.action}`);
  }
  const branch = gitAt(directory, ["branch", "--show-current"]).trim();
  if (!branch || branch !== prepared.branch || !branch.startsWith("chore/harness-lifecycle-updating-harness-")) {
    throw new Error("lifecycle branch identity differs from the verified prepared commit");
  }
  gitAt(directory, ["push", "-u", "origin", "HEAD"]);
  const url = ghAt(directory, [
    "pr", "create",
    "--base", defaultBranch,
    "--head", branch,
    "--title", "chore: sincroniza harness vendored",
    "--body", "Lifecycle do harness. Commit verificado pelo manifesto do vendor.",
  ]);
  const pr = JSON.parse(ghAt(directory, ["pr", "view", url, "--json", "number,url,baseRefName,headRefName,headRefOid"]));
  const head = gitAt(directory, ["rev-parse", "HEAD"]).trim();
  if (!Number.isInteger(pr.number) || pr.baseRefName !== defaultBranch || pr.headRefName !== branch || pr.headRefOid !== head) {
    throw new Error("lifecycle PR identity differs from the verified prepared commit");
  }
  const repo = ghAt(directory, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const workflowCount = Number(ghAt(directory, ["api", `repos/${repo}/actions/workflows`, "--jq", ".total_count"]));
  if (!Number.isInteger(workflowCount) || workflowCount < 0) throw new Error("could not determine the repository workflow count");
  if (workflowCount === 0) {
    const result = JSON.parse(ghAt(directory, [
      "api", "--method", "PUT", `repos/${repo}/pulls/${pr.number}/merge`,
      "-f", `sha=${head}`,
      "-f", "merge_method=squash",
    ]));
    if (result?.merged !== true) throw new Error("lifecycle merge was not accepted by GitHub");
  } else {
    ghAt(directory, ["pr", "checks", url, "--watch"]);
    ghAt(directory, ["pr", "merge", url, "--squash", "--delete-branch"]);
  }
  gitAt(directory, ["switch", defaultBranch]);
  gitAt(directory, ["pull", "--ff-only"]);
  return { action: "merged", url: pr.url, paths: prepared.paths ?? [] };
}

/**
 * Runs the full harness update outside the caller checkout. This makes a lifecycle sync atomic
 * from the operator's point of view: a feature branch, staged product work, or a stale local main
 * cannot contaminate the PR that refreshes the harness on origin's default branch.
 * @param {{
 *   cwd: string,
 *   ref: string,
 *   runtimeTarget: "claude"|"opencode"|"both",
 *   runVendor?: typeof runVendorDefault,
 *   prepare?: (directory: string, runtimeTarget: "claude"|"opencode"|"both") => { action: string, branch?: string, paths?: string[], url?: string },
 *   ship?: typeof shipPreparedLifecycle,
 * }} input
 */
export function runIsolatedLifecycleUpdate({
  cwd,
  ref,
  runtimeTarget,
  runVendor = runVendorDefault,
  prepare = prepareVendoredLifecycle,
  ship = shipPreparedLifecycle,
}) {
  const lifecycle = createLifecycleClone(cwd);
  try {
    copyGitIdentity(cwd, lifecycle.directory);
    runVendor({
      source: SOURCE_URL,
      ref,
      target: lifecycle.directory,
      withCodex: false,
      runtimeTarget,
    });
    const prepared = prepare(lifecycle.directory, runtimeTarget);
    return ship({ directory: lifecycle.directory, defaultBranch: lifecycle.defaultBranch, prepared });
  } finally {
    lifecycle.cleanup();
  }
}

/**
 * @description Checks if the script is being run directly, resolving symlinks.
 * @param {string} scriptPath - The path to check.
 * @returns {boolean} True if the script is being run directly.
 */
export function isDirectCli(scriptPath) {
  if (!scriptPath) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(scriptPath) === modulePath;
  } catch {
    return scriptPath === modulePath;
  }
}

/**
 * @description Parses the command and flags from argv (raw — no aliasing; the `init`→`setup-local`
 * alias is resolved by the dispatcher in main()).
 * Public `--target opencode|claude|both` selects the runtime shell (default claude).
 * @param {string[]} argv - The process.argv-shaped array.
 * @returns {{ command: string | undefined, withCodex: boolean, runtimeTarget: "claude"|"opencode"|"both", releaseRef: string | undefined }}
 */
export function parseCliArgs(argv) {
  let runtimeTarget = "claude";
  let releaseRef;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--target" && argv[i + 1]) {
      const v = String(argv[++i]).toLowerCase();
      if (v === "claude") runtimeTarget = "claude";
      else if (v === "opencode" || v === "oc") runtimeTarget = "opencode";
      else if (v === "both" || v === "all") runtimeTarget = "both";
      else throw new Error(`invalid --target "${v}" — expected: opencode | claude | both`);
    }
    if (argv[i] === "--ref") {
      const value = String(argv[++i] ?? "").trim();
      if (!value) throw new Error("--ref requires a release tag");
      releaseRef = value;
    }
  }
  return {
    command: argv[2],
    withCodex: argv.includes("--with-codex"),
    runtimeTarget,
    releaseRef,
  };
}

/**
 * @description Decides whether to vendor the cross-family Codex module. PURE — `ask` is injectable.
 * An explicit `--with-codex` flag always wins (the non-interactive / CI path). Otherwise, ONLY when
 * attached to a TTY do we prompt; a non-TTY with no flag defaults OFF (safe default = no Codex).
 * @param {{ withCodexFlag: boolean, isTTY: boolean, ask: (q: string) => Promise<string> }} opts
 * @returns {Promise<boolean>}
 */
export async function decideCodex({ withCodexFlag, isTTY, ask }) {
  if (withCodexFlag) return true;
  if (!isTTY) return false;
  const answer = await ask(
    "Run a cross-check with a second model family (Codex/GPT)? It only vendors the module + sets the toggle — you log in to OpenAI yourself. [y/N] "
  );
  return /^y(es)?$/i.test(String(answer ?? "").trim());
}

/**
 * @description PURE merge: returns a new settings object with the cross-family toggle enabled under
 * `env`. Never mutates the input; preserves every other key.
 * @param {object} settings
 * @returns {object}
 */
export function withCodexToggle(settings) {
  const next = { ...(settings ?? {}) };
  next.env = { ...(next.env ?? {}), [CROSS_FAMILY_ENV]: "1" };
  return next;
}

/**
 * @description Enables the cross-family toggle in `.claude/settings.local.json` (NOT the committed
 * settings.json — a per-machine opt-in that never lands in git and never corrupts the file that loads
 * Claude Code). Atomic (tmp + rename) and FAIL-SOFT: any error returns { ok:false, reason } so the
 * caller can print the manual line instead of crashing a half-done init.
 * @param {string} claudeDir
 * @returns {{ ok: boolean, reason?: string }}
 */
function enableCrossFamilyToggle(claudeDir) {
  const file = join(claudeDir, "settings.local.json");
  try {
    let current = {};
    if (existsSync(file)) {
      try {
        current = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return { ok: false, reason: "settings.local.json exists but is not valid JSON — left untouched" };
      }
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(withCodexToggle(current), null, 2)}\n`);
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * @description Operator-facing next-steps for the Codex second eye. This command vendors the module
 * and sets the toggle; it deliberately does NOT run any auth — the operator logs in to OpenAI.
 * @returns {string}
 */
export function codexSetupNotes() {
  return [
    "",
    "Cross-family (Codex) second eye — vendored + toggle set in .claude/settings.local.json.",
    "It is OFF anywhere the codex CLI is unauthenticated/absent (fail-open). To finish setup YOU run:",
    "  1. npm install -g @openai/codex        # Node 22+ (use the scoped @openai/codex, not 'codex')",
    "  2. codex login                          # ChatGPT OAuth — OR, for CI:",
    "     printenv OPENAI_API_KEY | codex login --with-api-key",
    "  3. Optional ~/.codex/config.toml + project .codex/ — see",
    "     .claude/modules/codex-adversary/README.md for the full read-only setup.",
    "This command never logs you in; the OpenAI auth is yours to run.",
    "",
  ].join("\n");
}

/**
 * @description Runs the init command by resolving the latest tag and running the vendor.
 * @param {object} options - The options.
 * @param {string} options.cwd - The current working directory.
 * @param {() => string | null} options.resolveTag - Function to resolve the latest tag.
 * @param {(opts: { source: string, ref: string, target: string, withCodex: boolean, runtimeTarget: string }) => void} options.runVendor
 * @param {boolean} [options.withCodex] - Vendor the cross-family Codex module.
 * @param {"claude"|"opencode"|"both"} [options.runtimeTarget] - Shell to vendor (default claude).
 * @returns {string} The resolved tag.
 */
export function runInit({ cwd, resolveTag, runVendor, withCodex = false, runtimeTarget = "claude" }) {
  const tag = resolveTag();
  if (!tag) {
    throw new Error(
      "claude-harness: could not resolve the latest release tag from " +
        SOURCE_URL +
        " (need network + gh or curl). Aborting — refusing to vendor an unpinned ref."
    );
  }
  runVendor({ source: SOURCE_URL, ref: tag, target: cwd, withCodex, runtimeTarget });
  return tag;
}

/**
 * Records the pre-vendor worktree state in .git so the newly vendored lifecycle helper can stage
 * only files that appeared during this update. This is deliberately available from the release
 * CLI: an older project cannot call a helper it has not vendored yet.
 * @param {string} cwd
 * @param {string} operation
 */
export function writeLifecycleSnapshot(cwd, operation) {
  if (operation !== "updating-harness") throw new Error("lifecycle-snapshot supports only updating-harness");
  const git = (args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const paths = new Set([
    ...git(["diff", "--name-only", "-z", "HEAD"]).split("\0"),
    ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ].filter(Boolean));
  const manifestPath = join(cwd, ".opencode", ".harness-owned-files.json");
  let owned;
  try {
    // A local/untracked manifest is data from the project, not authority. Only the last committed,
    // clean vendor manifest may narrow the conservative legacy fallback.
    git(["ls-files", "--error-unmatch", ".opencode/.harness-owned-files.json"]);
    git(["diff", "--quiet", "--", ".opencode/.harness-owned-files.json"]);
    git(["diff", "--cached", "--quiet", "--", ".opencode/.harness-owned-files.json"]);
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.files) || parsed.files.some((path) => typeof path !== "string")) {
      throw new Error("invalid ownership manifest");
    }
    owned = new Set(parsed.files);
  } catch {
    const legacyPrefixes = [
      ".opencode/agents/", ".opencode/command/", ".opencode/docs/", ".opencode/skills/",
      ".opencode/plugin/", ".opencode/tools/", ".opencode/hands/", ".opencode/rules/",
      ".opencode/lib/", ".opencode/shared/",
    ];
    const legacyFiles = new Set([".opencode/.gitignore", ".opencode/.harness-version", ".opencode/.harness-config-manifest.json", ".opencode/AGENTS.md", ".opencode/harness.routing.json", "opencode.json", "AGENTS.md", "harness.routing.json"]);
    const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
    owned = new Set(tracked.filter((path) => legacyFiles.has(path) || legacyPrefixes.some((prefix) => path.startsWith(prefix))));
  }
  const dirtyOwned = [...paths].filter((path) => owned.has(path));
  if (dirtyOwned.length > 0) {
    throw new Error(`pre-existing tracked change in lifecycle-owned cargo: ${dirtyOwned.join(", ")}`);
  }
  const target = resolve(cwd, git(["rev-parse", "--git-path", `harness-lifecycle-${operation}.json`]).trim());
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, paths: [...paths] })}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  return paths.size;
}

/**
 * @description Resolves the latest release tag from GitHub.
 * @returns {string | null} The latest tag or null on failure.
 */
function resolveLatestTag() {
  try {
    return execFileSync(
      "gh",
      [
        "release",
        "view",
        "--repo",
        "orobsonn/claude-harness",
        "--json",
        "tagName",
        "-q",
        ".tagName",
      ],
      {
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 5000,
        encoding: "utf8",
      }
    ).trim();
  } catch {
    try {
      const json = execFileSync(
        "curl",
        ["-fs", "--max-time", "5", "https://api.github.com/repos/orobsonn/claude-harness/releases/latest"],
        {
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 5000,
          encoding: "utf8",
        }
      );
      return JSON.parse(json).tag_name.trim();
    } catch {
      return null;
    }
  }
}

/**
 * @description Default vendor runner that delegates to vendor-core.mjs.
 * Public CLI `--target` is the runtime shell; vendor-core uses `--target` for project dir
 * and `--runtime` for claude|opencode|both.
 * @param {object} options - The vendor options.
 * @param {string} options.source - The source URL.
 * @param {string} options.ref - The git ref.
 * @param {string} options.target - The project directory.
 * @param {boolean} [options.withCodex]
 * @param {string} [options.runtimeTarget]
 */
function runVendorDefault({ source, ref, target, withCodex = false, runtimeTarget = "claude" }) {
  const here = dirname(fileURLToPath(import.meta.url));
  const vendorCorePath = join(here, "vendor-core.mjs");
  const flags = [
    "--source",
    source,
    "--ref",
    ref,
    "--target",
    target,
    "--runtime",
    runtimeTarget,
  ];
  if (withCodex) flags.push("--with-codex");
  execFileSync(process.execPath, [vendorCorePath, ...flags], { stdio: "inherit" });
}

/** @description Prompts on the TTY for a single line. Resolves with the typed answer. */
function askTTY(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

// ---------- main (runs only when invoked directly as a script) ----------

/**
 * @description Real seams for the setup-vps wizard. Infers everything it can so the operator barely
 * types: the engine dir (this script's own clone if it ships core/vps, else a stable ~/.claude/
 * harness-core auto-cloned once — NEVER the ephemeral npx cache), the project (cwd), and owner/repo
 * (the dir's git remote). Token write is 0600 and never logs the token.
 * @returns {object}
 */
function setupVpsSeams() {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dual-runtime layout: this file lives at
  // <harness>/core/claude-code/skills/initializing-projects/references/cli.mjs — 5 up is the harness
  // root. Legacy flat layout (core/skills/…/references) is 4 up. Prefer the candidate that actually
  // ships core/vps (a real clone, not npx).
  const candidates = [
    join(here, "..", "..", "..", "..", ".."),
    join(here, "..", "..", "..", ".."),
  ];
  const localCandidate =
    candidates.find((dir) => existsSync(join(dir, "core", "vps", "install-crons.mjs"))) ?? null;
  const localEngineDir = localCandidate;
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const stableEngineDir = join(home, ".claude", "harness-core");
  return {
    ask: askTTY,
    out: (t) => process.stdout.write(`${t}\n`),
    env: process.env,
    cwd: process.cwd(),
    gitRemote: (dir) => {
      try {
        return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return "";
      }
    },
    localEngineDir,
    stableEngineDir,
    cloneEngine: (dir) => {
      const tag = resolveLatestTag();
      const args = ["clone", "--depth", "1"];
      if (tag) args.push("--branch", tag);
      args.push(SOURCE_URL, dir);
      execFileSync("git", args, { stdio: "inherit" });
    },
    exists: (p) => existsSync(p),
    readFileSafe: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    },
    writeDevVars: (p, content) => {
      writeFileSync(p, content, { mode: 0o600 });
      try {
        chmodSync(p, 0o600);
      } catch {
        // best-effort tighten — a pre-existing file may resist chmod under some mounts
      }
    },
    ensureDir: (d) => mkdirSync(d, { recursive: true }),
    devVarsPathFor: (h) => join(h, ".claude", ".dev.vars"),
    runInstall: (scriptPath, args) => execFileSync(process.execPath, [scriptPath, ...args], { stdio: "inherit" }),
  };
}

async function main() {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv);
  } catch (err) {
    process.stderr.write(`[claude-harness] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const {
    command: rawCommand,
    withCodex: withCodexFlag,
    runtimeTarget,
    releaseRef,
  } = parsed;
  // `init` is a backward-compatible alias for `setup-local` (vendors the harness locally).
  const command = rawCommand === "init" ? "setup-local" : rawCommand;

  if (command === "setup-vps") {
    try {
      await runSetupVps(setupVpsSeams());
    } catch (err) {
      process.stderr.write(`[claude-harness] ${err.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (command === "lifecycle-snapshot") {
    try {
      const count = writeLifecycleSnapshot(process.cwd(), process.argv[3]);
      process.stdout.write(`[claude-harness] lifecycle snapshot captured (${count} existing path(s))\n`);
    } catch (err) {
      process.stderr.write(`[claude-harness] ${err.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (command === "lifecycle-update") {
    if (!releaseRef) {
      process.stderr.write("[claude-harness] lifecycle-update requires --ref <release-tag>\n");
      process.exit(1);
    }
    try {
      const result = runIsolatedLifecycleUpdate({
        cwd: process.cwd(),
        ref: releaseRef,
        runtimeTarget,
      });
      const url = typeof result?.url === "string" ? ` ${result.url}` : "";
      process.stdout.write(`[claude-harness] lifecycle update ${releaseRef}: ${result.action}.${url}\n`);
    } catch (err) {
      process.stderr.write(`[claude-harness] ${err.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (command !== "setup-local") {
    process.stderr.write(
      "Usage:\n" +
        "  npx claude-harness init --target opencode|claude|both [--with-codex]\n" +
        "  npx claude-harness setup-local [--target opencode|claude|both] [--with-codex]\n" +
      "  npx claude-harness lifecycle-snapshot updating-harness\n" +
      "  npx claude-harness lifecycle-update --target opencode|claude|both --ref <release-tag>\n" +
      "  npx claude-harness setup-vps\n"
    );
    process.exit(1);
  }

  const withCodex =
    runtimeTarget === "opencode"
      ? false
      : await decideCodex({
          withCodexFlag,
          isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          ask: askTTY,
        });

  try {
    const cwd = process.cwd();
    const isTTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    const dim = (text) => (isTTY ? `\x1b[2m${text}\x1b[0m` : text);
    process.stdout.write(`${dim("→")} Resolving latest harness release...\n`);
    const tag = runInit({
      cwd,
      resolveTag: () => {
        const resolved = resolveLatestTag();
        if (resolved) process.stdout.write(`${isTTY ? "\x1b[32m✓\x1b[0m" : "✓"} latest release: ${resolved}\n`);
        return resolved;
      },
      runVendor: runVendorDefault,
      withCodex,
      runtimeTarget,
    });
    const destHint =
      runtimeTarget === "opencode"
        ? "./.opencode"
        : runtimeTarget === "both"
          ? "./.claude + ./.opencode"
          : "./.claude";
    process.stdout.write(
      `[claude-harness] vendored harness ${tag} into ${destHint} — review and commit.\n`
    );
    if (withCodex) {
      const toggle = enableCrossFamilyToggle(join(cwd, ".claude"));
      if (toggle.ok) {
        process.stdout.write(`[claude-harness] cross-family toggle set: ${CROSS_FAMILY_ENV}=1 in .claude/settings.local.json\n`);
      } else {
        process.stdout.write(
          `[claude-harness] could not write the toggle (${toggle.reason}). Add it manually to .claude/settings.local.json:\n` +
          `  { "env": { "${CROSS_FAMILY_ENV}": "1" } }\n`
        );
      }
      process.stdout.write(codexSetupNotes());
    }
  } catch (err) {
    process.stderr.write(`[claude-harness] ${err.message}\n`);
    process.exit(1);
  }
}

if (isDirectCli(process.argv[1])) {
  main();
}
