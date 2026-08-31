import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STATUS = Object.freeze([
  "native",
  "deterministic",
  "prose",
  "unsupported",
  "intentionally-omitted",
]);

const MATRIX_PATH = fileURLToPath(new URL("./capability-matrix.json", import.meta.url));

export function loadMatrix(readFile = readFileSync) {
  const value = JSON.parse(readFile(MATRIX_PATH, "utf8"));
  return value.surfaces;
}

export function validateMatrix(matrix) {
  if (!Array.isArray(matrix)) return ["matrix must be an array"];
  const issues = [];
  const ids = new Set();

  for (const row of matrix) {
    if (!row || typeof row !== "object") {
      issues.push("row must be an object");
      continue;
    }
    if (typeof row.id !== "string" || row.id.trim() === "") issues.push("row has no id");
    else if (ids.has(row.id)) issues.push(`duplicate id: ${row.id}`);
    else ids.add(row.id);
    if (typeof row.category !== "string" || row.category.trim() === "") issues.push(`${row.id}: category missing`);
    if (!STATUS.includes(row.status)) issues.push(`${row.id}: invalid status`);
    if (!Array.isArray(row.source_patterns) || row.source_patterns.length === 0) issues.push(`${row.id}: source patterns missing`);
    else for (const pattern of row.source_patterns) {
      try { new RegExp(pattern); } catch { issues.push(`${row.id}: invalid source pattern`); }
    }
    for (const field of ["codex_surface", "verification", "residual_risk"]) {
      if (typeof row[field] !== "string" || row[field].trim() === "") issues.push(`${row.id}: ${field} missing`);
    }
  }
  return issues;
}

export function unadjudicatedSources(matrix, sources) {
  return sources.filter((source) => !matrix.some((row) =>
    row.source_patterns.some((pattern) => new RegExp(pattern).test(source))
  ));
}

/** @description Surfaces must have exactly one portability verdict, never an accidental broad overlap. */
export function ambiguouslyAdjudicatedSources(matrix, sources) {
  return sources
    .filter((source) => matrix.filter((row) => row.source_patterns.some((pattern) => new RegExp(pattern).test(source))).length > 1)
    .sort();
}

function main() {
  const matrix = loadMatrix();
  const issues = validateMatrix(matrix);
  if (issues.length > 0) {
    process.stderr.write(JSON.stringify({ ok: false, issues }, null, 2) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({ ok: true, surfaces: matrix.length }, null, 2) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
