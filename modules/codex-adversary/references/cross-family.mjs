#!/usr/bin/env node
/**
 * @description Single entrypoint that drives the cross-family adversary loop, end to end on the JS
 * side. There is NO separate "Codex init" — the harness is one install; this driver is the opt-in
 * glue the orchestrator calls when the toggle is on.
 *
 * Pipeline:
 *   0. TOGGLE  — isEnabled()? (env HARNESS_CODEX_ADVERSARY or task.adversarial.cross_family). Off =>
 *                passthrough: the Claude issues are returned unchanged (Claude-only, as today).
 *   1. AVAIL   — checkAvailability()? (codex present, not headless-without-key). Unavailable =>
 *                same passthrough; never blocks.
 *   2. ATTACK  — run the Codex adversary (read-only) on the same task. Different family.
 *   3. MERGE   — classifyFindings(claude, codex): agreed (both) + needsCrosscheck (single-family).
 *   4. REFUTE  — for claude-only findings, Codex tries to refute (policy B, fully in JS).
 *                For codex-only findings, refutation belongs to CLAUDE — node cannot dispatch a
 *                Claude Agent, so they are emitted as `pendingClaudeRefutation` for the orchestrator.
 *   5. EMIT    — { enabled, available, findings, pendingClaudeRefutation, dropped, classified } so
 *                the orchestrator can (a) feed `findings` to the sniper now, and (b) run the Claude
 *                refutations on `pendingClaudeRefutation`, then call finalizeFindings again.
 *
 * Dependency-free: only node builtins + the two sibling modules.
 */

import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { isEnabled, checkAvailability, composeRolePrompt, runCodexAdversary, runCodexRefutation, runCodexRole, ROLES } from "./codex-adversary.mjs";
import { classifyFindings, finalizeFindings, dedupKey, readIssues, securityVerdict, DEDUP_FIELDS } from "./merge-findings.mjs";
import { mergeVerdicts } from "./merge-verdicts.mjs";

/**
 * @description Drives the cross-family loop for ANY findings-shaped EYE role (default `adversary`;
 * also `security`) with INJECTABLE codex runners (unit-testable without codex). The role is the only
 * variable: it selects the canonical prompt source, the dedup discriminators (security has no
 * `category`), and the refutation role file. FAIL-OPEN is total: the toggle, availability, AND the
 * compose/attack are all guarded so a missing module, an off switch, a headless run, OR a path /
 * compose bug all degrade to Claude-only passthrough — never a throw (a thrown compose would be
 * fail-CLOSED, the opposite of the contract).
 * @param {{
 *   role?: string,
 *   taskJson: object|string,
 *   claudeIssues: object[],
 *   env?: NodeJS.ProcessEnv,
 *   runAttack?: (args:{prompt:string, availability:object, role:string}) => {available:boolean, issues:object[], reason?:string},
 *   runRefute?: (args:{finding:object, taskJson:any, key:string, availability:object, rolePath?:string}) => {key:string, refuted:boolean, argument:string, refuter:string},
 * }} opts
 */
export function driveCrossFamily({ role = "adversary", taskJson, claudeIssues, env = process.env, runAttack, runRefute, availability }) {
  const task = typeof taskJson === "string" ? safeParse(taskJson) : (taskJson ?? {});
  const cfg = ROLES[role];
  const fields = cfg?.dedupFields ?? DEDUP_FIELDS.findings;
  const meta = (over) => stamp(role, claudeIssues, over);

  if (!isEnabled({ env, task })) {
    return meta({ enabled: false, available: false, reason: "cross-family toggle off (opt-in)" });
  }
  availability = availability ?? checkAvailability({ env });
  if (!availability.ok) {
    return meta({ enabled: true, available: false, reason: availability.reason });
  }

  // Compose + attack are guarded: a path/compose defect must fail OPEN (Claude-only), never throw.
  let attack;
  try {
    const prompt = composeRolePrompt({ role, taskJson });
    attack = (runAttack ?? defaultAttack)({ prompt, availability, role });
  } catch (err) {
    return meta({ enabled: true, available: false, reason: `cross-family compose/attack failed: ${err?.message ?? err}` });
  }
  if (!attack || !attack.available) {
    return meta({ enabled: true, available: false, reason: attack?.reason ?? "codex attack unavailable" });
  }

  const classified = classifyFindings(claudeIssues, attack.issues, fields);

  // Codex refutes the claude-only findings (JS side). Codex-only findings await a CLAUDE refutation.
  const codexVerdicts = [];
  const pendingClaudeRefutation = [];
  for (const entry of classified.needsCrosscheck) {
    if (entry.refuter === "codex") {
      const key = dedupKey(entry.issue, fields);
      codexVerdicts.push((runRefute ?? defaultRefute)({ finding: entry.issue, taskJson, key, availability, rolePath: cfg?.rolePath }));
    } else {
      pendingClaudeRefutation.push(entry.issue); // refuter === "claude"
    }
  }

  const { findings, dropped } = finalizeFindings(
    // Only finalize the agreed + claude-only here; codex-only stay pending (kept provisionally).
    { agreed: classified.agreed, needsCrosscheck: classified.needsCrosscheck.filter((e) => e.refuter === "codex") },
    codexVerdicts,
    fields,
  );

  return decorate(role, {
    enabled: true,
    available: true,
    role,
    findings,                 // ship to sniper now (agreed + claude-only survivors)
    pendingClaudeRefutation,  // orchestrator: run Claude refutation, then finalize these too
    dropped,                  // claude-only findings Codex refuted, with the refutation argument
    classified,               // full provenance for auditing
  });
}

