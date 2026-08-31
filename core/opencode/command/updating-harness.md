---
description: Instalar, atualizar ou sincronizar o Claude Harness neste projeto, sem trocar de conversa.
---

Load the `oc-updating-harness` skill and follow only it.

This is a harness lifecycle operation inside `build`, not a delivery: do not classify, do not load
`oc-brainstorming` or `oc-orchestrating-delivery`, and do not dispatch a subagent. Run it once,
report the result in pt-br, and require a new session.

Operator request (may be empty): $ARGUMENTS
