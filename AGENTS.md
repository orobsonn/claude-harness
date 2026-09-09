# Claude Harness Source Repository

Este repositório é a fonte e a distribuição do harness. O código canônico vive
em `core/claude-code/`, `core/codex/`, `core/opencode/` e `core/pi/`.

Nunca inicialize, vendorize ou atualize o harness na raiz deste próprio
repositório. As pastas `/.claude/`, `/.codex/`, `/.opencode/` e `/.pi/`
são artefatos gerados exclusivamente para projetos consumidores e não podem ser
commitadas aqui. Para validar o vendor, use os fixtures dos testes ou um
diretório temporário fora do repositório.

Altere sempre a fonte em `core/` e os testes correspondentes. Comunicação com
o operador deve ser curta, em pt-BR e orientada ao resultado.
