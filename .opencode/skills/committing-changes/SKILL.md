---
name: oc-committing-changes
description: Analyzes changes, creates a semantic commit (Conventional Commits) and pushes. For a standalone commit OUTSIDE the full delivery loop — when you just want to commit a change without PR/review/docs. Conforms to AGENTS.md §4 git rules. For full delivery use the shipper agent.
license: MIT
compatibility: opencode
metadata:
  domain: git
  conforms-to: AGENTS.md §4
---

# Committing-Changes — standalone semantic commit

Standalone commit. Use when you want to commit now without running the full delivery loop.

For full delivery (review + security + docs + PR), the `shipper` agent does the git flow — dispatch it via `task` (or let `build` drive it in Phase 5). This skill is the lighter, no-PR path; it conforms to the SAME `AGENTS.md` §4 git rules the shipper does.

## When to use

- Intermediate commit during development (WIP you will squash later).
- Trivial change on your own branch that needs no formal review.
- Commit on a branch that already has an open PR (continuing work).

**Do NOT use for:**
- A change ready to deliver — use the `shipper` agent (branch + PR).
- A commit on `main` — forbidden by default (always branch + PR, per AGENTS.md §4).

## Flow

### 1. Verify state
```bash
git status --short
git diff --stat
git log --oneline -5
```
If there are no changes, report and exit.

### 2. Sanity check of files
Flag as probable junk (same list the `shipper` uses):
- `.dev.vars`, `.env*`, `.local.*`
- `node_modules/`, `dist/`, `coverage/`
- `.DS_Store`, `*.log`
- any credential / token file

Confirm with the operator (pt-br, product-language) before proceeding if any of these appear.

### 3. Local checks
Run the minimum defined in the project's root `CLAUDE.md`/`AGENTS.md` (Commands section). Typical:
```bash
npx tsc --noEmit
```
If it fails, stop.

Skip `npm test` here (can be costly) — the full `shipper` flow inherits green gates from `build` before the PR.

### 4. Selective stage
- `git add <files>` — **NEVER** `git add .` / `git add -A` / `git add --all` (AGENTS.md §4; also denied in `opencode.json` permissions). Stage by file or hunk.
- Show `git diff --cached` before committing.

### 5. Commit (Conventional Commits, AGENTS.md §4)
- Header: `<type>: <description in pt-br>` (≤72 chars).
- Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `style`, `perf`, `ci`, `build`, `revert`. Optional scope: `feat(auth): ...`.
- Body optional (1–3 lines) explaining the WHY.
- `Closes #N` if applicable.
- **NEVER** a `Co-Authored-By` trailer — the environment rejects fabricated authorship attribution and the push fails. The message ends at its description/body.

```bash
git commit -m "$(cat <<'EOF'
<type>: <description>

[optional body explaining WHY]

Closes #N
EOF
)"
```

### 6. Push (if the branch has an upstream)
```bash
git push
```
If the local branch has no upstream, ask the operator before `git push -u origin <branch>`.

## Output (pt-br, product-language)

Report:
- Commit hash + title.
- Whether it pushed (and to which remote/branch).
- A note if a PR is still needed (use the `shipper` agent to open it).

## Rules (verbatim with AGENTS.md §4)

- NEVER commit directly to `main` — always branch + PR.
- NEVER `git add .` / `-A` / `--all` blindly.
- NEVER `--no-verify` (don't skip hooks — fix the root cause) and never `--amend` a commit already pushed.
- NEVER a `Co-Authored-By` trailer or any generated-by line.
- If asked to force-push, refuse — exception: `--force-with-lease` on your OWN branch, with explicit confirmation. Never force-push `main`.
