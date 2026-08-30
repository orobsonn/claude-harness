---
name: oc-releasing-versions
description: Versioned release. If the project has release-please configured, the flow IS release-please — conventional commits on main, the action opens the release PR itself, and merging that PR creates the tag + GitHub Release. Without release-please, it falls back to the manual release-PR flow. Use when changes merged into main are ready to become a version. Conforms to AGENTS.md §4 git rules.
license: MIT
compatibility: opencode
metadata:
  domain: git
  conforms-to: AGENTS.md §4
---

# Releasing-Versions — release-please first, manual PR flow as the fallback

This skill has **two regimes**, and the regime is **detected, never assumed**:

- **Release-please regime** — the project has release-please configured. The action owns the CHANGELOG, the version and the tag. You only write conventional commits.
- **Manual regime (fallback)** — the project does NOT have release-please. The release-PR flow at the end of this file applies.

The governing rule is `rules/releases.md`, section "Release-please (fonte primaria quando configurado)". On any divergence, the rule wins.

All git mechanics conform to `AGENTS.md` §4 (Conventional Commits; never commit to `main`; selective stage; never a `Co-Authored-By` trailer).

## 0. Detect the regime (ALWAYS the first step)

```bash
ROOT=$(git rev-parse --show-toplevel) || exit 1
RP=""
[ -f "$ROOT/release-please-config.json" ] && RP="config"
[ -z "$RP" ] && [ -f "$ROOT/.release-please-manifest.json" ] && RP="manifest"
[ -z "$RP" ] && grep -rq "release-please-action" "$ROOT/.github/workflows/" 2>/dev/null && RP="workflow"
echo "${RP:-manual}"
```

- Output `config` / `manifest` / `workflow` → **RELEASE-PLEASE REGIME** → follow sections 1 to 4. The manual fallback **does not apply**; do not even read it.
- Output `manual` → **MANUAL REGIME** → jump straight to the fallback at the end of the file.

Two non-negotiables in this step:

- **Check all THREE forms.** release-please can be configured by workflow input alone, with no config file at the root. A detector tied to the root file reads such a project as "manual", writes into `CHANGELOG.md` what the action is about to rewrite, and that is a guaranteed conflict (`rules/releases.md`).
- **Anchor at the repo root.** All three checks are directory-relative; running from a subdirectory yields a false `manual`. Hence `ROOT=$(git rev-parse --show-toplevel)`.

---

## 1. Release-please regime — this is the flow

### 1.1 Division of labour

| You do | The action does |
| --- | --- |
| Write commits in **Conventional Commits** (`feat:`, `fix:`, `feat!:` …) | Derive the version from the commits since the last tag |
| Land those commits on `main` **via PR** | Write the whole `CHANGELOG.md` |
| Review and merge the PR the action opens | Bump `version` in `package.json` |
| Optionally force a version with `Release-As:` | Update the `extra-files` — including the README badge via the `x-release-please-version` marker |
| | Open / update the `chore(main): release X.Y.Z` PR |
| | On merging that PR — create the **tag** and the **GitHub Release** |

**What the action does NOT do in this repo:** publish to npm. The `release-please.yml` workflow runs only `release-please-action`; there is no publish workflow. Merging the bot PR produces **the tag and the GitHub Release, and nothing beyond that** — anyone consuming via `npx` keeps getting the previous version until someone publishes. If the project needs npm, that is an operator decision outside this skill.

### 1.2 Anatomy of the flow

```
conventional commits on main
        ↓
the action opens "chore(main): release X.Y.Z"
        ↓
merge that PR
        ↓
tag + GitHub Release, automatically (and that is all — no publish)
```

### 1.3 What to NEVER do in this regime

- NEVER edit `CHANGELOG.md` by hand — the action rewrites it and the conflict is guaranteed <!-- release-please:prohibition -->
- NEVER run `npm version` nor bump `package.json` by hand <!-- release-please:prohibition -->
- NEVER change the README badge by hand — the `x-release-please-version` marker does it <!-- release-please:prohibition -->
- NEVER `git tag` nor `gh release create` by hand — the action creates both on merge <!-- release-please:prohibition -->
- NEVER move the `## [Unreleased]` section — release-please does not even use it <!-- release-please:prohibition -->
- NEVER commit a release straight to `main` — everything goes through a PR, including the commit carrying `Release-As:`. The only commit that lands without a human PR is the action's own.

### 1.4 Inspect the state (read-only)

