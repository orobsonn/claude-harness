# Usage — instalar/atualizar o harness e configurar a routine

Guia prático. Para o desenho e as decisões, ver `design.md`, `cloud-routines.md`, `audit.md`.

## Os dois repositórios

- **Fonte (este repo):** `https://github.com/orobsonn/claude-harness` — o núcleo distribuível vive em `core/`.
- **Projeto vendorado:** cada projeto recebe uma cópia do `core/` no seu `.claude/` (committed), porque cloud routines só enxergam o `.claude/` do repo, nunca o `~/.claude`.

`core/` → `.claude/` é feito pelo instalador `vendor-core.mjs`.

---

## 1. Instalar o harness num projeto (primeira vez)

Bootstrap (você ainda não tem o script no projeto): clone a fonte uma vez e rode o instalador apontando para ela.

```bash
git clone --depth 1 https://github.com/orobsonn/claude-harness.git /tmp/claude-harness
node /tmp/claude-harness/core/skills/initializing-projects/references/vendor-core.mjs \
  --source https://github.com/orobsonn/claude-harness.git --target /caminho/do/projeto
```

`--source` aceita a **URL git** (clona sozinho) ou um **caminho local** com `core/`. O que ele faz (idempotente):

- **sobrescreve** (framework): `.claude/agents/`, `.claude/skills/`, `.claude/rules/`, `CLAUDE-HARNESS-MEMORY-MODEL.md`
- **semeia se ausente** (nunca clobbera): `.claude/memory/MEMORY.md`, `.claude/kaizen.md`
- **merge por marcador**: `.claude/CLAUDE.md` (preserva conteúdo do projeto fora dos marcadores)
- **non-clobber**: `.claude/settings.json` (se já existe, grava `settings.harness.json` pra você mesclar)
- **escreve**: `.claude/.gitignore`, `.claude/.harness-version`, `.github/ISSUE_TEMPLATE/harness-task.yml`

Depois:

```bash
# criar os labels do harness (idempotente)
gh label create "harness:ready"       -c 0E8A16 -d "Pronta para a pipeline autônoma" || true
gh label create "harness:in-progress" -c FBCA04 -d "Routine processando" || true
gh label create "harness:done"        -c 5319E7 -d "PR aberto pela routine" || true

# commitar o .claude/ na main (cloud routine clona a default branch)
git add .claude .github/ISSUE_TEMPLATE/harness-task.yml
git commit -m "chore: instala Claude Harness"
git push origin main
```

**Pré-requisitos pra a pipeline funcionar de verdade no projeto:**
- o `.claude/` precisa estar na **branch que a routine clona** (a default — normalmente `main`);
- o projeto precisa de **runner de teste** (vitest/jest) — senão o gate (`locked_tests`) fica vazio.

---

## 2. Atualizar o harness num projeto já instalado

O `vendor-core.mjs` já está vendorado no projeto. Rode-o apontando para a URL:

```bash
node .claude/skills/initializing-projects/references/vendor-core.mjs \
  --source https://github.com/orobsonn/claude-harness.git --target .
```

Atualiza os arquivos do framework para a versão atual da fonte **sem destruir** a memória (`.claude/memory/`), o `kaizen.md`, o conteúdo do projeto no `CLAUDE.md` (fora dos marcadores) nem o `settings.json`. A versão fica em `.claude/.harness-version`.

---

## 3. Padrão de issues (harness-ready)

A pipeline transforma a issue em spec → plano → testes. Para issue **nova**, use o form **"Harness Task"** (`.github/ISSUE_TEMPLATE/harness-task.yml`) — ele captura resumo, user journeys, **critérios de aceite testáveis** (viram os `locked_tests`), escopo, decisões resolvidas, domínio sensível, prioridade e tamanho, e **auto-aplica o label `harness:ready`**.

- Só issues `harness:ready` entram no radar da routine.
- Não marque `harness:ready` em tarefas **sensíveis críticas** (auth/pagamento/segredos) ou **arquiteturais grandes** sem alinhar — autônomo nelas é risco alto, mesmo com PR draft.
- Issues antigas (sem o form) podem ser retrofitadas no formato + tag `harness:ready`.

---

## 4. Configurar a routine no Claude Code (claude.ai/code)

A routine roda na nuvem, autônoma. **Routine não dispara por issue** (triggers de GitHub só cobrem PR/Release) — o padrão é **agendada + poll** das issues `harness:ready`.

Passos em `claude.ai/code/routines` → **New routine**:
1. **Repositório:** selecione o projeto (precisa ter o harness na `main`). Uma routine pode ter vários repos — mas roda **uma sessão independente por repo**, com o **mesmo prompt** e clonando a default branch.
2. **Branch:** default (`main`) — onde o harness está.
3. **Setup script:** `npm install` (pra o vitest existir no gate).
4. **Trigger:** Schedule (ex.: diário).
5. **Prompt (poll de issues):**

```
Rode em MODO AUTÔNOMO (headless).

Seleção:
1. gh issue list --state open --label "harness:ready" --json number,title,body,createdAt
2. Descarte as com label "harness:done" ou que já têm PR aberto (gh pr list).
3. Leia prioridade/tamanho do corpo (campos do form). Ordene: P0>P1>P2, empate→menor tamanho (S<M<L), empate→mais antiga.
4. Pegue a PRIMEIRA. Marque "harness:in-progress" e remova "harness:ready".

Execução:
5. Siga a entry-policy (.claude/CLAUDE.md): triaging → orchestrating-delivery headless.
   Os campos do form (UJs/ACs/escopo/decisões/sensível) SÃO a spec.
6. Abra PR DRAFT (Closes #N) + commite .claude/memory/ e .claude/kaizen.md.
7. Troque "harness:in-progress" por "harness:done".

NUNCA AskUserQuestion/plan-mode. Se não der pra escopar com segurança, comente, devolva "harness:ready" e pule. 1 issue por run.
```

6. **Run now** para testar; depois deixe no schedule.

### Caps
Research preview tem limites de runs (por routine/conta). Não conte com volume alto.

---

## 5. Validar um run

Não há link automático PR→sessão nem notificação de falha. Valide assim:

- **Transcript** em `claude.ai/code/routines` (clica no run) — persiste; mostra triaging→orchestrating→gates→PR. "Verde" = rodou sem erro de infra, **não** = tarefa OK; abra e leia.
- **No git** (independe da UI): o PR é **draft**? Tem `.claude/memory/` commitado (harvester rodou)? Os `__tests__` foram autorados (TDD)? O corpo do PR traz spec/plano/demo/riscos?
- Pipeline real (vs implementação direta) = PR com **memória + kaizen + testes + review**, não só o código.

---

## Modos

- **Local (interativo):** operador no loop; gates humanos reais (aprovar spec/plano, demo).
- **Headless (cloud routine):** sem humano; gates viram validação multi-agente; entrega = **PR draft, nunca merge**; o gate humano real é a **revisão do PR**. Ativado por ser cloud (`$CLAUDE_CODE_REMOTE`) ou pelo prompt "rode autônomo".

## Add-ons opcionais
`modules/rtk/` (economia de token, hook fail-open) e `modules/mv/` (Mind Vault, por-usuário) — opt-in, nunca dependência do core.
