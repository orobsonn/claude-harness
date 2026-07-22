---
name: updating-harness
description: "Use to install or update the Claude Harness in the CURRENT project from its source repo — the source URL is baked in, the operator never pastes it. Detects install-vs-update, pins to the latest GitHub release tag, reports what changed, and re-vendors via vendor-core without clobbering project memory/kaizen/settings. Call it in any repo to onboard or sync the harness after a new release."
---

# Updating-Harness — install or update the harness from its source repo

This skill is the **one-call shortcut** for keeping a project's vendored harness in sync. The operator
just invokes it in the repo; the source URL lives here, so there is no URL to copy/paste. It does not
plan, implement, or review — it only vendors the framework `core/` into the project's runtime shell(s)
(`.claude/` for Claude Code, `.opencode/` for OpenCode).

**Two distinct verbs — do not conflate them:**
- **Sync (default):** refresh the shell(s) the project **already has** to the latest version. Detected
  automatically (see Step 2), no operator input needed.
- **Add a runtime:** vendor a shell the project does **not** yet have (e.g. add OpenCode to a
  Claude-only project). This is **never** inferred from detection — detection is blind to a shell that
  isn't there yet. It requires **explicit operator intent** (`opencode` / `both`), passed as the public
  CLI's `--target`.

**Announce at start (pt-br):** "Atualizando o Claude Harness a partir do repo-fonte."

All identifiers/commands stay in English; every message to the operator is **pt-br, product-language**.

---

## Source (baked in — do NOT ask the operator for a URL)

```
SOURCE_URL = https://github.com/orobsonn/claude-harness.git
REPO_SLUG  = orobsonn/claude-harness
```

If the operator explicitly passes a different source (fork, local clone path for dev), honor it.
Otherwise always use `SOURCE_URL`.

---

## Step 1 — Check the latest release

```bash
gh release view --repo orobsonn/claude-harness --json tagName,name,body -q '{tag:.tagName, notes:.body}'
```

Read the project's current version if present:

```bash
cat .claude/.harness-version 2>/dev/null || echo "harness not installed yet"
```

Report to the operator in pt-br: **current → latest**, plus the release highlights (the `body`). If the
project is already at the latest tag, say so and ask whether to re-vendor anyway (idempotent, safe).

---

## Step 2 — Install or update (auto-detect + resolve runtime)

**2a — Detect install-vs-update.** Look for the vendored installer under **either** shell (a project
may have only `.claude/`, only `.opencode/`, or both):

```bash
{ test -f .claude/skills/initializing-projects/references/vendor-core.mjs || \
  test -f .opencode/.harness-version; } && echo update || echo install
```

**2b — Resolve the runtime to vendor** (the public CLI's `--target` value = runtime shell):
- **Sync (default):** the set of shells already present — `.claude/` present → include `claude`;
  `.opencode/` present → include `opencode`; both present → `both`.
- **Add a runtime (explicit intent only):** if the operator asked to add a shell (e.g. "add opencode",
  "vendor both"), use that intent instead — it is a **superset** of what's present, never inferred from
  detection. `both` on a Claude-only project is the normal way to add OpenCode.
- The public CLI's `--target opencode|claude|both` names the **runtime shell** (the CLI maps it to the
  engine's low-level `--runtime`). Use that vocabulary here — do not hand-invoke the low-level engine.

- **update** (already vendored — the common case): run the CLI from the **pinned latest release tag**
  via `npx`, passing the resolved runtime. `init` is idempotent — it re-vendors the framework files to
  the new version without clobbering project state. **Emit a single clean command** — no trailing
  comment, no `&&`, no redirect. This exact form is what the OpenCode entry-gate allowlists; any extra
  token re-triggers the anti-forgery block when this same skill is loaded inside an OpenCode session
  (both shells expose a skill named `updating-harness`, and OpenCode may load this Claude one):
  ```bash
  npx -y "github:orobsonn/claude-harness#<latest-tag>" init --target <resolved-runtime>
  ```
  Substitute `<latest-tag>` with the concrete `vX.Y.Z` from Step 1 and `<resolved-runtime>` from 2b
  (`claude`, `opencode`, or `both`). Running from the `github:…#<tag>` spec always fetches the tagged
  release's CLI — never a stale vendored copy — so no double-run is needed; do **not** use npm `@latest`
  (it lags and may predate OpenCode support). The CLI's `vendor-core` ends with an **integrity gate**:
  if any vendored hook imports a `../vps/<mod>.mjs` that was NOT mirrored, it exits **non-zero with a
  loud FATAL** instead of shipping a hook that crashes on load (ERR_MODULE_NOT_FOUND) and blocks the
  entry-gate. If it fails the gate, STOP and surface it — do not commit a broken shell.

- **install** (first time — no installer in the project yet): invoke the **`initializing-projects`**
  skill and hand it the baked `SOURCE_URL` and the latest tag. It bootstraps the clone and runs the
  full onboarding (labels, settings reconcile, issue form). Do not re-implement that flow here.

`vendor-core` is idempotent: framework files (`agents/`, `skills/`, `rules/`, `hooks/`, `CLAUDE-HARNESS-MEMORY-MODEL.md`)
are overwritten to the new version; **`.claude/memory/`, `.claude/kaizen.md`, project content in
`CLAUDE.md` (outside the markers), and `settings.json` are never clobbered**. `.claude/.harness-version`
is restamped.

### Step 2b — Re-run CI generation on re-sync (non-clobber)

On a re-sync (update), re-run CI generation via `generate-ci.mjs` to align the project's
`.github/workflows/ci.yml` with the latest harness version. The generation uses **non-clobber
semantics**: if the project already has an existing `.github/workflows/ci.yml`, it is **never
overwritten** — the CI generation respects the project's customizations and will only create the
file if it does not yet exist or will update it only if instructed.

---

## Step 3 — Reconcile and report

- If the installer wrote `settings.harness.json` (the project already had a `settings.json`), present
  the diff in product-language, merge the harness baseline into the operator's config (never silently
  overwrite their permissions/hooks), then delete `settings.harness.json`.
- Report **version before → after**, what the release changed (from Step 1 notes), and remind that the
  `.claude/` changes must be **committed** so cloud routines see the new version.
- **Do not commit automatically** unless the operator asks — staging the vendored `.claude/` is their call.

---

## Anti-patterns

- **Asking the operator for the source URL** — it is baked in. Only override on an explicit fork/local-dev request.
- **Re-vendoring from `main` when a tag exists** — pin `--ref <latest-tag>` for a reproducible, released version.
- **Clobbering project state** — never overwrite `memory/`, `kaizen.md`, `settings.json`, or project `CLAUDE.md` content. The installer's idempotency handles this; do not bypass it.
- **Hand-editing vendored files in the project** — changes belong in the framework source, promoted via kaizen.
- **Committing automatically** — leave the commit to the operator unless asked.
