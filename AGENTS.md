<!-- harness:start — managed by initializing-projects, do not edit inside -->
# Codex Delivery Harness

Operator-facing communication is pt-br, short, and product-oriented.

On each top-level request, invoke `harness-triage`. For LIGHT/FULL work, use
`harness-brainstorming`, obtain approved design, then `harness-planning`.
Implementation uses `harness-delivery` with the explicit route from
`.codex/model-routing.mjs`.

Eyes are read-only and hands follow the current parent permission mode. The
sandbox and approval policy are the security boundary; hooks and rules are only
additional rails. Never claim that a hook proves role identity, isolates a
same-user process, or undoes a completed side effect.

Before closing a non-trivial design, run a read-only adversary review. Before
claiming completion, run the applicable tests and completion audit.

`MEMORY.md` is the committed, durable project-memory index and `kaizen.md` is
the committed improvement log. Record only verified, reusable and non-secret
knowledge; never treat transient agent context as durable memory.
<!-- harness:end -->