/**
 * @description Drives the cross-family verdict-shaped path for roles whose output is a single
 * verdict (APPROVE/REVISE) rather than a findings[] array. FAIL-OPEN: any error, unavailable
 * codex, or missing output degrades to the Claude verdict with codexAvailable:false — never throws.
 * @param {{
 *   role: string,
 *   taskJson: object|string,
 *   claudeVerdict: object,
 *   runRole?: (args:{prompt:string, availability:object}) => {available:boolean, output?:object, reason?:string},
 *   env?: NodeJS.ProcessEnv,
 *   availability?: {ok:boolean, reason:string},
 * }} opts
 */
export function driveCrossFamilyVerdict({ role, taskJson, claudeVerdict, runRole, env = process.env, availability }) {
  try {
    const prompt = composeRolePrompt({ role, taskJson });
    const run = runRole ?? ((args) => runCodexRole(args));
    const res = run({ prompt, availability });
    if (res && res.available === true) {
      return mergeVerdicts(claudeVerdict, res.output, { codexAvailable: true });
    }
    return mergeVerdicts(claudeVerdict, {}, { codexAvailable: false });
  } catch (_err) {
    return mergeVerdicts(claudeVerdict, {}, { codexAvailable: false });
  }
}

/**
 * @description For the security gate, attach the recomputed SECURE|UNSAFE verdict. It is computed
 * ONLY from `findings` (agreed + claude-only survivors) — codex-only findings sit in
 * pendingClaudeRefutation and do NOT escalate the gate until the orchestrator runs the Claude
 * refutation and folds the survivors back in (a determinism the gate-state marker enforces). So a
 * codex false-high can never flip the gate behind the orchestrator's back.
 */
function decorate(role, result) {
  if (role === "security") result.verdict = securityVerdict(result.findings);
  return result;
}

function stamp(role, claudeIssues, meta) {
  const out = { ...meta, role, findings: [...claudeIssues], pendingClaudeRefutation: [], dropped: [], classified: null };
  return decorate(role, out);
}

function defaultAttack({ prompt, availability }) {
  return runCodexAdversary({ prompt, availability });
}
function defaultRefute({ finding, taskJson, key, availability, rolePath }) {
  return runCodexRefutation({ finding, taskJson, key, availability, rolePath });
}
function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// ---------------------------------------------------------------------------
// CLI: node cross-family.mjs --task <task.json> --claude <claude-issues.json>
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { task: null, claude: null, role: "adversary" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") out.task = argv[++i];
    else if (argv[i] === "--claude") out.claude = argv[++i];
    else if (argv[i] === "--role") out.role = argv[++i];
  }
  return out;
}

function main() {
  const { task, claude, role } = parseArgs(process.argv.slice(2));
  const taskJson = task ? readFileSync(resolveCwd(task), "utf8") : "{}";
  const claudeIssues = claude ? readIssues(claude) : [];
  const result = driveCrossFamily({ role, taskJson, claudeIssues });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function resolveCwd(p) { return isAbsolute(p) ? p : resolve(process.cwd(), p); }

if (process.argv[1] && resolve(process.argv[1]).endsWith("cross-family.mjs")) {
  main();
}
