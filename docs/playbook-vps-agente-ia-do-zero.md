# Playbook — VPS com agente de IA sempre ativo, do zero

> **Pra quem é este documento:** você (ou a pessoa que está te ajudando) tem uma VPS nova e quer
> chegar num ponto onde: (1) roda um agente de IA (OpenCode) numa máquina sempre ligada, não no seu
> PC pessoal; (2) consegue orquestrar isso visualmente pelo app Orca, do seu computador ou do
> celular; (3) seus projetos (novos ou já existentes) estão prontos pra trabalhar lá. Testado de
> ponta a ponta em Ubuntu 24.04 / x86_64.
>
> **Como usar:** se você tem uma IA te ajudando (Claude Code, Codex, Cursor, etc.), pode colar este
> documento inteiro pra ela e pedir pra executar os passos, com acesso SSH root na sua VPS. Cada
> passo tem o comando exato e o resultado esperado — uma IA com acesso SSH consegue seguir isso sem
> supervisão, mas os pontos marcados **[MANUAL]** exigem uma pessoa de verdade (login em conta,
> aprovar prompt do sistema operacional).

## O que você precisa antes de começar

- Uma VPS nova, Ubuntu 24.04 (ou 20.04/22.04/Debian stable), acesso root via SSH com senha.
  - **Specs mínimas recomendadas: 2 vCPU / 8GB RAM.** Testamos com 1 vCPU/4GB e a máquina trava sob
    carga (rodar vários agentes ao mesmo tempo derruba um núcleo só) — não é hipotético, aconteceu
    na prática. 2 vCPU/8GB com swap habilitado é o piso confortável.
