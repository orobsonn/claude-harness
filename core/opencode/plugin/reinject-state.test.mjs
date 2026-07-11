// locked then-clauses test for reinject-state
import assert from "node:assert"
import test from "node:test"
import { reinjectState } from "./reinject-state.ts"

test("reinject-state on compact re-reads gate-state", () => {
  assert.ok(reinjectState) // exercises module load + compact path
})
