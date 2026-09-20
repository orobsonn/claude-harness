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

## Onde procurar depois da janela

Os arquivos são locais à raiz Git em que o Pi executou. Runs distintas no mesmo
projeto acumulam no mesmo JSONL; worktrees distintas mantêm arquivos distintos:

```text
<projeto-ou-worktree>/.pi/harness/observability/jev-fidelity-shadow.jsonl
<projeto-ou-worktree>/.pi/harness/observability/jev-fidelity-shadow-summary.json
```

Na VPS do Orca, o inventário inicial deve cobrir bases e worktrees. Ajuste ou
acrescente raízes se a instalação usar outros diretórios:

```bash
find "$HOME/orca/projects" "$HOME/orca/workspaces" "$HOME/dev" \
  -path '*/.pi/harness/observability/jev-fidelity-shadow.jsonl' \
  -type f -print
```

Worktrees são descartáveis. Antes de remover qualquer uma criada durante a janela,
copie seu JSONL para um diretório de avaliação fora da worktree, preservando no nome
o projeto e a worktree de origem. Sem isso, apagar uma worktree também apaga suas
amostras. Não concatene o arquivo `summary.json`: ele é derivado e pode ser sempre
recalculado a partir dos JSONL.

## Como consolidar toda a VPS

Com `jq` instalado, o comando abaixo lê todos os eventos, junta previsão e reviewer
nativo pela identidade `(session_id, call_id)` e calcula os números globais sem
gravar código, prompt ou segredo:

```bash
find "$HOME/orca/projects" "$HOME/orca/workspaces" "$HOME/dev" \
  -path '*/.pi/harness/observability/jev-fidelity-shadow.jsonl' \
  -type f -print0 |
xargs -0 jq -s '
  sort_by([.session_id, .call_id])
  | group_by([.session_id, .call_id])
  | map({
      prediction: (map(select(.type == "prediction")) | .[-1]),
      native: (map(select(.type == "native-verdict")) | .[-1])
    })
  | . as $all
  | [$all[] | select(.prediction.status == "ok" and .native.verdict != null)] as $paired
  | {
      predictions_ok: ([$all[] | select(.prediction.status == "ok")] | length),
      prediction_errors: ([$all[] | select(.prediction != null and .prediction.status != "ok")] | length),
      paired_reviews: ($paired | length),
      exact_matches: ([$paired[] | select(.prediction.choice == .native.verdict)] | length),
      false_approves: ([$paired[] | select(.prediction.choice == "APPROVE" and .native.verdict != "APPROVE")] | length),
      false_rejects: ([$paired[] | select(.prediction.choice != "APPROVE" and .native.verdict == "APPROVE")] | length),
      native_distribution: ($paired | group_by(.native.verdict) | map({key: .[0].native.verdict, value: length}) | from_entries),
      input_tokens: ([$all[].prediction.usage.input_tokens // 0] | add // 0),
      output_tokens: ([$all[].prediction.usage.output_tokens // 0] | add // 0),
      average_latency_ms: ([$all[].prediction.latency_ms | select(. != null)] | if length == 0 then null else add / length end)
    }
  | .agreement_rate = (if .paired_reviews == 0 then null else .exact_matches / .paired_reviews end)
  | .error_rate = (if (.predictions_ok + .prediction_errors) == 0 then null else .prediction_errors / (.predictions_ok + .prediction_errors) end)
'
```

Se os JSONL já tiverem sido copiados para um diretório de avaliação, substitua as
raízes do `find` por esse diretório. Não conte o mesmo arquivo original e sua cópia
na mesma consolidação.

## Checklist da avaliação

Registre a versão efetivamente respondida em `model`; não misture versões do Jev na
mesma conclusão. Para a primeira decisão após 72 horas, avalie nesta ordem:

1. **Cobertura operacional:** pelo menos 30 pares, `error_rate < 0.05` e nenhum
   período relevante sem credencial ou API. Três dias sem volume não bastam.
2. **Diversidade:** a `native_distribution` precisa conter casos `REVISE` ou
   `BLOCKED`. Um conjunto composto apenas de aprovações não mede o risco principal.
3. **Segurança da decisão:** `false_approves` deve ser zero. Abra no JSONL cada
   discordância e classifique a causa como evidência ausente, estado truncado,
   pergunta inadequada, erro do Jev ou erro do reviewer nativo.
4. **Utilidade:** use `agreement_rate >= 0.90` como piso exploratório, não como prova
   suficiente. Avalie também latência, tokens e estabilidade das probabilidades.
5. **Calibração:** compare `probabilities.APPROVE` e `confidence` com os resultados
   observados. `confidence` mede a concentração entre as opções, não a correção do
   julgamento nem autorização para agir.
6. **Conjunto adversarial:** antes de qualquer promoção, rode casos rotulados com
   teste fiel, obrigação omitida, assert fraco, ausência de RED, evidência stale e
   evidência insuficiente. A concordância com o reviewer em tráfego natural não
   substitui esse conjunto.

O reviewer nativo é o comparador operacional da janela, não verdade absoluta. Toda
discordância precisa de inspeção humana. A decisão documentada ao final deve ser uma
destas: manter shadow, ajustar estado/pergunta e repetir a janela, experimentar uma
cascata com fallback nativo, ou rejeitar o uso como aprovador.
