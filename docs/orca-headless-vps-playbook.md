# Playbook — Orca headless server numa VPS (systemd + Tailscale)

> **O [Orca](https://onorca.dev) é a ADE oficial deste harness.**
> Download / instalação: **https://onorca.dev** · releases (AppImage Linux, app desktop):
> **https://github.com/stablyai/orca/releases**
>
> ADE = *Agent Development Environment*. É por ele que a entrega autônoma é despachada e observada —
> do desktop e do celular. Não é um add-on opcional do desenho: é a camada de despacho.

Passo a passo replicável de como instalamos o Orca como serviço sempre-ativo numa VPS Ubuntu,
pareado com o Orca desktop local via Tailscale. Testado em Ubuntu 24.04 / x86_64, Orca v1.4.177.

## Contexto e decisão — duas camadas, não dois motores

O desenho em produção hoje:

```
cron do usuário `orca`  ──▶  core/orca/select-and-dispatch.mjs  ──▶  orca worktree create
   (1 linha por projeto)          (escolhe a issue + trava)                │
                                                                          ▼
                                                     agente (claude) num worktree do Orca
                                                                          │
                                                                          ▼
                                                     lê o .claude/ VENDORADO do repo
                                                     → o pipeline vendorado É a pipeline
```

**Orca despacha; o harness do repositório executa.** O agente lançado num worktree do Orca lê o
`.claude/` do próprio repo, então a pipeline de entrega (entry-policy, `triaging`,
`orchestrating-delivery`, gates, hooks) já está lá. O selector não precisa — e não tem — despachante
próprio.

Isso **resolve** a antiga cláusula deste playbook ("não usar o motor de orquestração do Orca junto
com o pipeline do claude-harness"). Ela nasceu de uma leitura correta de um desenho errado: naquele
momento existiam de fato **dois motores** disputando o mesmo papel, porque o `claude-harness` trazia
o seu próprio (`core/vps/`, crons na VPS selecionando issue, criando worktree, revisando PR,
notificando). Com esse motor aposentado, não há competição: há uma camada de despacho (Orca) e uma
camada de execução (o `.claude/` do repo).

**O motor de cron da VPS foi aposentado** — por falhas medidas, não por preferência de arquitetura.
O registro completo está em [`core/vps/DEPRECATED.md`](../core/vps/DEPRECATED.md); em resumo:
seleção por issue mais antiga sem filtro de escopo (tornava modo canário impossível), gate de
dependência ancorado em nome de branch (4 de 14 issues mortas em silêncio, invisíveis para o
`chain-validate`), execução como root com tokens de vários clientes no ambiente, e uma frota
bifurcada em duas cópias do motor com todos os crons PAUSED.

Decisão de isolamento (mantida): o Orca roda na mesma VPS que guarda segredos de deploy de múltiplos
client projects, em vez de numa VPS separada — aceito depois de uma revisão adversarial que
recomendava isolamento. Mitigações aplicadas: usuário de sistema dedicado (`orca`), porta nunca
exposta publicamente (só Tailscale), e **credencial escopada por projeto**, carregada sob demanda —
nunca um `.bashrc` global com o token de todo cliente (ver a seção *Credencial escopada* abaixo).

## Pré-requisitos

- VPS Ubuntu 20.04/22.04/24.04 ou Debian stable (glibc 2.31+), x86_64 ou arm64.
- **Mínimo 2 vCPU / 8 GB com swap** — teto validado em 4 agentes Claude simultâneos.
- Acesso root via SSH.
- Uma conta Tailscale (grátis para uso pessoal).

## 1. Tailscale na VPS

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --hostname=harness-vps
```

Isso imprime um link `https://login.tailscale.com/a/...` — abrir no navegador e autorizar com a
conta Tailscale. Depois, confirmar o IP da VPS na tailnet (formato `100.x.x.x`):

```bash
tailscale ip -4
```

Guardar esse IP — é o `--pairing-address` usado em todos os passos seguintes.

## 2. Dependências do sistema

```bash
apt-get update
apt-get install -y curl file jq xvfb zlib1g-dev libfuse2t64 libgtk-3-0t64
```

Notas:
- `libfuse2t64` é o nome do pacote em Ubuntu 24.04/Debian (era `libfuse2` em versões antigas —
  usar `libfuse2` no Ubuntu 22.04).
- **`libgtk-3-0t64` não está documentado no guia oficial da Orca, mas é necessário** — sem ele o
  binário falha com `error while loading shared libraries: libgtk-3.so.0`. Descoberto na prática
  nesta instalação, não na doc.
- Xvfb (`xvfb`) só precisa estar **instalado** — o próprio Orca sobe um Xvfb gerenciado
  automaticamente quando não há `$DISPLAY` setado. Não precisa de unit systemd separada pra isso.

## 3. Baixar o binário (versão pinada, não "latest")

Página de download: **https://onorca.dev** · releases: **https://github.com/stablyai/orca/releases**

```bash
ORCA_VERSION=v1.4.177   # conferir a tag atual: curl -s https://api.github.com/repos/stablyai/orca/releases/latest | grep tag_name
mkdir -p /opt/orca
curl -fL --retry 3 "https://github.com/stablyai/orca/releases/download/${ORCA_VERSION}/orca-linux.AppImage" \
  -o /opt/orca/orca-linux.AppImage
chmod 755 /opt/orca/orca-linux.AppImage
```

Pinar a versão exata (não usar o link `.../releases/latest/download/...` direto num script de
instalação) evita que um redeploy futuro puxe uma versão nova sem aviso — supply chain de
ferramenta de terceiro.

## 4. Usuário dedicado não-root

```bash
useradd --system --create-home --shell /usr/sbin/nologin orca
chown root:root /opt/orca /opt/orca/orca-linux.AppImage
chmod 755 /opt/orca /opt/orca/orca-linux.AppImage
```

O binário fica dono do `root` (só leitura/execução pro `orca`) — o processo em si roda como
`orca`, preservando o sandbox do Chromium (rodar como root desativaria o sandbox do Electron).

## 5. Testar em foreground antes de virar serviço

```bash
LIBGL_ALWAYS_SOFTWARE=1 su - orca -s /bin/bash -c \
  "/opt/orca/orca-linux.AppImage serve --port 6768 --pairing-address <TAILSCALE_IP>"
```

Output esperado (ignorar os `ERROR:dbus/bus.cc` no início — inofensivo, comum em Electron sem
sessão D-Bus de desktop):

```
Orca server ready
Bound endpoint: ws://0.0.0.0:6768
Advertised endpoint: ws://<TAILSCALE_IP>:6768
Pairing URL: orca://pair?code=...
```

Confirmar e encerrar com `Ctrl+C` (ou deixar o timeout do teste). **Importante:** se for encerrar
esse teste com `kill -9`/`pkill -9` em vez de deixar o processo sair sozinho, ver a seção
Troubleshooting → "Another Orca instance already running" abaixo — isso deixa lock obsoleto.

## 6. Systemd service

`/etc/systemd/system/orca-serve.service`:

```ini
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
ExecStart=/opt/orca/orca-linux.AppImage serve --port 6768 --pairing-address <TAILSCALE_IP>
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartPreventExitStatus=3
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now orca-serve.service
systemctl status orca-serve.service
```

Confirmar: `Active: active (running)`, e no `journalctl -u orca-serve.service` a linha
`Bound endpoint: ws://0.0.0.0:6768` (não uma porta aleatória — ver troubleshooting se aparecer
`EADDRINUSE`).

## 7. Parear um dispositivo cliente (desktop / celular)

Baixe o Orca desktop em **https://onorca.dev**. No dispositivo cliente:

1. Instalar Tailscale (`brew install --cask tailscale-app` no Mac) e logar na **mesma conta** usada
   na VPS. Isso exige aprovar um prompt de extensão de sistema em Ajustes → Privacidade e
   Segurança — passo manual, não automatizável via script/SSH.
2. Confirmar alcance: `tailscale status` deve listar os dois dispositivos; `nc -zv <TAILSCALE_IP>
   6768` deve suceder.
3. Pegar a Pairing URL mais recente do log do serviço:
   ```bash
   journalctl -u orca-serve.service --no-pager | grep "Pairing URL" | tail -1
   ```
4. No cliente, registrar o ambiente remoto:
   ```bash
   orca environment add --name <nome> --pairing-code "<code da pairing URL, só a parte depois de code=>"
   ```
5. Confirmar round-trip real (não só rede): `orca status --environment <nome> --json` deve
   retornar `"reachable": true` e `"state": "ready"`.

**Tratar a pairing URL/código como senha** — dá controle total do runtime pra quem a tiver. Cada
pareamento novo gera um token revogável separado (não precisa reusar o mesmo).

---

## 8. Ligar a entrega autônoma (o selector)

Com o Orca no ar, a entrega autônoma é **um JSON por projeto + uma linha de cron**. O artefato é
[`core/orca/`](../core/orca/README.md) — leia esse README para o formato completo dos campos.

```bash
# 1) registrar o repo no Orca e pegar o id
sudo -u orca orca repo ls --json

# 2) um JSON por projeto
sudo -u orca install -d -m 700 /home/orca/.config/claude-harness/projects
sudo -u orca tee /home/orca/.config/claude-harness/projects/<slug>.json >/dev/null <<'JSON'
{
  "project": "<slug>",
  "ghRepo": "<owner>/<repo>",
  "orcaRepoId": "<id do passo 1>",
  "baseBranch": "main",
  "agent": "claude",
  "globalMaxWorking": 4,
  "titleIncludes": "[canary]"
}
JSON

# 3) uma linha de cron por projeto — usuário `orca`, NUNCA root
sudo -u orca crontab -e
# */20 * * * * /usr/bin/node /home/orca/.claude/harness-core/core/orca/select-and-dispatch.mjs \
#   --config /home/orca/.config/claude-harness/projects/<slug>.json \
#   >> /home/orca/.local/state/claude-harness/<slug>.log 2>&1
```

`globalMaxWorking` é o teto **global da máquina** (o selector conta os worktrees `working` de toda a
VPS via `orca worktree ps --json`), então todos os JSONs carregam o mesmo valor. Paralelizar por
projeto é mais um JSON e mais uma linha.

Comece com `"titleIncludes": "[canary]"` — assim só issues explicitamente marcadas entram na
pipeline. Sem esse filtro, a issue escolhida é simplesmente a `harness:ready` aberta mais antiga, e
num backlog real isso é uma tarefa de anos atrás, não a que você quer observar primeiro.

## 9. Revisão de PR + merge condicional

**Não é código — é uma automação agendada do Orca.** Ela só merja quando: o veredito próprio é
*merjar*, **nenhum** achado ARMADO de severidade alta, CI concluído em `SUCCESS`, e sem conflito —
com `--match-head-commit` obrigatório.

> **O `entry-gate.mjs` do harness continua valendo e é valioso:** ele lê o rollup de checks do PR
> antes de permitir `gh pr merge` e **recusa alvo ambíguo**. Consequência prática: o comando de merge
> da automação **não pode** passar `-R`/`--repo` (nem `--auto`) — ele precisa rodar dentro do
> checkout do repo alvo, passando só o número do PR. Isso é o que mantém o gate de CI inescapável.

## 10. Credencial escopada por projeto

Nunca um `.bashrc` global com o token de todo cliente. No `~/.bashrc` do usuário `orca`, defina a
**função**, não o carregamento:

```bash
cf() { set -a; . "$HOME/.config/$1/cloudflare.env"; set +a; }   # chmod 600 em cada arquivo
```

Um shell não-interativo — o que o cron e o agente herdam — fica **sem token nenhum** até alguém
pedir explicitamente, por projeto.

Complementarmente, a denylist vendorada bloqueia produção (`wrangler deploy|versions|secret|r2` e
`d1 execute --remote`, mais as formas `npm/pnpm/bun/yarn run deploy`). Sem isso, `Bash(npm run:*)`
aprovado + um script `"deploy": "wrangler deploy"` é caminho **aprovado** pra produção sem passar
por PR. É defesa em profundidade por string-match, não sandbox — o fechamento real é a credencial
escopada acima.

---

## Troubleshooting

| Sintoma | Causa | Fix |
|---|---|---|
| `error while loading shared libraries: libgtk-3.so.0` | falta `libgtk-3-0t64` (não documentado oficialmente) | `apt-get install -y libgtk-3-0t64` |
| Serviço systemd falha com `status=3/NOTIMPLEMENTED`, log diz `Another Orca instance is already running` | lock obsoleto (`SingletonLock`/`SingletonSocket`/`SingletonCookie`) sobrando de um processo anterior encerrado à força (`kill -9`) sem tempo de limpar | `systemctl stop orca-serve; pkill -9 -u orca; rm -f /home/orca/.config/orca/Singleton{Lock,Socket,Cookie}; systemctl reset-failed orca-serve; systemctl start orca-serve` |
| Log mostra `[ws-transport] Failed to bind port ... EADDRINUSE, trying next candidate` e o `Advertised endpoint` sai numa porta diferente da configurada | processo zumbi de um teste anterior ainda com a porta presa (o AppImage se extrai como `orca-ide` num `/tmp/.mount_orca-*` — um `pkill -f orca-linux` não mata esses filhos) | `pkill -9 -u orca` (mata por usuário, não por nome de processo) antes de subir o serviço |
| `dlopen(): error loading libfuse.so.2` | falta libfuse | Ubuntu 22.04: `libfuse2`; Ubuntu 24.04/Debian: `libfuse2t64` |
| `Missing X server or $DISPLAY` | `xvfb` não instalado (Orca só sobe Xvfb sozinho se o pacote já existir) | `apt-get install -y xvfb` |
| O selector nunca despacha e o log só diz `skip: ... worktrees working` | worktrees antigos presos em `working` consomem o teto global | `orca worktree ps --json` e encerrar os órfãos; o teto é global, não por projeto |
| Uma issue ficou `harness:in-progress` sem worktree | o `worktree create` falhou **e** a devolução do label também | procurar `STUCK: #N` no log do selector e devolver o label à mão — é o único estado que exige reparo humano |

## Atualização (quando sair versão nova)

Princípio: estado (perfil, credenciais, histórico) mora em `/home/orca/.config/orca/`, não junto
do binário — **rollback precisa restaurar os dois juntos**, nunca só o binário (uma versão mais
nova pode reescrever o schema do perfil ao iniciar).

```bash
ORCA_VERSION=v1.X.Y   # nova versão (ver https://github.com/stablyai/orca/releases)

# 1. baixar novo binário
curl -fL --retry 3 "https://github.com/stablyai/orca/releases/download/${ORCA_VERSION}/orca-linux.AppImage" \
  -o /opt/orca/orca-linux.AppImage.new
chmod 755 /opt/orca/orca-linux.AppImage.new

# 2. backup pra rollback (binário velho + perfil)
ROLLBACK=/opt/orca/rollback-$(date +%F-%H%M%S)
install -d -m 700 "$ROLLBACK"
cp -a /opt/orca/orca-linux.AppImage "$ROLLBACK/"
cp -a /home/orca/.config/orca "$ROLLBACK/config-orca"

# 3. parar, trocar (swap atômico), subir
systemctl stop orca-serve.service
mv -f /opt/orca/orca-linux.AppImage.new /opt/orca/orca-linux.AppImage
systemctl reset-failed orca-serve.service
systemctl start orca-serve.service
```

Se algo quebrar: `systemctl stop orca-serve`, restaurar **binário e pasta de config** do
`$ROLLBACK`, `systemctl start orca-serve`.

## O que NÃO fazer (decisões já tomadas)

- **Não copiar os segredos de deploy para o usuário `orca` num `.bashrc` global.** Quem precisar
  rodar algo autenticado conecta a credencial específica na hora, escopada por projeto (seção 10).
  Foi exatamente o oposto disso — root com 6 tokens Cloudflare de clientes diferentes em texto
  plano, herdados por todo `claude -p` — que ajudou a aposentar o motor antigo.
- **Não expor a porta 6768 publicamente** (sem Tailscale/WireGuard) — a pairing URL sozinha vira
  controle total do runtime pra qualquer um que a veja.
- **Não reviver o motor de cron da VPS** (`core/vps/`) ao lado do selector. Aí sim seriam dois
  motores competindo pelo mesmo papel — que é o problema real que a antiga cláusula deste playbook
  descrevia. Ver [`core/vps/DEPRECATED.md`](../core/vps/DEPRECATED.md), inclusive o procedimento de
  verificação antes de remover o diretório (outros projetos ainda podem ter crontab apontando pra lá).
- **Não rodar o selector como root.** Ele é cron do usuário `orca`, e é assim que a credencial
  escopada faz sentido.
