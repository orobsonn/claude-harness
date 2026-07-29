/**
 * @description Locked tests for eyes permission lockdown in agent frontmatter (webfetch/websearch/task/edit/bash),
 * plus (issue #516) a repo-wide anti-drift lock on permission.bash overrides in ANY core/opencode/agents/*.md
 * frontmatter: OpenCode resolves permission.bash with Array.prototype.findLast (last match wins), and agent
 * frontmatter is merged AFTER the global ruleset — so a "bash: allow" scalar or a "*": allow entry inside a
 * nested permission.bash map makes every deny in the global DANGEROUS_BASH_DENYLIST (core/vps/cron-a-dispatch.mjs)
 * unreachable for that agent. The fleet dispatches via `opencode run --agent build`, so this was reachable in
 * production for all 12 agents fixed by #516. Shared mode-all hands remain covered by the
 * repo-wide scan after their CLI spawn twins were retired.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const AGENTS_DIR = path.resolve(__dirname, "../agents")

/**
 * @description No agent in this allowlist today — an explicit permission.bash override in agent frontmatter
 * always ends up LAST in OpenCode's findLast resolution, so it can only ever WIDEN access relative to the
 * global ruleset, never narrow it (a narrower per-agent bash policy belongs in a nested map with "*": "deny"
 * plus explicit narrow allows, like plan.md's git-readonly map, which this lock permits — see
 * bashPermissionViolation below). If a future agent genuinely needs a global-deny bash command allowed, add
 * it here with a comment citing why the global posture doesn't already cover it; never default to blanket allow.
 */
const BASH_OVERRIDE_ALLOWLIST = new Set([])

/**
 * @description Strips a trailing ` #comment` from a YAML line. Naive (no quote-awareness — a literal
 * ` #` inside a quoted scalar would also be stripped), acceptable for this repo's own hand-authored
 * frontmatter, which never puts `#` inside a permission value.
 */
function stripYamlComment(line) {
  const idx = line.indexOf(" #")
  return idx === -1 ? line : line.slice(0, idx)
}

/**
 * @description Extracts the `permission:` YAML section from frontmatter as either `{ inline }` (text
 * after `permission:` on the SAME line, e.g. a flow-map `permission: {bash: allow}`) or `{ block }`
 * (the joined, comment-stripped body lines that are more-indented than `permission:` itself). Blank
 * and comment-only lines INSIDE the block are skipped, not treated as the end of the block — an
 * earlier version anchored the whole capture on `[ \t]+[^\n]*\n?` repeated, which silently truncated
 * at the first blank/unindented-comment line, hiding every entry after it (including a real
 * `bash: allow`) from every caller.
 * @returns {{ inline: string } | { block: string } | null}
 */
function extractPermissionSection(content) {
  const parts = content.split(/^---\s*$/m)
  if (parts.length < 2) return null
  const rawLines = (parts[1] || "").split("\n")
  for (let i = 0; i < rawLines.length; i++) {
    const line = stripYamlComment(rawLines[i])
    const m = line.match(/^(\s*)permission:\s*(.*)$/)
    if (!m) continue
    const indent = m[1].length
    const rest = m[2].trim()
    if (rest.length > 0) return { inline: rest }
    const bodyLines = []
    for (let j = i + 1; j < rawLines.length; j++) {
      const sub = stripYamlComment(rawLines[j])
      if (sub.trim() === "") continue
      const subIndent = sub.match(/^(\s*)/)[1].length
      if (subIndent <= indent) break
      bodyLines.push(sub)
    }
    return { block: bodyLines.join("\n") }
  }
  return null
}

/**
 * @description Strips a single layer of matching double OR single YAML quotes from a scalar.
 */
