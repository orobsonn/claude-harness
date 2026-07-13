# Spec — oc-bash-wall-calibration (issue #300)

**feature_id:** `oc-bash-wall-calibration`  
**mode:** full  
**priority:** P0  
**size:** M  
**spec_rev:** 4 (post R3 dual — example ceremony + glob honesty)

## Product outcome

OpenCode bash wall must not be both **more open by default** and **more hostile to legitimate harness ops** than Claude Code.

1. **Carve-out** for harness-prescribed package runners in `decideBashForge`.
2. **Tighter project bash default** in `opencode.json.example` — no `"*": "allow"`.

Hard product rule: carve-out is **specific** to documented harness commands — never general allow-all for npm/npx/make.

## User journeys

| ID | Journey | Expected |
|---|---|---|
| #uj-1 | `npx tsc --noEmit` | allow |
| #uj-2 | `npx github:orobsonn/claude-harness#v0.43.1 init` | allow |
| #uj-3 | `npm run build-malicious-thing` | deny |

## Acceptance criteria

| ID | Criterion |
|---|---|
| #ac-2.1 | `npx tsc --noEmit` → decideBashForge **allow** + isStateForgeCommand false |
| #ac-2.2 | `npx github:orobsonn/claude-harness#v0.43.1 init` → allow + not-forge |
| #ac-2.3 | `npm run build-malicious-thing` → deny + forge |
| #ac-2.4 | `opencode.json.example` bash has no `"*": "allow"`; default `"*": "ask"`; package-runner allow entries require prescribed shape (github forms must include ` init`) |
| #ac-2.5 | regression tests cover 2.1+2.2+2.3 |
| #ac-2.6 | npm override flags (`--prefix`, `-C`, `--workspace`, `-w`, `--workspaces`, `--userconfig`, `--globalconfig`, `--script-shell`, `--node-options`, `--location`) on/near package runners → deny |
| #ac-2.7 | wrappers (`PATH=`, `npm_config_*=`, `env `, `NODE_OPTIONS=`) + prescribed base → deny on both oracles; helper always gets **raw** tool string |
| #ac-2.8 | `$`, backticks, `&`, `&&`, `;`, `|`, `$()`, redirects → deny |
| #ac-2.9 | matrix asserts decideBashForge **and** isStateForgeCommand |
| #ac-2.10 | `npm test` / `npm run typecheck` **exact only** |
| #ac-2.11 | example allows ceremony node markers: `node .opencode/plugin/lib/mark-gate.mjs *` and `node core/opencode/plugin/lib/mark-gate.mjs *` (not `node *`) |

## Locked decisions

- sem_afrouxar_wall_geral
- referencia_cc (spirit)
- fail_closed on forge oracles
- chain_still_deny (includes single `&`)
- no_npm_root_redirect
- no_wrapper_carveout
- **raw_arg_contract:** `isHarnessPrescribedPackageCommand` called with original tool string only
- **forge_authoritative:** OC permission globs are UX outer skin; plugin forge is authoritative deny. Example must not auto-allow package-runner shapes the helper rejects when OC pattern language allows a tight form; where OC globs cannot express full helper grammar, document RES-300-06 and keep globs as tight as OC allows (`…#* init` not `…#*` alone).

## Exact carve-out inventory (forge helper)

| Pattern | Matcher |
|---|---|
| `npx tsc --noEmit` | exact `^npx\s+tsc\s+--noEmit\s*$` |
| `npx [-y] [quotes]github:orobsonn/claude-harness#REF[quotes] init [args]` | owner/repo fixed; REF=`[A-Za-z0-9._/-]+`; metachar/wrapper/override rules on full string |
| `npm test` | exact only |
| `npm run typecheck` | exact only |

**Closed NPM_OVERRIDE_FLAGS:**
`--prefix`, `-C`, `--userconfig`, `--globalconfig`, `--workspace`, `-w`, `--workspaces`, `--script-shell`, `--node-options`, `--location`

**NOT carved out:** make, yarn, pnpm, npm run other, npx other, registry @scope, lint, wrappers, metachar forms.

## Root cause

1. isPackageRunner 513-526 blanket  
2. decideBashForge 672-678 unconditional deny  
3. isStateForgeCommand 577 re-deny unless both wired  
4. opencode.json.example `"*": "allow"`

## Design

### A. `isHarnessPrescribedPackageCommand(command)` — raw only

1. non-string/empty → false  
2. raw = trim(command); if stripCommandWrappers(raw) !== raw → false  
3. if hasShellChainMetacharacters(raw) OR hasShellRedirectOperators(raw) OR includes `$` → false  
   - **extend** hasShellChainMetacharacters to `includes("&")` (covers single `&` and `&&`)  
4. if NPM_OVERRIDE_FLAGS match as flags → false  
5. match exact patterns (github requires `init`)  
6. true only on match  

### B. Wire

```
// decideBashForge — use original input.command as raw:
if (isPackageRunner(stripped) || isPackageRunner(raw)) {
  if (!isHarnessPrescribedPackageCommand(raw)) return deny;
}
// isStateForgeCommand(command):
if (isPackageRunner(strip(command)) && !isHarnessPrescribedPackageCommand(command)) return true;
```

### C. Tests

Migrate ~445: npm test allow; npm run build/make deny; npm ci allow.  
Paired matrix for all ACs 2.1–2.3, 2.6–2.8, 2.10.

### D. opencode.json.example

- Remove `"*": "allow"`; default `"*": "ask"`
- **Package-runner allows (tight):**
  - `npx tsc --noEmit`
  - `npx github:orobsonn/claude-harness#* init*`
  - `npx -y github:orobsonn/claude-harness#* init*`
  - `npx -y "github:orobsonn/claude-harness#*" init*`
  - `npm test`
  - `npm run typecheck`
- **Ceremony node (not node *):**
  - `node .opencode/plugin/lib/mark-gate.mjs *`
  - `node core/opencode/plugin/lib/mark-gate.mjs *`
  - optionally `node scripts/probe-oc-gates-headless.mjs *` if listed in ALLOWED_TOOLING_SCRIPTS
- **Other allows:** safe git forms, `gh *`, `node --test *`, read-only unix (ls,pwd,cat,head,tail,rg,grep,find,jq,wc,mkdir,touch)
- **Not allow:** `node *`, `npm run *`, `npx *`, `cp`/`mv` as open allow
- Keep destructive denies (force-push, hard-reset, git add ., --no-verify, rm -rf /)

## Non-goals

entry-gate.ts, plan-write, dual-enforcement, agents/skills content, CC pipeline, general npm allow.

## Scope paths

- core/opencode/plugin/lib/bash-decide.mjs
- core/opencode/plugin/lib/bash-decide.test.mjs
- core/opencode/opencode.json.example

## Residuals accepted

| ID | Statement |
|---|---|
| RES-300-01 | Bare npm test/typecheck trust project package.json |
| RES-300-02 | Registry npx @orobsonn/… denied |
| RES-300-03 | Multi-command chains denied |
| RES-300-04 | npm run lint still denied |
| RES-300-05 | GitHub ref may be branch |
| RES-300-06 | OC permission glob language cannot encode full helper grammar (wrappers/metachar); forge plugin is authoritative; example globs are outer UX and must stay as tight as OC allows (`init` required) |

## Adversary disposition

- R1/R2 highs fixed (raw wire, exact npm, closed deny-list, `&`, no passthrough)
- R3-01 ceremony node allows → #ac-2.11 + §D
- R3-02 glob honesty → `…#* init*` + RES-300-06 + forge_authoritative
- Spec gate: RESIDUAL_ACCEPTED for RES-300-01..06
