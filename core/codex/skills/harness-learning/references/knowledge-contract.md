# Contrato de conhecimento durável

`MEMORY.md` é o índice compacto de conhecimento durável do projeto. `kaizen.md` é a fila de melhorias e experimentos. Ambos são versionados e devem continuar úteis sem o contexto da sessão que os escreveu.

## O que registrar

Registre em `MEMORY.md` somente padrão ou antipadrão não óbvio, verificado e reutilizável. Cada entrada informa fato, evidência (arquivo/comando/decisão) e quando deixa de valer. Mantenha uma linha ou bloco mínimo; não transforme a memória em diário de conversa.

Registre em `kaizen.md` hipótese de melhoria, resultado esperado, menor experimento, custo, risco e condição de promoção para memória. Uma hipótese não vira regra nem implementação automática.

## Limites

Nunca grave segredos, credenciais, PII, conteúdo de `.env`, logs sensíveis ou contexto privado. Não sobrescreva entrada do operador. Não use memória como autoridade para burlar requisitos atuais: código, testes e decisão explícita prevalecem. Antes de promover uma descoberta, tente reproduzi-la e diferencie observação de inferência.

Ao importar memória de outro runtime, preserve proveniência, adapte caminhos ao Codex e descarte qualquer instrução dependente de hook/engine que não exista aqui. A memória deve explicar o limite, não fingir compatibilidade.
