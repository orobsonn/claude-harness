# Clóvis — Harness control plane

Módulo opcional para operar vários consumers do Claude Harness por um agente
geral chamado Clóvis. A arquitetura e as fronteiras de autoridade estão em
[`ARCHITECTURE.md`](ARCHITECTURE.md).

Uso local, depois da instalação do pacote:

```bash
harness-control-plane
```

Use `harness-control-plane --help` para ver as poucas opções seguras. Por
padrão, o estado fica em
`$XDG_STATE_HOME/claude-harness/control-plane` ou
`~/.local/state/claude-harness/control-plane`; `HARNESS_CONTROL_HOME` permite
escolher outro diretório absoluto, privado e dedicado.

O launcher cria/usa um home privado e inicia Pi com suas ferramentas nativas.
O agente pode navegar e operar a VPS como uma sessão Pi normal. Cadastro,
descoberta, consultas e ações do Harness passam pela tool `harness_control`;
um projeto citado pelo nome pode ser descoberto, cadastrado e consultado no
mesmo turno quando houver um único candidato.

Uma execução que já estava ativa antes do Clóvis pode ser descoberta por
`discover_runs` e vinculada por `track_run`. O vínculo é durável e observa o
terminal, worktree e `session_id` exatos sem criar ou reiniciar recursos. Como
não é possível injetar retroativamente o bridge numa sessão viva, esse caso é
explicitamente `external-readonly`: acompanha e avisa, mas não encaminha
decisões versionadas nem oferece retomada pelo control plane. Uma instrução
explícita ainda pode ser enviada ao terminal exato por
`send_tracked_run_message`; o recibo comprova `sent`, nunca `applied`.
O portfólio mostra filhos ativos a partir de `child-identity` e dos task workers
canônicos em `task-runs` do Harness. O supervisor ignora a ociosidade do pai
enquanto um planner/reviewer/task worker roda e também ignora animações de
spinner; somente mudança semântica ociosa desperta a conversa.

Pedidos gerais — por exemplo atualizar o Harness vendorizado de um consumer,
atualizar o Pi usado pelo Orca ou executar um merge explicitamente autorizado
— usam as ferramentas nativas, as instruções do repositório e verificação de
pós-condição. Esses fluxos não transformam o agente no pipeline de entrega.
Sem qualificador, “atualize o Pi” aponta sempre para o runtime canônico pinado
do `claude-harness`; não exige projeto e não significa `pi update`. “Pi global”,
“da máquina” ou “do Orca” é o comando distinto para a instalação global.

O produto é uma sessão operacional dedicada, não uma nova plataforma de
orquestração. Na conversa, o operador só escolhe intenção e autoriza ações
reservadas. IDs, locks, reconciliação e pós-condições permanecem internos. Com
a sessão aberta, um observador host-side desperta a conversa apenas para
decisões, interrupções e resultados materiais; ele não produz trabalho.
Ao ativar a implementação autônoma, um único selector canônico já existente é
descoberto e vinculado automaticamente; ambiguidade é reportada e nenhum novo
scheduler é criado.

Nenhum consumer é atualizado automaticamente. Consumers compatíveis precisam
conter `.pi/harness/control-capabilities.json` e são sempre iniciados por
`.pi/harness/pi-harness.mjs` dentro de uma worktree Orca.

Critérios executáveis e roteiro de demonstração: [`ACCEPTANCE.md`](ACCEPTANCE.md).
Matriz requisito → evidência e limite do piloto: [`AUDIT.md`](AUDIT.md).
