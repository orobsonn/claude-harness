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

- **Path tests use `import.meta.url`** — tests that reference repo files must resolve paths via
  `resolve(dirname(fileURLToPath(import.meta.url)), '../...')`. Hardcoded absolute paths
  (`/Users/robson/...`) pass locally and always fail in GitHub Actions (different checkout path).
  The compliance eye should scan new test files for `/Users/` or `/home/` literals as a gate check.
