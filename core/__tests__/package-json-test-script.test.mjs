/**
 * @description Locks package.json's scripts.test to run the SAME suite as CI
 * (core/**\/*.test.mjs AND modules/**\/*.test.mjs) — regression guard for #ac-1.1/#ac-1.2:
 * a modules/ test rotting red must be caught by `npm test`, not just by CI.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");

test("locked: package.json scripts.test covers core/**, modules/**, and scripts/** test globs", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  const testScript = pkg.scripts?.test ?? "";

  assert.ok(
    testScript.includes("core/**/*.test.mjs"),
    `scripts.test must include the core/**/*.test.mjs glob (got: ${testScript})`
  );
  assert.ok(
    testScript.includes("modules/**/*.test.mjs"),
    `scripts.test must include the modules/**/*.test.mjs glob — without it a modules/ test can rot red without npm test catching it (got: ${testScript})`
  );
  assert.ok(
    testScript.includes("scripts/**/*.test.mjs"),
    `scripts.test must include scripts/**/*.test.mjs (parity/cutover tests) (got: ${testScript})`
  );
});
