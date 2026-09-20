# Shadow de fidelidade com Jev

O shadow consulta o Jev em paralelo ao `harness-test-reviewer`, mas não substitui,
aprova, bloqueia nem altera nenhuma etapa da pipeline. O reviewer nativo continua
obrigatório e é a única decisão consumida pelos gates e recibos.

## Ativação

Configure os dois valores no ambiente do processo Pi:

```bash
export HARNESS_JEV_FIDELITY_SHADOW=1
export TYPESAFE_API_KEY='...'
```

O modelo fica preso em `jev-1.13.0`. Sem a flag, nada é enviado. Com a flag e sem
chave, o shadow registra o erro operacional e a pipeline segue normalmente.

## Informação enviada

Uma chamada ocorre somente quando um `harness-test-reviewer` inicia. O estado é
montado a partir de artefatos que o host já congelou para essa revisão:

- `obligation`: task canônica do plano estável;
- `representation`: brief, snapshot e diff de revisão, com limites de tamanho;
- `execution`: comandos e saídas de teste capturados pelo host.

Padrões comuns de chave, token, senha e chave privada são redigidos antes do
envio. A proteção não transforma código arbitrário em conteúdo público: habilite
o shadow apenas em repositórios cuja política permita enviar esse recorte à
TypeSafe. O Jev recebe texto; ele não acessa a VPS nem lê caminhos por conta própria.

## Evidência local

Os arquivos abaixo são criados no projeto consumidor:

```text
.pi/harness/observability/jev-fidelity-shadow.jsonl
.pi/harness/observability/jev-fidelity-shadow-summary.json
```

Não são gravados prompts, diffs, saídas, chave ou resposta textual. O log contém
hash do estado, versão do modelo, probabilidades, confiança, latência, tokens e o
veredito nativo. O resumo expõe:

- pares comparáveis e taxa de concordância;
- `false_approves`: Jev aprovou e o reviewer nativo não;
- `false_rejects`: Jev não aprovou e o reviewer nativo aprovou;
- falhas da API e consumo de tokens.

## Janela inicial de três dias

Três dias são uma boa janela operacional se gerarem volume suficiente. A avaliação
inicial deve exigir pelo menos 30 pares, zero `false_approves`, erros operacionais
abaixo de 5% e inspeção humana de toda discordância. Concordância alta sozinha não
prova que o Jev pode aprovar: os casos precisam incluir testes deliberadamente
fracos, ausência de RED e obrigações sutis.

Mesmo que o resultado seja favorável, promover o Jev a aprovador exige uma mudança
separada, com limiar de confiança versionado, fallback nativo e testes adversariais.
