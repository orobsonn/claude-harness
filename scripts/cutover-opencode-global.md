# Cutover runbook — empty global OpenCode harness

**Phase:** 1 final (T10)  
**Order:** **after T11 only** (parity manifesto + project-vendored smoke green)  
**Scope:** runbook + preflight + optional apply with operator confirmation  
**Not in scope:** phase 2 (T12–T14 VPS OC driver / NDJSON oracle / auto-merge)

---

## 0. Operator confirmation boundary

Cutover **deletes harness agents/plugins/tools/skills from `~/.config/opencode`**.

| Rule | Detail |
|---|---|
| No silent delete | Default mode is **preflight only** (dry-run). |
| Explicit confirm | Apply requires `--i-confirm-cutover` on the script/CLI. |
| TRACK record | IMPLEMENTATION-TRACK T10 notes must record operator confirmation (or that apply is deferred pending confirm). |
| Keep personal | Provider auth, MCP secrets, personal skills (`blog-post`, `quiz`, `copy`, …). |

---

## 1. Preconditions (hard gates — preflight)

Preflight **blocks any global delete** until all pass:

1. **T11 parity green** — `IMPLEMENTATION-TRACK` row T11 status `done` and notes record **parity** + **project-vendored smoke**.
2. **Project plugin paths are project-relative** — committed / example configs use `./.opencode/plugin/...`, never absolute `~/.config/opencode/plugin/...`.
3. **No phase-2 OC VPS artifacts** — no shared NDJSON session-result parser for OpenCode (T12), no VPS `opencode run` session driver (T13), no `autoMergeEnabled: true` for OC-driven merge (T14); TRACK T12–T14 remain `pending`.
4. **Backup + rollback documented** (this file + contract `10-cutover-global.md`).
5. **Active delivery already project-vendored** — each active project has committed `.opencode/` from `init --target opencode`.

Run:

```bash
./scripts/cutover-opencode-global.sh              # preflight only
# or
node scripts/cutover-preflight.test.mjs --preflight
```

Exit `0` = PASS. Exit `1` = FAIL — **do not delete**.

---

## 2. Backup (required before any global delete)

**Always backup first.** The apply path creates:

```text
~/.config/opencode/.backup-cutover-<ISO-stamp>/
  agents/
  plugin/
  tools/
  skills/
  AGENTS.md
  opencode.json
```

Manual backup (if applying by hand):

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$HOME/.config/opencode/.backup-cutover-$STAMP"
mkdir -p "$BACKUP"
cp -R "$HOME/.config/opencode/agents" "$BACKUP/" 2>/dev/null || true
cp -R "$HOME/.config/opencode/plugin" "$BACKUP/" 2>/dev/null || true
cp -R "$HOME/.config/opencode/tools" "$BACKUP/" 2>/dev/null || true
cp -R "$HOME/.config/opencode/skills" "$BACKUP/" 2>/dev/null || true
cp "$HOME/.config/opencode/AGENTS.md" "$BACKUP/" 2>/dev/null || true
cp "$HOME/.config/opencode/opencode.json" "$BACKUP/" 2>/dev/null || true
```

---

## 3. What to remove (harness only)

| Remove from `~/.config/opencode` |
|---|
| `agents/*` delivery roles |
| `plugin/*` gates (entry-gate, plan-gate, loop-guard, …) |
| `tools/*` classify / validate-plan / complexity-scorer if harness-only |
| Harness skills: triaging-requests, orchestrating-delivery, brainstorming, grill, recording-findings, distilling-learnings, proposing-improvements, surveying-codebase, proposing-deepening, committing-changes, releasing-versions, authoring-rules, canonical-critical-classes, importing-claude-memory |
| Harness body of `AGENTS.md` (replace with minimal personal stub) |
| Absolute harness entries in global `opencode.json` → `plugin` array |

---

## 4. What to keep (personal)

| Keep |
|---|
| Provider auth (xAI OAuth, OpenAI login — OC auth store) |
| MCP server definitions **with secrets** in global `opencode.json` |
| Personal skills: `blog-post`, `quiz`, `copy`, and any non-harness skill |
| Minimal model prefs in `opencode.json` (no harness plugins) |
| Optional hint in AGENTS.md: missing project harness → run `init --target opencode` |

---

## 5. Apply (operator only)

After preflight PASS and **explicit operator confirmation**:

```bash
./scripts/cutover-opencode-global.sh --apply --i-confirm-cutover
# or
node scripts/cutover-preflight.test.mjs --apply --i-confirm-cutover
```

Dry-run of apply plan (still requires preflight PASS; does not delete):

```bash
./scripts/cutover-opencode-global.sh --dry-run-apply
```

---

## 6. Rollback

If a project breaks or global was emptied too early:

```bash
BACKUP="$HOME/.config/opencode/.backup-cutover-<stamp>"   # pick the stamp
cp -R "$BACKUP/agents"  "$HOME/.config/opencode/"
cp -R "$BACKUP/plugin"  "$HOME/.config/opencode/"
cp -R "$BACKUP/tools"   "$HOME/.config/opencode/"
cp -R "$BACKUP/skills"  "$HOME/.config/opencode/"
cp "$BACKUP/AGENTS.md"  "$HOME/.config/opencode/"
cp "$BACKUP/opencode.json" "$HOME/.config/opencode/"
```

Then re-run project smoke and fix vendoring before attempting cutover again.

---

## 7. Post-cutover smoke

1. In a project with committed `.opencode/`: `opencode run` (or session) loads **project** plugins only (`PLUGIN_INIT` paths under project, not global harness).
2. New clone: `npx @orobsonn/claude-harness init --target opencode` → works **without** global harness.
3. Personal skill (e.g. blog-post) still available if kept global or under personal skill path.
4. MCP / provider auth still work.

---

## 8. Minor release handoff (post phase-1 DoD)

After T10 TRACK is `done` and phase-1 DoD checkboxes are complete:

1. Shipper / operator: feature branch + PR for M5 (T9+T11+T10) if not already merged — **never direct main**.
2. Conventional Commits pt-br.
3. **Minor release** via `releasing-versions` skill / release-please (`0.x` → next minor).
4. **No phase 2** in this release (T12–T14 stay pending).

---

## 9. Checklist (operator)

- [ ] `init --target opencode` on each active project; commit `.opencode`
- [ ] Preflight PASS (`./scripts/cutover-opencode-global.sh`)
- [ ] Backup created (automatic on apply, or manual §2)
- [ ] Operator confirms apply (`--i-confirm-cutover`)
- [ ] Global harness agents/plugins/tools/harness-skills removed
- [ ] Personal skills + auth + MCP retained
- [ ] Global `plugin` array stripped of harness entries
- [ ] Smoke: project run without global harness
- [ ] TRACK T10 → `done` + confirmation note
- [ ] Minor release handoff scheduled/executed
