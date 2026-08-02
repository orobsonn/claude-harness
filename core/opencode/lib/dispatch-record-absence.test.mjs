/** @description Prevents the retired single-slot dispatch machinery from returning to live OC code. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "docs" || entry.name === "fixtures" ? [] : sources(file);
    return /\.(?:mjs|ts|md)$/.test(entry.name) && !entry.name.includes(".test.") ? [file] : [];
  });
}

test("live OC sources contain no single-slot dispatch or composition registry", () => {
  for (const file of sources(join(root, "core", "opencode"))) {
    const source = readFileSync(file, "utf8");
    for (const term of ["active_dispatch", "cleanup_pending", "scope-runtime-composition"]) {
      assert.equal(source.includes(term), false, `retired ${term} remains in ${file}`);
    }
  }
});
