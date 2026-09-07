/**
 * @description PreToolUse(Bash) hook — deterministic deny for two `lavish-axi` subcommands that
 * must never run from this harness: `share` (publishes the artifact to a third-party host,
 * ht-ml.app, public by default) and `setup hooks` (installs a SessionStart hook that competes
 * with this harness's own entry-policy hook). grill's SKILL.md already prohibits both in prose
 * (see core/claude-code/skills/grill/references/lavish-usage.md) — this hook is the technical
 * backstop, since `build`/local sessions generally allow bash and prose alone is not a gate.
 *
 * Deliberately its own file, registered as a second command inside the existing PreToolUse
 * "Bash" matcher entry in settings.json (mirrors the existing pattern: PostToolUse "Agent" already
 * runs three independent hooks — codex-eye-nudge.mjs, obs-eye-append.mjs, agent-idle-nudge.mjs —
 * off one matcher) rather than folding into entry-gate.mjs's decideBash — that function is
 * delivery-pipeline ceremony (branch/regate/capture rails), a different concern from a narrow
 * third-party-CLI command deny.
 *
 * Fail-open contract: exits 0 on ANY parse/infra error; DENY only in the deliberate match branch.
 *
 * Deny output (stdout, then exit 0):
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
 * Allow output: no stdout, exit 0.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Shell-clause separators — a forbidden subcommand must be matched WITHIN one clause, so an
 * unrelated later command chained with `&&`/`;`/`|` cannot false-positive off an earlier mention. */
const SEGMENT_SPLIT = /[;&|\n]+/;
const LAVISH_TOKEN = /\blavish-axi(?:@[\w.-]+)?\b/i;
const SHARE_SUBCOMMAND = /\bshare\b/i;
const SETUP_HOOKS_SUBCOMMAND = /\bsetup\s+hooks\b/i;

/**
 * @description Returns the forbidden subcommand name ("share" | "setup hooks") if `command`
 * invokes `lavish-axi` with either in the same shell clause, else null. Never throws.
 * @param {unknown} command
 * @returns {"share" | "setup hooks" | null}
 */
export function forbiddenLavishSubcommand(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  const segments = command.split(SEGMENT_SPLIT);
  for (const segment of segments) {
    if (!LAVISH_TOKEN.test(segment)) continue;
    if (SHARE_SUBCOMMAND.test(segment)) return "share";
    if (SETUP_HOOKS_SUBCOMMAND.test(segment)) return "setup hooks";
  }
  return null;
}

/**
 * Pure decision layer — testable without spawning.
 * @param {unknown} payload - The parsed hook payload
 * @returns {{ allow: true }
 *         | { allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
export function decide(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { allow: true };
  }
  const command = payload?.tool_input?.command;
  const forbidden = forbiddenLavishSubcommand(command);
  if (forbidden === null) {
    return { allow: true };
  }
  return {
    allow: false,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `[lavish-command-gate] Blocked: 'lavish-axi ${forbidden}' is forbidden in this harness. ` +
        (forbidden === "share"
          ? "It publishes the artifact to a third-party host (ht-ml.app), public by default — " +
            "never used for grill mockups, which may reveal unannounced product decisions even in " +
            "wireframe form."
          : "It installs a SessionStart hook that competes with this harness's own entry-policy hook.") +
        " See core/*/skills/grill/references/lavish-usage.md.",
    },
  };
}

/**
 * Processes a raw stdin string through the gate.
 * Parse failure → fail-open (exitCode 0, output null).
 * Deny verdict → output is the JSON string to write to stdout.
 * @param {string} rawStr - Raw string from stdin
 * @returns {{ exitCode: 0, output: string|null }}
 */
export function processInput(rawStr) {
  let payload;
  try {
    payload = JSON.parse(rawStr);
  } catch {
    return { exitCode: 0, output: null };
  }

  let verdict;
  try {
    verdict = decide(payload);
  } catch {
    return { exitCode: 0, output: null };
  }

  if (!verdict.allow) {
    return {
      exitCode: 0,
      output: JSON.stringify({ hookSpecificOutput: verdict.hookSpecificOutput }),
    };
  }

  return { exitCode: 0, output: null };
}

// ---------------------------------------------------------------------------
// CLI entry point — guarded so imports from tests do not trigger side effects
// ---------------------------------------------------------------------------

function isDirectCli() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === modulePath;
  } catch {
    return process.argv[1] === modulePath;
  }
}

if (isDirectCli()) {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }

  try {
    const result = processInput(raw);
    if (result.output !== null) {
      process.stdout.write(result.output + "\n");
    }
  } catch {
    // Unexpected error — fail-open
  }

  process.exit(0);
}
