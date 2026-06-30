#!/usr/bin/env node
/**
 * @description Cross-family adversary bridge: runs the Claude Harness `adversary` attack on a
 * DIFFERENT model family (OpenAI GPT via the Codex CLI), so its findings can be merged with the
 * native Claude adversary's (see merge-findings.mjs). The model family is the ONLY variable —
 * the role prompt and the attack taxonomy are composed at runtime from the canonical core
 * sources, guaranteeing zero drift from the Claude adversary.
 *
 * Design contract (mirrors spawn-hand.mjs conventions):
 * - `composeAdversaryPrompt` / `composeRefutationPrompt` are PURE: they read the canonical files
 *   and return a prompt string; no process is launched.
 * - `runCodexAdversary` is INJECTABLE: the `spawn` parameter defaults to a thin spawnSync wrapper
 *   so tests pass a FAKE spawn that captures args/env without launching a real `codex`.
 * - FAIL-OPEN: a missing/unauthenticated `codex`, or a HEADLESS routine with no API key, returns
 *   `{ available: false, issues: [], reason }`. The caller degrades to the Claude-only adversary
 *   and NEVER blocks — the second family is an enhancement, never a hard dependency.
 * - READ-ONLY: Codex is invoked with `--sandbox read-only`. It is an EYE, never a hand.
 * - Dependency-free: only node builtins (fs, path, child_process, url).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @description Repo root, three levels up from modules/codex-adversary/references/. */
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** @description Canonical sources — the SINGLE source of truth shared with the Claude adversary. */
export const ADVERSARY_ROLE_PATH = join(REPO_ROOT, "core", "agents", "adversary.md");
export const CANONICAL_SKILL_PATH = join(
  REPO_ROOT, "core", "skills", "canonical-critical-classes", "SKILL.md",
);

/**
 * @description Strips a leading YAML frontmatter block (--- ... ---) from a markdown document.
 * The frontmatter is Claude-Code agent metadata (name/model/tools) and is meaningless to Codex.
 * @param {string} md
 * @returns {string} the body after the frontmatter (or the input unchanged if none)
 */
export function stripFrontmatter(md) {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  const afterClose = md.indexOf("\n", end + 1);
  return afterClose === -1 ? "" : md.slice(afterClose + 1).replace(/^\n+/, "");
}

/**
 * @description Composes the attack prompt for the Codex family from the canonical core sources.
 * PURE — reads files, returns a string. The composed prompt = adversary role (frontmatter stripped)
 * + the canonical-critical-classes taxonomy + the concrete task + a strict output instruction.
 * This is what guarantees parity: both families read the same words.
 * @param {{ taskJson: object|string, rolePath?: string, skillPath?: string }} opts
 * @returns {string}
 */
export function composeAdversaryPrompt({ taskJson, rolePath = ADVERSARY_ROLE_PATH, skillPath = CANONICAL_SKILL_PATH }) {
  const role = stripFrontmatter(readFileSync(rolePath, "utf8"));
  const skill = stripFrontmatter(readFileSync(skillPath, "utf8"));
  const task = typeof taskJson === "string" ? taskJson : JSON.stringify(taskJson, null, 2);
  return [
    "You are running as a CROSS-FAMILY peer of the Claude Harness adversary. You are a DIFFERENT",
    "model family; your value is the failure modes Claude's priors miss. Same role, same taxonomy,",
    "same output schema as below — only the engine differs.",
    "",
    "=== ATTACK ROLE (verbatim from core/agents/adversary.md) ===",
    role.trim(),
    "",
    "=== ATTACK TAXONOMY (verbatim from canonical-critical-classes) ===",
    skill.trim(),
    "",
    "=== TASK UNDER ATTACK ===",
    task,
    "",
    "=== OUTPUT CONTRACT ===",
    "Run the attested sweep against this task's scope_paths. Reply with ONE fenced ```json block",
    "matching the adversary `issues[]` schema EXACTLY (description, category, severity, scope,",
    "evidence, suggested_sniper_tier, fix_hint), and nothing after it. Zero real issues is a VALID",
    "result — emit `{\"issues\": []}`. NEVER fabricate a finding to hit a count.",
  ].join("\n");
}

/**
 * @description Composes a REFUTATION prompt (cross-check policy B): hand the Codex family a finding
 * that only the OTHER family raised and ask it to refute. PURE.
 * @param {{ finding: object, taskJson: object|string, rolePath?: string }} opts
 * @returns {string}
 */
export function composeRefutationPrompt({ finding, taskJson, rolePath = ADVERSARY_ROLE_PATH }) {
  const role = stripFrontmatter(readFileSync(rolePath, "utf8"));
  const task = typeof taskJson === "string" ? taskJson : JSON.stringify(taskJson, null, 2);
  return [
    "You are a CROSS-FAMILY refutation judge. Another model family raised the finding below.",
    "Your job is to REFUTE it: inspect the scope and decide whether it is a real, reachable defect.",
    "Default to refuted=true ONLY when you can show concretely why it cannot happen; if it is real,",
    "refuted=false. Do not rubber-stamp; do not invent agreement.",
    "",
    "=== ATTACK ROLE (for shared standards) ===",
    role.trim(),
    "",
    "=== TASK ===",
    task,
    "",
    "=== FINDING TO REFUTE ===",
    JSON.stringify(finding, null, 2),
    "",
    "=== OUTPUT CONTRACT ===",
    "Reply with ONE fenced ```json block: {\"refuted\": boolean, \"argument\": \"why, citing file:fn\"}",
    "and nothing after it.",
  ].join("\n");
}

