---
name: reviewing-pull-requests
description: "Machine-only skill that runs a fresh-eyes review session over a PR diff — adversary, compliance (via the diff-adapter), and security eyes. Eyes only, Claude tier, no write-hand. Emits raw eye-outputs to the engine-controlled stateDir; Node (cron-review) derives the canonical merge verdict from them and orchestrates cross-family eligibility."
---

# Reviewing-Pull-Requests — Fresh-eyes PR review session

**This skill is machine-only.** It is invoked by the Node review layer (cron-b / cron-review), never by `triaging-requests`. It orchestrates a read-only review session over `gh pr diff` — it spawns NO write-hand (no executor, no sniper, no Ollama hand-dispatch path). Every eye runs on Claude tier; no cheap-model fallback in judgment.

**Announce at the start (in pt-br):** "Iniciando sessão de revisão independente do PR #<N> — olhos frescos, somente leitura."

All identifiers, JSON keys, and reasoning stay in English. **Every message to the operator is pt-br, product-language.**

---

## Position in the system

```
Node review layer (cron-b / cron-review.mjs)
  → spawns this skill session (claude -p, read-only), once per invocation
    → adversary + compliance (diff-adapter) + security
    → session emits raw eye-outputs to session-out/eyes-<pr>-<sha>.json
  ← Node derives the canonical merge verdict from the eye-outputs (strict conjunction)
  ← Node orchestrates cross-family eligibility (when available)
  ← Node writes the canonical verdict artifact to the engine-controlled stateDir
```

The Node layer owns the lock, origin-gate, idempotency, chain counter, circuit-breaker, cross-family orchestration, the merge decision, relabel, and notify. This skill session owns **only the per-invocation judgment** — it reads the diff, runs the three eyes, and emits its raw eye-outputs; it never derives or writes the canonical merge verdict itself. It never mutates the worktree, never checks out a branch, and never invokes a write-capable hand.

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

### Step 4 — Cross-family (Node-orchestrated, when available)

Cross-family is **not** something this session decides for itself. **Node (the composition root
`run-cron-review.mjs`) orchestrates the second family** directly, over the PR diff — it is NOT the
per-task `driveCrossFamily`/policy-B refute-loop used elsewhere in the harness. Per PR, the bound
`crossFamilyEligible` closure:

1. Loads the `codex-adversary` module ONCE at composition-root setup (dynamic import; absent → fail-open).
2. Re-verifies the PR head (`headRefOid` still equals the reviewed `sha`) and fetches the **full patch**
   (`gh pr diff <n>`) as the review content — a diff-fetch failure or head drift → `available: false`
   (re-queue), never a review of a drifted revision.
3. Runs `runCodexRole` **directly** for the `adversary` AND `security` roles (GPT via Codex CLI) over the
   patch — the codex spawn env is scrubbed of hand-token credentials.
4. Derives the second-family verdict in **Node** via `deriveSecondFamilyVerdict` from the two codex eyes'
   structured `issues[]` (fail-closed: a malformed / unavailable eye, or an explicit `UNSAFE`, → BLOCKED;
   never a free-text summary), and writes a **sibling** artifact `review-<n>-<sha>.crossfamily.json`
   (`{available, verdict, adversaryClean, securitySecure}`) — never touching the canonical verdict artifact.
5. Injects `available` + the derived verdict into `crossFamilyEligible(pr, {available, secondFamilyVerdict})`.

- **Compliance stays Claude-only** (it is not run cross-family).
- **Fail-closed if absent:** when the module is absent, the switch is off, `codex` is unauthenticated, or
  `codex` is unreachable, the closure resolves `crossFamilyEligible: false` (never fabricates `available`),
  and the merge-eligible conjunction requires it. Absence → awaiting-merge, never fail-open "ok" (HR-2).
- **Auto-merge rollout lock:** even with the full conjunction CLEAN, a PR auto-merges ONLY when
  `config.autoMergeEnabled === true` (default OFF) — otherwise it routes to awaiting-merge. This decouples
  "cross-family validated running" from "auto-merge fires" (operator enables it after validating).

**Compliance stays Claude-only** — it checks THIS PR's acceptance criteria against the pseudo-contract, not general failure modes a second family would diversify.

