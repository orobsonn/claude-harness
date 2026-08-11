---
name: oc-updating-harness
description: "Install or update the Claude Harness from an OpenCode session. The pinned release CLI performs the whole lifecycle in an isolated clone: vendor, exact-boundary commit, PR, and merge. It never alters the checkout carrying the active conversation."
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
opens its PR, and merges it. It cleans the temporary clone in every outcome. It **does not modify the
invoking checkout**: its current branch, staged product work, plans, state, and local files remain
untouched. This prevents an old or dirty session checkout from blocking a legitimate harness sync.

The PR contains only the release's exact harness files. Product work, plans, run state, local plugins,
secrets, and unrelated staged files cannot enter it. GitHub rules remain authoritative. When the
repository has workflows, the CLI waits for their checks; when it has none, the manifest/SHA/PR identity
checks are the proportional lifecycle gate.

## Step 3 — close

- `merged`: report version/PR and that it landed on the default branch.
- `noop`: report that the requested version was already present on the default branch.
- Any other result: report its command evidence and stop. Do not retry through a different branch,
  broad staging, reset, stash, direct commit, or another release tag.

The active checkout intentionally remains as it was. Require a **new OpenCode session opened from the
updated default branch** to load the new plugins and skills; do not claim this existing session changed
its runtime.

## Anti-patterns

- Running a multi-step vendor/commit/PR sequence in the checkout that carries the conversation.
- Using `@orobsonn/claude-harness@latest` from npm; the npm release can lag the git tag.
- Inferring an additional runtime from detection; only explicit `both` adds one.
- Turning absent project CI into a product-test demand or an operator choice.
- Broad staging, force-push, `--no-verify`, or an admin merge.