```bash
gh pr list --search 'author:app/github-actions "chore(main): release"'
gh release view --json tagName,publishedAt
cat "$ROOT/.release-please-manifest.json"
```

---

## 2. Forcing a version — `Release-As: X.Y.Z`

The only way to drive the version is a `Release-As:` footer in the **body of the commit** that lands on `main`:

```
chore: release 1.0.0

Release-As: 1.0.0
```

**Squash gotcha.** In a repo that only allows squash merge, the action reads the footer from the **squash commit** that lands on `main`. A `Release-As:` that exists only on the branch commit is discarded by the squash and ignored. Recipe:

```bash
git checkout -b chore/release-as-1.0.0
git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"
git push -u origin chore/release-as-1.0.0
gh pr create --title "chore: release 1.0.0" --body "Release-As: 1.0.0"
```

When merging, make sure the **squash commit body** carries the `Release-As: 1.0.0` line. Never commit it straight to `main`.

### 2.1 Why a `feat!` on 0.55.71 gives 0.56.0 and not 1.0.0

Derived from this repo's `release-please-config.json`:

| config | value | effect while the version is `< 1.0.0` |
| --- | --- | --- |
| `bump-minor-pre-major` | `true` | a breaking change (`feat!`, `BREAKING CHANGE:`) bumps **minor**, not major → `0.55.71` + `feat!` = **`0.56.0`**, not `1.0.0` |
| `bump-patch-for-minor-pre-major` | `false` | `feat:` keeps bumping **minor** (`0.55.71` → `0.56.0`); `fix:` bumps patch (`0.55.71` → `0.55.72`) |

Explicit conclusion: **pre-1.0 there is no automatic path to `1.0.0`.** No commit, however breaking, gets there. The only way is `Release-As: 1.0.0`.

### 2.2 Major bump — confirm TWICE

- `Release-As: 1.0.0` (or any major) requires confirming with the operator **twice** — explicit question, explicit answer, twice, before writing the footer.

---

## 3. Stuck release — a `github-actions[bot]` PR with no CI

### Symptom

The `chore(main): release X.Y.Z` PR is authored by `github-actions[bot]`, CI shows up as `action_required` or with **zero jobs**, and the entry-gate denies the merge with:

```
No CI checks are reported; merge is denied.
```

### Why

A PR opened with the default `GITHUB_TOKEN` **does not trigger** `on: pull_request` workflows — GitHub's anti-recursion protection, unconditional and not switchable by a toggle. When a run does exist but awaits approval, it sits in `action_required` without materialising a single job. In both cases the gate denies, and in both cases **the gate is right**: an empty rollup → `state: "missing"`; `ACTION_REQUIRED` → classified as **red**.

### Diagnosis

```bash
gh pr view <N> --json statusCheckRollup      # exactly what the entry-gate reads
gh run list --branch release-please--branches--main --json status,conclusion,databaseId
```

### Unblocking — make the CI exist

The two failure shapes are different observables with different exits:

**A) A run exists, parked in `action_required`** → approve the run:
- GitHub UI — the **Actions** tab → the pending run → **Approve and run**; or
- `gh api -X POST repos/{owner}/{repo}/actions/runs/{run_id}/approve`

**B) No run at all** (the `GITHUB_TOKEN` case) → there is nothing to approve. Exits:
1. **A human closes and reopens the PR** (`gh pr close <N> && gh pr reopen <N>`, or the buttons) — the `reopened` event is human-attributed and `on: pull_request` fires. This exit always exists and never touches the gate.
2. Give `release-please-action` a PAT via `token:` so the PR has human authorship — **operator decision, outside this skill**.
3. Add a trigger to the CI workflow that covers the release branch — **operator decision, outside this skill**.

About the **Settings → Actions → General** toggle ("Allow GitHub Actions to create and approve pull requests" and the run-approval policy): it governs whether Actions may create/approve PRs and how pending runs get approved. It does **not** make an `on: pull_request` workflow fire for a PR authored by the default `GITHUB_TOKEN` — do not hunt for the cure only there.

### Never bypass the gate

- NEVER bypass the entry-gate — no `gh pr merge --admin`, no turning the gate off, no merging "because CI does not exist". An empty rollup denying the merge **is the gate working** — the exit is to make CI exist, never to silence the gate.

The FAIL-SOFT branch of the manual fallback below applies **only** there, in a project with no CI workflow at all. Under release-please, empty output means a run waiting for approval or a run that never existed — fail-closed, always.

