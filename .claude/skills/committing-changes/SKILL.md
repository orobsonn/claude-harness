---
name: committing-changes
description: Analisa mudancas, cria commit semantico (Conventional Commits) e faz push. Para commit avulso fora do pipeline /ship — quando voce so quer commitar uma mudanca sem PR/review/docs.
---

# Commit

Commit avulso. Quando voce quer commitar agora sem rodar pipeline completo de PR.

Para entrega completa (review + security + docs + PR), use `/ship`.

## Quando usar

- Commit intermediario durante desenvolvimento (WIP que voce vai squashar depois)
- Mudanca trivial em branch propria que nao precisa de revisao formal
- Commit em branch ja com PR aberta (continuar trabalho)

**Nao usar pra**:
- Mudanca pronta pra entregar — usar `/ship`
- Commit em main — proibido por padrao (use branch + PR)

## Fluxo

### 1. Verificar estado
```bash
git status --short
git diff --stat
git log --oneline -5
```

Se nao houver mudancas, reportar e sair.

### 2. Sanity check de arquivos
Flaggear como provavel lixo (mesma lista do `/ship`):
- `.dev.vars`, `.env*`, `.local.*`
- `.claude/settings.local.json`, `.claude/plans/current.md`
- `.DS_Store`, `*.log`, `node_modules/`, `dist/`, `coverage/`

Confirmar com o usuario antes de prosseguir.

### 3. Verificacoes locais
Rodar o minimo definido em `<projeto>/.claude/CLAUDE.md` (secao Comandos):
```bash
npx tsc --noEmit
```
Se falhar, parar.

Pular `npm test` aqui (pode ser custoso) — `/ship` cobre antes do PR.

### 4. Stage seletivo
- `git add <files>` — nunca `git add .` cego
- Mostrar `git diff --cached` antes de commitar

### 5. Commit (Conventional Commits)
- Header: `<type>: <descricao em pt-br>` (max 72 chars)
- Tipos: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `style`, `perf`, `ci`, `build`
- Body opcional (1-3 linhas) explicando PORQUE
- `Closes #N` se aplicavel
- **NUNCA** trailer `Co-Authored-By: Claude ...`

```bash
git commit -m "$(cat <<'EOF'
<type>: <descricao>

[opcional: body]

Closes #N
EOF
)"
```

### 6. Push (se branch tem upstream)
```bash
git push
```
Se branch local nao tem upstream, perguntar antes de `push -u origin <branch>`.

## Output

Reportar:
- Hash + titulo do commit
- Se fez push (e pra qual remote/branch)
- Aviso se ainda falta `/ship` pra abrir PR

## Regras
- NUNCA commit em main direto
- NUNCA `git add .` cego
- NUNCA `--no-verify` ou `--amend` em commit ja publicado
- NUNCA trailer `Co-Authored-By: Claude ...`
- Se pedir pra force push, recusar (excecao: `--force-with-lease` em branch propria, com confirmacao explicita)
