# Add-on: RTK (Rust Token Killer)

RTK is a hook-based proxy that rewrites common dev commands to token-optimized equivalents, cutting
token-in on operations like `git`, `grep`, `tsc`, and test runners. It is **open source** and runs
both on the desktop and in cloud routines.

This is a **recommended setup step** of the harness — enabling it materially lowers token cost — but
it is delivered as an opt-in add-on, never hardcoded into the core. The hook is engineered to
**fail open**: if the `rtk` binary is absent, commands pass through unchanged and Bash keeps working.

## Enable

### 1. Install the binary

Validated stable release: [RTK v0.48.0](https://github.com/rtk-ai/rtk/releases/tag/v0.48.0)
(2026-09-08). Install or update the binary on **each execution host**: installing it on a VPS
does not update a desktop connected to that VPS.

- **Desktop (Homebrew):** `brew update && brew upgrade rtk` for an existing installation,
  or `brew install rtk` for a new one. Confirm the installed version with `rtk --version`.
- **Linux/macOS without Homebrew, including the VPS:** use the official installer pinned to
  the validated release. It checks the downloaded archive's SHA-256 and installs in
  `~/.local/bin` by default:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/v0.48.0/install.sh -o /tmp/rtk-install-v0.48.0.sh
  RTK_VERSION=v0.48.0 sh /tmp/rtk-install-v0.48.0.sh
  rtk --version
  rtk gain
  ```

- **Build from source:** `cargo install --git https://github.com/rtk-ai/rtk --tag v0.48.0 --locked`.
  Do not use bare `cargo install rtk`: crates.io has a different package with that name.
- **Cloud routine:** put the chosen pinned installation in the environment setup script,
  before the coding agent launches. Ensure its install directory is on that agent's PATH.

Updating the binary preserves existing agent configuration. Wire the hook separately when
enabling RTK; do not rerun `rtk init` as part of an ordinary binary update.
The Pi harness launcher uses its own runtime and explicit extension list; it does not
automatically load an optimizer installed in the operator's global Pi packages. A binary
update alone therefore does not enable automatic rewriting in harness-launched Pi sessions.

### 2. Wire the PreToolUse hook

Merge this into the project's `.claude/settings.json`. The `|| true` keeps it **fail-open** — a
missing binary never blocks Bash:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "rtk hook claude || true" }
        ]
      }
    ]
  }
}
```

## Caveats

- RTK sees every Bash command string. Treat it as a trusted dependency; pin its version.
- In cloud, building from source adds compile time to each cold start and requires access to
  GitHub and the dependency registry. Prefer the official binary; a missing optional install
  must not prevent the core harness from running.
- **To validate on the first cloud test:** confirm the `PreToolUse` hook actually fires in routines
  and that the fail-open passthrough preserves command semantics.

See the RTK project for the full command reference and `rtk gain` savings analytics.
