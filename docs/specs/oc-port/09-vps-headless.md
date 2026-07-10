# 09 — VPS headless (phase 2)

**Phase:** 2  
**Depends on:** phase 1 DoD  
**Status:** stub contract — **do not implement during phase 1**  
**Implements later:** OC session driver for crons, NDJSON oracle, safe merge

---

## 1. Reality

This operator does **not** use Claude cloud routines as headless.  
Headless = **VPS crons** under `core/vps/` selecting issues, spawning sessions, reviewing PRs, notifying Telegram.

---

## 2. What already exists (Claude-oriented)

- cron-a select/dispatch/exit  
- cron-review + review-* + merge  
- reaper, drain, engine-update, notify-telegram  
- spawn-review-session (today treats non-zero exit as failure)

---

## 3. OpenCode blockers (probed)

1. `opencode run` often exits **0** even when tools were denied by plugin  
2. Output is **NDJSON stream**, not Claude's single JSON envelope  
3. Startup may **prune** large DB (minutes) — timeouts must account for this  
4. Global harness plugins affect all projects until cutover  

---

## 4. Required before auto-merge on OC

| Component | Purpose |
|---|---|
| NDJSON result parser (shared) | Derive success/fail from tool errors, missing deliverables, step_finish |
| spawn adapter for `opencode run` | Isolated dir, agent, --auto, --format json |
| Map parser outcome into review-verdict-source | Same merge policy as Claude path |
| Explicit tests for deny-but-exit-0 | Must classify as failed ceremony |

**Do not enable `autoMergeEnabled` for OC-driven PRs until the above is proven.**

---

## 5. Shared reuse

- merge-findings/verdicts  
- verdict-block parse/format  
- path helpers  
- routing validate  

---

## 6. DoD (phase 2 only)

- [ ] T12 parser + tests  
- [ ] T13 VPS spawn OC smoke on VPS or local  
- [ ] T14 auto-merge still off by default; enable only after operator sign-off  

---

## 7. References

- inventory/probe-results  
- core/vps/spawn-review-session.mjs  
- memory opencode-plugin-contract  
