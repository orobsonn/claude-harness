/**
 * @description Shared `--flag value` argv parser for the harness's thin CLI entrypoints
 * (`descriptor-emitter.mjs`, `brief-serializer.mjs`). The same loop already existed independently
 * in `spawn-hand.mjs` (`parseLiveArgs`) and `dispatch-hand.mjs` (`parseArgs`); this is the third
 * copy, crossing the documented 3-or-more-duplicates threshold — extracted here rather than
 * inline. Retrofitting the two pre-existing copies is intentionally out of scope for this change.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @description Parses `--flag value` pairs from argv into a plain object (keys without `--`).
 * Exits the process with status 1 on an argument not starting with `--` — same fail-fast
 * contract as the pre-existing duplicates.
 * @param {string[]} argv
 * @param {string} toolName - Used to prefix the stderr message (e.g. "[descriptor-emitter]").
 * @returns {Record<string, string|undefined>}
 */
export function parseFlags(argv, toolName) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) {
      process.stderr.write(`[${toolName}] unexpected argument: ${key}\n`);
      process.exit(1);
    }
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

/**
 * @description Symlink-safe guard for "is this module the directly-invoked CLI entrypoint"
 * (mirrors `core/hooks/mark.mjs`'s `isDirectCli`). The naive `import.meta.url === file://${process.argv[1]}`
 * check used by the pre-existing CLIs in this directory breaks when the script is invoked through
 * a symlink (argv[1] resolves to the symlink path, not the real module path); `realpathSync`
 * resolves that before comparing, falling back to the naive comparison if realpath fails.
 * @param {string} moduleUrl - Pass `import.meta.url` from the calling module.
 * @returns {boolean}
 */
export function isDirectCli(moduleUrl) {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(process.argv[1]) === modulePath;
  } catch {
    return process.argv[1] === modulePath;
  }
}
