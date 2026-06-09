# Git

Universal — sem `paths:`, carrega em toda conversa.

## Conventions

### Branches
- Branch `main` e protegida — nunca commitar direto. Sempre branch + PR
- Tipos de branch (kebab-case): `feat/`, `fix/`, `refactor/`, `test/`, `chore/`, `docs/`
- Nome curto, max ~50 chars: `feat/user-profile-page`, `fix/auth-redirect-loop`
- 1 issue ou grupo pequeno de issues relacionadas por branch
- Deletar branch local + remota apos merge (`git branch -d` + `gh pr merge --delete-branch`)

### Commits — Conventional Commits
- Formato: `<type>: <descricao curta em pt-br>` (max 72 chars no header)
- Tipos: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `style`, `perf`, `ci`, `build`, `revert`
- Scope opcional: `feat(auth): ...`, `fix(api): ...`
- Body opcional separado por linha em branco — explica PORQUE, nao O QUE (diff fala o que)
- `Closes #N` ou `Refs #N` no body pra fechar/referenciar issue
- 1 commit = 1 mudanca logica atomica. Refactor + feature em commits separados

### Commits — proibido
- `Co-Authored-By: Claude ...` — policy do ambiente rejeita o push com "fabricated authorship attribution". Commit deve terminar na descricao, sem trailer de co-autor
- `git commit -am "wip"` ou `"fix"` — mensagens vagas. Sempre descrever
- `git commit --amend` em commit ja publicado (push feito) — reescreve historia compartilhada
- `git push --force` em main — perde trabalho de outros. `--force-with-lease` em branch propria ok
- `git commit --no-verify` — pula hooks. Se hook falha, investigar a causa raiz

### Pull Requests
- Titulo segue Conventional Commits (`feat: descricao`)
- Body com 2 secoes minimas:
  - **Summary** — 1-3 bullets do que foi feito
  - **Test plan** — checklist de verificacao manual ou automatizada
- 1 PR auto-contida: codigo + testes + docs atualizados
- PR pequena (max ~400 linhas alteradas) — facilita review. Se for maior, justificar ou quebrar
- Merge: squash por default (1 commit limpo na main). Rebase ok pra branch propria; merge commit so se historia merece preservacao

### Stage seletivo
- NUNCA `git add .` ou `git add -A` cego — pode incluir `.dev.vars`, `.local.*`, arquivos gerados
- Stage por arquivo (`git add src/foo.ts`) ou por hunk (`git add -p`)
- Antes de commitar: `git diff --cached` pra ver exatamente o que vai entrar
- Antes de push: `git log origin/main..HEAD` pra revisar a serie

### Sincronizacao com remoto
- Antes de comecar trabalho novo: `git fetch origin && git status`
- Se main divergiu da remota e working tree limpo: `git checkout main && git pull`
- Se ha uncommitted changes: NAO puxar automaticamente — stash, commit ou descartar antes
- Conflito de merge: resolver manualmente, nunca `--strategy=ours/theirs` cego sem entender

### Histórico limpo
- Rebase interativo (`git rebase -i`) ok pra reorganizar commits da branch propria antes do push
- NUNCA rebase de main (historia compartilhada)
- Usar `git fixup` ou `git commit --fixup` + `rebase --autosquash` pra corrigir commit local

## Patterns

- **Commit message bem escrito**:
  ```
  feat(auth): persiste sessao em KV com TTL de 7 dias

  Antes a sessao vivia so em memoria do Worker — qualquer cold start
  derrubava o usuario. KV persiste e respeita TTL nativo.

  Closes #42
  ```

- **PR template minimo**:
  ```markdown
  ## Summary
  - Adiciona persistencia de sessao em KV
  - Configura TTL via env var `SESSION_TTL_DAYS`

  ## Test plan
  - [ ] Login local persiste apos restart do `wrangler dev`
  - [ ] Sessao expirada retorna 401
  - [ ] `npm test` verde
  ```

- **Stage seletivo**:
  ```bash
  git status --short              # ver tudo
  git add src/auth/session.ts    # stage especifico
  git diff --cached              # confirmar antes de commitar
  ```

## Gotchas

- **`git add .` em diretorio com `.dev.vars`**: vaza secret pro repo. Conventional Commits nao salva — depois precisa rewrite history
- **`git commit --amend` apos push**: proximo push exige `--force`, sobrescreve historia que outros podem ter pulled
- **PR sem `Closes #N`**: issue fica aberta apos merge. Sempre referenciar
- **Squash de PR com mensagem de commit ruim**: vira a mensagem permanente na main. Editar antes de squash
- **Branch local atras da remota**: `git rebase origin/main` antes do push pra evitar merge commit barato
- **`Co-Authored-By: Claude`**: trailer rejeitado pelo ambiente. Nao incluir
- **Deletar branch antes do merge**: perde trabalho. So deletar apos confirmar merge no GitHub