---

## 4. Report (pt-br, product-language)

- The version the action will publish (from the bot PR title or `.release-please-manifest.json`).
- The URL of the `chore(main): release X.Y.Z` PR.
- That merging produces tag + GitHub Release, and nothing beyond that.
- That **deploy stays decoupled** — release publishes a version, deploy promotes to prod; separate decisions (`skill({ name: "deploying-workers" })`).

STOP here. Merge and deploy are explicit operator decisions.

---
<!-- release-please:fallback-start -->

## Manual fallback — ONLY for projects WITHOUT release-please

> **STOP.** If step 0 detected release-please configured by any of the three forms,
> this entire section does NOT apply — go back to section 1. This fallback exists
> because the skill is vendored into projects WITHOUT release-please, and for them
> the manual release-PR flow is the legitimate flow (`rules/releases.md`: the rest
> of that rule is the fallback for projects with no release-please configured).

Creates a versioned release via PR. Two modes:

- **OPEN** — opens a `chore: release vX.Y.Z` PR (default when no release PR is pending).
- **FINISH** — after the PR merges, creates the tag + GitHub Release (auto-detected).

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

### 2. Verify CI is green via PR checks
Extract the PR number from the commit message (the `(#N)` squash suffix) and validate CI — use explicit STATE parsing, never just the exit code (`gh pr checks` exits 1 for BOTH a real failure and "no checks at all", so exit 1 is ambiguous and cannot tell the two apart):
```bash
PR_NUMBER=$(echo "$LAST_MSG" | sed -nE 's/.*\(#([0-9]+)\).*/\1/p')  # e.g. "chore: release v0.13.0 (#41)" → 41
STATES=$(gh pr checks "$PR_NUMBER" --json state -q '.[].state' 2>/dev/null)
```
If `$PR_NUMBER` is empty, the commit carries no `(#N)` — stop and ask. Mode detection accepts the suffix as optional, so this case is reachable, and a blank PR number would make `gh pr checks` return nothing and silently degrade the gate into the FAIL-SOFT branch below.

Evaluate the contents of `$STATES` in four branches — against the STATE, not the exit code:

- **Empty output** (`$STATES` blank): the repo has no CI workflow → **FAIL-SOFT** (warn, do not block). Warn the operator that no CI workflow is configured, and proceed. This FAIL-SOFT applies ONLY here, in this manual fallback in a project with no CI workflow at all — under release-please, empty output means a run waiting for approval (or a run that never existed) and the behavior is fail-closed (section 3).
- **Contains `FAILURE`, `ERROR`, `CANCELLED` or `TIMED_OUT`**: CI is **red** → **refuse** the release — do not create the tag. Stop and report the failing checks. Revert via `git revert -m 1 <merge-sha>` + a revert PR (or the GitHub "Revert" button via `gh pr view <N> --web`).
- **Only `SUCCESS`, `SKIPPED`, `NEUTRAL` or `PENDING` resolved**: CI is green → proceed.
- **Any other state** (`ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`, `QUEUED`, `IN_PROGRESS`, `WAITING`, `REQUESTED`, `EXPECTED` — all real values of GitHub's `CheckConclusionState` / `CheckStatusState` / `StatusState` enums): **NOT green** → stop and ask. `ACTION_REQUIRED`, `STARTUP_FAILURE` and `STALE` are non-success conclusions; the rest mean the run has not concluded. Never read "none of the four red tokens is present" as green.

If it fails on red CI, stop and report.

### 3. Confirm the tag does not yet exist
```bash
git tag -l "vX.Y.Z"
```
If it exists, stop — the release is already done.

### 4. Create local tag
```bash
git tag vX.Y.Z
```

### 5. Extract release notes
```bash
awk '/^## \[X\.Y\.Z\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md > "$TMPDIR/release-notes-X.Y.Z.md"
```
Validate content.

### 6. Push tag
```bash
git push origin vX.Y.Z
```

### 7. Create GitHub Release
```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file "$TMPDIR/release-notes-X.Y.Z.md" --latest
```

### 8. Report (pt-br, product-language)
- New published version.
- GitHub Release URL.
- Tag hash.
- Question: "Want to deploy now? Safe default: `versions upload` → smoke preview → promote 100% → smoke prod (`skill({ name: \"deploying-workers\" })`)."

STOP here. Deploy is an explicit decision.

---

## Rules (manual fallback)

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
<!-- release-please:fallback-end -->
