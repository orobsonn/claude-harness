/** @description Pure marker helpers plus an observability-only CLI. No privileged mutation API. */

import { spawnSync } from "node:child_process";
import { eventForTaskExecuting, obsAppend, dedupeByType } from "./obs-emit.mjs";

/** @description Build feature/task or feature/task@sha marker identity. */
export function fidelityPassEntry(featureId, taskId, sha) {
  const base = `${featureId}/${taskId}`;
  return typeof sha === "string" && sha.length > 0 ? `${base}@${sha}` : base;
}

/** @description Best-effort HEAD sha for SHA-qualified marker identity. */
export function defaultHeadSha(cwd = process.cwd()) {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    if (result.status !== 0) return null;
    const sha = String(result.stdout ?? "").trim();
    return sha || null;
  } catch {
    return null;
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("mark-gate.mjs") || process.argv[1].endsWith("mark-gate"));

if (isMain) {
  const [, , action, ...rest] = process.argv;
  const args = Object.fromEntries(
    rest.map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1]] : null).filter(Boolean),
  );
  const privileged = new Set([
    "brainstormed", "adversary_fired", "fidelity", "dual", "regate-pending",
    "regate-passed", "hand-finished", "capture-verified", "final-review", "demo-done",
  ]);
  let result;
  if (privileged.has(action)) {
    result = { ok: false, reason: "privileged markers require a host-issued native OpenCode tool context; ordinary shell is observability-only" };
  } else if (action === "task-executing") {
    const event = eventForTaskExecuting({ n: args.n, total: args.total });
    if (!event) result = { ok: false, reason: "task-executing requires --n <int>=1 and --total <int>=1" };
    else {
      obsAppend(event);
      result = { ok: true };
    }
  } else if (action === "plan-reviewed") {
    const verdict = String(args.verdict || "").toUpperCase();
    if (verdict !== "APPROVE" && verdict !== "REVISE") result = { ok: false, reason: "plan-reviewed requires --verdict APPROVE|REVISE" };
    else {
      obsAppend({ type: "plan-reviewed", verdict }, { dedupe: dedupeByType });
      result = { ok: true };
    }
  } else if (action === "spec-adversaried") {
    const findings = Number(args.findings ?? 0);
    if (!Number.isFinite(findings) || findings < 0) {
      result = { ok: false, reason: "spec-adversaried requires --findings <int>=0" };
    } else {
      // Obs wire only. Prefer findings count; optional legacy --verdict is accepted but never taught to eyes.
      const raw = String(args.verdict || "").toUpperCase();
      const verdict = raw === "BLOCK" || raw === "DIRTY" || findings > 0 ? "BLOCK" : "SHIP";
      obsAppend({ type: "spec-adversaried", verdict, findings });
      result = { ok: true };
    }
  } else if (action === "final-review-done") {
    obsAppend({ type: "final-review-done" }, { dedupe: dedupeByType });
    result = { ok: true };
  } else {
    result = { ok: false, reason: "usage: mark-gate.mjs task-executing|plan-reviewed|spec-adversaried|final-review-done ..." };
  }
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true }));
}

export default { fidelityPassEntry, defaultHeadSha };
