#!/usr/bin/env node
/**
 * @description Thin CLI wrapper for `npx claude-harness init` that vendors the harness.
 *
 * Delegates to vendor-core.mjs for the actual vendoring. Node builtins only.
 * Usage: npx claude-harness init
 */

import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createInterface } from "node:readline";

export const SOURCE_URL = "https://github.com/orobsonn/claude-harness.git";

/** @description Env key that turns the cross-family (Codex/GPT) eyes on. */
export const CROSS_FAMILY_ENV = "HARNESS_CODEX_ADVERSARY";

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
 * @description Parses the command and flags from argv.
 * @param {string[]} argv - The process.argv-shaped array.
 * @returns {{ command: string | undefined, withCodex: boolean }} The parsed command + flags.
 */
export function parseCliArgs(argv) {
  return { command: argv[2], withCodex: argv.includes("--with-codex") };
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
 * @param {(opts: { source: string, ref: string, target: string, withCodex: boolean }) => void} options.runVendor - Function to run the vendor.
 * @param {boolean} [options.withCodex] - Vendor the cross-family Codex module.
 * @returns {string} The resolved tag.
 */
export function runInit({ cwd, resolveTag, runVendor, withCodex = false }) {
  const tag = resolveTag();
  if (!tag) {
    throw new Error(
      "claude-harness: could not resolve the latest release tag from " +
        SOURCE_URL +
        " (need network + gh or curl). Aborting — refusing to vendor an unpinned ref."
    );
  }
  runVendor({ source: SOURCE_URL, ref: tag, target: cwd, withCodex });
  return tag;
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
 * @param {object} options - The vendor options.
 * @param {string} options.source - The source URL.
 * @param {string} options.ref - The git ref.
 * @param {string} options.target - The target directory.
 */
function runVendorDefault({ source, ref, target, withCodex = false }) {
  const here = dirname(fileURLToPath(import.meta.url));
  const vendorCorePath = join(here, "vendor-core.mjs");
  const flags = ["--source", source, "--ref", ref, "--target", target];
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

async function main() {
  const { command, withCodex: withCodexFlag } = parseCliArgs(process.argv);
  if (command !== "init") {
    process.stderr.write("Usage: npx claude-harness init [--with-codex]\n");
    process.exit(1);
  }

  const withCodex = await decideCodex({
    withCodexFlag,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: askTTY,
  });

  try {
    const cwd = process.cwd();
    const tag = runInit({ cwd, resolveTag: resolveLatestTag, runVendor: runVendorDefault, withCodex });
    process.stdout.write(
      `[claude-harness] vendored harness ${tag} into ./.claude — review and commit.\n`
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