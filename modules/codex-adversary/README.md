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

## Where it runs — every eye runs on both families

The principle is not "a second adversary." It is: **not every task has an adversarial checkpoint,
but every checkpoint that runs a critical-judgment EYE runs it on BOTH families** — Claude and GPT —
so each family surfaces the problems the other's priors miss. The same bridge serves any read-only
eye role; it composes that role's prompt from the canonical core file at runtime (zero drift).

| Checkpoint | Role | Merge shape | How both families combine |
|---|---|---|---|
| Spec attack | `adversary` | findings | union + dedup + cross-check (B) |
| Per-task attack | `adversary` | findings | union + dedup + cross-check (B) |
| Final dual-review | `adversary` | findings | union + dedup + cross-check (B) |
| **Plan review** | `plan-reviewer` | **verdict** | **either-REVISE-wins + union of concerns** |
| **Security audit** (per-task 3b, final) | `security` | findings | union + dedup (**severity**, no `category`) + cross-check (B); SECURE\|UNSAFE verdict stays **Claude-authoritative** |

Two merge shapes, because the outputs differ:

- **findings** (`issues[]`) → `merge-findings.mjs`: union + dedup + cross-check policy B (keep a
  single-family finding unless the other family refutes it).
- **verdict** (`APPROVE | REVISE`) → `merge-verdicts.mjs`: a plan-reviewer returns a verdict, not a
  bug list. Here a Claude plan-reviewer and a GPT plan-reviewer run on the **same** plan to catch
  **distinct** engineering problems; if **either** says REVISE, the plan is REVISE, and the planner
  receives the **union** of both families' concerns. We do **not** require agreement — a defect only
  the GPT reviewer spotted is exactly the reason to run it. Fail-open: if Codex can't run, the
  merged verdict is just Claude's (never a spurious REVISE from an empty second opinion).

The **security** audit is findings-shaped, with two adjustments versus the adversary: it dedups on
`(scope, severity, evidence)` because security findings carry no `category`, and its `SECURE | UNSAFE`
gate verdict is recomputed from the merged findings (severity normalized across families, so a GPT
`Critical` still gates). Run it via `--role security`. To keep the second family from blocking
delivery on an unrefuted false-high, the verdict counts only `findings` that Claude has weighed in on
(agreed + claude-only survivors); a **codex-only** finding waits in `pendingClaudeRefutation` and is a
**delivery-blocking precondition** (recorded in gate-state like a `regate-pending`) until its Claude
refute-pass runs and the verdict is recomputed. So a GPT-only real defect still gates — once Claude
has confirmed it — but a GPT false-high never flips the gate behind the orchestrator's back, and a
forgotten refute-pass blocks rather than silently passing.

The role registry lives in `codex-adversary.mjs` (`ROLES`) — add a future eye by declaring its
canonical role file, the skills it loads, and its merge shape.

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

**Install** (Node 22+) — always the **scoped** package (`codex` unscoped is an unrelated 2012 package):

```bash
npm install -g @openai/codex      # or: brew install --cask codex
```

**Authenticate** (Codex caches the login and reuses it):

- **Subscription path (no API key):** `codex login` once — OAuth against your ChatGPT
  Plus/Pro/Team subscription. The "spend the subscription you already pay for" path. Token lands in
  `~/.codex/auth.json` — treat it as a password, never commit it.
- **API-key path (CI / reproducible):** `printenv OPENAI_API_KEY | codex login --with-api-key`.
  **Gotcha:** merely exporting `OPENAI_API_KEY` does **not** reliably override an active ChatGPT
  login — the subscription login takes precedence. Use `codex login --with-api-key` to force API-key
  mode.
- **Cloud routine:** add the install to the environment **setup script**. OAuth/subscription auth
  generally **cannot** complete headlessly — prefer the API-key path, or accept that the bridge fails
  open to Claude-only.

The harness toggle (`HARNESS_CODEX_ADVERSARY`) is independent of this — `npx claude-harness init`
(opt-in) sets it for you, but it **never** runs `codex login`; the OpenAI auth above is yours to run.

### 2. (Optional) Give Codex the same context — global vs per-project

