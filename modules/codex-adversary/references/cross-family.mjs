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
import { isEnabled, checkAvailability, composeAdversaryPrompt, runCodexAdversary, runCodexRefutation } from "./codex-adversary.mjs";
import { classifyFindings, finalizeFindings, dedupKey, readIssues } from "./merge-findings.mjs";

/**
 * @description Drives the loop with INJECTABLE codex runners (so it is unit-testable without codex).
 * @param {{
 *   taskJson: object|string,
 *   claudeIssues: object[],
 *   env?: NodeJS.ProcessEnv,
 *   runAttack?: (args:{prompt:string, availability:object}) => {available:boolean, issues:object[], reason?:string},
 *   runRefute?: (args:{finding:object, taskJson:any, key:string, availability:object}) => {key:string, refuted:boolean, argument:string, refuter:string},
 * }} opts
 */
export function driveCrossFamily({ taskJson, claudeIssues, env = process.env, runAttack, runRefute, availability }) {
  const task = typeof taskJson === "string" ? safeParse(taskJson) : (taskJson ?? {});

  if (!isEnabled({ env, task })) {
    return passthrough(claudeIssues, { enabled: false, available: false, reason: "cross-family toggle off (opt-in)" });
  }
  availability = availability ?? checkAvailability({ env });
  if (!availability.ok) {
    return passthrough(claudeIssues, { enabled: true, available: false, reason: availability.reason });
  }

  const attack = (runAttack ?? defaultAttack)({ prompt: composeAdversaryPrompt({ taskJson }), availability });
  if (!attack.available) {
    return passthrough(claudeIssues, { enabled: true, available: false, reason: attack.reason ?? "codex attack unavailable" });
  }

  const classified = classifyFindings(claudeIssues, attack.issues);

  // Codex refutes the claude-only findings (JS side). Codex-only findings await a CLAUDE refutation.
  const codexVerdicts = [];
  const pendingClaudeRefutation = [];
  for (const entry of classified.needsCrosscheck) {
    if (entry.refuter === "codex") {
      const key = dedupKey(entry.issue);
      codexVerdicts.push((runRefute ?? defaultRefute)({ finding: entry.issue, taskJson, key, availability }));
    } else {
      pendingClaudeRefutation.push(entry.issue); // refuter === "claude"
    }
  }

  const { findings, dropped } = finalizeFindings(
    // Only finalize the agreed + claude-only here; codex-only stay pending (kept provisionally).
    { agreed: classified.agreed, needsCrosscheck: classified.needsCrosscheck.filter((e) => e.refuter === "codex") },
    codexVerdicts,
  );

  return {
    enabled: true,
    available: true,
    findings,                 // ship to sniper now (agreed + claude-only survivors)
    pendingClaudeRefutation,  // orchestrator: run Claude refutation, then finalize these too
    dropped,                  // claude-only findings Codex refuted, with the refutation argument
    classified,               // full provenance for auditing
  };
}

function passthrough(claudeIssues, meta) {
  return { ...meta, findings: [...claudeIssues], pendingClaudeRefutation: [], dropped: [], classified: null };
}

function defaultAttack({ prompt, availability }) {
  return runCodexAdversary({ prompt, availability });
}
function defaultRefute({ finding, taskJson, key, availability }) {
  return runCodexRefutation({ finding, taskJson, key, availability });
}
function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// ---------------------------------------------------------------------------
// CLI: node cross-family.mjs --task <task.json> --claude <claude-issues.json>
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { task: null, claude: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") out.task = argv[++i];
    else if (argv[i] === "--claude") out.claude = argv[++i];
  }
  return out;
}

function main() {
  const { task, claude } = parseArgs(process.argv.slice(2));
  const taskJson = task ? readFileSync(resolveCwd(task), "utf8") : "{}";
  const claudeIssues = claude ? readIssues(claude) : [];
  const result = driveCrossFamily({ taskJson, claudeIssues });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function resolveCwd(p) { return isAbsolute(p) ? p : resolve(process.cwd(), p); }

if (process.argv[1] && resolve(process.argv[1]).endsWith("cross-family.mjs")) {
  main();
}
