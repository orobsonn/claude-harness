---
name: oc-creating-issues
description: "Cria uma issue harness-ready ou um roadmap de issues pequenas — a partir da conversa, de um PRD escrito pelo grill (docs/prd/<slug>.md) ou de um candidato do proposing-deepening (docs/architecture/deepening-candidates.md) — com campos verificáveis e submissão segura pelo GitHub CLI. Issue vinda de candidato a aprofundamento é entrega local: nunca harness:ready, nunca submetida pelo submit-issue.mjs. Use quando o operador pedir para criar issue ou organizar roadmap."
---

# Criando issues

Ao iniciar, diga: "Vou montar a(s) issue(s) no padrão do harness."

Leia primeiro `.opencode/rules/creating-issues.md`. Esta skill aplica esse padrão sem duplicar regras de scheduling.

## Entrada: conversa, PRD do `oc-grill` ou candidato do `oc-proposing-deepening`

A origem é a conversa do operador, um **PRD em `docs/prd/<slug>.md`** escrito pela skill `oc-grill`, ou um **candidato a aprofundamento** em `docs/architecture/deepening-candidates.md` escrito pela skill `oc-proposing-deepening`. Com origem escrita, não reentreviste e não rededuza o conteúdo — mapeie:

| Seção do PRD | Campo do draft |
|---|---|
| `## Requisitos` | `acceptance_criteria` (`#ac-N.M`) |
| `## Quem se beneficia` | `user_journeys` (`#uj-N`) |
| `## Problema` | `summary` — contexto e por que importa |
| `## Fora de escopo` | `scope`, no bloco "Não tocar: ..." (os não-objetivos explícitos) |
| `## Riscos conhecidos` | informa `sensitive` e `priority` |
| `## Decisões travadas` | `resolved_decisions` |
| `## Suposições do modelo` | `summary`, em bloco rotulado como **suposição** — NUNCA em `resolved_decisions` |
| `## Em aberto` | **bloqueia** a fatia dependente — veja abaixo |

| Campo do candidato | Campo do draft |
|---|---|
| `o que fica mais fácil e pra quem` | `user_journeys` (`#uj-N`) |
| `sintoma` + `não fazer nada` | `summary` — contexto e por que importa |
| `fatias` | **uma issue por fatia**, na ordem, via `dependencies` |
| `oráculo independente` | `acceptance_criteria` (`#ac-N.M`) — o oráculo É a verificação |
| `rota: FULL-equivalente` | `size` + nota de revisão cuidadosa/segurança, mesmo com `sensível: não` |
| todo o resto do candidato | `summary`, sob o rótulo de **suposição** — NUNCA em `resolved_decisions` |

**Candidato a aprofundamento é 100% dedução do modelo**, então TUDO nele é suposição. A única decisão travada disponível é o "sim, vale reformar isso" do operador — decisão de FAZER o trabalho, nunca decisão de COMO. E a issue derivada **nunca é `harness:ready`** — veja § Reforma é entrega local.

**Rastreabilidade requisito → critério.** O requisito `N` do PRD vira `#ac-N.M`. Preserve a numeração do PRD para cada critério voltar a um requisito, e cite o PRD de origem (`docs/prd/<slug>.md`) no `summary`. Os requisitos já foram escritos para serem observáveis e verificáveis — carregue-os em substância, não os reinvente nem os afrouxe. Só quebre um requisito em vários `#ac-N.M` quando ele afirmar mais de um efeito observável.

**Decisão e suposição são DOIS blocos, nunca um.** `## Decisões travadas` são do operador: o `adversary-*` a jusante as DEFENDE. `## Suposições do modelo` são deduções do modelo: o adversário precisa continuar LIVRE PARA ATACÁ-LAS. Por isso as decisões vão em `resolved_decisions` (renderizado como "Decisões já resolvidas") e as suposições vão no `summary`, sob rótulo próprio:

```
Suposições do modelo (deduzidas pelo modelo, NÃO decididas pelo operador — atacáveis):
- ...
```

Juntar as duas categorias num campo só é exatamente a falha que este handoff existe para evitar — lava um palpite virando restrição que ninguém a jusante pode contestar.

