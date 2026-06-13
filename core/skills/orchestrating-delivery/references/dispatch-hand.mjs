#!/usr/bin/env node
/**
 * @description Dispatch runner for the "strong eyes, cheap hands" model: a code-writing
 * HAND runs on a cheap Ollama model via an external `claude -p` process (with an isolated
 * ephemeral CLAUDE_CONFIG_DIR so the global ~/.claude laws are excluded), while the
 * judging EYES stay on Claude. This helper is dependency-free (Node builtins only) and is
 * structured as PURE, TESTABLE functions plus a thin CLI.
 *
 * Conceptually a dispatch launches:
 *   ANTHROPIC_BASE_URL=https://ollama.com \
 *   ANTHROPIC_AUTH_TOKEN=<secret> \
 *   CLAUDE_CONFIG_DIR=<ephemeral-tmp-dir> \
 *   claude -p --model <model> --output-format json --permission-mode acceptEdits
 * in the working tree, under the harness's existing command-sandbox (NO container).
 *
 * SECURITY is load-bearing:
 *   - The Ollama auth token is read from `.dev.vars` / `process.env` (both gitignored) and
 *     is NEVER materialized into the brief, shared_context, or any captured/committed
 *     artifact. It is redacted from every log line and the captured JSON/NDJSON.
 *   - The TRUTH of a hand's work is the scope-checked git diff + the locked-test exit code
 *     + a JSON status block — NEVER the model's prose. A child that claims success in prose
 *     but produced an empty diff is NOT DONE. The spawn/capture layer MUST populate the
 *     child's `touchedPaths` from an independent `git diff --name-only` and its
 *     `lockedTestExitCode` from an independent frozen-test run — never parsed from the
 *     model's stdout/prose. A child flagged `source: "model_prose"` is rejected as untrusted.
 *
 * One-line setup (in a consumer project): copy `.dev.vars.example` to `.dev.vars` and set
 *   ANTHROPIC_AUTH_TOKEN=<your-ollama-token>
 * `.dev.vars` is gitignored — the token never reaches the repo. The placeholder is shipped
 * by vendor-core (REPO_FILES maps core/dev.vars.example → project-root .dev.vars.example).
 *
 * This runner executes in the CONSUMER project (vendored via vendor-core), not in the
 * harness repo itself.
 *
 * Usage (CLI): node dispatch-hand.mjs --dispatch <dispatch.json> [--result <child.json>]
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REDACTION_MARKER = "[REDACTED_AUTH_TOKEN]";
export const AUTH_TOKEN_KEY = "ANTHROPIC_AUTH_TOKEN";
export const UPSTREAM_BODY_MAX = 500;

/** @description Run outcomes. Truth = git diff + locked-test exit + status, never prose. */
export const OUTCOME = {
  DONE: "DONE",
  FAILED: "FAILED",
  NOT_DONE: "NOT_DONE",
};

/**
 * @description Resolves the Ollama auth token, preferring process.env over a parsed
 * `.dev.vars` blob. Returns undefined when neither source carries the key.
 * @param {Record<string,string|undefined>} env
 * @param {string} [devVarsContent] raw contents of a `.dev.vars` file
 * @returns {string|undefined}
 */
export function readAuthToken(env = {}, devVarsContent = "") {
  const fromEnv = env[AUTH_TOKEN_KEY];
  if (fromEnv) return fromEnv;
  for (const line of devVarsContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== AUTH_TOKEN_KEY) continue;
    const value = trimmed.slice(eq + 1).trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * @description Reads a file safely: returns '' on any error — never throws, never leaks the path.
 * @param {string} filePath
 * @returns {string}
 */
function defaultReadFileSafe(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  } catch {
    return "";
  }
}

/**
 * @description Resolves the Ollama auth token across env → cwd/.dev.vars → ~/.claude/.dev.vars (global).
 * The global file lets the operator set the token once without exporting ANTHROPIC_AUTH_TOKEN into the
 * shell (which would hijack Claude Code's own auth). cwd/homeDir/readFileSafe are injectable for tests.
 * @param {Record<string,string|undefined>} [env]
 * @param {{ cwd?: string, homeDir?: string, readFileSafe?: (path: string) => string }} [opts]
 * @returns {string|undefined}
 */
export function resolveAuthToken(env = {}, { cwd = process.cwd(), homeDir = homedir(), readFileSafe = defaultReadFileSafe } = {}) {
  const fromEnv = readAuthToken(env, "");
  if (fromEnv) return fromEnv;
  const fromCwd = readAuthToken({}, readFileSafe(join(cwd, ".dev.vars")));
  if (fromCwd) return fromCwd;
  return readAuthToken({}, readFileSafe(join(homeDir, ".claude", ".dev.vars")));
}

