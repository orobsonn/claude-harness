# OpenCode single Build primary design

## Goal

Make `build` the only OpenCode primary agent. Operators stay in one conversation for
planning, delivery, lifecycle updates, and model-routing changes.

## Decisions

- Remove the user-facing `plan` and `harness-config` primary agents.
- Keep `planner`, reviewers, and hands as internal subagents dispatched only by `build`.
- Keep `/updating-harness` and `/configuring-model-routing` as convenience commands, but do not
  attach either command to another agent. They run in the active `build` session.
- Lifecycle requests are administrative, not delivery. They bypass `classify`, plans, and
  subagent dispatch, then terminate the session after `merged` or `noop`.
- Preserve lifecycle isolation with native purpose-built tools. The tools have fixed arguments,
  reject child and fleet-dispatched sessions through authoritative session metadata, and never
  expose a generic lifecycle shell sequence to `build`.
- `configure-routing` remains host-confirmed. Harness update retains the verified vendoring CLI,
  manifest-only PR contents, squash merge, and mandatory restart.

## Flow

```text
direct operator request or slash command
              |
            build
     +--------+---------+
     |                  |
delivery request    lifecycle request
     |                  |
triage + pipeline    native isolated tool
     |                  |
internal roles       merged/noop -> restart
```

## Safety boundaries

Only a root `build` session may invoke lifecycle tools. Fleet-dispatched and child sessions are
rejected before the tool runs. The lifecycle tool derives the release tag itself, passes it as
an argument vector to the pinned CLI, and returns its result without accepting shell fragments.
The existing vendor manifest and GitHub branch protections remain the final authority for merge.

## Verification

- Unit tests lock the single-primary catalog, command routing, native-tool authority, and
  lifecycle argument construction.
- The OpenCode contract suite runs against the vendored source.
- A live VPS run executes `/updating-harness` from `build` and a normal delivery request to
  prove the paths diverge correctly without changing primary role.