This session itself has no cross-family role in a given invocation — it only ever runs the 3 eyes from Step 3 and emits their raw outputs (Step 6). Node decides, per PR, whether and when cross-family runs.

### Step 5 — Merge-eligible conjunction (Node-computed)

Node (cron-review) computes the merge-eligible verdict from the derived verdicts as:

```
eligible = freshVerdictClean && crossFamilyEligible
```

A single flaky CLEAN is never sufficient on its own — cross-family eligibility is always required. A change to the harness's own engine is treated like any other PR: one clean review is enough. There is no separate control-surface carve-out and no second pass — a change to the gate machinery auto-merges on a clean review just like a downstream PR.

### Step 6 — Emit the eye-outputs; Node derives and writes the verdict

This session never computes or writes the canonical merge verdict. Each invocation of this session **emits its raw eye-outputs** — the adversary, compliance, and security verdicts collected in Step 3 — to a session-scoped, engine-controlled path:

```
join(stateDir, "session-out", `eyes-<prNumber>-<headSha>.json`)
```

**Node derives the merge verdict** from those raw eye-outputs by strict conjunction — `adversary.verdict === "CLEAN"` AND `compliance.verdict === "pass"` AND `security.verdict === "SECURE"`, no normalization, no partial credit — and is the exclusive writer of the canonical **engine-controlled verdict artifact**, at a Node-only path — **never inside the worktree** (HR-5):

```
join(stateDir, `review-<prNumber>-<headSha>.json`)
```

The eye-outputs shape this session writes:

```json
{
  "adversary": { "findings": [], "verdict": "CLEAN" },
  "compliance": { "findings": [], "verdict": "pass" },
  "security": { "findings": [], "verdict": "SECURE" }
}
```

The canonical verdict Node derives and writes:

```json
{
  "status": "CLEAN",
  "finding": null
}
```

A CLEAN file named `review-<pr>-<sha>.json` that happens to appear in the PR diff itself is **ignored** — the canonical artifact is written by Node to the engine-controlled stateDir, never inside the worktree, so it can never collide with a file in the diff, and this session never has write access to that path.

The Node layer reads its own Node-derived artifact to determine merge eligibility. That artifact — never a claim the session makes about itself — is the **single source of truth** for the review verdict; the Node layer must switch from `parseVerdictBlock(body)` to reading this Node-derived artifact.

---

## Model routing

| Role | Model | Why |
|---|---|---|
| adversary | **opus** | Strongest available tier for the fresh-eyes attack — the core of the review |
| compliance | **sonnet** | Spec-vs-diff check; the pseudo-contract is simpler than a full plan |
| security | **opus** | Conditional auditor; security findings are load-bearing for the merge gate |
| cross-family (adversary) | GPT via Codex | Second model family; read-only eye, never a cheap hand |
| cross-family (security) | GPT via Codex | Second model family; read-only eye, never a cheap hand |

**No eye role ever falls below the sonnet floor** — never haiku, never a non-Claude tier for the primary eyes. The cross-family second opinion is a Claude-tier peer, not a cheap fallback. **No write-hand is spawned** — no executor, no sniper, no Ollama hand-dispatch path. This skill is eyes-only.

---

## What this skill is NOT

- It does **not** implement, fix, or modify any code — it spawns no write-hand (no executor, no sniper, no Ollama hand-dispatch path). Eyes only.
- It does **not** merge, relabel, or notify — the Node review layer owns those actions.
- It does **not** check out branches or mutate the worktree — it reads via `gh pr diff` only (HR-7).
- It does **not** derive or write the canonical merge verdict — it emits raw eye-outputs to the engine-controlled `session-out/` path (HR-5); Node derives and writes `review-<pr>-<sha>.json` exclusively.
- It does **not** decide cross-family eligibility on its own — Node (cron-review) orchestrates it, per invocation; absence of cross-family is recorded by Node as `crossFamilyEligible: false`, never fail-open (HR-2).
- It is **not** invoked by `triaging-requests` — it is machine-only, spawned by the Node review layer.
- It does **not** use `parseVerdictBlock` or any body-parsed verdict — the Node-derived verdict artifact is the single source of truth.
