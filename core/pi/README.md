# Pi Harness

Este pacote porta o harness para o Pi. O Orca continua dono da issue, da worktree e do terminal; o Pi executa o fluxo dentro daquela worktree.

## Pré-flight

Na worktree onde o harness foi instalado, rode:

```sh
pi-harness --verify
```

O resultado precisa incluir `"ok":true`, `"runtimeVersion":"0.84.4"` e `"subagentsVersion":"21.2.0"`. Ele não chama modelo nem lê a configuração Pi normal do operador.

## Uso no Orca

Crie ou selecione a worktree da issue no Orca. Depois abra um terminal nela:

```sh
orca terminal create --worktree issue:<numero> --title pi-harness --command "pi-harness --mode json -p 'Execute a issue #<numero> como uma run FULL do harness. A issue é a spec.'"
```

Na primeira execução, autentique o Pi no diretório de runtime do harness com `/login`, ou disponibilize o provedor por variável de ambiente. O launcher não reutiliza a configuração global para evitar que extensões, skills e agentes pessoais alterem a run.

## Progresso do plano

Em uma run FULL, depois da aprovação explícita do plano pelo operador, o Pi registra as tarefas em `harness_plan`. O TUI mostra `Plano 2/5 · atual: Implementar`; tarefas que declaram validação própria adicionam uma segunda linha, por exemplo `Validação 1/2 · atual: Teste de regressão`. O mesmo snapshot aparece no resultado da ferramenta em JSON/headless. O estado acompanha a ramificação atual da sessão; é informativo, não é aprovação, scheduler nem prova de conclusão do código.

## Limites

`harness-*` preserva os papéis do harness. O gate permite somente uma delegação foreground por vez e não aceita role do projeto com o mesmo nome. Isso é controle de workflow; a worktree Orca é a separação de trabalho. Pi roda com as permissões do usuário que o iniciou: não é sandbox de sistema, não isola credenciais nem substitui a política de acesso do Orca.
