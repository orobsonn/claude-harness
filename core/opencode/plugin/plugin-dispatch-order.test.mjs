/**
 * @description Regression tripwire for the Task-dispatch plugin chain order (issue #478
 * ac-1.*). OpenCode auto-globs `core/opencode/plugin/*.{ts,js}` with no sort (upstream
 * node-glob, nosort) — the real walk order is raw filesystem/readdir order, which is NOT
 * portable across OS/filesystems (verified: this repo's checkout gives ascending-alphabetical
 * on macOS/APFS, and docs/OC-CC-PARITY-REPORT.md measured descending-alphabetical on the
 * report author's environment). Reproducing that raw order here would make this test flaky
 * across machines/CI, so this test asserts the one property that IS portable and that a
 * rename of one of the 5 tracked files actually breaks: each file's name-sorted position
 * relative to the others. Scope, honestly stated: this catches a rename/removal of
 * `planner-recovery.ts`, `plan-gate.ts`, `obs-hand.ts`, `loop-guard.ts`, or `entry-gate.ts`
 * that changes their relative alphabetical order. It does NOT reproduce the real node-glob
 * nosort walk, so it canNOT catch a 6th plugin file joining the directory and shifting the
 * true unsorted walk order without touching any of the 5 tracked names — that residual gap is
 * exactly why docs/OC-CC-PARITY-ROADMAP-INPUT.md item #16 keeps a numeric-prefix/explicit-loader
 * follow-up open for "when a 6th plugin enters the chain".
 */
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { basename, dirname, extname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const pluginDir = dirname(fileURLToPath(import.meta.url))

/**
 * The Task-dispatch chain that actually gates a dispatch, in the order the operator
 * experiences a deny (first throw wins) — see AGENTS.md §12 for the human-readable doc.
 */
const DISPATCH_CHAIN_ORDER = ["planner-recovery", "plan-gate", "obs-hand", "loop-guard", "entry-gate"]

/**
 * Sorted-then-reversed basenames of every auto-globbed plugin file — a deterministic,
 * portable proxy for the documented order (see the module docstring for why raw readdir
 * order is not used directly).
 */
function pluginDiscoveryOrder() {
  return readdirSync(pluginDir)
    .filter((name) => /\.(ts|js)$/.test(name))
    .map((name) => basename(name, extname(name)))
    .sort()
    .reverse()
}

test("Task dispatch chain discovery order matches the documented sequence (ac-1.1)", () => {
  const observed = pluginDiscoveryOrder().filter((name) => DISPATCH_CHAIN_ORDER.includes(name))
  assert.deepEqual(
    observed,
    DISPATCH_CHAIN_ORDER,
    "plugin discovery order changed — a rename/add/remove reordered the Task dispatch gates. " +
      "Update AGENTS.md §12 and DISPATCH_CHAIN_ORDER together only after confirming the new order is intentional.",
  )
})

test("all 5 documented dispatch-chain files exist in core/opencode/plugin", () => {
  const files = readdirSync(pluginDir).filter((name) => /\.(ts|js)$/.test(name))
  for (const name of DISPATCH_CHAIN_ORDER) {
    assert.ok(files.includes(`${name}.ts`) || files.includes(`${name}.js`), `missing plugin file for ${name}`)
  }
})

test("AGENTS.md §12 documents the exact same order as DISPATCH_CHAIN_ORDER (ac-1.2)", () => {
  const agentsMdPath = join(pluginDir, "..", "AGENTS.md")
  const content = readFileSync(agentsMdPath, "utf8")
  const match = content.match(/^([a-z][a-z-]*(?: → [a-z][a-z-]*)+)$/m)
  assert.ok(match, `AGENTS.md must document the dispatch chain as a "a → b → c" line (checked ${agentsMdPath})`)
  const documented = match[1].split("→").map((name) => name.trim())
  assert.deepEqual(
    documented,
    DISPATCH_CHAIN_ORDER,
    "AGENTS.md §12 order diverged from DISPATCH_CHAIN_ORDER — ac-1.2 requires them to match exactly.",
  )
})
