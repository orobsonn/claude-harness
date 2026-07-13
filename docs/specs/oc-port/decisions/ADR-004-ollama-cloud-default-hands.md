# ADR-004 - Ollama Cloud default hands

**Status:** accepted
**Date:** 2026-07-13

## Decision

OpenCode defaults executor and sniper hands to the Ollama Cloud ladder:

- Low: `ollama-cloud/gemma4:31b`
- Medium: `ollama-cloud/glm-5.2`
- High: `ollama-cloud/kimi-k2.7-code`

The strong evaluator eyes remain unchanged: Grok leads planning and adversarial review, with OpenAI as the required cross-family dual for plan review and adversarial review.

## Prerequisite

Ollama Cloud credentials and approval for the provider egress are operator prerequisites before a hand is dispatched. The current harness does not enforce credential checks, egress preflight, or consent at runtime. Operators must ensure task prompts and scoped repository context do not contain secrets or data that must not leave the environment. Missing credentials are a configuration error, not a reason to silently fall back to another provider.

## Consequences

- `harness.routing.json`, agent frontmatter, and spawn twins must use this same ladder.
- Spawn twins differ only for primary-mode invocation, disabled nested task dispatch, and explicit CLI guidance.
- This ADR supersedes ADR-001 for OpenCode routing only.
