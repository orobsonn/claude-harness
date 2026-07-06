---
name: harness-repo-constraints
description: Load-bearing dev constraints for the harness source repo — sandbox deny-list, test runner, no package.json, dual-mirror edit rule, and import.meta.url path resolution in tests.
metadata:
  type: project
---

**Why:** The harness source repo has several non-obvious constraints that silently break tests or
ship incomplete changes: (1) the local Claude sandbox blocks `.env.*` reads, causing EPERM in tests
that create `.env.example` fixtures; (2) every global rule/skill exists in two mirrors — `core/`
(git-committed, seen by CI) and `~/.claude/` (live, seen by the running agent) — and both must be
edited in the same change; (3) there is no `package.json`, so standard Node tooling commands must
not be run unconditionally.

**How to apply:**

- **No `package.json`** — version lives in `VERSION`. The only test runner is `node --test`. Never
  invoke `npm test`, `npx tsc --noEmit`, or eslint unconditionally — check for `package.json` first.
  Stack detection for this repo resolves to `runner:"node-test"`, `command:'node --test "**/*.test.mjs"'`.

- **Sandbox `.env.*` deny-list** — the local Claude sandbox deny-list `/**/.env.*` blocks reads on
  temp-dir `.env.example` files created by tests (e.g. `detect-secrets.test.mjs`). These tests get
  EPERM locally and must run with sandbox disabled. In GitHub Actions there is no deny-list — they
  pass normally. Full suite: `node --test "core/**/*.test.mjs"` with sandbox off is the CI-equivalent
  local gate.

- **Dual-mirror edit rule** — `core/rules/<file>.md` + `~/.claude/rules/<file>.md` (and
  `core/skills/<skill>/SKILL.md` + live mirror) are two mirrors of the same content. Edit both in
  the same change. CI only sees the `core/` copy (`~/.claude` is absent on the runner), so locked
  tests assert the core file only. Diverged mirrors are a silent bug — the agent uses the live copy,
  CI enforces the core copy, and they drift undetected until a test catches a stale value.

- **The project-local `.claude/` tree is itself gitignored in this SOURCE repo** (see
  `.git/info/exclude`) — only `core/` and `modules/` ship in git; `.claude/` is the locally-vendored
  mirror the running agent reads (parallel to `~/.claude/`, same rule as above one level down). Any
  drift-guard test or docs-mirror test that asserts byte-identity against `.claude/<path>` must
  `existsSync`-guard that side (skip/no-op when absent) or compare `core/`↔`modules/` only — a fresh
  CI checkout has no `.claude/` tree at all, and an unguarded assertion fails hard there even though
  local dev is fine.

- **Path tests use `import.meta.url`** — tests that reference repo files must resolve paths via
  `resolve(dirname(fileURLToPath(import.meta.url)), '../...')`. Hardcoded absolute paths
  (`/Users/robson/...`) pass locally and always fail in GitHub Actions (different checkout path).
  The compliance eye should scan new test files for `/Users/` or `/home/` literals as a gate check.

- **Pinning a prompt/mandate rule in an agent `.md`** — the established pattern (see
  `core/__tests__/test-author-agent.test.mjs`, `core/__tests__/test-author-format-safety.test.mjs`)
  is a content-assertion `node --test` that reads the agent's markdown body and asserts specific
  substrings are present (or absent) in a named section window, not the whole file. A locked test
  that greps the **whole body** for its target tokens is a weak pin: it can pass vacuously if the
  tokens already exist elsewhere pre-edit (caught by plan-reviewer round 1 on `#ac-1.1`), and it can
  keep passing even after a future edit deletes the section that motivated the rule, as long as the
  same tokens survive scattered elsewhere (flagged LOW by the final-review adversary on
  `test-author-format-safety`, Test 2). **How to apply:** extract the specific section window first
  (e.g. a helper like `extractStep5Window` / bounded by a `## <heading>` marker) and assert
  co-occurrence of the target tokens **within that window only** — never a bare whole-body
  `.includes()`/regex search for a rule that is scoped to one section. When the test's own search
  tokens are themselves hazardous strings (a block-comment terminator, `/**` opener, or any pattern
  that could prematurely close the test file's own comments), build them via string-literal
  concatenation so they never appear as a literal token inside the test file's own comments.