function normalizeYamlScalar(raw) {
  const v = raw.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * @description Scans `text` — either the inline body of a YAML flow-map (`{...}`, braces stripped by the
 * caller) or the joined body lines of a YAML block map — for a `key: value` pair matching `wantKey`
 * (normalized) with value `"allow"`, in any quoting style (double, single, unquoted), comma- or
 * newline-separated.
 */
function hasAllowEntry(text, wantKey) {
  const pairs = text.split(/[,\n]/)
  for (const pair of pairs) {
    const m = pair.match(/^\s*("[^"]*"|'[^']*'|[^:\s]+)\s*:\s*("[^"]*"|'[^']*'|\{[^}]*\}|[^,\s]+)\s*$/)
    if (!m) continue
    const key = normalizeYamlScalar(m[1])
    if (key !== wantKey) continue
    const rawValue = m[2].trim()
    if (rawValue.startsWith("{")) {
      // key: {nested flow-map} — only relevant for a top-level `bash: {...}` found via the inline
      // permission form; recurse looking for a wildcard allow inside it.
      if (hasAllowEntry(rawValue.slice(1, -1), "*")) return true
      continue
    }
    if (normalizeYamlScalar(rawValue) === "allow") return true
  }
  return false
}

/**
 * @description Whether `blockText` (already comment-stripped body lines of a YAML block map) declares
 * a `"*": allow` pair at its OWN top level — i.e. a direct key of the map, not nested under some other
 * key. A tool-level `permission: {"*": allow, ...}` shadows every OTHER tool's resolution the exact
 * same way a `bash: allow` shadows bash specifically (OpenCode resolves per-tool: `match(toolName,
 * z.permission) && match(command, z.pattern)`), so it is an equally load-bearing override to catch.
 */
function hasTopLevelWildcardAllow(blockText) {
  const lines = blockText.split("\n").filter((l) => l.trim() !== "")
  if (lines.length === 0) return false
  const baseIndent = lines[0].match(/^(\s*)/)[1].length
  const topLines = lines
    .filter((l) => l.match(/^(\s*)/)[1].length === baseIndent)
    .map((l) => l.trim())
  return hasAllowEntry(topLines.join("\n"), "*")
}

/**
 * @description Scans an agent's frontmatter for a permission override that would shadow the global
 * bash denylist: a top-level `permission.bash: allow` scalar (any quoting, block or inline
 * `permission:` style, with or without a trailing comment), a `"*": allow` entry inside a nested
 * `bash:` map (block or same-line flow-map, any quoting), or a bare top-level `"*": allow` directly
 * under `permission:` (shadows EVERY tool, bash included, the same way). A nested map whose wildcard
 * stays `deny` (e.g. plan.md: `bash: {"*": deny, "git log*": allow, ...}`) is NOT a violation — it
 * narrows, it does not widen, so it cannot shadow a future global deny.
 *
 * Not a general YAML parser — a hand-rolled regex scan over this repo's own hand-authored frontmatter,
 * so it does not handle every YAML form (e.g. a flow-map split across multiple lines, or a `#` inside
 * a quoted value). It is defense-in-depth for a narrow, fully-controlled fixture set, not a substitute
 * for the choke-point in `core/opencode/plugin/entry-gate.ts` (Part 3 of issue #516), which re-checks
 * the raw command independently of how this frontmatter parses.
 * @returns {string|null} A human-readable description of the violation, or null if none found.
 */
function bashPermissionViolation(content) {
  const section = extractPermissionSection(content)
  if (!section) return null
  if ("inline" in section) {
    // permission: {bash: allow, ...} or permission: {bash: {"*": allow}, ...} or permission: {"*": allow, ...}
    const inlineBody = section.inline.match(/^\{(.*)\}$/)?.[1] ?? section.inline
    if (hasAllowEntry(inlineBody, "bash") || hasAllowEntry(inlineBody, "*")) {
      return `permission override inside inline permission flow-map ("permission: ${section.inline}")`
    }
    return null
  }
  if (hasTopLevelWildcardAllow(section.block)) {
    return `top-level permission."*": allow shadows every tool including bash (issue #516)`
  }
  const lines = section.block.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const bashLineMatch = line.match(/^(\s*)bash:\s*(.*)$/)
    if (!bashLineMatch) continue
    const indent = bashLineMatch[1].length
    const rest = bashLineMatch[2].trim()
    if (rest.length === 0) {
      // Block map on the following more-indented lines (blank/comment lines already stripped).
      const subLines = []
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j]
        const subIndent = sub.match(/^(\s*)/)[1].length
        if (subIndent <= indent) break
        subLines.push(sub.trim())
      }
      if (hasAllowEntry(subLines.join("\n"), "*")) {
        return `permission.bash["*"]: allow inside nested block map (under "${line.trim()}")`
      }
      continue
    }
    const scalarValue = normalizeYamlScalar(rest)
    if (scalarValue === "allow") return `top-level "bash: allow" scalar ("${line.trim()}")`
    const flowMapMatch = rest.match(/^\{(.*)\}$/)
    if (flowMapMatch && hasAllowEntry(flowMapMatch[1], "*")) {
      return `permission.bash["*"]: allow inside inline flow map ("${line.trim()}")`
    }
  }
  return null
}

