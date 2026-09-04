# Run live: Pi dentro do Orca

1. O Orca abre a worktree da issue.
2. No terminal dessa worktree, rode `node .pi/harness/pi-harness.mjs --verify`.
3. Para headless, inicie `node .pi/harness/pi-harness.mjs --mode json -p "Implemente a issue #N de forma autônoma, seguindo a pipeline padrão de entrega até abrir um PR draft."`. Para TUI, omita `--mode json -p` e passe o mesmo pedido. O harness deriva a spec da issue e a submete à revisão adversarial antes do plano.
4. Guarde o transcript JSON e verifique que ele contém triagem, plano, execução/testes, revisão independente e evidência final.

O login do provedor é compartilhado pelas worktrees do mesmo usuário no host, em `~/.pi/agent/auth.json`. Configuração, extensões, skills, agentes e sessões do harness continuam locais à worktree. Faça o login uma vez como o usuário que executará o Pi; a autenticação de um Mac não comprova autenticação na VPS.

Uma retomada da mesma sessão e worktree usa `node .pi/harness/pi-harness.mjs --harness-resume <session-id> "Continue o plano aprovado até o PR draft."`. O launcher valida identidade, selo da spec e estrutura do plano antes de abrir o arquivo exato da conversa existente; não permite combinar esse comando com outros seletores de sessão/diretório. Ele não declara o plano aprovado nem as tarefas concluídas: o pai precisa conferir a aprovação da versão atual e reconstruir as pendências de revisão/captura pelo histórico e pelos artefatos. Sem prova de aprovação, o plano volta ao plan-reviewer, não ao começo da spec. Uma nova sessão avulsa e uma mudança de host não são comprovadas por esse comando.

Transferência entre Mac e Linux ainda exige procedimento assistido: instalar dependências compatíveis no destino, preservar e validar plano, gates e trabalho, impedir execução simultânea e reconciliar o caminho da sessão. Não copie binários de `.pi/harness/runtime/bin/` entre arquiteturas. Exclua metadados AppleDouble (`._*`) da transferência. Na run da issue 17, esses dois resíduos da cópia causaram falhas reais; a entrega posterior não torna a transferência automática.
