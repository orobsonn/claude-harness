# Spec: codex-native-port

Feature ID: codex-native-port
Mode: full
Priority: P0

## Product outcome

The harness can be vendored into a Codex project and preserve every applicable
delivery control through Codex-native agents, skills, lifecycle hooks,
permissions, rules, and update tooling.

## Design principle

Keep workflow guidance in prose and skills. Keep only high-leverage controls
deterministic: deny-before-side-effect policy, plan/artifact validation,
version/update integrity, and append-only audit records. Codex sandbox and
approval policy are the security boundary; hooks are rails, never isolation.

## Runtime layout

`core/codex/` is the tracked source. Vendoring creates:

- root `AGENTS.md`: managed harness block merged without replacing project text;
- `.codex/skills/harness-*`: Codex-discoverable workflow skills;
- `.codex/agents/*.toml`: narrow custom eyes and hands;
- `.codex/config.toml`, `hooks.json`, `hooks/*.mjs`, and `rules/*.rules`:
  trusted project configuration, lifecycle rails, and external-command policy;
- `.codex/.harness-version`, `.harness-owned-files.json`, and `.gitignore`:
  lifecycle metadata and ephemeral paths.

No `core/codex/plugin`, second orchestration engine, role-specific executor
copies, or mutable global ceremony state is introduced.

## Roles and model routing

Eyes are read-only. Hands are workspace-write and remain constrained by the
parent's active Codex permission mode. A dispatch request must select the
following explicit route:

| Work | Model and effort |
| --- | --- |
| Narrow inventory, formatting, or mechanical evidence collection | `gpt-5.6-luna`, `low` |
| Focused implementation or test execution | `gpt-5.6-terra`, `medium` |
| Planning, adversarial review, security, or sensitive ambiguity | `gpt-5.6`, `high`; `xhigh` only after a failed gate or sensitive path |

The custom-agent catalog has one file per responsibility: planner,
plan-reviewer, adversary, security, compliance, executor, test-author,
harvester, and shipper. Tiers are dispatch data, not duplicated agent prose.

## Capability adjudication

Every Claude Code/OpenCode surface is recorded in a checked capability matrix:

- `native`: Codex runtime provides the control;
- `deterministic`: harness script enforces it at a documented hook boundary;
- `prose`: a skill or AGENTS contract is the appropriate implementation;
- `unsupported`: Codex has no safe equivalent, with exact reason;
- `intentionally-omitted`: a duplicate engine or low-value mechanism removed
  under the 80/20 rule.

An unsupported classification is completion only when its limitation and safe
operator alternative are documented.

## Hooks and state

One synchronous `policy.mjs` is the only writer/decision-maker for
`PreToolUse`, `PermissionRequest`, and `PostToolUse`. It receives the official
JSON payload on stdin and emits the official JSON decision schema. Each audit
record uses an atomic, validated, per-event path; there is no shared
read-modify-write gate-state file.

`PreToolUse` denies prohibited Bash, direct protected-harness mutations, and
unapproved lifecycle command forms before the side effect. `PostToolUse` only
records context and never claims to undo work. `Stop` and `SubagentStop` are
advisory and at most one continuation per checkpoint. Role ownership is never
asserted unless real runtime payloads prove a stable correlation.

Project hooks and rules require Codex project trust. The operator guide must
state this, hook hash review requirements, all tool paths that do not run local
hooks, and the fact that `danger-full-access` and same-user access are outside
the harness boundary.

## Permissions

The project default is `workspace-write` plus `on-request`; it does not set
`danger-full-access` or `never`. Native `.rules` block destructive command
prefixes and include inline rule examples. Secrets, remote deploys, force push,
and destructive Git cleanup remain forbidden. Permission approval hooks are
supplementary and are tested in both `on-request` and `never` modes.

## Lifecycle

The public vendor CLI accepts `--runtime codex` and `--runtime all`. It copies
framework-owned Codex files, excludes tests, rewrites only documented
source-to-vendor imports, preserves accumulated project memory, and records
owned paths. A second run is byte-idempotent. Existing user `config.toml` is
never overwritten; Codex runtime files that do not require config merging are
installed beside the existing trusted layer.

## Non-goals

- Claiming hook rails are a sandbox, multi-tenant isolation, or protection from
  a compromised same-user process.
- Porting deprecated VPS cron engine behavior as a new Codex engine.
- Adding a model router service, daemon, plugin loader, or mutable context
  sidecar.
- Replacing Codex native approval, sandbox, trust, or plugin security controls.

## Acceptance criteria

1. A capability matrix inventories all production Claude Code/OpenCode delivery
   surfaces and adjudicates each one.
2. The vendor creates a complete native Codex runtime and is idempotent in a
   fresh project, existing project, subdirectory, worktree, and symlink-safe
   target test.
3. Every applicable role, skill, rule, permission, and model route is present
   and its Codex configuration parses under `codex --strict-config`.
4. Critical hook decisions are exercised with official-shaped payloads and
   actual Codex CLI smoke probes: deny Bash, deny `apply_patch`, and intercept
   agent dispatch.
5. Hook trust, project trust, protected paths, parallel events, continuation
   limits, and bypass boundaries are documented and regression-tested.
6. The full repository suite, native Codex smoke tests, artifact test, and a
   post-implementation adversarial review are green.
