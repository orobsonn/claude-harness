# Add-on: Codex Adversary (cross-family second eye)

A **second adversary of a different model family**, run **in parallel** with the native Claude
`adversary` — same role prompt, same `canonical-critical-classes` skill, same input, same output
schema. The **only** variable is the model family (OpenAI GPT via the Codex CLI). Because the two
families fail differently, their union surfaces blind spots neither catches alone.

This extends the harness philosophy one notch:

> **strong eyes, cheap hands** — and, for the last gate, **two strong eyes of *different families*.**

The native `adversary` (an EYE role) always stays on Claude — that constraint is untouched. This
add-on does **not** replace it; it runs a *peer* attack on GPT and merges the findings. It is an
**opt-in add-on, never hardcoded into the core** — if the `codex` CLI is absent or unauthenticated,
the bridge **fails open**: the run degrades to the Claude-only adversary exactly as today and
**never blocks**.

---

## Why a different family (not just more Claude votes)

Running the Claude adversary N times is **redundancy** — it re-finds the same points (same training
priors, same blind spots). Running Claude **and** GPT is **diversity** — each family catches what the
other's priors miss. This is *perspective-diverse verification*: the value is the **union** of blind
spots, not a majority vote.

Consequently the merge is **not** majority voting (that would suppress exactly the minority finding
that only one family saw — the gold). It is:

1. **Union** of both families' issues.
2. **Dedup** by `(scope, category, evidence)` — an issue both families raised is `agreed` (high
   confidence, ships as-is).
3. **Cross-check (policy B)** for any issue **only one** family raised: the *other* family attempts
   to **refute** it. Keep it **unless** the other family refutes it. This filters false positives
   **without** discarding the minority catch just for being minority.

```
        ┌─ Claude adversary ─┐
 task ──┤  (same role+skill)  ├─→ union → dedup → cross-check(B) → merged findings → sniper
        └─ Codex  adversary ─┘
               ↑ different family = different points
```

Validation focus is **general**: bugs, broken logic, future-failure modes, the 8 canonical critical
classes — identical to the native adversary, because it *is* the native adversary's prompt.

---

## How parity is guaranteed (single source of truth)

The bridge does **not** copy the adversary prompt. At runtime it **composes** the Codex prompt from
the canonical sources already in the core:

- `core/agents/adversary.md` — the attack role (frontmatter stripped).
- `core/skills/canonical-critical-classes/SKILL.md` — the shared ammunition.

So there is **zero drift**: edit the Claude adversary and the Codex adversary changes with it. Both
families read the same words; only the inference engine differs.

---

## Enable

### 1. Install + authenticate the Codex CLI

The bridge speaks to OpenAI **only** through the Codex CLI, which carries its own auth.

- **Subscription path (no API key):** `codex login` once — Codex uses your ChatGPT Plus/Pro
  subscription via OAuth. This is the "spend the subscription you already pay for" path.
- **API-key path (pay-per-token, more robust/reproducible):** set `OPENAI_API_KEY` for Codex.

- **Desktop:** install per the Codex CLI docs, then `codex login`.
- **Cloud routine:** add the install to the environment **setup script**. Note: OAuth/subscription
  auth generally **cannot** complete headlessly — for cloud routines prefer the API-key path, or
  accept that the bridge fails open to Claude-only.

### 2. (Optional) Mirror MCP + skills into Codex

For the Codex adversary to inspect the repo with the **same MCP context** as Claude, give Codex its
own minimal, **read-only** harness (it needs skill + MCP + role to attack — not a dumb one-shot):

- Copy `references/codex/config.toml.example` → `~/.codex/config.toml` and fill in the same MCP
  servers your `.mcp.json` declares. The profile pins `sandbox_mode = "read-only"`.
- Copy `references/codex/AGENTS.md` to the repo root **only if** you run Codex natively (not needed
  for the bridge path, which injects the role inline).
- Register the shared attack taxonomy as a Codex skill:
  `ln -s "$PWD/core/skills/canonical-critical-classes" ~/.codex/skills/canonical-critical-classes`

The bridge path (inline-composed prompt) works **without** step 2; step 2 only matters when you want
Codex to natively load skills/MCP rather than receive the composed prompt.

### Headless behavior (Claude-only by default)

In a HEADLESS cloud routine (`$CLAUDE_CODE_REMOTE` set) the subscription/OAuth login **cannot**
complete — there is no browser to authorize. So the bridge is **deterministically unavailable**
there unless an `OPENAI_API_KEY` is provisioned in the environment setup script. When unavailable it
returns `{ available: false, issues: [] }` and exits `0`, and the merge step runs the **Claude-only
adversary exactly as today**. The second family is a LOCAL (or API-key-equipped) enhancement; it is
**never** a precondition for a headless run to complete. This is enforced in `checkAvailability()`,
not left to chance.

### 3. Wire it into the loop (opt-in)

Keep the core untouched. In your orchestration, where the native adversary runs, **also** run the
bridge in parallel and merge — see `references/codex-adversary.mjs` and `references/merge-findings.mjs`.
Sketch:

```bash
# 1. Claude adversary runs as today (native Agent) → claude-issues.json
# 2. Codex adversary, same task, different family:
node modules/codex-adversary/references/codex-adversary.mjs \
  --task .claude/plans/<feature>/task.json > codex-issues.json
# 3. Merge: union + dedup, and emit the cross-check work-list (policy B):
node modules/codex-adversary/references/merge-findings.mjs \
  --claude claude-issues.json --codex codex-issues.json > merged.json
# 4. For each entry in merged.needsCrosscheck, dispatch the OTHER family to refute,
#    then finalize: keep unless refuted. Feed survivors to the sniper.
```

---

## Caveats

- **Subscription ≠ API.** A ChatGPT Plus/Pro subscription does **not** expose the OpenAI API; the
  only way to spend it programmatically is *through* the Codex CLI's own OAuth. Using that token
  outside Codex is a ToS gray zone and is fragile (breaks when the OAuth flow changes). For
  reproducible CI, prefer an OpenAI **API key**.
- **Headless auth.** OAuth login can't run in a cloud routine. Either provision an API key in the
  setup script or let the bridge fail open to Claude-only.
- **Read-only is enforced.** The Codex adversary runs `--sandbox read-only`: it inspects and judges,
  it never mutates. It is an EYE, not a hand.
- **Cost.** Each gate now pays two strong-eye passes plus the cross-check refutations. Worth it for
  the final dual-review gate; consider gating it to FULL / high-severity tasks only.
- **Fail-open is load-bearing.** A missing/again-unauthenticated `codex` must never block delivery.
  The bridge returns `{ available: false, issues: [] }` and the merge degrades to Claude-only.
