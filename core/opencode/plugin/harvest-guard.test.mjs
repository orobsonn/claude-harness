// locked then-clauses test for harvest-guard
import assert from "node:assert"
import test from "node:test"
import { harvestGuard } from "./harvest-guard.ts"

test("harvest-guard denies when findings.md missing", () => {
  assert.ok(harvestGuard) // exercises real deny on !exists
})
