---
name: oc-authoring-rules
description: Meta-skill for authoring and editing folder-scoped rules in the native OpenCode tree — nested AGENTS.md (or an existing folder CLAUDE.md router), root AGENTS.md/CLAUDE.md, never a Claude-style paths-gated rule file. Use when creating a new folder/subsystem rule, adding a Convention/Pattern/Gotcha to an existing one, or deciding whether something is a rule, a router-table row, or a one-off. Routes harness-wide rules to proposing-improvements via kaizen.md.
license: MIT
compatibility: opencode
metadata:
  phase: knowledge
  routes-to: nested AGENTS.md, root AGENTS.md/CLAUDE.md, kaizen.md
---

# Authoring-Rules — managing the project's folder-scoped law

**Announce at the start (in pt-br):** "Usando authoring-rules para escrever/editar a lei de pasta no mecanismo nativo certo."

Standardizes how durable, actionable rules are written into this harness's **native** rule mechanism. Each rule organizes knowledge into the same 3 canonical categories used everywhere in the harness.

**There is no `.claude/rules/*.md` here, and there is no `paths:` frontmatter.** Those are Claude-Code-only mechanics with no OpenCode equivalent. In this harness a rule's SCOPE is its **tree location**: a rule that governs one folder lives in that folder's nested `AGENTS.md` (read by up-traversal), a project-wide rule lives in the root `AGENTS.md`/`CLAUDE.md`, and a harness-wide rule is never authored here at all — it is proposed to `kaizen.md`. The blast-radius routing below mirrors `skill({ name: "oc-distilling-learnings" })` exactly, because both write into the same native destinations.

## When to use

- Create a new rule for a folder/subsystem that does not yet have one.
- Add a Convention / Pattern / Gotcha to an existing folder rule.
- Review/edit folder rules.
- Decide whether something should be a folder rule, a root router-table row, a `kaizen.md` proposal, or just a one-off in the commit.

## Where rules live — the native mechanism (no `paths:`)

Scope is decided by WHERE the file sits in the tree, not by a glob field. This replaces the Claude `paths:` mechanism one-for-one.

| Scope | Destination | What goes here |
|---|---|---|
| **One folder / subsystem** | that folder's nested **`AGENTS.md`** (or the folder's existing **`CLAUDE.md`** router, if that is what the folder already uses) + a one-row pointer in the root router table | stack/domain law for that area: handlers, components, hooks, mcp-tools, libs, schemas, sandbox invariants |
| **Whole project** | root **`AGENTS.md`** (or root **`CLAUDE.md`** router, whichever the project uses) | project-wide conventions, the router table itself, top-of-tree invariants |
| **Harness-wide** (all projects) | **NOT authored here** — append a proposal to project-root **`kaizen.md`** via `skill({ name: "oc-proposing-improvements" })` | code-quality / security / git and any rule that would change harness behavior across every project (these already live in `~/.config/opencode/AGENTS.md` §4–6) |

**Do NOT invent a `paths:` field** in the frontmatter of a nested `AGENTS.md` / `CLAUDE.md`. It has no effect in OpenCode — these files are scoped by their position in the directory tree and loaded by up-traversal from the working dir. A folder's `AGENTS.md` already governs exactly that folder and its descendants; no glob is needed or honored.

**How a folder's rule reaches the implementer:** `agents/build.md` reads the nested `AGENTS.md`/`CLAUDE.md` of a task's `scope_paths` folder(s) deliberately and injects it as **L3 context** to the executor (and any role acting on that folder). That injection — not a `paths:` glob — is what puts a folder's law in front of the agent doing the work. Keep the rule next to the code it governs so the L3 read finds it.

## Mandatory structure of a folder rule

```markdown
# <Rule title — the folder/subsystem it governs>

## Conventions
- Direct actionable instruction (one line)

## Patterns
- **Pattern name**: short description
  ```typescript
  // short, canonical code example
  ```

## Gotchas
- **Short name**: concise statement of the footgun and how to avoid it
```

### Rules of each section

| Section | Required | Format | Content |
|---|---|---|---|
| `## Conventions` | Yes | `- Direct instruction` | How to write code in this area. Imperative, one line per item. |
| `## Patterns` | If any exist | `- **Name**: ...` + code | A reusable solution with a snippet. Add ONLY if it appears in **2+ places** (DRY-with-limit — no premature abstraction). |
| `## Gotchas` | If any exist | `- **Name**: ...` | A footgun that already caused a problem. State what NOT to do and what to do instead. |

