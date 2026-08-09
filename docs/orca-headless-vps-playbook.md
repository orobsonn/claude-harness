# Playbook — Orca headless server numa VPS (systemd + Tailscale)

Passo a passo replicável de como instalamos o [Orca](https://onorca.dev) (ADE de orquestração de
agentes, Electron) como serviço sempre-ativo numa VPS Ubuntu, pareado com o Orca desktop local via
Tailscale. Testado em Ubuntu 24.04 / x86_64, Orca v1.4.177.

## Contexto e decisão

Decisão consciente: instalar direto na mesma VPS que já roda o pipeline de cron do
`claude-harness` (issues → PR → review) e guarda segredos de deploy de múltiplos client projects,
em vez de isolar numa VPS separada — aceito depois de uma revisão adversarial que recomendava
isolamento. Mitigação aplicada: usuário de sistema dedicado (`orca`, sem shell), nunca expor a
porta pública (só Tailscale), e não copiar os segredos existentes (`~/.bashrc` do root) para o
usuário `orca` — quem precisar disso conecta manualmente depois, por escopo.

## Pré-requisitos

- VPS Ubuntu 20.04/22.04/24.04 ou Debian stable (glibc 2.31+), x86_64 ou arm64.
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

Guardar esse IP — é o `--pairing-address` usado em todos os passos seguintes (nesta instalação:
`100.98.45.37`).

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

## 7. Parear um dispositivo cliente (Mac/desktop)

No dispositivo cliente:
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

## Troubleshooting

| Sintoma | Causa | Fix |
|---|---|---|
| `error while loading shared libraries: libgtk-3.so.0` | falta `libgtk-3-0t64` (não documentado oficialmente) | `apt-get install -y libgtk-3-0t64` |
| Serviço systemd falha com `status=3/NOTIMPLEMENTED`, log diz `Another Orca instance is already running` | lock obsoleto (`SingletonLock`/`SingletonSocket`/`SingletonCookie`) sobrando de um processo anterior encerrado à força (`kill -9`) sem tempo de limpar | `systemctl stop orca-serve; pkill -9 -u orca; rm -f /home/orca/.config/orca/Singleton{Lock,Socket,Cookie}; systemctl reset-failed orca-serve; systemctl start orca-serve` |
| Log mostra `[ws-transport] Failed to bind port ... EADDRINUSE, trying next candidate` e o `Advertised endpoint` sai numa porta diferente da configurada | processo zumbi de um teste anterior ainda com a porta presa (o AppImage se extrai como `orca-ide` num `/tmp/.mount_orca-*` — um `pkill -f orca-linux` não mata esses filhos) | `pkill -9 -u orca` (mata por usuário, não por nome de processo) antes de subir o serviço |
| `dlopen(): error loading libfuse.so.2` | falta libfuse | Ubuntu 22.04: `libfuse2`; Ubuntu 24.04/Debian: `libfuse2t64` |
| `Missing X server or $DISPLAY` | `xvfb` não instalado (Orca só sobe Xvfb sozinho se o pacote já existir) | `apt-get install -y xvfb` |

## Atualização (quando sair versão nova)

Princípio: estado (perfil, credenciais, histórico) mora em `/home/orca/.config/orca/`, não junto
do binário — **rollback precisa restaurar os dois juntos**, nunca só o binário (uma versão mais
nova pode reescrever o schema do perfil ao iniciar).

```bash
ORCA_VERSION=v1.X.Y   # nova versão

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

- **Não copiar os segredos de deploy (`~/.bashrc` do root com tokens Cloudflare) para o usuário
  `orca`.** Quem precisar rodar algo autenticado a partir do Orca conecta a credencial específica
  na hora, escopada — não replica o `.bashrc` global inteiro.
- **Não expor a porta 6768 publicamente** (sem Tailscale/WireGuard) — a pairing URL sozinha vira
  controle total do runtime pra qualquer um que a veja.
- **Não usar o motor `orca orchestration` (run/task/dispatch/gate/worker/coordinator) junto com o
  pipeline autônomo do `claude-harness` no mesmo repo/worktree sem coordenação** — são dois
  motores de orquestração independentes competindo pelo mesmo papel.
