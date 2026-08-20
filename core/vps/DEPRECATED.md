# `core/vps/` — APOSENTADO (aguardando verificação antes da remoção)

> **Status:** não use isto em projeto novo. O substituto é `core/orca/` (ver `core/orca/README.md`).
> **Este diretório ainda NÃO foi removido de propósito** — a remoção está bloqueada por uma
> verificação que precisa de acesso `root` na VPS. O procedimento está no fim deste arquivo.

## O que era

O motor headless de cron da VPS: Cron A (`run-cron-a.mjs` — seleção + dispatch da issue), fase de
revisão (`run-cron-review.mjs`), drain do outbox (`run-drain.mjs`), reaper de worktrees
(`run-reaper.mjs`), auto-update blue/green do motor (`run-cron-update.mjs`), notificação Telegram
(`notify-telegram.mjs`) e o instalador de crontab (`install-crons.mjs`).

## Por que foi aposentado

Não foi preferência de arquitetura — foram falhas medidas em produção:

1. **Seleção sem filtro de escopo.** `cron-a-select.mjs` ordena por `createdAt` ascendente e **não
   filtra por título**. No `oraculo-app` a issue mais antiga era uma tarefa de *hard delete de PII de
   5 meses atrás*: ela seria a primeira escolhida, o que torna qualquer **modo canário impossível**.

2. **Gate de dependência ancorado em nome de branch.** `chain-release.mjs:dependencyMerged` só
   considera uma dependência satisfeita se existir PR merjado cuja head seja **literalmente**
   `harness/<N>`. Issue entregue por PR normal nunca satisfaz isso → as dependentes ficam
   `harness:queued` **para sempre**. E `chain-validate.mjs` **não detecta essa classe de falha** —
   ele valida o *grafo* (ciclo, ref dangling), não o *gate*. Resultado real: **4 de 14 issues mortas**
   num projeto, sem nenhum alarme.

3. **Postura de segurança.** Rodava como `root`, com um `.bashrc` carregando **6 tokens Cloudflare em
   texto plano**, de clientes diferentes, num shell não-interativo que todo `claude -p` herdava.

4. **Frota bifurcada e parada.** Duas cópias do motor conviviam (`/root/dev/claude-harness` na
   v0.51.0 e `/root/.claude/harness-core`) e **todos os crons de projeto estavam PAUSED**. Um motor
   que ninguém percebeu que parou é a evidência mais forte de que ele não era o caminho real.

5. **Era um segundo motor de orquestração.** O agente lançado num worktree do Orca lê o `.claude/`
   vendorado do repositório — a pipeline de entrega já está lá. `core/vps/` reimplementava
   despachante, lock, fila e notificação em ~800 KB de código para produzir o que o `.claude/` do
   repo já produz.

## O substituto

`core/orca/select-and-dispatch.mjs` — ~250 linhas (metade comentário), um JSON por projeto, cron do
usuário `orca`. As duas armadilhas acima estão fechadas por construção: `titleIncludes` é o botão de
canário, e "dependência satisfeita" é **a issue da dependência estar CLOSED**, nunca um nome de
branch. Ver `core/orca/README.md`.

O que NÃO migrou para código, porque não precisa ser código:
- **revisão de PR + merge condicional** → automação agendada do Orca (critérios em
  `core/orca/README.md`);
- **notificação Telegram** → as runs do Orca são visíveis do desktop e do celular;
- **reaper de worktrees / drain de outbox** → ciclo de vida do worktree é do Orca;
- **auto-update blue/green do motor** → não há motor separado para atualizar; o pipeline é o
  `.claude/` vendorado no repo, atualizado por PR como qualquer outro código.

## O que continua valendo (não foi aposentado junto)