For the Codex eye to inspect with the **same MCP context** as Claude, give Codex its own minimal,
**read-only** harness. Codex resolves config closest-wins: **per-project `.codex/` overrides global
`~/.codex/`** (the per-project files are loaded only in a *trusted* project — the direct analogue of
`.claude/`).

| What | Global (`~/.codex/`) | Per-project (versioned) |
|---|---|---|
| Config | `~/.codex/config.toml` | `.codex/config.toml` |
| Instructions | `~/.codex/AGENTS.md` | `AGENTS.md` at the repo root |
| Skills | `~/.codex/skills/` | `.codex/skills/` |
| Auth | `~/.codex/auth.json` | — |

- Copy `references/codex/config.toml.example` → `~/.codex/config.toml` **or** `.codex/config.toml`,
  and fill in the same MCP servers your `.mcp.json` declares. It pins `sandbox_mode = "read-only"`.
- Copy `references/codex/AGENTS.md` to the repo root **only if** you run Codex natively (not needed
  for the bridge path, which injects the role inline).
- Register the shared attack taxonomy as a Codex skill by placing the
  `canonical-critical-classes` skill folder under `~/.codex/skills/` (global) or `.codex/skills/`
  (per-project). The Codex docs say to *place the folder in the skills path*; a symlink to the
  vendored `.claude/skills/canonical-critical-classes` works but is not an officially documented
  mechanism — copy it if you want to be safe.

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

### The opt-in toggle (the operator chooses)

Cross-family is **off by default** — running it is the operator's explicit choice. There is **no
separate "Codex init"**: the harness is one install (`vendor-core.mjs`); Codex is just a second
*engine* for one role. To turn it on, either:

- **per-run:** `export HARNESS_CODEX_ADVERSARY=1`, or
- **per-task:** set `"adversarial": { "cross_family": true }` in the task contract (mirrors the
  existing `adversarial.enabled` flag).

`HARNESS_CODEX_ADVERSARY=0|off` force-disables even if a task sets the flag. Intent (toggle) and
capability (availability) are separate checks — turning it on never overrides the headless/no-codex
fail-open.

### 3. Wire it into the loop — one command (opt-in)

Keep the core untouched. Where the native adversary runs, capture its issues to JSON, then call the
**driver** — it gates on the toggle + availability, runs the Codex attack, merges, and runs the
Codex-side refutations, all in one step:

```bash
# 1. Claude adversary runs as today (native Agent) → claude-issues.json
# 2. One command drives attack + merge + Codex refutation (vendored path; run from the repo root):
node .claude/modules/codex-adversary/references/cross-family.mjs \
  --task .claude/plans/<feature>/task.json --claude claude-issues.json > xfam.json

# Security eye: same driver, --role security (the SECURE|UNSAFE verdict rides in xfam.json):
node .claude/modules/codex-adversary/references/cross-family.mjs --role security \
  --task .claude/plans/<feature>/task.json --claude claude-security.json > xfam-security.json
```

> In the **source** repo (not vendored) the path is `modules/codex-adversary/references/...`.

`xfam.json` contains:

- `findings` — ship to the sniper **now**: the `agreed` issues (both families) plus the claude-only
  issues Codex could **not** refute.
- `pendingClaudeRefutation` — codex-only issues whose refutation belongs to **Claude** (node cannot
  dispatch a Claude Agent). The orchestrator runs the native adversary in refute-mode on these, then
  calls `finalizeFindings` again to fold the survivors into `findings`.
- `dropped` — claude-only issues Codex refuted, with the refutation argument (audit trail).
- `enabled` / `available` — `false` here means it ran Claude-only (toggle off, or fail-open).

### How refutation works (cross-check policy B)

A finding **both** families raised ships as-is (`agreed`). A finding **one** family raised is
cross-checked by the **other** family:

| Finding seen only by | Refuter | Runs where |
|---|---|---|
| Claude | Codex | **in JS** — the driver does it (`runCodexRefutation`) |
| Codex | Claude | **orchestrator** — a native Claude adversary refute-pass (`pendingClaudeRefutation`) |

The refuter is asked to **refute** the finding (read-only). The finding is **kept unless** the
refuter returns `refuted: true`. If the refuter can't run (unavailable), the finding is **kept**
(fail-open — never drop a finding because the cross-check could not complete). This preserves the
minority catch — the whole reason for a second family — while still filtering false positives.

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
