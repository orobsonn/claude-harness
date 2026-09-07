---
name: harness-releasing-versions
description: Use when a completed milestone is ready for a release-please release PR, tag, or GitHub Release.
---

# Releasing versions

Detect the release regime before doing anything. Apply the portable delivery
contract at `.pi/harness/skills/harness-delivery/references/delivery-contract.md`
and the safety contract at `.pi/harness/skills/harness-rules/references/governance-contract.md`.

## 0. Detect the regime

```bash
ROOT=$(git rev-parse --show-toplevel) || exit 1
RP=""
[ -f "$ROOT/release-please-config.json" ] && RP="config"
[ -z "$RP" ] && [ -f "$ROOT/.release-please-manifest.json" ] && RP="manifest"
[ -z "$RP" ] && grep -rq "release-please-action" "$ROOT/.github/workflows/" 2>/dev/null && RP="workflow"
echo "${RP:-manual}"
```

- `config`, `manifest`, or `workflow`: use **release-please**.
- `manual`: use only the fenced manual fallback below.

## Release-please

The action owns `CHANGELOG.md`, package version, tag, and GitHub Release. Land
Conventional Commits through a PR; this repository does not publish to npm.

- NUNCA editar `CHANGELOG.md` manualmente <!-- release-please:prohibition -->
- NUNCA rodar `npm version` <!-- release-please:prohibition -->
- NUNCA criar tag ou GitHub Release manualmente <!-- release-please:prohibition -->
- NUNCA commitar uma release direto em `main`; toda mudança humana vai por PR.

```bash
gh pr list --search 'author:app/github-actions "chore(main): release"'
gh release view --json tagName,publishedAt
```

## 2. Force a version with `Release-As: X.Y.Z`

`Release-As: X.Y.Z` belongs in the body of the squash commit that lands on `main`. A major `Release-As:` needs two explicit operator confirmations — duas vezes. With `bump-minor-pre-major: true`, `0.55.71 + feat! = 0.56.0`; with
`bump-patch-for-minor-pre-major: false`, a feature stays minor before 1.0.0.
`Release-As: 1.0.0` is the only automatic path to 1.0.0 before the major line.

## 3. Release PR with missing CI

A `github-actions[bot]` PR `chore(main): release X.Y.Z` can show `action_required` or zero jobs; the entry gate correctly says `No CI checks are reported; merge is denied.` Diagnose with `gh pr view <N> --json statusCheckRollup`. Approve a pending run, or have a human close and reopen the
PR when no run exists. Settings → Actions has a toggle for workflow approval,
but it does not create the missing pull-request run. NUNCA contornar o gate with
`--admin` or another bypass: make CI exist.

<!-- release-please:fallback-start -->

## Manual fallback

PARE: use this fallback somente SEM release-please. Confirm a clean tree,
current `main`, a non-empty `CHANGELOG.md` `[Unreleased]`, the version source,
and the project test command. Open a dedicated `chore/release-X.Y.Z` PR.

## Detect mode

```bash
git checkout main && git fetch origin && git pull --ff-only
LAST_MSG=$(git log -1 --format=%s)
```

- If `$LAST_MSG` matches `^chore: release v[0-9]+\.[0-9]+\.[0-9]+( \(#[0-9]+\))?$` and no tag exists, enter **MODO FINISH**.
- If a `chore/release-*` branch or PR exists, report the partial state and stop.
- Otherwise enter OPEN mode.

## MODO OPEN

Calculate the bump, run checks, update version and changelog, push the release
PR, then stop for the operator to merge it.

## MODO FINISH

### 1. Confirm the release commit

```bash
LAST_MSG=$(git log -1 --format=%s)
echo "$LAST_MSG"
```

Stop if it is not the expected release commit or the target tag already exists.

### 2. Gate on the PR checks

Use `STATE`, never only the exit code: `exit 1` is ambiguous between a failing
check and no checks.

```bash
PR_NUMBER=$(echo "$LAST_MSG" | sed -nE 's/.*\(#([0-9]+)\).*/\1/p')
STATES=$(gh pr checks "$PR_NUMBER" --json state -q '.[].state' 2>/dev/null)
```

If `PR_NUMBER` is vazio, parar e perguntar: `gh pr checks ""` resolves the current branch and silently degrades the gate to FAIL-SOFT or checks the wrong PR.

Evaluate four branches against `STATE`, not the exit code:

- Empty `STATES`: no CI workflow, so **FAIL-SOFT** only in this manual fallback; under release-please an empty CI workflow is fail-closed; warn and continue.
- `FAILURE`, `ERROR`, `CANCELLED`, or `TIMED_OUT`: CI is **red**; refuse the release and nao criar tag.
- Only `SUCCESS`, `SKIPPED`, `NEUTRAL`, or `PENDING`: CI is green; proceed.
- `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`, `QUEUED`, `IN_PROGRESS`, `WAITING`, `REQUESTED`, or `EXPECTED`: nao e verde; parar e perguntar.

### 3. Publish only after the green gate

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/release-notes-X.Y.Z.md --latest
```

Extract and validate the release notes before the last command. Report the tag,
release URL, and commit hash. Deploy remains a separate operator decision.

<!-- release-please:fallback-end -->
