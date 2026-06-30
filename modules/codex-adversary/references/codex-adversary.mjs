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

/**
 * @description Repo root, three levels up from the module's references/ dir. In the SOURCE repo this
 * is `<root>` (module at `<root>/modules/codex-adversary/references/`); when the module is VENDORED
 * it is the project's `.claude/` (module at `<root>/.claude/modules/codex-adversary/references/`).
 */
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/**
 * @description Resolves a canonical core source that lives under TWO possible layouts: the source
 * repo keeps it under `core/` (`<root>/core/agents/...`), while a vendored project keeps it directly
 * under `.claude/` (`<root>/agents/...`, no `core/`). Tries the `core/`-prefixed path first, then the
 * bare path; if NEITHER exists, returns the `core/` variant so a downstream read error points at the
 * canonical location. PURE — `exists` is injectable for tests.
 * @param {string} rel - Path relative to the core root, e.g. "agents/adversary.md".
 * @param {{ repoRoot?: string, exists?: (p: string) => boolean }} [opts]
 * @returns {string} Absolute path to the resolved source.
 */
export function resolveCanonicalPath(rel, { repoRoot = REPO_ROOT, exists = existsSync } = {}) {
  const underCore = join(repoRoot, "core", rel);
  if (exists(underCore)) return underCore;
  const bare = join(repoRoot, rel);
  if (exists(bare)) return bare;
  return underCore;
}

