# Contrato de entrega do Codex Harness

Este contrato porta a lógica de entrega que é comportamento humano verificável;
ele não tenta recriar uma máquina de estados paralela dentro do Codex.

## Entrada e proporção

Classifique antes de agir.

- **QUICK:** pergunta, leitura ou mudança mecânica de até dois arquivos, com risco baixo. Responda ou faça a alteração e rode a checagem mais estreita.
- **LIGHT:** alteração localizada com comportamento observável. Escreva o resultado esperado, faça TDD e mantenha um plano curto no turno.
- **FULL:** arquitetura, segurança, fluxo multi-etapa, dado externo, release ou efeito difícil de reverter. Faça descoberta, design aprovado, plano TDD, revisão adversarial e verificação de fechamento.

Não reduza FULL para LIGHT porque o pedido parece simples. Caminho sensível, permissão, segredo, migração, concorrência e blast radius vencem tamanho.

## Design, plano e TDD

Para LIGHT/FULL, formule problema, resultado do usuário, não-objetivos, restrições e critérios observáveis. Design não aprovado não é autorização para inventar escopo. Um plano deve ter, por etapa: arquivo/área, teste que fica vermelho, implementação mínima, comando de verificação e rollback/risco.

O ciclo de cada etapa é sempre:

1. tornar o teste **red** por um comportamento real ausente;
2. implementar o menor código que o deixe **green**;
3. rodar a suíte afetada e só então avançar;
4. registrar evidência, não a alegação de um agente.

Teste verde pré-existente não prova a mudança. Não esconda falha com skip, mock que não toca a fronteira ou redução do critério de aceitação.

## Gates de integridade sem motor oculto

**ARMED** é o padrão: use quando o gatilho é consequência do design na escala
pretendida, mesmo sem tráfego ou reprodução local. Falta de reprodução,
evidência, escala citada ou entendimento é incerteza; em dúvida, **ARMED**.

**UNARMED** só é permitido se o defeito exigir uma coincidência que não acontece
nem na escala pretendida, com a citação que sustenta essa conclusão e um
observável de **REARM** concreto, existente e verificado falso hoje. UNARMED
não reduz severidade, não apaga o achado e apenas pode estacionar o dispatch de
correção; sem argumento, citação e observável verificado falso, mantenha ARMED.
Depois de escopo, risco, dependência ou observável mudar, faça **REARM**:
revalide o alvo e o teste antes de continuar.

Antes de congelar um plano/teste para execução, faça fidelity-before-freeze:
confira critérios contra o pedido aprovado, arquivos/linhas reais e a closure de
dependências que o teste observa. Registre um hash da closure quando ela for
material; qualquer divergência pede REARM, não uma exceção silenciosa.

Após um fix HIGH, use um adversário fresh-virgin e forte, somente leitura, para
atacar o diff e o teste sem herdar a narrativa do executor. Ele não precisa de
state machine: entrega achados, reprodução e veredito estruturado; qualquer
achado não refutado reabre o plano.

## Delegação e roteamento de modelo

### Coordenação por tarefa no Pi

Quando o host é o Pi e a sessão global aprovada registra
`task_pipeline_version: 1`, o pai global não despacha diretamente test-author,
executor, sniper ou os olhos de implementação. Ele usa `harness_tasks` para:

1. despachar juntas as tasks independentes prontas;
2. observar os handles duráveis sem transformar abort de observação em cancelamento;
3. integrar somente o `expected_head` do resultado verificado;
4. retomar a mesma task/tentativa quando houver feedback.

Uma dependente só entra depois que os recibos das dependências foram integrados.
Cada pai local executa o ciclo TDD nativo completo e devolve captura, freeze,
re-gate e revisões identificados pela sua própria sessão. O pai global preserva
essas identidades, integra os recibos e executa testes, harvest e olhos finais no
HEAD agregado. Uma correção de dependência compartilhada aguarda os descendentes
já admitidos estarem integrados e pausa novos dispatches/integrações até o novo
recibo; depois dela, os testes e olhos finais do conjunto precisam rodar novamente.

`harness_plan` só apresenta progresso e pode mostrar várias tasks `in_progress`.
Ele não substitui o registry nem os recibos de `harness_tasks`. Fora desse modo Pi,
continue usando o dispatch nativo descrito abaixo, sem alterar a coordenação dos
demais hosts.

Antes de criar um subagente, obtenha a rota explícita:

```sh
node .pi/harness/vendor/codex/model-routing.mjs --role <papel> --complexity <low|medium|high|critical>
```

Passe `model`, `reasoning_effort`, escopo e evidência esperada ao dispatch nativo. O sandbox efetivo vem do perfil TOML e da sessão pai; não há campo de dispatch que o substitua. Use Luna/low para inventário mecânico; Terra/medium para execução delimitada; Sol/high para plano, segurança, ambiguidade, adversarial e caminho crítico. xhigh só após uma falha de gate ou incerteza material. Nunca envie segredo, contexto privado desnecessário ou autorização ampla a um filho.

Olhos são somente leitura. Mãos só recebem escrita no workspace quando existe uma etapa aprovada e verificável. Um filho não pode ampliar escopo, aprovar a própria mudança nem substituir sandbox/aprovação da sessão pai.

## Evidência e handoff

Todo resultado entrega: o que mudou, arquivos relevantes, testes/comandos executados e resultado, risco residual e próximo passo seguro. Para uma falha, entregue reprodução mínima e hipótese marcada como hipótese. Um relatório de agente é input; o artefato e a verificação são a autoridade.

Antes de dizer “feito”, execute a verificação proporcional e uma revisão de completude: critérios de aceitação, regressões, diff, segurança, documentação, configuração e resíduos honestos. FULL requer adversarial independente e resposta concreta a cada achado.
