#!/usr/bin/env node
/**
 * @description Cross-family merge for VERDICT-shaped eyes (the plan-reviewer): each family returns
 * APPROVE | REVISE plus concerns. Unlike findings (union + dedup + cross-check), a verdict merge is
 * conservative by design:
 *
 *   - If EITHER family says REVISE, the merged verdict is REVISE. A second family that spots a
 *     substantive engineering defect the other missed is exactly the value of running both — we do
 *     NOT require agreement to act on it (that would suppress the catch).
 *   - The merged concerns are the UNION of both families' issues, tagged by provenance.
 *   - planner_instructions are concatenated (both families' guidance reaches the planner).
 *   - APPROVE only when BOTH families approve.
 *
 * This is intentionally NOT symmetric with findings cross-check: a REVISE is cheap to act on (the
 * planner revises), so the conservative union is the right default for a pre-execution gate.
 *
 * Dependency-free: only node builtins.
 */

import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

/** @description Normalizes a verdict string to APPROVE | REVISE (defaults to REVISE if unknown). */
function normVerdict(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "APPROVE" ? "APPROVE" : "REVISE";
}

function tagIssues(issues, family) {
  return (Array.isArray(issues) ? issues : []).map((i) => ({ ...i, found_by: [family] }));
}

/**
 * @description Merges two plan-reviewer verdicts (one per family). PURE.
 * Either-REVISE-wins; concerns are unioned; instructions concatenated.
 * @param {{ verdict?: string, issues?: object[], planner_instructions?: string }} claudeVerdict
 * @param {{ verdict?: string, issues?: object[], planner_instructions?: string }} codexVerdict
 * @param {{ codexAvailable?: boolean }} [meta] when codex did not run, fall back to Claude's verdict
 * @returns {{ verdict: string, issues: object[], planner_instructions: string, sources: object }}
 */
export function mergeVerdicts(claudeVerdict = {}, codexVerdict = {}, meta = {}) {
  const claude = normVerdict(claudeVerdict.verdict);
  // Fail-open: if codex was unavailable, the merged verdict is just Claude's (Claude-only), never a
  // spurious REVISE from an empty/missing second opinion.
  if (meta.codexAvailable === false) {
    return {
      verdict: claude,
      issues: tagIssues(claudeVerdict.issues, "claude"),
      planner_instructions: claudeVerdict.planner_instructions ?? "",
      sources: { claude, codex: null },
    };
  }
  const codex = normVerdict(codexVerdict.verdict);
  const verdict = claude === "REVISE" || codex === "REVISE" ? "REVISE" : "APPROVE";
  const issues = [...tagIssues(claudeVerdict.issues, "claude"), ...tagIssues(codexVerdict.issues, "codex")];
  const planner_instructions = [claudeVerdict.planner_instructions, codexVerdict.planner_instructions]
    .filter(Boolean).join("\n---\n");
  return { verdict, issues, planner_instructions, sources: { claude, codex } };
}

/** @description Reads a verdict envelope from disk (bare verdict object). */
export function readVerdict(path) {
  return JSON.parse(readFileSync(resolveCwd(path), "utf8"));
}

function resolveCwd(p) { return isAbsolute(p) ? p : resolve(process.cwd(), p); }

// CLI: node merge-verdicts.mjs --claude claude.json --codex codex.json
function parseArgs(argv) {
  const out = { claude: null, codex: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--claude") out.claude = argv[++i];
    else if (argv[i] === "--codex") out.codex = argv[++i];
  }
  return out;
}

function main() {
  const { claude, codex } = parseArgs(process.argv.slice(2));
  const claudeV = claude ? readVerdict(claude) : {};
  const codexV = codex ? readVerdict(codex) : {};
  const merged = mergeVerdicts(claudeV, codexV, { codexAvailable: Boolean(codex) });
  process.stdout.write(JSON.stringify(merged, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("merge-verdicts.mjs")) {
  main();
}
