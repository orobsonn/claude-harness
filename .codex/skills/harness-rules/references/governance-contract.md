# Contrato de governança e revisão

## Segurança operacional

O sandbox e a aprovação nativos são o limite de segurança. Hooks, regras e prompts são rails complementares: podem falhar, ser ignorados por ferramentas fora do matcher e não desfazem efeitos concluídos. Não apresente esses rails como isolamento de processos do mesmo usuário ou controle de identidade.

Não leia, exiba, copie nem coloque em prompt valores de `.env`, `.dev.vars`, `~/.ssh`, `~/.aws`, credenciais, tokens ou PII. Prefira exemplo, placeholder ou metadado. Toda alteração de permissão, hook, configuração, CI, deploy, segredo, migração ou exclusão recebe revisão de risco explícita.

O rail local bloqueia formas perigosas conhecidas de force push, limpeza, deploy e administração remota do Wrangler. `force-with-lease` é permitido como recuperação mais segura; não transforme proteção específica em bloqueio total. Se uma nova variante puder burlar o rail, primeiro escreva sua regressão.

## Revisão adversarial

Para design ou FULL não trivial, use um revisor independente e somente leitura. Peça que ataque segurança, multi-tenancy/isolation, injeção, PII, escalabilidade, quotas, atomicidade, concorrência, custo, observabilidade e abstração prematura. Não dê ao adversário a implementação como verdade; dê proposta, critérios e ameaças. Classifique cada achado por severidade, reprodução, evidência e ação: corrigir, aceitar explicitamente como risco, ou provar falso positivo.

Revisão “sem achados” não é uma licença. Ela precisa citar escopo inspecionado, testes executados e limites que não pôde verificar. O autor não é o único juiz da própria mudança.

## Git, release e entrega

Não force push, não use limpeza destrutiva e não altere histórico sem autorização explícita e verificação de alvo. Preserve alterações de terceiros. Antes de um commit, confirme diff e testes. Antes de release, sincronize `package.json`, tag e `CHANGELOG.md` no formato Keep a Changelog; release ocorre por marco, não por micro-PR. Nenhum número de versão é inventado a partir de saída ambígua.

PR/review deve separar bloqueadores de sugestões, apontar arquivo/linha, descrever impacto observável e indicar teste ausente. Não aprove mudança que reduz a cobertura de segurança, mascara falha ou anuncia paridade sem prova.

## Política de honestidade

Registre limites como “não suportado” ou “omitido intencionalmente” quando o runtime não oferece contrato verificável. Não recrie motor mutável só para marcar uma caixa: use prosa para julgamento e determinismo apenas na fronteira de alto impacto. Atualize a matriz de capacidade quando uma superfície mudar.
