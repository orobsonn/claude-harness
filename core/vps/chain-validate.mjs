/**
 * @description Roadmap DAG linter for the VPS cron harness's merge-driven chaining. The runtime
 * (chain-release + cron-a-select) safely ORDERS a well-formed roadmap and strands a subtree under a
 * dead dependency, but two AUTHORING mistakes would otherwise strand issues SILENTLY forever with no
 * dead dependency to trigger a notification:
 *   - a dependency CYCLE (A depends on B, B depends on A) — neither can ever merge, so both stay
 *     `harness:queued` indefinitely;
 *   - a DANGLING dependency (`#9999`, a typo or a non-harness/closed issue that will never carry a
 *     merged `harness/<n>` PR) — the dependent waits on a PR that can never appear.
 *
 * This module is the pre-flight lint the operator runs after building a roadmap
 * (`node core/vps/chain-validate.mjs --config <project.json>`): it reads the open harness issues,
 * extracts each one's declared dependencies, and reports every cycle and dangling reference BEFORE
 * the engine runs — turning a silent stall into an authoring error caught up front. The core
 * `validateRoadmap` transform is pure (no gh/process) so it is fully unit-testable; the CLI is the
 * thin production wiring.
 */
import { spawnSync } from "node:child_process";

import { parseDependsOn } from "./chain-deps.mjs";
import { loadConfig } from "./run-cron-a.mjs";
import { scopedGh, defaultGhExec } from "./gh-exec.mjs";

/**
 * @description Pure DAG validation over a roadmap's declared dependencies. Detects dependency cycles
 * (via DFS gray-stack back-edge detection, de-duplicated by member set so the same cycle reported
 * from different entry points appears once) and dangling references (a declared dependency whose
 * issue number is not among the known issues). A dangling edge is EXCLUDED from cycle traversal so a
 * typo can never masquerade as a cycle.
 * @param {Array<{number: number, deps: number[]}>} issues
 * @returns {{cycles: number[][], dangling: Array<{issue: number, missing: number[]}>}}
 */
export function validateRoadmap(issues) {
  const known = new Set(issues.map((i) => i.number));
  const depMap = new Map(issues.map((i) => [i.number, (i.deps || []).filter((d) => Number.isInteger(d) && d > 0)]));

  const dangling = [];
  for (const issue of issues) {
    const missing = (issue.deps || []).filter((d) => Number.isInteger(d) && d > 0 && !known.has(d));
    if (missing.length > 0) {
      dangling.push({ issue: issue.number, missing });
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...known].map((n) => [n, WHITE]));
  const stack = [];
  const cycleByKey = new Map();

  function visit(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of depMap.get(node) || []) {
      if (!known.has(dep)) continue; // dangling — reported separately, never traversed
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        const idx = stack.indexOf(dep);
        const cycle = stack.slice(idx);
        const key = [...cycle].sort((a, b) => a - b).join(",");
        if (!cycleByKey.has(key)) cycleByKey.set(key, cycle);
      } else if (depColor === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of known) {
    if (color.get(node) === WHITE) visit(node);
  }

  return { cycles: [...cycleByKey.values()], dangling };
}

/**
 * @description Builds the `{number, deps}` roadmap graph from a gh issue list by parsing each open
 * issue's `harness-deps` block. Scans ALL open issues (any harness state) so a dependency that has
 * already moved to in-progress/in-review/done still counts as a KNOWN issue, not a dangling one.
 * @param {(args: string[]) => any} gh
 * @returns {Array<{number: number, deps: number[]}>}
 */
export function buildRoadmapGraph(gh) {
  const issues = gh(["issue", "list", "--state", "open", "--limit", "500", "--json", "number,body"]) || [];
  return issues.map((issue) => ({ number: issue.number, deps: parseDependsOn(issue.body) }));
}

/**
 * @description Renders a human-readable lint report. Empty problems → a single clean line.
 * @param {{cycles: number[][], dangling: Array<{issue: number, missing: number[]}>}} report
 * @returns {string}
 */
export function formatReport(report) {
  const lines = [];
  if (report.cycles.length === 0 && report.dangling.length === 0) {
    return "Roadmap OK — sem ciclos nem dependências inexistentes.";
  }
  for (const cycle of report.cycles) {
    lines.push(`CICLO: ${cycle.map((n) => `#${n}`).join(" → ")} → #${cycle[0]} (nenhuma issue do ciclo pode merjar)`);
  }
  for (const { issue, missing } of report.dangling) {
    lines.push(`DEPENDÊNCIA INEXISTENTE: issue #${issue} depende de ${missing.map((n) => `#${n}`).join(", ")} — não existe(m) entre as issues abertas`);
  }
  return lines.join("\n");
}

/**
 * @description CLI entry: reads the project config, lists open harness issues, validates the DAG,
 * prints the report, and exits non-zero when any problem is found (so it can gate a roadmap in CI
 * or a pre-flight script). Every seam defaults to real wiring but is injectable for tests.
 * @param {object} config
 * @param {object} [deps]
 * @returns {{ok: boolean, report: {cycles: number[][], dangling: Array<{issue: number, missing: number[]}>}}}
 */
export function runValidate(config, deps = {}) {
  const ghExec = deps.ghExec ?? defaultGhExec;
  const gh = deps.gh ?? scopedGh(config.owner, config.repo, ghExec);
  const log = deps.log ?? console.error;

  const graph = buildRoadmapGraph(gh);
  const report = validateRoadmap(graph);
  log(formatReport(report));
  return { ok: report.cycles.length === 0 && report.dangling.length === 0, report };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = process.argv[2];
  const configPath = arg === "--config" ? process.argv[3] : arg;
  try {
    const { ok } = runValidate(loadConfig(configPath));
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`chain-validate: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
