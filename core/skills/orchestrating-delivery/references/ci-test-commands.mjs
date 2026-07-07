/**
 * @description Enumerates + executes the test commands a project's CI declares, so the delivery
 * gate reproduces CI's test list 1:1 (every `--config` variant) instead of a project passing
 * locally while an entire runner config's tests never ran. Pure-ish core functions with injectable
 * `fs`/`spawn` (matches runner-adapters.mjs) — node builtins only, no new dependency.
 *
 * TRUST BOUNDARY (RJ-4): `runCiTestCommands` shells out (`spawnSync`, `shell:true`) to execute the
 * enumerated commands. The executed strings come ONLY from repo-owned content — the project's own
 * `package.json` `scripts` and `.github/workflows/*.yml` `run:` steps, both checked into the repo
 * and reviewable. This module never executes commands sourced from untrusted/external input, user
 * prompts, or PR bodies. CI/package.json content is trusted to the same degree the CI runner itself
 * trusts it (CI executes these strings verbatim). Callers MUST NOT feed non-repo content through
 * `enumerateCiTestCommands`/`runCiTestCommands`; the injectable `fs`/`spawn` exist for hermetic
 * testing, not for widening the trust boundary.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { isDirectCli, parseFlags } from "./cli-flags.mjs";

const RUNNERS = new Set(["vitest", "jest", "mocha"]);
const BLOCK_SCALAR_INDICATORS = new Set(["|", ">", "|-", ">-", "|+", ">+"]);
const FOLDED_BLOCK_INDICATORS = new Set([">", ">-", ">+"]);
const UNSPLIT_SHELL_METACHARACTERS = /[$`|<>()]/;

/** @description Default node:fs backing `enumerateCiTestCommands` when no `fsImpl` is injected. */
const NODE_FS = { existsSync, readFileSync, readdirSync };

/**
 * @description Default spawn backing `runCiTestCommands` when no `spawnImpl` is injected —
 * `shell:true` is intentional (the enumerated strings are repo-owned CI/package.json commands, see
 * the module-level trust boundary). Returns the shape the injectable test fake returns.
 * @param {string} command
 * @returns {{ status: number }}
 */
function defaultSpawn(command) {
  const result = spawnSync(command, { shell: true, encoding: "utf8" });
  return { status: result.status };
}

/** @description Whitespace-collapses a command string (preserves `${{ }}` and `--config=` forms). */
function collapseWhitespace(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/**
 * @description Strips one or more leading `ENV=val` prefixes (e.g. `NODE_ENV=test`) so the runner
 * token is reachable. Value is non-space chars (handles unquoted and `"quoted"` alike).
 */
function stripEnvPrefixes(cmd) {
  let out = cmd;
  for (;;) {
    const match = out.match(/^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)\s+/);
    if (!match) break;
    out = out.slice(match[0].length);
  }
  return out;
}

/** @description Strips a single leading package-manager binary launcher (`npx`/`pnpm exec`/`yarn`). */
function stripLauncher(cmd) {
  return cmd.replace(/^(?:npx|pnpm exec|yarn)\s+/, "");
}

/** @description Full normalization applied to a resolved script value: collapse, strip ENV, strip launcher. */
function normalizeResolved(raw) {
  return stripLauncher(stripEnvPrefixes(collapseWhitespace(raw)));
}

/** @description True iff the token list carries a `--test` flag (`--test` or `--test=…`). */
function hasTestFlag(tokens) {
  return tokens.some((t) => t === "--test" || t.startsWith("--test="));
}

/**
 * @description Recognizes a normalized command as a direct test-runner invocation (RJ-1 runner/node
 * branches — NO script indirection here). Returns the command string if recognized, else null.
 * @param {string} cmd
 * @returns {string|null}
 */
function recognizeRunnerOrNode(cmd) {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (RUNNERS.has(tokens[0])) return cmd;
  if (tokens[0] === "node" && hasTestFlag(tokens)) return cmd;
  return null;
}

/**
 * @description Extracts the package.json script name from an `npm`/`yarn`/`pnpm` test-script call
 * (RJ-1 script-indirection branch), or null when the command is not such a call. Recognized forms:
 * `npm test`, `npm run <name>`, `npm run-script <name>`, `yarn <name>`, `yarn run <name>`,
 * `pnpm <name>`, `pnpm run <name>`. `pnpm exec <bin>` is a binary LAUNCHER (not a script call) and
 * returns null so the caller falls through to `stripLauncher`. The "script must exist" check in
 * `resolveScript` is what disambiguates `yarn vitest` (binary launch) from `yarn test` (script).
 * @param {string} cmd
 * @returns {string|null}
 */