/**
 * @description Replaces every literal occurrence of `token` with the redaction marker.
 * A missing/empty token is a no-op, so this is always safe to call before logging.
 * @param {string} text
 * @param {string|undefined} token
 * @returns {string}
 */
export function redact(text, token) {
  if (!token) return text;
  return String(text).split(token).join(REDACTION_MARKER);
}

/**
 * @description Truncates an upstream error body to at most UPSTREAM_BODY_MAX chars before
 * it is captured/logged — a large body can leak JWTs, cookies or tokens.
 * @param {string} body
 * @param {number} [max]
 * @returns {string}
 */
export function truncateUpstreamError(body, max = UPSTREAM_BODY_MAX) {
  if (typeof body !== "string") return "";
  return body.length > max ? body.slice(0, max) : body;
}

/**
 * @description True when the child's output carries the known-benign `count_tokens` 404
 * (Ollama lacks that endpoint). Such a 404 must NOT fail the task. The match requires the
 * `count_tokens` endpoint token and a 404 to sit on the SAME line, with count_tokens BEFORE
 * the 404 and reasonably adjacent — so an arbitrary hostile string elsewhere can't trip it.
 * Each channel (stderr, stdout) is scanned independently with the same adjacency regex so
 * a 404 that appears only on stdout (or a parsed-json error field) is also recognised.
 * This only forgives the child EXIT CODE; the locked-test exit and the in-scope git diff
 * remain independent gates, so a child cannot fake acceptance by emitting this string.
 * @param {string} stderr
 * @param {string} [stdout]
 * @returns {boolean}
 */
export function isBenignCountTokens404(stderr = "", stdout = "") {
  const pattern = /count_tokens[^\n]{0,40}\b404\b/i;
  return pattern.test(stderr) || pattern.test(stdout);
}

/**
 * @description True when the COMBINED stream (stderr + stdout) carries any REAL upstream error
 * code: 5xx, 401, 403, or 429. The real-error set deliberately EXCLUDES 404, so a benign
 * `count_tokens 404` — which by itself contains no real-error code — never trips this. There is
 * therefore nothing positional to strip or skip: any 5xx/401/403/429 anywhere in the captured
 * stream is a genuine upstream error and must NOT be forgiven, regardless of its position
 * relative to the benign 404 (before it, after it, or between two count_tokens-404 spans). This
 * removes every positional edge case the prior per-line strip suffered.
 *
 * Accepted tradeoff: a benign body that happens to contain a standalone 5xx/401/403/429-looking
 * number would fail-CLOSED → escalation (the safe direction). In practice the Ollama count_tokens
 * 404 body carries no such codes, so this does not misfire.
 * @param {string} stderr
 * @param {string} [stdout]
 * @returns {boolean}
 */
export function hasNonBenignUpstreamError(stderr = "", stdout = "") {
  return /\b(5\d\d|401|403|429)\b/.test(`${stderr}\n${stdout}`);
}

/**
 * @description True when `path` is covered by an allow entry, using the SAME git-pathspec
 * convention as the pre-spawn guard (`git status --porcelain -- <entry>`): an entry covers an
 * exact-file match OR any path UNDER it as a directory, matched by PATH COMPONENT — with or
 * WITHOUT a trailing slash. The trailing slash is therefore cosmetic, not load-bearing: `core/x`
 * and `core/x/` both cover `core/x` and everything beneath `core/x/`. This is the single source
 * of truth for coverage, so the guard (git-pathspec prefix) and `checkScope` (this) can never
 * diverge on a directory entry a planner wrote without the trailing slash — the latent fail-closed
 * trap where one covered by prefix and the other demanded an exact match. The component boundary
 * (`base + "/"`) keeps `core/x` from spuriously covering a sibling like `core/xyz`, matching git.
 */
function isPathCovered(path, allowEntries) {
  return allowEntries.some((entry) => {
    const base = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    return path === base || path.startsWith(`${base}/`);
  });
}

/**
 * @description Reports every touched path that falls OUTSIDE scope_paths. The git diff is
 * the truth: any out-of-scope path is a violation regardless of what the model claims.
 * @param {string[]} touchedPaths
 * @param {string[]} scopePaths
 * @returns {string[]}
 */
export function checkScope(touchedPaths = [], scopePaths = []) {
  return touchedPaths.filter((p) => !isPathCovered(p, scopePaths));
}

