---
name: harness-lifecycle
description: Use when installing, updating, or validating the project-vendored Codex harness.
---

# harness-lifecycle

Operate only through the vendor lifecycle; do not edit the vendored runtime directly.

- Check `.codex/.harness-version`, the ownership manifest, and vendor source first.
- Preserve explicit operator config values; only absent activation flags may be added.
- Review and re-trust changed hooks before relying on them.
- Verify a fresh install and a second convergent run after lifecycle changes.

Use `.codex/skills/harness-rules/references/governance-contract.md` for the
trust boundary and `.codex/skills/harness-delivery/references/delivery-contract.md` for verification evidence.
