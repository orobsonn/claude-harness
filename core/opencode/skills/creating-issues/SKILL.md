---
name: creating-issues
description: "Cria uma issue harness-ready ou um roadmap de issues pequenas, com campos verificáveis e submissão segura pelo GitHub CLI. Use quando o operador pedir para criar issue ou organizar roadmap."
---

# Criando issues

Ao iniciar, diga: "Vou montar a(s) issue(s) no padrão do harness."

Leia primeiro `.opencode/rules/creating-issues.md`. Esta skill aplica esse padrão sem duplicar regras de scheduling.

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
