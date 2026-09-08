# Validação FULL em projeto real

Status: nova prova TUI em execução. Este registro não declara aprovação antes do
término.

- Projeto: `orobsonn/proj-lainny`, [issue #47](https://github.com/orobsonn/proj-lainny/issues/47), já implementada no PR #56.
- Base anterior à implementação: `84b946d5e12b516952c9cdb8696fbab6382ef813`.
- Worktree Orca: `/home/orca/orca/workspaces/proj-lainny/pi-harness-full-lainny-47`.
- Sessão global: `228d1aaf-1bbe-48d3-8c2f-574b7c7485b1`.
- Feature: `escritor-publico-lead-tui`, FULL com `task_pipeline_version: 1`.
- Source: `a5cb415983b106d51182aaaa5babfe7affcbabd8`.
- Bootstrap: `41f63723b50338d20015356a2275e25abcedcf9b`.
- Runtime fixado: `8db003b17cd55d1b3d15353b850743a65e2dd92e722787eb99dc13eb5c870a87`.
- Terminal: `term_3628621d-98c2-48e0-a06a-824e36a93a85`, TUI nativa do Pi.
- Baseline do produto: 699 testes em 80 arquivos, typecheck, audit sem achados e docs-check de três PRDs.
- CI corrente: [3512 testes, 3510 passaram, 0 falharam e 2 foram ignorados](https://github.com/orobsonn/claude-harness/actions/runs/34179909715).

Às 02:42 UTC de 8 de setembro, o processo estava ativo. O gate continha uma spec nova
em draft e o adversary nativo havia sido despachado. Não havia aprovação do plano,
tasks admitidas ou integração. A topologia prevista tem três tasks, que só podem ser
executadas depois dos gates de planejamento.

O smoke no host Orca confirmou a TUI nativa, o PTY e a gravação dos eventos usados pelo
harness. Na run corrente, o terminal foi criado com `surface: background`; houve
navegação de cliente despachada, mas ainda não existe confirmação do usuário de que a
nova TUI foi renderizada em seu cliente. Isso não altera a autoridade dos gates.

A sessão anterior e suas T1/T2 foram encerradas sem integração. As duas worktrees foram
removidas oficialmente; branches, patches e bundle ficaram preservados em
`/tmp/pi-full-lainny-47-old-diagnostics` apenas para diagnóstico. Nenhum receipt, código
ou aprovação antiga será reutilizado.

Os critérios vêm da issue e dos artefatos normativos históricos. Cloudflare, deploy,
push e publicação do produto permanecem fora da prova. Ainda faltam as três tasks,
integração, validação agregada, harvest, olhos finais e aprovação FULL. O estado e as
evidências detalhadas ficam no [relatório de implementação](implementation-report.md).
