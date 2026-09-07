/**
 * @description Pure decision layer for the OC lavish-command-gate plugin. Ported 1:1 from
 * Claude Code's core/claude-code/hooks/lavish-command-gate.mjs (forbiddenLavishSubcommand/decide)
 * so both runtimes deny the same two `lavish-axi` subcommands identically: `share` (publishes to
 * a third-party host, ht-ml.app, public by default) and `setup hooks` (installs a SessionStart
 * hook that competes with this harness's own). Never throws — the plugin wrapper decides whether
 * a deny verdict becomes a thrown Error (OC's tool.execute.before contract).
 */

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
 * @description Builds the deny reason for a forbidden subcommand, or null if `command` is fine.
 * @param {unknown} command
 * @returns {string | null}
 */
export function lavishDenyReason(command) {
  const forbidden = forbiddenLavishSubcommand(command);
  if (forbidden === null) return null;
  return (
    `[lavish-command-gate] Blocked: 'lavish-axi ${forbidden}' is forbidden in this harness. ` +
    (forbidden === "share"
      ? "It publishes the artifact to a third-party host (ht-ml.app), public by default — never " +
        "used for grill mockups, which may reveal unannounced product decisions even in " +
        "wireframe form."
      : "It installs a SessionStart hook that competes with this harness's own entry-policy hook.") +
    " See core/*/skills/grill/references/lavish-usage.md."
  );
}