/**
 * @description Reports every touched path that falls OUTSIDE the per-dispatch allowed-write
 * set. This set is NARROWER than scope_paths, so a hand can touch only the files it owns
 * (e.g. the executor can never write frozen test paths).
 * @param {string[]} touchedPaths
 * @param {string[]} allowedWrites
 * @returns {string[]}
 */
export function checkAllowedWrites(touchedPaths = [], allowedWrites = []) {
  return touchedPaths.filter((p) => !isPathCovered(p, allowedWrites));
}

/**
 * @description Reports every touched path that intersects the FROZEN manifest set — the
 * test/fixture files captured by the test-author and handed to the executor read-only. A
 * cheap HAND editing any frozen file is an AUTOMATIC gate failure, independent of
 * scope_paths/allowed_writes: the frozen test is the rail that makes the cheap hand safe, so
 * a hand that mutates it to make tests pass must never reach DONE.
 * @param {string[]} touchedPaths
 * @param {string[]} frozenPaths
 * @returns {string[]}
 */
export function checkFrozen(touchedPaths = [], frozenPaths = []) {
  return touchedPaths.filter((p) => isPathCovered(p, frozenPaths));
}

/**
 * @description Decides a run's outcome from the scope-checked diff + locked-test exit code
 * + child exit code — NEVER the prose. Order of judgment:
 *   1. untrusted child (model prose, not independently captured) → NOT_DONE
 *   2. out-of-scope write            → FAILED
 *   3. frozen-manifest write         → FAILED
 *   4. out-of-allowed-write-set      → FAILED
 *   5. empty diff (prose ignored)    → NOT_DONE
 *   6. non-zero child exit (non-benign count_tokens 404) → FAILED
 *   7. non-zero locked-test exit     → FAILED
 *   8. otherwise                     → DONE
 *
 * @contract `touchedPaths` and `lockedTestExitCode` MUST originate from an INDEPENDENT
 * capture — `git diff --name-only` for the paths and an independent frozen-test run for the
 * exit code — performed by the spawn/capture layer. They must NEVER be parsed from the
 * child's stdout/stderr/prose; a model that self-reports its own diff or test result can
 * lie. The gate is fail-CLOSED: a child reaches DONE only when the capture layer EXPLICITLY
 * attests `captured: true` on the harness-built result. A child marked `source: "model_prose"`,
 * or one that simply OMITS `captured`, is rejected as untrusted and never reaches DONE.
 * @param {{ dispatch: object, child: object }} args
 * @returns {{ status: string, scopeViolations: string[], frozenViolations: string[], allowedWriteViolations: string[], reasons: string[] }}
 */
export function evaluateRun({ dispatch, child }) {
  const reasons = [];

  if (child.source === "model_prose" || child.captured !== true) {
    reasons.push("untrusted child: touchedPaths/lockedTestExitCode must come from an independent git diff + frozen-test run, not model prose");
    return { status: OUTCOME.NOT_DONE, scopeViolations: [], frozenViolations: [], allowedWriteViolations: [], reasons };
  }

  const touched = child.touchedPaths ?? [];

  const scopeViolations = checkScope(touched, dispatch.scope_paths ?? []);
  const frozenViolations = checkFrozen(touched, dispatch.frozen_paths ?? []);
  const allowedWriteViolations = checkAllowedWrites(touched, dispatch.allowed_writes ?? []);

  let status = OUTCOME.DONE;

  if (scopeViolations.length) {
    status = OUTCOME.FAILED;
    reasons.push(`scope violation: ${scopeViolations.join(", ")}`);
  } else if (frozenViolations.length) {
    status = OUTCOME.FAILED;
    reasons.push(`frozen-manifest violation: ${frozenViolations.join(", ")}`);
  } else if (allowedWriteViolations.length) {
    status = OUTCOME.FAILED;
    reasons.push(`allowed-write violation: ${allowedWriteViolations.join(", ")}`);
  } else if (touched.length === 0) {
    status = OUTCOME.NOT_DONE;
    reasons.push("empty diff — prose-only success is not acceptance");
  } else if (child.exitCode !== 0 && !(isBenignCountTokens404(child.stderr ?? "", child.stdout ?? "") && !hasNonBenignUpstreamError(child.stderr ?? "", child.stdout ?? ""))) {
    status = OUTCOME.FAILED;
    reasons.push(`child exited ${child.exitCode}`);
  } else if ((child.lockedTestExitCode ?? 0) !== 0) {
    status = OUTCOME.FAILED;
    reasons.push(`locked tests exited ${child.lockedTestExitCode}`);
  }

  return { status, scopeViolations, frozenViolations, allowedWriteViolations, reasons };
}

