import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { ambiguouslyAdjudicatedSources, loadMatrix, unadjudicatedSources, validateMatrix } from "./capability-matrix.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const RUNTIME_ROOTS = ["core/claude-code", "core/opencode", "core/shared", "core/github", "core/orca"];

function productionFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    if (entry.name.endsWith(".test.mjs") || entry.name === ".DS_Store") return [];
    return [relative(ROOT, path).replaceAll("\\", "/")];
  });
}

test("every production runtime surface is adjudicated once", () => {
  const matrix = loadMatrix();
  const sources = RUNTIME_ROOTS.flatMap((dir) => productionFiles(join(ROOT, dir)));

  assert.deepEqual(validateMatrix(matrix), []);
  assert.deepEqual(unadjudicatedSources(matrix, sources), []);
  assert.deepEqual(ambiguouslyAdjudicatedSources(matrix, sources), [], "a source must receive one portability verdict, not a broad overlapping label");
});

test("matrix distinguishes narrow deterministic hooks, prose, and honest residuals without overstating hook parity", () => {
  const matrix = loadMatrix();

  assert.equal(matrix.filter((row) => row.category === "hooks" && row.status === "deterministic").length, 2, "only version and lavish rails are ported deterministically");
  assert.ok(matrix.some((row) => row.id === "cc-hook-state-engine" && row.status === "intentionally-omitted"));
  assert.ok(existsSync(join(ROOT, "core/codex/hooks/policy.mjs")), "the narrow policy rail is tested separately");
  assert.ok(matrix.some((row) => row.category === "agents" && row.status === "native"));
  assert.ok(matrix.some((row) => row.category === "skills" && row.status === "prose"));
  assert.ok(matrix.some((row) => row.status === "unsupported"));
  assert.ok(matrix.some((row) => row.status === "intentionally-omitted"));
  assert.ok(matrix.every((row) => row.codex_surface && row.verification && row.residual_risk));
});

test("matrix source patterns resolve against the checked-in production tree", () => {
  const matrix = loadMatrix();
  for (const row of matrix) {
    assert.ok(
      RUNTIME_ROOTS.flatMap((dir) => productionFiles(join(ROOT, dir))).some((source) =>
        row.source_patterns.some((pattern) => new RegExp(pattern).test(source))
      ),
      `${row.id} has no checked-in source match`
    );
  }
});
