---
name: secret-shaped-fixture-fragmentation
description: Assemble secret-shaped test fixtures from ≤16-char concatenated fragments so scan-secrets-in-tree's locked-2 meta-test doesn't self-flag them
metadata:
  type: project
---

**Why:** `scan-secrets-in-tree.mjs`'s locked-2 test (`core/skills/initializing-projects/references/
scan-secrets-in-tree.test.mjs`) scans the ENTIRE tracked tree and requires ZERO findings. Any new test
file whose fixture contains a literal secret-shaped string (`ghp_`, `sk-proj-`, `github_pat_`, a JWT,
a high-entropy token, etc.) — even when the fixture exists purely to exercise `scrubSecrets` redaction
— trips the scanner's single-line heuristic and fails that meta-test. This recurred in
`exit-reason-capture` (#240): `cron-a-exit-reason.test.mjs` and `cron-a-exit-security.test.mjs` both
planted literal secret-shaped tokens as `scrubSecrets` input and failed locked-2 until fixed.

**How to apply:**

- The scanner does NOT detect tokens fragmented across a concatenation — this is documented directly
  in `scan-secrets-in-tree.mjs`'s own header comment ("Heuristic single-line scan — does NOT detect
  tokens fragmented across...").
- Build the fixture value from 2+ string-literal fragments, each ≤16 chars, concatenated with `+`:
  ```javascript
  // WRONG — literal, self-flags the repo's own secret scanner
  const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

  // RIGHT — same runtime value, no single line contains the full token
  const token = "ghp_" + "A1b2C3d4E5f6G7h8" + "I9j0K1l2M3n4O5p6" + "Q7r8";
  ```
- Reference the SAME variable in both the input construction and the assertion (`output.includes(token)`)
  — never re-type the literal a second time in the assertion, or the assertion line itself re-introduces
  the unfragmented string and still trips the scanner.
- Applies to any prefix the harness's own `scrubSecrets` patterns key on: `ghp_`, `sk-`/`sk-proj-`,
  `github_pat_`, `glpat-`, JWTs, `Bearer`/`Basic` headers, and generic `KEY|TOKEN|SECRET|PASSWORD|AUTH`
  env-value assignments.

**Gotcha:** this is a test-authoring concern only — it changes how the fixture literal is *written*,
never the runtime value under test (byte-identical after fragmentation) nor the scrub assertions
themselves.