Other domain-specific sections are allowed, but the 3 above are the base pattern. This matches the Conventions/Patterns/Gotchas shape used throughout the harness (and `~/.config/opencode/AGENTS.md` §4–6).

## Global vs project vs folder — pick the tightest scope

| Type | Where | When |
|---|---|---|
| **Harness-wide** (all projects) | propose to `kaizen.md` (NOT written here) | code-quality, security, git, observability, testing, releases — already in `~/.config/opencode/AGENTS.md` §4–6 |
| **Project-wide** | root `AGENTS.md` / `CLAUDE.md` router | conventions true across the whole project; the router table |
| **One folder** | nested `AGENTS.md` / folder `CLAUDE.md` + root router row | stack/domain law: workers, components, hooks, mcp-tools, libs, schemas, sandbox |

Pick the tightest scope that still covers the rule. A folder-specific rule dumped into the root pollutes every task's context; a project-wide rule buried in one folder never surfaces elsewhere — the same blast-radius discipline as `oc-distilling-learnings`.

**Golden rule before creating a folder rule** (decision tree):
- Is the rule **non-obvious from the code**? (yes → it can be a rule)
- If I **just read the code, do I already understand it**? (yes → no rule needed)
- Is it an **actionable instruction**? (no → it is probably an explanation for `AGENTS.md`/`CLAUDE.md` prose or JSDoc, not a rule)

## Writing principles

1. **Concise** — one line per bullet. If it needs a paragraph, it is too detailed.
2. **Actionable** — "Use X" instead of "X is a good practice". Imperative.
3. **No duplication** — check `~/.config/opencode/AGENTS.md` (harness-wide §4–6), the root `AGENTS.md`/`CLAUDE.md`, and sibling folder rules before adding. Reference instead of repeating.
4. **English by default** — harness artifacts are English (`~/.config/opencode/AGENTS.md` §2). Exception: if the folder's existing rule file is already written in pt-br, match that file's language for consistency rather than mixing.
5. **Gotchas are named** — `**Name**: explanation`.
6. **Patterns carry code** — a short snippet showing correct use; add only at 2+ uses.
7. **Target size** — 80–150 lines. Above 200, consider splitting into two folder rules.

## Flow: create a new folder rule

1. Identify the scope (the folder/subsystem the law governs).
2. Confirm scope is folder-level (not harness-wide → that goes to `kaizen.md`; not a one-off → that goes in the commit).
3. Create / open that folder's `AGENTS.md` (or use its existing `CLAUDE.md` if the folder already routes through one). No `paths:` field.
4. Add `## Conventions` (+ `## Patterns` / `## Gotchas` as warranted).
5. Add/refresh **one row** in the root router table: `<folder> | <what lives there> | see <folder>/AGENTS.md`.
6. Validate against the new-rule checklist below.

## Flow: add an item to an existing rule

1. Classify the item: is it a Convention, a Pattern, or a Gotcha?
2. Open the correct folder's rule file.
3. Add it to the matching section in the correct format.
4. Verify it does not duplicate an existing item (and is not already covered by the harness-wide rules in `~/.config/opencode/AGENTS.md`).

## Checklist — new folder rule

- [ ] Lives in the right folder's `AGENTS.md` / `CLAUDE.md` (scope = tree location, NO `paths:` field)?
- [ ] `#` title describes the folder/subsystem scope?
- [ ] `## Conventions` has at least 3 items?
- [ ] Patterns/Gotchas added only where they earn their place (no inflation; Patterns at 2+ uses)?
- [ ] No content duplicated with the harness-wide rules or another folder's rule?
- [ ] One row added/refreshed in the root router table?
- [ ] Concise (target 80–150 lines)?
- [ ] English (or matches the folder file's existing language), no emoji?

## Checklist — add an item

- [ ] Classified correctly (Convention / Pattern / Gotcha)?
- [ ] In the right folder's rule file?
- [ ] Correct section format (bullet, `**Name**` where applicable)?
- [ ] Does not duplicate an existing item or a harness-wide rule?

## When NOT to author a rule

- The info is already obvious in the code (`grep` shows it) → no rule needed.
- It is tooling config (ESLint, Prettier, tsconfig) → enforced by the tool, not a rule.
- It is a one-off decision for a single feature → it lives in the PR/commit, not a rule.
- It is a metric/dashboard URL → it goes in `AGENTS.md`/`CLAUDE.md` "Resources", not a rule.
- It is a **harness-wide** convention (would change behavior across all projects) → do NOT write it here. Propose it to `kaizen.md` via `skill({ name: "oc-proposing-improvements" })`; promotion is human-reviewed, never auto-applied.
