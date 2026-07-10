# ADR-001 — No Ollama in default routing

**Status:** accepted  
**Date:** 2026-07-10

## Decision

Default OpenCode harness routing uses **xAI Grok** for motor/hands and **OpenAI** for evaluator eyes. Ollama is not part of the default map.

## Context

Claude harness used Ollama for cheap hands. Operator is standardizing on subscription Grok ($30 works with Grok Build; Heavy optional later) + OpenAI for eyes. Provider-agnostic routing still allows users to point hands at Ollama later via `configuring-model-routing`.

## Consequences

- Spawn adapters must not assume `OLLAMA_HAND_TOKEN` as the only auth path for OC default.  
- Claude target may keep Ollama hand path independently.  
- Docs and `.dev.vars.example` should not imply Ollama is required for OC.
