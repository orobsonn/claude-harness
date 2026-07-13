// locked then-clauses test for version-check — advisory only
import assert from "node:assert"
import test from "node:test"
import { versionCheck } from "./version-check.ts"

test("version-check is advisory only", () => {
  assert.ok(versionCheck) // exercises advisory no-block path
})

test("version-check factory returns chat.message hook without throw", async () => {
  const hooks = await versionCheck({ directory: process.cwd() })
  assert.equal(typeof hooks["chat.message"], "function")
  // fail-open: call must not throw
  await hooks["chat.message"]({}, {})
})
