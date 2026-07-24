---
name: oc-releasing-versions
description: Versioned release pipeline via PR — opens a chore/release-X.Y.Z PR (version bump + CHANGELOG), waits for merge, then creates the tag + GitHub Release. Use when you have changes merged into main ready to become a version. Conforms to AGENTS.md §4 git rules.
license: MIT
compatibility: opencode
metadata:
  domain: git
  conforms-to: AGENTS.md §4
---

# Releasing-Versions — versioned release via PR

Creates a versioned release via PR. Two modes:

- **OPEN** — opens a `chore: release vX.Y.Z` PR (default when no release PR is pending).
- **FINISH** — after the PR merges, creates the tag + GitHub Release (auto-detected).

All git mechanics conform to `AGENTS.md` §4 (Conventional Commits; never commit to `main`; selective stage; never a `Co-Authored-By` trailer).

## Prerequisites

- A git repo with `origin` pointing to GitHub.
- `CHANGELOG.md` at the root with a filled `## [Unreleased]` (in OPEN mode).
- `package.json` at the root with `version`.
- `gh` CLI authenticated.
- Repo settings: "Allow squash merging" on (others off).

## Operator input (pt-br, product-language)

- **Bump type** (in OPEN mode) — patch (default), minor, major.
- **Deploy after release** — NOT coupled by default. After `gh release create`, the operator decides whether to deploy (e.g. `skill({ name: "deploying-workers" })`).

## Detect mode

```bash
git checkout main && git fetch origin && git pull --ff-only
LAST_MSG=$(git log -1 --format=%s)
```

- If `$LAST_MSG` matches `^chore: release v[0-9]+\.[0-9]+\.[0-9]+( \(#[0-9]+\))?$` AND no tag exists for that version → **FINISH mode**.
- If a local branch or open PR `chore/release-*` exists → report state and ask (likely mid-flow).
- Otherwise → **OPEN mode**.

---

## OPEN mode — open the release PR

### 1. Pre-flight on main
```bash
git status                          # clean working tree
git log origin/main..HEAD --oneline # main in sync (empty = ok)
```
If not clean / in sync, stop and ask to resolve.

### 2. Validate `[Unreleased]` in CHANGELOG
```bash
head -30 CHANGELOG.md
```
If `[Unreleased]` is empty (only empty subsections), stop — nothing to release. If there are entries, show the operator to confirm before proceeding.

### 3. Compute new version
- Read `version` from `package.json`.
- Apply bump (patch default): `0.0.1` → `0.0.2`.
- Minor: `0.0.x` → `0.1.0`.
- Major: `0.x.x` → `1.0.0` — confirm with the operator **twice**.
- Confirm the final version with the operator.

### 4. Local checks
Run what the project's root `CLAUDE.md`/`AGENTS.md` defines. Typical:
```bash
npx tsc --noEmit
npm test
```
If it fails, stop — do not release.

### 5. Create dedicated branch (never commit release to main — AGENTS.md §4)
```bash
git checkout -b chore/release-X.Y.Z
```

### 6. Bump `package.json` (no tag yet)
```bash
npm version X.Y.Z --no-git-tag-version
```

### 7. Move entries in CHANGELOG
Edit `CHANGELOG.md`:
- `## [Unreleased]` becomes `## [X.Y.Z] - YYYY-MM-DD`.
- Insert a fresh `## [Unreleased]` at the top with 4 empty subsections (Added/Changed/Fixed/Removed).

### 8. Extract release notes (for the PR body and later release notes)
```bash
awk '/^## \[X\.Y\.Z\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md > "$TMPDIR/release-notes-X.Y.Z.md"
```
Validate the file is non-empty.

### 9. Commit + push branch (selective stage — AGENTS.md §4)
```bash
git add CHANGELOG.md package.json
git commit -m "chore: release vX.Y.Z"
git push -u origin chore/release-X.Y.Z
```
**NEVER** a `Co-Authored-By` trailer — the environment rejects it and the push fails.

### 10. Open PR
```bash
gh pr create --title "chore: release vX.Y.Z" --body-file "$TMPDIR/release-notes-X.Y.Z.md"
```

### 11. Report (pt-br, product-language)
- PR URL.
- Version to be released.
- Instruction: "Merge on GitHub (squash) and invoke this skill again to finish (tag + GitHub Release)."

STOP here. Do NOT merge via CLI without explicit operator authorization (merge is irreversible — a human checkpoint, per `build` HARD-GATE before merge/deploy).

---

## FINISH mode — close the release after merge

### 1. Confirm you are on the right commit
```bash
LAST_MSG=$(git log -1 --format=%s)
echo "$LAST_MSG"   # expected: "chore: release vX.Y.Z (#N)" — squash adds "(#N)"
```
Extract the version from the end of the message. If it does not match, stop and ask.

### 2. Confirm the tag does not yet exist
```bash
git tag -l "vX.Y.Z"
```
If it exists, stop — the release is already done.

### 3. Create local tag
```bash
git tag vX.Y.Z
```

### 4. Extract release notes
```bash
awk '/^## \[X\.Y\.Z\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md > "$TMPDIR/release-notes-X.Y.Z.md"
```
Validate content.

### 5. Push tag
```bash
git push origin vX.Y.Z
```

### 6. Create GitHub Release
```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file "$TMPDIR/release-notes-X.Y.Z.md" --latest
```

### 7. Report (pt-br, product-language)
- New published version.
- GitHub Release URL.
- Tag hash.
- Question: "Want to deploy now? Safe default: `versions upload` → smoke preview → promote 100% → smoke prod (`skill({ name: \"deploying-workers\" })`)."

STOP here. Deploy is an explicit decision.

---

## Rules

- NEVER a release commit directly on `main` — always via the `chore/release-X.Y.Z` PR (AGENTS.md §4).
- NEVER create the tag before the PR merges — the tag would point to a commit off main.
- NEVER forget `--latest` on `gh release create`.
- NEVER force-push a tag (deleting a remote tag via `git push origin :refs/tags/vX.Y.Z` requires explicit confirmation).
- NEVER a `Co-Authored-By` trailer — rejected by the environment.
- NEVER couple deploy to release without confirmation — release publishes a version, deploy promotes to prod; separate decisions.
- If any step fails (tsc, test, push, PR), stop and report — a partial release is worse than no release.
- If `[Unreleased]` is empty in OPEN mode, stop — nothing to release.
- Major bump (`0.x.x` → `1.0.0`): **always** confirm with the operator twice.

## Why via PR (and not a direct commit)

- **Audit**: the PR is a permanent record — who approved, when, what changed.
- **CI re-runs**: any `on: pull_request` workflow runs on the release PR, catching regressions introduced since the last release.
- **Clean revert**: a PR can be reverted (`gh pr revert`); a direct commit needs `git revert` + force-push.
- **No extra cost**: `gh` is already available; PR + merge are two commands.
- **Coherence**: the rest of the project ships via PR — the release follows the same discipline (consistent with the `shipper` agent).

## Why deploy is not coupled

- Release = publish an identifiable version (tag + notes).
- Deploy = promote bits to prod.
- The two can happen at different times (release now, deploy after a staging gate).
- Forcing coupling hides the critical smoke-test step of the deploy flow.
