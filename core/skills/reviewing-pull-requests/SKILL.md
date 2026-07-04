---
name: reviewing-pull-requests
description: "Machine-only skill that orchestrates a fresh-eyes review session over a PR diff — adversary, compliance (via the diff-adapter), and security eyes, plus cross-family and gate-hardening 2nd pass. Eyes only, Claude tier, no write-hand. Writes the engine-controlled verdict artifact to the stateDir path, never inside the worktree."
---

# Reviewing-Pull-Requests — Fresh-eyes PR review session

**This skill is machine-only.** It is invoked by the Node review layer (cron-b / cron-review), never by `triaging-requests`. It orchestrates a read-only review session over `gh pr diff` — it spawns NO write-hand (no executor, no sniper, no Ollama hand-dispatch path). Every eye runs on Claude tier; no cheap-model fallback in judgment.

**Announce at the start (in pt-br):** "Iniciando sessão de revisão independente do PR #<N> — olhos frescos, somente leitura."

All identifiers, JSON keys, and reasoning stay in English. **Every message to the operator is pt-br, product-language.**

---

## Position in the system

```
Node review layer (cron-b / cron-review.mjs)
  → spawns this skill session (claude -p, read-only)
    → adversary + compliance (diff-adapter) + security
    → cross-family (when available)
    → gate-hardening 2nd pass (when diff touches gate machinery)
    → writes verdict artifact to engine-controlled stateDir
```

The Node layer owns the lock, origin-gate, idempotency, chain counter, circuit-breaker, merge decision, relabel, and notify. This skill session owns **only the judgment** — it reads the diff, runs the eyes, and writes the verdict artifact. It never mutates the worktree, never checks out a branch, and never invokes a write-capable hand.

---

## Input (received from the Node layer)

The Node layer passes these via the session brief (environment / CLI args):

| Input | Source | Description |
|---|---|---|
| `prNumber` | `gh pr list` | The PR number to review |
| `headSha` | `gh pr view --json headRefOid` | The HEAD commit SHA under review |
| `stateDir` | engine-controlled | Absolute path to the harness state directory (e.g. `.claude/plans/.state/<session_id>/`) |
| `changedFiles` | `gh pr diff --name-only` | Repo-relative paths changed in the PR diff |
| `prTitle` | `gh pr view --json title` | PR title (for the compliance diff-adapter) |
| `prBody` | `gh pr view --json body` | PR body (for the compliance diff-adapter) |

---

## Review flow

### Step 1 — Fetch the diff

Run `gh pr diff <prNumber>` to obtain the full diff. This is the sole input to every eye — the skill never checks out a branch (HR-7: no worktree collision with concurrent repair).

### Step 2 — Synthesize the compliance pseudo-contract

The compliance agent is task-oriented — it expects `criterion_refs` and `locked_tests` from a plan. A raw PR diff has no plan. The **compliance diff-adapter** (`references/compliance-diff-adapter.mjs`) bridges this gap:

```
node core/skills/reviewing-pull-requests/references/compliance-diff-adapter.mjs \
  --title "<prTitle>" --body "<prBody>" --changed-files "<changedFiles...>"
```

It synthesizes a pseudo-contract:
- `criterion_refs` — every `#ac-N.M` found in the PR title + body, in order. When none exist, falls back to a title-derived synthetic ref (`#ac-title:<kebab-case-title>`) — never empty (a vacuous contract would let compliance pass blindly).
- `scope_paths` — the PR's changed files, unmodified.

The output is the contract the compliance eye consumes.

### Step 3 — Fan-out the three eyes (concurrent, read-only)

Dispatch all three eyes **concurrently in a single fan-out** (one message with N Agent calls). Every eye is read-only, Claude tier, and mutually independent — no ordering constraint among them. The skill blocks until all verdicts arrive (fan-out-join).

**3a. adversary** (opus, virgin) — receives the raw `gh pr diff` + the PR title/body. No prior verdicts, no compliance findings, no anchor. Attests the canonical failure classes (each with a `file:fn` citation) and reports every real failure mode at honest severity with `fix_hint`. Zero findings is a valid attested result — never fabricate to hit a count.