function extractScriptName(cmd) {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const head = tokens[0];
  if (head === "npm") {
    if (tokens[1] === "test") return "test";
    if ((tokens[1] === "run" || tokens[1] === "run-script") && tokens[2]) return tokens[2];
    return null;
  }
  if (head === "yarn") {
    if (!tokens[1]) return null;
    if (tokens[1] === "run" && tokens[2]) return tokens[2];
    return tokens[1];
  }
  if (head === "pnpm") {
    if (!tokens[1] || tokens[1] === "exec") return null;
    if (tokens[1] === "run" && tokens[2]) return tokens[2];
    return tokens[1];
  }
  return null;
}

/**
 * @description Resolves ONE level of npm/yarn/pnpm script indirection against `scripts` and returns
 * the normalized resolved runner command, or null when there is no matching script (RJ-1: one level
 * only — the resolved string is re-tested by `recognizeRunnerOrNode` by the caller, never recursed).
 * @param {string} cmd
 * @param {Record<string, string>} scripts
 * @returns {string|null}
 */
function resolveScript(cmd, scripts) {
  const name = extractScriptName(cmd);
  if (name === null) return null;
  const value = scripts[name];
  return typeof value === "string" ? normalizeResolved(value) : null;
}

/** @description Splits a run: block on `&&`, `;`, and newline (command chaining). */
function splitChain(raw) {
  return String(raw)
    .split(/&&|;|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @description Line/indent scanner that collects every `run:` step's command text from a workflow
 * body (node builtins only — no YAML dep). Handles inline scalars (`run: vitest run`) and `run: |`
 * / `run: >` block scalars (content dedented by the first content line's indent). The block text is
 * split on `&&`/`;`/newline later by `splitChain`.
 * @param {string} text
 * @returns {string[]}
 */
function collectRunCommandsFromYaml(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const rest = match[2].trim();
    if (BLOCK_SCALAR_INDICATORS.has(rest)) {
      const blockLines = [];
      let contentIndent = null;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const blockLine = lines[j];
        if (blockLine.trim() === "") {
          blockLines.push("");
          continue;
        }
        const blockIndent = blockLine.match(/^(\s*)/)[1].length;
        if (blockIndent <= indent) break;
        if (contentIndent === null) contentIndent = blockIndent;
        blockLines.push(blockLine.slice(contentIndent));
      }
      if (FOLDED_BLOCK_INDICATORS.has(rest)) {
        const segments = [];
        let current = [];
        for (const line of blockLines) {
          if (line === "") {
            if (current.length) {
              segments.push(current.join(" "));
              current = [];
            }
          } else {
            current.push(line);
          }
        }
        if (current.length) segments.push(current.join(" "));
        out.push(segments.join("\n"));
      } else {
        out.push(blockLines.join("\n"));
      }
      i = j - 1;
    } else if (rest !== "") {
      out.push(rest);
    }
  }
  return out;
}

/** @description Reads `<projectRoot>/package.json` `scripts` (JSON.parse); {} when absent/unparseable. */
function readPackageScripts(projectRoot, fs) {
  const pkgPath = join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
  } catch {
    return {};
  }
}