/**
 * @description Extracts the first fenced ```json block from Codex stdout and parses it. Tolerates
 * surrounding prose. Returns null if no parseable block is found.
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseJsonBlock(stdout) {
  if (!stdout) return null;
  const fenced = stdout.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : stdout;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    // Last resort: first balanced-looking {...} span.
    const start = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (start !== -1 && last > start) {
      try { return JSON.parse(candidate.slice(start, last + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * @description True when the run is a HEADLESS cloud routine (no interactive OAuth possible).
 * @param {NodeJS.ProcessEnv} env
 */
export function isHeadless(env = process.env) {
  return Boolean(env.CLAUDE_CODE_REMOTE || env.CLAUDE_CODE_ON_THE_WEB);
}

/**
 * @description Decides whether the Codex bridge can run at all, BEFORE spawning anything.
 * Headless + no API key => unavailable by design (subscription/OAuth can't complete headlessly),
 * so the loop runs Claude-only. Returns { ok, reason }.
 * @param {{ env?: NodeJS.ProcessEnv, codexBin?: string, hasCodex?: (bin:string)=>boolean }} opts
 */
export function checkAvailability({ env = process.env, codexBin = "codex", hasCodex = defaultHasCodex } = {}) {
  if (isHeadless(env) && !env.OPENAI_API_KEY) {
    return { ok: false, reason: "headless routine without OPENAI_API_KEY — OAuth/subscription auth cannot run; degrading to Claude-only" };
  }
  if (!hasCodex(codexBin)) {
    return { ok: false, reason: `codex CLI not found on PATH (${codexBin}) — degrading to Claude-only` };
  }
  return { ok: true, reason: "" };
}

/** @description Best-effort `codex` presence probe via `command -v`. Pure-ish; injectable in tests. */
function defaultHasCodex(bin) {
  try {
    const r = spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * @description Runs the Codex adversary read-only and returns parsed issues. INJECTABLE spawn.
 * FAIL-OPEN: never throws on a missing/erroring codex — returns { available:false, issues:[] }.
 * @param {{
 *   prompt: string,
 *   spawn?: typeof spawnSync,
 *   codexBin?: string,
 *   env?: NodeJS.ProcessEnv,
 *   extraArgs?: string[],
 *   availability?: {ok:boolean, reason:string},
 * }} opts
 * @returns {{ available: boolean, issues: object[], raw?: string, reason?: string }}
 */
export function runCodexAdversary({
  prompt,
  spawn = spawnSync,
  codexBin = "codex",
  env = process.env,
  extraArgs = [],
  availability,
} = {}) {
  const avail = availability ?? checkAvailability({ env, codexBin });
  if (!avail.ok) return { available: false, issues: [], reason: avail.reason };

  const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", ...extraArgs, prompt];
  let res;
  try {
    res = spawn(codexBin, args, { encoding: "utf8", env });
  } catch (err) {
    return { available: false, issues: [], reason: `codex spawn failed: ${err?.message ?? err}` };
  }
  if (!res || res.error || res.status !== 0) {
    const reason = res?.error?.message || res?.stderr || `codex exited ${res?.status}`;
    return { available: false, issues: [], reason: `codex run failed: ${String(reason).slice(0, 300)}` };
  }
  const parsed = parseJsonBlock(res.stdout);
  if (!parsed || !Array.isArray(parsed.issues)) {
    return { available: false, issues: [], reason: "codex output had no parseable issues[] block", raw: res.stdout };
  }
  return { available: true, issues: parsed.issues, raw: res.stdout };
}

// ---------------------------------------------------------------------------
// CLI: node codex-adversary.mjs --task <task.json> [--self-test]
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { task: null, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") out.task = argv[++i];
    else if (argv[i] === "--self-test") out.selfTest = true;
  }
  return out;
}

function main() {
  const { task, selfTest } = parseArgs(process.argv.slice(2));
  const taskJson = task ? readFileSync(resolveCwd(task), "utf8") : "{}";

  // --self-test composes the prompt from the REAL canonical sources and prints it WITHOUT calling
  // codex — proves parity and works with no codex installed (e.g. in CI / headless).
  if (selfTest) {
    const prompt = composeAdversaryPrompt({ taskJson });
    process.stdout.write(prompt + "\n");
    process.exit(0);
  }

  const avail = checkAvailability({});
  if (!avail.ok) {
    // Fail-open contract: emit the empty, available:false envelope on stdout and exit 0 so the
    // orchestrator's merge step degrades to Claude-only without treating this as an error.
    process.stdout.write(JSON.stringify({ available: false, issues: [], reason: avail.reason }) + "\n");
    process.exit(0);
  }
  const prompt = composeAdversaryPrompt({ taskJson });
  const result = runCodexAdversary({ prompt, availability: avail });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}

function resolveCwd(p) {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

// Re-export for callers that want to probe existence without spawning.
export { existsSync };
