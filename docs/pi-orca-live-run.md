# Run live: Pi dentro do Orca

1. O Orca abre a worktree da issue.
2. No terminal dessa worktree, rode `pi-harness --verify`.
3. Inicie `pi-harness --mode json -p "Execute a issue #N como uma run FULL do harness. A issue é a spec."`.
4. Guarde o transcript JSON e verifique que ele contém triagem, plano, execução/testes, revisão independente e evidência final.

O provider do Pi é autenticado no runtime do harness, sem reutilizar extensões, skills ou agentes da configuração global.
