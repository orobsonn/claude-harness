/** @description Prevents retired duplicate plan and observation-test helpers from returning. */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const retired = [
  "core/opencode/plugin/lib/bound-plan.mjs",
  "core/opencode/plugin/lib/bound-plan.test.mjs",
  "core/opencode/plugin/lib/obs-test-isolation.mjs",
  "core/opencode/plugin/lib/obs-test-isolation.test.mjs",
  "core/opencode/plugin/eyes-permission-lockdown.test.mjs",
];
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]); }
test("retired duplicate paths stay absent and no live source imports them", () => {
  for (const relative of retired) assert.equal(existsSync(join(root, relative)), false, relative);
  for (const file of files(join(root, "core", "opencode"))) {
    if (file.includes(".test.")) continue;
    const source = readFileSync(file, "utf8");
    assert.equal(source.includes("bound-plan.mjs"), false, file);
    assert.equal(source.includes("obs-test-isolation"), false, file);
  }
});