**3b. compliance** (sonnet) — receives the raw `gh pr diff` + the synthesized pseudo-contract from Step 2 (NOT the adversary's findings). Validates the diff against the `criterion_refs` and `scope_paths` from the pseudo-contract. Returns `pass | partial | fail` + issues.

**3c. security** (opus) — receives the raw `gh pr diff`. Audits for secrets, injection, auth bypass, unsafe input handling, and every other surface in the security rules. Returns `SECURE | UNSAFE` + issues.

### Step 4 — Cross-family (when available)

When the `codex-adversary` module is installed AND the global switch `HARNESS_CODEX_ADVERSARY` is on AND `codex` is reachable, run the **adversary** AND **security** eyes on a second model family (GPT via Codex CLI) and merge under **policy B**:

```
node .claude/modules/codex-adversary/references/cross-family.mjs \
  --role adversary --task <task.json> --claude <claude-issues.json>
node .claude/modules/codex-adversary/references/cross-family.mjs \
  --role security --task <task.json> --claude <claude-issues.json>
```

- A single-family finding is kept unless the other family refutes it — never majority voting.
- Codex-only findings get their Claude refute-pass before being folded into the verdict.
- For security, the `SECURE|UNSAFE` verdict is recomputed only after the refute-pass.
- **Fail-closed if absent:** when the module is absent, the switch is off, or `codex` is unreachable, the checkpoint runs Claude-only — but the cross-family requirement is **recorded as unmet** in the verdict artifact (`crossFamilyEligible: false`), and the merge-eligible conjunction (HR-9) requires it. Absence → awaiting-merge, never fail-open "ok" (HR-2).

**Compliance stays Claude-only** — it checks THIS PR's acceptance criteria against the pseudo-contract, not general failure modes a second family would diversify.

### Step 5 — Gate-hardening 2nd pass (when diff touches gate machinery)

When the PR's `changedFiles` touch the harness's own gate machinery (detected by `core/vps/review-gate-hardening.mjs` → `touchesGateMachinery(changedFiles)` — globs: `core/vps/`, `core/skills/`, `core/agents/`, `core/rules/`, `verdict-block`, `settings.json`, `CLAUDE.md`), a **second independent fresh-eyes pass** is required before merge (HR-9).

Run a **second virgin adversary** (opus, fresh session, no prior verdicts) against the same diff. This is a distinct eye dispatch — not a re-run of Step 3a. The second pass returns its own independent verdict.

The merge-eligible conjunction (HR-9) is:

```
eligible = freshVerdictClean
  && crossFamilyEligible
  && (secondPassRequired ? secondPassClean : true)
```

A single flaky CLEAN is never sufficient on its own. The `second_pass_required` flag is observable at the routing decision (HR-10: BLOCKED → awaiting-merge), not at the merge.

### Step 6 — Write the verdict artifact

Compute the final verdict from all collected eye outputs and write the **engine-controlled verdict artifact** to the stateDir path — **never inside the worktree** (HR-5):

```
join(stateDir, `review-<prNumber>-<headSha>.json`)
```

The artifact shape:

```json
{
  "pr": "<prNumber>",
  "sha": "<headSha>",
  "freshVerdictClean": true,
  "crossFamilyEligible": true,
  "secondPassRequired": true,
  "secondPassClean": true,
  "adversary": { "findings": [], "verdict": "CLEAN" },
  "compliance": { "findings": [], "verdict": "pass" },
  "security": { "findings": [], "verdict": "SECURE" },
  "crossFamily": {
    "adversary": { "findings": [], "merged": true },
    "security": { "findings": [], "merged": true }
  },
  "gateHardening": {
    "secondPassRequired": true,
    "secondPass": { "findings": [], "verdict": "CLEAN" }
  }
}
```

A CLEAN file named `review-<pr>-<sha>.json` that happens to appear in the PR diff itself is **ignored** — the artifact is written to the engine-controlled stateDir, never inside the worktree, so it can never collide with a file in the diff.

The Node layer reads this artifact to determine merge eligibility. The artifact is the **single source of truth** for the review verdict — the Node layer must switch from `parseVerdictBlock(body)` to reading this fresh artifact.

---

## Model routing

| Role | Model | Why |
|---|---|---|
| adversary | **opus** | Strongest available tier for the fresh-eyes attack — the core of the review |
| compliance | **sonnet** | Spec-vs-diff check; the pseudo-contract is simpler than a full plan |
| security | **opus** | Conditional auditor; security findings are load-bearing for the merge gate |
| gate-hardening 2nd pass | **opus** | Second virgin adversary — same tier as the first, independent perspective |
| cross-family (adversary) | GPT via Codex | Second model family; read-only eye, never a cheap hand |
| cross-family (security) | GPT via Codex | Second model family; read-only eye, never a cheap hand |

**No eye role ever falls below the sonnet floor** — never haiku, never a non-Claude tier for the primary eyes. The cross-family second opinion is a Claude-tier peer, not a cheap fallback. **No write-hand is spawned** — no executor, no sniper, no Ollama hand-dispatch path. This skill is eyes-only.

---

## What this skill is NOT

- It does **not** implement, fix, or modify any code — it spawns no write-hand (no executor, no sniper, no Ollama hand-dispatch path). Eyes only.
- It does **not** merge, relabel, or notify — the Node review layer owns those actions.
- It does **not** check out branches or mutate the worktree — it reads via `gh pr diff` only (HR-7).
- It does **not** write the verdict artifact inside the worktree — the artifact goes to the engine-controlled stateDir (HR-5).
- It does **not** fail-open on cross-family absence — absence is recorded as `crossFamilyEligible: false` and the merge-eligible conjunction requires it (HR-2).
- It is **not** invoked by `triaging-requests` — it is machine-only, spawned by the Node review layer.
- It does **not** use `parseVerdictBlock` or any body-parsed verdict — the verdict artifact is the single source of truth.
