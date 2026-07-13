# Approved Design: OpenCode Agent Catalog Hardening

## Components

- **Catalog resolver:** Select `.opencode/agents` whenever that directory exists. Use `core/opencode/agents` only when the vendored directory is absent in a source checkout.
- **Health checker:** Compare the selected catalog with the required native-agent list and return missing names without throwing.
- **Signal delivery:** Emit a one-time visible chat advisory for an incomplete catalog. If that delivery fails or is unavailable, write the advisory to the console.
- **Recovery contract:** State that the operator must re-vendor the harness and reopen the session. An active session cannot reload already discovered agent definitions.
- **Vendored documentation:** Copy `docs/SPAWN-PATTERN.md` into the vendored runtime. Keep it outside agent discovery and never expose it as a callable agent.
- **Routing record:** Supersede ADR-001 with an ADR that makes Ollama Cloud the default executor/sniper ladder.
- **Twin contract:** Keep `sniper-low` and `sniper-low-spawn` aligned in model and role body, allowing only the required spawn execution-mode differences.

## Error Handling

Catalog inspection, chat advisory delivery, and console fallback are best-effort and fail-open. Any filesystem, import, or delivery failure leaves the session operational. The console is a fallback signal, not a gate. The system does not attempt live repair or reload; reopening after re-vendoring is the supported recovery path.

## Tests

- Vendored catalog takes precedence over a complete source catalog when it exists.
- Source catalog is used only when the vendored catalog is absent.
- Missing agents produce a visible advisory and console fallback without throwing.
- The advisory directs re-vendoring and reopening, and the stale-session limitation is documented.
- Vendoring includes `docs/SPAWN-PATTERN.md`; callable-agent discovery excludes it.
- The superseding ADR and routing configuration agree on the Ollama Cloud executor/sniper default.
- `sniper-low` and its spawn twin remain aligned in source and vendored outputs.
