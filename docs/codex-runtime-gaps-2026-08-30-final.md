# Codex — port nativo final

## Decisão

O port entrega o que o Codex suporta nativamente sem recriar o motor de estado que tornou a lane
OpenCode difícil de operar. A fonte é `core/codex/`; o vendor escreve `.codex/` e
`.codex/skills/`.

## Portado

- Dez papéis em agentes Codex com sandbox explícito: olhos read-only e mãos workspace-write,
  inclusive o `sniper` para correção cirúrgica.
- Quinze skills consolidadas com contratos reutilizáveis de delivery, governança e memória,
  `AGENTS.md`, regras de comando e guia do operador.
- Roteamento: Luna/low para coleta mecânica, Terra/medium para execução e testes, Sol/high para
  plano e revisão; Sol/xhigh só para segurança/crítico ou falha de gate.
- Rails nativos estreitos: version-check no `SessionStart`, policy antes de operações destrutivas,
  segredos em shell, Wrangler remoto e edição direta do harness; após a ferramenta só registra
  recibo local sem conteúdo sensível. Não é port do sistema de hooks dos outros runtimes.
- Memória durável inicial `MEMORY.md`/`kaizen.md` sem sobrescrever conteúdo do operador e primitivas
  puras de complexidade, formato de review e merge conservador de vereditos.
- Vendor `--runtime codex` e `--runtime all`, manifesto de ownership, atualização isolada, pacote npm
  e preservação dos valores de um `config.toml` já pertencente ao projeto, acrescentando apenas
  ativações de runtime ausentes.

## Limites assumidos

| Superfície original | Decisão | Motivo verificável |
|---|---|---|
| Plugins, state e lib do OpenCode | Não portar | Codex não oferece o mesmo contrato de plugin/estado. Replicar criaria um segundo motor. |
| Estado compartilhado Claude/OpenCode | Não portar | Sem chamador Codex nativo, seria código morto e autoridade fictícia; contratos puros de review foram portados sem estado. |
| Orca | Não suportado ainda | Não há adaptador Codex testado; mantenha Orca externo até existir contrato real. |
| VPS aposentada | Omitida | É motor depreciado e duplicado. |
| Hooks | Rail estreito, não fronteira | Exigem confiança do projeto; podem ser contornados por caminhos hospedados/opt-out, não incluem os state machines antigos e o pós-hook não desfaz efeito. |
| Leitura de segredos | Rail de Bash, não deny nativo | Um perfil experimental de filesystem foi aceito pelo parser, mas um probe real ainda leu `.env`; por isso não é distribuído nem alegado como fronteira. |
| Linked worktree | Limitação do runtime atual | Em Codex 0.151, o probe real carregou skills mas não o `hooks.json` do worktree com `.git` em arquivo; rode rails de hook a partir de um checkout Git normal até a descoberta ser corrigida. |
| Regras `execpolicy` | Prefixo, não parser de shell | Cobrem o início do comando; flags após remote/ref, comandos compostos e `-C` dependem do hook local. |
| Sandbox do agente filho | Limite herdado | O sandbox do TOML não vence overrides vivos da sessão pai. |

## Operação

```bash
npx @orobsonn/claude-harness init --target codex
```

Revise o diff completo e confie o projeto e a definição dos hooks no Codex antes de depender deles.
Alterar apenas `policy.mjs` não produz nova prova criptográfica de confiança. O padrão é
`workspace-write` com aprovação `on-request`; `danger-full-access` e aprovação `never` não são
perfil de entrega. Depois de mudar o harness, rode novamente o vendor; não edite o runtime gerado.

## Evidência

- A matriz cobre toda superfície de produção uma vez, com hooks e primitivas puras discriminados
  dos motores omitidos.
- Testes de rota, manifestos, skills, contratos puros, regra e hook passam; o vendor é testado em
  instalação nova, ativação mínima de configuração, memória não destrutiva e segunda execução idempotente.
- `codex --strict-config exec --sandbox read-only` aceitou o fixture vendorizado em Codex 0.151.0.
