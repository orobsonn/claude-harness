---
name: oc-updating-harness
description: "Install or update the Claude Harness from an OpenCode session. The pinned release CLI performs the lifecycle in an isolated clone, then synchronizes the invoking checkout's runtime after merge."
license: MIT
compatibility: opencode
metadata:
  phase: onboarding
  invocation: operator-only
---

# Updating-Harness (OpenCode)

This is the loader-visible lifecycle entry for an OpenCode-native session. It uses the published CLI
from one pinned git release; it does not depend on a local helper from an older vendor.

**Announce at start (operator language):** "Atualizando o Claude Harness (OpenCode) a partir do CLI publicado."

All identifiers and commands stay in English; every operator message is concise, in the operator's
language.

<HARD-GATE>
This is one top-level, interactive lifecycle operation, not product delivery. Run only from a direct
operator request while no delivery is active. Do not call `classify`, create a plan/spec, load
`oc-brainstorming` or `oc-orchestrating-delivery`, or dispatch any subagent. The operator reaches this
lane through `/updating-harness`, never through `build`. In headless or relayed input, stop without
modifying the harness.
</HARD-GATE>

<LIFECYCLE-QUALITY-BOUNDARY>
This operation validates the released vendor's ownership boundary, not the project's product behavior.
Do not run or demand the project's typecheck, test suite, or a quality receipt. No GitHub Actions
checks is an expected compatibility case, not missing evidence. Never create a plan/spec or ask the
operator to choose extra protection because CI is absent.
</LIFECYCLE-QUALITY-BOUNDARY>

<LIFECYCLE-TURN-CONTINUITY>
Lifecycle command results are internal progress, not an operator checkpoint. While a next prescribed
command is lawful, make that next prescribed command in the **same active turn**. Do not send an
intermediate textual response such as "atualizando", "continuando" or "commit quando quiser" and then
wait. Only send an operator-facing response after the lifecycle result is `merged` or `noop`, or after
a formal block with command evidence and the authority actually needed.
</LIFECYCLE-TURN-CONTINUITY>

## Step 1 — resolve the runtime

Detect the OpenCode shell:

```bash
test -f .opencode/.harness-version && echo update || echo install
```

Then run this exact second marker check. Do not probe a directory and do not compose a different shell
test:

```bash
test -f .claude/.harness-version && echo claude || echo no-claude
```

Use only those marker results to resolve the CLI target. Never use `read` to probe an absent optional
shell, and never use `test -d`: an absent Claude marker means `opencode`, not an error.

- OpenCode result `update` plus Claude result `claude`: `both`.
- OpenCode result `update` plus Claude result `no-claude`: `opencode` — the absent Claude shell is optional.
- OpenCode result `install` plus Claude result `claude`: `claude`.
- Both results absent: install only the runtime explicitly requested by the operator.
- Add a runtime only with explicit intent: `both`.

## Step 2 — one isolated operation

Resolve the latest release tag **once** and retain that value for this invocation:

```bash
gh release view --repo orobsonn/claude-harness --json tagName -q .tagName
```

Run exactly this single clean command — substitute its placeholders with the resolved values; no
comment, redirect, `&&`, or second lifecycle command:

```bash
npx --yes --package=github:orobsonn/claude-harness#<latest-tag> claude-harness lifecycle-update --target <resolved-runtime> --ref <latest-tag>
```

The published CLI starts from a **clean clone of `origin/main`** (or `origin/master`), vendors the
pinned release, accepts only the exact generated harness manifest, creates the lifecycle-only commit,
opens its PR, and merges it. It cleans the temporary clone in every outcome. After a `merged` or `noop`
result, it fast-forwards the invoking default-branch checkout to `origin/main` (or `origin/master`) so
the local harness files are synchronized in the same operation. On a feature checkout, it copies the
exact release-owned harness files from that verified clone into the current worktree, without moving
its branch. This overwrites only those official files and removes only declared retired files; product
work, plans, state, local plugins, index, and unrelated files remain untouched, without staging, committing,
merging, rebasing, stashing, or resetting. It never switches a feature branch and never uses stash, reset, or a non-fast-forward merge.

The PR contains only the release's exact harness files. Product work, plans, run state, local plugins,
secrets, and unrelated staged files cannot enter it. The CLI requests the merge immediately; GitHub
rules remain authoritative and reject it when the repository itself requires approval or checks. It
never polls a just-created PR for checks, because that transient list can be empty before Actions starts.

## Step 3 — close

- `merged`: report version/PR, that it landed on the default branch, and that the current runtime synchronized.
- `noop`: report that the requested version was already present and whether the local branch or runtime synchronized.
- Any other result: report its command evidence and stop. Do not retry through a different branch,
  broad staging, reset, stash, direct commit, or another release tag.

The running OpenCode process still has the old plugins and skills in memory. Require a **new OpenCode
session** after a successful update, even when the local default-branch files synchronized or the feature
checkout runtime synchronized.

## Anti-patterns

- Running a multi-step vendor/commit/PR sequence in the checkout that carries the conversation.
- Using `@orobsonn/claude-harness@latest` from npm; the npm release can lag the git tag.
- Inferring an additional runtime from detection; only explicit `both` adds one.
- Turning absent project CI into a product-test demand or an operator choice.
- Broad staging, force-push, `--no-verify`, or an admin merge.
