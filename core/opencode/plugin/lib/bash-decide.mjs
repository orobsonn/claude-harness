/**
 * @description Pure OC bash gates: delivery ceremony + rails + gate-state anti-forgery.
 * Never throws; returns Decision. D1 single fall-through — no early allow after delivery detect.
 */

import { isDeliveryCommand } from "./is-delivery-command.mjs";
import { isSafeSessionIdSegment } from "./dual-enforcement.mjs";
import { matchesAbsolution } from "../../../shared/lib/absolution.mjs";
import { fidelityPassEntry } from "./mark-gate.mjs";
import {
  classifyRegatePending,
  corruptRegatePendingReason,
} from "../../../shared/lib/regate-classify.mjs";
import { checkRealFileCaptureRail } from "../../../shared/lib/real-file-capture-rail.mjs";

/**
 * @typedef {{ ok: boolean, decision: "allow"|"deny", reason: string, details?: unknown }} Decision
 */

/** Bash forge allowlist: basename of marker scripts only (must also pass path bind). */
const FORGE_ALLOWLIST = new Set(["classify", "mark", "mark-gate"]);

/**
 * Marker scripts trusted ONLY as exact relative paths from project root (not suffix match).
 * Absolute / evil/.opencode/... impostors never match.
 */
const HARNESS_MARKER_RELATIVE = new Set([
  ".opencode/plugin/lib/mark-gate.mjs",
  "core/opencode/plugin/lib/mark-gate.mjs",
]);

/**
 * CC-only marker CLIs — under OC they print JSON but NEVER write `.opencode` gate-state
 * (no stamp-triage PostToolUse). Allowlisting them caused silent ceremony miss (#291).
 */
