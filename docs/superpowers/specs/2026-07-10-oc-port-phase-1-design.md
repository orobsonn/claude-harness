# OC Port Phase 1 — Execution design

**Status:** approved (operator: implement all; 2026-07-10)  
**Feature id:** `oc-port-phase-1`  
**Mode:** FULL  
**Technical source of truth:** `docs/specs/oc-port/` (phase 0 pack, already APPROVE)

---

## 1. Goal

Implement phase 1 of the OpenCode port (track items T0–T11 + T5c) so the delivery harness runs on OpenCode with a shared pure core, dual-runtime layout, project vendoring, and global cutover — without implementing phase 2 (VPS OC driver T12–T14).

---

## 2. Locked decisions (operator)

| id | decision | operator_resolution |
|---|---|---|
| D1 | Git packaging | One PR per milestone (5 PRs) |
| D2 | T5c (reinject, version-check, harvest-guard) | Include in phase 1, same milestone as T5/T5b |
| D3 | T10 global cutover | Apply real cutover of `~/.config/opencode` at end of last milestone |
| D4 | Execution approach | Single FULL plan; sequential T* execution; commits per item; PRs at milestones |
| D5 | Phase 2 (T12–T14) | Out of scope |
| D6 | Technical design | Spec pack `docs/specs/oc-port/` is authoritative; do not re-invent architecture |

---

## 3. Milestones (PR boundaries)

| PR | Track items | Theme |
|---|---|---|
| M1 | T0, T1 | Folder skeleton + routing table/schema |
| M2 | T2, T3, T4 | Shared pure libs (feature-id/paths, validate-plan, severity/merge) |
| M3 | T5, T5b, T5c | Gates MVP + complexity-scorer + optional polish |
| M4 | T6, T7, T8 | Agents/skills prose + cheap hands + dual runtime wiring |
| M5 | T9, T11, T10 | Vendor CLI + parity CI + real global cutover LAST |

After each milestone: virgin OpenAI review (authoritative slug `openai/gpt-5.5` only) on item diffs + contracts + DoD; blocking REVISE → fix → re-review until APPROVE; record on TRACK.

---

## 4. Per-item protocol (mandatory)

For each T*:

1. Read `00-index.md` (order + phase DoD)
2. Read `IMPLEMENTATION-TRACK.md`
3. Read ONLY contract docs listed for that item
4. Inventory only if contract links it
5. Implement only that item's DoD
6. Update TRACK (status, date, note)
7. Run contract tests
8. STOP item; then next

Forbidden: invent scope outside active contract; finish whole port in one shot; implement phase 2.

---

## 5. Non-negotiable invariants

1. `shared/` never throws — returns Decision/ValidationResult
2. Cheap hand = external subprocess + independent capture (not prose, not exit code alone)
3. Plugin does not read hand auth tokens
4. Gate state on disk + ownership-token lock (RMW)
5. Routing table; default Grok motor + OpenAI eyes; dual always on plan-reviewer and adversary

---

## 6. Architecture (summary — detail in pack)

```
core/
  shared/       # pure libs, rules, knowledge, schemas
  claude-code/  # today's flat core/* moved (T0)
  opencode/     # OC shell: agents, skills, plugins, tools, routing
  vps/          # existing; phase-2 OC driver not in this work
```

Vendor: `init --target opencode` → project `.opencode/`. Global harness dies at T10 cutover.

---

## 7. Testing & validation

- Unit/contract tests listed on each contract doc
- Phase 1 DoD checklist in `00-index.md` §7
- TRACK all T0–T11 (+T5c) `done`
- Virgin OpenAI APPROVE on each milestone
- Known blocker: live OpenAI dual may need auth on operator machine (TRACK blockers log); dual fail-open policy per `07-cross-family.md`

---

## 8. Delivery

- Branch per milestone (or long-lived branch with sequential PRs — prefer `feat/oc-port-m1-…` style)
- Conventional Commits, descriptions in pt-br
- Never commit directly to `main`
- Final operator summary: what shipped, what deferred, TRACK state

---

## 9. Out of scope

- T12–T14 (VPS OC / NDJSON / auto-merge)
- Deprecating Claude Code target
- Renaming npm package
- Re-opening product decisions already in ADRs 001–003

---

## 10. Success criteria

Phase 1 DoD from `00-index.md` §7 fully checked; TRACK phase 1 complete including T5c; five milestone PRs merged or open with virgin reviews recorded; global cutover applied at M5 end per D3.
