# Playbook — VPS com agente de IA sempre ativo, do zero

> **Pra quem é este documento:** você tem (ou vai comprar) uma VPS nova e quer chegar num ponto
> onde: (1) roda um agente de IA (OpenCode) numa máquina sempre ligada, não no seu PC pessoal;
> (2) orquestra isso visualmente pelo app Orca, do computador ou do celular; (3) seus projetos
> (novos ou já existentes) estão prontos pra trabalhar lá. Testado de ponta a ponta em Ubuntu
> 24.04 / x86_64.
>
> **Como usar:** cole este documento inteiro pra sua IA (Claude Code, Codex, etc.) rodando local no
> seu computador, com acesso SSH root na VPS. Ela executa quase tudo sozinha — o filtro de cada
> passo é: **só é seu se envolver login numa conta, digitar uma senha, ou aprovar algo na tela do
> seu celular/computador.** Tudo o mais (gerar chave, instalar pacote, configurar serviço, subir
> projeto) é a IA que faz.


> **ADE oficial: [Orca](https://onorca.dev).** O Orca (*Agent Development Environment*) é o ambiente
> oficial deste harness para rodar e observar entregas — no desktop e no celular. **Download:
> https://onorca.dev** · releases (AppImage Linux + app desktop):
> **https://github.com/stablyai/orca/releases**.
>
> O desenho são **duas camadas, não dois motores**: o **Orca despacha** (cria o worktree, lança o
> agente, mostra a run) e o **`.claude/` vendorado no repo executa** (entry-policy, gates, hooks).
> O que liga os dois é um selector fino — um JSON por projeto, uma linha de cron
> (`core/orca/`, ver [`../core/orca/README.md`](../core/orca/README.md)).

## Specs da VPS

**Mínimo recomendado: 2 vCPU / 8GB RAM, com swap habilitado.** Testamos com 1 vCPU/4GB/sem swap e
a VPS **travou por completo sob carga real** — 6 agentes rodando ao mesmo tempo derrubaram a
máquina a ponto de nem SSH conseguir conectar (precisou do console web do provedor pra recuperar).
Com 2 vCPU/8GB + swap, o mesmo tipo de carga só fica lento, não trava. Se a VPS que você comprou
não veio com swap, a IA configura antes de seguir:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
free -h | grep -i swap   # se mostrar 0B, cria um swapfile:
[ "$(swapon --show)" ] || (
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
)
'
```

## O que só você precisa fazer (visão geral)

Antes de mergulhar nos passos, aqui está a lista **completa** das coisas que exigem você — o resto
do documento é a IA executando. São ~10 ações rápidas, a maioria "clicar em um link":

1. Comprar a VPS e pegar IP + senha root no painel do provedor.
2. Rodar **um único comando** (`ssh-copy-id`) você mesmo, digitando a senha — é a única vez que a
   senha aparece, e só no seu terminal, nunca pra IA.
3. Criar uma conta [Tailscale](https://tailscale.com/) — grátis, uso pessoal.
4. Clicar no link de autorização quando a VPS entrar na sua rede Tailscale.
5. Aprovar o login do `gh` (GitHub CLI) uma vez — depois disso a IA cadastra todas as chaves SSH
   sozinha, sem você colar nada no GitHub manualmente.
6. Instalar o app **Tailscale** no seu computador e aprovar a extensão de sistema (prompt do
   macOS/Windows) + logar.
7. Instalar o app **Orca** no seu computador e logar.
8. Rodar `opencode auth login` você mesmo e colar sua chave de API (é sua credencial, só você tem).
9. Instalar **Tailscale** e **Orca Mobile** no celular, logar nos dois com a mesma conta.
10. Escanear o QR de pareamento mobile (gerado dentro do app Orca do computador).

**Dica pro Tailscale (passo 3):** usa um e-mail que você acessa fácil de qualquer lugar — vai
logar com essa mesma conta em **3 dispositivos** (VPS, computador, celular).

---

## Fase 0 — Primeiro acesso e endurecimento do SSH

🧑 **Você:** compra a VPS, pega o IP e a senha root no painel do provedor, e passa isso pra sua IA.

🤖 **A IA gera a chave** (no seu computador, não na VPS ainda):
```bash
ssh-keygen -t ed25519 -C "acesso-vps" -f ~/.ssh/id_ed25519_vps -N ""
```

🧑 **Você roda isso** (é o único momento em que uma senha entra em jogo — por isso é manual):
```bash
ssh-copy-id -i ~/.ssh/id_ed25519_vps.pub root@<IP_DA_VPS>
```

🤖 **A IA testa e endurece o acesso** a partir daqui:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'echo login-por-chave-ok'
```
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config
sshd -t && echo "config valida"
systemctl restart ssh
'
```

**Gotcha comum:** imagens de VPS com cloud-init têm um arquivo separado em
`/etc/ssh/sshd_config.d/*.conf` que pode reescrever `PasswordAuthentication` de volta pra `yes`
(porque é lido *antes* do arquivo principal). Se depois de reiniciar o `ssh` a senha ainda
funcionar:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
grep -rl "PasswordAuthentication yes" /etc/ssh/sshd_config.d/ 2>/dev/null | \
  xargs -r sed -i "s/PasswordAuthentication yes/PasswordAuthentication no/"
systemctl restart ssh
'
```

A IA testa uma conexão nova por chave antes de considerar esse passo concluído, pra garantir que
não travou o próprio acesso.

---

## Fase 1 — GitHub CLI (libera automação de chave SSH pro resto do playbook)

Esse passo vem cedo de propósito: fazendo isso uma vez agora, a IA nunca mais precisa pedir pra
você colar chave pública no site do GitHub — ela cadastra tudo sozinha via API dali em diante
(Fase 1.2 e Fase 5).

🤖 **A IA verifica se o `gh` já está instalado e autenticado no seu computador:**
```bash
gh auth status
```

Se não estiver instalado: `brew install gh` (Mac) ou equivalente. Se não estiver autenticado:

🧑 **Você aprova uma vez:**
```bash
gh auth login --scopes admin:public_key
```
Isso imprime um código de 4 letras e um link (`https://github.com/login/device`). Você abre o
link, cola o código, aprova. **`admin:public_key` no comando é o que permite a IA cadastrar
chaves SSH automaticamente depois** — sem esse escopo, teria que voltar a colar manualmente.

### 1.1 — Ambiente base na VPS

🤖 **A IA faz tudo daqui:**
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

Git — identidade global (a IA já sabe seu nome/email da conversa, ou pergunta uma vez):
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
git config --global user.name "<SEU_NOME>"
git config --global user.email "<SEU_EMAIL>"
'
```

### 1.2 — Chave SSH da VPS pro GitHub (sem colar nada manualmente)

🤖 **A IA gera a chave na VPS e cadastra direto no GitHub via `gh`, num só fluxo:**
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -C "<SEU_EMAIL>" -f ~/.ssh/id_ed25519 -N ""
'
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'cat ~/.ssh/id_ed25519.pub' | \
  gh ssh-key add - --title "vps-root-<NOME_DA_VPS>"
```
(o `gh ssh-key add` roda no seu computador, usando o login do passo anterior — lê o conteúdo da
chave pública direto da VPS via SSH, sem passar por copiar/colar em navegador)

Confirma:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'ssh -o StrictHostKeyChecking=accept-new -T git@github.com'
```
Esperado: `Hi <seu-usuário>! You've successfully authenticated...`

---

## Fase 2 — Tailscale (a rede privada que conecta tudo)

O Tailscale cria uma VPN privada (WireGuard) só entre os seus dispositivos — VPS, computador,
celular — como se todos estivessem na mesma rede local, com IPs fixos (`100.x.x.x`) que só você
enxerga. É o que permite acessar o servidor de agente sem nunca abrir porta pra internet pública.

🧑 **Você:** cria a conta em [tailscale.com](https://tailscale.com/) (se ainda não tiver) — use um
e-mail fácil de acessar de qualquer lugar, vai logar nos 3 dispositivos com essa conta.

🤖 **A IA instala e conecta a VPS:**
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'curl -fsSL https://tailscale.com/install.sh | sh'
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'tailscale up --hostname=<NOME_DA_VPS>'
```
O segundo comando imprime um link `https://login.tailscale.com/a/...`.

🧑 **Você clica** nesse link e autoriza com sua conta Tailscale.

🤖 **A IA confirma e guarda o IP da tailnet** (formato `100.x.x.x` — vai ser usado no resto do
playbook):
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'tailscale ip -4'
```

🧑 **Você instala o app Tailscale no computador** (`brew install --cask tailscale-app` no Mac, ou
baixa em tailscale.com/download) — precisa abrir o app e **aprovar manualmente um prompt de
extensão de sistema** (Ajustes → Privacidade e Segurança no Mac). Esse prompt de SO não dá pra
automatizar de jeito nenhum, nem por script nem por IA. Loga com a mesma conta.

A IA confirma que os dispositivos se enxergam:
```bash
tailscale status
```
Deve listar seu computador e a VPS (o celular entra na Fase 5).

---

## Fase 3 — Orca headless (servidor sempre ativo)

O [Orca](https://onorca.dev) é a **ADE oficial** deste harness — o painel visual pra orquestrar
agentes de IA (worktrees isolados, terminais, múltiplos agentes em paralelo). Rodando como serviço na
VPS, fica disponível 24/7: desligar seu computador não afeta nada, porque quem processa é a VPS.

**Downloads:** https://onorca.dev · releases (AppImage Linux + app desktop):
https://github.com/stablyai/orca/releases

🤖 **A IA faz toda essa fase.**

### 3.1 — Dependências de sistema
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
apt-get install -y curl file jq xvfb zlib1g-dev libfuse2t64 libgtk-3-0t64
'
```
Notas:
- `libfuse2t64` é o nome certo em Ubuntu 24.04/Debian (era `libfuse2` no 22.04).
- **`libgtk-3-0t64` não está no guia oficial da Orca, mas é obrigatório** — sem ele o binário falha
  com `error while loading shared libraries: libgtk-3.so.0`. Achado na prática.
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
Pinar a versão evita atualização silenciosa de uma ferramenta de terceiro num script futuro.

### 3.3 — Usuário dedicado, não-root

Todo o trabalho de agente (worktrees, terminais, projetos) roda sob um usuário de sistema próprio —
isola do `root` (que segue com o acesso administrativo da VPS) e preserva o sandbox do Chromium do
Electron.
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
useradd --system --create-home --shell /usr/sbin/nologin orca
chown root:root /opt/orca /opt/orca/orca-linux.AppImage
chmod 755 /opt/orca /opt/orca/orca-linux.AppImage
'
```
`--shell /usr/sbin/nologin` bloqueia login interativo direto — mas `sudo -u orca <comando>`
funciona normal (é assim que a IA configura tudo pra esse usuário sem precisar mudar isso).

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
| Diálogo "Create worktree" no app só mostra "Blank Terminal", nunca "OpenCode" mesmo já instalado | o app cacheia os agentes detectados no host desde que conectou | fecha e abre o app Orca de novo — ou usa Blank Terminal e digita `opencode` manualmente, funciona igual |
| Um projeto que você criou "some" da lista do app, mas você tem certeza que existia | mesma causa: cache da UI dessincronizado do estado real da VPS — **não é perda de dado** | confirma antes de entrar em pânico: `orca repo list --environment <nome> --json` mostra o projeto normalmente mesmo quando o app não mostra. Fecha e abre o app (ou desconecta/reconecta o host) e ele reaparece |

Comando de recuperação de lock obsoleto (roda sempre nessa ordem):
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

🤖 **A IA pega a URL de pareamento e registra o ambiente localmente — sem você precisar clicar em
nada no app:**
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'journalctl -u orca-serve.service --no-pager | grep "Pairing URL" | tail -1'
```
```bash
orca environment add --name <NOME_DA_VPS> --pairing-code "<código, a parte depois de code=>"
orca status --environment <NOME_DA_VPS> --json   # confirma: "reachable": true, "state": "ready"
```
Isso grava a configuração no mesmo lugar que o app Orca lê — 🧑 **você só precisa abrir o app** e
o host já aparece disponível, pareado, sem passar por nenhum diálogo de "Add remote host".

Instala o app se ainda não tiver: `brew install --cask orca` (Mac) ou baixa em **https://onorca.dev** (releases: https://github.com/stablyai/orca/releases).
Trate o link/código de pareamento como senha — dá controle total do servidor pra quem tiver.

---

## Fase 4 — OpenCode (o agente de IA)

**Ponto crítico que não está em nenhuma documentação oficial:** o Orca cria worktrees e terminais
que rodam como o usuário **`orca`**, não como `root`. Instalar o OpenCode só pra root não aparece
dentro dos terminais/worktrees do Orca — dá `command not found`. **Precisa instalar pro usuário
`orca` especificamente.**

🤖 **A IA instala:**
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
sudo -u orca bash -c "curl -fsSL https://opencode.ai/install | bash"
'
```
O instalador nem sempre ajusta o `PATH` no `.bashrc` do usuário `orca`. A IA confirma e corrige se
precisar:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
grep -q "opencode/bin" /home/orca/.bashrc || \
  echo "export PATH=/home/orca/.opencode/bin:\$PATH" | sudo -u orca tee -a /home/orca/.bashrc
'
```

**Autenticação — só você tem a chave de API, então esse passo é seu.** Caminho mais simples: pelo
próprio app Orca (sem precisar de SSH/Termius).

🧑 **Você:**
1. No app Orca (já pareado na Fase 3.6), abre qualquer worktree e cria um terminal — é um terminal
   remoto embutido, já rodando na VPS como o usuário `orca`.
2. Roda `opencode auth login` nesse terminal. Escolhe o provedor (OpenCode Zen é o recomendado pra
   começar — tem modelos grátis) e cola sua chave de API quando pedir.

Se preferir por SSH direto em vez do app:
```bash
ssh -t -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS>
sudo -u orca -i
opencode auth login
```

🤖 **A IA confirma que autenticou:**
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'sudo -u orca /home/orca/.opencode/bin/opencode auth list'
```

---

## Fase 5 — Trazendo seus projetos e pareando o celular

### 5.0 — Identidade git pro usuário orca

Mesmo padrão da Fase 1.1: aquela configuração foi só pro `root`. Sem isso, o próprio app Orca
bloqueia a criação de projeto pela interface com `Git author identity is not configured`.

🤖 **A IA:**
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
sudo -u orca git config --global user.name "<SEU_NOME>"
sudo -u orca git config --global user.email "<SEU_EMAIL>"
'
```

### 5.1 — Chave de git dedicada pro usuário orca

**Decisão de segurança:** o usuário `orca` tem **sua própria chave SSH**, separada da que o `root`
usa — nunca reaproveitar. Limita o estrago se algum dia o Orca (app ainda jovem, sem histórico
longo de segurança auditada) for comprometido: um problema no ambiente gerenciado por ele não some
junto com credenciais administrativas da VPS inteira.

🤖 **A IA gera e cadastra no GitHub no mesmo fluxo automático da Fase 1.2** (sem colar nada
manualmente, já que o `gh` foi autorizado uma vez lá atrás):
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
sudo -u orca mkdir -p -m 700 /home/orca/.ssh
sudo -u orca ssh-keygen -t ed25519 -C "orca@<NOME_DA_VPS>" -f /home/orca/.ssh/id_ed25519 -N ""
'
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'sudo -u orca cat /home/orca/.ssh/id_ed25519.pub' | \
  gh ssh-key add - --title "orca-<NOME_DA_VPS>"
```
Testa:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'sudo -u orca ssh -o StrictHostKeyChecking=accept-new -T git@github.com'
```

### 5.2 — Trazer um projeto (novo ou já existente — mesmo mecanismo)

🤖 **A IA clona sempre como o usuário `orca`**, numa pasta dele (`/home/orca/dev/`) — mesmo que
esse projeto já exista em outro lugar da VPS (ex: sob `/root`). Não reusa o checkout do root; o
`orca` faz sua própria cópia independente.
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
sudo -u orca mkdir -p /home/orca/dev
sudo -u orca git clone git@github.com:<SEU_USUARIO>/<SEU_REPO>.git /home/orca/dev/<SEU_REPO>
'
```
Se for um projeto **novo que ainda não existe em lugar nenhum**: cria o repositório vazio no
GitHub primeiro (ou local com `git init`), depois clona do mesmo jeito. Ou usa o próprio app Orca
→ "Create a new project" (a IA já resolveu a identidade git na Fase 5.0, então esse fluxo funciona
direto pela interface também).

**Gotcha crítico — todo clone feito pelo app Orca (botão "Clone from URL") nasce sem
`origin/HEAD` configurado.** Um `git clone` de terminal normal configura essa referência sozinho
(é ela que diz qual é a branch padrão do remoto — `main` ou `master`); o clone feito pela
interface do Orca pula esse passo, sempre, em todo projeto novo. Sem ela, qualquer skill que
precise identificar a branch padrão pra abrir PR com segurança (o `/updating-harness`, por
exemplo) recusa seguir — e o erro só aparece muito depois, na hora de tentar mergear. **Rode isso
uma vez logo após clonar** (seja qual for o mecanismo usado):
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> "sudo -u orca git -C /home/orca/dev/<SEU_REPO> remote set-head origin -a"
```
Se em algum momento surgir um erro mencionando `origin/HEAD` num projeto que você não lembra de
ter configurado assim, é sempre esse mesmo gap — roda o comando acima nele.

### 5.3 — Registrar no Orca
```bash
orca repo add --path /home/orca/dev/<SEU_REPO> --environment <NOME_DA_VPS>
```
Repete pra cada projeto. Depois disso ele aparece no app pra criar worktrees, disparar o OpenCode
dentro, tudo rodando na VPS.

### 5.4 — Confirmação: tudo funcionando junto

🤖 **A IA cria um worktree de teste com o OpenCode já disparado como agente inicial** (`--agent
opencode` já é reconhecido pelo Orca, dispara o OpenCode automaticamente no primeiro terminal):
```bash
orca worktree create --repo <id-do-repo> --name teste --agent opencode --environment <NOME_DA_VPS> --setup skip --json
```
Esperado no JSON de retorno: `"createdWithAgent": "opencode"` e um `startupTerminal` com
`"spawned": true` — confirma que o binário está acessível, autenticado, e rodando como o usuário
certo, dentro do projeto certo, na VPS.

### 5.5 — Pareando o celular

**Correção importante em relação a versões anteriores deste documento:** a tela **Settings → Set
up → Mobile → Generate QR Code**, dentro do app Orca do computador, pareia o celular com **o
computador**, não com a VPS — dá pra confirmar isso pelo campo "This computer's address" naquela
tela, que mostra o IP Tailscale do computador, não o da VPS. Usar esse caminho quebra o objetivo
inteiro (celular sempre ativo, independente do computador ligado). **O jeito certo é gerar o
código de pareamento direto na VPS.**

O celular precisa estar **na mesma rede Tailscale que a VPS** (exigência da documentação oficial
do Orca — sem atalho por nuvem/relay).

🧑 **Você:**
1. Instala o app **Tailscale** no celular (App Store / Google Play), loga com a mesma conta usada
   no computador e na VPS. **No iOS, confirma que a VPN está de fato conectada** — em Ajustes →
   VPN, ou dentro do próprio app Tailscale em "VPN On Demand" (liga pra Wi-Fi e Celular). Ter o app
   instalado e logado não é suficiente; o túnel precisa estar ativo de verdade.
2. Instala o app **Orca Mobile** no celular (App Store / Google Play).

🤖 **A IA gera o código de pareamento mobile-scoped direto no host da VPS** (não dá pra pedir isso
pro serviço já rodando sem parar ele por um instante — é rápido, ~5 segundos, e o serviço volta
sozinho):
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
systemctl stop orca-serve.service
sleep 2
timeout 8 sudo -u orca /opt/orca/orca-linux.AppImage serve --mobile-pairing --port 6768 --pairing-address <TAILSCALE_IP_DA_VPS>
'
```
No final do output, tem uma linha `Pairing URL: orca://pair?code=...` — é esse link (não o QR ASCII
que aparece no terminal, ignora ele). O `timeout 8` mata o processo de propósito depois de capturar
o link; a IA restaura o serviço normal logo em seguida:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
pkill -9 -u orca
sleep 2
rm -f /home/orca/.config/orca/Singleton{Lock,Socket,Cookie}
systemctl reset-failed orca-serve.service
systemctl start orca-serve.service
'
```

🧑 **Você:** abre o link `orca://pair?code=...` **no próprio celular** (manda pra você mesmo por
Notas, WhatsApp, o que for mais fácil de abrir lá — o iOS/Android reconhece o esquema `orca://` e
abre direto no app Orca Mobile). Trate esse link como senha.

A IA confirma que funcionou checando se rolou handshake de verdade entre a VPS e o celular
(não só "Online" — isso só significa logado na conta Tailscale, não que o túnel está ativo):
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> 'tailscale status --json' | \
  python3 -c "import json,sys; d=json.load(sys.stdin); [print(p.get(\"HostName\"),p.get(\"Active\"),p.get(\"LastHandshake\")) for p in d[\"Peer\"].values()]"
```
Handshake recente + `Active: true` = celular realmente conectado na VPS, não só "logado" no
Tailscale. Depois de parear uma vez, o celular reconecta sozinho nas próximas vezes.

**Se o handshake nunca acontece mesmo com Tailscale "Online":** teste de diagnóstico —
`tailscale ping --c 3 <IP_TAILSCALE_DO_CELULAR>` rodado na VPS. Se voltar `pong ... via DERP`, a
rede funciona (só não é conexão direta, é via relay — normal em rede celular, não é problema). Se
não voltar nada, o problema é mesmo de rede/Tailscale no celular, não do Orca.

### 5.6 — Dando acesso de escrita a um segundo agente/usuário no mesmo projeto (opcional)

Se em algum momento você quiser dar acesso a **outro agente de IA** (ex: Codex) ou outra pessoa a
um projeto que o `orca` já usa — sem entregar a chave raiz da VPS — o padrão é: usuário Linux
dedicado + ACL escopada só na(s) pasta(s) do(s) projeto(s) em questão (nunca a VPS inteira).

🤖 A IA cria o usuário e concede acesso só ao projeto certo:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@<IP_DA_VPS> '
useradd --create-home --shell /bin/bash <nome-do-usuario>
setfacl -R -m u:<nome-do-usuario>:rwX /home/orca/orca/projects/<projeto>
setfacl -R -d -m u:<nome-do-usuario>:rwX /home/orca/orca/projects/<projeto>
'
```

**Gotcha crítico — a ACL tem que ser simétrica nos dois sentidos.** Se o projeto já é usado pelo
`orca` (Orca/OpenCode escrevendo nele), a ACL acima só dá permissão de volta pro usuário novo.
Qualquer arquivo/pasta que **ele** criar (ex: `.git/objects/xx/` de um commit dele) nasce sem
entrada de ACL pro `orca` — o `orca` cai no bucket "other" (só leitura) nessa pasta nova. Na
prática isso aparece assim: o agente original tenta commitar/dar push depois do novo e recebe algo
como "Git não tem permissão para gravar em .git/objects". O fix é dar a mesma ACL pros **dois**
usuários, nos dois modos (atual + default, pra valer em arquivos futuros também):
```bash
setfacl -R -m u:orca:rwX,u:<nome-do-usuario>:rwX /home/orca/orca/projects/<projeto>
setfacl -R -d -m u:orca:rwX,u:<nome-do-usuario>:rwX /home/orca/orca/projects/<projeto>
```
Roda isso **toda vez que um projeto passa a ser compartilhado por dois usuários** — não é
automático, e o erro só aparece depois que os dois já escreveram alguma coisa cada um.

---

## Cuidado com capacidade (memória/CPU)

**Cada agente rodando (OpenCode, ou qualquer subagente que ele dispare) é um processo pesado** —
na prática vimos ~300-400MB de RAM por processo, e CPU é o gargalo mais cedo que memória num VPS
de poucos núcleos. Regra prática pra 2 vCPU/8GB: **2-3 agentes ativos ao mesmo tempo é confortável;
6+ é quando a coisa trava de verdade** (aconteceu nesta VPS, load average passou de 18 num núcleo
só, o OOM killer começou a matar processo — inclusive sessões importantes no meio do trabalho).

**Se a VPS ficar completamente inacessível** (SSH não conecta, nem ping/porta respondem):
1. Isso é diferente de "SSH lento" — teste `nc -zv <IP> 22` primeiro. Se a porta responde mas o
   handshake do SSH nunca fecha, é sobrecarga de CPU (o sistema não consegue nem escalonar o
   `sshd`), não queda de rede.
2. **Acesse pelo console web do provedor** (toda VPS tem isso no painel — procura por "Console" ou
   "VNC"). É o único jeito de entrar quando o SSH está inacessível por sobrecarga.
3. De dentro do console, mata os processos mais pesados — geralmente os agentes de fundo:
   ```bash
   pkill -TERM -f -- "--agent-id"   # mata subagentes específicos, preserva a sessão principal
   free -h                           # confirma que liberou memória
   ```
4. Espera a `load average` (comando `uptime`) descer antes de tentar SSH de novo.

## Checklist final

- [ ] VPS com 2 vCPU/8GB mínimo e swap habilitado
- [ ] Login por chave SSH funcionando, senha desativada
- [ ] `gh auth login` feito uma vez, com escopo `admin:public_key`
- [ ] Node.js, git configurados (**pro `root` e pro `orca`**, os dois — é fácil esquecer o segundo)
- [ ] Tailscale conectando VPS + computador + celular
- [ ] `orca-serve.service` ativo e habilitado (sobrevive a reboot)
- [ ] App Orca pareado no computador (via `orca environment add`, sem passar por diálogo manual) e
      no celular (via link `orca://pair` gerado **direto na VPS** com `--mobile-pairing` — não pela
      tela Settings do app do computador, que pareia com o computador, não com a VPS)
- [ ] Handshake real confirmado entre VPS e celular (`tailscale status --json` mostrando
      `Active: true` e `LastHandshake` recente pro celular, não só "Online")
- [ ] OpenCode instalado **pro usuário `orca`** (não só root) e autenticado
- [ ] Chave SSH dedicada do `orca` no GitHub (separada da do root, cadastrada via `gh ssh-key add`,
      sem colar nada manualmente)
- [ ] Projetos clonados sob `/home/orca/dev/` e registrados no Orca
- [ ] Teste de ponta a ponta: worktree criado com `--agent opencode` retornando
      `createdWithAgent: "opencode"` e terminal disparado
- [ ] **Entrega autônoma ligada**: fila de implementação (JSON do projeto + linha do selector) **e**
      automação de review no Orca — as duas metades. O caminho guiado, do diagnóstico até uma issue
      canária entregue, é a skill
      [`connecting-orca`](../core/claude-code/skills/connecting-orca/SKILL.md)
- [ ] Uma sessão de agente consegue **operar** a VPS: `npx @orobsonn/claude-harness orca-doctor`.
      Três falhas comuns leem como *"não tenho acesso"* e nenhuma delas é — barreiras, causas e
      correções em [`orca-headless-vps-playbook.md` §8](orca-headless-vps-playbook.md)

Com isso, desligar seu computador ou celular não afeta nada — o trabalho continua rodando na VPS, e
você reconecta de onde quiser pra ver o estado exato de onde parou.
