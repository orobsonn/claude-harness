#!/usr/bin/env node
/**
 * @description Merges the Claude adversary's findings with the cross-family (Codex/GPT) adversary's,
 * implementing the diversity-preserving policy:
 *   1. UNION of both families' issues.
 *   2. DEDUP by (scope, category, evidence) — an issue BOTH families raised is `agreed`
 *      (high confidence, ships without cross-check).
 *   3. CROSS-CHECK (policy B) for any issue only ONE family raised: the OTHER family must try to
 *      refute it. Keep it UNLESS refuted. This filters false positives without discarding the
 *      minority catch (the whole point of running a second family) just for being minority.
 *
 * NOT majority voting — that would suppress the single-family finding, which is exactly the blind
 * spot the second family exists to surface.
 *
 * Split into PURE functions so the model-call boundary stays outside:
 *   - classifyFindings(claude, codex) -> { agreed, needsCrosscheck }
 *   - finalizeFindings(classified, verdicts) -> final issue list (policy B applied)
 *
 * Dependency-free: only node builtins.
 */

import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

/** @description Normalizes a free-text field for dedup key construction. */
function norm(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * @description Stable dedup key for an issue. Two issues from different families collapse when they
 * point at the same place (scope), the same failure class (category), and the same proof (evidence).
 * Evidence is normalized loosely so "line 14" vs "L14" still tend to collide on scope+category.
 * @param {object} issue
 * @returns {string}
 */
export function dedupKey(issue) {
  return [norm(issue.scope), norm(issue.category), norm(issue.evidence)].join("::");
}

/** @description Tags an issue with provenance without mutating the input. */
function tag(issue, family) {
  return { ...issue, found_by: [family] };
}

/**
 * @description Union + dedup. Issues raised by both families become `agreed`; issues raised by a
 * single family become `needsCrosscheck` (to be refuted by the OTHER family under policy B).
 * PURE.
 * @param {object[]} claudeIssues
 * @param {object[]} codexIssues
 * @returns {{ agreed: object[], needsCrosscheck: { issue: object, foundBy: string, refuter: string }[] }}
 */
export function classifyFindings(claudeIssues = [], codexIssues = []) {
  const byKey = new Map();
  const order = [];

  for (const raw of claudeIssues) {
    const issue = tag(raw, "claude");
    const k = dedupKey(issue);
    if (byKey.has(k)) { mergeFamilies(byKey.get(k), "claude"); }
    else { byKey.set(k, issue); order.push(k); }
  }
  for (const raw of codexIssues) {
    const issue = tag(raw, "codex");
    const k = dedupKey(issue);
    if (byKey.has(k)) { mergeFamilies(byKey.get(k), "codex"); }
    else { byKey.set(k, issue); order.push(k); }
  }

  const agreed = [];
  const needsCrosscheck = [];
  for (const k of order) {
    const issue = byKey.get(k);
    if (issue.found_by.length >= 2) {
      agreed.push(issue);
    } else {
      const foundBy = issue.found_by[0];
      needsCrosscheck.push({ issue, foundBy, refuter: foundBy === "claude" ? "codex" : "claude" });
    }
  }
  return { agreed, needsCrosscheck };
}

/** @description Adds a family to an issue's provenance, de-duplicated. Mutates in place. */
function mergeFamilies(issue, family) {
  if (!issue.found_by.includes(family)) issue.found_by.push(family);
}

/**
 * @description Applies policy B given the refutation verdicts for the single-family findings.
 * Each verdict: { key: dedupKey, refuted: boolean, argument?: string, refuter?: string }.
 * A single-family finding survives UNLESS its verdict says refuted. Missing verdict => kept
 * (fail-open: we do not silently drop a finding because the cross-check could not run — e.g. the
 * refuter family was unavailable in headless).
 * @param {{ agreed: object[], needsCrosscheck: {issue:object, foundBy:string, refuter:string}[] }} classified
 * @param {{ key: string, refuted: boolean, argument?: string, refuter?: string }[]} verdicts
 * @returns {{ findings: object[], dropped: object[] }}
 */
export function finalizeFindings(classified, verdicts = []) {
  const verdictByKey = new Map(verdicts.map((v) => [v.key, v]));
  const findings = [...classified.agreed];
  const dropped = [];

  for (const { issue } of classified.needsCrosscheck) {
    const v = verdictByKey.get(dedupKey(issue));
    if (v && v.refuted === true) {
      dropped.push({ ...issue, refuted_by: v.refuter, refutation: v.argument });
    } else {
      findings.push(v ? { ...issue, crosscheck: { refuted: false, argument: v.argument } } : issue);
    }
  }
  return { findings, dropped };
}

/**
 * @description Reads an issues envelope from disk. Accepts either the bridge envelope
 * ({ available, issues }) or a bare { issues } / array. Returns issues[] (possibly empty).
 * @param {string} path
 * @returns {object[]}
 */
export function readIssues(path) {
  const data = JSON.parse(readFileSync(resolveCwd(path), "utf8"));
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.issues)) return data.issues;
  return [];
}

function resolveCwd(p) {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

// ---------------------------------------------------------------------------
// CLI: node merge-findings.mjs --claude <claude.json> --codex <codex.json>
//   Emits { agreed, needsCrosscheck } so the orchestrator can dispatch refutations,
//   then call finalizeFindings with the collected verdicts.
// ---------------------------------------------------------------------------
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
  const claudeIssues = claude ? readIssues(claude) : [];
  const codexIssues = codex ? readIssues(codex) : [];
  const classified = classifyFindings(claudeIssues, codexIssues);
  process.stdout.write(JSON.stringify(classified, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("merge-findings.mjs")) {
  main();
}