- **`core/claude-code/hooks/entry-gate.mjs`** fica e é valioso: ele verifica o rollup de checks do PR
  antes de permitir `gh pr merge` e recusa alvo ambíguo. Consequência prática para a automação de
  merge do Orca: **o comando de merge não pode passar `-R`/`--repo`** (nem `--auto`) — precisa rodar
  dentro do checkout do repo alvo, passando só o número do PR.
- **`core/shared/lib/harness-deps.mjs`** — o parser do bloco ```` ```harness-deps ```` saiu daqui para
  `core/shared/lib/`, porque o selector do Orca usa o mesmo formato de issue. `chain-deps.mjs` virou
  um re-export para os crons ainda instalados não quebrarem.
- **`core/shared/lib/merge-check-gate.mjs`**, `core/shared/*` em geral: sempre foram libs
  compartilhadas, não parte do motor.

---

## Procedimento de remoção (NÃO pule a verificação)

Outros projetos ainda podem ter entradas de crontab apontando para cá — em particular `run-drain` e
`run-reaper`, que o `install-crons.mjs` escreve em blocos separados do bloco por projeto.
**Apagar `core/vps/` sem checar quebra esses crons silenciosamente** (o cron simplesmente falha e
manda o stderr para o mailbox local que ninguém lê).

### 1. Inventariar (precisa de root — o motor rodava como root)

```bash
sudo crontab -l | grep -n "harness:\|core/vps" ; echo "---"
for u in $(cut -d: -f1 /etc/passwd); do sudo crontab -l -u "$u" 2>/dev/null | grep -q "core/vps" && echo "USER COM CRON DO MOTOR: $u"; done
sudo grep -rl "core/vps" /etc/cron.d /etc/crontab 2>/dev/null
sudo ls -d /root/dev/claude-harness /root/.claude/harness-core /root/.claude/harness-core-versions 2>/dev/null
sudo ls /root/.claude/harness-crons/ 2>/dev/null      # um JSON por projeto instalado
```

Os blocos são cercados por linhas literais: `# >>> harness:<project> >>>` / `# <<< harness:<project>
<<<`, mais `# >>> harness:reaper >>>`. Cada bloco de projeto tem 3 linhas: `run-cron-a.mjs`,
`run-cron-review.mjs`, `run-drain.mjs`.

### 2. Migrar cada projeto encontrado

Para cada projeto ainda no crontab do root:

```bash
# a) criar o JSON do projeto (formato em core/orca/project.example.json)
sudo -u orca $EDITOR /home/orca/.config/claude-harness/projects/<slug>.json

# b) registrar a linha do selector no crontab do usuário `orca`
sudo -u orca crontab -e
#    */20 * * * * /usr/bin/node /home/orca/.claude/harness-core/core/orca/select-and-dispatch.mjs \
#      --config /home/orca/.config/claude-harness/projects/<slug>.json >> /home/orca/.local/state/claude-harness/<slug>.log 2>&1

# c) criar a automação de revisão de PR do projeto no Orca (ver core/orca/README.md)

# d) só então remover o bloco antigo do crontab do root
sudo crontab -l | sed '/# >>> harness:<slug> >>>/,/# <<< harness:<slug> <<</d' | sudo crontab -
```

### 3. Fechar a frota

```bash
sudo crontab -l | sed '/# >>> harness:reaper >>>/,/# <<< harness:reaper <<</d' | sudo crontab -
sudo crontab -l | grep -c "core/vps"     # precisa dar 0
```

### 4. Só então remover

Quando o passo 3 retornar `0` **e** nenhum outro usuário/`/etc/cron.d` referenciar `core/vps`:

```bash
git rm -r core/vps
```

E na mesma mudança: remover as referências restantes em `scripts/cutover-preflight.test.mjs`,
`scripts/parity-manifest.test.mjs`, `docs/specs/oc-port/`, `docs/prd/` e o import de
`resolve-runtime.mjs`. O `package.json` **já** não empacota `core/vps/` (não está em `files`), então
nada muda para quem instala pela tag do GitHub.
