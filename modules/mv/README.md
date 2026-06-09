# Add-on: MV (Mind Vault)

Mind Vault is an external MCP that provides a curated latticework of **mental models** — reusable
engineering/design lenses (atomicity, idempotency, separation of responsibilities, escalation vs.
approval, leverage points). The `planner` and `plan-reviewer` consult it as **advisory lenses** when
shaping a non-trivial decision; the `harvester` may optionally check it for duplicates before
proposing a global learning.

This is an **optional, recommended** add-on — it sharpens planning quality — but it is never a hard
dependency. The agents already treat it as **best-effort**: if MV is absent (common in headless/cron
runs), they plan with their own judgment and **never block** on it.

## Connection model

MV connects **per user** — never a shared instance.

- **Desktop / claude.ai:** add MV as a connector in your Claude account.
- **Cloud routine:** commit a `.mcp.json` at the repo root declaring the MV server with the
  operator's own credentials.

Each operator's vault is their own. The harness core ships **no** MV credentials, endpoints, or
shared instance.

## Agent wiring

The agents that consult MV declare these tools (already present, best-effort):

```
mcp__claude_ai_mv__recall      # domain-literal query → tldr of relevant lenses
mcp__claude_ai_mv__get_note    # pull the body of the 1–2 directly relevant notes
```

If MV is not connected, these tools are simply unavailable and the agents proceed without them.

## Privacy

The `harvester` **never** auto-writes to MV. Global knowledge entering any vault is always a human
decision (it writes a suggestion to an ephemeral file for the human to review). The harness never
sends project content to a shared or third-party vault.