**`## Em aberto` bloqueia a criação de tudo que depende dele.** Pergunta em aberto é uma decisão que o motor autônomo inventaria às 3h da manhã e merjaria sem supervisão. Toda fatia que depende de um item em aberto **fica de fora deste lote** e continua estacionada no `## Em aberto` do PRD, que é de onde uma próxima sessão de `oc-grill` retoma. Não há caminho "criar inerte" aqui: o `submit-issue.mjs` aplica `harness:ready` sempre, e `harness:queued` / `harness:blocked` são do motor — nunca aplicados à mão. Diga ao operador quais fatias ficaram de fora e qual pergunta segura cada uma.

## Reforma é entrega local — nunca `harness:ready`

Issue vinda de um **candidato a aprofundamento** é criada **sem a label `harness:ready`**. Ela é entregue **localmente, com o operador olhando o resultado**, porque reestruturar código que já funciona não pode merjar sozinho às 3h da manhã. O `cron-a-select` só pega `harness:ready` aberta, então issue sem label é inerte e nunca é despachada.

Consequência operacional aqui: o `submit-issue.mjs` estampa `harness:ready` sempre — portanto **candidato a aprofundamento não passa por ele**. Se o operador quiser um registro de acompanhamento, ele cria à mão, sem label. Não invente label nova e nunca aplique `harness:queued` / `harness:blocked` à mão — são do motor.

Por que isso e não "é só ter cuidado": o eixo de risco de uma reforma é **raio de explosão**, não sensibilidade de domínio — a allowlist de path sensível não enxerga isso. Uma reestruturação grande de código comum, não-sensível e que funciona cairia na cerimônia mais barata e merjaria sem ninguém olhando. Escreva a issue para escrutínio equivalente a FULL e diga ao operador, em pt-br, que ela não vai rodar sozinha.

**PRD não autoriza issue maior.** Um PRD que gera N fatias vira N issues sob a mesma regra de tamanho. "É tudo um PRD só, é tudo o mesmo tema" é coesão de TEMA, não de ENTREGA — a exata racionalização contra a qual a rule já avisa.

## Glossário do projeto

Se existir `CONTEXT.md` na raiz do projeto, use os termos dele **literalmente** no título e no corpo da issue. Não invente vocabulário paralelo e não crie nem edite o arquivo (`oc-surveying-codebase` semeia, o `harvester` mantém).

## Fluxo

1. Confirme o resultado que deve chegar ao usuário. Em sessão interativa, pergunte apenas o que faltar; sem ferramenta de pergunta, faça uma pergunta curta ao operador. Em headless, não bloqueie: registre incertezas no resumo.
2. Separe resultados que podem ser entregues ou revertidos isoladamente. Não crie dependência, ordem ou scheduling que o operador não pediu explicitamente.
3. Monte um JSON por issue com os campos exatos abaixo. Mostre o draft ao operador antes de submeter em sessao interativa.
4. Valide sem publicar: `node .opencode/skills/creating-issues/references/submit-issue.mjs --draft <arquivo.json> --validate-only`.
5. Após autorização explícita, remova `--validate-only` e submeta com o helper nativo. Nunca monte `gh` em string de shell, nunca interpole title/body em comando e nunca use `gh issue create` diretamente.

```json
{
  "title": "[harness] slug-kebab-case",
  "summary": "O que será entregue e por que importa.",
  "user_journeys": ["#uj-1: quem se beneficia e como"],
  "acceptance_criteria": ["#ac-1.1: dado X, quando Y, então ocorre Z observável"],
  "scope": "Pode tocar: ... Não tocar: ...",
  "sensitive": "não",
  "priority": "P1",
  "size": "S",
  "resolved_decisions": "opcional",
  "dependencies": ["Nenhuma."]
}
```

Enums aceitos:

- `sensitive`: `não`, `auth/sessão`, `pagamento/billing`, `dados/PII`, `segredos`, `SQL/migração`
- `priority`: `P0`, `P1`, `P2`
- `size`: `S`, `M`, `L`

Para dependência explicitamente solicitada, use números reais (`"dependencies": ["#12"]`). `Nenhuma.` só é válida como entrada única. Não use placeholders e não infira dependências por proximidade temática.

## Política da label

O helper valida o repo atual contra o `origin` e exige `harness:ready`. Por padrão, label ausente interrompe sem criar nada. Use `--create-label` somente com autorização explícita do operador; isso cria apenas `harness:ready` com a descrição canônica.

## Roadmap

Submeta na ordem necessária apenas para obter os números reais citados pelo pedido. Depois, valide o grafo com o comando de `chain-validate` definido na rule. Nunca crie issue real em testes.
