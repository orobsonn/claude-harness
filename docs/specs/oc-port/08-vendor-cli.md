# 08 — Vendor CLI and parity CI

**Phase:** 1  
**Depends on:** 01, 04, 05 content exists to vendor  
**Implements:** multi-target init/update, parity manifesto  
**Out of scope:** VPS install (09), personal skills

---

## 1. CLI

Package remains `@orobsonn/claude-harness` (rename is non-goal).

```bash
npx @orobsonn/claude-harness init --target opencode
npx @orobsonn/claude-harness init --target claude
npx @orobsonn/claude-harness init --target both
```

Aliases: `setup-local` as today for claude if needed.

### Behavior

Extend `vendor-core.mjs` (or sibling `vendor-opencode.mjs` called by cli):

**OpenCode target framework-owned (overwrite):**

- `.opencode/agents`, `skills`, `plugin`, `tools`  
- `.opencode/harness.routing.json`  
- shared copies needed at runtime  
- `AGENTS.md` harness block (markers) or project root AGENTS merge  

**Accumulated:** MEMORY.md / kaizen non-clobber  

**Config:** `opencode.json` — create if absent with **relative** plugins; if present write `opencode.harness.json`  

**Gitignore:** plans/, local secrets, caches under `.opencode/`  

**Version stamp:** `.opencode/.harness-version`  

**Never vendor:** MCP secrets, absolute plugin paths, personal blog/quiz skills  

---

## 2. Warning on plugin auto-exec

Document in README + init stdout: project plugins execute when someone runs opencode in the repo (probe/memory). Acceptable under vendored-only doctrine; no hand tokens in plugins.

---

## 3. Parity manifesto (CI)

Machine-checkable test that fails release if either target lacks:

1. Role set **OC-canonical files present:** `build`, `planner`, `plan-reviewer`, `plan-reviewer-openai` (or documented dual pair), `adversary`, `adversary-openai` (or pair), `compliance`, `security`, `executor-low`, `executor-medium`, `executor-high`, `sniper-low`, `sniper-medium`, `sniper-high`, `test-author`, `harvester`, `shipper`. (CC target may use singular executor/sniper — check per target.)  
2. Dual config on plan-reviewer + adversary (OC routing)  
3. Gates present (entry + plan at minimum)  
4. Capture oracle module present  
5. No plugin source references `OLLAMA_HAND_TOKEN` / `ANTHROPIC_AUTH_TOKEN` reads  
6. shared lib tests green  
7. validate-plan rejects claude tier names  

Implementation: `core/shared` or repo `scripts/parity-manifest.mjs` + `npm test` entry.

---

## 4. DoD (T9, T11)

- [ ] init --target opencode vendors a clean fixture project  
- [ ] re-run does not clobber MEMORY/kaizen  
- [ ] parity script in CI  
- [ ] IMPLEMENTATION-TRACK T9 T11 done  

---

## 5. References

- vendor-core.mjs current behavior  
- 10-cutover-global  
- package.json bin  