/** @description Canonical sources — the SINGLE source of truth shared with the Claude adversary. */
export const ADVERSARY_ROLE_PATH = resolveCanonicalPath("agents/adversary.md");
export const CANONICAL_SKILL_PATH = resolveCanonicalPath(
  "skills/canonical-critical-classes/SKILL.md",
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

/** @description Role file path for the plan-reviewer eye (a verdict-shaped cross-family checkpoint). */
export const PLAN_REVIEWER_ROLE_PATH = resolveCanonicalPath("agents/plan-reviewer.md");

/** @description Role file path for the security auditor eye (findings-shaped, SECURE|UNSAFE gate). */
export const SECURITY_ROLE_PATH = resolveCanonicalPath("agents/security.md");

/**
 * @description Registry of the EYE roles that can run cross-family. The principle: NOT every task
 * has an adversarial checkpoint, but EVERY checkpoint that runs an eye runs it on BOTH families.
 * Each entry declares the canonical role file (single source of truth — composed at runtime, never
 * copied), the skills that role loads, the merge `shape`, and the output contract handed to Codex.
 *   - shape "findings": output is `issues[]` → merged by union + dedup + cross-check (merge-findings).
 *   - shape "verdict":  output is APPROVE|REVISE + concerns → merged by either-REVISE-wins (merge-verdicts).
 */
export const ROLES = {
  adversary: {
    rolePath: ADVERSARY_ROLE_PATH,
    skillPaths: [CANONICAL_SKILL_PATH],
    shape: "findings",
    headline: "CROSS-FAMILY peer of the Claude Harness adversary",
    outputContract: [
      "Run the attested sweep against this task's scope_paths. Reply with ONE fenced ```json block",
      "matching the adversary `issues[]` schema EXACTLY (description, category, severity, scope,",
      "evidence, suggested_sniper_tier, fix_hint), and nothing after it. Zero real issues is a VALID",
      "result — emit `{\"issues\": []}`. NEVER fabricate a finding to hit a count.",
    ].join("\n"),
  },
  "plan-reviewer": {
    rolePath: PLAN_REVIEWER_ROLE_PATH,
    skillPaths: [],
    shape: "verdict",
    headline: "CROSS-FAMILY peer of the Claude Harness plan-reviewer",
    outputContract: [
      "Audit the plan as written against the codebase. Reply with ONE fenced ```json block matching",
      "the plan-reviewer schema EXACTLY: {\"verdict\": \"APPROVE | REVISE\", \"issues\": [...],",
      "\"planner_instructions\": \"...\"}, and nothing after it. REVISE only for a substantive",
      "engineering defect, never style. If sound, emit verdict APPROVE with an empty issues list.",
    ].join("\n"),
  },
  security: {
    rolePath: SECURITY_ROLE_PATH,
    skillPaths: [],
    shape: "findings",
    // Security issues carry no `category` (unlike the adversary) — dedup on severity instead, so two
    // distinct security findings in the same scope are not silently collapsed. See merge-findings.
    dedupFields: ["scope", "severity", "evidence"],
    headline: "CROSS-FAMILY peer of the Claude Harness security auditor",
    outputContract: [
      "Audit this task's scope_paths for exploitable attack vectors (secrets, auth, input validation,",
      "data leakage, deps, endpoint surface). Reply with ONE fenced ```json block matching the security",
      "schema EXACTLY: {\"verdict\": \"SECURE | UNSAFE\", \"issues\": [{description, severity, scope,",
      "evidence, suggested_sniper_tier, fix_hint}]}, and nothing after it. UNSAFE requires at least one",
      "high or medium issue. Zero real issues is a VALID result — emit verdict SECURE with `issues: []`.",
      "NEVER fabricate a finding to hit a count.",
    ].join("\n"),
  },
};

/**
 * @description Composes the Codex prompt for ANY registered eye role, from the canonical core
 * sources. PURE — reads files, returns a string. Parity guarantee: both families read the same
 * role + skills verbatim; only the inference engine differs.
 * @param {{ role?: string, taskJson: object|string, roles?: object }} opts
 * @returns {string}
 */
export function composeRolePrompt({ role = "adversary", taskJson, roles = ROLES }) {
  const cfg = roles[role];
  if (!cfg) throw new Error(`unknown cross-family role: ${role}`);
  const roleBody = stripFrontmatter(readFileSync(cfg.rolePath, "utf8"));
  const skills = cfg.skillPaths.map((p) => stripFrontmatter(readFileSync(p, "utf8")).trim());
  const task = typeof taskJson === "string" ? taskJson : JSON.stringify(taskJson, null, 2);
  const parts = [
    `You are running as a ${cfg.headline}. You are a DIFFERENT model family; your value is the`,
    "failure modes Claude's priors miss. Same role, same skills, same output schema — only the engine",
    "differs.",
    "",
    `=== ROLE (verbatim from ${cfg.rolePath.replace(REPO_ROOT + "/", "")}) ===`,
    roleBody.trim(),
  ];
  skills.forEach((s, i) => {
    parts.push("", `=== SKILL ${i + 1} (verbatim) ===`, s);
  });
  parts.push("", "=== INPUT UNDER REVIEW ===", task, "", "=== OUTPUT CONTRACT ===", cfg.outputContract);
  return parts.join("\n");
}

/**
 * @description Back-compat wrapper: composes the adversary attack prompt. Prefer composeRolePrompt.
 * @param {{ taskJson: object|string }} opts
 * @returns {string}
 */
export function composeAdversaryPrompt({ taskJson }) {
  return composeRolePrompt({ role: "adversary", taskJson });
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
 * @description Runs Codex read-only on a composed prompt and returns the parsed JSON output for ANY
 * role shape. INJECTABLE spawn. FAIL-OPEN: never throws — returns { available:false } on any failure.
 * @param {{
 *   prompt: string, spawn?: typeof spawnSync, codexBin?: string, env?: NodeJS.ProcessEnv,
 *   extraArgs?: string[], availability?: {ok:boolean, reason:string},
 * }} opts
 * @returns {{ available: boolean, output?: object, raw?: string, reason?: string }}
 */
export function runCodexRole({
  prompt, spawn = spawnSync, codexBin = "codex", env = process.env, extraArgs = [], availability,
} = {}) {
  const avail = availability ?? checkAvailability({ env, codexBin });
  if (!avail.ok) return { available: false, reason: avail.reason };

  const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", ...extraArgs, prompt];
  let res;
  try {
    res = spawn(codexBin, args, { encoding: "utf8", env });
  } catch (err) {
    return { available: false, reason: `codex spawn failed: ${err?.message ?? err}` };
  }
  if (!res || res.error || res.status !== 0) {
    const reason = res?.error?.message || res?.stderr || `codex exited ${res?.status}`;
    return { available: false, reason: `codex run failed: ${String(reason).slice(0, 300)}` };
  }
  const parsed = parseJsonBlock(res.stdout);
  if (!parsed || typeof parsed !== "object") {
    return { available: false, reason: "codex output had no parseable json block", raw: res.stdout };
  }
  return { available: true, output: parsed, raw: res.stdout };
}

/**
 * @description Back-compat wrapper for the findings-shaped adversary role. Returns the legacy
 * { available, issues } envelope. FAIL-OPEN.
 * @returns {{ available: boolean, issues: object[], raw?: string, reason?: string }}
 */
export function runCodexAdversary(opts = {}) {
  const r = runCodexRole(opts);
  if (!r.available) return { available: false, issues: [], reason: r.reason, raw: r.raw };
  if (!Array.isArray(r.output.issues)) {
    return { available: false, issues: [], reason: "codex output had no parseable issues[] block", raw: r.raw };
  }
  return { available: true, issues: r.output.issues, raw: r.raw };
}

/**
 * @description The OPT-IN toggle: is the cross-family adversary turned on for this run? Default OFF
 * — the operator must explicitly opt in. Aligned with the per-task `adversarial.enabled` convention:
 * either set env HARNESS_CODEX_ADVERSARY=1, or `adversarial.cross_family: true` in the task contract.
 * Availability (codex present, not headless-without-key) is checked SEPARATELY — this is intent,
 * not capability.
 * @param {{ env?: NodeJS.ProcessEnv, task?: object }} opts
 * @returns {boolean}
 */
export function isEnabled({ env = process.env, task = {} } = {}) {
  const flag = String(env.HARNESS_CODEX_ADVERSARY ?? "").toLowerCase();
  if (flag === "1" || flag === "true" || flag === "on") return true;
  if (flag === "0" || flag === "false" || flag === "off") return false;
  return task?.adversarial?.cross_family === true;
}

/**
 * @description Runs a single REFUTATION (cross-check policy B) on the Codex family: hands Codex a
 * finding only the Claude adversary raised and asks it to refute. Returns a verdict shaped for
 * finalizeFindings. FAIL-OPEN: if Codex is unavailable or its output is unparseable, returns
 * `refuted: false` (KEEP the finding — never drop a finding because the cross-check could not run).
 * @param {{
 *   finding: object, taskJson: object|string, key: string,
 *   spawn?: typeof spawnSync, codexBin?: string, env?: NodeJS.ProcessEnv,
 *   availability?: {ok:boolean, reason:string}, rolePath?: string,
 * }} opts
 * @returns {{ key: string, refuted: boolean, argument: string, refuter: "codex" }}
 */
export function runCodexRefutation({
  finding, taskJson, key, spawn = spawnSync, codexBin = "codex", env = process.env, availability, rolePath = ADVERSARY_ROLE_PATH,
}) {
  const avail = availability ?? checkAvailability({ env, codexBin });
  if (!avail.ok) {
    return { key, refuted: false, argument: `cross-check skipped — ${avail.reason}; finding kept (fail-open)`, refuter: "codex" };
  }
  const prompt = composeRefutationPrompt({ finding, taskJson, rolePath });
  let res;
  try {
    res = spawn(codexBin, ["exec", "--sandbox", "read-only", "--skip-git-repo-check", prompt], { encoding: "utf8", env });
  } catch (err) {
    return { key, refuted: false, argument: `cross-check spawn failed: ${err?.message ?? err}; finding kept`, refuter: "codex" };
  }
  if (!res || res.error || res.status !== 0) {
    return { key, refuted: false, argument: `cross-check run failed; finding kept`, refuter: "codex" };
  }
  const parsed = parseJsonBlock(res.stdout);
  if (!parsed || typeof parsed.refuted !== "boolean") {
    return { key, refuted: false, argument: "cross-check unparseable; finding kept", refuter: "codex" };
  }
  return { key, refuted: parsed.refuted, argument: String(parsed.argument ?? ""), refuter: "codex" };
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
