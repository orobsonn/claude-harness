/**
 * @description Cost report for a harness delivery — wraps `ccusage` to surface the
 * per-session API-equivalent cost (with model breakdown) and the weekly consumption
 * trend. The weekly figure spans ALL Claude Code usage (ccusage reads every project
 * transcript), so it is a real total-consumption proxy — NOT a subscription %, which
 * is opaque and model-weighted. Fail-soft: if ccusage is unreachable (offline / cloud
 * headless), returns a graceful "indisponível" notice instead of throwing.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const CCUSAGE_TIMEOUT_MS = 120000;

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const intBR = (n) => Number(n || 0).toLocaleString("pt-BR");

/**
 * Runs a ccusage subcommand via npx and returns parsed JSON, or null on any failure.
 * @param {string} subcommand - ccusage subcommand (e.g. 'session', 'weekly')
 * @returns {object | null}
 */
function runCcusage(subcommand) {
  try {
    const out = execFileSync("npx", ["-y", "ccusage@latest", subcommand, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CCUSAGE_TIMEOUT_MS,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Picks the session entry to report: by id (ccusage `period`) when provided,
 * otherwise the most-recently-active session (the live run during a harvest).
 * @param {object | null} sessionJson - parsed `ccusage session --json`
 * @param {string | null} sessionId - session id to match, or null for most-recent
 * @returns {object | null} the chosen session entry, or null when none exist
 */
export function pickSession(sessionJson, sessionId) {
  const sessions = Array.isArray(sessionJson?.session) ? sessionJson.session : [];
  if (sessions.length === 0) return null;
  if (sessionId) {
    const match = sessions.find((s) => s.period === sessionId);
    if (match) return match;
  }
  return sessions.reduce((latest, s) => {
    const t = Date.parse(s?.metadata?.lastActivity ?? "") || 0;
    const lt = Date.parse(latest?.metadata?.lastActivity ?? "") || 0;
    return t >= lt ? s : latest;
  });
}

/**
 * Pure formatter — produces the pt-br product-language cost summary.
 * @param {{ session: object | null, weekly: object | null }} input
 * @returns {string} markdown summary (never throws)
 */
export function formatCostReport({ session, weekly }) {
  const lines = ["## Custo da entrega", ""];

  if (!session) {
    lines.push("- **Sessão**: custo indisponível (ccusage não acessível neste ambiente).");
  } else {
    lines.push(`- **Sessão**: ${usd(session.totalCost)} (${intBR(session.totalTokens)} tokens)`);
    const breakdowns = Array.isArray(session.modelBreakdowns) ? session.modelBreakdowns : [];
    for (const b of breakdowns) {
      lines.push(`  - ${b.modelName}: ${usd(b.cost)}`);
    }
    lines.push("  - _custo equivalente-API; sub-agentes têm transcript próprio e contam no total da semana abaixo._");
  }

  lines.push("");
  const weeks = Array.isArray(weekly?.weekly) ? weekly.weekly : [];
  if (weeks.length === 0) {
    lines.push("- **Semana**: indisponível.");
  } else {
    const current = weeks[weeks.length - 1];
    const prev = weeks.length > 1 ? weeks[weeks.length - 2] : null;
    lines.push(`- **Semana atual** (todo o uso do Claude Code, todos os projetos): ${usd(current.totalCost)}`);
    if (prev) {
      const delta = (Number(current.totalCost) || 0) - (Number(prev.totalCost) || 0);
      const arrow = delta >= 0 ? "▲" : "▼";
      lines.push(`  - vs. semana anterior ${usd(prev.totalCost)} → ${arrow} ${usd(Math.abs(delta))}`);
    }
    lines.push("  - _consumo real relativo, não % da subscription (que é opaca)._");
  }

  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const idIdx = args.indexOf("--session-id");
  const sessionId = idIdx >= 0 ? args[idIdx + 1] : null;
  const session = pickSession(runCcusage("session"), sessionId);
  const weekly = runCcusage("weekly");
  process.stdout.write(formatCostReport({ session, weekly }) + "\n");
}

function isDirectCli() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === modulePath;
  } catch {
    return process.argv[1] === modulePath;
  }
}

if (isDirectCli()) main();