/** @description Collects `run:` command text from every `.github/workflows/*.yml` file. */
function collectCiRunCommands(projectRoot, fs) {
  const dir = join(projectRoot, ".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const path = join(dir, name);
    try {
      out.push(...collectRunCommandsFromYaml(fs.readFileSync(path, "utf8")));
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * @description Classifies a single (already chain-split) command string against the RJ-1 predicate
 * and pushes into `commands` or `unresolved`. Mutates the two accumulators and the dedup set.
 * @param {string} raw
 * {"package.json"|"ci"} source
 * @param {Record<string, string>} scripts
 * @param {{command:string, source:string}[]} commands
 * @param {{command:string, source:string}[]} unresolved
 * @param {Set<string>} seen
 */
function classifyCommand(raw, source, scripts, commands, unresolved, seen) {
  const collapsed = collapseWhitespace(raw);
  if (!collapsed) return;
  const cmd = stripEnvPrefixes(collapsed);

  if (cmd.includes("${{")) {
    unresolved.push({ command: cmd, source });
    return;
  }

  const resolved = resolveScript(cmd, scripts);
  if (resolved !== null) {
    const recognized = recognizeRunnerOrNode(resolved);
    if (recognized && UNSPLIT_SHELL_METACHARACTERS.test(recognized)) {
      unresolved.push({ command: recognized, source });
      return;
    }
    if (recognized && !seen.has(recognized)) {
      seen.add(recognized);
      commands.push({ command: recognized, source });
    }
    return;
  }

  const recognized = recognizeRunnerOrNode(stripLauncher(cmd));
  if (recognized && UNSPLIT_SHELL_METACHARACTERS.test(recognized)) {
    unresolved.push({ command: recognized, source });
    return;
  }
  if (recognized && !seen.has(recognized)) {
    seen.add(recognized);
    commands.push({ command: recognized, source });
  }
}

/**
 * @description Enumerates the test commands CI declares — the union of repo-root `package.json`
 * `scripts` and every `.github/workflows/*.yml` `run:` step, deduped by normalized command string
 * (RJ-2). Recognition (RJ-1): after stripping a leading `ENV=val` prefix and a `npx`/`pnpm exec`/
 * `yarn` launcher, the runner token is `vitest`|`jest`|`mocha`, OR it is `node … --test …` (the
 * `--test` flag REQUIRED), OR it is an `npm`/`yarn`/`pnpm` test-script call resolved ONE level
 * against `package.json` `scripts` and re-tested. Every `--config x` / `--config=x` / `-c x`
 * variant is kept distinct. A command carrying an unexpanded `${{ … }}` template is NOT executed
 * and NOT dropped — it lands in `unresolved` and forces `complete:false` (RJ-3, fail-closed).
 * @param {string} projectRoot
 * @param {{ existsSync: Function, readFileSync: Function, readdirSync: Function }} [fsImpl]
 * @returns {{ commands: Array<{command:string, source:"package.json"|"ci"}>, unresolved: Array<{command:string, source:"package.json"|"ci"}>, complete: boolean }}
 */
export function enumerateCiTestCommands(projectRoot, fsImpl = NODE_FS) {
  const fs = fsImpl || NODE_FS;
  const scripts = readPackageScripts(projectRoot, fs);
  const commands = [];
  const unresolved = [];
  const seen = new Set();

  for (const value of Object.values(scripts)) {
    if (typeof value !== "string") continue;
    for (const part of splitChain(value)) {
      classifyCommand(part, "package.json", scripts, commands, unresolved, seen);
    }
  }

  for (const raw of collectCiRunCommands(projectRoot, fs)) {
    for (const part of splitChain(raw)) {
      classifyCommand(part, "ci", scripts, commands, unresolved, seen);
    }
  }

  return { commands, unresolved, complete: unresolved.length === 0 };
}

/**
 * @description Executes each enumerated command via `spawnImpl(command) → { status }` and aggregates
 * the exit codes (RJ-4). `allGreen` is true iff every result exited 0 (empty `commands` ⇒ true);
 * `complete` is propagated from `enumResult.complete` (RJ-3 unresolved templates block here).
 * Injectable `spawnImpl` lets the locked test drive exit codes without running real suites.
 * @param {{ commands: Array<{command:string}>, complete: boolean }} enumResult
 * @param {(command: string) => { status: number }} [spawnImpl]
 * @returns {{ results: Array<{command:string, exitCode:number}>, allGreen: boolean, complete: boolean }}
 */
export function runCiTestCommands(enumResult, spawnImpl = defaultSpawn) {
  const commands = enumResult && Array.isArray(enumResult.commands) ? enumResult.commands : [];
  const results = commands.map((entry) => {
    const spawned = spawnImpl(entry.command);
    const exitCode = spawned && typeof spawned.status === "number" ? spawned.status : 1;
    return { command: entry.command, exitCode };
  });
  const allGreen = results.every((r) => r.exitCode === 0);
  return { results, allGreen, complete: enumResult ? Boolean(enumResult.complete) : true };
}

/**
 * @description The delivery-blocking exit code: 0 iff `allGreen && complete`, else 1 (#ac-1.2).
 * @param {{ allGreen: boolean, complete: boolean }} result
 * @returns {number}
 */
export function ciSuiteExitCode(result) {
  return result && result.allGreen && result.complete ? 0 : 1;
}

/**
 * @description CLI entrypoint: enumerate → run → write `{commands, unresolved, results, allGreen,
 * complete}` to `--out` → exit 0 iff `allGreen && complete`, else non-zero (delivery-blocking).
 * Flags: `--project-root <dir>` (default cwd), `--out <path>`
 * (default `<projectRoot>/.claude/plans/ci-suite/run/ci-suite-result.json`).
 */
function runCli() {
  const args = parseFlags(process.argv.slice(2), "ci-test-commands");
  const projectRoot = args["project-root"] || process.cwd();
  const out = args["out"] || join(projectRoot, ".claude", "plans", "ci-suite", "run", "ci-suite-result.json");

  const enumResult = enumerateCiTestCommands(projectRoot);
  const runResult = runCiTestCommands(enumResult);
  const artifact = {
    commands: enumResult.commands,
    unresolved: enumResult.unresolved,
    results: runResult.results,
    allGreen: runResult.allGreen,
    complete: runResult.complete,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  process.exit(ciSuiteExitCode(runResult));
}

if (isDirectCli(import.meta.url)) {
  runCli();
}