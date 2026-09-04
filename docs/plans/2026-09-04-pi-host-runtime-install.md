# Pi: instalação reproduzível por usuário/host

## Resultado e limites

Um init/update sem alvo explícito instala os quatro harnesses. Quando Pi está
incluído, a worktree vendorizada precisa executar na máquina atual sem depender
do Pi global nem alterar dependências do produto. Worktrees do mesmo usuário
reutilizam o runtime e a autenticação; mudar de host requer provisionar naquele
host. Clonar o repositório não transporta dependências ou login.

Não mudar pipeline, modelos ou permissões de produto nesta etapa. Não instalar
scripts npm por tentativa, copiar binários Mac para Linux, fazer GC automático,
reiniciar runs ativas ou publicar antes de validar cold install nos dois hosts.

## Evidência e revisão adversarial

O vendor atual copia arquivos; o launcher resolve pacotes locais/npx/globais e
aplica patches neles. Isso falhou na transferência para VPS e pode modificar o
Pi global do operador. O teste de overlay antes aceitava dependência já patched;
agora parte obrigatoriamente do digest original e foi conferido contra npm pack.

A revisão adversarial exigiu: chave inclui o overlay (não só lock de pacotes),
execução/preflight não modificam o cache, provisionamento termina antes de
vendorizar a release e instalação concorrente publica uma geração completa.
Esses requisitos são aceitos. Hashes detectam corrupção; não são isolamento de
outro processo com a mesma UID. Symlinks legítimos de npm em `.bin` precisam ser
distinguidos de links que escapam do cache; não bloquear npm normal por uma
regra genérica de "nenhum symlink".

Correção da revisão: manter os dois pins como dependencies de produção na raiz.
O contrato de `pi install git:` usa npm com `--omit=dev` e o manifest referencia
diretamente a extensão subagents em node_modules. Movê-los para dev quebraria esse
caminho. Aceitar temporariamente o download duplicado no npx; remover esse custo
requer uma migração deliberada do pacote nativo e sua validação, não esta otimização.

## Plano TDD

1. **Definição e resolução da geração** — `core/pi/runtime-deps/{package.json,package-lock.json}`,
   módulo `core/pi/lib/pi-runtime-cache.mjs` e testes. Chave estável por conteúdo
   de manifests/overlay, plataforma, arquitetura e ABI Node. RED: geração muda
   quando o overlay muda; cache ausente ou inválido não cai em projeto/global.
   Resolver só lê e retorna caminhos exatos ou diagnóstico acionável.

2. **Provisionamento** — mesmo módulo e testes de integração. `npm ci
   --omit=dev --ignore-scripts --no-audit --no-fund` em staging irmão 0700;
   validar versões, bytes dos patches e smoke do CLI, publicar atomicamente sob
   lock. RED: duas instalações concorrentes, falha npm, cache alterado e lock
   obsoleto. Cache hit não chama npm; nenhuma geração existente é patchada no
   lugar. Definir integridade suficiente para arquivos executados sem inventar
   um sandbox. Preservar gerações anteriores; recuperação nunca remove runtime
   de uma run viva.

3. **Lifecycle e launcher** — integrar ensure antes do vendor que inclui Pi;
   seleção explícita sem Pi não provisiona. Launcher/`--verify` usam apenas
   resolveVerified. Assets fixados definem o cache; os pins da raiz continuam
   preservando a instalação nativa do pacote Pi. RED:
   falha na instalação não publica launcher novo; default all e cada seleção
   explícita; npm-pack contém assets; produto e Pi global permanecem intocados.

4. **Aceitação real** — pacote empacotado, HOME/cache isolados, projeto sem
   node_modules e sem fallback global: init → launcher vendorizado --verify;
   repetir sem npm; executar smoke headless/TUI da extensão e autenticação
   compartilhada sem exibir credenciais. Repetir instalação no Linux da VPS,
   não transportar o cache do Mac. Só então consolidar release e nova run de
   pipeline com evidência de retomada e revisões.

## Verificação e rollback

Rodar testes do cache/lifecycle, suíte Pi e suíte completa. A revisão final deve
inspecionar paths resolvidos, hashes antes/depois do produto/Pi global e falhas
observáveis, não apenas mocks de npm ou strings de documentação. Rollback usa
o launcher/release anterior e sua geração preservada. Nenhuma limpeza automática
de cache ou credencial faz parte desta implementação.

## Pendências paralelas para paridade

Exclusividade do pai em todos os modos de abrir sessão; retomada live com plano
aprovado; contrato de tarefas sem teste e verificação final parent-only; redução
medida dos loops de testes; consolidar e publicar as alterações já verificadas.
Este plano não redefine o objetivo como apenas instalar o runtime.
