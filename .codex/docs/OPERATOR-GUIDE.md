# Guia do operador — Codex Delivery Harness

## O que é instalado

O vendor instala agentes em `.codex/agents/`, hooks e regras em `.codex/`,
skills em `.codex/skills/`, e o bloco de workflow no `AGENTS.md` do
projeto. A fonte versionada é `core/codex/`; nunca edite o runtime vendorizado
para mudar o harness.

Também cria `MEMORY.md` e `kaizen.md` somente quando ausentes. Ambos são
artefatos do projeto, não estado oculto do agente: conhecimento verificado e
sem segredos entra no primeiro; experimentos de melhoria entram no segundo.

## Confiança e segurança

Codex só carrega `.codex/config.toml`, hooks e regras do projeto depois que o
projeto é confiado. Revise a definição em `/hooks` antes de ativá-la. Como a
definição chama `policy.mjs` por caminho, uma mudança só no script não cria uma
nova prova criptográfica de confiança: revise o diff completo do vendor antes
de depender dele. Sem confiança e revisão, o harness não está ativo.

No Codex 0.151, um linked worktree cujo `.git` é um arquivo carregou skills,
mas não carregou o `hooks.json` local no probe real. Para rails de hook, use o
checkout Git normal até o runtime corrigir essa descoberta; não trate o
worktree como protegido só porque as skills aparecem.

O limite de segurança é o sandbox nativo e a política de aprovação do Codex.
O padrão recomendado é `workspace-write` com `on-request`. Não use
`danger-full-access` ou `never` para um workflow de entrega normal.

Hooks são rails: esta instalação cobre somente `Bash`, `apply_patch` e `Agent`.
Ela não afirma cobertura de MCPs, ferramentas hospedadas ou caminhos
especializados que não acionem esses eventos. `PostToolUse` acontece
depois do efeito e nunca o desfaz; ele grava somente um recibo local, sem
injetá-lo como contexto do modelo. Um processo do mesmo usuário, um hook
comprometido ou acesso total não é isolado por este harness.

As regras `execpolicy` do Codex só reconhecem prefixos de tokens. Por isso elas
cobrem `git push --force ...`, `git reset --hard`, limpeza e deploy; a variante
`git push origin main --force` é coberta pelo hook local, não pela regra nativa.

## Papéis e custo

- Inventário mecânico, formatação e coleta estreita: Luna com esforço baixo.
- Execução focada e testes: Terra com esforço médio.
- Plano, adversarial, segurança e ambiguidade sensível: Sol com esforço alto;
  use xhigh somente depois de falha de gate ou caminho sensível.

Olhos são read-only. Mãos usam workspace-write, mas o modo de permissões vivo
do pai é reaplicado aos filhos; portanto o arquivo do agente não substitui a
política da sessão.

## Fluxo

1. O agente principal classifica a solicitação.
2. Para trabalho LIGHT/FULL, ele usa a skill de brainstorming e pede aprovação
   de design antes da implementação.
3. O planner produz plano verificável; adversary e security atacam riscos.
4. Cada mão recebe escopo, modelo e esforço explícitos. TDD é obrigatório:
   vermelho, verde, suíte afetada.
5. O shipper só prepara entrega após testes e revisão.

A autoridade de uma transição deve ser o artefato validado, não uma alegação de
um subagente. Hooks não inferem autoria de papel em `PreToolUse` ou
`PostToolUse`, porque esses payloads não fornecem uma correlação de papel
provada.

O policy hook é deliberadamente estreito: bloqueia variantes de Bash para
segredos e operações remotas/destrutivas, mas não é um deny nativo para leitura
direta de arquivo. Não trate essa prosa ou o hook como substituto do sandbox e
das aprovações do Codex.

## Atualização

Use a skill `harness-lifecycle` ou o CLI de vendor no projeto. O update
preserva os valores já definidos em `.codex/config.toml` e acrescenta apenas
as ativações ausentes de hooks/agentes quando usa a tabela `[features]`. Uma
tabela inline ou chaves `features.*` são tratadas como escolha explícita e ficam
byte a byte preservadas. Após atualizar,
revise o diff completo de hooks e script; se a definição mudou, refaça também
a revisão no fluxo nativo do Codex.

## Skills de operação

| Skill | Quando | O que faz |
|---|---|---|
| `harness-releasing-versions` | Release versionada do produto | Com **release-please**: Conventional Commits na `main` → a action abre `chore(main): release X.Y.Z` → merge gera tag + GitHub Release automaticamente. O fluxo manual é somente fallback sem release-please. |

## Limites adjudicados

A matriz `core/codex/capability-matrix.json` registra cada superfície como
nativa, determinística, prosa, não suportada ou omitida intencionalmente. O
adaptador Orca e a automação VPS Claude-específica não são anunciados como
portados: não há contrato Codex verificado para eles. O motor VPS depreciado
também não é recriado.
