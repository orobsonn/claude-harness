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

/**
 * @description The merge's own arming resolution. A Symbol so a model-emitted `arming` key cannot forge
 * it: the agent contracts state the declaration lives at the head of `description` and NEVER as a JSON
 * field, and this keeps that true at the boundary instead of merely asking for it.
 */
export const MERGED_ARMING = Symbol("merged_arming");

/** @description Normalizes a free-text field for dedup key construction. */
function norm(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * @description Per-shape dedup discriminators. The adversary tags every issue with a `category`
 * (failure class) — its natural discriminator. The security auditor's output has NO `category`
 * field (core/agents/security.md), so reusing `(scope, category, evidence)` would collapse to
 * `(scope, "", evidence)` and silently drop two DISTINCT security findings that share a scope +
 * evidence — losing exactly the minority catch a second family exists to surface. Security uses
 * `severity` as the discriminator instead.
 */
export const DEDUP_FIELDS = {
  findings: ["scope", "category", "evidence"],
  security: ["scope", "severity", "evidence"],
};

/**
 * @description Stable dedup key for an issue. Two issues from different families collapse when they
 * agree on every discriminator field. `fields` is per-shape (see DEDUP_FIELDS) — default is the
 * adversary's `(scope, category, evidence)`. Threaded consistently through classify + finalize +
 * the driver's refutation-key construction, so the same issue maps to the same key everywhere.
 * @param {object} issue
 * @param {string[]} [fields]
 * @returns {string}
 */
export function dedupKey(issue, fields = DEDUP_FIELDS.findings) {
  return fields.map((f) => norm(issue[f])).join("::");
}

/**
 * @description Normalizes a severity string from ANY model family to the harness enum
 * (low|medium|high). A different family may emit "Critical"/"HIGH"/"crit"; an UNKNOWN value maps to
 * "high" — conservative, so a real high is never silently demoted past a security gate.
 * @param {string} severity
 * @returns {"low"|"medium"|"high"}
 */
export function normalizeSeverity(severity) {
  const s = norm(severity);
  if (s === "low") return "low";
  if (s === "medium" || s === "med" || s === "moderate") return "medium";
  return "high"; // high, critical, crit, blocker, or anything unrecognized → conservative
}

/**
 * @description Reads the DECLARED arming axis (rules/unarmed-defects.md) off an issue, or null when the
 * issue declares nothing. The eyes declare it at the HEAD of `description` ("UNARMED · REPRO: …")
 * rather than as a JSON key, so the canonical report schema stays exact-keyed — and so a model that
 * simply invents an `arming` key cannot outrank its own prose. The merge records its OWN resolution
 * under a Symbol key that no model output can forge. PURE.
 * @param {object} issue
 * @returns {"armed"|"unarmed"|null}
 */
export function declaredArming(issue) {
  const merged = issue?.[MERGED_ARMING];
  if (merged === "unarmed" || merged === "armed") return merged;
  const head = norm(issue?.description);
  if (/^unarmed\b/.test(head)) return "unarmed";
  if (/^armed\b/.test(head)) return "armed";
  return null;
}

/**
 * @description Effective arming: an issue that declares nothing is **armed**, because the absence of a
 * classification is not a classification and "in doubt → ARMED" is the standing default. PURE.
 * @param {object} issue
 * @returns {"armed"|"unarmed"}
 */
export function armingOf(issue) {
  return declaredArming(issue) === "unarmed" ? "unarmed" : "armed";
}

/**
 * @description Recomputes the security gate verdict from a final issue list. UNSAFE when ANY **ARMED**
 * issue is high or medium (mirrors core/agents/security.md), SECURE otherwise. Severity is normalized
 * first so a cross-family "Critical" still gates.
 *
 * **Parking is OPT-IN and defaults OFF.** `honorParking: true` excludes parked (unarmed) issues, which
 * is what an ORCHESTRATOR-SUPERVISED checkpoint wants: there, a parked finding is routed away from the
 * sniper, so if it still set UNSAFE the run would deadlock — nothing changes, the next audit returns
 * UNSAFE again, forever.
 *
 * It defaults OFF because this function is NOT orchestrator-private: `core/vps/run-cron-review.mjs`
 * imports it to decide UNATTENDED auto-merge eligibility. On that path there is no orchestrator, no
 * park acceptance on the record, no operator warning, no tracked issue, and nobody verifying the rearm
 * observable is false — so an eye's own prose head must never be able to clear a merge gate. Parking
 * suppresses a fix dispatch under supervision; it never lowers a severity and never opens a merge.
 * PURE.
 * @param {object[]} issues
 * @param {{ honorParking?: boolean }} [options]
 * @returns {"SECURE"|"UNSAFE"}
 */
export function securityVerdict(issues = [], { honorParking = false } = {}) {
  const blocking = issues.some((i) => {
    if (honorParking && armingOf(i) === "unarmed") return false;
    const sev = normalizeSeverity(i?.severity);
    return sev === "high" || sev === "medium";
  });
  return blocking ? "UNSAFE" : "SECURE";
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
export function classifyFindings(claudeIssues = [], codexIssues = [], fields = DEDUP_FIELDS.findings) {
  const byKey = new Map();
  const order = [];

  for (const raw of claudeIssues) {
    const issue = tag(raw, "claude");
    const k = dedupKey(issue, fields);
    if (byKey.has(k)) { mergeFamilies(byKey.get(k), "claude", issue); }
    else { byKey.set(k, issue); order.push(k); }
  }
  for (const raw of codexIssues) {
    const issue = tag(raw, "codex");
    const k = dedupKey(issue, fields);
    if (byKey.has(k)) { mergeFamilies(byKey.get(k), "codex", issue); }
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

/**
 * @description Adds a family to an issue's provenance, de-duplicated, and reconciles the arming axis
 * across families. Mutates in place.
 *
 * The dedup key ignores `description`, so without this the first family's issue would win wholesale and
 * a cross-family DISAGREEMENT about arming would be destroyed silently — one family calling a defect
 * reachable and the other calling it parked is exactly the signal a second family exists to surface.
 * Disagreement resolves to **armed** (conservative, matching "in doubt → ARMED") and is recorded in
 * `arming_conflict` so the orchestrator can see it was contested rather than agreed.
 */
function mergeFamilies(issue, family, incoming) {
  const sameFamily = issue.found_by.includes(family);
  if (!sameFamily) issue.found_by.push(family);
  if (!incoming || sameFamily) return; // a family duplicating itself is not a cross-family disagreement
  const mine = declaredArming(issue);
  const theirs = declaredArming(incoming);
  if (mine === null || theirs === null) return; // a missing declaration is a format defect, not a contest
  if (mine === theirs) {
    issue[MERGED_ARMING] = mine;
    return;
  }
  issue[MERGED_ARMING] = "armed";
  issue.arming_conflict = {
    armed_by: mine === "armed" ? issue.found_by[0] : family,
    unarmed_by: mine === "unarmed" ? issue.found_by[0] : family,
  };
  // Make the resolution visible where every consumer actually looks. The dedup key ignores
  // `description`, so the stored text is whichever family was seen first — leaving an "UNARMED" head on
  // an issue the merge just resolved to ARMED would send the orchestrator's prose-driven triage to park
  // it, the exact outcome this reconciliation exists to prevent.
  if (mine === "unarmed") {
    issue.description = String(issue.description ?? "").replace(
      /^\s*unarmed\b/i,
      `ARMED (contested: ${issue.arming_conflict.unarmed_by} called it unarmed)`,
    );
  }
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
export function finalizeFindings(classified, verdicts = [], fields = DEDUP_FIELDS.findings) {
  const verdictByKey = new Map(verdicts.map((v) => [v.key, v]));
  const findings = [...classified.agreed];
  const dropped = [];

  for (const { issue } of classified.needsCrosscheck) {
    const v = verdictByKey.get(dedupKey(issue, fields));
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
