---
name: codex-cross-family-gitignored-evidence
description: Codex's own file-search/verification inside cross-family.mjs appears to respect .gitignore, so it cannot independently confirm evidence paths under a gitignored directory (e.g. .claude/plans/) even when the file is real on disk — plan for this when composing cross-family task/evidence inputs.
metadata:
  type: project
---

**Why:** During `spawn-hand-trust-stamp`'s final security crosscheck, a Claude finding cited
`.claude/plans/spawn-hand-trust-stamp/run/trust-stamp-empirical-validation.md` as evidence. That
directory is gitignored in this repo (`.claude/plans/` — see `harness-repo-constraints.md`). When
`cross-family.mjs` drove `codex exec --sandbox read-only` to crosscheck the finding, Codex reported
the cited file "does not exist in this checkout" — even though a direct `Read` confirmed it plainly
does. The likely cause is that Codex's own search/read tooling under `--sandbox read-only` walks the
tree respecting `.gitignore` (or an equivalent ignore-file heuristic), so a real, on-disk file under a
gitignored path is invisible to Codex's own verification even though Claude (using `Read` directly)
sees it fine. This produced a spurious-looking "cannot verify" argument in the crosscheck that a
Claude refutation had to resolve manually by re-reading the file and asserting its existence.

**How to apply:** when composing cross-family (`cross-family.mjs`) task/evidence inputs that cite a
path under a gitignored directory (`.claude/plans/`, `.claude/memory/mv-suggestions.md` if ever
introduced, or any other repo-local gitignored tree) — do not rely on Codex being able to
independently confirm that evidence by path alone; either (a) inline the relevant file content
directly into the `--claude`/task JSON payload instead of only citing its path, or (b) treat a
Codex "file does not exist" report about a gitignored-path citation as a tooling-visibility artifact
to verify directly (Claude `Read`) before accepting it as a real refutation, rather than as
conclusive evidence the citation was fabricated. This is a distinct failure mode from the two prior
Codex I/O quirks already tracked in `core/kaizen.md` (2026-07-04 read-only-sandbox timeout on
large files; 2026-07-06 hang without a working `OPENAI_API_KEY`) — those are latency/availability
issues (fail-open, no verdict), while this one is a silent, incorrect verdict about file existence
inside a sandbox that otherwise responded normally. If a second occurrence of this specific
gitignored-visibility gap surfaces, it should graduate to a `kaizen.md` harness-improvement proposal
(e.g. detect gitignored-path citations and pre-inline their content before dispatching to Codex).
