---
name: creating-issues
description: Cria issues e roadmaps do harness com dependências verificáveis antes de colocá-los na fila.
---

# Criar issues para o Pi Harness

Crie cada issue sem `harness:ready`, usando o form `.github/ISSUE_TEMPLATE/harness-task.yml` ou um corpo equivalente. Se ela não depende de outra issue, preencha `Dependências` com `Nenhuma.`. Se depende, substitua esse texto por um bloco fechado com **números reais** de issues, um por linha:

````markdown
```harness-deps
#123
#124
```
````

Não escreva `depende de: filha 1`, nomes de fases, `#` sem número ou bloco incompleto. Confira que cada `#N` existe e que o roadmap não forma ciclo. Vínculos nativos `blocked by` no GitHub também são respeitados pelo seletor, mas não substituem um bloco válido quando o corpo declara dependências.

Depois de criar a issue, valide o corpo **antes** de aplicar a label:

```bash
node .pi/harness/skills/creating-issues/references/validate-ready.mjs --repo OWNER/REPO --issue N
```

Se o comando retornar `ok:true`, aplique `harness:ready`. Uma predecessora ainda aberta pode permanecer declarada: o seletor manterá a issue em espera até ela fechar. Se a validação falhar, corrija o corpo e repita. Não aplique a label enquanto o metadado estiver inválido.
