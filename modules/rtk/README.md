# Add-on: RTK (Rust Token Killer)

RTK is a hook-based proxy that rewrites common dev commands to token-optimized equivalents, cutting
token-in on operations like `git`, `grep`, `tsc`, and test runners. It is **open source** and runs
both on the desktop and in cloud routines.

This is a **recommended setup step** of the harness — enabling it materially lowers token cost — but
it is delivered as an opt-in add-on, never hardcoded into the core. The hook is engineered to
**fail open**: if the `rtk` binary is absent, commands pass through unchanged and Bash keeps working.

## Enable

### 1. Install the binary

- **Desktop:** `cargo install rtk` (requires a Rust toolchain).
- **Cloud routine:** add `cargo install rtk` to the environment **setup script** (runs as root on the
  fresh container before Claude Code launches; has network access to crates.io at the Trusted level).

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
- In cloud, building from crates.io adds compile time to each cold start and depends on the registry
  being reachable. Detect-and-skip if `cargo` is unavailable rather than failing the run.
- **To validate on the first cloud test:** confirm the `PreToolUse` hook actually fires in routines
  and that the fail-open passthrough preserves command semantics.

See the RTK project for the full command reference and `rtk gain` savings analytics.
