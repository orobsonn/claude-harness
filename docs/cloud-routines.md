# Cloud routines — o que realmente carrega e como se comporta

Constraints confirmados na doc oficial (`code.claude.com/docs/en/routines.md`, `claude-code-on-the-web.md`, `memory.md`, `sub-agents.md`, `permission-modes.md`). Esta é a superfície de falha que o framework precisa respeitar.

## O que a routine enxerga

Uma cloud routine roda num **clone fresco do repo**. Ela **não tem acesso ao `~/.claude`** (home do operador). Só carrega o que está **commitado no `.claude/` do repo**.

| Config no repo | Auto-carrega na routine? | Nota |
|---|---|---|
| `.claude/CLAUDE.md` | ✅ sim | no início da sessão |
| `.claude/agents/*.md` | ✅ sim | auto-descoberto, recursivo **só sob `.claude/agents/`** (não `.claude/harness/agents/`) |
| `.claude/rules/*.md` | ✅ sim | sem `paths:` carrega no início; com `paths:` quando arquivo casa |
| `.claude/skills/*/SKILL.md` | ⚠️ **não auto** | carrega **on-demand** por relevância/invocação |
| `.claude/settings.json` | ✅ sim | nível projeto; user-level **não** carrega |
| `.mcp.json` (commitado) | ✅ sim | MCP local (`claude mcp add`) **não** vai |
| hooks | ⚠️ **assumir que não** | não documentado rodar em routine |
| `~/.claude/*` | ❌ nunca | home não existe na nuvem |

**Implicações de design:**
- Agents/rules têm de morar **exatamente** em `.claude/agents/` e `.claude/rules/` (topo) — não em subpasta. Isso elimina submodule/subtree "arrumadinho numa subpasta".
- Skills não auto-carregam → o gatilho da pipeline é a **instrução no `CLAUDE.md` + no prompt da routine**, não a presença do arquivo.
- Memória durável **não pode** viver em `~/.claude/projects/…` — tem de ser repo-relative (`.claude/memory/`), commitada de volta.

## Comportamento de prompts (a routine não trava)

> "Routines run autonomously as full Claude Code cloud sessions: there is no permission-mode picker and no approval prompts during a run."

- **Permissões de tool** (Bash/Edit/Write): **auto-aprovadas** (equivalente a `acceptEdits`; não é `bypass`).
- **AskUserQuestion / clarificação**: **não bloqueia** — assume default e segue (qual default: não documentado).
- **Plan mode / ExitPlanMode**: não documentado se escapa sozinho → **evitar** (risco de travar).

Consequência crítica: "não trava" significa **aceitar qualquer coisa cegamente** nos pontos que pediam julgamento. Por isso o modo headless substitui gates humanos por **validação multi-agente**, não por "auto-seguir".

## Revisão humana = o PR

A routine **não pausa** esperando humano. O padrão oficial é **abrir um PR (draft)** como entregável; o humano revisa de forma **assíncrona** no GitHub. Confirmado como o pattern pretendido para review de output de routine.

## Distribuição na nuvem (avaliado)

| Mecanismo | Funciona na nuvem? | Veredito |
|---|---|---|
| git submodule | ❌ | clone não inicializa submodule; precisaria de hook (que não roda) |
| git subtree | ✅ arquivos físicos | mas esbarra no discovery (tem de cair no topo do `.claude/`) |
| plugin + marketplace | ✅ se declarado no `.claude/settings.json` + marketplace alcançável | forma nativa de fonte única; evolução futura |
| **cópia (vendor) de uma pasta-fonte** | ✅ garantido | **escolhido** — self-contained, e a pasta-fonte vira plugin depois sem retrabalho |
