# Configure-routing caller authority — Design

## Problem

`configure-routing` accepts weak-eye confirmation as an ordinary model-supplied argument. The
runtime must require an operator-host permission prompt and limit the tool to the root lifecycle
lane, so a delivery or child agent cannot silently weaken the judges.

## Chosen design

Use the existing OpenCode authority surfaces only:

1. The root OpenCode config marks `configure-routing` as `ask`; `general` and `explore` override
   it to `deny`. On every mutating `apply`, the native tool also calls `context.ask` directly. The
   host owns that confirmation, not the model; one-shot/headless runs reject it rather than silently
   treating a model flag as approval.
2. `entry-gate` recognizes the native tool. It resolves the caller from the official SDK's exact
   session and tool-call facts, then permits only a root `harness-config` session. Missing,
   conflicting, child, or other-agent facts deny.

The existing confirmation arguments remain inputs to the routing engine, but can reach it only
after the host permission and authority checks. No new persisted state, session mode, service, or
prompt protocol is introduced.

## Tests

- config contract: root `ask`; `general`/`explore` deny in both tracked configs;
- entry-gate: root `harness-config` permits; child and non-lifecycle callers deny;
- local OpenCode smoke: root lane reaches the tool, headless apply is host-rejected, and `build`
  is denied by the entry-gate.
- regression: normal build Task flow remains allowed.

## Non-goals

- Proving a terminal/UI transport mode unavailable in the OpenCode tool context.
- Adding an approval ledger or an independent confirmation system.