/**
 * @description Unit coverage for `bashPermissionViolation` itself, against synthetic fixtures — without
 * this, a regression that made the detector always return `null` would leave `lt-no-agent-bash-override-drift`
 * green while the lock silently stopped catching anything.
 */
test("lt-bash-permission-violation-detector: catches every override shape, ignores every safe shape", () => {
  const frontmatter = (permissionBody) =>
    `---\ndescription: x\npermission:\n${permissionBody}---\n\n# body\n`

  const violations = [
    ["scalar bash: allow", "  bash: allow\n"],
    ["scalar bash: \"allow\" (double-quoted)", '  bash: "allow"\n'],
    ["scalar bash: 'allow' (single-quoted)", "  bash: 'allow'\n"],
    ["nested block map, unquoted wildcard", '  bash:\n    "*": allow\n    "git log*": deny\n'],
    ["nested block map, single-quoted wildcard", "  bash:\n    '*': allow\n"],
    ["nested block map, unquoted key and value", "  bash:\n    *: allow\n"],
    ["inline flow map, double-quoted", '  bash: {"*": "allow"}\n'],
    ["inline flow map, single-quoted", "  bash: {'*': allow}\n"],
    // Adversarial sweep (issue #516 review round) — each of these previously slipped past the detector.
    ["scalar bash: allow with a trailing inline comment", "  bash: allow # roda a suite\n"],
    ["scalar bash: allow after a BLANK line inside the permission block", "  edit: deny\n\n  bash: allow\n"],
    ["scalar bash: allow after a comment-only line inside the permission block", "  edit: deny\n  # nota\n  bash: allow\n"],
    ["nested block map wildcard allow, separated from bash: by a blank line", '  bash:\n    "git log*": deny\n\n    "*": allow\n'],
    ["bare top-level \"*\": allow directly under permission: (shadows every tool, not just bash)", '  "*": allow\n  edit: deny\n'],
    ["bare top-level *: allow, unquoted", "  *: allow\n  edit: deny\n"],
  ]
  for (const [label, body] of violations) {
    assert.notStrictEqual(bashPermissionViolation(frontmatter(body)), null, label)
  }
  assert.notStrictEqual(
    bashPermissionViolation("---\ndescription: x\npermission: {bash: allow}\n---\n"),
    null,
    "whole permission: as a single-line inline flow-map with bash: allow",
  )
  assert.notStrictEqual(
    bashPermissionViolation('---\ndescription: x\npermission: {"*": "allow", edit: "deny"}\n---\n'),
    null,
    "whole permission: as a single-line inline flow-map with top-level \"*\": allow",
  )

  const safe = [
    ["scalar bash: deny", "  bash: deny\n"],
    ["nested block map, wildcard deny + narrow allow (plan.md shape)", '  bash:\n    "*": deny\n    "git log*": allow\n'],
    ["inline flow map, wildcard deny", '  bash: {"*": "deny", "echo *": "allow"}\n'],
    ["no bash key at all", "  edit: allow\n"],
    ["top-level \"*\": deny (plan.md/discussion-adversary.md/harness-config.md shape)", '  "*": deny\n  edit: deny\n  bash: deny\n'],
    ["nested read: {\"*\": allow} is unrelated to bash and not flagged", '  "*": deny\n  bash: deny\n  read:\n    "*": allow\n    "**/.env*": deny\n'],
  ]
  for (const [label, body] of safe) {
    assert.strictEqual(bashPermissionViolation(frontmatter(body)), null, label)
  }
})

/**
 * @description Every core/opencode/agents/*.md frontmatter is free of a permission.bash override that
 * widens beyond the global ruleset — the regression this repo hit before #516 (build/compliance/harvester/
 * planner/security/shipper/executor-{low,medium,high}.md all declared "bash: allow").
 */
test("lt-no-agent-bash-override-drift", () => {
  const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"))
  assert.ok(files.length > 0, "expected to find agent .md files")
  for (const f of files) {
    if (BASH_OVERRIDE_ALLOWLIST.has(f)) continue
    const violation = bashPermissionViolation(readAgent(f))
    assert.strictEqual(
      violation,
      null,
      `${f}: ${violation} — an agent-level permission.bash override is resolved LAST by OpenCode ` +
        `(findLast semantics) and shadows every deny in the global DANGEROUS_BASH_DENYLIST (issue #516). ` +
        `Remove the override (bash access is inherited from the global ruleset) or add ${f} to ` +
        `BASH_OVERRIDE_ALLOWLIST above with a documented reason.`,
    )
  }
})

