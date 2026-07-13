---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "app/**/*.ts"
  - "app/**/*.tsx"
  - "worker/**/*.ts"
---

# Architecture

Loads when code lives in `src/`, `app/`, or `worker/`. Complements `code-quality`
(atomicity / DRY / naming) and `security` (input validation at the edge) — this rule
covers domain boundaries and modeling. The default is FLAT; rich modeling is conditional
(see Gotchas).

## Conventions

### Thin handler/controller
- A handler only: parses the request → calls a logic function → formats the response.
- Business logic NEVER lives in the handler. A domain `if` inside the handler means extract it into `src/lib/`.

### Boundary translation (Anticorruption Layer)
- An external API / third-party format (Stays, Meta, etc.) is translated into an INTERNAL type at the boundary.
- NEVER propagate a third-party raw shape into the core — when the third party changes its JSON, one translation file changes, not the whole codebase.
- The translation function lives next to the integration's client (`src/integrations/<name>/`), not scattered across the core.

### Shape isolation at the boundary
- A domain type != a DB row != a third-party shape. Never leak one of these into another.
- What crosses the boundary into the core is an owned type (an internal DTO / model), not the DB `row` nor the third-party payload.

### Typed value over primitive (primitive obsession)
- A value carrying a rule/invariant (`Email`, `Slug`, `Money`, `UserId`) becomes a branded type or value object — not a bare `string`/`number`.
- Only when the value carries an invariant; do not wrap a trivial primitive that has no rule.

### Logic next to its data (no anemic model)
- When a multi-step business rule with an invariant to protect exists, the logic lives WITH the data it operates on — not in an anemic "service" that manipulates a dumb struct from the outside.

## Gotchas

- **Rich modeling is CONDITIONAL**: only enable it (value objects, rich model, formal translation)
  when the feature touches money/auth OR has a real multi-step invariant. Otherwise keep it FLAT
  (thin handler + pure functions). A speculative `domain/application/infrastructure` skeleton in a
  flat codebase is the anti-pattern — never add a layer without a core that justifies it.
- **Leaked third-party shape**: accepting the external API's raw JSON directly into the core couples
  everything to their format. Translate at the boundary.
- **Anemic service on a flat feature**: extracting a "service" layer for a single-step CRUD path adds
  indirection with no invariant to protect. Keep the logic inline until a real invariant appears.
