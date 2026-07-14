# Spec: audit-oc-portability

Feature ID: audit-oc-portability
Mode: full
Priority: P0

## Product outcome
Assess whether the Claude Code harness ports safely to OpenCode, then remedy only verified critical legitimate-run blockers or delivery-control bypasses.

## Scope
- Map repository topology and delivery surfaces: entry, planning, dispatch, gate state, permissions, dual eyes, observability, lifecycle, vendoring, and deterministic checks.
- Compare active Claude Code and OpenCode behavior plus shared primitives by contract, not filename.
- Analyze only the newest available real OpenCode session, including deterministic-gate failures.
- Obtain an independent OpenAI-family assessment of parity gaps.
- Run targeted deterministic checks and fix verified critical findings only.

## Non-goals
No broad refactor, speculative parity work, older-session analysis, release, commit, push, or deployment.

## User journeys
- uj-1: Valid OpenCode delivery passes required entry, plan, and deterministic controls.
- uj-2: Attempts to evade gate state, scope, or role controls are denied or explicitly fail-open under policy.
- uj-3: A newest-session gate failure is sourced, reproduced when possible, and classified.
- uj-4: A maintainer gets a traceable CC-to-OC surface map and residual-risk report.

## Acceptance criteria
- ac-1.1: Inventory links CC source, OC counterpart, shared primitive, tests, and parity status.
- ac-1.2: Audit plan is ordered by independently reportable surfaces.
- ac-1.3: Only newest-session evidence is analyzed; no secret-bearing raw log is retained.
- ac-1.4: Independent OpenAI-family review challenges unsupported parity assumptions.
- ac-1.5: Gate failures are reproduced or explicitly classified as environment/session evidence.
- ac-1.6: Every verified critical issue gets regression coverage and green affected gates.
- ac-1.7: Residuals are prioritized as parity, intentional divergence, accepted residual, or follow-up.

## Locked decisions
- audit approach: Surface audit: map, behavioral comparison, newest-session evidence, deterministic validation, independent challenge. Operator approved option 2.
- session scope: Inspect only newest available OpenCode session. Operator approved.
- critical threshold: Fix both legitimate-run blockers and control-bypass gaps. Operator confirmed.
- change scope: Fix verified critical findings only. Operator chose outcome B.
- independent review: Include a solo OpenAI-family evaluator; strong models handle complex analysis. Operator requested.

## Analysis surfaces
1. Topology, ownership, generated and vendored boundaries.
2. Behavioral matrix: entry and plan, marks and state, roles, dual, permissions scope shell, lifecycle, observability, vendoring.
3. Static contracts and test coverage.
4. Newest-session evidence and reproducibility.
5. Independent GPT challenge.
6. Critical remediation and regression.
7. Final validation and prioritized residual report.

## Model routing
Complex behavior and independent challenge use strong eyes. Mechanical inventory uses low tier if an implementation hand is needed. Critical behavior fixes use high tier and bounded logic fixes use medium tier.

## Demo
1. Surface map and parity labels.
2. Newest-session gate-failure classification.
3. Regression proof for each critical correction.
4. Affected deterministic checks and remaining risks.

## Adversarial safeguards added
- Target selection: Snapshot the newest completed non-current OpenCode session before analysis. Record only its session identifier and derived timestamps. Exclude the audit session and concurrent active sessions.
- Log handling: Retain derived evidence only: event type, gate prefix, status, selected session identifier, and redacted path or hash. Never copy raw stdout, stderr, tool payloads, credentials, or user data into plans, shared context, findings, or documentation.
- Gate oracle: Classify OpenCode probes from parsed tool-use gate-prefix evidence, not process exit code alone. Include deny and allow probes for entry gate, plan gate, and plugin loading.
- Registration parity: Inventory root opencode.json, the core example, vendoring default plugin paths, canonical VPS plugin registration, and the vendored runtime copy.
- Review coverage: The independent OpenAI reviewer completed. The paired primary reviewer was prevented from returning a report because the loop guard recorded adversary_loop_count equal to four before a usable result; dual status is incomplete and must never be reported as full coverage.
