/** @description Guards removal of the OC-only ceremony coordinator API and runtime. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const retiredPaths = [
  "core/opencode/plugin/ceremony-coordinator.ts",
  "core/opencode/plugin/ceremony-coordinator.test.mjs",
  "core/opencode/skills/orchestrating-delivery/ceremony-runtime.mjs",
  "core/opencode/skills/orchestrating-delivery/ceremony-runtime.test.mjs",
];

function liveSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "fixtures" || entry.name === "docs" ? [] : liveSourceFiles(file);
    return /\.(?:mjs|ts|md)$/.test(entry.name) && !entry.name.includes(".test.") ? [file] : [];
  });
}

test("ceremony coordinator paths stay absent", () => {
  for (const relativePath of retiredPaths) {
    assert.equal(existsSync(join(repositoryRoot, relativePath)), false, `retired ceremony path remains: ${relativePath}`);
  }
});

test("live OC sources contain no ceremony-next API consumer", () => {
  const liveFiles = [join(repositoryRoot, "core/opencode/docs/OPERATOR-GUIDE.md")];
  // #807: `core/vps` retired and was deleted; #834 then retired and deleted `core/notify/` (the
  // notify modules extracted from it, which had briefly taken its place in this scan) — see
  // docs/vps-retirement.md. Neither root needs a scan entry any more: nothing lives there.
  for (const root of ["core/opencode", "core/shared", "scripts"]) {
    liveFiles.push(...liveSourceFiles(join(repositoryRoot, root)));
  }

  for (const file of liveFiles) {
    const source = readFileSync(file, "utf8");
    for (const term of ["ceremony-next", "ceremony-coordinator", "ceremony-runtime", "coordinator_step", "completion_transition"]) {
      assert.equal(source.includes(term), false, `live source retains ${term}: ${file}`);
    }
  }
});
