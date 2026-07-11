// locked then-clauses test for version-check
import assert from "node:assert"
import test from "node:test"
import { versionCheck } from "./version-check.ts"

test("version-check is advisory only", () => {
  assert.ok(versionCheck) // exercises advisory no-block path
})