- Uma conta [Tailscale](https://tailscale.com) (grátis pra uso pessoal).
- Uma conta GitHub (se for versionar os projetos por lá).
- Alguns minutos onde você mesmo vai precisar clicar em links de autenticação — não dá pra
  automatizar 100%, e não deveria: login em conta é sempre um passo seu.

---

## Fase 0 — Primeiro acesso e endurecimento do SSH

**[MANUAL]** Anota o IP da VPS e a senha root que o provedor te deu.

No seu computador local, gera uma chave SSH dedicada pra essa VPS (não reusa uma chave que já
tenha outro propósito):

```bash
ssh-keygen -t ed25519 -C "acesso-vps" -f ~/.ssh/id_ed25519_vps -N ""
ssh-copy-id -i ~/.ssh/id_ed25519_vps.pub root@<IP_DA_VPS>
```

(`-N ""` já cria sem passphrase — mais simples pra uso do dia a dia; `ssh-copy-id` vai pedir a
senha root uma última vez pra copiar a chave)

Testa o login por chave:

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'echo login-por-chave-ok'
```

**Desativa a autenticação por senha** — só depois de confirmar que o login por chave funciona:

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config
sshd -t && echo "config valida"
systemctl restart ssh
'
```

**Gotcha comum:** imagens de VPS de alguns provedores (cloud-init) têm um arquivo separado em
`/etc/ssh/sshd_config.d/*.conf` que pode reescrever `PasswordAuthentication` de volta pra `yes`,
sobrescrevendo o que você acabou de mudar (porque é lido *antes* do arquivo principal). Se depois
de reiniciar o `ssh` a senha ainda funcionar, roda:

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
grep -rl "PasswordAuthentication yes" /etc/ssh/sshd_config.d/ 2>/dev/null | \
  xargs -r sed -i "s/PasswordAuthentication yes/PasswordAuthentication no/"
systemctl restart ssh
'
```

Depois disso, teste de novo uma conexão nova por chave **antes de fechar a sessão atual** — só pra
garantir que não travou o próprio acesso.

---

## Fase 1 — Ambiente base

Atualiza o sistema e instala o essencial:

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
apt-get update && apt-get upgrade -y
apt-get install -y curl git jq build-essential
'
```

Node.js (via NodeSource, versão 22 LTS):

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v && npm -v
'
```

Git — configura identidade global (troque pelos seus dados):

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
git config --global user.name "<SEU_NOME>"
git config --global user.email "<SEU_EMAIL>"
'
```

**Chave SSH da VPS pro GitHub** (pra clonar/dar push nos seus repos):

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
ssh-keygen -t ed25519 -C "<SEU_EMAIL>" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
'
```

**[MANUAL]** Copia a chave pública impressa e cola em GitHub → Settings → SSH and GPG keys → New
SSH key. Depois testa:

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'ssh -o StrictHostKeyChecking=accept-new -T git@github.com'
```
Esperado: `Hi <seu-usuário>! You've successfully authenticated...`

---

## Fase 2 — Tailscale (a rede privada que conecta tudo)

O Tailscale cria uma VPN privada (WireGuard) só entre os seus dispositivos — VPS, seu computador,
seu celular — como se todos estivessem na mesma rede local, com IPs fixos (`100.x.x.x`) que só
você enxerga. É o que permite expor o servidor de agente sem nunca abrir porta pra internet
pública.

**Na VPS:**

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'curl -fsSL https://tailscale.com/install.sh | sh'
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'tailscale up --hostname=<NOME_DA_VPS>'
```

O segundo comando imprime um link `https://login.tailscale.com/a/...`.

**[MANUAL]** Abre esse link no navegador e autoriza com sua conta Tailscale.

Confirma e guarda o IP da tailnet (formato `100.x.x.x`) — vai ser usado em quase todos os passos
seguintes:

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'tailscale ip -4'
```

**No seu computador** (Mac): `brew install --cask tailscale-app` e abre o app.
**[MANUAL]** Aprovar qualquer prompt de extensão de sistema (Ajustes → Privacidade e Segurança) e
logar com a mesma conta — isso é um passo de UI do sistema operacional, não dá pra scriptar.

**No celular:** instalar o app Tailscale (App Store / Play Store), logar na mesma conta.

Confirma que os dispositivos se enxergam:
```bash
tailscale status
```
Deve listar seu computador, seu celular (se já configurado) e a VPS.

---

## Fase 3 — Orca headless (servidor sempre ativo)

O [Orca](https://onorca.dev) é o "painel de controle" visual pra orquestrar agentes de IA —
worktrees isolados, terminais, múltiplos agentes em paralelo. Rodando como serviço na VPS, ele fica
disponível 24/7, e você acessa de qualquer dispositivo pareado — desligar seu computador não afeta
nada, porque quem processa é a VPS, seu app é só o controle remoto.

### 3.1 — Dependências de sistema

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
apt-get install -y curl file jq xvfb zlib1g-dev libfuse2t64 libgtk-3-0t64
'
```

Notas:
- `libfuse2t64` é o nome certo em Ubuntu 24.04/Debian (era `libfuse2` em versões antigas do
  Ubuntu — usar esse nome no 22.04).
- **`libgtk-3-0t64` não está no guia oficial da Orca, mas é obrigatório** — sem ele o binário falha
  com `error while loading shared libraries: libgtk-3.so.0`. Achado na prática, não na
  documentação.
- Xvfb só precisa estar **instalado** — o Orca sobe um display virtual sozinho quando não há
  `$DISPLAY`.

### 3.2 — Baixar o binário (versão pinada)

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
ORCA_VERSION=$(curl -s https://api.github.com/repos/stablyai/orca/releases/latest | grep tag_name | cut -d\" -f4)
mkdir -p /opt/orca
curl -fL --retry 3 "https://github.com/stablyai/orca/releases/download/${ORCA_VERSION}/orca-linux.AppImage" \
  -o /opt/orca/orca-linux.AppImage
chmod 755 /opt/orca/orca-linux.AppImage
echo "instalado: ${ORCA_VERSION}"
'
```

Pinar a versão (em vez de sempre puxar "latest" num script futuro) evita atualização silenciosa
sem aviso — prática padrão pra qualquer ferramenta de terceiro com esse nível de acesso.

### 3.3 — Usuário dedicado, não-root

Todo o trabalho de agente (worktrees, terminais, projetos) vai rodar sob um usuário de sistema
próprio — isola do `root` (que segue guardando o acesso administrativo da VPS) e preserva o
sandbox do Chromium do Electron (rodar como root desativaria isso).

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
useradd --system --create-home --shell /usr/sbin/nologin orca
chown root:root /opt/orca /opt/orca/orca-linux.AppImage
chmod 755 /opt/orca /opt/orca/orca-linux.AppImage
'
```

`--shell /usr/sbin/nologin` bloqueia login interativo direto como esse usuário — mas comandos via
`sudo -u orca <comando>` funcionam normalmente (é assim que a IA/você vai configurar tudo pra esse
usuário sem precisar mudar isso).

### 3.4 — Serviço systemd

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> "cat > /etc/systemd/system/orca-serve.service << 'EOF'
[Unit]
Description=Orca runtime server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=orca
WorkingDirectory=/home/orca
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/orca/orca-linux.AppImage serve --port 6768 --pairing-address <TAILSCALE_IP_DA_VPS>
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartPreventExitStatus=3
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now orca-serve.service"
```

Confirma:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'systemctl is-active orca-serve.service && systemctl is-enabled orca-serve.service'
```
Esperado: `active` e `enabled`.

### 3.5 — Troubleshooting do serviço

| Sintoma | Causa | Fix |
|---|---|---|
| `error while loading shared libraries: libgtk-3.so.0` | falta `libgtk-3-0t64` | `apt-get install -y libgtk-3-0t64` |
| Serviço falha com `status=3`, log diz `Another Orca instance is already running` | lock obsoleto de um processo anterior morto à força (`kill -9`) sem tempo de limpar | ver comando de recuperação abaixo |
| `[ws-transport] Failed to bind port ... EADDRINUSE` e a porta anunciada muda sozinha | processo zumbi de teste anterior ainda preso na porta (o AppImage se extrai como `orca-ide` num `/tmp/.mount_orca-*` — `pkill -f orca-linux` não mata os filhos) | `pkill -9 -u orca` (mata por usuário, não por nome) |
| `dlopen(): error loading libfuse.so.2` | falta libfuse | Ubuntu 22.04: `apt-get install libfuse2`; 24.04/Debian: `libfuse2t64` |
| `Missing X server or $DISPLAY` | `xvfb` não instalado | `apt-get install -y xvfb` |

Comando de recuperação de lock obsoleto (roda os dois primeiros passos sempre juntos, na ordem):
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
systemctl stop orca-serve.service
pkill -9 -u orca
sleep 2
rm -f /home/orca/.config/orca/Singleton{Lock,Socket,Cookie}
systemctl reset-failed orca-serve.service
systemctl start orca-serve.service
'
```

### 3.6 — Parear seu computador

Pega a URL de pareamento mais recente do log do serviço:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'journalctl -u orca-serve.service --no-pager | grep "Pairing URL" | tail -1'
```

**[MANUAL]** Abre o app Orca no seu computador → Add a project → Host → Add remote host → cola o
código de pareamento (a parte depois de `code=` na URL, ou escaneia o QR se estiver usando a versão
web). **Trate esse código como senha** — dá controle total do servidor pra quem tiver.

Ou via CLI:
```bash
orca environment add --name <nome-que-quiser> --pairing-code "<código>"
orca status --environment <nome> --json   # confirma: "reachable": true, "state": "ready"
```

### 3.7 — Parear o celular

O celular precisa estar **na mesma rede Tailscale que a VPS** — isso é exigência da própria
documentação oficial do Orca, não tem atalho por nuvem/relay. A conexão é direta celular→VPS; não
depende do seu computador estar ligado.

**[MANUAL] Passo 1 — Tailscale no celular:**
1. Instala o app **Tailscale** (App Store / Google Play).
2. Abre, loga com a **mesma conta** usada na VPS e no computador.
3. Confirma que o celular apareceu na lista: `tailscale status` (rodado em qualquer dispositivo já
   conectado) deve listar o celular junto com a VPS e o computador.

**[MANUAL] Passo 2 — App Orca no celular:**
1. Instala o app **Orca Mobile** (App Store / Google Play).
2. Abre o app → **Pair** (ou "Add host" / ícone de scanner, dependendo da versão).

**Passo 3 — gerar o código de pareamento** (na VPS):
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> \
  '/opt/orca/orca-linux.AppImage serve --mobile-pairing --port 6768 --pairing-address <TAILSCALE_IP_DA_VPS>'
```
Isso imprime um QR code (em texto) e um link de pareamento escopado pra mobile. **Ctrl+C depois de
capturar** — esse comando é só pra imprimir o código; o serviço de verdade (`orca-serve.service`)
já está rodando full-time via systemd desde a Fase 3.4, não precisa deixar esse rodando.

**[MANUAL] Passo 4:** no app Orca do celular, escaneia o QR (ou cola o link) impresso no passo
anterior. Depois de parear uma vez, o celular reconecta sozinho da próxima vez que abrir o app —
não precisa repetir o pareamento.

Trate o link/QR de pareamento como senha, igual no pareamento do computador (Fase 3.6) — dá
controle total do servidor pra quem escanear.

---

## Fase 4 — OpenCode (o agente de IA)

**Ponto crítico que não está em nenhuma documentação oficial:** o Orca cria worktrees e terminais
que rodam como o usuário **`orca`**, não como `root`. Se você instalar o OpenCode só pra root (jeito
mais óbvio de instalar logo que entra na VPS), ele **não vai aparecer** dentro dos
terminais/worktrees do Orca — vai dar `command not found`. **Precisa instalar pro usuário `orca`
especificamente.**

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
sudo -u orca bash -c "curl -fsSL https://opencode.ai/install | bash"
'
```

O instalador nem sempre ajusta o `PATH` no `.bashrc` do usuário `orca` (não tem o mesmo tratamento
que dá pro root). Confirma e corrige se precisar:

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
grep -q "opencode/bin" /home/orca/.bashrc || \
  echo "export PATH=/home/orca/.opencode/bin:\$PATH" | sudo -u orca tee -a /home/orca/.bashrc
'
```

**Autenticação — precisa ser feita por você, dentro de um terminal de verdade** (não dá pra
automatizar sem sua própria chave de API). Duas formas — a primeira é a mais simples, não exige
saber usar SSH:

**Opção A — pelo próprio app Orca (recomendado, sem precisar de SSH/Termius):** depois de parear o
Orca (Fase 3.6) e trazer pelo menos um projeto (Fase 5), abre qualquer worktree no app e cria um
terminal por lá (é um terminal remoto embutido, já rodando na VPS como o usuário `orca` — o app É
o seu acesso remoto, não precisa abrir mais nada). Dentro desse terminal, roda:
```
opencode auth login
```
Menu interativo aparece na tela do próprio app: escolhe o provedor (OpenCode Zen é o recomendado
pra começar — tem modelos grátis) e cola sua API key quando pedir. A credencial fica salva pro
usuário `orca` — funciona daí em diante em qualquer projeto/worktree que você abrir.

**Opção B — direto por SSH** (se preferir, ou pra automatizar via IA com acesso SSH):
```bash
ssh -t -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS>
sudo -u orca -i
opencode auth login
```
Mesmo menu interativo, mesmo resultado — só muda a porta de entrada.

Confirma que autenticou:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'sudo -u orca /home/orca/.opencode/bin/opencode auth list'
```

**Gotcha: o app Orca não percebe o OpenCode instalado na hora.** No diálogo "Create worktree", o
campo **Agent** só mostra "Blank Terminal" mesmo com o OpenCode já instalado e funcionando (dá pra
confirmar isso via CLI: `orca worktree create --agent opencode ...` já reconhece e funciona
perfeitamente, o problema é só o app não ter re-escaneado o host ainda). **Fecha e abre o app Orca
de novo** depois de instalar o OpenCode (Fase 4) — na próxima vez que abrir o diálogo de criar
worktree, "OpenCode" aparece como opção no dropdown Agent. Se mesmo assim não aparecer, funciona
igual selecionando "Blank Terminal" e digitando `opencode` manualmente dentro do terminal criado.

---

## Fase 5 — Trazendo seus projetos

**Decisão de segurança importante:** o usuário `orca` deve ter **sua própria chave SSH**, separada
da chave que o `root` usa — nunca reaproveitar. Isso limita o estrago se algum dia o Orca (app
ainda jovem, sem histórico longo de segurança auditada) for comprometido: um problema no ambiente
gerenciado pelo Orca não some junto com credenciais administrativas da VPS inteira.

### 5.0 — Identidade git pro usuário orca

**Mesmo padrão de novo: a Fase 1 configurou o git só pro `root`. O usuário `orca` precisa da sua
própria configuração** — sem isso, o próprio app Orca bloqueia a criação de projeto pela interface
com o erro `Git author identity is not configured`.

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
sudo -u orca git config --global user.name "<SEU_NOME>"
sudo -u orca git config --global user.email "<SEU_EMAIL>"
'
```

### 5.1 — Chave de git dedicada pro usuário orca

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
sudo -u orca mkdir -p -m 700 /home/orca/.ssh
sudo -u orca ssh-keygen -t ed25519 -C "orca@<NOME_DA_VPS>" -f /home/orca/.ssh/id_ed25519 -N ""
cat /home/orca/.ssh/id_ed25519.pub
'
```

**[MANUAL]** Cola essa chave pública em GitHub → Settings → SSH and GPG keys → New SSH key (uma
entrada nova, **não** reusa a chave do root).

Testa:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'sudo -u orca ssh -o StrictHostKeyChecking=accept-new -T git@github.com'
```

### 5.2 — Trazer um projeto (novo ou já existente — mesmo mecanismo)

Clona **sempre como o usuário `orca`**, numa pasta dele (`/home/orca/dev/`) — mesmo que esse
projeto já exista em algum outro lugar da VPS (ex: sob `/root`). Não reusa o checkout do root; o
`orca` faz sua própria cópia independente.

```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
sudo -u orca mkdir -p /home/orca/dev
sudo -u orca git clone git@github.com:<SEU_USUARIO>/<SEU_REPO>.git /home/orca/dev/<SEU_REPO>
'
```

Se for um projeto **novo que ainda não existe em lugar nenhum**: cria o repositório vazio no
GitHub primeiro (ou local com `git init`), depois clona do mesmo jeito.

### 5.3 — Registrar no Orca

```bash
orca repo add --path /home/orca/dev/<SEU_REPO> --environment <nome-do-environment>
```

Repete pra cada projeto que quiser disponível no Orca. Depois disso, o projeto aparece no app pra
criar worktrees, disparar o OpenCode (ou qualquer agente) dentro dele, tudo rodando na VPS.

### 5.4 — Confirmação final: tudo funcionando junto

Cria um worktree de teste e roda o OpenCode dentro pra confirmar que a cadeia inteira fecha:
```bash
orca worktree create --repo <id-do-repo-do-passo-anterior> --name teste --environment <nome> --setup skip
orca terminal create --worktree "<worktree-id-retornado>" --environment <nome> --command "opencode --version"
# espera alguns segundos, depois:
orca terminal read --terminal "<handle-retornado>" --environment <nome>
```
Esperado: o número da versão do OpenCode aparece no output — confirma que o binário está acessível
e rodando como o usuário certo, dentro do projeto certo, na VPS.

---

## Checklist final

- [ ] Login por chave SSH funcionando, senha desativada
- [ ] Node.js, git configurados
- [ ] Tailscale conectando VPS + computador + celular
- [ ] `orca-serve.service` ativo e habilitado (sobrevive a reboot)
- [ ] App Orca pareado no computador E no celular
- [ ] OpenCode instalado **pro usuário `orca`** (não só root) e autenticado
- [ ] Identidade git (`user.name`/`user.email`) configurada pro usuário `orca`, não só root
- [ ] Chave SSH dedicada do `orca` no GitHub (separada da do root)
- [ ] Projetos clonados sob `/home/orca/dev/` e registrados no Orca
- [ ] Teste de ponta a ponta: worktree → terminal → `opencode --version` retornando certo

Com isso, desligar seu computador ou celular não afeta nada — o trabalho continua rodando na VPS, e
você reconecta de onde quiser pra ver o estado exato de onde parou.
