---
name: updating-harness
description: "Install or update the Claude Harness in the CURRENT project from within an OpenCode session. Runs the CLI from the pinned git release tag (npx github:orobsonn/claude-harness#<tag> init) so no engine needs to be vendored into .opencode/ and it never depends on the lagging npm release. Detects install-vs-update, resolves which runtime shell(s) to vendor, and re-vendors without clobbering project memory/kaizen/config. Run it in any repo to onboard or sync the OpenCode harness after a new release."
license: MIT
compatibility: opencode
metadata:
  phase: onboarding
  invocation: operator-only
---

# Updating-Harness (OpenCode) — install or update the harness from within OpenCode

This is the **loader-visible lifecycle entry for an OpenCode-native session**. A Claude Code session
has its own `updating-harness` skill that runs the vendored engine directly; an OpenCode session cannot
see that engine, so here we drive the CLI **from the pinned git release tag**, which fetches the engine
from that release. This keeps an OpenCode project self-maintaining — it never depends on a Claude Code
session to administer it, nor on the npm release being current.

**Announce at start (operator language):** "Atualizando o Claude Harness (OpenCode) a partir do CLI publicado."

All identifiers/commands stay in English; every message to the operator is in **the operator's language**, product-language.

<HARD-GATE>
This is a top-level, interactive lifecycle operation, not a delivery. Run only from a direct operator
request and only when no delivery is active. Do not call `classify`, create or modify a plan/spec,
load `brainstorming` or `orchestrating-delivery`, or dispatch any subagent. Run the exact release CLI
command directly from `build`, report the result, and require a session restart. In headless or relayed
input, stop without modifying the harness.
</HARD-GATE>

---

## Two distinct verbs — do not conflate them

- **Sync (default):** refresh the shell(s) the project **already has** to the latest version.
- **Add a runtime:** vendor a shell the project does **not** yet have (e.g. add the Claude shell to an
  OpenCode-only project). This is **never** inferred — it requires **explicit operator intent** (`both`).

---

## Step 1 — Detect install-vs-update and resolve the runtime

Detect by the OpenCode shell's version stamp:

```bash
test -f .opencode/.harness-version && echo update || echo install
```

Resolve which runtime(s) to vendor (the public CLI's `--target`):
- **Both `.claude/.harness-version` and `.opencode/.harness-version` exist:** `both`.
- **Only `.opencode/.harness-version` exists:** `opencode`.
- **Only `.claude/.harness-version` exists:** `claude`.
- **A marker exists without its runtime shell:** stop; do not repair a partial install by inference.
- **No marker exists:** install only the runtime explicitly requested by the operator.
- **Add a runtime (explicit intent only):** `both` — keep/add the Claude shell alongside OpenCode.

> **Public CLI `--target` = runtime shell.** In the CLI, `--target opencode|claude|both` names the
> runtime — this is the CLI convention and differs from the low-level engine, whose `--target` is a
> directory. From OpenCode you always drive the CLI, so use `--target opencode` (or `both`).

---

## Step 2 — Install or update (same idempotent command)

First resolve the latest release tag (the CLI runs from that pinned tag):

```bash
gh release view --repo orobsonn/claude-harness --json tagName -q .tagName   # → <latest-tag>, e.g. v0.40.0
```

Both first-install and update use the same command — `init` is idempotent. **Run the CLI from the git
tag, not from npm:**

```bash
npx -y "github:orobsonn/claude-harness#<latest-tag>" init --target <resolved-runtime>   # opencode | both
```

> **Why the git tag, not `@orobsonn/claude-harness@latest`:** the npm-published version lags the repo
> and may predate OpenCode support entirely — `@latest` can silently vendor a stale **Claude-only**
> harness with `--target` ignored. The `github:…#<tag>` spec always runs the tagged release's CLI, which
> has the OpenCode shell. Only use the npm form once a release **≥ the tag with OpenCode support** is
> published (`npx -y "@orobsonn/claude-harness@>=0.40.0" …` fails loud if it is not).

This vendors the OpenCode shell into `.opencode/` (agents, skills, plugin, tools, `harness.routing.json`,
`AGENTS.md`, `opencode.json`, `shared/`), stamps `.opencode/.harness-version`, and — with `both` — also
refreshes the Claude shell in `.claude/`.

**Non-clobber guarantees (per shell):** `MEMORY.md`/`kaizen.md` are seeded only if absent; `AGENTS.md`
is merged between harness markers (project content preserved); an existing `opencode.json` is left
untouched (harness config written beside it as `opencode.harness.json` for manual merge).

---

## Step 3 — Reconcile and report

- If the CLI wrote `opencode.harness.json` (the project already had an `opencode.json`), present the
  diff in product-language, merge the harness config into the operator's config (never silently
  overwrite their plugins/settings), then remove `opencode.harness.json`.
- Report **version before → after** and remind that the `.opencode/` changes must be **committed** so
  cloud routines see the new version.
- Stop after the update and tell the operator to restart the session. Plugins already loaded in the
  current process still run the previous version and must not continue as a hybrid runtime.
- Point the operator to the human guide: `.opencode/docs/OPERATOR-GUIDE.md` (skills, plan vs build, routing).
- **Do not commit automatically** unless the operator asks.

---

## Anti-patterns

- **Vendoring the engine into `.opencode/` to run it locally** — the sanctioned OpenCode entry is the
  CLI run from the pinned git release tag (spec 08); do not clone-and-run a local engine from within OpenCode.
- **Using `@orobsonn/claude-harness@latest` from npm** — the npm release lags and may predate OpenCode; `@latest` can silently vendor a stale Claude-only harness. Use the `github:…#<tag>` spec, or pin `@>=0.40.0` so npm fails loud instead of mis-vendoring.
- **Passing a runtime word to the low-level engine's `--target`** — from OpenCode you drive the CLI, whose
  `--target` IS the runtime. Never hand-invoke the engine's directory-`--target` with `opencode`/`both`.
- **Inferring "add a runtime" from detection** — detection is blind to a shell that isn't there yet; adding one needs explicit operator intent (`both`).
- **Committing automatically** — leave the commit to the operator unless asked.