/**
 * @description Deep-redacts every STRING VALUE in a JSON-like structure, leaving object
 * keys and structure intact. Redacting over a serialized blob would corrupt keys when the
 * token collides with JSON syntax, so we walk values instead.
 * @param {unknown} value
 * @param {string|undefined} token
 * @returns {unknown}
 */
export function redactDeep(value, token) {
  if (typeof value === "string") return redact(value, token);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, token));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, redactDeep(val, token)])
    );
  }
  return value;
}

/**
 * @description Builds the captured run record from a dispatch + synthetic/real child result,
 * with the auth token redacted from EVERY channel (brief, shared_context, stdout, stderr,
 * logs) and the upstream error body truncated. A final deep-redaction over the serialized
 * record guarantees the literal token leaks nowhere — even if a future field is added.
 * @param {{ dispatch: object, child: object, token: string|undefined, logs?: string[] }} args
 * @returns {object} JSON-serializable, token-free run record
 */
export function buildRunRecord({ dispatch, child, token, logs = [] }) {
  const outcome = evaluateRun({ dispatch, child });

  const record = {
    model: dispatch.model,
    brief: redact(dispatch.brief ?? "", token),
    shared_context: redact(dispatch.shared_context ?? "", token),
    scope_paths: dispatch.scope_paths ?? [],
    frozen_paths: dispatch.frozen_paths ?? [],
    allowed_writes: dispatch.allowed_writes ?? [],
    touchedPaths: child.touchedPaths ?? [],
    exitCode: child.exitCode,
    stdout: truncateUpstreamError(redact(child.stdout ?? "", token)),
    stderr: truncateUpstreamError(redact(child.stderr ?? "", token)),
    lockedTestExitCode: child.lockedTestExitCode ?? 0,
    upstreamErrorBody: truncateUpstreamError(redact(child.upstreamErrorBody ?? "", token)),
    logs: logs.map((line) => redact(line, token)),
    outcome,
  };

  // Defense in depth: deep-redact every string value so no field can leak the token,
  // even one added later — without corrupting keys/structure.
  return redactDeep(record, token);
}

// ---------- thin CLI ----------

/**
 * @description Reads + JSON-parses a file, or fails the process with a clear message. The
 * parse-error message is redacted with `token` first, because a malformed JSON error can
 * echo a file-content snippet (e.g. the .dev.vars-derived token) into stderr.
 * @param {string} path
 * @param {string|undefined} token
 */
function readJson(path, token) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    process.stderr.write(`[dispatch-hand] cannot read ${path}: ${redact(err.message, token)}\n`);
    process.exit(1);
  }
}

/** @description Parses `--flag value` pairs from argv. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) {
      process.stderr.write(`[dispatch-hand] unexpected argument: ${key}\n`);
      process.exit(1);
    }
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dispatch) {
    process.stderr.write("[dispatch-hand] --dispatch <dispatch.json> is required\n");
    process.exit(1);
  }
  // Resolve the token BEFORE any readJson so its parse-error path can redact a leaked snippet.
  const token = resolveAuthToken(process.env);

  const dispatch = readJson(args.dispatch, token);

  // The child result is supplied (already-captured) for evaluation. Live spawning of
  // `claude -p` (with an isolated ephemeral CLAUDE_CONFIG_DIR) is intentionally out of this
  // CLI's unit-tested surface; when wired, it MUST set ANTHROPIC_BASE_URL=https://ollama.com
  // and ANTHROPIC_AUTH_TOKEN (from `token` above) in the child env, set CLAUDE_CONFIG_DIR to
  // an ephemeral mkdtemp path (so global ~/.claude laws are excluded), pipe child stdout/stderr
  // through `redact(line, token)` at capture-write time, write `result.json` only into an
  // ephemeral, sandbox-scoped path, and populate `touchedPaths`/`lockedTestExitCode` from an
  // INDEPENDENT `git diff --name-only` + frozen-test run (never the model's prose). A future
  // live-spawn argv must likewise keep the token out of process arguments (env only).
  const child = args.result ? readJson(args.result, token) : { touchedPaths: [], exitCode: 1, stderr: "" };

  const record = buildRunRecord({ dispatch, child, token, logs: [] });
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  process.exit(record.outcome.status === OUTCOME.DONE ? 0 : 1);
}
