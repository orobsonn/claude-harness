#!/usr/bin/env node
/**
 * @description Independent post-hoc CAPTURE for a finished cheap-hand child — the GATE OF
 * RECORD in the "strong eyes, cheap hands" model. After the Ollama hand exits, the HARNESS
 * (never the model's prose) builds the child result that feeds the fail-closed `evaluateRun`
 * from `./dispatch-hand.mjs`:
 *
 *   1. PRECONDITION (fail-closed): HEAD must still equal the recorded freeze baseline —
 *      `git.headSha() === freezeCommitSha`. The hand has no git/Bash, so HEAD MUST still be the
 *      freeze-commit; a divergent HEAD means a rogue commit ran and we cannot anchor a diff to
 *      the baseline → abort to a CRITICAL EXCEPTION, NEVER stamping `captured:true`. We do NOT
 *      assert a clean tree here: ensuring a CLEAN baseline BEFORE the hand spawns is the
 *      orchestrator's / spawn-hand's responsibility (the freeze-commit guarantees HEAD is clean
 *      before the hand runs). Post-hoc, the tree is EXPECTED to be dirty — that dirt IS the
 *      hand's work, and capturing it is precisely this function's job.
 *   2. SNAPSHOT touchedPaths = UNION of tracked changes (`git diff --name-only <sha>`) and
 *      untracked files (`git ls-files --others --exclude-standard`). A brand-new untracked
 *      file is real work — it must be captured, not read as an empty diff. The snapshot is
 *      taken BEFORE running the frozen test, which may itself write fixtures. A gitignored
 *      out-of-scope write (which `--exclude-standard` hides) is recovered via a no-exclude
 *      sweep (`git ls-files --others`) and appended when it falls OUTSIDE `scope_paths`, so
 *      `checkScope` in `evaluateRun` flags it instead of letting it escape.
 *   3. RUN the frozen test BY PATH via the injected `testRunner`, parse stdout for `# tests N`.
 *      N === 0 (zero collected tests) is a VACUOUS-GREEN guard: never a pass, even on exit 0 —
 *      it is forced to a non-zero locked-test exit so `evaluateRun` yields FAILED.
 *   4. BUILD the harness-controlled child: `{ captured:true, touchedPaths, lockedTestExitCode,
 *      exitCode, stdout, stderr }`. The model's prose NEVER populates touchedPaths or the
 *      locked-test exit — those come only from the independent git snapshot + frozen-test run.
 *   5. FEED the existing `evaluateRun({ dispatch, child })`.
 *
 * SECURITY (load-bearing): the Ollama auth token leaks NOWHERE. Live tee lines are redacted
 * per-line via `redact` BEFORE reaching the injected `logSink` (not only before disk). On-disk
 * artifacts (result.json + cost NDJSON) are written into an ephemeral mkdtemp dir with
 * `redactDeep` over the result and per-line redaction over the cost stream; the dir is torn
 * down in `finally` unless the caller opts to keep it (still token-free).
 *
 * Every dependency — `git`, `testRunner`, `logSink`, `fs` — is INJECTABLE; the real defaults
 * wrap child_process/fs but are NOT exercised by `node --test` (fakes drive every test).
 */

import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  evaluateRun,
  redact,
  redactDeep,
  truncateUpstreamError,
  checkScope,
  checkFrozen,
  checkAllowedWrites,
  resolveAuthToken,
} from "./dispatch-hand.mjs";

/** @description Forced non-zero locked-test exit for the vacuous-green guard. */
export const VACUOUS_GREEN_EXIT = 1;

/**
 * @description Parses the `# tests N` summary line emitted by `node --test`. Returns the
 * collected test count, or null when the marker is absent (treated as zero downstream).
 * @param {string} stdout
 * @returns {number|null}
 */
