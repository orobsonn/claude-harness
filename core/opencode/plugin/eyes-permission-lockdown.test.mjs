/**
 * @description Locked tests for eyes permission lockdown in agent frontmatter (webfetch/websearch/task/edit/bash).
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const AGENTS_DIR = path.resolve(__dirname, "../agents")

const EYE_FILES = [
  "adversary.md",
  "adversary-openai.md",
  "plan-reviewer.md",
  "plan-reviewer-openai.md",
  "security.md",
  "planner.md",
  "compliance.md",
]

function readAgent(file) {
  const full = path.join(AGENTS_DIR, file)
  return fs.readFileSync(full, "utf8")
}

function extractPermissions(content) {
  // split on --- delimiters (yaml frontmatter)
  const parts = content.split(/^---\s*$/m)
  if (parts.length < 2) return {}
  const fm = parts[1] || ""
  // capture indented permission block (2+ spaces)
  const blockMatch = fm.match(/permission:\s*\n((?:\s{2,}[^\n]+\n?)+)/)
  if (!blockMatch) return {}
  const block = blockMatch[1]
  const perms = {}
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*(\w+):\s*(.+?)\s*$/)
    if (m) {
      let v = m[2].trim()
      // strip optional quotes per yaml note
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      perms[m[1]] = v
    }
  }
  return perms
}

/**
 * @description Frontmatter of each of the 7 eyes files under core/opencode/agents/ declares permission.webfetch, permission.websearch and permission.task as the string "deny".
 */
test("lt-eyes-frontmatter-denies", () => {
  const keys = ["webfetch", "websearch", "task"]
  for (const f of EYE_FILES) {
    const perms = extractPermissions(readAgent(f))
    for (const k of keys) {
      assert.strictEqual(
        perms[k],
        "deny",
        `${f} must declare permission.${k}: deny (or "deny")`,
      )
    }
  }
})

/**
 * @description compliance.md has bash: allow and edit: deny.
 */
test("lt-compliance-bash-preserved", () => {
  const perms = extractPermissions(readAgent("compliance.md"))
  assert.strictEqual(perms.bash, "allow")
  assert.strictEqual(perms.edit, "deny")
})

/**
 * @description All 7 eyes declare edit: deny; the six non-compliance eyes declare bash: deny.
 */
test("lt-eyes-edit-deny-and-noncompliance-bash-deny", () => {
  for (const f of EYE_FILES) {
    const perms = extractPermissions(readAgent(f))
    assert.strictEqual(perms.edit, "deny", `${f} must have edit: deny`)
    if (f !== "compliance.md") {
      assert.strictEqual(perms.bash, "deny", `${f} must have bash: deny`)
    }
  }
})
