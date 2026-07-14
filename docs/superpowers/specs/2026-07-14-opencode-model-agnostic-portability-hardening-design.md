# Spec: OpenCode model-agnostic portability hardening

Feature ID: opencode-model-agnostic-portability-hardening
Mode: full
Priority: P0
Date: 2026-07-14

## Outcome

Transform the OpenCode harness into a model-agnostic runtime, remove every active Grok dependency, and close confirmed gaps that block legitimate delivery or permit control bypass. Existing vendored projects must migrate safely. Mandatory primary review and optional second-family coverage remain independently auditable.

## Locked decisions

1. No active OpenCode role uses Grok.
2. Critical reasoning roles formerly on Grok use openai/gpt-5.6-sol.
3. Test author and its spawn twin use ollama-cloud/glm-5.2.
4. Non-critical roles formerly on grok-build use openai/gpt-5.5.
5. Canonical role names are provider-agnostic.
6. Family 1 is mandatory. Only useful completed family-1 reviews count toward round limits.
7. Family 2 is optional and fail-open. It never counts and never claims full coverage when absent or failed.
8. Family 2 initially uses ollama-cloud/kimi-k2.7-code and remains configurable.
9. Provider-coded names remain compatibility aliases for two releases.
10. Full delivery begins only after the bootstrap restart.

## Target routing

| Role | Model |
|---|---|
| build | openai/gpt-5.6-sol |
| planner | openai/gpt-5.6-sol |
| plan-reviewer-family-1 | openai/gpt-5.6-sol |
| plan-reviewer-family-2 | ollama-cloud/kimi-k2.7-code |
| adversary-family-1 | openai/gpt-5.6-sol |
| adversary-family-2 | ollama-cloud/kimi-k2.7-code |
| compliance | openai/gpt-5.5 |
| security | openai/gpt-5.5 |
| executor-low and sniper-low | ollama-cloud/gemma4:31b |
| executor-medium and sniper-medium | ollama-cloud/glm-5.2 |
| executor-high and sniper-high | ollama-cloud/kimi-k2.7-code |
| test-author and test-author-spawn | ollama-cloud/glm-5.2 |
| harvester and shipper | openai/gpt-5.5 |
| default model | openai/gpt-5.6-sol |
| small model | openai/gpt-5.5 |

## User journeys

- UJ-1: A new delivery runs without calling Grok.
- UJ-2: One useful family-1 review records exactly one primary round.
- UJ-3: Provider failure before a useful report does not consume a review round.
- UJ-4: Family 2 unavailable does not block after successful family 1 and does not claim full dual coverage.
- UJ-5: Stale ceremony, conflicting identity, forged marker, or missing primary proof cannot unlock delivery.
- UJ-6: Compact and resume restores context and unresolved re-gates.
- UJ-7: Harvester cannot run without valid findings from the current run.
- UJ-8: Version-1 projects update through a two-release alias window.
- UJ-9: Fresh install, local checkout, worktree, and VPS load the same complete catalog.
- UJ-10: Targeted tests use commands accepted by deterministic shell policy.

## Acceptance criteria

### Models and families

- AC-1.1: No active model field in root config, core OC tree, vendored runtime, agent frontmatter, spawn agents, defaults, or VPS output references xai or Grok.
- AC-1.2: modelCapabilities includes openai/gpt-5.6-sol with reasoning effort support.
- AC-1.3: Both test-author agents use GLM 5.2.
- AC-1.4: Root config, sidecar, and OC example use GPT-5.6-sol as default and GPT-5.5 as small model.
- AC-1.5: Routing validation is capability-driven and has no provider-specific exception.
- AC-1.6: A no-active-Grok regression test scans runtime-driving files.
- AC-2.1: Canonical agents are adversary-family-1, adversary-family-2, plan-reviewer-family-1, and plan-reviewer-family-2.
- AC-2.2: An explicit catalog records logical role, family, primary, optional, and countsLoop.
- AC-2.3: Runtime never identifies family by provider suffix.
- AC-2.4: Four old names remain real alias files for two releases.
- AC-2.5: Internal dispatch emits canonical names only.
- AC-2.6: Routing version 2 has required family 1 and optional family 2.
- AC-2.7: Version-1 routing loads through a compatibility adapter with warning.

### Review accounting

- AC-3.1: Loop guard never increments useful-review counters before execution.
- AC-3.2: Useful family-1 adversary and plan-review reports increment once after execution.
- AC-3.3: Empty, malformed, denied, crashed, timed-out, unauthenticated, or provider-error outputs do not increment useful rounds.
- AC-3.4: Family 2 never increments primary rounds.
- AC-3.5: Primary provider failures use a separate bounded failure streak.
- AC-3.6: Inflated legacy counters move to legacy audit fields and do not block new useful rounds.
- AC-3.7: Delivery requires useful family-1 proof independently of dual status.
- AC-3.8: Primary success plus family-2 failure records primary-only status and is not full dual coverage.
- AC-3.9: Dual nudge cannot write terminal fail-open solely because a feature flag is disabled.

### Gate integrity

- AC-4.1: Ceremony is session-and-feature-bound.
- AC-4.2: Conflicting task identity aliases fail closed.
- AC-4.3: Trusted platform identity wins when available.
- AC-4.4: Ordinary model shell access cannot invoke privileged markers without session capability or verifiable evidence.
- AC-4.5: Observability-only markers cannot mutate privileged state.
- AC-4.6: active_dispatch is atomically produced and cleared for writing hands.
- AC-4.7: Scope enforcement starts in shadow mode and becomes fail-closed only after composition proof.
- AC-4.8: Fidelity, capture, regate, session, plan, and anti-forgery gates remain green.

### Lifecycle and distribution

- AC-5.1: Reinjection uses the installed OC compacting hook rather than chat-text matching.
- AC-5.2: Reinjection restores mode, feature, canonical plan path, progress, shared context location, and unmatched re-gates.
- AC-5.3: Reinjection cannot read another session.
- AC-5.4: Harvest guard intercepts task or agent dispatch of the canonical harvester role.
- AC-5.5: Missing, empty, directory-shaped, stale, or wrong-session findings block harvest by throwing.
- AC-5.6: Harvest resolves directory or worktree root, never accidental process working directory.
- AC-5.7: Completion clears stale current-session markers under retention policy.
- AC-6.1: Root config, sidecar, OC example, vendor defaults, VPS list, and vendored runtime have the same plugin set.
- AC-6.2: Health checks require every delivery-critical plugin.
- AC-6.3: Re-vendor removes retired framework files while preserving project-owned memory and config.
- AC-6.4: Tests fail when root config references missing vendored plugins; no soft skip hides it.
- AC-6.5: An unmerged sidecar cannot be reported as active configuration.
- AC-6.6: VPS partial legacy plugin lists are upgraded or rejected.
- AC-6.7: OC warns when stale Claude and OC skill catalogs coexist.
- AC-6.8: Published artifact and fresh vendor smoke tests include all required files.

### Deterministic usability

- AC-7.1: Latest victor-bot package-runner and interpreter blocks are documented as legitimate policy denies.
- AC-7.2: Planner and executor guidance chooses direct allowlisted targeted test commands.
- AC-7.3: Final reviewers do not recursively dispatch delivery agents without valid context.
- AC-7.4: Probes classify tool events and gate prefixes, never exit code alone.