export function parseTestsCount(stdout = "") {
  const matches = [...String(stdout).matchAll(/^# tests (\d+)$/gm)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

/**
 * @description Real git adapter (NOT exercised by `node --test`). Each method shells out with
 * an argument array (never string concat) so user/baseline input cannot inject shell.
 * @param {string} cwd
 * @returns {{ headSha: () => string, statusPorcelain: () => string, diffNameOnly: (sha: string) => string[], lsFilesOthers: () => string[], lsFilesAllOthers: () => string[] }}
 */
export function realGit(cwd = process.cwd()) {
  const run = (args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const lines = (out) => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return {
    headSha: () => run(["rev-parse", "HEAD"]).trim(),
    statusPorcelain: () => run(["status", "--porcelain"]),
    diffNameOnly: (sha) => lines(run(["diff", "--name-only", sha])),
    lsFilesOthers: () => lines(run(["ls-files", "--others", "--exclude-standard"])),
    // No `--exclude-standard`: this DOES report gitignored untracked files. Used only to
    // recover an out-of-scope write into a gitignored path (dist/, *.log) that the
    // exclude-standard sweep above would hide, so checkScope can flag it. Tradeoff: this
    // sweep also lists IN-scope gitignored files, so we only append the OUT-OF-scope ones.
    lsFilesAllOthers: () => lines(run(["ls-files", "--others"])),
    // Content hash (git blob sha) for each path, in input order → path→hash map. Used to subtract
    // pre-existing-unchanged untracked files at capture. A missing/removed path is skipped (the
    // whole batch fails closed to an empty map → no subtraction → conservative legacy behavior).
    hashObject: (paths) => {
      const map = new Map();
      if (!paths || paths.length === 0) return map;
      let out;
      try {
        out = run(["hash-object", ...paths]);
      } catch {
        return map; // fail safe: no hashes → nothing subtracted → no false-clean
      }
      const shas = lines(out);
      paths.forEach((p, i) => {
        if (shas[i]) map.set(p, shas[i]);
      });
      return map;
    },
  };
}

/**
 * @description Drops paths that were present pre-spawn with an UNCHANGED content hash (build junk
 * that was already there). Keeps any path NEW since the snapshot, or whose hash CHANGED (a hand
 * mutating a pre-existing untracked file). PURE — `preUntracked`/`currentHashes` are path→hash maps.
 * @param {string[]} paths
 * @param {Map<string,string>} preUntracked - pre-spawn snapshot (path→hash)
 * @param {Map<string,string>} currentHashes - hashes captured now (path→hash)
 * @returns {string[]}
 */
export function subtractUnchanged(paths, preUntracked, currentHashes) {
  if (!preUntracked || preUntracked.size === 0) return paths;
  return paths.filter((p) => {
    const pre = preUntracked.get(p);
    if (pre === undefined) return true; // new since snapshot → keep
    const cur = currentHashes.get(p);
    return cur !== pre; // changed → keep (tamper); unchanged → drop (pre-existing junk)
  });
}

/**
 * @description Real frozen-test runner (NOT exercised by `node --test`): runs the locked test
 * by path via `node --test <path>` and returns its stdout/stderr/exit without throwing.
 * @param {string} testPath
 * @param {string} cwd
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
export function realTestRunner(testPath, cwd = process.cwd()) {
  try {
    const stdout = execFileSync("node", ["--test", testPath], { cwd, encoding: "utf8" });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    return {
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : "",
      exitCode: typeof err.status === "number" ? err.status : 1,
    };
  }
}

/**
 * @description Tees a single child line through the injected sink, redacting the token FIRST
 * so the sink can never receive the raw secret (per-line redact BEFORE the sink).
 * @param {string} line
 * @param {string|undefined} token
 * @param {(line: string) => void} logSink
 */
function teeLine(line, token, logSink) {
  if (!line) return;
  logSink(redact(line, token));
}

/**
 * @description Splits a captured stream into non-empty lines for per-line teeing.
 * @param {string} text
 * @returns {string[]}
 */
function streamLines(text = "") {
  return String(text).split(/\r?\n/).filter((l) => l.length > 0);
}

/**
 * @description Independently captures a finished cheap-hand child into the harness-controlled
 * result and runs it through the fail-closed `evaluateRun`. Prose is NEVER read into
 * touchedPaths/lockedTestExitCode; those come only from the injected git snapshot + frozen-test
 * run. Fails closed to a critical exception on a dirty/divergent baseline (never stamping
 * `captured:true`). All artifacts and tee lines are token-redacted.
 * @param {{
 *   dispatch: object,
 *   child: { exitCode: number, stdout?: string, stderr?: string },
 *   freezeCommitSha: string,
 *   testPath: string,
 *   git: { headSha: () => string, statusPorcelain: () => string, diffNameOnly: (sha: string) => string[], lsFilesOthers: () => string[], lsFilesAllOthers: () => string[] },
 *   testRunner: (testPath: string) => { stdout: string, stderr?: string, exitCode: number },
 *   logSink?: (line: string) => void,
 *   token: string,
 *   costStream?: unknown[],
 *   fs?: { mkdtempSync: Function, writeFileSync: Function, rmSync: Function },
 *   tmpDir?: string,
 *   keepArtifacts?: boolean,
 * }} args
 * @returns {{ criticalException?: true, captured: boolean, reason?: string, child?: object, outcome?: object, artifactDir?: string }}
 */
export function captureResult({
  dispatch,
  child,
  freezeCommitSha,
  testPath,
  git,
  testRunner,
  logSink = () => {},
  token,
  costStream = [],
  fs = { mkdtempSync, writeFileSync, rmSync },
  tmpDir = tmpdir(),
  keepArtifacts = false,
  preUntracked = new Map(),
}) {
  if (token === undefined)
    throw new Error(
      "captureResult requires a resolved auth token; pass readAuthToken(process.env, devVars) — undefined silently disables redaction"
    );

  // (1) Precondition: HEAD MUST still equal the recorded freeze baseline. The hand has no
  // git/Bash, so a divergent HEAD means a rogue commit ran and the diff can no longer be
  // anchored to the baseline → critical exception, and we NEVER stamp captured:true. The tree
  // is EXPECTED to be dirty here (that dirt is the hand's work we are about to capture); a clean
  // baseline BEFORE the spawn is the orchestrator's responsibility, not a post-hoc check.
  const headSha = git.headSha();
  if (headSha !== freezeCommitSha) {
    return {
      criticalException: true,
      captured: false,
      reason: `HEAD ${headSha} diverged from freeze baseline ${freezeCommitSha}`,
    };
  }

  // The gitignore-escape sweep is a load-bearing security control (see below) — it MUST exist.
  if (typeof git.lsFilesAllOthers !== "function")
    throw new Error(
      "git adapter must provide lsFilesAllOthers for the gitignore-escape sweep"
    );

  // (2) Snapshot touchedPaths = union(diff, untracked) BEFORE running the frozen test (the
  // test may write fixtures that would otherwise pollute the snapshot).
  //
  // Pre-existing-untracked subtraction (the "painter's pre-existing mess" fix): build junk ALREADY
  // in the tree before the spawn (dist/, coverage/, *.tsbuildinfo) must not be misattributed to the
  // hand. `preUntracked` is a path→hash snapshot taken pre-spawn. A path is dropped ONLY when it was
  // present pre-spawn AND its content hash is unchanged. A NEW file (absent from the snapshot) or an
  // EDITED pre-existing one (hash differs — a hand mutating a gitignored fixture to fake a green) is
  // KEPT, so the security control keeps full strength. Empty preUntracked (default / standalone CLI)
  // → no subtraction → legacy behavior. Both untracked channels are subtracted; the tracked diff
  // channel is left untouched (the pre-spawn full-tree clean-check guarantees it is all the hand's).
  const diffPaths = git.diffNameOnly(freezeCommitSha) ?? [];
  const rawUntracked = git.lsFilesOthers() ?? [];
  const rawAllOthers = git.lsFilesAllOthers() ?? [];
  const currentHashes =
    preUntracked.size && typeof git.hashObject === "function"
      ? git.hashObject([...new Set([...rawUntracked, ...rawAllOthers])])
      : new Map();
  const untrackedPaths = subtractUnchanged(rawUntracked, preUntracked, currentHashes);
  const touchedPaths = [...new Set([...diffPaths, ...untrackedPaths])];

  // Gitignore restriction-escape sweep: a NEW file written into a gitignored path (dist/, *.log)
  // is invisible to `ls-files --others --exclude-standard`. Recover those via a no-exclude sweep
  // and APPEND any that violate ANY restriction set — out of scope_paths, OR a frozen path, OR
  // outside allowed_writes. Since allowed_writes ⊂ scope_paths and the frozen closure ⊂
  // scope_paths, a gitignored IN-SCOPE write onto a frozen path (or outside allowed_writes) would
  // pass a scope-only filter and escape evaluateRun's checkFrozen/checkAllowedWrites entirely —
  // letting a hand drop a gitignored file onto a frozen path to pass the frozen test vacuously.
  // The union makes every such violation visible to evaluateRun.
  const allOthers = subtractUnchanged(rawAllOthers, preUntracked, currentHashes);
  const flagged = new Set([
    ...checkScope(allOthers, dispatch.scope_paths ?? []),
    ...checkFrozen(allOthers, dispatch.frozen_paths ?? []),
    ...checkAllowedWrites(allOthers, dispatch.allowed_writes ?? []),
  ]);
  for (const p of flagged) {
    if (!touchedPaths.includes(p)) touchedPaths.push(p);
  }

  // Live tee: redact each child line BEFORE the sink.
  for (const line of streamLines(child.stdout)) teeLine(line, token, logSink);
  for (const line of streamLines(child.stderr)) teeLine(line, token, logSink);

  // (3) Run the frozen test by path; parse `# tests N`. N === 0 → vacuous-green → forced FAILED.
  const runner = testRunner(testPath);
  const testsCount = parseTestsCount(runner.stdout);
  const lockedTestExitCode =
    testsCount === null || testsCount === 0 ? VACUOUS_GREEN_EXIT : runner.exitCode;

  // (4) Build the harness-controlled child — prose NEVER feeds touchedPaths/lockedTestExitCode.
  const built = {
    captured: true,
    touchedPaths,
    lockedTestExitCode,
    exitCode: child.exitCode,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    testsCount: testsCount ?? 0,
  };

  // (5) Feed the existing fail-closed judge.
  const outcome = evaluateRun({ dispatch, child: built });

  // On-disk artifacts: ephemeral mkdtemp; redactDeep the result, per-line redact the cost
  // stream. Tear down in finally unless the caller keeps it (still token-free).
  // The persisted child copy applies truncateUpstreamError (AFTER redact) to stderr/stdout so a
  // large upstream body cannot survive in the on-disk artifact; the FULL streams remain in `built`
  // for evaluateRun's benign-404 / hasNonBenignUpstreamError checks above.
  const dir = fs.mkdtempSync(join(tmpDir, "capture-hand-"));
  try {
    const persistedChild = {
      ...built,
      stdout: truncateUpstreamError(redact(built.stdout, token)),
      stderr: truncateUpstreamError(redact(built.stderr, token)),
    };
    const safeResult = redactDeep({ dispatch, child: persistedChild, outcome }, token);
    fs.writeFileSync(join(dir, "result.json"), JSON.stringify(safeResult, null, 2));

    const costNdjson = (costStream ?? [])
      .map((entry) => redact(JSON.stringify(redactDeep(entry, token)), token))
      .join("\n");
    fs.writeFileSync(join(dir, "cost.ndjson"), costNdjson);

    return {
      captured: true,
      child: built,
      outcome,
      artifactDir: keepArtifacts ? dir : undefined,
    };
  } finally {
    if (!keepArtifacts) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- thin CLI ----------

if (import.meta.url === `file://${process.argv[1]}`) {
  // The live wiring (real spawn → real capture) runs in the consumer project, not under
  // `node --test`. The CLI reads a dispatch + finished-child JSON and prints the captured
  // outcome; git/testRunner default to the real adapters above.
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) args[argv[i]?.slice(2)] = argv[i + 1];

  if (!args.dispatch || !args.child || !args.freeze || !args.test) {
    process.stderr.write(
      "[capture-hand] --dispatch <d.json> --child <c.json> --freeze <sha> --test <path> required\n"
    );
    process.exit(1);
  }

  // Resolve the Ollama auth token across env → cwd/.dev.vars → ~/.claude/.dev.vars (global).
  // WITHOUT a resolved token, the live tee + on-disk artifacts run redact(text, undefined)
  // — a silent no-op — and any echoed bearer leaks raw to disk/stderr.
  const token = resolveAuthToken(process.env);

  const dispatch = JSON.parse(readFileSync(args.dispatch, "utf8"));
  const child = JSON.parse(readFileSync(args.child, "utf8"));
  const result = captureResult({
    dispatch,
    child,
    freezeCommitSha: args.freeze,
    testPath: args.test,
    git: realGit(),
    testRunner: (p) => realTestRunner(p),
    logSink: (line) => process.stderr.write(`${line}\n`),
    token,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.criticalException || result.outcome?.status !== "DONE" ? 1 : 0);
}
