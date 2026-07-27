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
  "adversary-family-1.md",
  "adversary-family-2.md",
  "plan-reviewer.md",
  "plan-reviewer-openai.md",
  "plan-reviewer-family-1.md",
  "plan-reviewer-family-2.md",
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
 * @description Edit/bash matrix per oc-agents-permission-parity (issue #472): planner is the only
 * eye with edit: allow (parity write access; the plan JSON is still persisted by the
 * planner-recovery plugin, never by the planner itself); compliance, security, and planner have
 * bash: allow (audit/exploration parity); every other eye keeps edit: deny and bash: deny.
 */
test("lt-eyes-edit-deny-and-noncompliance-bash-deny", () => {
  const EDIT_ALLOWED = new Set(["planner.md"])
  const BASH_ALLOWED = new Set(["compliance.md", "security.md", "planner.md"])
  for (const f of EYE_FILES) {
    const perms = extractPermissions(readAgent(f))
    if (EDIT_ALLOWED.has(f)) {
      assert.strictEqual(perms.edit, "allow", `${f} must have edit: allow`)
    } else {
      assert.strictEqual(perms.edit, "deny", `${f} must have edit: deny`)
    }
    if (BASH_ALLOWED.has(f)) {
      assert.strictEqual(perms.bash, "allow", `${f} must have bash: allow`)
    } else {
      assert.strictEqual(perms.bash, "deny", `${f} must have bash: deny`)
    }
  }
})
