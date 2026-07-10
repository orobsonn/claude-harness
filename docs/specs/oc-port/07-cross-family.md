# 07 — Cross-family eyes

**Phase:** 1  
**Depends on:** 02, 03 merge-*, 04 agents, ADR-003  
**Implements:** always-on dual for plan-reviewer + adversary on OC  
**Out of scope:** Codex CLI module internals (CC keeps them)

---

## 1. Goal

Second model family catches failures the first family's priors miss.  
OC default: **Grok 4.5 primary + OpenAI secondary** on key posts.  
CC: keep optional Codex module + Claude eyes.

---

## 2. Always-dual posts (OC default)

| Post | Primary | Secondary |
|---|---|---|
| plan-reviewer | grok-4.5 agent | openai gpt-5.5 agent |
| adversary (every invocation: spec / task / final) | grok-4.5 | openai gpt-5.5 |

Not always-dual by default: compliance, security (single OpenAI), planner, hands.

---

## 3. Mechanism (OC) — probe-proven (P16)

Orchestrator issues **two `task` calls** (sequential is fine; parallel if runtime allows):

1. `task(subagent_type: "plan-reviewer" | "adversary", prompt: ...)`  
2. `task(subagent_type: "plan-reviewer-openai" | "adversary-openai", prompt: same contract, virgin)`  

Each eye returns structured findings/verdict in its reply.  
Orchestrator runs **shared** `finalizeFindings` / `mergeVerdicts` (policy B).

### Virgin rule

Neither eye receives the other's verdict in its prompt.  
Adversary never receives compliance output or shared_context (existing invariant).

### If OpenAI unavailable

Fail-**open** with explicit operator-visible warning (pt-br product language): dual skipped, primary-only.  
Do not invent secondary findings.

**Gate-state field (locked enum, not boolean):**

| Value | Meaning |
|---|---|
| `dual_status: "both"` | primary + secondary ran; merge applied |
| `dual_status: "primary_only_failopen"` | secondary unavailable/auth fail; warning logged; primary used |
| `dual_status: "pending"` | dual required but not yet attempted |
| `dual_status: "primary_only_error"` | secondary attempted and failed for non-auth reasons (retry policy separate) |

Never store `dual_completed: true` as a bare boolean. Downstream must not treat `primary_only_failopen` as full dual coverage for metrics that claim cross-family ran.

---

## 4. Policy B (merge)

Implemented in shared (03):

- Single-family finding **kept** unless other family **explicitly refutes**  
- No majority vote  
- Security gate authority: document whether OpenAI-only security stays authoritative (CC: Claude authoritative for SECURE|UNSAFE) — for OC default security is OpenAI-only; if dual security added later, define authority in routing

---

## 5. Claude target

- Keep `modules/codex-adversary` opt-in  
- `codex-eye-nudge` hook remains CC  
- Shared merge libs generalized from codex merge-*  

---

## 6. Orchestrator checklist (build / orchestrating-delivery)

After each plan-reviewer or adversary primary returns:

- [ ] Secondary dispatched with same brief, virgin  
- [ ] Merge via shared  
- [ ] Product summary to operator if human gate  
- [ ] Gate-state records `dual_status` enum (`both` | `primary_only_failopen` | `pending` | …) — never bare boolean true for partial dual  

---

## 7. DoD (T8)

- [ ] dual agent files exist  
- [ ] orchestrating-delivery / build protocol mandates dual on both posts  
- [ ] shared merge wired  
- [ ] fail-open path when secondary auth missing  
- [ ] IMPLEMENTATION-TRACK T8 done  

---

## 8. References

- ADR-003  
- modules/codex-adversary merge tests  
- probe P16 dual sequential tasks  