/**
 * @description Whether a `config.agent.<name>.permission.bash` value (already JSON-parsed — a
 * string, an object, or absent) would shadow the global bash denylist: the scalar `"allow"`, or an
 * object whose `"*"` entry is `"allow"`. Mirrors `bashPermissionViolation`'s bash-specific check but
 * over parsed JSON instead of regex-scanned YAML — `config.agent.<name>.permission` is a SEPARATE
 * rule set from the `.md` frontmatter (evaluated afterwards by OpenCode, same `findLast` semantics),
 * so it is an independent site for the exact same override bug (issue #516 adversarial review: found
 * live in `opencode.json`/`opencode.json.example`'s `agent.explore`/`agent.general`).
 */
function agentConfigBashViolation(bashValue) {
  if (bashValue === "allow") return "scalar \"allow\"";
  if (bashValue && typeof bashValue === "object" && bashValue["*"] === "allow") return "\"*\": allow";
  return null;
}

/**
 * @description `config.agent.<name>.permission.bash` never overrides the global bash denylist in
 * either the root `opencode.json` or the vendored `opencode.json.example` template — the same
 * override bug Part 1/Part 2 close for `core/opencode/agents/*.md` frontmatter, found live during
 * the #516 adversarial review in `agent.explore`/`agent.general` (both OpenCode's own built-in
 * agent types, dispatchable via `task(subagent_type: "general"|"explore")` with no harness gate
 * restricting `subagent_type` to harness-named roles).
 */
test("lt-no-opencode-json-agent-bash-override-drift", () => {
  const repoRoot = path.resolve(__dirname, "../../..")
  const configPaths = [
    path.join(repoRoot, "opencode.json"),
    path.join(repoRoot, "core", "opencode", "opencode.json.example"),
  ]
  for (const configPath of configPaths) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
    const agents = config.agent && typeof config.agent === "object" ? config.agent : {}
    for (const [agentName, agentConfig] of Object.entries(agents)) {
      const bashValue = agentConfig?.permission?.bash
      const violation = agentConfigBashViolation(bashValue)
      assert.strictEqual(
        violation,
        null,
        `${configPath}: agent.${agentName}.permission.bash is ${violation} — this shadows the global ` +
          `bash denylist for this agent the same way a .md frontmatter override does (issue #516). ` +
          `Remove the "bash" key (it inherits the global ruleset) or narrow it to a "*": "deny" map.`,
      )
    }
  }
})

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
 * @description compliance.md has edit: deny and declares no permission.bash override (issue #516 —
 * it still runs the test suite, via the global ruleset's inherited bash access, not a per-agent
 * override that would shadow the global denylist).
 */
test("lt-compliance-no-bash-override", () => {
  const perms = extractPermissions(readAgent("compliance.md"))
  assert.strictEqual(
    perms.bash,
    undefined,
    "compliance.md must not declare permission.bash in frontmatter — bash access is inherited from " +
      "the global ruleset (issue #516)",
  )
  assert.strictEqual(perms.edit, "deny")
})

/**
 * @description Edit/bash matrix per oc-agents-permission-parity (issue #472), updated by #516: planner
 * is the only eye with edit: allow (parity write access; the plan JSON is still persisted by the
 * planner-recovery plugin, never by the planner itself). compliance, security, and planner run bash
 * commands (audit/exploration parity) but declare NO permission.bash override in frontmatter — that
 * access comes from the global ruleset only, since an explicit override is resolved last by OpenCode
 * and would shadow every future global bash deny (issue #516). Every other eye keeps edit: deny and
 * an explicit bash: deny.
 */
test("lt-eyes-edit-deny-and-bash-matrix", () => {
  const EDIT_ALLOWED = new Set(["planner.md"])
  const NO_BASH_OVERRIDE = new Set(["compliance.md", "security.md", "planner.md"])
  for (const f of EYE_FILES) {
    const perms = extractPermissions(readAgent(f))
    if (EDIT_ALLOWED.has(f)) {
      assert.strictEqual(perms.edit, "allow", `${f} must have edit: allow`)
    } else {
      assert.strictEqual(perms.edit, "deny", `${f} must have edit: deny`)
    }
    if (NO_BASH_OVERRIDE.has(f)) {
      assert.strictEqual(
        perms.bash,
        undefined,
        `${f} must not declare permission.bash in frontmatter (issue #516)`,
      )
    } else {
      assert.strictEqual(perms.bash, "deny", `${f} must have bash: deny`)
    }
  }
})