const CC_MARKER_PATH_RE =
  /(?:^|[\s"'=])(?:\.\/)?(?:\.claude\/hooks\/|core\/claude-code\/hooks\/)(?:mark-gate|mark|classify)\.mjs\b/;

/** Native marker authority is host-loaded only; Bash may not execute or import it. */
const NATIVE_MARK_AUTHORITY_RE =
  /(?:^|[\s"'=])(?:\.\/)?(?:\.opencode\/plugin\/marker-authority\.ts|core\/opencode\/plugin\/marker-authority\.ts|\.opencode\/tools\/mark\.ts|core\/opencode\/tools\/mark\.ts|\.opencode\/plugin\/lib\/marker-capability\.mjs|core\/opencode\/plugin\/lib\/marker-capability\.mjs|\.opencode\/tools\/lib\/mark-native\.mjs|core\/opencode\/tools\/lib\/mark-native\.mjs)\b/;

// State oracles only — execution-plan.json is intentionally NOT forge-blocked so
// build/orchestrator may materialize the plan via bash (edit is denied on build).
const ORACLE_PATH_RE =
  /\.(?:opencode|claude)\/plans\/\.state\b|gate-state\.json\b|triage\.json\b/;

/** Drop-dir script runners — common impostor home for forged markers. */
const TMP_SCRIPT_RE =
  /\b(?:node(?:js)?|python3?|bun|deno)\s+(?:["']?)(?:\/tmp\/|\/var\/tmp\/|\.\/tmp\/)/i;

/** Shell basenames that support -c / --command (token-scanned in isShellCCommand). */
const SHELL_BINARIES = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "fish",
  "csh",
  "tcsh",
]);

/**
 * Exact relative tooling scripts allowed beyond markers/tests (orchestrator ops).
 * Keep short — every entry is a trusted executable surface.
 */
const ALLOWED_TOOLING_SCRIPTS = new Set([
  "scripts/probe-oc-gates-headless.mjs",
  "core/claude-code/skills/initializing-projects/references/vendor-core.mjs",
]);

/** Paths that must not be bash-written (cp/mv/tee/sed targets) — same freeze as plan-write. */
const FROZEN_BASH_PATH_RES = [
  /(?:^|[\s"'=])(?:\.\/)?(?:core\/opencode\/plugin\/lib\/|\.opencode\/plugin\/lib\/)mark-gate\.mjs\b/,
  /(?:^|[\s"'=])(?:\.\/)?scripts\/probe-oc-gates-headless\.mjs\b/,
  /(?:^|[\s"'=])(?:\.\/)?core\/claude-code\/skills\/initializing-projects\/references\/vendor-core\.mjs\b/,
];

/** Test files only under these roots (no cwd-drop evil.test.mjs). */
const TEST_ROOT_RE = /^(core|modules|\.opencode)\//;

/**
 * @param {unknown} mode
 * @returns {"QUICK"|"LIGHT"|"FULL"|"NO-CEREMONY"|""}
 */
/**
 * @description True when gate-state shows the session already entered LIGHT/FULL ceremony
 * or planner/review work — used to block QUICK ship laundering after a stuck LIGHT run.
 * @param {Record<string, unknown>} gs
 * @returns {boolean}
 */
export function hasElevatedCeremonyResidue(gs = {}) {
  if (!gs || typeof gs !== "object" || Array.isArray(gs)) return false;
  const peak = normalizeMode(gs.peak_mode);
  if (peak === "LIGHT" || peak === "FULL") return true;
  if (gs.brainstormed === true || gs.adversary_fired === true) return true;
  const plannerStatus = typeof gs.planner_status === "string" ? gs.planner_status : "";
  if (plannerStatus && plannerStatus !== "not_started") return true;
  const attempts = Number(gs.planner_primary_attempts);
  if (Number.isFinite(attempts) && attempts > 0) return true;
  if (
    gs.review_status === "primary_failure_cap_reached" ||
    gs.review_status === "review_cap_reached"
  ) {
    return true;
  }
  const dual = gs.dual_status;
  if (dual && typeof dual === "object" && !Array.isArray(dual)) {
    if (dual.plan_review || dual.adversary) return true;
  }
  if (Array.isArray(gs.review_outcomes) && gs.review_outcomes.length > 0) return true;
  return false;
}

export function normalizeMode(mode) {
  if (typeof mode !== "string") return "";
  const m = mode.trim().toLowerCase();
  if (m === "quick") return "QUICK";
  if (m === "light") return "LIGHT";
  if (m === "full") return "FULL";
  if (m === "no-ceremony") return "NO-CEREMONY";
  return "";
}

/**
 * @description True when a dual_status value (scalar enum or plan_review axis of a map)
 * is a recorded attempt. Legacy scalar and map forms both accepted.
 * @param {unknown} dualStatus
 * @returns {boolean}
 */
export function isRecordedDual(dualStatus) {
  const status =
    typeof dualStatus === "string"
      ? dualStatus
      : dualStatus != null && typeof dualStatus === "object" && !Array.isArray(dualStatus)
        ? /** @type {Record<string, unknown>} */ (dualStatus).plan_review
        : undefined;
  return (
    status === "both" ||
    status === "primary_only" ||
    status === "primary_only_failopen" ||
    status === "primary_only_error"
  );
}

/**
 * @description Strip env/VAR= wrappers so `env node` / `FOO=1 node` still gate.
 * Does NOT strip `env -i …` / complex env options — residual `env` is fail-closed.
 * @param {string} command
 * @returns {string}
 */
export function stripCommandWrappers(command) {
  if (typeof command !== "string") return "";
  let c = command.trim();
  for (let n = 0; n < 16; n += 1) {
    if (/^env\s+/i.test(c)) {
      const rest = c.replace(/^env\s+/i, "").trim();
      // Complex env (`env -i …`, `env -u FOO …`) — leave `env` for fail-closed deny.
      if (/^-/.test(rest)) break;
      c = rest;
      continue;
    }
    // NODE_OPTIONS=... or OTHER=val prefix
    if (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(c)) {
      c = c.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "").trim();
      continue;
    }
    break;
  }
  return c;
}

/**
 * @description Residual `env` after strip = options/flags remain (fail-closed).
 * @param {unknown} command
 * @returns {boolean}
 */
export function isComplexEnvCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const c = stripCommandWrappers(command);
  return /^env(?:\s|$)/i.test(c);
}

/**
 * @description Script path token for node/bare invocation (empty for eval one-liners).
 * @param {string} command
 * @returns {string}
 */
export function extractNodeScriptPath(command) {
  if (typeof command !== "string") return "";
  const tokens = stripCommandWrappers(command).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  // Find interpreter basename anywhere (prefix wrappers: time/command/nice/…).
  let i = 0;
  for (; i < tokens.length; i += 1) {
    const rawBase = tokens[i].split(/[/\\]/).pop() ?? tokens[i];
    const base = unquoteToken(rawBase);
    if (isInterpreterHead(base)) break;
  }
  if (i >= tokens.length) {
    // No interpreter — bare path / binary form (./script.mjs, ls, …).
    return tokens[0] ?? "";
  }
  const headTok = tokens[i] ?? "";
  const headBase = unquoteToken(headTok.split(/[/\\]/).pop() ?? headTok);
  const isNode = headBase === "node" || headBase === "nodejs";
  if (isNode) {
    i += 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      const flag = tokens[i];
      if (
        flag === "-e" ||
        flag === "-p" ||
        flag === "--eval" ||
        flag === "--print" ||
        flag.startsWith("--eval=") ||
        flag.startsWith("--print=")
      ) {
        return "";
      }
      // flags that take a value: --require x, -r x, --import x
      if (
        flag === "-r" ||
        flag === "--require" ||
        flag === "--import" ||
        flag === "--loader" ||
        flag === "--experimental-loader" ||
        flag === "--test-name-pattern" ||
        flag === "--test-reporter"
      ) {
        i += 2;
        continue;
      }
      i += 1;
    }
    return tokens[i] ?? "";
  }
  // python/others: first non-flag after interpreter
  i += 1;
  while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
  return tokens[i] ?? "";
}

/**
 * @description Extract basename of first meaningful argv (node script or binary).
 * @param {string} command
 * @returns {string}
 */
export function firstArgvBasename(command) {
  if (typeof command !== "string") return "";
  const raw = extractNodeScriptPath(command);
  if (!raw) return "";
  const base = raw.split(/[/\\]/).pop() ?? "";
  return base.replace(/\.mjs$/i, "").replace(/\.ts$/i, "").replace(/\.js$/i, "");
}

/**
 * @description Normalize script path for marker bind (strip ./, unify slashes).
 * @param {string} script
 * @returns {string}
 */
function normalizeScriptPath(script) {
  let norm = script.replace(/\\/g, "/").trim();
  while (norm.startsWith("./")) norm = norm.slice(2);
  return norm;
}

/**
 * @description True when command invokes a harness marker at an exact relative path.
 * Suffix impostors (evil/.opencode/plugin/lib/mark-gate.mjs) and absolute paths fail.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isHarnessMarkerScript(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const script = extractNodeScriptPath(command);
  if (!script) return false;
  const norm = normalizeScriptPath(script);
  if (norm.startsWith("/") || norm.includes("/tmp/") || norm.includes("/var/tmp/")) {
    return false;
  }
  return HARNESS_MARKER_RELATIVE.has(norm);
}

/**
 * @description Interpreter eval one-liner — flags may appear after other node flags.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isEvalOneLiner(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const c = stripCommandWrappers(command);
  // node … -e / -p / --eval / --print (flags anywhere after node)
  if (/\bnode(?:js)?\b/i.test(c)) {
    if (/(?:^|\s)-(?:[ep])(?:\s|=|$)/i.test(c)) return true;
    if (/(?:^|\s)--eval(?:\s|=|$)/i.test(c)) return true;
    if (/(?:^|\s)--print(?:\s|=|$)/i.test(c)) return true;
  }
  if (/\bbun\s+-e\b/i.test(c)) return true;
  if (/\bdeno\s+eval\b/i.test(c)) return true;
  if (/\bpython3?\s+-c\b/i.test(c)) return true;
  if (/\bperl\s+-e\b/i.test(c)) return true;
  if (/\bruby\s+-e\b/i.test(c)) return true;
  if (/\bphp\s+-r\b/i.test(c)) return true;
  return false;
}

/**
 * @description node/python/bun/deno running a script from /tmp (impostor drop).
 * @param {unknown} command
 * @returns {boolean}
 */
export function isTmpScriptRunner(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  if (TMP_SCRIPT_RE.test(command)) return true;
  const script = extractNodeScriptPath(command);
  if (!script) return false;
  const norm = script.replace(/\\/g, "/");
  return (
    norm.startsWith("/tmp/") ||
    norm.startsWith("/var/tmp/") ||
    norm.startsWith("./tmp/") ||
    norm.includes("/tmp/") ||
    norm.includes("/var/tmp/")
  );
}

/** Shell options that consume the next argv token as a value. */
const SHELL_VALUE_OPTS = new Set(["-o", "-O", "--rcfile", "--init-file"]);

/**
 * @description bash/sh -c (encoded oracle write hides from substring wall).
 * Token-scan any shell basename in argv (not only argv0) so prefixes like
 * `time bash -c` / `command bash --noprofile -c` still deny. Skips value-taking
 * options (`-o`, `--rcfile`, `--init-file`, `-O`) so `bash -o pipefail -c` denies.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isShellCCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const c = stripCommandWrappers(command);
  const tokens = c.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // Find first shell binary anywhere in argv (prefix wrappers: time/command/nice/…).
  let shellIdx = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const base = (tokens[i].split(/[/\\]/).pop() ?? tokens[i]).toLowerCase();
    if (SHELL_BINARIES.has(base)) {
      shellIdx = i;
      break;
    }
  }
  if (shellIdx < 0) return false;
  for (let i = shellIdx + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "-c" || t === "--command" || t === "-lc") return true;
    // Combined short options containing c: -xc, -ec, …
    if (!t.startsWith("--") && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) return true;
    // Value-taking options: skip the next token (option value).
    if (SHELL_VALUE_OPTS.has(t)) {
      i += 1;
      continue;
    }
    // Non-option before -c → script-file form (handled by isShellScriptOrPipeToShell).
    if (!t.startsWith("-")) return false;
  }
  return false;
}

/**
 * @description Head token is a script interpreter we gate.
 * @param {string} head
 * @returns {boolean}
 */
function isInterpreterHead(head) {
  if (typeof head !== "string" || !head) return false;
  const base = head.split(/[/\\]/).pop() ?? "";
  return (
    base === "node" ||
    base === "nodejs" ||
    base === "python" ||
    base === "python3" ||
    base === "bun" ||
    base === "deno" ||
    base === "perl" ||
    base === "ruby" ||
    base === "php"
  );
}

/**
 * @description Strip one layer of surrounding " or ' from a token (shell-quoted argv).
 * @param {string} t
 * @returns {string}
 */
function unquoteToken(t) {
  if (typeof t !== "string" || t.length < 2) return t;
  const q = t[0];
  if ((q === '"' || q === "'") && t[t.length - 1] === q) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * @description Authorized test file path: under core|modules|.opencode + *.test.*
 * Rejects `..` and empty segments (//) so core/../evil.test.mjs cannot pass.
 * @param {string} norm
 * @returns {boolean}
 */
export function isAuthorizedTestPath(norm) {
  if (typeof norm !== "string" || !norm) return false;
  if (!/\.test\.(mjs|js|cjs|mts|cts)$/i.test(norm)) return false;
  if (!norm.includes("/")) return false;
  const segments = norm.split("/");
  if (segments.some((s) => s === ".." || s === "")) return false;
  return TEST_ROOT_RE.test(norm);
}

/**
 * @description True when node --test with ≥1 authorized test file arg.
 * Empty file list (cwd discovery) is NOT authorized — require explicit paths.
 * @param {string} command
 * @returns {boolean}
 */
export function isNodeTestRunner(command) {
  if (typeof command !== "string") return false;
  const c = stripCommandWrappers(command);
  if (!/\bnode(?:js)?\b/i.test(c) || !/(?:^|\s)--test(?:\s|$)/.test(c)) {
    return false;
  }
  // Fail-closed: --test-reporter loads an arbitrary reporter module (path or package).
  if (/(?:^|\s)--test-reporter(?:\s|=|$)/.test(c)) {
    return false;
  }
  const tokens = c.trim().split(/\s+/).filter(Boolean);
  // Start after first node/nodejs basename (prefix wrappers: time/command/…).
  let start = 0;
  for (; start < tokens.length; start += 1) {
    const rawBase = tokens[start].split(/[/\\]/).pop() ?? tokens[start];
    const base = unquoteToken(rawBase);
    if (base === "node" || base === "nodejs") break;
  }
  if (start >= tokens.length) return false;
  const files = [];
  for (let i = start + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      if (
        t === "--test-name-pattern" ||
        t === "-r" ||
        t === "--require" ||
        t === "--import" ||
        t === "--test-reporter"
      ) {
        i += 1;
      }
      continue;
    }
    files.push(normalizeScriptPath(t));
  }
  // Require ≥1 authorized test path — bare `node --test` (cwd discovery) is deny.
  if (files.length === 0) return false;
  return files.every((f) => isAuthorizedTestPath(f));
}

/**
 * @description Unauthorized interpreter script run (two-step forge wall).
 * Allows: exact markers, authorized *.test.* under core|modules|.opencode,
 * node --test (authorized files only), tooling allowlist.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isUnauthorizedInterpreter(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const c = stripCommandWrappers(command);
  const tokens = c.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // Find first interpreter basename anywhere (prefix wrappers: time/command/nice/…).
  let interpIdx = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const rawBase = tokens[i].split(/[/\\]/).pop() ?? tokens[i];
    const base = unquoteToken(rawBase);
    if (isInterpreterHead(base)) {
      interpIdx = i;
      break;
    }
  }
  if (interpIdx < 0) return false;
  // Slice from interpreter so extract/marker/--test checks see argv0=node|python|…
  const fromInterp = tokens.slice(interpIdx).join(" ");
  // Chain/subshell turns an authorized interpreter into a multi-command forge.
  if (hasShellChainMetacharacters(c) || hasShellChainMetacharacters(command)) {
    return true;
  }
  if (isHarnessMarkerScript(fromInterp)) return false;
  if (isNodeTestRunner(fromInterp)) return false;
  // node --test present but not authorized (empty files / bad paths) → unauthorized.
  // Bare `node --test` has no script path so the extract path below would miss it.
  if (
    /\bnode(?:js)?\b/i.test(fromInterp) &&
    /(?:^|\s)--test(?:\s|$)/.test(fromInterp)
  ) {
    return true;
  }
  const script = extractNodeScriptPath(fromInterp);
  if (!script) return false;
  const norm = normalizeScriptPath(script);
  if (!norm || norm.startsWith("-")) return false;
  if (isAuthorizedTestPath(norm)) return false;
  if (ALLOWED_TOOLING_SCRIPTS.has(norm)) return false;
  return true;
}

/**
 * @description node --require / -r / --import / --loader preload side-effect forge.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isNodePreload(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  // NODE_OPTIONS=--require=... / --test-reporter=... before strip loses the payload.
  if (
    /(?:^|\s)NODE_OPTIONS=(?:["']?)[^'"\n]*(?:--require|-r\b|--import|--loader|--eval|--test-reporter|(?:^|[=\s])-[ep](?:\s|=|$))/i.test(
      command,
    )
  ) {
    return true;
  }
  const c = stripCommandWrappers(command);
  if (!/\bnode(?:js)?\b/i.test(c) && !/\bnode(?:js)?\b/i.test(command)) {
    // still check flag forms on full string
  }
  const scan = `${command}\n${c}`;
  if (/(?:^|\s)(?:-r|--require)(?:\s|=|$)/.test(scan)) return true;
  if (/(?:^|\s)--import(?:\s|=|$)/.test(scan)) return true;
  if (/(?:^|\s)--loader(?:\s|=|$)/.test(scan)) return true;
  if (/(?:^|\s)--experimental-loader(?:\s|=|$)/.test(scan)) return true;
  // --test-reporter loads an arbitrary reporter module (CLI or NODE_OPTIONS residual).
  if (/(?:^|\s)--test-reporter(?:\s|=|$)/.test(scan)) return true;
  return false;
}

/**
 * @description Direct ./script.mjs or script.py exec (no interpreter head).
 * @param {unknown} command
 * @returns {boolean}
 */
export function isDirectScriptExec(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const c = stripCommandWrappers(command);
  const head = c.split(/\s+/)[0] ?? "";
  if (!head || isInterpreterHead(head)) return false;
  if (isHarnessMarkerScript(c)) return false;
  return /\.(mjs|cjs|js|mts|cts|py|rb|pl|php)$/i.test(head);
}

/**
 * @description Pipe into a shell or `bash file.sh` (script-file two-step).
 * @param {unknown} command
 * @returns {boolean}
 */
export function isShellScriptOrPipeToShell(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const c = stripCommandWrappers(command);
  if (/\|\s*(?:bash|sh|zsh|dash|ash|fish|ksh)\b/i.test(c)) return true;
  // bash|sh path/to/script.sh (not -c which is isShellCCommand)
  if (
    /\b(?:bash|sh|zsh|dash|ash|fish|ksh)\s+(?!-[a-zA-Z]*c\b)(?:["']?)(?:\.\/)?[\w./-]+\.(?:sh|bash|zsh)\b/i.test(
      c,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * @description Redirect/write + shell expansion that can hide a gate-state oracle in $VAR.
 * Not a blanket ban on `$` near redirects — that false-denied plan/spec writes (#72):
 * - Quoted heredoc bodies (`<<'EOF'`) are stripped first (literal `$` in markdown OK).
 * - `$SPEC_DIR/spec.md` style plan-artifact writes (no `.state`) are allowed.
 * - Still denied: opaque `> $GS`, any expansion touching `.state` / gate-state.json,
 *   unquoted heredoc with `$`, and other expansion+write outside plan artifacts.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isExpandingRedirect(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const { surface, unquotedBodyHasExpand } = analyzeHeredocBodies(command);
  // Unquoted heredoc body with $ / ` runs at shell time (incl. $(forge)) — deny
  if (unquotedBodyHasExpand) return true;
  const hasExpand = /\$|`/.test(surface);
  if (!hasExpand) return false;
  const writeLike =
    hasShellRedirectOperators(surface) ||
    /\b(?:cp|mv|ln|rsync|dd|install|tee|sed)\b/.test(surface);
  if (!writeLike) return false;
  // Expansion + state oracle in the same shell surface → forge
  if (ORACLE_PATH_RE.test(surface)) return true;
  // Opaque write target is only a variable (echo x > $GS / tee $GS)
  if (/(?:>>|>>|>)\s*["']?\$[A-Za-z_][A-Za-z0-9_]*["']?(?:\s|$|;|&|\|)/.test(surface)) {
    return true;
  }
  if (
    /\b(?:cp|mv|tee)\b[^;|&\n]*\s["']?\$[A-Za-z_][A-Za-z0-9_]*["']?\s*(?:$|;|&|\|)/.test(
      surface,
    )
  ) {
    return true;
  }
  // Plan/ceremony artifacts (not .state) may use $DIR composition — not gate forge
  if (
    /(?:^|[\s"'=])(?:\.\/)?\.opencode\/plans\/(?!\.state)/.test(surface) ||
    /(?:execution-plan\.json|spec\.md|shared_context\.md|decision-ledger\.md)\b/.test(
      surface,
    )
  ) {
    return false;
  }
  // Default: expansion + write outside known plan artifacts stays denied
  return true;
}/**
 * @description tar/git apply unpack without path review (payload may land under .state).
 * @param {unknown} command
 * @returns {boolean}
 */
export function isArchiveUnpack(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const c = stripCommandWrappers(command);
  if (/\btar\b/.test(c)) {
    // extract forms: -x, xf, --extract, -xzf, etc.
    if (/(?:^|\s)(?:--extract\b|-x\b|-[a-zA-Z]*x[a-zA-Z]*\b|xf\b|xvf\b|xzf\b)/.test(c)) {
      return true;
    }
  }
  if (/\bgit\s+apply\b/.test(c)) return true;
  if (/\b(?:unzip|gunzip|bunzip2|7z|7za|cpio|gzip|xz|zstd)\b/.test(c)) {
    // gzip -d / xz -d / zstd -d are decompress
    if (/\b(?:unzip|gunzip|bunzip2|7z|7za|cpio)\b/.test(c)) return true;
    if (/\b(?:gzip|xz|zstd)\b/.test(c) && /(?:^|\s)-(?:[a-zA-Z]*d|[a-zA-Z]*d[a-zA-Z]*)/.test(c)) {
      return true;
    }
  }
  return false;
}

/**
 * @description bash writing/overwriting frozen marker/tooling paths (cp/mv/tee/sed).
 * Pure `node <marker>` runs are allowed (isHarnessMarkerScript).
 * @param {unknown} command
 * @returns {boolean}
 */
export function isFrozenPathBashWrite(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const c = stripCommandWrappers(command);
  if (!FROZEN_BASH_PATH_RES.some((re) => re.test(c))) return false;
  // Legitimate marker/tooling *execution* only
  if (isHarnessMarkerScript(c)) return false;
  const script = extractNodeScriptPath(c);
  if (script && ALLOWED_TOOLING_SCRIPTS.has(normalizeScriptPath(script))) {
    // node tooling.mjs … without write ops
    if (
      !hasShellRedirectOperators(c) &&
      !hasShellChainMetacharacters(c) &&
      !/\b(?:cp|mv|ln|rsync|dd|install|tee|sed|perl|ruby)\b/.test(c)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * @description source / . / bash < file indirection.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isShellSourceOrStdin(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const surface = stripQuotedSpans(stripQuotedHeredocBodies(stripCommandWrappers(command)));
  // `source`/`. ` only execute at a COMMAND position — the command word of a simple command, not an
  // argument slot. A `.` or `source` as an argument (`find . -name`, `--target . --runtime`, `mv
  // source dst`, the word "source" in quoted spec prose) is not a builtin invocation and must not be
  // denied. Command position = start, after a separator (; && || | & ( { newline), or after a run of
  // transparent prefix words/keywords (`eval`/`time`/`command`/`then`/`do`/… source x) — bash treats
  // those as prefixing the command word, so they must not be an escape hatch.
  if (new RegExp(`(?:^|[\\n;&|(){}])\\s*${SHELL_COMMAND_PREFIX}(?:source|\\.)\\s`).test(surface)) {
    return true;
  }
  if (/\b(?:bash|sh|zsh|dash|ash)\s+</.test(surface)) return true;
  return false;
}

/**
 * @description Transparent prefix words that keep the following token in command position (bash
 * reserved words + prefix/dispatch builtins). `eval source x` / `time source x` / `! source x` /
 * `then source x` all still run `source`, so the anchor must see through them. A few entries
 * (`nohup`/`nice`/`setsid`/`stdbuf`/`sudo`) exec an EXTERNAL program and cannot actually reach a
 * builtin — including them is harmless over-inclusion (widens DENY, never adds a false positive).
 *
 * KNOWN-ACCEPTED gaps (defense-in-depth, not a sound wall — a determined local actor is never walled
 * out by a regex): a flag between the prefix and the token (`time -p source x`, `command -p source x`)
 * breaks the contiguous match, and quoted/escaped/expanded command words (`'source' x`, `\source x`,
 * `source$IFS x`, `eval -- source x`) run the builtin without matching. These are the same class as
 * the obfuscations noted on `stripQuotedSpans`; the layered forge checks are the real defense.
 */
const SHELL_COMMAND_PREFIX =
  "(?:(?:!|coproc|time|command|builtin|exec|eval|nohup|nice|setsid|stdbuf|sudo|then|do|else|elif)\\s+)*";

/**
 * @description Blank single/double-quoted span CONTENT (and delimiters) so quoted prose — e.g. a
 * spec written via `printf '… product source code …' > spec.md` — is not scanned as shell syntax.
 * Bash single quotes are fully literal; double quotes honor `\"`.
 *
 * This is defense-in-depth, NOT a sound wall: bash still runs the builtin when the command WORD is
 * quoted/escaped (`'source' x`, `\source x`, `source$IFS x`), and those obfuscations are not caught
 * here (nor were they before). The goal is only to stop legitimate quoted PROSE from tripping the
 * command-position scan; genuine indirection defense relies on the layered forge checks together.
 * @param {string} command
 * @returns {string}
 */
function stripQuotedSpans(command) {
  let out = "";
  let quote = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        out += "  ";
        i += 1;
        continue;
      }
      out += ch === quote ? ((quote = ""), " ") : " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * @description Drop quoted-heredoc payload lines (`<<'EOF'` / `<<"EOF"`) so prose is not
 * mistaken for shell (`source`, `. file`). Unquoted bodies stay (still expand at runtime).
 * @param {string} command
 * @returns {string}
 */
function stripQuotedHeredocBodies(command) {
  return analyzeHeredocBodies(command).quotedStrippedSurface;
}

/**
 * @description Heredoc analysis for expansion checks.
 * - Bodies (quoted + unquoted) removed from `surface` so path/`$VAR` scan is shell-only.
 * - `unquotedBodyHasExpand` true when an unquoted body contains `$` / backticks (runtime expand /
 *   command-substitution risk — must stay denied).
 * @param {string} command
 * @returns {{ surface: string, quotedStrippedSurface: string, unquotedBodyHasExpand: boolean }}
 */
function analyzeHeredocBodies(command) {
  const lines = String(command).split("\n");
  const allStripped = [];
  const quotedOnlyStripped = [];
  let delimiter = "";
  let stripTabs = false;
  let quoted = false;
  let unquotedBodyHasExpand = false;
  for (const line of lines) {
    if (delimiter) {
      const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === delimiter) {
        delimiter = "";
        stripTabs = false;
        quoted = false;
        continue;
      }
      if (!quoted && /\$|`/.test(line)) unquotedBodyHasExpand = true;
      // unquoted body lines remain in quotedOnlyStripped (legacy source scanner)
      if (!quoted) quotedOnlyStripped.push(line);
      continue;
    }
    allStripped.push(line);
    quotedOnlyStripped.push(line);
    const match = line.match(
      /<<(\-?)\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/,
    );
    if (match) {
      delimiter = match[2] || match[3] || match[4];
      stripTabs = match[1] === "-";
      quoted = !!(match[2] || match[3]);
    }
  }
  return {
    surface: allStripped.join("\n"),
    quotedStrippedSurface: quotedOnlyStripped.join("\n"),
    unquotedBodyHasExpand,
  };
}
/** Lifecycle subcommands that execute package.json scripts (not install/ci). */
const NPM_LIFECYCLE = new Set([
  "test",
  "start",
  "stop",
  "restart",
  "exec",
  "explore",
  "run",
  "run-script",
  "x",
]);
const YARN_LIFECYCLE = new Set(["test", "start", "run", "dlx", "node", "exec"]);
const PNPM_LIFECYCLE = new Set(["test", "start", "exec", "run", "dlx", "node"]);

/** Package-manager basenames scanned anywhere in argv (prefix wrappers). */
const PACKAGE_MANAGER_BINARIES = new Set(["npm", "yarn", "pnpm"]);

/**
 * @description npm/yarn/pnpm script lifecycle + make/npx/bunx (package.json indirection).
 * Token-scans package-manager basenames anywhere (not only argv0) so prefixes like
 * `time npm run evil` / `corepack npm test` still deny. Detects lifecycle even with
 * global flags between binary and subcommand (`npm --prefix /tmp/evil test`).
 * install/ci are NOT package-runners. bunx / yarn dlx / pnpm dlx always deny.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isPackageRunner(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const c = stripCommandWrappers(command);
  if (/\bmake\b/.test(c)) return true;
  if (/\bnpx\b/.test(c)) return true;
  // bunx / pnpx are always package-runners (no prescribed form).
  if (/\bbunx\b/.test(c)) return true;
  if (/\bpnpx\b/.test(c)) return true;
  const tokens = c.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // Find first package-manager basename anywhere (prefix: time/command/nice/nohup/corepack).
  let pmIdx = -1;
  let lifecycle = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const rawBase = tokens[i].split(/[/\\]/).pop() ?? tokens[i];
    const base = unquoteToken(rawBase);
    if (!PACKAGE_MANAGER_BINARIES.has(base)) continue;
    if (base === "npm") lifecycle = NPM_LIFECYCLE;
    else if (base === "yarn") lifecycle = YARN_LIFECYCLE;
    else if (base === "pnpm") lifecycle = PNPM_LIFECYCLE;
    pmIdx = i;
    break;
  }
  if (pmIdx < 0 || !lifecycle) return false;
  // Any later token matching lifecycle (flags may intervene; strip shell quotes).
  for (let i = pmIdx + 1; i < tokens.length; i += 1) {
    if (lifecycle.has(unquoteToken(tokens[i]))) return true;
  }
  return false;
}

/**
 * @description Shell chain / substitution metacharacters that turn an allowlisted
 * basename into a multi-command forge (e.g. mark-gate ; cat > .state/...).
 * @param {string} command
 * @returns {boolean}
 */
export function hasShellChainMetacharacters(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  return (
    command.includes(";") ||
    command.includes("&&") ||
    command.includes("||") ||
    command.includes("|") ||
    command.includes("\n") ||
    command.includes("$(") ||
    command.includes("`") ||
    command.includes("&")
  );
}

/**
 * @description Shell redirects that can forge oracle paths even with an
 * allowlisted basename (e.g. mark-gate ... > .opencode/plans/.state/...).
 * Covers `>`, `>>`, and `<` (symmetry).
 * @param {string} command
 * @returns {boolean}
 */
export function hasShellRedirectOperators(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  return command.includes(">") || command.includes("<");
}

/** Closed override flags for package managers (deny even on prescribed base). */
const NPM_OVERRIDE_FLAGS = [
  "--prefix",
  "-C",
  "--userconfig",
  "--globalconfig",
  "--workspace",
  "-w",
  "--workspaces",
  "--script-shell",
  "--node-options",
  "--location",
];

/**
 * @description Harness-prescribed package commands only (raw tool string).
 * Unsafe if pre-stripped — caller must pass original input.command.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isHarnessPrescribedPackageCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const raw = command.trim();
  if (stripCommandWrappers(raw) !== raw) return false;
  if (
    hasShellChainMetacharacters(raw) ||
    hasShellRedirectOperators(raw) ||
    raw.includes("$")
  ) {
    return false;
  }
  // Flags start with `-` so `\b` before them never matches — use space/start anchor.
  // Short -C / -w also match attached forms: -C/tmp/evil, -w@scope, -C=path.
  for (const flag of NPM_OVERRIDE_FLAGS) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (flag === "-C") {
      if (/(?:^|\s)-C(?:=|\s|\/|$)/.test(raw)) return false;
      continue;
    }
    if (flag === "-w") {
      if (/(?:^|\s)-w(?:=|\s|@|\/|$)/.test(raw)) return false;
      continue;
    }
    if (new RegExp(`(?:^|\\s)${escaped}(?:=|\\s|$)`).test(raw)) {
      return false;
    }
  }
  if (/^npx\s+tsc\s+--noEmit\s*$/.test(raw)) return true;
  if (/^npm\s+test\s*$/.test(raw)) return true;
  if (/^npm\s+run\s+typecheck\s*$/.test(raw)) return true;
  if (/^npx(?:\s+-y)?\s+(?:"github:orobsonn\/claude-harness#v\d+\.\d+\.\d+"|'github:orobsonn\/claude-harness#v\d+\.\d+\.\d+'|github:orobsonn\/claude-harness#v\d+\.\d+\.\d+)\s+init\s+--target\s+(?:opencode|claude|both)\s*$/.test(raw)) {
    return true;
  }
  return false;
}

/**
 * @description Fail-closed anti-forgery wall (text oracle + structural denials).
 * Always forge: eval one-liners, bash -c, /tmp runners, cwd-drop `node w.mjs`.
 * Oracle-path commands forge unless exact relative harness marker, no chain/redirect.
 * execution-plan.json is NOT an oracle — build may write the plan.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isStateForgeCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const c = stripCommandWrappers(command);
  if (isComplexEnvCommand(command) || isComplexEnvCommand(c)) return true;
  if (isEvalOneLiner(c)) return true;
  if (isNodePreload(command) || isNodePreload(c)) return true;
  if (isShellCCommand(c) || isShellCCommand(command)) return true;
  if (isShellScriptOrPipeToShell(c)) return true;
  if (isShellSourceOrStdin(c)) return true;
  if (isExpandingRedirect(command) || isExpandingRedirect(c)) return true;
  if (isArchiveUnpack(c)) return true;
  if (isPackageRunner(c) && !isHarnessPrescribedPackageCommand(command)) return true;
  if (isFrozenPathBashWrite(command) || isFrozenPathBashWrite(c)) return true;
  if (isTmpScriptRunner(c)) return true;
  if (isDirectScriptExec(c)) return true;
  if (isUnauthorizedInterpreter(c)) return true;
  if (!ORACLE_PATH_RE.test(c)) return false;
  const base = firstArgvBasename(c);
  if (
    FORGE_ALLOWLIST.has(base) &&
    isHarnessMarkerScript(c) &&
    !hasShellChainMetacharacters(c) &&
    !hasShellRedirectOperators(c)
  ) {
    return false;
  }
  return true;
}

/**
 * @param {{ command?: unknown }} input
 * @returns {Decision}
 */
export function decideBashForge(input = {}) {
  try {
    const raw = input.command;
    if (typeof raw !== "string") {
      return { ok: true, decision: "allow", reason: "not-state-forge" };
    }
    const command = stripCommandWrappers(raw);
    if (NATIVE_MARK_AUTHORITY_RE.test(raw) || NATIVE_MARK_AUTHORITY_RE.test(command)) {
      return {
        ok: false,
        decision: "deny",
        reason: "[entry-gate] Blocked: native marker authority is issued by the OpenCode host and cannot run or import through Bash.",
      };
    }
    // CC marker CLIs under OC never write .opencode gate-state — hard deny with redirect.
    if (CC_MARKER_PATH_RE.test(raw) || CC_MARKER_PATH_RE.test(command)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: Claude-Code marker CLIs (.claude/hooks/mark|classify) do not stamp OpenCode gate-state. Use the native `classify` tool and `node .opencode/plugin/lib/mark-gate.mjs` only.",
      };
    }
    // Complex env (`env -i node …`) — residual env after strip is fail-closed.
    if (isComplexEnvCommand(raw) || isComplexEnvCommand(command)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: complex env invocations (env -i / env options) cannot run via bash (anti-forgery).",
      };
    }
    // Preload checks raw too (NODE_OPTIONS=--require lost after strip).
    if (isNodePreload(raw) || isNodePreload(command)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: node --require/--import/--loader preloads cannot run via bash (anti-forgery).",
      };
    }
    if (isEvalOneLiner(command) || isEvalOneLiner(raw)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: interpreter eval one-liners (node -e / python -c / …) cannot touch gate-state (anti-forgery).",
      };
    }
    if (isShellCCommand(command) || isShellCCommand(raw)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: nested shells (-c) cannot run via bash (anti-forgery).",
      };
    }
    if (isShellScriptOrPipeToShell(command) || isShellScriptOrPipeToShell(raw)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: shell scripts and pipes into bash/sh cannot run via bash (anti-forgery).",
      };
    }
    if (isShellSourceOrStdin(command) || isShellSourceOrStdin(raw)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: source / bash < file cannot run via bash (anti-forgery).",
      };
    }
    if (isExpandingRedirect(raw) || isExpandingRedirect(command)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: redirects with $ / command-substitution cannot run via bash (anti-forgery).",
      };
    }
    if (isArchiveUnpack(command) || isArchiveUnpack(raw)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: archive unpack (tar/7z/cpio/gzip -d/…) cannot run via bash (anti-forgery).",
      };
    }
    if (isPackageRunner(command) || isPackageRunner(raw)) {
      if (!isHarnessPrescribedPackageCommand(raw)) {
        return {
          ok: false,
          decision: "deny",
          details: { denied_class: "package_launcher", resolver: "verify" },
          reason:
            "[entry-gate] Blocked: denied_class=package_launcher; npm run / make / npx cannot run via bash (anti-forgery package indirection). For an exact registered targeted-test equivalent, call native `verify` once with this denied class, exact command, task id, and named test path; otherwise stop.",
        };
      }
    }
    if (isFrozenPathBashWrite(raw) || isFrozenPathBashWrite(command)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: cannot bash-write frozen marker/tooling paths (anti-forgery).",
      };
    }
    if (isTmpScriptRunner(command)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: scripts under /tmp cannot run via bash (anti-forgery impostor drop).",
      };
    }
    if (isDirectScriptExec(command)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: direct script exec (./file.mjs) cannot run via bash (anti-forgery).",
      };
    }
    if (isUnauthorizedInterpreter(command)) {
      return {
        ok: false,
        decision: "deny",
        details: { denied_class: "interpreter", resolver: "verify" },
        reason:
          "[entry-gate] Blocked: denied_class=interpreter; only harness markers, authorized *.test.* under core|modules|.opencode, node --test, or allowlisted tooling may run interpreters (anti-forgery two-step). Call native `verify` once only when this exact interpreter form has a registered targeted-test equivalent; otherwise stop.",
      };
    }
    if (!isStateForgeCommand(raw)) {
      return { ok: true, decision: "allow", reason: "not-state-forge" };
    }
    return {
      ok: false,
      decision: "deny",
      reason:
        "[entry-gate] Blocked: bash must not write gate-state / plans/.state — use path-bound classify/mark/mark-gate only (anti-forgery).",
    };
  } catch {
    return {
      ok: false,
      decision: "deny",
      reason: "[entry-gate] Blocked: state-forge decision failed",
    };
  }
}

/**
 * @param {unknown} v
 * @returns {unknown[]}
 */
function coerceArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * @description Fail-closed: key present and not array → corrupt (same family as regate_pending).
 * Absent (undefined) → empty array. Array → as-is.
 * @param {Record<string, unknown>} gs
 * @param {string} key
 * @returns {{ corrupt: false, value: unknown[] } | { corrupt: true, raw: unknown, key: string }}
 */
function classifyArrayMarker(gs, key) {
  const raw = gs[key];
  if (raw === undefined) return { corrupt: false, value: [] };
  if (Array.isArray(raw)) return { corrupt: false, value: raw };
  return { corrupt: true, raw, key };
}

/**
 * @param {string} key
 * @param {unknown} raw
 * @returns {string}
 */
function corruptArrayMarkerReason(key, raw) {
  let text;
  try {
    text = JSON.stringify(raw);
  } catch {
    try {
      text = String(raw);
    } catch {
      text = `<unserializable ${key}>`;
    }
  }
  if (text.length > 200) text = text.slice(0, 200);
  return (
    `[entry-gate] Blocked: gate-state corrupted — ${key} is not a JSON array ` +
    `(raw value: ${text}). Repair or delete gate-state.json (${key} must be a ` +
    "JSON array), then re-stamp before proceeding."
  );
}

/**
 * @description Headless delivery context: explicit input/gate flag, or cloud env signals.
 * Interactive (default) requires demo for FULL; headless auto-validates demo off-gate.
 * @param {{ headless?: unknown }} input
 * @param {Record<string, unknown>} gs
 * @returns {boolean}
 */
export function isHeadlessDeliveryContext(input = {}, gs = {}) {
  if (input.headless === true) return true;
  if (gs && gs.headless === true) return true;
  try {
    if (typeof process !== "undefined" && process.env) {
      const remote = process.env.CLAUDE_CODE_REMOTE;
      if (remote === "true" || remote === "1") return true;
      const oc = process.env.OPENCODE_HEADLESS;
      if (oc === "true" || oc === "1") return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * @description Writing-task ids from a bound execution-plan: a task counts as a
 * writing task when it declares a non-empty `scope_paths` (an executor produces a
 * capture for it). Returns null when the plan is not enumerable — the A5 push rail
 * is fail-open (never block delivery on a plan we cannot read).
 * @param {unknown} plan
 * @returns {string[] | null}
 */
export function writingTaskIdsFromPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const tasks = /** @type {Record<string, unknown>} */ (plan).tasks;
  if (!Array.isArray(tasks)) return null;
  const ids = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) continue;
    const t = /** @type {Record<string, unknown>} */ (task);
    const id = t.id;
    const scope = t.scope_paths;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!Array.isArray(scope) || scope.length === 0) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * @param {{
 *   command?: unknown,
 *   gateState?: unknown,
 *   sessionId?: unknown,
 *   gateStateLoadOk?: boolean,
 *   headless?: boolean,
 *   gitState?: { branch?: string|null, commitsAhead?: number|null, defaultBranch?: string|null }|null,
 *   isAncestorFn?: (sha: string) => boolean|null,
 *   listHandRecordsForFeatureFn?: (featureId: string) => unknown[],
 *   boundPlan?: { tasks?: unknown[] }|null,
 * }} input
 * @returns {Decision}
 */
export function decideBashDelivery(input = {}) {
  try {
    const command = input.command;
    // 1. non-delivery → allow
    if (!isDeliveryCommand(command)) {
      return { ok: true, decision: "allow", reason: "not-delivery-command" };
    }

    // 2. gitState rails (null / unresolvable → skip fail-open)
    const gitState = input.gitState;
    if (gitState && typeof gitState === "object" && typeof gitState.branch === "string") {
      const isProtected =
        gitState.branch === "main" ||
        gitState.branch === "master" ||
        (typeof gitState.defaultBranch === "string" &&
          gitState.branch === gitState.defaultBranch);
      if (isProtected) {
        return {
          ok: false,
          decision: "deny",
          reason:
            `[entry-gate] Blocked: delivery command on protected branch '${gitState.branch}'. ` +
            "The per-task freeze/impl commit series must live on a feature branch — run " +
            "`git switch -c <type>/<feature-id>` (feat/fix/refactor/chore/docs) and commit the " +
            "work before any delivery command (git push / gh pr create / gh pr merge).",
        };
      }
      if (gitState.commitsAhead === 0) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: delivery command with zero commits ahead of base. Commit the " +
            "task's work (the freeze/impl series) before delivering — a push/PR with no commits " +
            "ships nothing and signals the orchestrator skipped the per-task commit step.",
        };
      }
    }

    // 3. sessionId safe + gateStateLoadOk — OC fail-closed deny
    if (input.gateStateLoadOk === false) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery requires readable gate-state (fail-closed).",
      };
    }

    if (!isSafeSessionIdSegment(input.sessionId)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery requires a safe sessionId bound to gate-state.",
      };
    }

    const gs =
      input.gateState &&
      typeof input.gateState === "object" &&
      !Array.isArray(input.gateState)
        ? /** @type {Record<string, unknown>} */ (input.gateState)
        : {};

    const mode = normalizeMode(gs.mode);
    const classified = gs.classified === true || gs.triaged === true;

    // 4. ceremony checks — deny if fail, NEVER return allow
    if (mode === "NO-CEREMONY") {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: no-ceremony mode cannot public-ship (git push / gh pr).",
      };
    }

    if (!classified && !mode) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery (git push / gh pr) requires ceremony — run triaging + classify before shipping.",
      };
    }

    // 4a. review failure/useful caps block ALL delivery (including QUICK launder)
    if (
      gs.review_status === "primary_failure_cap_reached" ||
      gs.review_status === "review_cap_reached"
    ) {
      return {
        ok: false,
        decision: "deny",
        reason:
          `[entry-gate] Blocked: delivery denied while review_status=${String(gs.review_status)}. ` +
          "Recover via canonical ceremony restart (new generation + bound plan) — never reclassify down to QUICK.",
        details: { denied_class: "review-cap-active", review_status: gs.review_status },
      };
    }

    if (mode === "QUICK" && classified) {
      // Anti-launder: QUICK ship is only for genuine QUICK runs — not after LIGHT/FULL residue.
      if (hasElevatedCeremonyResidue(gs)) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: QUICK delivery denied after elevated ceremony residue " +
            "(prior LIGHT/FULL, planner attempt, or dual/review leftovers). " +
            "Finish the LIGHT/FULL path or open a new session — do not reclassify down.",
          details: { denied_class: "quick-launder" },
        };
      }
      // genuine QUICK — fall through to rails 5–9
    } else if (mode === "LIGHT" || mode === "FULL" || (!mode && classified)) {
      if (gs.brainstormed !== true) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: delivery requires brainstormed before git push / gh pr.",
        };
      }
      if (gs.adversary_fired !== true) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: delivery requires adversary_fired before git push / gh pr.",
        };
      }
      if (mode === "FULL" && !isRecordedDual(gs.dual_status)) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: FULL delivery requires recorded dual_status before git push / gh pr.",
          details: { dual_status: gs.dual_status ?? null },
        };
      }
      // LIGHT|FULL require a usable bound planner plan — coordinator must not ship after
      // planner_unavailable / plan_invalid / delivery-blocked (smoke #72 PR without hands).
      if (gs.delivery_status === "delivery-blocked") {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: delivery_status=delivery-blocked — fix planner/review recovery before git push / gh pr.",
          details: {
            denied_class: "delivery-blocked",
            planner_status: gs.planner_status ?? null,
          },
        };
      }
      if (gs.planner_status !== "usable") {
        return {
          ok: false,
          decision: "deny",
          reason:
            `[entry-gate] Blocked: LIGHT/FULL delivery requires planner_status=usable ` +
            `(got ${String(gs.planner_status ?? "missing")}). Dispatch planner or planner-fallback; do not implement inline.`,
          details: {
            denied_class: "planner-not-usable",
            planner_status: gs.planner_status ?? null,
            planner_retry_outcome: gs.planner_retry_outcome ?? null,
          },
        };
      }
      // ceremony OK — fall through (no ceremony-delivery-ok early allow)
    } else {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery requires valid mode stamp (QUICK|LIGHT|FULL).",
      };
    }

    const isAncestorFn =
      typeof input.isAncestorFn === "function"
        ? input.isAncestorFn
        : () => null;

    // 5. corrupt regate_pending → deny (never "stamp regate-passed")
    const regate = classifyRegatePending(gs);
    if (regate.corrupt) {
      return {
        ok: false,
        decision: "deny",
        reason: corruptRegatePendingReason(regate.raw),
      };
    }

    // 5b. corrupt hand_finished / capture_verified / regate_passed (present + non-array) → deny
    for (const key of ["hand_finished", "capture_verified", "regate_passed"]) {
      const marker = classifyArrayMarker(gs, key);
      if (marker.corrupt) {
        return {
          ok: false,
          decision: "deny",
          reason: corruptArrayMarkerReason(marker.key, marker.raw),
        };
      }
    }

    // 6. unmatched regate via matchesAbsolution
    const pending = regate.pending;
    const passed = coerceArray(gs.regate_passed);
    const unmatched = pending.filter(
      (t) => !matchesAbsolution(/** @type {string} */ (t), passed, isAncestorFn),
    );
    if (unmatched.length > 0) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery command denied — HIGH sniper fix(es) for task(s) " +
          `${unmatched.join(", ")} still await the mandatory strong-eye re-gate ` +
          "(regate-pending without regate-passed). Dispatch the fresh-virgin adversary and " +
          "stamp regate-passed before running any delivery command " +
          "(git push / gh pr create / gh pr merge).",
      };
    }

    // 7. unmatched hand_finished vs capture_verified (arrays validated above)
    const handFinished = coerceArray(gs.hand_finished);
    const captureVerified = coerceArray(gs.capture_verified);
    const unmatchedCapture = handFinished.filter(
      (t) =>
        !matchesAbsolution(
          /** @type {string} */ (t),
          captureVerified,
          isAncestorFn,
        ),
    );
    if (unmatchedCapture.length > 0) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: delivery command denied — finished cheap-hand task(s) " +
          `${unmatchedCapture.join(", ")} still await independent capture/verification ` +
          "(hand-finished without capture-verified). Independently capture the hand output and " +
          "stamp capture-verified before running any delivery command " +
          "(git push / gh pr create / gh pr merge).",
      };
    }

    // 8. LIGHT/FULL require string feature_id
    const featureId =
      typeof gs.feature_id === "string" ? gs.feature_id : null;
    if ((mode === "LIGHT" || mode === "FULL") && featureId === null) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: LIGHT/FULL delivery requires string feature_id in gate-state.",
      };
    }

    // 8b. multitask capture coverage (A5): every writing task in the BOUND plan must
    // show delivery EVIDENCE — a capture-verified stamp OR a hand record for that task.
    // This catches the real gap: a LIGHT/FULL feature shipping with a planned writing
    // task that was never dispatched (no record, no capture = a silent half-build).
    // A task WITH a hand record (any terminal outcome, incl. the shippable
    // DONE_WITH_CONCERNS which the system deliberately does NOT capture-stamp) is left
    // to the existing capture / real-file rails — 8b must not demand a capture the
    // system never produces. Fail-open: only enforced when the bound plan is enumerable.
    if ((mode === "LIGHT" || mode === "FULL") && featureId !== null) {
      const writingTaskIds = writingTaskIdsFromPlan(input.boundPlan);
      if (Array.isArray(writingTaskIds) && writingTaskIds.length > 0) {
        const captured = coerceArray(gs.capture_verified);
        const recordedTaskIds = new Set();
        if (typeof input.listHandRecordsForFeatureFn === "function") {
          try {
            for (const rec of input.listHandRecordsForFeatureFn(featureId) ?? []) {
              const tid = rec && typeof rec === "object" && !Array.isArray(rec) ? rec.taskId : null;
              if (typeof tid === "string" && tid.length > 0) recordedTaskIds.add(tid);
            }
          } catch {
            /* fail-open: unreadable records → treat as none, rely on capture match */
          }
        }
        const missing = writingTaskIds.filter(
          (taskId) =>
            !recordedTaskIds.has(taskId) &&
            !matchesAbsolution(
              fidelityPassEntry(featureId, taskId, null),
              captured,
              isAncestorFn,
            ),
        );
        if (missing.length > 0) {
          return {
            ok: false,
            decision: "deny",
            reason:
              "[entry-gate] Blocked: delivery command denied — writing task(s) " +
              `${missing.join(", ")} in the bound execution-plan have no delivery evidence ` +
              "(no hand record and no capture-verified stamp) — a planned task was never " +
              "dispatched (half-built delivery). Dispatch the hand for each remaining writing " +
              "task before running any delivery command (git push / gh pr create / gh pr merge).",
          };
        }
      }
    }

    // 9. real-file rail when LIGHT|FULL or feature_id present
    // LIGHT|FULL: empty list is vacuous ship → deny (requireCaptureEvidence).
    // QUICK with feature_id: still runs rail on present records; empty list ok.
    const listFn = input.listHandRecordsForFeatureFn;
    const isLightOrFull = mode === "LIGHT" || mode === "FULL";
    const needsRealFile = isLightOrFull || featureId !== null;
    if (needsRealFile) {
      if (typeof listFn !== "function") {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: real-file-list-unavailable — listHandRecordsForFeatureFn required for delivery.",
        };
      }
      const realFileDeny = checkRealFileCaptureRail(
        /** @type {string} */ (featureId),
        {
          listHandRecordsForFeatureFn: listFn,
          isAncestorFn:
            typeof input.isAncestorFn === "function"
              ? input.isAncestorFn
              : undefined,
          requireCaptureEvidence: isLightOrFull,
          // LIGHT|FULL positive evidence must bind to the current delivery session
          requiredSessionId: isLightOrFull
            ? /** @type {string} */ (input.sessionId)
            : undefined,
        },
      );
      if (realFileDeny !== null) {
        return realFileDeny;
      }
    }

    // 9b. FULL ship preconditions: final review (+ demo when interactive)
    if (mode === "FULL") {
      if (gs.final_review_done !== true) {
        return {
          ok: false,
          decision: "deny",
          details: { denied_class: "final-review-missing" },
          reason:
            "[entry-gate] Blocked: denied_class=final-review-missing; FULL delivery requires " +
            "final dual review recorded (native mark action final-review) before git push / gh pr.",
        };
      }
      if (!isHeadlessDeliveryContext(input, gs) && gs.demo_done !== true) {
        return {
          ok: false,
          decision: "deny",
          details: { denied_class: "demo-missing" },
          reason:
            "[entry-gate] Blocked: denied_class=demo-missing; interactive FULL delivery requires " +
            "demo marker (native mark action demo-done) after operator validates the demo before " +
            "git push / gh pr. Headless sessions skip this rail (auto-validated against ACs).",
        };
      }
    }

    // 10. single terminal allow only
    return { ok: true, decision: "allow", reason: "delivery-ok" };
  } catch {
    return {
      ok: false,
      decision: "deny",
      reason: "[entry-gate] Blocked: delivery decision failed",
    };
  }
}

/**
 * @param {Decision} decision
 * @returns {void}
 */
export function throwIfDenied(decision) {
  if (decision && decision.decision === "deny") {
    throw new Error(decision.reason || "[entry-gate] denied");
  }
}

export { isDeliveryCommand };
