# 10 — Cutover: empty global OpenCode harness

**Phase:** 1 (final)  
**Depends on:** T11 parity + project-vendored smoke (after T9 vendor)  
**Implements:** remove harness from `~/.config/opencode` so projects are source of truth  
**Operator runbook (detailed):** [`scripts/cutover-opencode-global.md`](../../../scripts/cutover-opencode-global.md)  
**Preflight / apply:** [`scripts/cutover-opencode-global.sh`](../../../scripts/cutover-opencode-global.sh)

---

## 1. Why

Probe: project run still loaded **global** `~/.config/opencode` plugins (entry-gate blocked first task).  
Same class of bug as Claude personal>project skill shadowing (fixed 2026-06-28 for CC).

While global contains harness agents/skills/plugins, **vendoring is not isolation**.

---

## 2. What must leave global

| Remove / stop using as harness |
|---|
| `~/.config/opencode/agents/*` delivery roles |
| `~/.config/opencode/skills/*` loop skills (triage, orchestrating, …) |
| `~/.config/opencode/plugin/*` gates |
| `~/.config/opencode/tools/*` classify/validate/complexity if only for harness |
| Harness sections of global AGENTS.md |
| Absolute plugin paths in global opencode.json |

---

## 3. What may remain global (personal)

| Keep |
|---|
| Provider auth (xAI OAuth, OpenAI login) |
| MCP server definitions **with secrets** (or prefer project-local gitignored) |
| Personal skills: blog-post, quiz, copy, etc. |
| Minimal opencode.json model prefs without harness plugins |
| Optional hint: “project missing .opencode harness → run init” |

---

## 4. Cutover checklist (operator)

1. `init --target opencode` on each active project; commit `.opencode`  
2. Confirm project run does **not** need global plugins (`PLUGIN_INIT` only from project paths)  
3. **Preflight PASS** — `./scripts/cutover-opencode-global.sh` (T11 parity green, relative plugins, no phase-2, backup docs)  
4. **Backup** global harness dirs (automatic on apply; see runbook §2)  
5. Move personal skills aside if mixed into harness skill dir  
6. **Operator confirmation** — only then: `./scripts/cutover-opencode-global.sh --apply --i-confirm-cutover`  
7. Delete or archive global harness agents/plugins/tools (script does this)  
8. Strip global opencode.json `plugin` array harness entries  
9. Smoke: `opencode run` in project still triages via **project** skills  
10. **Rollback path** documented (runbook §6) if smoke fails  
11. Mark IMPLEMENTATION-TRACK T10 done + confirmation note  
12. Minor release handoff (post phase-1 DoD) — no phase 2  

---

## 5. Backup and rollback (required before global delete)

### Backup (before delete)

Apply creates `~/.config/opencode/.backup-cutover-<stamp>/` with copies of `agents/`, `plugin/`, `tools/`, `skills/`, `AGENTS.md`, `opencode.json`. Manual steps are in the runbook.

### Rollback (restore from backup)

Copy those trees back over `~/.config/opencode/`, then re-vendor projects and re-run preflight before a second attempt.

**Never** run global delete without a backup directory present or created in the same apply step.

---

## 6. Operator confirmation boundary

| Mode | Behavior |
|---|---|
| Default / `--preflight` | Checks only — **never deletes** |
| `--dry-run-apply` | Shows removal plan after preflight; no delete |
| `--apply --i-confirm-cutover` | Backup then remove harness (keeps personal/auth/MCP) |

Silent delete is forbidden. TRACK must record confirmation or deferred-apply status.

---

## 7. DoD (T10)

- [x] Written runbook (`10-cutover-global.md` + `scripts/cutover-opencode-global.md`)  
- [x] Script + dry-run / preflight checker (`scripts/cutover-opencode-global.sh` + `cutover-preflight.test.mjs`)  
- [x] Operator confirmation note in TRACK (apply with `--i-confirm-cutover`; backup stamp recorded)  
- [x] Parity: new clone / project-vendored path works without global harness (T11 smoke; cutover enforces order)  
- [x] Backup + rollback documented before global delete  
- [x] Phase 2 not implemented (preflight fails if T12–T14 artifacts appear)  
- [x] Global emptied of harness (agents/plugin/tools/loop skills); personal kept

---

## 8. Minor release handoff

After phase-1 TRACK complete: ship via feature branch + PR; **minor** release (`releasing-versions` / release-please). Phase 2 (T12–T14) stays out of this release.

---

## 9. References

- probe global+project plugin merge  
- harness-distribution memory (CC global removal)  
- locked tests: `scripts/cutover-preflight.test.mjs`  
