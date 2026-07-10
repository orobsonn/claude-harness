# 10 — Cutover: empty global OpenCode harness

**Phase:** 1 (final)  
**Depends on:** T9 vendor works for operator projects  
**Implements:** remove harness from `~/.config/opencode` so projects are source of truth

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
3. Move personal skills aside if mixed into harness skill dir  
4. Delete or archive global harness agents/plugins/tools  
5. Strip global opencode.json `plugin` array harness entries  
6. Smoke: `opencode run` in project still triages via **project** skills  
7. Mark IMPLEMENTATION-TRACK T10 done  

---

## 5. DoD (T10)

- [ ] Written runbook (this file)  
- [ ] Optional script `scripts/cutover-opencode-global.md` or dry-run checker  
- [ ] Operator confirmation note in TRACK  
- [ ] Parity: new clone of project works without global harness  

---

## 6. References

- probe global+project plugin merge  
- harness-distribution memory (CC global removal)  
