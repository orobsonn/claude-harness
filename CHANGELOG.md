# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e o projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.53.7](https://github.com/orobsonn/claude-harness/compare/v0.53.6...v0.53.7) (2026-08-03)


### Bug Fixes

* não reescreve opencode.json sem mudança real ([#623](https://github.com/orobsonn/claude-harness/issues/623)) ([a4912c0](https://github.com/orobsonn/claude-harness/commit/a4912c06ab1250b74801dd206027bc8c22979af3))

## [0.53.6](https://github.com/orobsonn/claude-harness/compare/v0.53.5...v0.53.6) (2026-08-03)


### Bug Fixes

* no-ceremony não prende feature_id no OC ([#620](https://github.com/orobsonn/claude-harness/issues/620)) ([#621](https://github.com/orobsonn/claude-harness/issues/621)) ([8adab05](https://github.com/orobsonn/claude-harness/commit/8adab050d06341e0fa660aef1342ad3fb07c3b6b))

## [0.53.5](https://github.com/orobsonn/claude-harness/compare/v0.53.4...v0.53.5) (2026-08-03)


### Bug Fixes

* preserva modelo do operador no autonomy continue ([#618](https://github.com/orobsonn/claude-harness/issues/618)) ([337856d](https://github.com/orobsonn/claude-harness/commit/337856df174f4178ccbb6be64584fdc98dae66c8))

## [0.53.4](https://github.com/orobsonn/claude-harness/compare/v0.53.3...v0.53.4) (2026-08-03)


### Bug Fixes

* completa sessão OC com freeze de model_strategy ([#616](https://github.com/orobsonn/claude-harness/issues/616)) ([24de21b](https://github.com/orobsonn/claude-harness/commit/24de21b748e069751d989cfbe25889fa30bed57d))

## [0.53.3](https://github.com/orobsonn/claude-harness/compare/v0.53.2...v0.53.3) (2026-08-03)


### Bug Fixes

* mantém entrega autônoma no OpenCode ([#613](https://github.com/orobsonn/claude-harness/issues/613)) ([06f4dae](https://github.com/orobsonn/claude-harness/commit/06f4dae967370145e396ab8ce1add298991912b9))

## [0.53.2](https://github.com/orobsonn/claude-harness/compare/v0.53.1...v0.53.2) (2026-08-02)

### Corrigido

- **oc:** congela `model_strategy.hand_tiers` a partir do routing efetivo do executor, em vez da escada histórica de Ollama.
- **oc:** preserva o snapshot de routing na gravação, no plano vinculado, na reconciliação e no gate de dispatch.
- **oc:** alinha exemplos e descrições dos executores ao roteamento Luna/Terra.

## [0.53.1](https://github.com/orobsonn/claude-harness/compare/v0.53.0...v0.53.1) (2026-08-02)

### Corrigido

- **oc:** normaliza marcador parcial do plano no dispatch nativo, sem descolar o binding canônico.
- **oc:** bloqueia executor/sniper de alterar teste congelado e registra violação real na captura da mão.
- **oc:** classifica esgotamento de passos como capacidade e escala a mão automaticamente.
- **oc:** torna sessão local explicitamente autônoma: só pergunta por decisão que muda o produto; rails, testes, infraestrutura e recuperações seguem com gates.

### Alterado

- **oc:** rota padrão das mãos para OpenAI — Luna nos tiers baixo/médio e Terra no alto.

## [0.53.0](https://github.com/orobsonn/claude-harness/compare/v0.52.0...v0.53.0) (2026-08-02)

### Features

* **oc:** adjudica segundo olho com policy B ([#606](https://github.com/orobsonn/claude-harness/issues/606)) ([faded65](https://github.com/orobsonn/claude-harness/commit/faded65759fbab932a4362d63745c5cb4d1ea365))

### Bug Fixes

* **oc:** remove teto de sessão do planner ([#602](https://github.com/orobsonn/claude-harness/issues/602)) ([#604](https://github.com/orobsonn/claude-harness/issues/604)) ([2644d69](https://github.com/orobsonn/claude-harness/commit/2644d69b3b4968ef0707dc0b865727f00c65f567))

### Refactors

* reconstrói harness OpenCode por fatos ([#608](https://github.com/orobsonn/claude-harness/issues/608)) ([b05d055](https://github.com/orobsonn/claude-harness/commit/b05d055dc2b3104479de5cc5506d14b38a7b64af))

## [0.52.0](https://github.com/orobsonn/claude-harness/compare/v0.51.0...v0.52.0) (2026-07-30)


### Features

* **oc:** avaliador único + second eye opt-in ([#582](https://github.com/orobsonn/claude-harness/issues/582)) ([#595](https://github.com/orobsonn/claude-harness/issues/595)) ([828efda](https://github.com/orobsonn/claude-harness/commit/828efda4dfdb61aa9b9197741292bfd8b96d73ea))
* **oc:** endurece avaliador único ([#598](https://github.com/orobsonn/claude-harness/issues/598)) ([85fc8b4](https://github.com/orobsonn/claude-harness/commit/85fc8b4e609fa2489fbd447371c8e368344c53fd))


### Bug Fixes

* **oc:** commita a migração de permissão e desacopla o teste do arquivo real ([#593](https://github.com/orobsonn/claude-harness/issues/593)) ([831fff2](https://github.com/orobsonn/claude-harness/commit/831fff2996435f5b7eeb25f95408aa6c07756248))
* **oc:** conta rodadas do loop atual do adversary ([#588](https://github.com/orobsonn/claude-harness/issues/588)) ([2c981ae](https://github.com/orobsonn/claude-harness/commit/2c981aea985980e2e0441e8464ae7d679aa5ee3a))
* **oc:** fecha lacunas apontadas nas revisões ([#592](https://github.com/orobsonn/claude-harness/issues/592)) ([8851864](https://github.com/orobsonn/claude-harness/commit/88518640dc39637d2611f7d1d0eb187654a1d9af))
* **oc:** prepara vendoring e routing para poda ([#587](https://github.com/orobsonn/claude-harness/issues/587)) ([89c8ffd](https://github.com/orobsonn/claude-harness/commit/89c8ffd4d4438dbc48017465317da30d0a25b4d2))
* **oc:** restaura baseline de testes no macOS ([#589](https://github.com/orobsonn/claude-harness/issues/589)) ([d369f62](https://github.com/orobsonn/claude-harness/commit/d369f62315bd5d96dd94461ec2bab581623ec7e0))


### Refactors

* **oc:** elimina agentes spawn duplicados ([#596](https://github.com/orobsonn/claude-harness/issues/596)) ([03bda40](https://github.com/orobsonn/claude-harness/commit/03bda4088ca4c4accbddf14c0517e4e1599a00ee))
* **oc:** extrai utilitários genéricos de dual-enforcement ([#580](https://github.com/orobsonn/claude-harness/issues/580)) ([#594](https://github.com/orobsonn/claude-harness/issues/594)) ([29322b2](https://github.com/orobsonn/claude-harness/commit/29322b2173dc64907b29d15c4a80884b0f70b873))
* **oc:** remove bloco dual do plugin ([#597](https://github.com/orobsonn/claude-harness/issues/597)) ([b404538](https://github.com/orobsonn/claude-harness/commit/b40453869a45d4b64023a2980147241e53d297f1))
* **oc:** simplifica accounting para avaliador único ([#599](https://github.com/orobsonn/claude-harness/issues/599)) ([547230d](https://github.com/orobsonn/claude-harness/commit/547230da65c732db418fbd46cd96f3255f9e6f4d))
* **oc:** volta SKILL orchestrating-delivery ao formato CC ([#585](https://github.com/orobsonn/claude-harness/issues/585)) ([#601](https://github.com/orobsonn/claude-harness/issues/601)) ([19d20a3](https://github.com/orobsonn/claude-harness/commit/19d20a3ce1ae0eafba76d3bdf2230afb90c6f40b))

## [0.51.0](https://github.com/orobsonn/claude-harness/compare/v0.50.1...v0.51.0) (2026-07-28)


### Features

* **grill:** integra lavish-axi como review interativo do mockup visual ([#528](https://github.com/orobsonn/claude-harness/issues/528)) ([98de367](https://github.com/orobsonn/claude-harness/commit/98de36754d1f7787e6845815d696ccf5227ac130))


### Bug Fixes

* **merge:** chave de dedup de plan-review para de descartar findings por severidade ([#542](https://github.com/orobsonn/claude-harness/issues/542)) ([a7cde5d](https://github.com/orobsonn/claude-harness/commit/a7cde5d01265562391c4d36502fb2d640a3b87c7)), closes [#531](https://github.com/orobsonn/claude-harness/issues/531)
* **merge:** guard de dedup para de depender de validador externo ([#557](https://github.com/orobsonn/claude-harness/issues/557)) ([e32a033](https://github.com/orobsonn/claude-harness/commit/e32a033d0ad4003208ad67b4ac2c730f60a394cf)), closes [#549](https://github.com/orobsonn/claude-harness/issues/549)
* **oc:** CAP=3 do loop pós-sniper nomeia o contador que a governa ([#561](https://github.com/orobsonn/claude-harness/issues/561)) ([d3b4286](https://github.com/orobsonn/claude-harness/commit/d3b4286e178ccfa70f0c179cc801ae4491d59abd)), closes [#537](https://github.com/orobsonn/claude-harness/issues/537)
* **oc:** captura pós-mão separa mão que recusou de falha transitória ([#558](https://github.com/orobsonn/claude-harness/issues/558)) ([#567](https://github.com/orobsonn/claude-harness/issues/567)) ([514514a](https://github.com/orobsonn/claude-harness/commit/514514ac14557d67c0c1bb013cdef69fc20df1dd))
* **oc:** corrige drift de permissão pós-PR [#495](https://github.com/orobsonn/claude-harness/issues/495) em 4 skills do OpenCode ([#525](https://github.com/orobsonn/claude-harness/issues/525)) ([14e11db](https://github.com/orobsonn/claude-harness/commit/14e11dba6c9eb362d3a1313626e5d499962b5c01))
* **oc:** cria branch de feature antes do primeiro executor, não só no shipper ([#535](https://github.com/orobsonn/claude-harness/issues/535)) ([5f9bb00](https://github.com/orobsonn/claude-harness/commit/5f9bb008e1186d876ef98db5d2ddb8d074a560dd)), closes [#533](https://github.com/orobsonn/claude-harness/issues/533)
* **oc:** desambigua o K=3 de re-dispatch da mão no post-hand capture path ([#556](https://github.com/orobsonn/claude-harness/issues/556)) ([31163c4](https://github.com/orobsonn/claude-harness/commit/31163c4632bad5e20b3a85e91eb2a0982982e8d4)), closes [#538](https://github.com/orobsonn/claude-harness/issues/538)
* **oc:** escada de tier do executor antes da exceção crítica ([#543](https://github.com/orobsonn/claude-harness/issues/543)) ([#555](https://github.com/orobsonn/claude-harness/issues/555)) ([d312a7e](https://github.com/orobsonn/claude-harness/commit/d312a7e30684db4575f1f330e57bdd4eeb7ddd65))
* **oc:** escopa cada stop-rule ao seu loop e libera plan-review convergente ([#550](https://github.com/orobsonn/claude-harness/issues/550)) ([033fd11](https://github.com/orobsonn/claude-harness/commit/033fd1134bf2cd364e4a6fb4e8a8df854423a5b2)), closes [#529](https://github.com/orobsonn/claude-harness/issues/529)
* **oc:** fidelidade do test-author escala pra mão mais forte em vez de matar a run ([#534](https://github.com/orobsonn/claude-harness/issues/534)) ([#548](https://github.com/orobsonn/claude-harness/issues/548)) ([48a3060](https://github.com/orobsonn/claude-harness/commit/48a3060bb899caace7474f51f56ef1900388e493))
* **oc:** loop do spec-adversary declara inline que a CAP=3 nao o governa ([#554](https://github.com/orobsonn/claude-harness/issues/554)) ([3fce487](https://github.com/orobsonn/claude-harness/commit/3fce487a0bfb8eced344e9aceee1d66c3b125ae8)), closes [#541](https://github.com/orobsonn/claude-harness/issues/541)
* **oc:** loop pós-sniper e passo g passam a usar um critério de parada só ([#545](https://github.com/orobsonn/claude-harness/issues/545)) ([#564](https://github.com/orobsonn/claude-harness/issues/564)) ([dea6be8](https://github.com/orobsonn/claude-harness/commit/dea6be86752df6a8226860045e6f4537f5bcb16e))
* **oc:** loop pós-sniper ganha hand mais forte e saída pro regate órfão ([#544](https://github.com/orobsonn/claude-harness/issues/544)) ([#563](https://github.com/orobsonn/claude-harness/issues/563)) ([17d2f12](https://github.com/orobsonn/claude-harness/commit/17d2f122b7099c597673e93d603295b230513e29))
* **oc:** nomeia o teto de sessão do planner no SKILL.md do orchestrating-delivery ([#553](https://github.com/orobsonn/claude-harness/issues/553)) ([4efb81c](https://github.com/orobsonn/claude-harness/commit/4efb81c83e40d16b2f17b8abcbfb2a374927dc14)), closes [#539](https://github.com/orobsonn/claude-harness/issues/539)
* **oc:** número do orçamento de plan-review vira cópia declarada do rail ([#551](https://github.com/orobsonn/claude-harness/issues/551)) ([6ac2eb5](https://github.com/orobsonn/claude-harness/commit/6ac2eb574dfb7c3b47690cec79996b89a0d5e3a7)), closes [#536](https://github.com/orobsonn/claude-harness/issues/536)
* **oc:** obs-hand nao derruba mais a run quando o belt de observabilidade falha ([#547](https://github.com/orobsonn/claude-harness/issues/547)) ([d9baeb7](https://github.com/orobsonn/claude-harness/commit/d9baeb70b9bae5fd29a5663d6a5bd10ac48a440e)), closes [#532](https://github.com/orobsonn/claude-harness/issues/532)
* **oc:** primary failure cap nomeia valor, contador e a isenção de spec-phase ([#562](https://github.com/orobsonn/claude-harness/issues/562)) ([637678d](https://github.com/orobsonn/claude-harness/commit/637678d5d0e9258fc8f57a941ff011c2230d83b7)), closes [#540](https://github.com/orobsonn/claude-harness/issues/540)
* **oc:** resolved_judgments_model_resolved passa a ser validado e a chegar no PR ([#566](https://github.com/orobsonn/claude-harness/issues/566)) ([98ef383](https://github.com/orobsonn/claude-harness/commit/98ef383704b08a0f6ef9bbb4fa4c4dbba879fa44)), closes [#559](https://github.com/orobsonn/claude-harness/issues/559)
* **oc:** segunda estagnação no mesmo achado vira exceção crítica terminal ([#570](https://github.com/orobsonn/claude-harness/issues/570)) ([dd8eaf0](https://github.com/orobsonn/claude-harness/commit/dd8eaf0427d5d43ea48abd56be46ee0669abf7e5)), closes [#565](https://github.com/orobsonn/claude-harness/issues/565)
* **vps:** preserva mtime de eventos derivados ([#530](https://github.com/orobsonn/claude-harness/issues/530)) ([9c6ec8a](https://github.com/orobsonn/claude-harness/commit/9c6ec8ac679d18b62b5b441ff3d456485f504a05))

## [0.50.1](https://github.com/orobsonn/claude-harness/compare/v0.50.0...v0.50.1) (2026-07-27)


### Bug Fixes

* **oc:** version-check.ts derruba a frota inteira — plugin loader do OpenCode 1.18.7 quebra com múltiplos exports ([#523](https://github.com/orobsonn/claude-harness/issues/523)) ([bf9b377](https://github.com/orobsonn/claude-harness/commit/bf9b377b5c6fb4c6f59a948ddcc648abd54241cf))

## [0.50.0](https://github.com/orobsonn/claude-harness/compare/v0.49.8...v0.50.0) (2026-07-27)


### Features

* **oc:** motor de migração de opencode.json entre gerações do harness ([#503](https://github.com/orobsonn/claude-harness/issues/503)) ([5867da7](https://github.com/orobsonn/claude-harness/commit/5867da7052d8f9b9d05759bd5ef546762e0af13a)), closes [#479](https://github.com/orobsonn/claude-harness/issues/479)
* **oc:** nega leitura e edição de arquivo de segredo por config, à prova de sobrescrita ([#492](https://github.com/orobsonn/claude-harness/issues/492)) ([3998416](https://github.com/orobsonn/claude-harness/commit/399841615cda6f1ef240af53b5fb7abccf0c84d7)), closes [#471](https://github.com/orobsonn/claude-harness/issues/471)
* **oc:** remove muralha anti-forgery de bash-decide.mjs, adiciona canal advisory ([#497](https://github.com/orobsonn/claude-harness/issues/497)) ([0753387](https://github.com/orobsonn/claude-harness/commit/07533873d510be8a98413d4d1642fbeaed26ea76)), closes [#475](https://github.com/orobsonn/claude-harness/issues/475)
* **oc:** trava ordem da cadeia de dispatch + sinal de harness desatualizado ([#502](https://github.com/orobsonn/claude-harness/issues/502)) ([a4664ed](https://github.com/orobsonn/claude-harness/commit/a4664ed6c25bfe41977844e3eeb644478d088be1)), closes [#478](https://github.com/orobsonn/claude-harness/issues/478)
* **vps:** feed-per-task-steps — Conformidade/Adversarial/Segurança/Correção cirúrgica/Portões no feed ([#498](https://github.com/orobsonn/claude-harness/issues/498)) ([e86a98c](https://github.com/orobsonn/claude-harness/commit/e86a98cab8fd25d629900d3c51db386e5f142738)), closes [#491](https://github.com/orobsonn/claude-harness/issues/491)


### Bug Fixes

* **cc:** settings.json de projeto vendorizado ganha merge real, não fica só em sidecar órfão ([#507](https://github.com/orobsonn/claude-harness/issues/507)) ([774b882](https://github.com/orobsonn/claude-harness/commit/774b88214b37c852679ebe01f38561b9155aff82))
* **gate-state:** escopa validação de dual-fields ao delta do patch ([#494](https://github.com/orobsonn/claude-harness/issues/494)) ([26f6ed9](https://github.com/orobsonn/claude-harness/commit/26f6ed988262c1d31e85382778647422d7d5e9b0)), closes [#474](https://github.com/orobsonn/claude-harness/issues/474)
* **oc:** alinha o portão de entrega bash do OpenCode ao do Claude Code ([#505](https://github.com/orobsonn/claude-harness/issues/505)) ([5fa444a](https://github.com/orobsonn/claude-harness/commit/5fa444a1925714ff93b4cf717cbb78524606fb56)), closes [#481](https://github.com/orobsonn/claude-harness/issues/481)
* **oc:** condiciona plan-gate ao binding real do planner ([#476](https://github.com/orobsonn/claude-harness/issues/476)) ([#500](https://github.com/orobsonn/claude-harness/issues/500)) ([115185c](https://github.com/orobsonn/claude-harness/commit/115185cc41a6ecfd1d468d48dd37f6c0d405e20f))
* **oc:** corrige claim falsa de doc sobre bypass de barra invertida no denylist ([#521](https://github.com/orobsonn/claude-harness/issues/521)) ([72a4c4d](https://github.com/orobsonn/claude-harness/commit/72a4c4d6f8ee1d121dce70255eabf8883495bd43))
* **oc:** endurece DANGEROUS_BASH_DENYLIST da frota contra bash -c/npx/tar/source ([#517](https://github.com/orobsonn/claude-harness/issues/517)) ([00e6e46](https://github.com/orobsonn/claude-harness/commit/00e6e4633dbba0262c7a1fbd9b45c01464c826e6)), closes [#499](https://github.com/orobsonn/claude-harness/issues/499)
* **oc:** entry-gate do OpenCode vira fail-open como o do Claude Code ([#506](https://github.com/orobsonn/claude-harness/issues/506)) ([54d7fee](https://github.com/orobsonn/claude-harness/commit/54d7feec069f6302bfb586235ce671e9c0a64b24)), closes [#482](https://github.com/orobsonn/claude-harness/issues/482)
* **oc:** fecha bypass do bash denylist via override de agente + choke-point no plugin ([#520](https://github.com/orobsonn/claude-harness/issues/520)) ([07afd98](https://github.com/orobsonn/claude-harness/commit/07afd9802b746aa276c245a449fac0d32151d6fd)), closes [#516](https://github.com/orobsonn/claude-harness/issues/516)
* **oc:** fecha paridade CC nos gates 1/3 e isenta sniper do fidelity rail ([#509](https://github.com/orobsonn/claude-harness/issues/509)) ([d861f67](https://github.com/orobsonn/claude-harness/commit/d861f675857306930f2c574f0e36f9931c172b4d)), closes [#485](https://github.com/orobsonn/claude-harness/issues/485)
* **oc:** gate de dual/plan_verdict sai do dispatch, vira gravação ([#511](https://github.com/orobsonn/claude-harness/issues/511)) ([6ef5edc](https://github.com/orobsonn/claude-harness/commit/6ef5edc2c7d5d8715c5b3d41858285af18bd99ba)), closes [#483](https://github.com/orobsonn/claude-harness/issues/483)
* **oc:** isola HARNESS_OBSERVABILITY_RUN_PATH nos testes do plugin, corta vazamento de eventos falsos no feed real ([#515](https://github.com/orobsonn/claude-harness/issues/515)) ([31a6f82](https://github.com/orobsonn/claude-harness/commit/31a6f8283028e3acf59596b99ea1be6e578323a3)), closes [#490](https://github.com/orobsonn/claude-harness/issues/490)
* **oc:** migra permission.bash da frota antes do enforce + paridade de denylist com CC ([#510](https://github.com/orobsonn/claude-harness/issues/510)) ([6ec32c0](https://github.com/orobsonn/claude-harness/commit/6ec32c0d0fde665c798abc1a2b7f3db4d665404c))
* **oc:** paridade de permissão dos agentes build/planner/plan/security ([#495](https://github.com/orobsonn/claude-harness/issues/495)) ([3771f89](https://github.com/orobsonn/claude-harness/commit/3771f898166bfe71948b4d8fc5b2b933d57676da))
* **oc:** paridade permission.bash com Claude Code + libera force-with-lease ([#504](https://github.com/orobsonn/claude-harness/issues/504)) ([be594ad](https://github.com/orobsonn/claude-harness/commit/be594ada6531988e8c3d5d50292e7cdafddfe31d))
* **oc:** remove command-resolver e tool verify, órfãos após a muralha ([#501](https://github.com/orobsonn/claude-harness/issues/501)) ([903137f](https://github.com/orobsonn/claude-harness/commit/903137f7a21a42650412764f6bdc4e3b2cea5a28)), closes [#480](https://github.com/orobsonn/claude-harness/issues/480)
* **oc:** remove loop de ceremony-recovery e repara ciclo de vida do claim do planner ([#496](https://github.com/orobsonn/claude-harness/issues/496)) ([19e3ba1](https://github.com/orobsonn/claude-harness/commit/19e3ba1a0dae291b63f16398122f10d4df5fcc96)), closes [#477](https://github.com/orobsonn/claude-harness/issues/477)
* **oc:** remove selo HMAC por processo do marker-seal e endurece taskId ([#512](https://github.com/orobsonn/claude-harness/issues/512)) ([5fd7cdb](https://github.com/orobsonn/claude-harness/commit/5fd7cdbda5892c911c862c053e9db67fd7f2127e)), closes [#484](https://github.com/orobsonn/claude-harness/issues/484)
* **oc:** retira permissão legada por conteúdo e garante classify no fix-mode ([#519](https://github.com/orobsonn/claude-harness/issues/519)) ([52ee765](https://github.com/orobsonn/claude-harness/commit/52ee7651b84d8d6086739bd8ae586145c8758adb))

## [0.49.8](https://github.com/orobsonn/claude-harness/compare/v0.49.7...v0.49.8) (2026-07-25)


### Bug Fixes

* **capture:** captura morre com ENOBUFS em repo com node_modules instalado ([#466](https://github.com/orobsonn/claude-harness/issues/466)) ([37d6cfe](https://github.com/orobsonn/claude-harness/commit/37d6cfe5b1573c5f86a72061c8376be065cebc6e))

## [0.49.7](https://github.com/orobsonn/claude-harness/compare/v0.49.6...v0.49.7) (2026-07-25)


### Bug Fixes

* **init:** vendoriza .claude/state/ como ignorado — o estado de run carrega segredo ([#465](https://github.com/orobsonn/claude-harness/issues/465)) ([3ea1dbf](https://github.com/orobsonn/claude-harness/commit/3ea1dbff83c3ee0d8650abb4f13f977bdf878cfe)), closes [#464](https://github.com/orobsonn/claude-harness/issues/464)
* tier do sniper é derivado da severidade, não ecoado pelo olho ([#462](https://github.com/orobsonn/claude-harness/issues/462)) ([2cbcdcf](https://github.com/orobsonn/claude-harness/commit/2cbcdcf129d6190f26bea9455169358c778698c9)), closes [#461](https://github.com/orobsonn/claude-harness/issues/461)

## [0.49.6](https://github.com/orobsonn/claude-harness/compare/v0.49.5...v0.49.6) (2026-07-25)


### Bug Fixes

* **planner:** plano não pode pinar teste que ele mesmo não consegue satisfazer ([#459](https://github.com/orobsonn/claude-harness/issues/459)) ([bc72557](https://github.com/orobsonn/claude-harness/commit/bc72557d0d986e2abea67deccb1955a28fcef88e))

## [0.49.5](https://github.com/orobsonn/claude-harness/compare/v0.49.4...v0.49.5) (2026-07-25)


### Bug Fixes

* **oc:** laço de adversário deixa de congelar a run; quem para é o orquestrador ([#457](https://github.com/orobsonn/claude-harness/issues/457)) ([0d8cafd](https://github.com/orobsonn/claude-harness/commit/0d8cafd683bc199bc710eb0f28478a2ccb1df210)), closes [#456](https://github.com/orobsonn/claude-harness/issues/456)

## [0.49.4](https://github.com/orobsonn/claude-harness/compare/v0.49.3...v0.49.4) (2026-07-25)


### Bug Fixes

* **oc:** plan-review converge até APROVAR em vez de travar no planejamento ([#453](https://github.com/orobsonn/claude-harness/issues/453)) ([05a1579](https://github.com/orobsonn/claude-harness/commit/05a15790c3d9ba644645ab085667ef68cfe7c8f4))

## [0.49.3](https://github.com/orobsonn/claude-harness/compare/v0.49.2...v0.49.3) (2026-07-24)


### Bug Fixes

* **oc:** plan-review segue até APPROVE em vez de parar na 2ª rodada ([#451](https://github.com/orobsonn/claude-harness/issues/451)) ([7408a90](https://github.com/orobsonn/claude-harness/commit/7408a906129a1931e925bfabcad17faf6de3b0c3))

## [0.49.2](https://github.com/orobsonn/claude-harness/compare/v0.49.1...v0.49.2) (2026-07-24)


### Bug Fixes

* **oc:** lane de lifecycle vira agente travado, não prosa ([#447](https://github.com/orobsonn/claude-harness/issues/447)) ([90baa26](https://github.com/orobsonn/claude-harness/commit/90baa2648a6555baefc90076eeaff73c3527e774)), closes [#444](https://github.com/orobsonn/claude-harness/issues/444)
* **oc:** plugin passa a ser o autor do plano canônico ([#449](https://github.com/orobsonn/claude-harness/issues/449)) ([d8d7f07](https://github.com/orobsonn/claude-harness/commit/d8d7f076c1d182623aa006a92f8ed5da8cf68b45))
* **oc:** prefixo oc- no name das skills resolve colisão de catálogo com .claude ([#445](https://github.com/orobsonn/claude-harness/issues/445)) ([#450](https://github.com/orobsonn/claude-harness/issues/450)) ([7ab096a](https://github.com/orobsonn/claude-harness/commit/7ab096a8914ee62e1a9e49fc4bad9f632bd5b531))

## [0.49.1](https://github.com/orobsonn/claude-harness/compare/v0.49.0...v0.49.1) (2026-07-24)


### Bug Fixes

* **oc:** version-check não trava mais o bootstrap da sessão ([#442](https://github.com/orobsonn/claude-harness/issues/442)) ([0e5f7e1](https://github.com/orobsonn/claude-harness/commit/0e5f7e14f10e7a245d51d73330f5ca28d43a6c95))

## [0.49.0](https://github.com/orobsonn/claude-harness/compare/v0.48.2...v0.49.0) (2026-07-24)


### Features

* fase pré-implementação — grill, PRD, glossário CONTEXT.md ([#437](https://github.com/orobsonn/claude-harness/issues/437)) ([3d979e7](https://github.com/orobsonn/claude-harness/commit/3d979e74ac75ac4811cf1163d0d7005679c4b4fe))
* **skills:** proposing-deepening — análise de retrofit arquitetural ([#439](https://github.com/orobsonn/claude-harness/issues/439)) ([3f61a33](https://github.com/orobsonn/claude-harness/commit/3f61a3375ca62df6c501c7c663b5df1630b339b4))

## [0.48.2](https://github.com/orobsonn/claude-harness/compare/v0.48.1...v0.48.2) (2026-07-23)


### Bug Fixes

* **harness:** gate OC não bloqueia source/. fora de posição de comando ([#434](https://github.com/orobsonn/claude-harness/issues/434)) ([468181a](https://github.com/orobsonn/claude-harness/commit/468181ab05f8e3124d0e618fbff9a4c01bbaf537))

## [0.48.1](https://github.com/orobsonn/claude-harness/compare/v0.48.0...v0.48.1) (2026-07-22)


### Bug Fixes

* **harness:** unifica updating-harness no comando npx allowlistado ([#432](https://github.com/orobsonn/claude-harness/issues/432)) ([97da527](https://github.com/orobsonn/claude-harness/commit/97da5276fc4a3ff4caddb904a4c4942d72dd936e))

## [0.48.0](https://github.com/orobsonn/claude-harness/compare/v0.47.1...v0.48.0) (2026-07-22)


### Features

* **opencode:** lane no-ceremony + native tool p/ configuring-model-routing ([#426](https://github.com/orobsonn/claude-harness/issues/426)) ([a3ec3dd](https://github.com/orobsonn/claude-harness/commit/a3ec3dd15dbfff44baecb0b775a16fe88734ee01))
* **opencode:** preset default deriva de fonte única + endurece slots ([#429](https://github.com/orobsonn/claude-harness/issues/429)) ([78e70ee](https://github.com/orobsonn/claude-harness/commit/78e70eed3c41c45725dfbe3bc7b53974bcd54fc3))
* **opencode:** realoca modelos OpenAI por role no template de routing ([#428](https://github.com/orobsonn/claude-harness/issues/428)) ([96c5196](https://github.com/orobsonn/claude-harness/commit/96c519613a705692de7eb5b9c289051ddeb15e03))
* **opencode:** valida modelos do routing contra o catálogo do binário ([#430](https://github.com/orobsonn/claude-harness/issues/430)) ([faaec2c](https://github.com/orobsonn/claude-harness/commit/faaec2ce3a11015512abd6b6339c6baf8ec48157))

## [0.47.1](https://github.com/orobsonn/claude-harness/compare/v0.47.0...v0.47.1) (2026-07-21)


### Bug Fixes

* **opencode:** host-hand-capture poda entradas por-task e não órfã o gate ([#423](https://github.com/orobsonn/claude-harness/issues/423)) ([1d1fab0](https://github.com/orobsonn/claude-harness/commit/1d1fab0c51fa79147b6f945069456fa3c1a8420f))

## [0.47.0](https://github.com/orobsonn/claude-harness/compare/v0.46.0...v0.47.0) (2026-07-20)


### Features

* **opencode:** A5 multitask capture coverage — block half-built LIGHT/FULL ship ([#413](https://github.com/orobsonn/claude-harness/issues/413)) ([da3f77a](https://github.com/orobsonn/claude-harness/commit/da3f77a5c0e99ac6d45eae887cba45ad3bfa254a))
* **opencode:** unified K=3 same-agent retry for every Task role ([#407](https://github.com/orobsonn/claude-harness/issues/407)) ([aae4fea](https://github.com/orobsonn/claude-harness/commit/aae4fea64bfa5e8a6bbd3ba2be974ad6b2034226))


### Bug Fixes

* **opencode:** allow $DIR plan writes; keep oracle/$GS deny ([#411](https://github.com/orobsonn/claude-harness/issues/411)) ([fedb778](https://github.com/orobsonn/claude-harness/commit/fedb778b396e07b50b3c6b3be6b6248845d1947c))
* **opencode:** auto-bind plan + allow $ in quoted heredoc ([#410](https://github.com/orobsonn/claude-harness/issues/410)) ([9ed5dae](https://github.com/orobsonn/claude-harness/commit/9ed5dae7336d863b7bdc549e3fecd06bdbd2da58))
* **opencode:** classify only on top-level build — hands never triage ([#405](https://github.com/orobsonn/claude-harness/issues/405)) ([e0c0131](https://github.com/orobsonn/claude-harness/commit/e0c01316f98f0e7fcd971a00bf0755e6c0f68e23))
* **opencode:** close LIGHT→QUICK escape rails ([#72](https://github.com/orobsonn/claude-harness/issues/72) forensics) ([#403](https://github.com/orobsonn/claude-harness/issues/403)) ([cffe42b](https://github.com/orobsonn/claude-harness/commit/cffe42b92b1e22053404b087ed29a9873ef93325))
* **opencode:** closure loose-ends — provider forensics classes + build prose ([#412](https://github.com/orobsonn/claude-harness/issues/412)) ([25564b6](https://github.com/orobsonn/claude-harness/commit/25564b65524b9e39603aeabe5732d5f298398be9))
* **opencode:** dedupe agent-retry counts per Task callId ([#408](https://github.com/orobsonn/claude-harness/issues/408)) ([12ebaab](https://github.com/orobsonn/claude-harness/commit/12ebaabe14e4c7ebf53dca151a7a861be790cd74))
* **opencode:** OC-native ship/capture — Task hands, not CC spawn ([#409](https://github.com/orobsonn/claude-harness/issues/409)) ([b56e389](https://github.com/orobsonn/claude-harness/commit/b56e389621f5c583704325d16175930907b9fed6))
* **opencode:** planner fallback default + deny LIGHT ship without usable plan ([#404](https://github.com/orobsonn/claude-harness/issues/404)) ([af4dfa5](https://github.com/orobsonn/claude-harness/commit/af4dfa5f1d119b229afa46a0eaffc198231b4f9f))
* **opencode:** planner primary-only — no lease kill, no model fallback ([#406](https://github.com/orobsonn/claude-harness/issues/406)) ([a7ff665](https://github.com/orobsonn/claude-harness/commit/a7ff665b36dfb24a42380e65d62c18024352608b))
* **opencode:** rails headless — claim planner, hand-record e REVISE ([#400](https://github.com/orobsonn/claude-harness/issues/400)) ([d853ab3](https://github.com/orobsonn/claude-harness/commit/d853ab37456330c9d544eed153d1f7aee624fb6d))
* **opencode:** single-load plugins — OC auto-glob, not plugin[] ([#402](https://github.com/orobsonn/claude-harness/issues/402)) ([4407e85](https://github.com/orobsonn/claude-harness/commit/4407e859de90a6cbced5c05b20f436cebc3779f1))

## [0.46.0](https://github.com/orobsonn/claude-harness/compare/v0.45.4...v0.46.0) (2026-07-18)


### Features

* **opencode:** skill configuring-model-routing com apply determinístico ([#396](https://github.com/orobsonn/claude-harness/issues/396)) ([32ea9cb](https://github.com/orobsonn/claude-harness/commit/32ea9cb5cb236668e2ae009fd4134132b24a142c))


### Bug Fixes

* **opencode:** dual REVISE bloqueia executor e dual por fase ([#375](https://github.com/orobsonn/claude-harness/issues/375) [#383](https://github.com/orobsonn/claude-harness/issues/383) [#384](https://github.com/orobsonn/claude-harness/issues/384)) ([#393](https://github.com/orobsonn/claude-harness/issues/393)) ([55a49f7](https://github.com/orobsonn/claude-harness/commit/55a49f7bb49dddcbbad3b5b93238c9e1d7b86df6))
* **opencode:** hand-record no Task e path capture-verified ([#374](https://github.com/orobsonn/claude-harness/issues/374) [#382](https://github.com/orobsonn/claude-harness/issues/382)) ([#391](https://github.com/orobsonn/claude-harness/issues/391)) ([05d6a1e](https://github.com/orobsonn/claude-harness/commit/05d6a1edfcbb7cad1743128808021dc2c88f77d8))
* **opencode:** hardening do apply de model routing ([#397](https://github.com/orobsonn/claude-harness/issues/397)) ([71922e0](https://github.com/orobsonn/claude-harness/commit/71922e001f406fe8a94004290b1aa192996edeee))
* **opencode:** hygiene harvest scope identity e validate-plan ([#378](https://github.com/orobsonn/claude-harness/issues/378)-[#381](https://github.com/orobsonn/claude-harness/issues/381)) ([#395](https://github.com/orobsonn/claude-harness/issues/395)) ([cd095d5](https://github.com/orobsonn/claude-harness/commit/cd095d597ca64f5d2a9027587c7161bd29ad2546))
* **opencode:** regate auto-arm e preconditions de ship ([#377](https://github.com/orobsonn/claude-harness/issues/377) [#385](https://github.com/orobsonn/claude-harness/issues/385)) ([#394](https://github.com/orobsonn/claude-harness/issues/394)) ([9db9c06](https://github.com/orobsonn/claude-harness/commit/9db9c0602f2ed23b819df83a7546c28e4ebed2ba))
* **opencode:** unifica schema de plan e tool validate-plan ([#373](https://github.com/orobsonn/claude-harness/issues/373)) ([#389](https://github.com/orobsonn/claude-harness/issues/389)) ([1deea70](https://github.com/orobsonn/claude-harness/commit/1deea705668db0c273dc75dfbfa416a345963f31))
* **vps:** helper de teste de dispatch acha o comando pelo último arg do tmux ([#392](https://github.com/orobsonn/claude-harness/issues/392)) ([89400ff](https://github.com/orobsonn/claude-harness/commit/89400ff297a54799fe74e22a6068bc2c69bae4f7))

## [0.45.4](https://github.com/orobsonn/claude-harness/compare/v0.45.3...v0.45.4) (2026-07-18)


### Bug Fixes

* **opencode:** baseline B0 adversary prompt e cap malformed ([#386](https://github.com/orobsonn/claude-harness/issues/386)) ([117b4b7](https://github.com/orobsonn/claude-harness/commit/117b4b78fb619a282b79ddc5747e70c5e502bced))
* **vps:** revisão de PR não entra em loop nem revisa PR concorrente ([#387](https://github.com/orobsonn/claude-harness/issues/387)) ([dfecb6e](https://github.com/orobsonn/claude-harness/commit/dfecb6efaf4f4544cf4e85ec9ce1c62245c3e84a))

## [0.45.3](https://github.com/orobsonn/claude-harness/compare/v0.45.2...v0.45.3) (2026-07-17)


### Bug Fixes

* **orchestrating-delivery:** torna a posicao do sniper alcancavel ([#369](https://github.com/orobsonn/claude-harness/issues/369)) ([3e10c13](https://github.com/orobsonn/claude-harness/commit/3e10c13a15bce036b244ac16f47e640c7c1ed1a8)), closes [#362](https://github.com/orobsonn/claude-harness/issues/362)

## [0.45.2](https://github.com/orobsonn/claude-harness/compare/v0.45.1...v0.45.2) (2026-07-16)


### Bug Fixes

* **orchestrating-delivery:** captura para de acusar a papelada do harness ([#364](https://github.com/orobsonn/claude-harness/issues/364)) ([921081d](https://github.com/orobsonn/claude-harness/commit/921081d981190963e1b807449872058468cd6c71)), closes [#362](https://github.com/orobsonn/claude-harness/issues/362)

## [0.45.1](https://github.com/orobsonn/claude-harness/compare/v0.45.0...v0.45.1) (2026-07-16)


### Bug Fixes

* **harness:** trava a mão barata na escada aprovada ([#363](https://github.com/orobsonn/claude-harness/issues/363)) ([8599f05](https://github.com/orobsonn/claude-harness/commit/8599f05d47aa74b537a2af3535be5246498d5a8d)), closes [#361](https://github.com/orobsonn/claude-harness/issues/361)
* **opencode:** separa atualização da cerimônia ([#359](https://github.com/orobsonn/claude-harness/issues/359)) ([1e03d38](https://github.com/orobsonn/claude-harness/commit/1e03d38a068a95a689d6e949dc1371671d2bbc01))

## [0.45.0](https://github.com/orobsonn/claude-harness/compare/v0.44.1...v0.45.0) (2026-07-16)


### Features

* **opencode:** adiciona planejamento conversacional ([#356](https://github.com/orobsonn/claude-harness/issues/356)) ([20dd052](https://github.com/orobsonn/claude-harness/commit/20dd052b52fb1edc9bcd6bf2dcd8ef32133c7138))


### Bug Fixes

* **opencode:** ancora revisão na feature da sessão ([#358](https://github.com/orobsonn/claude-harness/issues/358)) ([475aef4](https://github.com/orobsonn/claude-harness/commit/475aef4bffe047ba5ea3b21368b6b4de060d7b4c))

## [0.44.1](https://github.com/orobsonn/claude-harness/compare/v0.44.0...v0.44.1) (2026-07-15)


### Bug Fixes

* **readme:** usa endpoint estático válido no badge ([#354](https://github.com/orobsonn/claude-harness/issues/354)) ([9a16355](https://github.com/orobsonn/claude-harness/commit/9a163553ae6c2ed863775e753c0f13eab51f6cb7))

## [0.44.0](https://github.com/orobsonn/claude-harness/compare/v0.43.4...v0.44.0) (2026-07-15)


### Features

* **opencode:** adiciona catálogo canônico de revisão ([#344](https://github.com/orobsonn/claude-harness/issues/344)) ([89bdddb](https://github.com/orobsonn/claude-harness/commit/89bdddbb0b02132bf04dfb7b00a5c9dc5bc3d8c3))
* **opencode:** adiciona criação nativa de issues ([#352](https://github.com/orobsonn/claude-harness/issues/352)) ([be8238e](https://github.com/orobsonn/claude-harness/commit/be8238e803c216cf5828f301e99f2d9c8ecb11ff))
* **opencode:** migra roteamento para modelos sem Grok ([#345](https://github.com/orobsonn/claude-harness/issues/345)) ([cd95344](https://github.com/orobsonn/claude-harness/commit/cd95344e97087377f981c90bddfea00e7ced8ed8))
* **opencode:** recupera falhas do planner ([#346](https://github.com/orobsonn/claude-harness/issues/346)) ([f555990](https://github.com/orobsonn/claude-harness/commit/f55599079452275f6ed5437ddd0fa2808f912845))


### Bug Fixes

* corrige URL do badge de release ([#332](https://github.com/orobsonn/claude-harness/issues/332)) ([6f34d71](https://github.com/orobsonn/claude-harness/commit/6f34d71033932508ee9a33378c6375008a2fb2bc))
* **opencode:** contabiliza apenas revisões primárias úteis ([#353](https://github.com/orobsonn/claude-harness/issues/353)) ([c8a71c3](https://github.com/orobsonn/claude-harness/commit/c8a71c34890c11225890af657503dd5540de4148))
* **opencode:** limita escrita ao escopo da mão ([#349](https://github.com/orobsonn/claude-harness/issues/349)) ([36ee88c](https://github.com/orobsonn/claude-harness/commit/36ee88c31a2f616176b99b2caf7edca6cf2169b0))
* **opencode:** recupera comandos negados conhecidos ([#351](https://github.com/orobsonn/claude-harness/issues/351)) ([b98dc15](https://github.com/orobsonn/claude-harness/commit/b98dc15ca8e82597569fccf97ad0102e55ba1e19))
* **opencode:** retoma apenas o contexto da sessão ([#350](https://github.com/orobsonn/claude-harness/issues/350)) ([1415f10](https://github.com/orobsonn/claude-harness/commit/1415f10b4014c2de0d13c60dc430e6e29b89d860))
* **opencode:** retoma cerimônia de forma determinística ([#348](https://github.com/orobsonn/claude-harness/issues/348)) ([bbb885e](https://github.com/orobsonn/claude-harness/commit/bbb885ee7d77d81b5d75181bb81bd9dac1f51dc7))
* **opencode:** vincula cerimônia à identidade confiável ([#347](https://github.com/orobsonn/claude-harness/issues/347)) ([de36569](https://github.com/orobsonn/claude-harness/commit/de3656970db2c19e9d63977e97a390e7ba150cb4))

## [0.43.4](https://github.com/orobsonn/claude-harness/compare/v0.43.3...v0.43.4) (2026-07-13)


### Bug Fixes

* endurece catálogo de agents do OpenCode ([199c7cc](https://github.com/orobsonn/claude-harness/commit/199c7cc135fa8a292a906cd04388c54674dd76f2))
* maos Ollama + catalogo de agents no OpenCode ([#328](https://github.com/orobsonn/claude-harness/issues/328)) ([501f4d5](https://github.com/orobsonn/claude-harness/commit/501f4d550f0649d91753c6ad7f14afcbb479bc85))

## [0.43.3](https://github.com/orobsonn/claude-harness/compare/v0.43.2...v0.43.3) (2026-07-13)


### Bug Fixes

* materializa runtime OC completo no seed do Cron A ([#323](https://github.com/orobsonn/claude-harness/issues/323)) ([2a14441](https://github.com/orobsonn/claude-harness/commit/2a14441a129dfceb232aa810f46891f49672733b))
* seed OC materializa/reescreve paths de plugins ([#315](https://github.com/orobsonn/claude-harness/issues/315)) ([#316](https://github.com/orobsonn/claude-harness/issues/316)) ([3e4537b](https://github.com/orobsonn/claude-harness/commit/3e4537baea355c9aa7b80dfe6d3b69b5529bc0f1))

## [0.43.2](https://github.com/orobsonn/claude-harness/compare/v0.43.1...v0.43.2) (2026-07-13)


### Bug Fixes

* alinha prosa OC com routing e sinais reais ([#307](https://github.com/orobsonn/claude-harness/issues/307)) ([1085b50](https://github.com/orobsonn/claude-harness/commit/1085b50b75acb77f762a59561acd8bbf416fcd2a))
* calibra wall bash OC com carve-out harness ([#306](https://github.com/orobsonn/claude-harness/issues/306)) ([5ea7176](https://github.com/orobsonn/claude-harness/commit/5ea717687281788d743977feb67b874d4985242a)), closes [#300](https://github.com/orobsonn/claude-harness/issues/300)
* capture-verified deixa de falhar em silêncio ([#291](https://github.com/orobsonn/claude-harness/issues/291)) ([#309](https://github.com/orobsonn/claude-harness/issues/309)) ([a769d5e](https://github.com/orobsonn/claude-harness/commit/a769d5ea11b93c46b0638c84c0429bc1397672e8))
* **oc:** paridade de gates scope/eyes/QUICK ([#299](https://github.com/orobsonn/claude-harness/issues/299)) ([#305](https://github.com/orobsonn/claude-harness/issues/305)) ([1373158](https://github.com/orobsonn/claude-harness/commit/1373158be6da9c0a3fbbd4908700e41a34694e35))
* **oc:** sessionId distinto de ceremony no entry-gate ([#298](https://github.com/orobsonn/claude-harness/issues/298)) ([#303](https://github.com/orobsonn/claude-harness/issues/303)) ([66dfaba](https://github.com/orobsonn/claude-harness/commit/66dfaba6dfd0a8ee896c41b3c20f53ee01b9fcbc))
* paridade OC idle-nudge e limpeza oc-data no reaper ([#308](https://github.com/orobsonn/claude-harness/issues/308)) ([0257317](https://github.com/orobsonn/claude-harness/commit/02573178eb420d1f11fcfe16967d8f33cced04a4))

## [0.43.1](https://github.com/orobsonn/claude-harness/compare/v0.43.0...v0.43.1) (2026-07-13)


### Bug Fixes

* **oc:** fecha portabilidade CC→OC que matava cron ([#291](https://github.com/orobsonn/claude-harness/issues/291)) ([#295](https://github.com/orobsonn/claude-harness/issues/295)) ([8c84ff3](https://github.com/orobsonn/claude-harness/commit/8c84ff318e036192649df73a0dc60c7577688930))

## [0.43.0](https://github.com/orobsonn/claude-harness/compare/v0.42.0...v0.43.0) (2026-07-13)


### Features

* **oc:** cinto de observabilidade mid-run → Telegram ([#287](https://github.com/orobsonn/claude-harness/issues/287)) ([9d6d40d](https://github.com/orobsonn/claude-harness/commit/9d6d40d813d929a62ea772be8f609027b5c2c92f))
* **oc:** oc-headless-rails — nudges + permissões headless ([#289](https://github.com/orobsonn/claude-harness/issues/289)) ([2ba1205](https://github.com/orobsonn/claude-harness/commit/2ba12058472a3c1c4f99869997299f6831b49608))
* **oc:** oc-port-closeout — skills parity + auto-merge T14 fail-closed gate ([#290](https://github.com/orobsonn/claude-harness/issues/290)) ([9d63d7a](https://github.com/orobsonn/claude-harness/commit/9d63d7a551d39da5d39db24290560611a517240b))
* **oc:** paridade de prosa CC→OC (triagem investiga antes de classificar) ([#294](https://github.com/orobsonn/claude-harness/issues/294)) ([d21fe5d](https://github.com/orobsonn/claude-harness/commit/d21fe5d20131912fed8716d2597f1d50fa9a7f79))
* **oc:** plan-write-gate live + bash forge wall endurecido ([#292](https://github.com/orobsonn/claude-harness/issues/292)) ([953373c](https://github.com/orobsonn/claude-harness/commit/953373cb6b874ede3cdcaf615e9caf24ec41600d))

## [0.42.0](https://github.com/orobsonn/claude-harness/compare/v0.41.0...v0.42.0) (2026-07-12)


### Features

* add npm publish workflow triggered by release ([#278](https://github.com/orobsonn/claude-harness/issues/278)) ([17cdffb](https://github.com/orobsonn/claude-harness/commit/17cdffb578921bdcb321ce4ad346df65b87795d9))
* **oc:** U2 trilhos completos de delivery bash (paridade CC) ([#281](https://github.com/orobsonn/claude-harness/issues/281)) ([3ed4ad1](https://github.com/orobsonn/claude-harness/commit/3ed4ad1ece7374f1a886c91c5c8ce8998b43c135))


### Bug Fixes

* pipe do prompt headless vai pro runner, nao pro ulimit ([#276](https://github.com/orobsonn/claude-harness/issues/276)) ([2c82f56](https://github.com/orobsonn/claude-harness/commit/2c82f567c1a3c4b7e4150764efe47835f71d05c1))

## [0.41.0](https://github.com/orobsonn/claude-harness/compare/v0.40.0...v0.41.0) (2026-07-12)


### Features

* oc-port-vps-headless T12+T13 (NDJSON oracle + opencode run spawn) ([#273](https://github.com/orobsonn/claude-harness/issues/273)) ([921c993](https://github.com/orobsonn/claude-harness/commit/921c993a7f856d13905d4b3610ae67d5bd797f6b))
* **onboarding:** torna vendoring runtime-aware (Claude Code + OpenCode) ([#272](https://github.com/orobsonn/claude-harness/issues/272)) ([fd1ecd2](https://github.com/orobsonn/claude-harness/commit/fd1ecd2278812117d1dc03d7feb62c986e7e673f))

## [0.40.0](https://github.com/orobsonn/claude-harness/compare/v0.39.0...v0.40.0) (2026-07-12)


### Features

* **hooks:** autoriza fallback sniper via sinal rateLimited no entry-gate ([#269](https://github.com/orobsonn/claude-harness/issues/269)) ([699fef0](https://github.com/orobsonn/claude-harness/commit/699fef09205d55319c8ec22b7c4eed578d3b6e04))
* implement ADR-003 dual enforcement for OC gates (task-3) ([add167c](https://github.com/orobsonn/claude-harness/commit/add167c6dbb40501d69fe6ef36129a65c0259c25))
* implement ADR-003 dual enforcement for OC gates (task-3) ([26ce9a1](https://github.com/orobsonn/claude-harness/commit/26ce9a10b81929d6f4cae1b43b574a3403303af2))

## [0.39.0](https://github.com/orobsonn/claude-harness/compare/v0.38.0...v0.39.0) (2026-07-11)


### Features

* **oc-port:** phase-1 dual runtime + shared core + opencode vendoring + cutover ([#257](https://github.com/orobsonn/claude-harness/issues/257)) — includes `primary_only_failopen` (secondary auth/unavailable yields primary findings only; not full dual coverage) + stop-rule met. All fixes included: gitignore, 3 mediums, 2 boundary, predicate, locked test, vendor sync.
* **vps:** captura motivo de exit em sessões autônomas sem PR ([#261](https://github.com/orobsonn/claude-harness/issues/261)) ([1de8751](https://github.com/orobsonn/claude-harness/commit/1de8751))
* **vps:** guard de spawn de sessão sob pouca memória livre na VPS ([#265](https://github.com/orobsonn/claude-harness/issues/265)) ([0062148](https://github.com/orobsonn/claude-harness/commit/0062148)), closes [#241](https://github.com/orobsonn/claude-harness/issues/241)
* **observability:** checkpoint determinístico do spec-adversary no Telegram ([#267](https://github.com/orobsonn/claude-harness/issues/267)) ([2e06f29](https://github.com/orobsonn/claude-harness/commit/2e06f29)), closes [#260](https://github.com/orobsonn/claude-harness/issues/260)


### Chores

* .gitignore rule for .opencode/plans/
* medium fixes: T5c real (reinject-state), loop-guard dual count (loop-decide + roles), ceremony stamp timing (entry-gate + tests)
* 2 boundary fixes, predicate (isRefuteVehicle in merge-findings), locked test (t5-loop-dual-secondary-no-inc), vendor sync
* merge main post-0.38.0 work into oc-port release line as v0.39.0

## [0.38.0](https://github.com/orobsonn/claude-harness/compare/v0.37.0...v0.38.0) (2026-07-10)


### Features

* **vps:** modo-conserto no re-dispatch de review reprovada (Grupo C) ([#258](https://github.com/orobsonn/claude-harness/issues/258)) ([213306b](https://github.com/orobsonn/claude-harness/commit/213306b748d3cda5e2fb4360963b1374e4cd9a7f)), closes [#249](https://github.com/orobsonn/claude-harness/issues/249)

## [0.37.0](https://github.com/orobsonn/claude-harness/compare/v0.36.1...v0.37.0) (2026-07-10)


### Features

* **hooks:** rails de morte de sessão + teto de timeout da mão (Grupo B) ([#255](https://github.com/orobsonn/claude-harness/issues/255)) ([d51671f](https://github.com/orobsonn/claude-harness/commit/d51671fd723c9e34cbe5952085c3e27364c387be)), closes [#248](https://github.com/orobsonn/claude-harness/issues/248)
* **hooks:** security-rails que destravam a frota — A1 basename + A2 sha-qualified + A3 scope (Grupo A) ([#254](https://github.com/orobsonn/claude-harness/issues/254)) ([b8a7f10](https://github.com/orobsonn/claude-harness/commit/b8a7f103503b8e9e8ef0eddadbcb7aff32ce84a2)), closes [#247](https://github.com/orobsonn/claude-harness/issues/247)
* **orchestrating-delivery:** disciplina de custo de contexto do orquestrador (Grupo D) ([#253](https://github.com/orobsonn/claude-harness/issues/253)) ([acbdfcb](https://github.com/orobsonn/claude-harness/commit/acbdfcb410a9908b24c04ae763aa7d84052107ee)), closes [#250](https://github.com/orobsonn/claude-harness/issues/250)
* **vps:** higiene de efêmeros + timestamp real nos checkpoints (Grupo E) ([#252](https://github.com/orobsonn/claude-harness/issues/252)) ([e50518d](https://github.com/orobsonn/claude-harness/commit/e50518d30c6cd617cdf3b778ffbff6725aa4977d)), closes [#251](https://github.com/orobsonn/claude-harness/issues/251)

## [0.36.1](https://github.com/orobsonn/claude-harness/compare/v0.36.0...v0.36.1) (2026-07-10)


### Bug Fixes

* alinha scripts.test do npm ao glob do CI (core + modules) ([#242](https://github.com/orobsonn/claude-harness/issues/242)) ([75183fd](https://github.com/orobsonn/claude-harness/commit/75183fd03547704213ec843bbaa7e08302572571)), closes [#226](https://github.com/orobsonn/claude-harness/issues/226)
* harvester delega CHANGELOG ao release-please quando configurado ([#244](https://github.com/orobsonn/claude-harness/issues/244)) ([c745e6d](https://github.com/orobsonn/claude-harness/commit/c745e6dfe301a89e95863a846a5c52f010ccbf96)), closes [#231](https://github.com/orobsonn/claude-harness/issues/231)
* reaper poda worktree concluído mesmo com outro run ativo ([#233](https://github.com/orobsonn/claude-harness/issues/233)) ([#245](https://github.com/orobsonn/claude-harness/issues/245)) ([bb1fc03](https://github.com/orobsonn/claude-harness/commit/bb1fc03e1c3e7910abfafd2d4797d35a5e94f9f1))
* **vps:** tópicos de Telegram de issues fechadas não ressurgem mais ([#246](https://github.com/orobsonn/claude-harness/issues/246)) ([3e07c52](https://github.com/orobsonn/claude-harness/commit/3e07c529131c2ef8083968781d60f1c20b5d080b)), closes [#235](https://github.com/orobsonn/claude-harness/issues/235)

## [0.36.0](https://github.com/orobsonn/claude-harness/compare/v0.35.0...v0.36.0) (2026-07-10)


### Features

* **vps:** sweep de retenção que apaga tópicos fechados há mais de 7 dias ([#238](https://github.com/orobsonn/claude-harness/issues/238)) ([c01c740](https://github.com/orobsonn/claude-harness/commit/c01c7405e28adf85218636c7463e0f504af8c9cb)), closes [#178](https://github.com/orobsonn/claude-harness/issues/178)

## [0.35.0](https://github.com/orobsonn/claude-harness/compare/v0.34.0...v0.35.0) (2026-07-09)


### Features

* **vps:** frota multi-repo — cada projeto age no seu próprio repositório ([#236](https://github.com/orobsonn/claude-harness/issues/236)) ([5decc74](https://github.com/orobsonn/claude-harness/commit/5decc744b832a61378958708bae5b37119f6b915))

## [0.34.0](https://github.com/orobsonn/claude-harness/compare/v0.33.0...v0.34.0) (2026-07-09)


### Features

* **agents:** orientação module-relative de path de teste + check de conformidade ([#203](https://github.com/orobsonn/claude-harness/issues/203)) ([dbfc2fd](https://github.com/orobsonn/claude-harness/commit/dbfc2fd842db25c988fc55e7d9b17e574ac623fc))
* **agents:** test-author self-formats output and avoids block-comment footgun ([#148](https://github.com/orobsonn/claude-harness/issues/148)) ([79e6129](https://github.com/orobsonn/claude-harness/commit/79e612927ade8da3d5872ba71d06499d8e65c7f4))
* **chain:** gate de dependência na seleção + lint de DAG (Fatia 2/4) ([#143](https://github.com/orobsonn/claude-harness/issues/143)) ([318a282](https://github.com/orobsonn/claude-harness/commit/318a2824d1db18088024d116d2c04d49ce91be1a))
* **chain:** merge-driven release of dependency-gated roadmap issues ([#142](https://github.com/orobsonn/claude-harness/issues/142)) ([da614a4](https://github.com/orobsonn/claude-harness/commit/da614a4f9939a73dc31a0105c2bd973a5c9b9b89))
* **cheap-hands:** cancela do plano + pintor do capture-hand + escada de modelos Ollama ([#38](https://github.com/orobsonn/claude-harness/issues/38)) ([e1a18e9](https://github.com/orobsonn/claude-harness/commit/e1a18e9346e863a5f0bafb4e16b5feca8f8d8836))
* **ci-release-gate:** geração de CI por projeto + gate de CI verde no release ([#42](https://github.com/orobsonn/claude-harness/issues/42)) ([0216830](https://github.com/orobsonn/claude-harness/commit/0216830e3a70daf28781913ad280da69701c32c8))
* **cli:** progresso em tempo real no npx claude-harness init ([#201](https://github.com/orobsonn/claude-harness/issues/201)) ([37cf1d2](https://github.com/orobsonn/claude-harness/commit/37cf1d239de52adf81ec3ad7e3fdb7ffc8561fbf))
* codex cross-family completo (vendoring portável + security + UX npx) ([#60](https://github.com/orobsonn/claude-harness/issues/60)) ([f0c03c6](https://github.com/orobsonn/claude-harness/commit/f0c03c66a043812dd660254398154b594dfe0587)), closes [#59](https://github.com/orobsonn/claude-harness/issues/59)
* **creating-plans:** consolidate three planner checklist rules ([#93](https://github.com/orobsonn/claude-harness/issues/93), [#94](https://github.com/orobsonn/claude-harness/issues/94), [#98](https://github.com/orobsonn/claude-harness/issues/98)) ([#125](https://github.com/orobsonn/claude-harness/issues/125)) ([0ec5257](https://github.com/orobsonn/claude-harness/commit/0ec5257a3e533af89495598bdb80c00b84cac096))
* **crons:** configurable cadence + live end-to-end scheduler test ([#144](https://github.com/orobsonn/claude-harness/issues/144)) ([65bb523](https://github.com/orobsonn/claude-harness/commit/65bb5235463d69930bd79fb78f68fabc0a644f84))
* disciplinas do ponytail — conserto na raiz + alvos de over-engineering ([#51](https://github.com/orobsonn/claude-harness/issues/51)) ([ba012fd](https://github.com/orobsonn/claude-harness/commit/ba012fd5f285f98069cd1c9b9fe344d7e95fcaa0))
* distribuição do harness — version-check hook + npx init ([#53](https://github.com/orobsonn/claude-harness/issues/53)) ([f347ad5](https://github.com/orobsonn/claude-harness/commit/f347ad53c545f1828b9bb97633aa0f947f479573))
* **entry-gate:** convenção de issue form + advisory não-bloqueante ([#47](https://github.com/orobsonn/claude-harness/issues/47)) ([5b3bcbd](https://github.com/orobsonn/claude-harness/commit/5b3bcbdd39634d911623d5f839e2b747ed5fbdc9))
* **entry-gate:** fail closed on corrupt regate_pending ([#217](https://github.com/orobsonn/claude-harness/issues/217)) ([d27379c](https://github.com/orobsonn/claude-harness/commit/d27379cb968d2c6c1d6b343a5c4b813bbf47fa13))
* **entry-gate:** trava determinística de entrada + recalibra complexity-scorer (v0.2.0) ([#1](https://github.com/orobsonn/claude-harness/issues/1)) ([2cc8d82](https://github.com/orobsonn/claude-harness/commit/2cc8d82f58e22a16e380d4be529a955da7132c3c))
* fase de review independente de PR + fix do done-bug + auto-merge com trava dupla ([#129](https://github.com/orobsonn/claude-harness/issues/129)) ([dd1b088](https://github.com/orobsonn/claude-harness/commit/dd1b088a1b376a33720805624e10db7faa5c826f))
* **harness:** auto-inclui memory de test-infra no dispatch do test-author ([#218](https://github.com/orobsonn/claude-harness/issues/218)) ([6e8520f](https://github.com/orobsonn/claude-harness/commit/6e8520f3f31248d0fa2617b88d755ac529d3c476)), closes [#102](https://github.com/orobsonn/claude-harness/issues/102)
* **harness:** branch/commit delivery rail no push-gate ([#23](https://github.com/orobsonn/claude-harness/issues/23)) ([fabb874](https://github.com/orobsonn/claude-harness/commit/fabb87468cb9d77625e9011577f46cc197ac970f))
* **harness:** check de CLI documentada inerte (doc-driven entry-block) ([#195](https://github.com/orobsonn/claude-harness/issues/195)) ([484953f](https://github.com/orobsonn/claude-harness/commit/484953f821974ad97360402b2c9dd2f385c3fc00))
* **harness:** habilita orquestrador Sonnet com trilhos determinísticos ([#3](https://github.com/orobsonn/claude-harness/issues/3)) ([0f5cbb2](https://github.com/orobsonn/claude-harness/commit/0f5cbb268a5042457df38bc5c5456d4e5233bb1a))
* **harness:** hand_tiers as the only model_strategy shape ([#25](https://github.com/orobsonn/claude-harness/issues/25)) ([3af892a](https://github.com/orobsonn/claude-harness/commit/3af892a93f8167b0c2d4f2d15e1518a5c0696045))
* **harness:** live cheap-hand dispatch + on-disk evidence escape (v0.9.0) ([#27](https://github.com/orobsonn/claude-harness/issues/27)) ([918039f](https://github.com/orobsonn/claude-harness/commit/918039fecec1210ca22e26e0cc04b9ff24cd6160))
* **harness:** rails determinísticos contra desvio de pipeline ([#21](https://github.com/orobsonn/claude-harness/issues/21)) ([d6a0eba](https://github.com/orobsonn/claude-harness/commit/d6a0eba2de544896627c3352cba301d8df862b52))
* **harness:** sniper re-runs frozen contracts before accepting adversary-suggested fix ([#207](https://github.com/orobsonn/claude-harness/issues/207)) ([08dccdd](https://github.com/orobsonn/claude-harness/commit/08dccdda240ba942c2a1620e23351f81347f8284))
* **harness:** strong eyes cheap hands — Ollama hands + deterministic rails (v1) ([#9](https://github.com/orobsonn/claude-harness/issues/9)) ([38ecf19](https://github.com/orobsonn/claude-harness/commit/38ecf19be3e91bd5d6ecd43797eb003ea5ca6018))
* **harvester:** medidor de custo da entrega via ccusage ([#5](https://github.com/orobsonn/claude-harness/issues/5)) ([8d81d4b](https://github.com/orobsonn/claude-harness/commit/8d81d4b819852dedb902978a93e071540c3e5f74))
* **hooks:** agent-idle-nudge PostToolUse[Agent] hook ([#175](https://github.com/orobsonn/claude-harness/issues/175)) ([66d987d](https://github.com/orobsonn/claude-harness/commit/66d987d92c533d93aaf60609b7594a082b842c47))
* implementa o modo headless (Fase A.3, tema ①) ([f8f758b](https://github.com/orobsonn/claude-harness/commit/f8f758bd2823008260c56624952d0c0aa49cc775))
* instalador de crontab por projeto (VPS autônomo) + release v0.21.0 ([#116](https://github.com/orobsonn/claude-harness/issues/116)) ([da1afa4](https://github.com/orobsonn/claude-harness/commit/da1afa49675e7dc9f6cd004015aec3ca76b1a91a))
* notificação Telegram one-way para o motor autônomo por VPS (v0.22.0) ([#118](https://github.com/orobsonn/claude-harness/issues/118)) ([af93950](https://github.com/orobsonn/claude-harness/commit/af9395032fadb04318576caf15ee0a3a43e24524))
* nudge determinístico do 2º olho cross-family (v0.18.0) ([6cc39da](https://github.com/orobsonn/claude-harness/commit/6cc39da22f9c2dddb71d1c0a8a21a55816f39b59))
* **observability:** cron dedicado só-drenar (feed quase ao vivo, ~3min) ([#185](https://github.com/orobsonn/claude-harness/issues/185)) ([8872f64](https://github.com/orobsonn/claude-harness/commit/8872f64bd8ca711e63fd4046a8a66bb917837f0e))
* **observability:** feed curado de notificações Telegram por run ([#166](https://github.com/orobsonn/claude-harness/issues/166)) ([5774841](https://github.com/orobsonn/claude-harness/commit/57748419f2d89b12bee4a194f5a3380491ebc204))
* **orchestrating-delivery:** gate reproduces every declared CI test config ([#168](https://github.com/orobsonn/claude-harness/issues/168)) ([549a983](https://github.com/orobsonn/claude-harness/commit/549a98336be3b6915e7bb174bcbcc135234e0d8f))
* **orchestrating-delivery:** global ~/.claude/.dev.vars fallback for the cheap-hand token ([#18](https://github.com/orobsonn/claude-harness/issues/18)) ([c948eba](https://github.com/orobsonn/claude-harness/commit/c948eba1621899021c2e493268803f09871eec4a))
* **orchestrating-delivery:** per-task adversary rechecks earlier deferred-risk notes ([#187](https://github.com/orobsonn/claude-harness/issues/187)) ([d49e79d](https://github.com/orobsonn/claude-harness/commit/d49e79d552096b4c8804a2a42b492d44efb690df))
* **orchestrating-delivery:** roteia Fable nos gates de fronteira + tabela de model routing ([7f83c69](https://github.com/orobsonn/claude-harness/commit/7f83c69291e90fcbf91ea9d27e9b587ad3d74336))
* **orchestrating-delivery:** shortcut to Claude fallback after 2 consecutive Ollama 429s ([#153](https://github.com/orobsonn/claude-harness/issues/153)) ([3d21bc2](https://github.com/orobsonn/claude-harness/commit/3d21bc2c590b5a31cdbb39c4feed3b42fd22e2c9))
* **orchestrating-delivery:** teto de 15min pras cheap-hands + survive-timeout capture ([#197](https://github.com/orobsonn/claude-harness/issues/197)) ([80ac4e3](https://github.com/orobsonn/claude-harness/commit/80ac4e35a73b6f0bdae78e6e68c2ca934b5f5ede)), closes [#158](https://github.com/orobsonn/claude-harness/issues/158)
* **orchestrating-delivery:** trilhos de relay (fidelity rail + brief-serializer + descriptor-emitter) ([#40](https://github.com/orobsonn/claude-harness/issues/40)) ([2e87b9f](https://github.com/orobsonn/claude-harness/commit/2e87b9f21becd4bd610876ca441f3c0134e5944e))
* padrão de issue harness-ready + labels (issue-driven routines) ([905f885](https://github.com/orobsonn/claude-harness/commit/905f88578007fb58bebce16c10c6d91a3d0f5767))
* paraleliza os olhos de review (fan-out-join) na Phase 2 e no final dual review ([#57](https://github.com/orobsonn/claude-harness/issues/57)) ([9a65d15](https://github.com/orobsonn/claude-harness/commit/9a65d152d587e4ee3e8bfe4d508e5c6449880760))
* popula core/ sanitizado (Fase B) + add-ons RTK/MV ([fa2ed4e](https://github.com/orobsonn/claude-harness/commit/fa2ed4e05c8ab40244ffebd0a6b44026c7602eb0))
* proportional eye routing + conditional re-gate (v0.20.0) ([#115](https://github.com/orobsonn/claude-harness/issues/115)) ([106bf6c](https://github.com/orobsonn/claude-harness/commit/106bf6c48b17c11859b21aeb9421e6c95868f866))
* reescreve initializing-projects vendorando core/ (Fase C, tema ⑧) ([53ad0da](https://github.com/orobsonn/claude-harness/commit/53ad0da685af9f0d6869e35785d1b0d0a620dde8))
* **review:** cross-family fail-open só na ausência genuína, nunca na reprovação ([#186](https://github.com/orobsonn/claude-harness/issues/186)) ([989a11d](https://github.com/orobsonn/claude-harness/commit/989a11da380918cdb1bf182dad59d4a94f40fa56))
* **review:** merge falho por branch BEHIND aciona update-branch em vez de fila manual ([#188](https://github.com/orobsonn/claude-harness/issues/188)) ([ea9bad5](https://github.com/orobsonn/claude-harness/commit/ea9bad5a1ef8a8d4935232033d63051e2357046f))
* **review:** remove tratamento especial de PR que toca o motor do harness ([#191](https://github.com/orobsonn/claude-harness/issues/191)) ([359eec0](https://github.com/orobsonn/claude-harness/commit/359eec0ab901871dc7d0d4dc42dd595ad3841ec3))
* **review:** wire the real cross-family (Codex) actuator + subscription-auth + fail-closed diff + autoMerge rollout lock ([#137](https://github.com/orobsonn/claude-harness/issues/137)) ([f1b839d](https://github.com/orobsonn/claude-harness/commit/f1b839d637a351ff91bff489a41984a7e3e9b5ce))
* setup-vps infere tudo do contexto (digitação mínima) + auto-clone do motor ([#121](https://github.com/orobsonn/claude-harness/issues/121)) ([c61e448](https://github.com/orobsonn/claude-harness/commit/c61e44854ca009a1de3a1cd31c974bc38a259402))
* **skills:** skill creating-issues — procedimento ativo de criação de issue (Fatia 5) ([#145](https://github.com/orobsonn/claude-harness/issues/145)) ([0ff64c9](https://github.com/orobsonn/claude-harness/commit/0ff64c9c958fcbcb171c7637590f8502e2c2598d))
* **skills:** updating-harness — atalho install/update com URL embutida ([#7](https://github.com/orobsonn/claude-harness/issues/7)) ([c5cfb1b](https://github.com/orobsonn/claude-harness/commit/c5cfb1bdd68ae1a493fc0d87e9da5e8d476a3e20))
* **spawn-hand:** wall-clock timeout on the cheap-hand child ([#150](https://github.com/orobsonn/claude-harness/issues/150)) ([c9ea874](https://github.com/orobsonn/claude-harness/commit/c9ea874fce2ff07f6087f77569db9824c27f4fea))
* strong eyes cheap hands v2 — live Ollama dispatch ([#12](https://github.com/orobsonn/claude-harness/issues/12)) ([5bdcce3](https://github.com/orobsonn/claude-harness/commit/5bdcce3e47c410b4278af332942167a12d2a244a))
* **triaging:** adiciona porta QUICK-craft (via rápida pra artefatos visuais) ([#33](https://github.com/orobsonn/claude-harness/issues/33)) ([790d46e](https://github.com/orobsonn/claude-harness/commit/790d46ed3e5a68ecf52da53701d23830a7fa8855))
* VPS autonomous issue delivery ([#113](https://github.com/orobsonn/claude-harness/issues/113)) ([f403370](https://github.com/orobsonn/claude-harness/commit/f40337087770da89daefaa960f4f60fa3533246b))
* **vps:** auto-cura de tópico morto no drain ([#230](https://github.com/orobsonn/claude-harness/issues/230)) ([26dbf96](https://github.com/orobsonn/claude-harness/commit/26dbf96e072355dbad02164110431d1e0da986ef)), closes [#214](https://github.com/orobsonn/claude-harness/issues/214)
* **vps:** auto-merge undraft + gate-machinery carve-out + label mutual-exclusivity ([#151](https://github.com/orobsonn/claude-harness/issues/151)) ([fb0b353](https://github.com/orobsonn/claude-harness/commit/fb0b3530cd2ab17c5f682615339295b4b637f832))
* **vps:** install-crons aceita cadência em minutos (não só horas) ([#211](https://github.com/orobsonn/claude-harness/issues/211)) ([c219f8c](https://github.com/orobsonn/claude-harness/commit/c219f8c4dfc785ed523729fc0130f972a3e1a354))
* **vps:** mecanismo de auto-update blue/green do motor da VPS ([#189](https://github.com/orobsonn/claude-harness/issues/189)) ([b1bf6e6](https://github.com/orobsonn/claude-harness/commit/b1bf6e64d846132ff621dc3d8be83ad7f463407d))
* **vps:** per-run Telegram forum-topic observability + hand_tiers swap ([#159](https://github.com/orobsonn/claude-harness/issues/159)) ([23cb382](https://github.com/orobsonn/claude-harness/commit/23cb382ecf7b8748fd5ea0596539e99ec893e7eb))
* **vps:** PR-review lifecycle in the run topic (keep-open until merge) ([#209](https://github.com/orobsonn/claude-harness/issues/209)) ([ddfbf85](https://github.com/orobsonn/claude-harness/commit/ddfbf854b089cc8a5b28f8a84ce37502fe99f5f4))
* wire the live PR-review actuator (spawnReviewSession) + breaker fix + idempotency ([#132](https://github.com/orobsonn/claude-harness/issues/132)) ([589c35d](https://github.com/orobsonn/claude-harness/commit/589c35df1217e7de045fe364c0cf643c345a3b33))
* wizard npx setup-vps + heartbeat ON por padrão + rename init→setup-local ([#119](https://github.com/orobsonn/claude-harness/issues/119)) ([fabbfb8](https://github.com/orobsonn/claude-harness/commit/fabbfb8fe94a12763de69c0e02b8ea76a22909c9))


### Bug Fixes

* adaptador de test-runner configurável + CLI dos hand helpers ([#62](https://github.com/orobsonn/claude-harness/issues/62)) ([d09caa9](https://github.com/orobsonn/claude-harness/commit/d09caa91662ef3d7d23d33d064e47b8d22061ba0))
* adapter vitest do test-runner ignora logs do vitest-pool-workers ([#68](https://github.com/orobsonn/claude-harness/issues/68)) ([4d3edf3](https://github.com/orobsonn/claude-harness/commit/4d3edf3801e121e3b5ab54d605e9d08c58a38d34))
* **changelog:** remove entrada duplicada de [Unreleased] que já saiu na v0.30.0 ([#196](https://github.com/orobsonn/claude-harness/issues/196)) ([1274b5d](https://github.com/orobsonn/claude-harness/commit/1274b5de5629f0645c6afaf3ff8437bb2470d69a))
* **cheap-hands:** token via OLLAMA_HAND_TOKEN no env sob sandbox + headless roda hands em Claude ([#35](https://github.com/orobsonn/claude-harness/issues/35)) ([0f23ea9](https://github.com/orobsonn/claude-harness/commit/0f23ea98c8f23c3a762f5703ad43780b7087f59c))
* **codex-adversary:** cross-family.mjs falha rápido sem --task/--claude ([#124](https://github.com/orobsonn/claude-harness/issues/124)) ([95afa21](https://github.com/orobsonn/claude-harness/commit/95afa21c0c32a024b2b34aeca6b590dbe03fcc2f))
* corrige os furos da Fase A.2 no core/ (temas ②③④⑤⑥⑦) ([e090dc9](https://github.com/orobsonn/claude-harness/commit/e090dc9dd9005fa14ba7c0b4da4007bb678c4053))
* **cron-dispatch:** resume-mode só reusa branch com PR aberto, não ressuscita órfã ([#182](https://github.com/orobsonn/claude-harness/issues/182)) ([17a8173](https://github.com/orobsonn/claude-harness/commit/17a8173955ec4cfaa346ae987ce68891869a0311))
* **cron-dispatch:** runs autônomos morriam no arranque (P10) + feed com plano falso (P11) ([#169](https://github.com/orobsonn/claude-harness/issues/169)) ([e0c63c0](https://github.com/orobsonn/claude-harness/commit/e0c63c05b329eb80671a677479b7d284c3b4b41b))
* **cross-family:** auth-probe reads codex stderr + review notifies carry project ([#139](https://github.com/orobsonn/claude-harness/issues/139)) ([dbda08c](https://github.com/orobsonn/claude-harness/commit/dbda08c021929b36648a1a703fcb7d5a58a88f70))
* **cross-family:** teste de passthrough não dispara codex real ([#234](https://github.com/orobsonn/claude-harness/issues/234)) ([6a2efc8](https://github.com/orobsonn/claude-harness/commit/6a2efc8dd6fe9f3e66a2d22393e1b174a334c021)), closes [#225](https://github.com/orobsonn/claude-harness/issues/225)
* destrava deadlock do test-author no fidelity-rail (test-author = Agent sonnet) ([#56](https://github.com/orobsonn/claude-harness/issues/56)) ([2c84576](https://github.com/orobsonn/claude-harness/commit/2c845762db3d7e0879bf555a2d5c05ba8cc1d922))
* **dispatch:** normalize isPathCovered to git-pathspec semantics ([#20](https://github.com/orobsonn/claude-harness/issues/20)) ([4967fe1](https://github.com/orobsonn/claude-harness/commit/4967fe147a4c8176e684a69abd535d7e2803784c))
* endurece o gate capture-verified com o run-record real ([#80](https://github.com/orobsonn/claude-harness/issues/80)) ([0e594c4](https://github.com/orobsonn/claude-harness/commit/0e594c4f955a9d3d0bb4c7b217c79d3efbf16525))
* **entry-gate:** base de commits-ahead via origin default, nao @{u} ([#45](https://github.com/orobsonn/claude-harness/issues/45)) ([dec8c38](https://github.com/orobsonn/claude-harness/commit/dec8c382bf6f02b6ea33068c4d9aa814fcfb2207))
* **entry-gate:** guard de CLI robusto a path com espaço/symlink (v0.2.1) ([#2](https://github.com/orobsonn/claude-harness/issues/2)) ([4b5ed62](https://github.com/orobsonn/claude-harness/commit/4b5ed6274df4208d0c7acd513e4aa196a2f60141))
* **entry-gate:** piso protegido cobre o default branch real, nao so main/master ([#49](https://github.com/orobsonn/claude-harness/issues/49)) ([13d692d](https://github.com/orobsonn/claude-harness/commit/13d692de0b83f0e9dc05b817efd50bac3d4db8c7))
* gitignore-escape sweep não trata node_modules/ mais como violação de escopo ([#70](https://github.com/orobsonn/claude-harness/issues/70)) ([67d172d](https://github.com/orobsonn/claude-harness/commit/67d172d3aa45729944774184bf2e40f3073c9df5))
* **harness:** cheap-hand auth resolution e dispatch de testes ([#31](https://github.com/orobsonn/claude-harness/issues/31)) ([c069a05](https://github.com/orobsonn/claude-harness/commit/c069a05add39c382624cfa539b8d0bc948afe524))
* **headless:** ajustes da Fase D (run real no poupix) ([7111fb1](https://github.com/orobsonn/claude-harness/commit/7111fb1e15d451b58d7951f67bda89915f5632cf))
* **headless:** simula o brainstorm via subagentes de exploração ([7d6ee46](https://github.com/orobsonn/claude-harness/commit/7d6ee468533ca3fa6a55df57ea2b1ce49b6f3849))
* **headless:** Workflow obrigatório pra simular o brainstorm (fail-safe) ([01279b7](https://github.com/orobsonn/claude-harness/commit/01279b725996476473bfab135d97994a616e2e91))
* **hooks:** marker stamps persist reliably or fail loudly (stamp-triage exactly-one scan + read-back) ([#146](https://github.com/orobsonn/claude-harness/issues/146)) ([4c41a5f](https://github.com/orobsonn/claude-harness/commit/4c41a5f5d7e8e60dbad0fc663dce87606c1f9216))
* mão executora não tenta redisparar o pipeline do harness ([#77](https://github.com/orobsonn/claude-harness/issues/77)) ([4e97621](https://github.com/orobsonn/claude-harness/commit/4e9762160d6f732545fddb6cb4d0de7fc9952bd1))
* nudge determinístico com o motivo real de falha pré-spawn da mão barata ([#66](https://github.com/orobsonn/claude-harness/issues/66)) ([89fa18b](https://github.com/orobsonn/claude-harness/commit/89fa18b1c3d706c426aa01a3508491fcdb29bae6))
* **obs:** deterministic execution checkpoints in the run feed ([#200](https://github.com/orobsonn/claude-harness/issues/200)) ([8f5afdf](https://github.com/orobsonn/claude-harness/commit/8f5afdfb4a2b154da661c156e73104c245e88dcb))
* **observability:** concordância de plural no feed (1 tarefa, não 1 tarefas) ([#184](https://github.com/orobsonn/claude-harness/issues/184)) ([1a03614](https://github.com/orobsonn/claude-harness/commit/1a036141369a4917eb966d58aa5dc4f6f2b55139))
* **observability:** cron de review também drena o outbox (P7) ([#183](https://github.com/orobsonn/claude-harness/issues/183)) ([da3331f](https://github.com/orobsonn/claude-harness/commit/da3331fd198dcef55bf8185b88fa03c8d09d5cb6))
* **observability:** feed mostra só UMA classificação (dedupe pipeline-type por tipo) ([#173](https://github.com/orobsonn/claude-harness/issues/173)) ([7fa7e18](https://github.com/orobsonn/claude-harness/commit/7fa7e181a8be6b708dff8453338bf8d888998167))
* **observability:** feed Telegram em uma linha, revisões numeradas, emoji spec-adversary, anti-duplicata ([#176](https://github.com/orobsonn/claude-harness/issues/176)) ([af61a15](https://github.com/orobsonn/claude-harness/commit/af61a1594a65dd566f5118539e29c200dcef743b))
* **observability:** grupo global do Telegram só recebe ação/erro, não tagarelice de PR ([#179](https://github.com/orobsonn/claude-harness/issues/179)) ([8aee890](https://github.com/orobsonn/claude-harness/commit/8aee890ca55057932f718a9c48e03acd07e0944f))
* **observability:** marcos spec/plano na ordem certa (emissão session-side) ([#171](https://github.com/orobsonn/claude-harness/issues/171)) ([487a4cd](https://github.com/orobsonn/claude-harness/commit/487a4cd0f07b4e4a37347ef314442f666af042cc))
* **orchestrating-delivery:** exclude harness version-check cache from cheap-hand scope gate ([#147](https://github.com/orobsonn/claude-harness/issues/147)) ([2588413](https://github.com/orobsonn/claude-harness/commit/2588413b6ec358241325f4d932529ed8c7d004f7))
* **orchestrating-delivery:** forbid backgrounding spawn-hand under claude -p ([#136](https://github.com/orobsonn/claude-harness/issues/136)) ([e7cb7fb](https://github.com/orobsonn/claude-harness/commit/e7cb7fb57cf5ff3f4d7066006067b18dbdbfc2d8))
* **orchestrating-delivery:** stamp capturedVerifiedAt inline at dispatch ([#163](https://github.com/orobsonn/claude-harness/issues/163)) ([0a1a58c](https://github.com/orobsonn/claude-harness/commit/0a1a58c626242fbc222872e4c7ec8f194ca306c7)), closes [#89](https://github.com/orobsonn/claude-harness/issues/89)
* pacote npx quebrado (files sem setup-vps.mjs) + crontab estável no setup-vps ([#120](https://github.com/orobsonn/claude-harness/issues/120)) ([09560b8](https://github.com/orobsonn/claude-harness/commit/09560b8256d75bf3a34762d4424db1d0c329dfa4))
* **release:** bump badge de versão do README + skill releasing-versions inclui badge/VERSION no bump ([#37](https://github.com/orobsonn/claude-harness/issues/37)) ([3ebcf22](https://github.com/orobsonn/claude-harness/commit/3ebcf22006ace8fa8b2cb2e55db6642e12793a53))
* remove suggested_sniper_tier (nomes de modelo Claude) do schema do adversary/security ([#73](https://github.com/orobsonn/claude-harness/issues/73)) ([b79dcc6](https://github.com/orobsonn/claude-harness/commit/b79dcc6edb9c8e5572b6a7d547de211407122dba))
* **review-merge:** retry the squash-merge through GitHub mergeability lag ([#140](https://github.com/orobsonn/claude-harness/issues/140)) ([de85ea8](https://github.com/orobsonn/claude-harness/commit/de85ea8654cd9380988109b2e53a862e876e97dc))
* **review:** await review-started notify before the blocking spawn ([#141](https://github.com/orobsonn/claude-harness/issues/141)) ([755e644](https://github.com/orobsonn/claude-harness/commit/755e644bc8eb8ee7b58966801362f0960fa0108e))
* **review:** BLOCKED verdict é terminal por commit — mata o flaky BLOCKED→CLEAN do auto-merge ([#198](https://github.com/orobsonn/claude-harness/issues/198)) ([b2e0f64](https://github.com/orobsonn/claude-harness/commit/b2e0f645d0a695c22e4151d8a0f17c9389c0c449))
* **review:** Codex que não roda vira ausência (fail-open), não bloqueio de auto-merge ([#193](https://github.com/orobsonn/claude-harness/issues/193)) ([18a7d06](https://github.com/orobsonn/claude-harness/commit/18a7d063acee4fbd95c4938a77c3108727ac5fcd))
* **review:** list PRs via headRefOid + notify on start/merge/awaiting-merge ([#134](https://github.com/orobsonn/claude-harness/issues/134)) ([ef11cf6](https://github.com/orobsonn/claude-harness/commit/ef11cf6a481217744e3ffea1e9527b9a4636b660))
* **review:** sessão de revisão que trava não devolve a issue pra re-dispatch ([#192](https://github.com/orobsonn/claude-harness/issues/192)) ([8682c40](https://github.com/orobsonn/claude-harness/commit/8682c404ad9d11ed975987639b21ba78af9c9c9e))
* **spawn-hand:** pre-stamp hasTrustDialogAccepted in the hand ephemeral workspace ([#156](https://github.com/orobsonn/claude-harness/issues/156)) ([aa2a4fc](https://github.com/orobsonn/claude-harness/commit/aa2a4fc884ba023bc16c06587a7bcc88360eef4a))
* **vendor-core:** espelha os módulos vps que os hooks importam ([#164](https://github.com/orobsonn/claude-harness/issues/164)) ([b266379](https://github.com/orobsonn/claude-harness/commit/b266379464ed5c217b1e48a99bbf0fac995131fb))
* **vendoring+observability:** self-check vps deps no vendor-core + [projeto] nos tópicos ([#177](https://github.com/orobsonn/claude-harness/issues/177)) ([6c5b278](https://github.com/orobsonn/claude-harness/commit/6c5b27897e8e186db44dcdb0e8abe0a3afcfde08))
* **vps:** branch fresca do dispatch nasce de origin/main recém-buscado ([#229](https://github.com/orobsonn/claude-harness/issues/229)) ([56623a9](https://github.com/orobsonn/claude-harness/commit/56623a97b6ac51ed6f6159cea007f0ac2f6f8c97)), closes [#213](https://github.com/orobsonn/claude-harness/issues/213)
* **vps:** reaper poda o worktree de uma run já concluída ([#228](https://github.com/orobsonn/claude-harness/issues/228)) ([d6e4f80](https://github.com/orobsonn/claude-harness/commit/d6e4f8079ce8bb6fff61f8251703f1f8223be773))
* **vps:** reconhecer PR por vínculo com issue + 'picked' com resumo ([#126](https://github.com/orobsonn/claude-harness/issues/126)) ([b0dca22](https://github.com/orobsonn/claude-harness/commit/b0dca222a107ae432da3191c1c594eccb5eb4fe1))

## [0.33.0](https://github.com/orobsonn/claude-harness/compare/claude-harness-v0.32.1...claude-harness-v0.33.0) (2026-07-08)


### Features

* **agents:** orientação module-relative de path de teste + check de conformidade ([#203](https://github.com/orobsonn/claude-harness/issues/203)) ([dbfc2fd](https://github.com/orobsonn/claude-harness/commit/dbfc2fd842db25c988fc55e7d9b17e574ac623fc))
* **agents:** test-author self-formats output and avoids block-comment footgun ([#148](https://github.com/orobsonn/claude-harness/issues/148)) ([79e6129](https://github.com/orobsonn/claude-harness/commit/79e612927ade8da3d5872ba71d06499d8e65c7f4))
* **chain:** gate de dependência na seleção + lint de DAG (Fatia 2/4) ([#143](https://github.com/orobsonn/claude-harness/issues/143)) ([318a282](https://github.com/orobsonn/claude-harness/commit/318a2824d1db18088024d116d2c04d49ce91be1a))
* **chain:** merge-driven release of dependency-gated roadmap issues ([#142](https://github.com/orobsonn/claude-harness/issues/142)) ([da614a4](https://github.com/orobsonn/claude-harness/commit/da614a4f9939a73dc31a0105c2bd973a5c9b9b89))
* **cheap-hands:** cancela do plano + pintor do capture-hand + escada de modelos Ollama ([#38](https://github.com/orobsonn/claude-harness/issues/38)) ([e1a18e9](https://github.com/orobsonn/claude-harness/commit/e1a18e9346e863a5f0bafb4e16b5feca8f8d8836))
* **ci-release-gate:** geração de CI por projeto + gate de CI verde no release ([#42](https://github.com/orobsonn/claude-harness/issues/42)) ([0216830](https://github.com/orobsonn/claude-harness/commit/0216830e3a70daf28781913ad280da69701c32c8))
* **cli:** progresso em tempo real no npx claude-harness init ([#201](https://github.com/orobsonn/claude-harness/issues/201)) ([37cf1d2](https://github.com/orobsonn/claude-harness/commit/37cf1d239de52adf81ec3ad7e3fdb7ffc8561fbf))
* codex cross-family completo (vendoring portável + security + UX npx) ([#60](https://github.com/orobsonn/claude-harness/issues/60)) ([f0c03c6](https://github.com/orobsonn/claude-harness/commit/f0c03c66a043812dd660254398154b594dfe0587)), closes [#59](https://github.com/orobsonn/claude-harness/issues/59)
* **creating-plans:** consolidate three planner checklist rules ([#93](https://github.com/orobsonn/claude-harness/issues/93), [#94](https://github.com/orobsonn/claude-harness/issues/94), [#98](https://github.com/orobsonn/claude-harness/issues/98)) ([#125](https://github.com/orobsonn/claude-harness/issues/125)) ([0ec5257](https://github.com/orobsonn/claude-harness/commit/0ec5257a3e533af89495598bdb80c00b84cac096))
* **crons:** configurable cadence + live end-to-end scheduler test ([#144](https://github.com/orobsonn/claude-harness/issues/144)) ([65bb523](https://github.com/orobsonn/claude-harness/commit/65bb5235463d69930bd79fb78f68fabc0a644f84))
* disciplinas do ponytail — conserto na raiz + alvos de over-engineering ([#51](https://github.com/orobsonn/claude-harness/issues/51)) ([ba012fd](https://github.com/orobsonn/claude-harness/commit/ba012fd5f285f98069cd1c9b9fe344d7e95fcaa0))
* distribuição do harness — version-check hook + npx init ([#53](https://github.com/orobsonn/claude-harness/issues/53)) ([f347ad5](https://github.com/orobsonn/claude-harness/commit/f347ad53c545f1828b9bb97633aa0f947f479573))
* **entry-gate:** convenção de issue form + advisory não-bloqueante ([#47](https://github.com/orobsonn/claude-harness/issues/47)) ([5b3bcbd](https://github.com/orobsonn/claude-harness/commit/5b3bcbdd39634d911623d5f839e2b747ed5fbdc9))
* **entry-gate:** fail closed on corrupt regate_pending ([#217](https://github.com/orobsonn/claude-harness/issues/217)) ([d27379c](https://github.com/orobsonn/claude-harness/commit/d27379cb968d2c6c1d6b343a5c4b813bbf47fa13))
* **entry-gate:** trava determinística de entrada + recalibra complexity-scorer (v0.2.0) ([#1](https://github.com/orobsonn/claude-harness/issues/1)) ([2cc8d82](https://github.com/orobsonn/claude-harness/commit/2cc8d82f58e22a16e380d4be529a955da7132c3c))
* fase de review independente de PR + fix do done-bug + auto-merge com trava dupla ([#129](https://github.com/orobsonn/claude-harness/issues/129)) ([dd1b088](https://github.com/orobsonn/claude-harness/commit/dd1b088a1b376a33720805624e10db7faa5c826f))
* **harness:** auto-inclui memory de test-infra no dispatch do test-author ([#218](https://github.com/orobsonn/claude-harness/issues/218)) ([6e8520f](https://github.com/orobsonn/claude-harness/commit/6e8520f3f31248d0fa2617b88d755ac529d3c476)), closes [#102](https://github.com/orobsonn/claude-harness/issues/102)
* **harness:** branch/commit delivery rail no push-gate ([#23](https://github.com/orobsonn/claude-harness/issues/23)) ([fabb874](https://github.com/orobsonn/claude-harness/commit/fabb87468cb9d77625e9011577f46cc197ac970f))
* **harness:** check de CLI documentada inerte (doc-driven entry-block) ([#195](https://github.com/orobsonn/claude-harness/issues/195)) ([484953f](https://github.com/orobsonn/claude-harness/commit/484953f821974ad97360402b2c9dd2f385c3fc00))
* **harness:** habilita orquestrador Sonnet com trilhos determinísticos ([#3](https://github.com/orobsonn/claude-harness/issues/3)) ([0f5cbb2](https://github.com/orobsonn/claude-harness/commit/0f5cbb268a5042457df38bc5c5456d4e5233bb1a))
* **harness:** hand_tiers as the only model_strategy shape ([#25](https://github.com/orobsonn/claude-harness/issues/25)) ([3af892a](https://github.com/orobsonn/claude-harness/commit/3af892a93f8167b0c2d4f2d15e1518a5c0696045))
* **harness:** live cheap-hand dispatch + on-disk evidence escape (v0.9.0) ([#27](https://github.com/orobsonn/claude-harness/issues/27)) ([918039f](https://github.com/orobsonn/claude-harness/commit/918039fecec1210ca22e26e0cc04b9ff24cd6160))
* **harness:** rails determinísticos contra desvio de pipeline ([#21](https://github.com/orobsonn/claude-harness/issues/21)) ([d6a0eba](https://github.com/orobsonn/claude-harness/commit/d6a0eba2de544896627c3352cba301d8df862b52))
* **harness:** sniper re-runs frozen contracts before accepting adversary-suggested fix ([#207](https://github.com/orobsonn/claude-harness/issues/207)) ([08dccdd](https://github.com/orobsonn/claude-harness/commit/08dccdda240ba942c2a1620e23351f81347f8284))
* **harness:** strong eyes cheap hands — Ollama hands + deterministic rails (v1) ([#9](https://github.com/orobsonn/claude-harness/issues/9)) ([38ecf19](https://github.com/orobsonn/claude-harness/commit/38ecf19be3e91bd5d6ecd43797eb003ea5ca6018))
* **harvester:** medidor de custo da entrega via ccusage ([#5](https://github.com/orobsonn/claude-harness/issues/5)) ([8d81d4b](https://github.com/orobsonn/claude-harness/commit/8d81d4b819852dedb902978a93e071540c3e5f74))
* **hooks:** agent-idle-nudge PostToolUse[Agent] hook ([#175](https://github.com/orobsonn/claude-harness/issues/175)) ([66d987d](https://github.com/orobsonn/claude-harness/commit/66d987d92c533d93aaf60609b7594a082b842c47))
* implementa o modo headless (Fase A.3, tema ①) ([f8f758b](https://github.com/orobsonn/claude-harness/commit/f8f758bd2823008260c56624952d0c0aa49cc775))
* instalador de crontab por projeto (VPS autônomo) + release v0.21.0 ([#116](https://github.com/orobsonn/claude-harness/issues/116)) ([da1afa4](https://github.com/orobsonn/claude-harness/commit/da1afa49675e7dc9f6cd004015aec3ca76b1a91a))
* notificação Telegram one-way para o motor autônomo por VPS (v0.22.0) ([#118](https://github.com/orobsonn/claude-harness/issues/118)) ([af93950](https://github.com/orobsonn/claude-harness/commit/af9395032fadb04318576caf15ee0a3a43e24524))
* nudge determinístico do 2º olho cross-family (v0.18.0) ([6cc39da](https://github.com/orobsonn/claude-harness/commit/6cc39da22f9c2dddb71d1c0a8a21a55816f39b59))
* **observability:** cron dedicado só-drenar (feed quase ao vivo, ~3min) ([#185](https://github.com/orobsonn/claude-harness/issues/185)) ([8872f64](https://github.com/orobsonn/claude-harness/commit/8872f64bd8ca711e63fd4046a8a66bb917837f0e))
* **observability:** feed curado de notificações Telegram por run ([#166](https://github.com/orobsonn/claude-harness/issues/166)) ([5774841](https://github.com/orobsonn/claude-harness/commit/57748419f2d89b12bee4a194f5a3380491ebc204))
* **orchestrating-delivery:** gate reproduces every declared CI test config ([#168](https://github.com/orobsonn/claude-harness/issues/168)) ([549a983](https://github.com/orobsonn/claude-harness/commit/549a98336be3b6915e7bb174bcbcc135234e0d8f))
* **orchestrating-delivery:** global ~/.claude/.dev.vars fallback for the cheap-hand token ([#18](https://github.com/orobsonn/claude-harness/issues/18)) ([c948eba](https://github.com/orobsonn/claude-harness/commit/c948eba1621899021c2e493268803f09871eec4a))
* **orchestrating-delivery:** per-task adversary rechecks earlier deferred-risk notes ([#187](https://github.com/orobsonn/claude-harness/issues/187)) ([d49e79d](https://github.com/orobsonn/claude-harness/commit/d49e79d552096b4c8804a2a42b492d44efb690df))
* **orchestrating-delivery:** roteia Fable nos gates de fronteira + tabela de model routing ([7f83c69](https://github.com/orobsonn/claude-harness/commit/7f83c69291e90fcbf91ea9d27e9b587ad3d74336))
* **orchestrating-delivery:** shortcut to Claude fallback after 2 consecutive Ollama 429s ([#153](https://github.com/orobsonn/claude-harness/issues/153)) ([3d21bc2](https://github.com/orobsonn/claude-harness/commit/3d21bc2c590b5a31cdbb39c4feed3b42fd22e2c9))
* **orchestrating-delivery:** teto de 15min pras cheap-hands + survive-timeout capture ([#197](https://github.com/orobsonn/claude-harness/issues/197)) ([80ac4e3](https://github.com/orobsonn/claude-harness/commit/80ac4e35a73b6f0bdae78e6e68c2ca934b5f5ede)), closes [#158](https://github.com/orobsonn/claude-harness/issues/158)
* **orchestrating-delivery:** trilhos de relay (fidelity rail + brief-serializer + descriptor-emitter) ([#40](https://github.com/orobsonn/claude-harness/issues/40)) ([2e87b9f](https://github.com/orobsonn/claude-harness/commit/2e87b9f21becd4bd610876ca441f3c0134e5944e))
* padrão de issue harness-ready + labels (issue-driven routines) ([905f885](https://github.com/orobsonn/claude-harness/commit/905f88578007fb58bebce16c10c6d91a3d0f5767))
* paraleliza os olhos de review (fan-out-join) na Phase 2 e no final dual review ([#57](https://github.com/orobsonn/claude-harness/issues/57)) ([9a65d15](https://github.com/orobsonn/claude-harness/commit/9a65d152d587e4ee3e8bfe4d508e5c6449880760))
* popula core/ sanitizado (Fase B) + add-ons RTK/MV ([fa2ed4e](https://github.com/orobsonn/claude-harness/commit/fa2ed4e05c8ab40244ffebd0a6b44026c7602eb0))
* proportional eye routing + conditional re-gate (v0.20.0) ([#115](https://github.com/orobsonn/claude-harness/issues/115)) ([106bf6c](https://github.com/orobsonn/claude-harness/commit/106bf6c48b17c11859b21aeb9421e6c95868f866))
* reescreve initializing-projects vendorando core/ (Fase C, tema ⑧) ([53ad0da](https://github.com/orobsonn/claude-harness/commit/53ad0da685af9f0d6869e35785d1b0d0a620dde8))
* **review:** cross-family fail-open só na ausência genuína, nunca na reprovação ([#186](https://github.com/orobsonn/claude-harness/issues/186)) ([989a11d](https://github.com/orobsonn/claude-harness/commit/989a11da380918cdb1bf182dad59d4a94f40fa56))
* **review:** merge falho por branch BEHIND aciona update-branch em vez de fila manual ([#188](https://github.com/orobsonn/claude-harness/issues/188)) ([ea9bad5](https://github.com/orobsonn/claude-harness/commit/ea9bad5a1ef8a8d4935232033d63051e2357046f))
* **review:** remove tratamento especial de PR que toca o motor do harness ([#191](https://github.com/orobsonn/claude-harness/issues/191)) ([359eec0](https://github.com/orobsonn/claude-harness/commit/359eec0ab901871dc7d0d4dc42dd595ad3841ec3))
* **review:** wire the real cross-family (Codex) actuator + subscription-auth + fail-closed diff + autoMerge rollout lock ([#137](https://github.com/orobsonn/claude-harness/issues/137)) ([f1b839d](https://github.com/orobsonn/claude-harness/commit/f1b839d637a351ff91bff489a41984a7e3e9b5ce))
* setup-vps infere tudo do contexto (digitação mínima) + auto-clone do motor ([#121](https://github.com/orobsonn/claude-harness/issues/121)) ([c61e448](https://github.com/orobsonn/claude-harness/commit/c61e44854ca009a1de3a1cd31c974bc38a259402))
* **skills:** skill creating-issues — procedimento ativo de criação de issue (Fatia 5) ([#145](https://github.com/orobsonn/claude-harness/issues/145)) ([0ff64c9](https://github.com/orobsonn/claude-harness/commit/0ff64c9c958fcbcb171c7637590f8502e2c2598d))
* **skills:** updating-harness — atalho install/update com URL embutida ([#7](https://github.com/orobsonn/claude-harness/issues/7)) ([c5cfb1b](https://github.com/orobsonn/claude-harness/commit/c5cfb1bdd68ae1a493fc0d87e9da5e8d476a3e20))
* **spawn-hand:** wall-clock timeout on the cheap-hand child ([#150](https://github.com/orobsonn/claude-harness/issues/150)) ([c9ea874](https://github.com/orobsonn/claude-harness/commit/c9ea874fce2ff07f6087f77569db9824c27f4fea))
* strong eyes cheap hands v2 — live Ollama dispatch ([#12](https://github.com/orobsonn/claude-harness/issues/12)) ([5bdcce3](https://github.com/orobsonn/claude-harness/commit/5bdcce3e47c410b4278af332942167a12d2a244a))
* **triaging:** adiciona porta QUICK-craft (via rápida pra artefatos visuais) ([#33](https://github.com/orobsonn/claude-harness/issues/33)) ([790d46e](https://github.com/orobsonn/claude-harness/commit/790d46ed3e5a68ecf52da53701d23830a7fa8855))
* VPS autonomous issue delivery ([#113](https://github.com/orobsonn/claude-harness/issues/113)) ([f403370](https://github.com/orobsonn/claude-harness/commit/f40337087770da89daefaa960f4f60fa3533246b))
* **vps:** auto-merge undraft + gate-machinery carve-out + label mutual-exclusivity ([#151](https://github.com/orobsonn/claude-harness/issues/151)) ([fb0b353](https://github.com/orobsonn/claude-harness/commit/fb0b3530cd2ab17c5f682615339295b4b637f832))
* **vps:** install-crons aceita cadência em minutos (não só horas) ([#211](https://github.com/orobsonn/claude-harness/issues/211)) ([c219f8c](https://github.com/orobsonn/claude-harness/commit/c219f8c4dfc785ed523729fc0130f972a3e1a354))
* **vps:** mecanismo de auto-update blue/green do motor da VPS ([#189](https://github.com/orobsonn/claude-harness/issues/189)) ([b1bf6e6](https://github.com/orobsonn/claude-harness/commit/b1bf6e64d846132ff621dc3d8be83ad7f463407d))
* **vps:** per-run Telegram forum-topic observability + hand_tiers swap ([#159](https://github.com/orobsonn/claude-harness/issues/159)) ([23cb382](https://github.com/orobsonn/claude-harness/commit/23cb382ecf7b8748fd5ea0596539e99ec893e7eb))
* **vps:** PR-review lifecycle in the run topic (keep-open until merge) ([#209](https://github.com/orobsonn/claude-harness/issues/209)) ([ddfbf85](https://github.com/orobsonn/claude-harness/commit/ddfbf854b089cc8a5b28f8a84ce37502fe99f5f4))
* wire the live PR-review actuator (spawnReviewSession) + breaker fix + idempotency ([#132](https://github.com/orobsonn/claude-harness/issues/132)) ([589c35d](https://github.com/orobsonn/claude-harness/commit/589c35df1217e7de045fe364c0cf643c345a3b33))
* wizard npx setup-vps + heartbeat ON por padrão + rename init→setup-local ([#119](https://github.com/orobsonn/claude-harness/issues/119)) ([fabbfb8](https://github.com/orobsonn/claude-harness/commit/fabbfb8fe94a12763de69c0e02b8ea76a22909c9))


### Bug Fixes

* adaptador de test-runner configurável + CLI dos hand helpers ([#62](https://github.com/orobsonn/claude-harness/issues/62)) ([d09caa9](https://github.com/orobsonn/claude-harness/commit/d09caa91662ef3d7d23d33d064e47b8d22061ba0))
* adapter vitest do test-runner ignora logs do vitest-pool-workers ([#68](https://github.com/orobsonn/claude-harness/issues/68)) ([4d3edf3](https://github.com/orobsonn/claude-harness/commit/4d3edf3801e121e3b5ab54d605e9d08c58a38d34))
* **changelog:** remove entrada duplicada de [Unreleased] que já saiu na v0.30.0 ([#196](https://github.com/orobsonn/claude-harness/issues/196)) ([1274b5d](https://github.com/orobsonn/claude-harness/commit/1274b5de5629f0645c6afaf3ff8437bb2470d69a))
* **cheap-hands:** token via OLLAMA_HAND_TOKEN no env sob sandbox + headless roda hands em Claude ([#35](https://github.com/orobsonn/claude-harness/issues/35)) ([0f23ea9](https://github.com/orobsonn/claude-harness/commit/0f23ea98c8f23c3a762f5703ad43780b7087f59c))
* **codex-adversary:** cross-family.mjs falha rápido sem --task/--claude ([#124](https://github.com/orobsonn/claude-harness/issues/124)) ([95afa21](https://github.com/orobsonn/claude-harness/commit/95afa21c0c32a024b2b34aeca6b590dbe03fcc2f))
* corrige os furos da Fase A.2 no core/ (temas ②③④⑤⑥⑦) ([e090dc9](https://github.com/orobsonn/claude-harness/commit/e090dc9dd9005fa14ba7c0b4da4007bb678c4053))
* **cron-dispatch:** resume-mode só reusa branch com PR aberto, não ressuscita órfã ([#182](https://github.com/orobsonn/claude-harness/issues/182)) ([17a8173](https://github.com/orobsonn/claude-harness/commit/17a8173955ec4cfaa346ae987ce68891869a0311))
* **cron-dispatch:** runs autônomos morriam no arranque (P10) + feed com plano falso (P11) ([#169](https://github.com/orobsonn/claude-harness/issues/169)) ([e0c63c0](https://github.com/orobsonn/claude-harness/commit/e0c63c05b329eb80671a677479b7d284c3b4b41b))
* **cross-family:** auth-probe reads codex stderr + review notifies carry project ([#139](https://github.com/orobsonn/claude-harness/issues/139)) ([dbda08c](https://github.com/orobsonn/claude-harness/commit/dbda08c021929b36648a1a703fcb7d5a58a88f70))
* destrava deadlock do test-author no fidelity-rail (test-author = Agent sonnet) ([#56](https://github.com/orobsonn/claude-harness/issues/56)) ([2c84576](https://github.com/orobsonn/claude-harness/commit/2c845762db3d7e0879bf555a2d5c05ba8cc1d922))
* **dispatch:** normalize isPathCovered to git-pathspec semantics ([#20](https://github.com/orobsonn/claude-harness/issues/20)) ([4967fe1](https://github.com/orobsonn/claude-harness/commit/4967fe147a4c8176e684a69abd535d7e2803784c))
* endurece o gate capture-verified com o run-record real ([#80](https://github.com/orobsonn/claude-harness/issues/80)) ([0e594c4](https://github.com/orobsonn/claude-harness/commit/0e594c4f955a9d3d0bb4c7b217c79d3efbf16525))
* **entry-gate:** base de commits-ahead via origin default, nao @{u} ([#45](https://github.com/orobsonn/claude-harness/issues/45)) ([dec8c38](https://github.com/orobsonn/claude-harness/commit/dec8c382bf6f02b6ea33068c4d9aa814fcfb2207))
* **entry-gate:** guard de CLI robusto a path com espaço/symlink (v0.2.1) ([#2](https://github.com/orobsonn/claude-harness/issues/2)) ([4b5ed62](https://github.com/orobsonn/claude-harness/commit/4b5ed6274df4208d0c7acd513e4aa196a2f60141))
* **entry-gate:** piso protegido cobre o default branch real, nao so main/master ([#49](https://github.com/orobsonn/claude-harness/issues/49)) ([13d692d](https://github.com/orobsonn/claude-harness/commit/13d692de0b83f0e9dc05b817efd50bac3d4db8c7))
* gitignore-escape sweep não trata node_modules/ mais como violação de escopo ([#70](https://github.com/orobsonn/claude-harness/issues/70)) ([67d172d](https://github.com/orobsonn/claude-harness/commit/67d172d3aa45729944774184bf2e40f3073c9df5))
* **harness:** cheap-hand auth resolution e dispatch de testes ([#31](https://github.com/orobsonn/claude-harness/issues/31)) ([c069a05](https://github.com/orobsonn/claude-harness/commit/c069a05add39c382624cfa539b8d0bc948afe524))
* **headless:** ajustes da Fase D (run real no poupix) ([7111fb1](https://github.com/orobsonn/claude-harness/commit/7111fb1e15d451b58d7951f67bda89915f5632cf))
* **headless:** simula o brainstorm via subagentes de exploração ([7d6ee46](https://github.com/orobsonn/claude-harness/commit/7d6ee468533ca3fa6a55df57ea2b1ce49b6f3849))
* **headless:** Workflow obrigatório pra simular o brainstorm (fail-safe) ([01279b7](https://github.com/orobsonn/claude-harness/commit/01279b725996476473bfab135d97994a616e2e91))
* **hooks:** marker stamps persist reliably or fail loudly (stamp-triage exactly-one scan + read-back) ([#146](https://github.com/orobsonn/claude-harness/issues/146)) ([4c41a5f](https://github.com/orobsonn/claude-harness/commit/4c41a5f5d7e8e60dbad0fc663dce87606c1f9216))
* mão executora não tenta redisparar o pipeline do harness ([#77](https://github.com/orobsonn/claude-harness/issues/77)) ([4e97621](https://github.com/orobsonn/claude-harness/commit/4e9762160d6f732545fddb6cb4d0de7fc9952bd1))
* nudge determinístico com o motivo real de falha pré-spawn da mão barata ([#66](https://github.com/orobsonn/claude-harness/issues/66)) ([89fa18b](https://github.com/orobsonn/claude-harness/commit/89fa18b1c3d706c426aa01a3508491fcdb29bae6))
* **obs:** deterministic execution checkpoints in the run feed ([#200](https://github.com/orobsonn/claude-harness/issues/200)) ([8f5afdf](https://github.com/orobsonn/claude-harness/commit/8f5afdfb4a2b154da661c156e73104c245e88dcb))
* **observability:** concordância de plural no feed (1 tarefa, não 1 tarefas) ([#184](https://github.com/orobsonn/claude-harness/issues/184)) ([1a03614](https://github.com/orobsonn/claude-harness/commit/1a036141369a4917eb966d58aa5dc4f6f2b55139))
* **observability:** cron de review também drena o outbox (P7) ([#183](https://github.com/orobsonn/claude-harness/issues/183)) ([da3331f](https://github.com/orobsonn/claude-harness/commit/da3331fd198dcef55bf8185b88fa03c8d09d5cb6))
* **observability:** feed mostra só UMA classificação (dedupe pipeline-type por tipo) ([#173](https://github.com/orobsonn/claude-harness/issues/173)) ([7fa7e18](https://github.com/orobsonn/claude-harness/commit/7fa7e181a8be6b708dff8453338bf8d888998167))
* **observability:** feed Telegram em uma linha, revisões numeradas, emoji spec-adversary, anti-duplicata ([#176](https://github.com/orobsonn/claude-harness/issues/176)) ([af61a15](https://github.com/orobsonn/claude-harness/commit/af61a1594a65dd566f5118539e29c200dcef743b))
* **observability:** grupo global do Telegram só recebe ação/erro, não tagarelice de PR ([#179](https://github.com/orobsonn/claude-harness/issues/179)) ([8aee890](https://github.com/orobsonn/claude-harness/commit/8aee890ca55057932f718a9c48e03acd07e0944f))
* **observability:** marcos spec/plano na ordem certa (emissão session-side) ([#171](https://github.com/orobsonn/claude-harness/issues/171)) ([487a4cd](https://github.com/orobsonn/claude-harness/commit/487a4cd0f07b4e4a37347ef314442f666af042cc))
* **orchestrating-delivery:** exclude harness version-check cache from cheap-hand scope gate ([#147](https://github.com/orobsonn/claude-harness/issues/147)) ([2588413](https://github.com/orobsonn/claude-harness/commit/2588413b6ec358241325f4d932529ed8c7d004f7))
* **orchestrating-delivery:** forbid backgrounding spawn-hand under claude -p ([#136](https://github.com/orobsonn/claude-harness/issues/136)) ([e7cb7fb](https://github.com/orobsonn/claude-harness/commit/e7cb7fb57cf5ff3f4d7066006067b18dbdbfc2d8))
* **orchestrating-delivery:** stamp capturedVerifiedAt inline at dispatch ([#163](https://github.com/orobsonn/claude-harness/issues/163)) ([0a1a58c](https://github.com/orobsonn/claude-harness/commit/0a1a58c626242fbc222872e4c7ec8f194ca306c7)), closes [#89](https://github.com/orobsonn/claude-harness/issues/89)
* pacote npx quebrado (files sem setup-vps.mjs) + crontab estável no setup-vps ([#120](https://github.com/orobsonn/claude-harness/issues/120)) ([09560b8](https://github.com/orobsonn/claude-harness/commit/09560b8256d75bf3a34762d4424db1d0c329dfa4))
* **release:** bump badge de versão do README + skill releasing-versions inclui badge/VERSION no bump ([#37](https://github.com/orobsonn/claude-harness/issues/37)) ([3ebcf22](https://github.com/orobsonn/claude-harness/commit/3ebcf22006ace8fa8b2cb2e55db6642e12793a53))
* remove suggested_sniper_tier (nomes de modelo Claude) do schema do adversary/security ([#73](https://github.com/orobsonn/claude-harness/issues/73)) ([b79dcc6](https://github.com/orobsonn/claude-harness/commit/b79dcc6edb9c8e5572b6a7d547de211407122dba))
* **review-merge:** retry the squash-merge through GitHub mergeability lag ([#140](https://github.com/orobsonn/claude-harness/issues/140)) ([de85ea8](https://github.com/orobsonn/claude-harness/commit/de85ea8654cd9380988109b2e53a862e876e97dc))
* **review:** await review-started notify before the blocking spawn ([#141](https://github.com/orobsonn/claude-harness/issues/141)) ([755e644](https://github.com/orobsonn/claude-harness/commit/755e644bc8eb8ee7b58966801362f0960fa0108e))
* **review:** BLOCKED verdict é terminal por commit — mata o flaky BLOCKED→CLEAN do auto-merge ([#198](https://github.com/orobsonn/claude-harness/issues/198)) ([b2e0f64](https://github.com/orobsonn/claude-harness/commit/b2e0f645d0a695c22e4151d8a0f17c9389c0c449))
* **review:** Codex que não roda vira ausência (fail-open), não bloqueio de auto-merge ([#193](https://github.com/orobsonn/claude-harness/issues/193)) ([18a7d06](https://github.com/orobsonn/claude-harness/commit/18a7d063acee4fbd95c4938a77c3108727ac5fcd))
* **review:** list PRs via headRefOid + notify on start/merge/awaiting-merge ([#134](https://github.com/orobsonn/claude-harness/issues/134)) ([ef11cf6](https://github.com/orobsonn/claude-harness/commit/ef11cf6a481217744e3ffea1e9527b9a4636b660))
* **review:** sessão de revisão que trava não devolve a issue pra re-dispatch ([#192](https://github.com/orobsonn/claude-harness/issues/192)) ([8682c40](https://github.com/orobsonn/claude-harness/commit/8682c404ad9d11ed975987639b21ba78af9c9c9e))
* **spawn-hand:** pre-stamp hasTrustDialogAccepted in the hand ephemeral workspace ([#156](https://github.com/orobsonn/claude-harness/issues/156)) ([aa2a4fc](https://github.com/orobsonn/claude-harness/commit/aa2a4fc884ba023bc16c06587a7bcc88360eef4a))
* **vendor-core:** espelha os módulos vps que os hooks importam ([#164](https://github.com/orobsonn/claude-harness/issues/164)) ([b266379](https://github.com/orobsonn/claude-harness/commit/b266379464ed5c217b1e48a99bbf0fac995131fb))
* **vendoring+observability:** self-check vps deps no vendor-core + [projeto] nos tópicos ([#177](https://github.com/orobsonn/claude-harness/issues/177)) ([6c5b278](https://github.com/orobsonn/claude-harness/commit/6c5b27897e8e186db44dcdb0e8abe0a3afcfde08))
* **vps:** reconhecer PR por vínculo com issue + 'picked' com resumo ([#126](https://github.com/orobsonn/claude-harness/issues/126)) ([b0dca22](https://github.com/orobsonn/claude-harness/commit/b0dca222a107ae432da3191c1c594eccb5eb4fe1))

## [Unreleased]

### Fixed

- **O adversário não trava mais a entrega, e o motor para de moer rodadas que não levam a nada.**
  Uma run travou na fase de spec sem o planner rodar uma única vez: o ataque à spec voltou com achado
  em quatro rodadas seguidas, bateu um teto e o estado resultante **congelou toda mão de escrita pelo
  resto da run**, exigindo reinício de cerimônia. A causa não era a spec. Eram três coisas: **(1)**
  não existia em código nenhuma definição de "passe aceito" — a decisão ficava na cabeça do modelo, e
  duas sessões com o mesmo código fizeram coisas opostas (uma aceitou na 1ª rodada e seguiu, a outra
  reatacou até queimar o pavio); **(2)** a barra escrita era "lista de problemas vazia", inalcançável
  num codebase real, porque achar problema é literalmente o trabalho do agente e cada reescrita da
  spec abre superfície nova — esteira, não convergência; **(3)** o contador desse laço era **da run
  inteira**, compartilhado entre o ataque à spec e o ataque de cada tarefa, então uma entrega grande
  com quatro tarefas atacadas congelava no meio da implementação por contabilidade, não por defeito.
  Agora: o teto determinístico do adversário **saiu** (é o que o Claude Code sempre fez, e é por isso
  que lá isso não acontece) — nenhum laço de adversário nega despacho nem congela a run; a contagem
  passou a ser por unidade de trabalho (o passe da spec e cada tarefa com a sua); e quem para é o
  **orquestrador**, avisado a cada rodada: passe limpo → aceita e segue; achado aberto com rodadas
  pela frente → corrige a spec e reataca; deixou de convergir → **para e escala para o humano** (em
  autônomo, registra como risco aberto, segue, e leva para o corpo do PR). Os achados residuais agora
  chegam estruturalmente ao brief do planner, então aceitar um risco não é mais o mesmo que perdê-lo
  de vista. O ataque à spec também ganhou alvo próprio: contrato de entrega, não toda fraqueza
  alcançável do codebase — o que a spec exclui de propósito é risco aberto, não bloqueio.
  O único laço que ainda congela é o de revisão do plano, onde um REVISE de fato proíbe escrever.

  Fechados na revisão da própria correção: **um olho que devolve resposta ilegível três vezes na fase
  de spec também congelava mãos e entrega pelo resto da run** — nesta run a 1ª rodada veio malformada,
  faltaram duas para travar antes do planner existir; agora o olho quebrado para de ser despachado
  (insistir num schema que não passa é inútil) mas nada congela, e a recusa virou instrução em
  linguagem de produto. A **escalada deixa rastro durável** no estado e no feed de observabilidade —
  sem limite determinístico, escalada que ninguém registra falha igual a escalada que ninguém obedece.
  O **risco aceito é fotografado num campo próprio** e repetido em todo replanejamento até o plano ser
  aprovado (antes ele era lido de um campo que a 1ª revisão de plano sobrescrevia, então um risco que
  o planner deixasse cair desaparecia para sempre). E a prosa do adversário perdeu a brecha que
  mandava rebaixar fraqueza em chamador não tocado: escopo limita o que ele PROPÕE, não o que ele
  REPORTA — defeito que a própria mudança introduz nunca é rebaixado.

- **O plano volta a poder ser aprovado depois de corrigido, e o planejamento não trava mais na 2ª rodada.**
  Numa run ao vivo a entrega morreu em silêncio no planejamento: o revisor pediu ajuste (REVISE), e como
  um REVISE congela toda mão de escrita, a run ficou sem saída — não revisava e não implementava. Eram
  três defeitos empilhados, não um teto errado. **(1)** A assinatura que emparelha os dois revisores não
  incluía o plano, então o parecer antigo de uma família valia para sempre: com o plano já corrigido, um
  "aprovado" da família principal era sobrescrito pelo "revisar" da rodada anterior da outra — aprovar era
  inalcançável. Agora a assinatura acompanha o plano vinculado. **(2)** As negações do próprio motor ao
  planner eram cobradas do orçamento de *qualidade do agente*: três delas baniam pelo resto da sessão um
  agente que nunca rodou, e o planner não tem plano B. Agora contam no orçamento certo, o de precondição.
  **(3)** O orçamento de 5 rodadas de revisão era ficção: cada rodada consome um replanejamento, e o
  planner só tinha 3 tentativas na sessão inteira — uma delas perdida numa recusa de envelope. Agora cada
  rodada de revisão credita um orçamento novo (o K=3 continua barrando *falha* dentro da rodada), com um
  teto de sessão que **nenhum** caminho zera para o gasto não multiplicar num motor que faz merge sozinho.
  Fecham o conserto: as instruções do revisor e o identificador travado da feature passam a chegar ao
  planner no despacho — antes não havia caminho de código, só prosa, e cada replanejamento era cego
  (o texto do revisor entra como dado não-confiável, cercado por marcador com nonce); a negação por
  orçamento agora fala em linguagem de produto e manda escalar, em vez de encerrar o turno calada; e o
  estado deixa de mentir (o erro de vínculo antigo sobrevivia ao lado de um plano válido). Três prosas que
  ainda mandavam parar na 2ª rodada ou renomear a feature foram corrigidas.

  Duas armadilhas fechadas na revisão adversarial da própria correção, cada uma capaz de reproduzir o
  mesmo deadlock: o contador de negação por precondição **não tinha nenhum caminho de reset** em todo o
  código — três negações não-consecutivas baniam para sempre um despacho que já voltou a funcionar, então
  o ban só teria mudado de contador; e a única mensagem que o motor entrega de fato mandava "aplique a
  instrução no plano e re-despache o revisor", coisa que o orquestrador não pode fazer (o plano é do
  plugin desde a #449) — sem mandar replanejar, o plano nunca é revinculado, o parecer do par continua
  valendo e as 5 rodadas queimariam sem um único replanejamento. Também: a rodada que estoura o teto não
  credita mais orçamento (era plano que ninguém poderia revisar), o brief não é duplicado quando o
  runtime dispara o hook duas vezes, e a cerca de dado não-confiável falha fechada sem nonce em vez de
  cair num literal previsível.

- **A mão barata só roda nos modelos aprovados, e o orquestrador não escolhe mais o modelo no olho.**
  Numa run real o plano declarava a escada `{low: gemma4, medium: glm-5.2, high: kimi-k2.7-code}` e as
  três mãos saíram despachadas em `gpt-oss:120b` — justamente o modelo que a própria documentação
  mandava evitar, porque o tool-calling dele desmonta em loop agêntico. Custou 12 passes de sniper numa
  única run. Agora existe uma allowlist dos três modelos verificados, numa constante única
  (`shared/lib/hand-model-ladder.mjs`) lida pelos dois trilhos: o `plan-write-gate` bloqueia o plano que
  crave qualquer outro id — nomeando o tier e o id recusado — e o `spawn-hand` recusa o despacho sem
  spawnar processo nenhum. A trava é allowlist, não veto ao `gpt-oss`: um id que existe na API mas está
  fora da escada (`deepseek-v4-pro`) é recusado igual. O modelo saiu da mão do LLM: a flag `--model` do
  `descriptor-emitter` foi removida (um caller antigo recebe erro, nunca é ignorado em silêncio) e o
  modelo passa a ser derivado do plano — executor pelo `complexity ?? severity` da task, sniper pela
  aritmética sobre as findings aplicadas, com os inputs gravados no descriptor pra auditoria distinguir
  "resolvido a partir destas severidades" de "alguém disse high". Quando o modelo não resolve, o
  fallback é `glm-5.2` e ele se anuncia (`modelFallbackUsed`) no descriptor e no run-record — um
  fallback silencioso foi exatamente como o `qwen3-coder:480b` morto (410 Gone) sobreviveu no código;
  ele agora foi removido. Um id explicitamente fora da escada nunca vira fallback: é recusa dura.

- **A trava vale de fábrica em qualquer projeto, sem configuração.** O vendor só reescrevia os imports
  de `shared/` dentro de `.claude/hooks/`, nunca em `.claude/skills/`. Como `core/claude-code/` vira
  `.claude/`, todo arquivo vendorizado fica um nível mais perto de `shared/` — então a primeira skill a
  importar `core/shared` teria morrido com `ERR_MODULE_NOT_FOUND` no import, deixando **toda mão inerte
  em todo projeto vendorizado**. O rewrite agora é aritmético e cobre a árvore inteira, com um teste que
  importa o módulo vendorizado de verdade (uma checagem de string passaria com a profundidade errada).

### Added

- **A frota VPS agora suporta múltiplos repositórios.** Antes o reaper e os crons resolviam owner/repo
  a partir de UM único par no nível da frota — uma frota com dois repositórios corria o risco de
  relabelar, fechar ou podar contra o repositório errado, já que números de issue são por-repo. Cada
  entrada de `projects[]` agora carrega seu próprio `owner`/`repo`; o reaper resolve o escopo do `gh`
  por projeto (com fallback pro nível da frota numa fleet legada sem esses campos), e falha fechado
  (nunca poda, nunca fecha tópico) diante de um projeto desconhecido (#117).
- **test-infra memory chega ao test-author sozinha** — a curadoria de contexto do `orchestrating-delivery` agora, por convenção, injeta em todo dispatch do TEST-AUTHOR qualquer memory de `.claude/memory/` sobre o runner/pool/fixture de teste (ex.: `vitest-pool-workers-raw-import.md`). Um gotcha de test-infra já documentado alcança o test-author no primeiro dispatch — sem relay manual via `shared_context.md` — para a mesma mão não redescobri-lo duas vezes no mesmo run. Escopo restrito ao test-author; a curadoria do executor não muda (#102).
- **Fixtures em testes `@cloudflare/vitest-pool-workers` sem `node:fs`.** Testes que rodam no isolate Cloudflare não têm filesystem, então a orientação de autoria agora proíbe `readFileSync`/`readFile` nesses testes e prescreve o import build-time `?raw` (que devolve o texto bruto do fixture como string; `JSON.parse` quando o objeto é necessário), com carve-out explícito para suítes `node:test`, que continuam legítimas com `node:fs`. Documentado no agente `test-author` e na regra `testing-unit`.

### Changed

- **Testes que mockam `fetch` não quebram mais na segunda chamada.** A orientação pra quem escreve testes agora usa `mockImplementation` com uma `Response` nova a cada chamada, em vez de `mockResolvedValue` reutilizando a mesma instância — o corpo de uma `Response` só pode ser lido uma vez, então a segunda chamada ao mock antes quebrava silenciosamente.

### Security

- **Gate de entrega agora barra a entrega se o estado de re-triagem estiver corrompido, em vez de liberar por engano.** Se o arquivo interno que controla pendências de correção grave (`regate_pending`) existir mas estiver num formato inválido (corrompido), a entrega agora é **negada** com um motivo diagnosticável (em vez de tratar como "nada pendente" e liberar silenciosamente). Continua liberando normalmente quando o arquivo está simplesmente ausente (situação de infraestrutura, comportamento inalterado). Vale nos dois pontos onde essa checagem acontece antes de um push/entrega. (#100)

### Fixed

- **A captura não acusa mais a papelada do próprio harness como escrita fora de escopo da mão.** Um
  run em que a mão escreveu exatamente o arquivo que devia saía `FAILED` acusando 35 caminhos — entre
  eles o descriptor que a despachou, o brief, o gate-state e o próprio registro que continha a
  acusação. A causa não era a papelada: a captura já sabia descontar arquivos que estavam na árvore
  antes da mão começar, mas essa subtração era desligada por inteiro sempre que UM caminho da árvore
  não podia ser lido — e caminhos ilegíveis são rotina (a pasta de worktrees do próprio harness, o
  churn do `.wrangler/`, os stubs de `/dev/null` do sandbox). Com um caminho ilegível, todo arquivo
  pré-existente virava violação da mão, transformando trabalho bom em `FAILED` e disparando
  escalação e retrabalho em cima de nada. A subtração agora isola o caminho problemático em vez de se
  desligar. O controle de segurança fica intacto: escrita nova fora do escopo, adulteração de
  papelada existente, registro forjado e escape via `.gitignore` continuam todos acusados (#362).
- **O reaper agora limpa sozinho o worktree de um run já concluído.** Antes, um run que terminava
  normalmente (sem crash) deixava o worktree e a branch parados no disco indefinidamente — o reaper só
  agia em crash ou lock órfão. Agora, quando não há run vivo, o reaper confirma que o trabalho está
  preservado (PR merjado, branch ancestral do default, ou nenhum commit exclusivo) e o run está
  concluído (issue fechada ou PR merjado) sem PR aberto, e remove o worktree + a branch órfã. Se o
  trabalho NÃO está confirmadamente preservado, o worktree é removido sem force (preservando qualquer
  edição não commitada, que é retentada no próximo ciclo) e a branch é mantida — os commits não
  mesclados são sempre registrados em log antes da limpeza. Um run com sessão ativa nunca é tocado
  (#161).
- **vps notify (Telegram):** o feed de um run cujo tópico do fórum foi deletado/fechado não trava mais
  em silêncio — o drain agora recria o tópico, confirma a persistência e retoma o envio dos checkpoints
  pendentes ([#214](https://github.com/orobsonn/claude-harness/issues/214))
- **cross-family:** o teste de passthrough do `driveCrossFamily` não depende mais da máquina — antes ele
  chamava a checagem de disponibilidade real e, num host com o `codex` instalado e logado, disparava uma
  chamada de verdade ao codex dentro da suite, deixando o `main` vermelho e envenenando o gate de todo
  run. Agora a indisponibilidade é injetada, e um novo teste fixa o contrato oposto — sessão headless sem
  chave de API, mas autenticada por assinatura, **continua** rodando a segunda família (é assim que a
  revisão de PR ganha os olhos do codex) ([#225](https://github.com/orobsonn/claude-harness/issues/225))
- **O reaper volta a podar worktrees concluídos mesmo com outro run em andamento no mesmo projeto.**
  Antes, o run-lock (um por projeto) era atribuído ao holder vivo em TODO worktree listado — enquanto
  qualquer run estivesse ativo, todo outro worktree do mesmo projeto parecia vivo, e o reaper nunca
  podava worktrees de issues já fechadas/PRs já mergeados enquanto o motor (serializado, quase sempre
  ocupado) tinha outro run em curso. Agora a liveness é decidida por worktree — o holder só é atribuído
  à entrada cujo `tmux_session_id` bate com aquele worktree específico — então um run concluído é
  podado mesmo com outro run vivo no mesmo projeto ([#233](https://github.com/orobsonn/claude-harness/issues/233))

### Removed

## [0.32.1] - 2026-07-08

### Added

- **install-crons: cadência em minutos** — novos campos `intervalMinutesA` / `intervalMinutesReview` (inteiros 1–59) e flags `--interval-minutes-a` / `--interval-minutes-review` no `install-crons`, permitindo agendar Cron A e a fase de review em minutos (ex.: `*/15 * * * *`) de forma versionada, sem editar o crontab na mão. Mutuamente exclusivos com os campos `intervalHours*` do mesmo phase; sem eles o comportamento hour-based (4h/6h) permanece byte-idêntico (#162). Obs.: `*/N` é um _step_ dentro de cada hora, não um intervalo contínuo — escolha um divisor de 60 (15/20/30) para cadência uniforme.

## [0.32.0] - 2026-07-08

### Added
- **Você volta a acompanhar a revisão dos PRs — no tópico do run, do começo ao merge.** Cada run mantém seu próprio tópico no Telegram aberto até o PR merjar, e o ciclo de revisão inteiro (revisão iniciada → pronto pra merjar → merjado) é narrado ali dentro, em vez de sumir. O grupo global fica limpo, só com erro/ação. O reaper nunca fecha o tópico de um PR ainda em revisão (e reconhece PRs de branch atípica pelo corpo), e o fechamento no merge só grava "fechado" depois de confirmar o fechamento no Telegram — um soluço de rede não deixa mais um tópico órfão. Substitui a supressão interina da 0.28.6, que era a causa de você não receber nada sobre a revisão dos PRs. (#180)
- **Testes travados não podem mais depender de caminho absoluto do computador de quem escreveu.** A orientação pros agentes que criam e implementam testes agora exige caminho relativo ao próprio arquivo (em vez de `/Users/...` ou `/home/...` hardcoded), e a revisão de conformidade passa a barrar esse tipo de caminho hardcoded antes do teste travar — evitando que um teste passe na máquina de quem escreveu e quebre no checkout de outra máquina ou da nuvem.
- **Correção sugerida pelo revisor adversarial não quebra mais um teste já travado de outra tarefa por engano.** Antes de aceitar como definitiva uma correção que o agente aplicou por sugestão do revisor adversarial, o sistema agora reexecuta todos os testes travados já verdes das tarefas concluídas — e, se a correção quebrar um deles, ela é refeita sem tocar no teste travado, preservando o contrato já fechado.

## [0.31.2] - 2026-07-08

### Fixed
- **Feed de acompanhamento da run não fica mais mudo entre a aprovação do plano e a revisão final.** Dois checkpoints de progresso ("tarefa em execução" e "agente barato terminou") paravam de aparecer silenciosamente: um porque o registro da tarefa vinha formatado em várias linhas e o parser só entendia linha única; o outro porque dependia de um comando manual que podia ser esquecido no meio da run. O checkpoint de "tarefa em execução" agora é emitido automaticamente pelo próprio despacho da tarefa, sem depender de lembrete.

## [0.31.1] - 2026-07-08

### Added
- `npx claude-harness init` mostra progresso em tempo real (check por etapa concluída + progresso ao vivo do `git clone`) em vez de um resumo silencioso só no final

## [0.31.0] - 2026-07-08

### Added
- **Revisão de conformidade passa a pegar CLI documentada que na prática nunca roda.** Quando um guia (skill, comentário de CI, etc.) descreve um módulo `.mjs` como comando de terminal (`node arquivo.mjs`) mas o arquivo não tem o bloco real que o habilita a rodar assim, o resultado era um comando "fantasma" — parece funcional na documentação, mas executa e não faz nada. A revisão agora detecta essa inconsistência e bloqueia; módulos que são só biblioteca (chamados via `import`, nunca documentados como comando de terminal) nunca são sinalizados por engano.

### Changed
- **Tarefa de agente barato (cheap-hand) tem mais tempo pra terminar antes de ser considerada travada.** O teto de espera subiu de 9 para 15 minutos, e um trabalho que estoura o teto mas termina corretamente (teste travado passa) agora é aproveitado em vez de descartado como falha — evita re-tentativas desnecessárias em tarefas médias/grandes.

### Fixed
- **Revisão automática de PR não flipa mais de "bloqueado" pra "aprovado" no mesmo commit.** Um PR marcado como bloqueado por uma revisão podia, no ciclo seguinte, ser reavaliado do zero e liberado por engano — auto-mergeando um defeito que já tinha sido rejeitado. Agora um bloqueio é definitivo até o commit mudar. Também corrigido: o aviso de "PR travado" não dispara mais por engano enquanto o PR ainda está sendo corrigido normalmente.

### Removed

## [0.30.0] - 2026-07-08

### Added

- **Adversário per-task revê notas de risco adiado de tarefas anteriores** — em modo FULL, quando uma
  tarefa fecha com um risco explicitamente adiado ("seguro porque X ainda não acontece") sobre uma
  entidade de estado nomeada, o orquestrador casa deterministicamente essa entidade contra o diff de
  tarefas futuras e dobra a premissa casada no contrato do adversário da tarefa seguinte — pegando bugs
  de composição cross-tarefa (uma tarefa depois invalida silenciosamente a premissa de uma anterior)
  antes da revisão final, sinalizados com a tag `[cross-task-composition]`.

### Changed

### Fixed
- **Auto-merge deixa de ficar refém da segunda família (Codex/GPT) quando ela não roda por limite de assinatura.** No servidor do operador o Codex estoura o rate-limit e trava na maioria das revisões; quando isso acontecia, o gate tratava a falha como "segunda família reprovou" e bloqueava o auto-merge — mesmo com o Claude tendo aprovado —, empilhando PRs indefinidamente. Agora um Codex que **não conseguiu rodar** (rate-limit, timeout, hang, sem login) é tratado como ausência genuína → o veredito do Claude decide sozinho (fail-open, auto-merge). O Codex só **bloqueia** quando de fato roda e aponta um problema real (UNSAFE / issue grave). Segurança preservada: um achado real sempre acompanha `available:true`, então esse caminho nunca engole uma reprovação legítima.
- **Sessão de revisão que trava não vira mais loop de re-processamento caro.** Quando a revisão automática de um PR crashava/timeoutava sem produzir veredito, o sistema tratava isso como "revisão rejeitou" e devolvia a issue inteira pra fila — re-executando spec+plano+código do zero (caríssimo) pra corrigir um problema que não existia. Agora um crash de revisão é distinguido de uma rejeição real: o sistema apenas re-tenta a revisão (barata) do mesmo PR no próximo ciclo e, após 3 falhas seguidas de infraestrutura no mesmo commit, bloqueia a issue e avisa o operador de forma acionável, em vez de retentar pra sempre.

### Removed
- **Tratamento especial de PRs que tocam o próprio motor do harness (gate-machinery carve-out + 2ª revisão).** Antes, um PR cujo diff mexia na maquinaria de controle do harness (`core/vps/`, `core/skills/`, `.github/`, etc.) nunca era auto-mergeado — esperava merge manual do operador — e ainda passava por uma segunda revisão independente. Isso empilhava PRs de infra parados indefinidamente e dobrava o consumo de token nessas revisões. Agora mudança no motor é tratada **igual a qualquer PR**: uma revisão limpa (fresh CLEAN + cross-family) → auto-merge. A elegibilidade cross-family e o fail-closed de diff vazio permanecem intactos. Removidos `review-gate-hardening.mjs` (+ testes) e a lógica de 2nd pass do `cron-review`.

## [0.29.0] - 2026-07-07

### Added
- Auto-update do motor na VPS (blue/green): quando a `main` avança após um merge autônomo, um clone da nova versão é preparado numa pasta isolada e o motor troca para ela via symlink atômico — sem lock, sem instante meio-atualizado, com fallback seguro que nunca mexe num motor que não é gerenciado. Mecanismo entregue; a ativação automática no onboarding é o próximo passo.
- Recuperação automática de PR travado por branch desatualizada: em vez de mandar direto para a fila de merge manual, o harness sincroniza a branch com a base (operação nativa do GitHub, sem force) e a esteira de revisão reprocessa o PR do zero antes de tentar mergear de novo — com teto de tentativas para dois PRs que se invalidam mutuamente não entrarem em loop.

### Changed
- Auto-merge deixa de ficar refém da segunda família (Codex): quando o Codex não está disponível, a elegibilidade do merge passa a depender só do veredito do Claude (risco aceito e documentado). Um veredito do Codex que de fato rodou continua governando incondicionalmente — um `BLOCKED` sempre bloqueia. Quando o Codex voltar a rodar, a trava mais forte volta sozinha.

## [0.28.10] - 2026-07-07

### Added

- **Cron dedicado só-drenar (feed quase ao vivo)** — novo `run-drain.mjs` que roda APENAS o drain do
  outbox (sem dispatch, sem review), pra agendar num intervalo curto (default 3 min) e deixar o feed
  do Telegram quase ao vivo sem disparar os efeitos pesados dos outros crons. O `install-crons` passa
  a gerar essa 3ª linha (`intervalMinutesDrain`, default 3). O bloco de drain+lock virou um helper
  compartilhado (`drain-lock.mjs`) usado pelo cron de drain e pelo de review (mesmo `drain.lock`, sem
  double-send).

## [0.28.9] - 2026-07-07

### Fixed

- **"1 tarefas" no feed** — o checkpoint de plano criado dizia "1 tarefas" (plural com singular); agora
  concorda: "1 tarefa" / "N tarefas".

## [0.28.8] - 2026-07-07

### Fixed

- **Feed do Telegram só atualizava 1x/hora (P7)** — só o Cron A (de hora em hora) drenava o outbox de
  observabilidade; um run que começava e terminava entre dois ticks não mostrava nada no tópico até a
  próxima hora. Agora o cron de review (a cada 15 min) também drena — compartilhando o mesmo
  `drain.lock` do Cron A (sem double-send) e com stale-reclaim de 15 min. O feed passa a atualizar a
  cada 15 min.

## [0.28.7] - 2026-07-07

### Fixed

- **Resume-mode ressuscitava branch órfã de run morto (abria PR falso sem rodar o pipeline)** — o
  dispatch reusava QUALQUER branch `harness/<issue>` já existente, mesmo uma órfã deixada por uma
  tentativa que morreu antes de abrir PR. Um re-dispatch pegava os commits velhos e abria um PR em
  segundos, pulando spec/plano/build/review (com `regate-pending` sem resolver). Agora o resume só
  acontece quando a branch tem **PR aberto** (entrega real a preservar); uma branch órfã sem PR é
  **deletada e reconstruída do zero** (`-b`). O probe de PR é fail-safe: em qualquer erro do `gh` ele
  resume (nunca deleta), pra um `gh` inacessível jamais destruir uma entrega real.

## [0.28.6] - 2026-07-07

### Changed

- **Grupo global do Telegram só recebe ação/erro, não a tagarelice de PR** — o cron de review deixou
  de mandar `review-started` e `pr-merged` (eventos não-acionáveis) pro tópico global compartilhado,
  que com N projetos viraria spam. Continuam subindo: `pr-awaiting-merge` (o "mergeia isso" — sua
  ação) e todos os eventos de erro/bloqueio. (Rotear o ciclo completo pro tópico do próprio run exige
  refactor de lifecycle do tópico — rastreado em issue à parte.)

## [0.28.5] - 2026-07-07

### Added

- **Gate de entrega reproduz o suite de CI inteiro, não só o config default** — o Phase 3 (revisão
  final) agora enumera e roda TODO comando de teste que o CI declara (`package.json` scripts +
  cada `--config`/workflow do `.github/workflows/`) via `ci-test-commands.mjs`, e só declara a
  entrega verde quando todos passam. Fecha a classe de furo onde um projeto com mais de um config
  de teste passava local rodando só o default, enquanto um config inteiro do CI nunca era exercitado.
- **Hook `agent-idle-nudge` (PostToolUse[Agent])** — nudge automático quando um agente despachado
  encerra sem entregar o relatório estrutural final: injeta uma diretiva única de re-prompt (um só
  `SendMessage`) e, se ainda assim não vier relatório, marca a tarefa como não resolvida sem re-loop
  nem re-despacho. (#90)

### Changed

- **Nome do projeto no tópico do Telegram (multi-projeto)** — com N projetos compartilhando um grupo,
  o tópico de cada run agora se chama `[<projeto>] #<issue> · <título>`, então você lê o dono no
  título sem abrir. Dentro do tópico o feed segue sem a tag (o título já identifica). Os pings de
  erro/extraordinário que sobem pro grupo global levam `[<projeto>]` na frente. O nome do projeto vem
  do campo `project` no config do cron de cada projeto.

### Fixed

- **`vendor-core` não espelhava `vps/` em updates a partir de uma cópia velha (stale-jump)** — um
  projeto cujo `vendor-core` vendorizado era anterior à etapa de espelhamento de `vps/` atualizava os
  hooks pro import novo `../vps/…` **sem** criar `.claude/vps/`, deixando 3 hooks quebrando na carga
  (`ERR_MODULE_NOT_FOUND`) de forma invisível (o único sintoma era o entry-gate bloqueando todo
  subagente de entrega). Agora o `vendor-core` termina com um **portão de integridade** que **falha
  alto (exit 1)** se algum hook importa um `../vps/<mod>` ausente de `.claude/vps/`, e a skill
  `updating-harness` roda o vendor **duas vezes** (a 2ª sempre usa a cópia já atualizada) — auto-cura
  o stale-jump em vez de shippar hook quebrado em silêncio.

### Removed

## [0.28.4] - 2026-07-07

### Changed

- **Feed do Telegram em uma linha só** — cada checkpoint agora é `<emoji> <label> — <info>` numa
  única linha (`🚀 Classificação — modo LIGHT`), ou só o label quando não há info (`📝 Spec criada`).
  Antes eram duas linhas (título em negrito + corpo em itálico). Escape de HTML e truncação preservados.
- **Cron A espaça e limita os envios do Telegram** — o drain agora espaça os sends (~1,1 s entre cada,
  críticos e cosméticos) e o teto passou de 30 → 20 msg/min (o limite real por grupo do Telegram),
  para nunca disparar em rajada.

### Fixed

- **`spec-adversary` sem emoji** — o marco de adversarial da spec caía no emoji fallback `🔔`; agora
  usa `🛡️`.
- **Revisões do plano numeradas** — várias "Revisão do plano" apareciam sem distinção; agora cada
  round é numerado (`revisão 1 — requer revisão`, `revisão 2 — aprovado`), contado deterministicamente
  pelo produtor no retorno de cada `plan-reviewer`.
- **Repetição no feed** — sob o rate-limit do Telegram, o último send de uma rajada estourava o timeout
  de 5 s **depois** da mensagem já ter sido entregue → o cursor não avançava → reenvio no tick seguinte
  (duplicata). O espaçamento dos sends mata a causa (sem rajada, sem timeout-após-entrega); o timeout
  global do módulo não foi tocado.
- **`drain.lock` órfão silenciava o feed pra sempre** — um kill/OOM no meio do drain deixava o lock sem
  dono e todo tick futuro pulava o drain. Agora um lock com mtime além do TTL (15 min) é reivindicado;
  um lock fresco (drain concorrente real) é respeitado.

## [0.28.3] - 2026-07-07

### Fixed

- **Feed mostra só UMA linha de classificação por run** — subagentes dispatchados que rodam o próprio
  triaging classificavam a sub-tarefa com modos variados (LIGHT/QUICK/no-ceremony) no outbox
  compartilhado; o dedupe por `(tipo, modo)` deixava os 4+ passarem. Agora o `pipeline-type` dedupa
  por **tipo** — a sessão top-level classifica a issue uma vez (antes de dispatchar qualquer
  subagente), então só a classificação real sobrevive; as dos subagentes são suprimidas.

### Removed

## [0.28.2] - 2026-07-07

### Fixed

- **Marcos `spec pronta` / `plano criado` aparecem na ordem certa no feed** — antes eram derivados
  pelo drain (varredura de arquivo, com atraso de um tick), então caíam FORA DE ORDEM em relação aos
  eventos imediatos do run (podia mostrar "spec atacada" antes de "spec pronta"). Um hook novo
  `obs-plan-write` (PostToolUse Write) emite `spec-created`/`plan-created` **no momento em que o
  planner escreve o arquivo**, pondo o feed em ordem real de pipeline (classificação → spec →
  adversarial da spec → plano → revisão do plano → …). A varredura do drain permanece como fallback
  (dedupe append-if-absent, nunca duplica).

### Removed

## [0.28.1] - 2026-07-07

### Fixed

- **Runs autônomos do cron voltam a subir (aspas simples no gatilho quebravam o comando de sessão)** —
  o `TRIGGER_PROMPT` continha `'Closes #<issue>'`; ao ser embutido cru dentro de aspas simples no
  comando do tmux, a aspa fechava a string no meio e o `#` transformava o resto (incluindo
  `| claude -p`) em comentário de shell — **todo run do cron morria no arranque**, antes de rodar o
  pipeline. Agora o gatilho passa pelo `shellQuoteSingle`, blindando contra qualquer aspa. (P10)
- **Feed de observação para de mostrar spec/plano de outra feature** — o `cp -a .claude` para o
  worktree de cada run arrastava o `plans/` histórico (efêmero); o drain detectava um plano antigo e
  emitia `spec-created`/`plan-created` falsos, além de fazer o `spec-adversary` sumir. O
  `cron-a-dispatch` agora descarta `.claude/plans/` no worktree após copiar o harness, como um
  checkout de projeto normal já faz. (P11)

### Removed

## [0.28.0] - 2026-07-07

### Added

- **Feed curado de notificações no Telegram por run** — o tópico de cada run passa a mostrar só os
  marcos que o operador quer (sessão iniciada, classificação, spec, adversarial da spec, plano,
  revisão/aprovação do plano, loop das tasks + modelos, revisão final, PR), com rótulos em pt-br e
  emoji. O ruído interno (eye cru, `regate-pending`) e o spam de eventos duplicados por subagente
  ficam só no trilho de auditoria (JSONL), suprimidos do feed. `spec-adversary` e `plan-reviewed`
  (com verdict) passam a ser emitidos deterministicamente pelos hooks, sem depender de o orquestrador
  lembrar de marcar. A trava de entrega (gate-state) segue intacta — a supressão é só no feed.

### Changed

### Fixed

### Removed

## [0.27.1] - 2026-07-07

### Added

### Changed

### Fixed

- **Rastro de auditoria da captura fecha no despacho, não por lembrete do orquestrador** — o
  `spawn-hand.mjs` agora carimba `capturedVerifiedAt` no run-record que ele já grava, no mesmo passo
  do despacho e apenas quando a captura interna fica verde (`DONE`). Como o gate de entrega já bloqueia
  qualquer run-record `DONE` sem esse campo, o HEAD não avança mais para a próxima tarefa com a
  verificação em aberto — fechando o buraco em que os marcadores eram pulados silenciosamente e só
  apareciam no gate final, depois do HEAD já ter passado do ponto de captura. Green-only por
  construção: run que falha ou estoura tempo nunca recebe o carimbo.
- **Hooks vendorizados voltam a carregar (`vendor-core` espelha as deps vps)** — os hooks
  `stamp-triage` e `obs-eye-append` importam `../vps/obs-outbox.mjs`, mas o `vendor-core` não copiava
  `vps/` para o `.claude/` vendorizado. Resultado: `ERR_MODULE_NOT_FOUND` ao carregar o hook →
  `triage.json` nunca gravava → o entry-gate bloqueava todo subagent do pipeline (todo `.claude`
  vendorizado da 0.27.0 nascia com os hooks quebrados). O `vendor-core` agora espelha só os módulos
  que os hooks de produção realmente importam (fecho transitivo, `*.test.mjs` e cron runtime
  excluídos).

### Removed

## [0.27.0] - 2026-07-06

### Added

- **Observabilidade por run em tópico de fórum Telegram para runs autônomos na VPS** — cada run
  autônomo ganha um tópico de fórum dedicado que transmite checkpoints determinísticos do pipeline
  (tipo do pipeline, spec, plano, plan-reviewer, executor+modelo+eyes por task, revisão final, PR) via
  uma outbox drenada pelo cron, com prioridade crítica (bloqueado/falhou) sinalizada, fallback pro
  tópico compartilhado quando a criação falha, e fechamento do tópico pelo lado do cron ao terminar.

### Changed

- **Escada de modelos baratos (`hand_tiers`) trocada para gemma4/glm-5.2/kimi-k2.7-code** —
  deepseek-v4-pro saiu da escada por custo desproporcional ao ganho de qualidade nas mãos baratas.

## [0.26.1] - 2026-07-06

### Fixed

- Cheap-hand dispatches (`spawn-hand.mjs`) não travam/falham mais por causa do dialogo de confianca do workspace efemero nunca ter sido aceito — o hand agora roda o loop real de teste (red/green) em vez de ser bloqueado no primeiro `Bash` e estourar o timeout (fecha #91).

## [0.26.0] - 2026-07-06

### Added

- **Atalho de escalação em rate-limit de conta (429) do Ollama** — quando duas dispatches
  consecutivas da mão barata batem no limite de cota da conta Ollama (dois 429 seguidos para a mesma
  task, ancorados ao mesmo freeze), o orquestrador agora **pula o 3º tier Ollama** — que 429aria de
  novo por construção, já que todos os tiers dividem a mesma conta — e vai direto para o reforço
  Claude (K=1), poupando turnos e wall-clock. O `spawn-hand.mjs` atribui `rateLimited` sobre o stream
  do child (predicado estrito, não um `429` solto), mantém um contador consecutivo freeze-ancorado e
  expõe `rateLimitExhausted` no run-record; a §escalation do `SKILL.md` consome esse sinal. Route C: o
  `spawn-hand` nunca pula um spawn internamente (o record da 2ª tier é um run genuíno), então o
  cinturão de evidência não-forjável do entry-gate fica intacto (sem tocar `entry-gate.mjs`). Pinado
  por 11 locked tests em `spawn-hand.test.mjs`.

### Fixed

- **Sessão headless em branch tipada (`feat/`/`fix/`/`docs/`) agora fecha a issue certo** — o cron de
  saída só reconhecia PR pela convenção antiga `harness/<N>`; uma sessão que entregava em branch
  tipada (padrão `git.md`) tinha o PR invisível e a issue voltava pra fila em vez de fechar. Agora o
  cron também acha o PR pelo vínculo `Closes/Fixes/Refs #N` no corpo. O aviso Telegram de "pegou a
  issue #N" passa a incluir título + resumo, não só o número.
- **`cross-family.mjs` não roda mais um passe degenerado e silencioso** — sem `--task`/`--claude` o
  CLI antes deixava o Codex vasculhar o repo sem escopo e sem contraponto do Claude; agora exige os
  dois argumentos e falha rápido (usage + código de saída não-zero) quando faltam.

## [0.25.0] - 2026-07-06

### Added

- **Auto-merge autônomo que fecha de verdade + trava de segurança da própria máquina** — três
  correções que destravam o auto-merge de PRs verdes e impedem retrabalho: (1) o review cron agora
  **tira o PR do rascunho** (`gh pr ready`) nas duas rotas limpas antes de mergear — sem isso o
  `gh pr merge` nunca fechava um PR headless (que nasce draft), então nada auto-merjava mesmo verde;
  (2) **carve-out de gate-machinery**: um PR que toca a própria máquina de controle do harness — no
  repo do harness (`core/{vps,skills,agents,rules,hooks,github,__tests__}/`, `modules/codex-adversary/`)
  **e, crucialmente, o harness vendorizado em qualquer projeto downstream** (`.claude/{skills,agents,rules,hooks,modules}/`,
  `settings.json`/`CLAUDE.md`) — **nunca** auto-merjar, vai pra merge manual; num projeto normal nada
  disso é tocado, então tudo verde auto-merjar hands-free (matcher corrigido pra casar por segmento
  de path, não `startsWith` cru; saídas do harvester `.claude/memory/`/`kaizen.md` ficam de fora pra
  não travar todo PR); (3) **estados de label mutuamente exclusivos** via a fonte única `STATE_LABELS`
  — todo relabel strippa o conjunto completo de estados, então uma issue nunca carrega `harness:ready`
  junto de um estado posterior (o bug que fez uma issue já entregue ser re-despachada), e o seletor
  passa a excluir `awaiting-merge`/`queued`/`done`. Diff vazio/malformado **fail-closed** pra merge
  manual. Refs #86.
- **Timeout wall-clock na mão barata do spawn-hand** — um `claude -p` que trava numa chamada de
  rede sem fim (observado 28+ min a CPU quase zero) agora se autotermina no prazo (default 9 min,
  configurável por tier via `dispatch.timeout_ms`) e degrada sozinho para o caminho de reforço
  (Claude, K=1) — sem exigir `kill -9` manual e sem travar a entrega autônoma, especialmente em
  headless sem ninguém observando. O contrato de saída normal (0/1/2) fica inalterado.
- **`test-author` autoverifica formato e evita a armadilha do terminador de block-comment** — o
  agente agora tem uma auto-checagem de conformidade de formato (passo 5, sem depender de um
  formatter externo) e uma regra explícita contra escrever qualquer `/* */`/`/** */` cujo texto
  contenha a sequência que fecha o comentário (ex.: um cron `0 */6` dentro de um JSDoc), que hoje
  derruba a coleta de testes silenciosamente. Pinado por
  `core/__tests__/test-author-format-safety.test.mjs`.
- **Cadência dos crons configurável na instalação** — `install-crons` aceita `--interval-hours-a` e
  `--interval-hours-review` (inteiros 1..24; default 4h/6h). Intervalos menores fazem um roadmap
  encadeado avançar mais rápido sem tocar na garantia de ordem. Injection-safe por construção (só
  inteiro entra na linha do crontab).
- **Validação end-to-end do agendamento real** — novo teste opt-in (`HARNESS_CRON_E2E=1`) instala
  uma linha de crontab de verdade, espera o **cron daemon do SO disparar** e observa o efeito, então
  restaura o crontab original — prova que o scheduler agendado roda a linha instalada, algo que os
  testes herméticos (fakes em memória) nunca cobriram. Fica de fora do `npm test` normal (skip).
- **Skill `creating-issues`** — procedimento ativo pra criar a issue (o insumo de maior alavancagem
  da pipeline: último ponto de controle humano antes da máquina rodar plano→build→review→merge
  sozinha). Aplica a regra de sizing (unidade de entrega pequena e revertível), **treina critério de
  aceite verificável** (os `locked_tests` saem dele — AC vago mira a pipeline inteira errado), amarra
  `harness-deps` pra ordem do roadmap, cria tudo `harness:ready` e roda o `chain-validate`. Fonte
  única: lê a rule `creating-issues`, não a duplica; o advisory de `gh issue create` aponta pra ela.
- **Encadeamento de roadmap por dependência (parte 1: motor de liberação)** — uma issue de roadmap
  pode declarar de quais issues ela depende num bloco fechado no corpo (` ```harness-deps ` com
  `#12`, `#13`…), e nasce com a label `harness:queued` — invisível pro seletor, que só pega
  `harness:ready`. A cada ciclo de revisão, o motor libera automaticamente `harness:queued →
  harness:ready` **assim que TODAS as dependências têm PR merjado na main** (verdade-fundamento = PR
  merjado, nunca o label, que pode atrasar). Uma dependência diamante só libera quando a última
  merjа. Se qualquer dependência morre (`harness:blocked`), a dependente é encalhada
  (`harness:queued → harness:blocked`) e o operador é **notificado** — a corrente abaixo de um nó
  morto nunca fica parada em silêncio. A liberação roda no `reconcile()` do review cron, agnóstica
  ao modo de merge (auto **ou** merge manual do operador). A ordem é garantida por dois mecanismos
  combinados: o gate (dependente espera as deps merjarem) + a serialização do run-lock por-projeto
  (uma issue por vez) — sem dispatch automático nem race de implementação paralela.
- **Encadeamento de roadmap (parte 2: gate na seleção + lint de DAG)** — o seletor do Cron A agora
  **adia** qualquer issue `harness:ready` cujas dependências ainda não têm PR merjado
  (`harness:ready → harness:queued`), então o operador cria TODAS as issues do roadmap como
  `harness:ready` e o motor se auto-organiza — uma issue nunca é implementada sobre uma main que
  ainda não tem o código da dependência, mesmo que tenha sido criada `ready` por engano. O form de
  issue ganhou o campo **Dependências** (bloco ` ```harness-deps `). Novo lint pré-flight
  `node core/vps/chain-validate.mjs` detecta **ciclos** e **dependências inexistentes** de roadmap —
  os dois erros de autoria que o runtime não consegue auto-curar (ficariam encalhados em silêncio).
- **Fase independente de revisão de PR agora funciona de verdade** — o `spawnReviewSession` deixou
  de ser um stub que sempre falhava: a sessão de revisão roda de fato sobre o diff do PR (só olhos —
  adversary/compliance/security, nunca um hand com escrita) e o veredito CLEAN/BLOCKED que decide
  auto-merge é calculado pelo motor a partir dos vereditos brutos, nunca por autorrelato da sessão.
  Reforços anti-spoofing: artefatos de uma tentativa anterior (travada/expirada) são sempre apagados
  antes de rodar uma nova sessão e também em qualquer falha, para nunca herdar um veredito CLEAN
  velho.
- **Segunda família de modelo (Codex/GPT) agora roda de verdade na revisão de PR** — antes a
  checagem cross-family estava sempre desligada por um bug de fiação; agora ela chama o Codex de
  fato, sobre o diff real do PR, ao lado dos olhos Claude. A autenticação passou a reconhecer o
  login por assinatura do ChatGPT (sem precisar de chave de API). Uma trava explícita
  `autoMergeEnabled` (desligada por padrão) garante que nenhum PR mescla sozinho até o operador
  decidir ligar o auto-merge cross-family de propósito.

### Fixed

- **Marcador de `mark.mjs` encadeado com outro comando deixava de ser gravado em silêncio** —
  `stamp-triage.mjs` agora exige exatamente um objeto JSON com o marcador esperado antes de gravar
  (dois ou mais, ex.: `mark.mjs` encadeado com outro comando na mesma chamada, disparam um aviso
  alto em vez de gravação ambígua) e confere, por leitura de volta, que toda gravação tentada
  realmente persistiu — uma falha de gravação agora dispara aviso alto em vez de sucesso silencioso,
  e uma nova tentativa se auto-corrige.
- **A notificação "revisão iniciada" volta a chegar** — antes o aviso de que a análise de um PR
  começou era disparado logo antes de um `spawn` bloqueante de vários minutos; o tempo-limite de 5s
  do envio estourava durante o bloqueio e a notificação nunca chegava, o operador só via o resultado.
  Agora o envio de "revisão iniciada" é aguardado até concluir enquanto o loop está livre, antes do
  spawn — o ping chega de fato.

### Changed

- **PR já revisado no mesmo commit deixa de ser revisado de novo em todo ciclo** (fecha parte do
  risco de custo apontado no release anterior) — um PR aguardando merge ou barrado na segunda
  passagem de revisão agora é marcado como já revisado por SHA.

### Fixed

- **Bug do disjuntor (breaker) da revisão de PR corrigido** — o contador de sessões de revisão por
  janela de tempo travava (matemática quebrada) e nunca se recuperava depois de bater o teto; agora
  conta, corta no limite e se recupera normalmente após a janela.
- **Falha ao buscar o diff do PR deixou de ser indistinguível de "PR sem mudanças"** — antes uma
  falha transitória de rede/API ao buscar o diff caía silenciosamente no mesmo caminho de "diff
  vazio", podendo pular sem aviso uma checagem extra de segurança em PRs que tocam a própria
  infraestrutura de revisão. Agora a falha é sinalizada de forma distinta e o PR é reenfileirado em
  vez de seguir como se nada tivesse mudado.
- **Mão barata (cheap hand) deixa de ser falsamente reprovada por um cache interno do próprio
  harness** — a sessão filha que executa a mão carrega o hook de version-check do projeto, que
  grava um cache interno periódico e gitignorado (`.claude/.harness-version-check-cache`); a
  varredura de escopo passava a marcar esse arquivo benigno como violação e reprovava uma entrega
  correta, exigindo um re-disparo inteiro. Esse cache agora é reconhecido e ignorado pela checagem
  de escopo (correspondência exata, nunca por prefixo — fecha também um possível escape por nome de
  arquivo parecido).

### Removed

**Riscos abertos registrados (não bloqueiam esta entrega — o auto-merge cross-family segue
desligado por padrão, mas devem ser fechados antes de ligar `autoMergeEnabled` em produção):** um
veredito manipulado via injeção de prompt segue barrado hoje só por revisão humana do PR; e uma
falha transitória da segunda família de modelo (timeout, indisponibilidade) ainda é tratada como um
veredito definitivo de "bloqueado" em vez de "tentar de novo depois" — inofensivo hoje porque nada
mescla automaticamente sem essa trava, mas pode prender sem necessidade um PR bom até o próximo
push.

## [0.24.0] - 2026-07-05

### Added

- **Três regras de checklist no `creating-plans`** (fecha #93, #94, #98) — o planner agora sabe: (a) incluir todos os arquivos que tornam uma env/secret var usável em `scope_paths`, não só os 1-2 que o teste importa direto; (b) nunca adicionar um parâmetro posicional obrigatório a uma função cuja assinatura já foi pinada por um `locked_test` de tarefa anterior (preferir default opcional ou DI); (c) exigir que um `locked_test` cubra TODOS os branches de um invariante multi-estado, não só o happy-path. Documentação apenas — nenhum comportamento de código muda.
- **Fase independente de revisão de PR** (`cron-review.mjs` + `run-cron-review.mjs`) — o auto-merge deixa de confiar no corpo editável do PR como veredito e passa a ler um artefato de veredito fresco e fora de banda, só mesclando na conjunção completa de checks (origem-máquina + veredito CLEAN + acordo cross-family quando disponível). Rótulos novos no fluxo: `harness:in-review` → `harness:awaiting-merge` → `harness:done`/`harness:blocked`. **Nota:** a fase está montada e com testes verdes, mas ainda **inerte em produção** até um follow-up implementar o `spawnReviewSession` (o disparo real da sessão de revisão) — falha alto e claro (throw), nunca silenciosamente.

### Changed

### Fixed

- **Bug do rótulo `done` prematuro no `cron-a-exit`** — ao existir um PR aberto, a issue agora vai para `harness:in-review` em vez de pular direto para `harness:done`, alinhando o rótulo ao estado real (aguardando revisão, não entregue).

### Removed

## [0.23.2] - 2026-07-04

### Changed

- **`setup-vps` agora infere tudo do contexto — digitação mínima.** Não pergunta mais o caminho do harness: o motor (`core/vps`) é resolvido automaticamente do local do próprio script (clone real) ou, se rodar via `npx` (que não empacota `core/vps`), é **clonado uma vez** num path estável (`~/.claude/harness-core`) — nunca do cache efêmero do npx. O projeto vem da pasta atual (`cwd`), owner/repo do `git remote origin`, e os paths têm defaults sensatos. O operador só digita o que não dá pra adivinhar: o **token** e o **chat_id** do Telegram (Enter aceita cada default inferido).

## [0.23.1] - 2026-07-04

### Fixed

- **Pacote npx quebrado na 0.23.0** — o `files` do pacote não incluía o `setup-vps.mjs`, mas o `cli.mjs` o importa no topo → `ERR_MODULE_NOT_FOUND` ao rodar QUALQUER comando via npx (`setup-local`/`init` inclusive). Corrigido adicionando `setup-vps.mjs` ao `files`.
- **`setup-vps` apontava o crontab pro cache efêmero do npx** — o wizard agora pergunta o path do clone ESTÁVEL do harness na VPS (onde vive `core/vps/`), valida que existe, e roda o `install-crons` **de lá** — assim o crontab (que aponta pra `<clone>/core/vps/run-cron-a.mjs`) continua válido depois que o cache do npx é apagado. Sem clone válido, o wizard para com instrução clara de `git clone`.

## [0.23.0] - 2026-07-04

### Added

- **Wizard interativo `npx claude-harness setup-vps`** — liga o motor autônomo + as notificações Telegram na VPS por um assistente guiado, pensado pra operador não-dev. Pergunta projeto/owner/repo/paths e o Telegram (token, chat_id, thread_id, heartbeat), e é **auto-explicativo**: mostra na hora como conseguir cada valor do Telegram (criar bot no @BotFather, ler o chat_id via `getUpdates`/@RawDataBot, achar o message_thread_id do tópico). Grava o bot token **só** em `~/.claude/.dev.vars` (0600, fora do git, nunca exibido/logado — auditoria SECURE) e registra os crons + config de notify via `install-crons`. Substitui o one-liner `node install-crons.mjs install --flags`.

### Changed

- **`npx claude-harness init` → `setup-local`** — o comando de vendoring do harness na máquina de dev agora se chama `setup-local` (deixa claro o par com o `setup-vps`); `init` segue funcionando como alias retrocompatível.
- **Heartbeat do Telegram agora é ON por padrão** — o aviso periódico de "nada a fazer" (evento `idle`) passa a ser opt-**out** (`heartbeat: false` desliga), não mais opt-in. Configurar notify sem especificar heartbeat liga o ping. O `install-crons install --chat-id ...` pergunta interativamente (default sim) quando `--heartbeat` não é passado.

## [0.22.0] - 2026-07-04

### Added

- **Notificação Telegram one-way para o motor autônomo por VPS (`core/vps/notify-telegram.mjs`)** — o operador passa a receber os eventos-chave do ciclo cron num tópico de grupo compartilhado, sem SSH: issue escolhida, dispatch falhou/re-enfileirada, sessão concluída → PR aberto, issue bloqueada (precisa de atenção humana) ou com retentativas esgotadas, PR revisado CLEAN→merged ou BLOCKED, e ações do reaper (watchdog kill / recuperação de crash / worktree órfão limpo). Cada mensagem é prefixada `[<project>]` (multi-projeto: um destino compartilhado serve vários projetos). O módulo é **puro/injetável e zero-dep** (Node builtins): `formatEvent` puro (HTML-escape, links `<a href>`, truncagem), `sendNotification` best-effort com `AbortSignal.timeout` (~5s) e feature-detect de runtime, sem retry (429 engolido). A lógica pura de cada cron retorna resultado estruturado; os composition roots (`run-cron-a`/`run-cron-b`/`run-reaper`/`cron-a-exit`) traduzem em evento e notificam best-effort com `drain` antes do exit. **100% opcional e fail-open**: sem `notify` configurado ou com o Telegram fora do ar, o motor roda idêntico a hoje — uma falha de notificação nunca derruba nem atrasa um cron. **Higiene de segredo (auditoria SECURE):** o `TELEGRAM_BOT_TOKEN` vive só em `~/.claude/.dev.vars`, lido do disco no envio; nunca no config, crontab, argv, log ou na URL logada — falha loga só `{op,type,project,status}`. Config `notify:{chatId,threadId}` opcional via `install-crons` (flags `--chat-id`/`--thread-id`/`--heartbeat`); `chatId`/`threadId` não são secret. 42 testes novos com `fetch` injetado (zero chamada real ao Telegram), suíte inteira 846/846. Entregue pela pipeline FULL do harness (spec-adversary + plano + plan-review + TDD congelado + dual-review compliance/adversary/security).

## [0.21.0] - 2026-07-04

### Added

- **Instalador de crontab por projeto (`core/vps/install-crons.mjs`)** — fecha o follow-up do motor autônomo por VPS (v0.19.0): gera e valida o config por-projeto que os composition roots (`run-cron-a`/`run-cron-b`) consomem e o config compartilhado do reaper, e registra/desregistra as linhas de crontab de forma idempotente. Cadências fixas — Cron A a cada 4h (`0 */4`), Cron B a cada 6h (`0 */6`), reaper diário às 03:00 (`0 3`). Cada projeto vive num bloco cercado por marcador (`# >>> harness:<project> >>>`), então reexecução nunca duplica; `--uninstall <project>` remove só aquele bloco e o reaper compartilhado só sai quando o último projeto é removido (o config do fleet é apagado, não deixado obsoleto). Nenhum secret toca o crontab, config ou log — o token é lido do disco em runtime pelo caminho já existente (`scoped-env-fromdisk`). Determinístico, Node builtins puros, zero deps, 65 testes (zero mutação de crontab real no teste). Endurecido por dual-review cross-family (Claude + Codex): leitura de crontab que nunca apaga crons de outros tenants num erro de leitura, validação estrita de coordenadas + guarda no render contra injeção de linha cron, invariante single-repo por fleet, trava de install e escritas atômicas.

## [0.20.0] - 2026-07-04

### Changed

- **Revisão proporcional dos "eyes" (process-eye-routing)** — duas mudanças de custo/latência no próprio pipeline, sem enfraquecer as classes graves:
  - **Roteamento do adversary por blast radius.** O adversary per-task deixa de rodar Opus em todo checkpoint: agora flexiona o tier via o helper puro determinístico `references/eye-tier.mjs` (`resolveEyeTier`) — **Opus** quando a task é grave (`severity` HIGH **ou** sensitive-path), **Sonnet** caso contrário (com **piso Sonnet** — nunca Haiku, nunca Ollama). Os dois gates de fronteira (spec-adversary upfront + dual-review final), o `plan-reviewer` e o `security` per-task **continuam Opus sempre**. A economia no trivial vem de **pular** o eye (`adversarial.enabled=false`), nunca de um eye sub-Sonnet. Nota "raise effort before raising tier" preservada; instrumentar `usage` **por eye** para comprovar a economia.
  - **Re-gate condicional do sniper.** O re-gate obrigatório após fix HIGH deixa de ser sempre um adversário Opus fresh-virgin: continua **Opus completo para fixes graves** (`isGrave(fix)` = qualquer classe canônica-crítica — incluindo as irreversíveis 1/2 — **ou** sensitive-path **ou** re-arquitetura **ou** >1 função/seam; default duro de viés-pra-grave na dúvida). Para um fix HIGH **cirúrgico não-grave**, um **caminho leve**: um `locked_test` congelado que vai **red→green** por causa do fix (um "stays green" é explicitamente insuficiente) **ou** um spot-check de adversary Sonnet virgem com zero findings — cada um deixando um **artefato em disco** sob `run/` que o self-check exige. O trilho `regate-pending`→`regate-passed` permanece **inalterado e delivery-blocking**; os hooks seguem mechanism-agnostic (nenhuma mudança de lógica de hook).

## [0.19.0] - 2026-07-04

### Added

- **Entrega autônoma por VPS (cron-driven)** — substitui as Cloud Routines por um motor self-hosted: dois crons por projeto + um reaper compartilhado que rodam o pipeline do harness sem operador. O Cron A pega a issue `harness:ready` mais antiga, marca `in-progress`, roda a sessão autônoma (`claude -p --permission-mode auto`, headless-local, mãos baratas Ollama ativas) num git worktree isolado e abre um PR rascunho; o Cron B revisa o PR e faz **merge automático** quando o veredito do dual-review é CLEAN (gate de autor fail-closed + merge preso ao SHA revisado), senão comenta o bloqueio; o reaper mata sessões penduradas (watchdog de tempo), recupera runs que crasharam e limpa worktrees órfãos. Inclui trava de concorrência atômica (single-winner via `mkdir`+`rename`, com defesa em 3 camadas), isolamento de secret por projeto (env-scoping), máquina de estados da issue (`done`/`blocked`/re-fila com teto de retentativas) e persistência do veredito CLEAN/BLOCKED no corpo do PR — o único toque aditivo no pipeline existente. Código em `core/vps/` (15 módulos, 66 testes), runnable via `run-cron-a`/`run-cron-b`/`run-reaper`. O instalador que registra o crontab por projeto é follow-up.

## [0.18.7] - 2026-07-02

### Added

### Changed

- Organização da pasta de plano: os buffers de run por feature (`shared_context.md`, `test-manifest-*`, `brief-*`, `descriptor-*`, `task-slice-*`, `plan-review-*`, `spec-adversary-*`, `task.json`) agora vivem em `.claude/plans/<feature_id>/run/`; só `spec.md` e `execution-plan.json` ficam na raiz da feature. Mudança de convenção na prosa do pipeline (emitters recebem paths por arg — sem mudança de código).

### Fixed

- Bug de ordenação `scaffold`-após-`freeze` na mão barata: quando o teste congelado importa um módulo de produção ainda inexistente, o `spawn-hand` recusava com "gate vazio"; commitar o stub depois do freeze movia o HEAD e disparava "HEAD diverged" → tempestade de retries. Agora o SKILL instrui o stub a entrar DENTRO do freeze commit (exportando exatamente os símbolos que o teste importa), e a mensagem de erro do `spawn-hand` nomeia o recovery correto.
- Loop de plan-review sem freio determinístico: o `entry-gate` agora conta cada dispatch de `plan-reviewer` por sessão (`plan_review_count`) — reetiquetar a rodada como "verificação focada" na prosa não dribla mais o contador. Passado o cap documentado de 2 revisões, injeta um aviso visível com o número da rodada e o custo; um backstop de runaway bloqueia além da rodada 10 (só interativo — headless permanece warn-only pra não travar cloud run sem operador). O contador sobrevive a re-triage (preservado no `resetGateState`).
- Precondição de Auto Mode pra cheap-hands documentada: o egress da mão barata pro modelo Ollama externo pode ser hard-blocked pelo classificador de data-exfiltration do Auto Mode se o endpoint não estiver declarado em `autoMode.environment`. O SKILL agora instrui checar isso UPFRONT (antes de plano/freeze), tratar o bloqueio como controle real de plataforma (não fabricação/erro de config), e nunca auto-declarar destino confiável (decisão de dado do operador). Fail-open.

### Removed

## [0.18.6] - 2026-07-01

### Fixed

- Gate de entrega (`capture-verified`) agora cruza com o registro real da mão barata, gravado automaticamente em disco a cada dispatch — não só com o carimbo manual `hand-finished`/`capture-verified`. Detecta um dispatch sem verificação independente mesmo quando o carimbo foi esquecido (incidente real onde 4 de 5 dispatches numa run ficaram sem carimbo). Violação de escopo/manifesto congelado agora bloqueia a entrega mesmo que o carimbo tenha sido feito.
- Corrigido path traversal em `feature_id`/`task_id` nos registros de mão barata (`.claude/plans/.state/hand-records/`), achado na revisão adversarial desta mudança.

## [0.18.5] - 2026-07-01

### Fixed

- Mão executora (executor/sniper) não tenta mais redisparar o pipeline de triagem do harness quando lê o CLAUDE.md do projeto — evita travar esperando confirmação que nunca chega em modo não-interativo.

## [0.18.4] - 2026-07-01

### Fixed
- `adversary`/`security` não devolvem mais `suggested_sniper_tier` com nomes de modelo Anthropic (`haiku`/`sonnet`/`opus`) — campo morto de uma migração anterior incompleta; o dispatch da mão barata já é resolvido via `hand_tiers[severity]`, nunca lê esse campo. Corrigido nos dois lados (agents nativos + espelho cross-family Codex).

## [0.18.3] - 2026-07-01

### Fixed
- O sweep de recuperação de writes gitignorados (`lsFilesAllOthers`) não trata mais `node_modules/` como possível violação de escopo — cache que o próprio test runner escreve ao rodar o teste travado (vitest, coverage tooling) derrubava hands corretos como `FAILED` por falso positivo.

## [0.18.2] - 2026-07-01

### Fixed
- Adapter `vitest` do test-runner não travava mais em falso-negativo em projetos Cloudflare Workers: o parser da contagem de testes ignorava os logs que o `@cloudflare/vitest-pool-workers` intercala com a linha JSON do reporter, tratando qualquer run como "sem contagem" e travando a mão barata.

## [0.18.1] - 2026-07-01

### Fixed
- `stamp-triage.mjs` agora injeta o motivo real de uma falha pré-spawn da mão barata (lido do JSON estruturado que `spawn-hand.mjs` já emite no exit 2), em vez de deixar o orquestrador compor sua própria explicação — fecha um caso real onde um agente inventou uma causa fictícia pra um erro banal (token ausente).

## [0.18.0] - 2026-06-30

### Added

- **Nudge determinístico do segundo olho (Codex) — deixa de depender da memória do orquestrador**: um hook `PostToolUse[Agent]` (`core/hooks/codex-eye-nudge.mjs`, registrado no `settings.json`) injeta automaticamente, no instante em que o orquestrador despacha um eye elegível (adversary/security/plan-reviewer) com o cross-family ligado, um lembrete pra rodar a segunda família e mergear. Resolve o caso real (observado em sessão FULL) em que o orquestrador Sonnet pulava silenciosamente o `cross-family.mjs` — a instrução vivia em prosa na skill, lida no começo da sessão e esquecida no momento do dispatch. **Advisory e fail-open total**: nunca bloqueia (sem `permissionDecision`); switch off, módulo ausente ou headless → Claude-only exatamente como hoje. Cobertura por `subagent_type` em todos os checkpoints (spec, per-task, plan-review, final), não só os finais. Catraca/gate determinístico foi deliberadamente rejeitado (forjável + deadlock fail-closed) — não se adiciona gate onde nada está quebrado.
- **Rota verdict-shaped pro `plan-reviewer` no `cross-family.mjs`**: `cross-family.mjs --role plan-reviewer` agora roteia pelo fluxo de veredito (`runCodexRole` + `merge-verdicts`, either-REVISE-wins) em vez do fluxo de findings, alcançável end-to-end pelo CLI. O verdict path respeita o toggle de opt-in/force-off e faz fail-open pro veredito do Claude quando o Codex está indisponível ou retorna saída sem veredito (nunca um REVISE espúrio).

### Changed

### Fixed

### Removed

## [0.17.1] - 2026-06-30

### Added

### Changed

### Fixed

- **`test_runner` configurável por projeto (`references/runner-adapters.mjs`) — Vitest deixa de ser falso-FAILED na mão barata**: o dry-run pré-spawn, o gate ao vivo do Stop-hook e a captura independente pós-spawn rodavam `node --test` cravado em três lugares distintos — um projeto Vitest (ex: `victor-pipeline-dados-bot`, com `vitest-pool-workers`) sempre reportava `lockedTestExitCode: 1` mesmo com código correto, exigindo validação manual fora do harness. Agora um adaptador único (`{ command, parseCount }` por runner, sempre array pra `execFileSync`, nunca string interpolada) é a fonte de verdade nos três pontos; `node-test` continua default — zero config pra todo projeto já vendorizado. Seleção por `.claude/hand-config/test-runner.json` (`{ "adapter": "vitest" }`).
- **CLI runnável pro `descriptor-emitter.mjs` e `brief-serializer.mjs`** — a skill já prometia "descriptor nunca digitado à mão", mas os dois helpers só existiam como função JS exportada, sem entrypoint. O orquestrador, sem runtime JS interativo, acabava digitando `descriptor.json` na mão via heredoc — exatamente o que a skill proíbe — e batendo, em sequência, erro de quoting, `fidelity-pass` faltando e `freeze_commit_sha` faltando (observado ao vivo no `victor-pipeline-dados-bot`). Agora `node references/descriptor-emitter.mjs --feature-id ... --out descriptor.json` e `node references/brief-serializer.mjs --task-slice ... --out brief.txt` espelham a UX já estabelecida em `spawn-hand.mjs`/`mark.mjs`. Sem flag `--head-sha`: `freeze_commit_sha` sempre vem do `git rev-parse HEAD` real, nunca de argv — fechar a fricção não reabre a porta de forjar o anchor do fidelity-rail.

### Removed

## [0.17.0] - 2026-06-30

### Added

- **`security` vira olho cross-family (módulo `codex-adversary`) — o terceiro olho de outra família, com gate Claude-authoritative**: o auditor de segurança passa a rodar em **duas famílias** (Claude + Codex/GPT) nos checkpoints per-task (step 3b) e no final dual-review, merge **policy B** (achado de uma só família sobrevive a menos que a outra refute). Por ser um **gate** binário (`SECURE|UNSAFE`), o verdict é **Claude-authoritative**: um achado codex-only só escala o gate após o seu refute-pass do Claude — um `pendingClaudeRefutation` não-resolvido vira **precondição bloqueante no gate-state** (igual `regate-pending`). Assim um defeito real que só o Codex pegou ainda bloqueia (depois do Claude confirmar), mas um falso-high do Codex nunca vira UNSAFE espúrio por trás do orquestrador, e um refute-pass esquecido **bloqueia** em vez de passar silencioso. Dedup e `severity` **por-shape** (security não tem `category`; `Critical`/desconhecido→high conservador). Reverte a nota da v0.16.0 "security stays Claude-only" — `compliance` segue Claude-only (checa ACs do spec, não failure-modes gerais que uma 2ª família diversificaria).
- **`vendor-core` vendoriza o módulo `codex-adversary` (gated) — fecha o gap "não auto-vendorizado" da v0.16.0**: copia `modules/` → `.claude/modules/` quando `--with-codex` OU o módulo já está presente no target (um update **refresca** o opt-in em vez de deixá-lo stale). Default sem flag = nenhum módulo (safe default = sem codex). `*.test.mjs` excluído (o repo-fonte é a casa dos testes).
- **UX do `npx @orobsonn/claude-harness init` — pergunta o cross-check, sem nunca tocar no auth**: em TTY pergunta se quer o segundo olho (Codex/GPT); SIM vendoriza o módulo + liga o toggle `HARNESS_CODEX_ADVERSARY=1` em **`.claude/settings.local.json`** (per-machine, não-versionado, write atômico, fail-soft) + imprime o setup do Codex. Não-TTY (CI/headless) usa a flag explícita `--with-codex`; sem flag = init padrão. O `init` **nunca roda `codex login`** — o login na OpenAI é do operador.
- **Doc do setup do Codex (operador)**: README do módulo + `config.toml.example` com os fatos verificados na doc oficial do Codex CLI — install `@openai/codex` (Node 22+; nunca o `codex` cru), gotcha do `OPENAI_API_KEY` que **não** sobrescreve um login ChatGPT ativo (use `codex login --with-api-key`), config **por-projeto** `.codex/` (trusted, closest-wins) análoga ao `.claude/`, e skills em `.codex/skills/`.

### Changed

- **Portabilidade do módulo `codex-adversary` — resolve as fontes canônicas nos dois layouts**: `resolveCanonicalPath` tenta `REPO_ROOT/core/<rel>` (repo-fonte) e cai pra `REPO_ROOT/<rel>` (vendored, `.claude/agents/...` sem `core/`). Sem isso o módulo vendorizado quebrava ao resolver os role files. Validado ponta-a-ponta num projeto-teste (os 3 roles resolvem de `.claude/agents/`). O driver `driveCrossFamily` vira genérico por `role` (default `adversary`; também `security`) e é **embrulhado em fail-open real** — um defeito de path/compose degrada Claude-only em vez de throw fail-CLOSED. Paths de comando nas SKILL/CLAUDE/README reconciliados pro contexto vendored (`.claude/modules/...`).

### Fixed

### Removed

## [0.16.0] - 2026-06-30

### Added

- **Olhos cross-family (módulo opt-in `codex-adversary`) — um segundo olho de outra família de modelo (GPT via Codex CLI) nos checkpoints de julgamento**: o `adversary` (spec attack / per-task / final dual-review) e o `plan-reviewer` podem rodar em **duas famílias** — Claude + Codex/GPT — em paralelo, com merge dos achados (**policy B**: um achado de uma só família sobrevive a menos que a outra o refute; nunca voto majoritário) e, no plan-reviewer, **either-REVISE-wins**. Como as famílias falham diferente, a união cobre pontos cegos que nenhuma pega sozinha. **Opt-in e fail-open total**: OFF por default — o operador liga via `HARNESS_CODEX_ADVERSARY` (ou `adversarial.cross_family` por task); sem o módulo, switch off, headless sem `OPENAI_API_KEY`, ou `codex` indisponível → roda **Claude-only exatamente como hoje**, nunca bloqueia. O segundo olho é sempre read-only (`--sandbox read-only`) e Claude-tier (um olho, nunca uma mão barata). Compõe com o fan-out-join: o checkpoint `adversary` se alarga para 2 famílias *dentro* do mesmo membro do fan-out, com o merge resolvido no join. **Nota:** o módulo ainda não é auto-vendorizado para projetos (`vendor-core` copia só `core/`); por ora fica disponível no repo-fonte / operator-installed.
- **Revisão paralela dos olhos (fan-out-join) — entrega mais rápida sem tocar no trilho de segurança**: os olhos read-only que revisam o código (compliance + adversary + security), antes despachados em fila, passam a rodar **concorrentemente numa só leva de Agent calls (fan-out)**, com todos os verdicts coletados (**join**) antes do sniper — tanto na revisão per-task (Phase 2) quanto no final dual-review (Phase 3). O gargalo real de wall-clock é o `adversary` (Opus, lento); rodá-lo concorrente com compliance/security corta esse tempo. Seguro por construção: os olhos são read-only, não escrevem no working tree nem carimbam markers no gate-state, e são mutuamente independentes (adversary virgin, compliance lean) — o paralelismo não toca o trilho de segurança. Mantém a proibição de **background-and-poll** (verdict stale); o que se habilita é o **fan-out-join** (bloqueia até todos os verdicts finais chegarem). Mãos (executor/sniper/test-author) seguem seriais de propósito.

### Changed

### Fixed

- **Deadlock do `test-author` no fidelity-rail (LOCAL) — destravado**: o `test-author` (quem autora o teste travado RED, o oráculo do pipeline) é a *pré-condição* do `fidelity-pass`, mas era gateado pelo MESMO fidelity-rail que serve — bloqueado por todos os caminhos (spawn-hand exige um teste congelado que ele ainda nem criou; main-loop `Agent` exigia um ticket de escalação com run-record `FAILED` inexistente). Sem saída, o orquestrador escrevia testes e código na mão e auto-carimbava o `fidelity-pass` (violando "strong eyes, cheap hands" de ponta a ponta — observado ao vivo no `victor-pipeline-dados-bot`). **Conserto:** o `test-author` passa a rodar como **main-loop Claude Agent (sonnet)** em LOCAL e HEADLESS — espelhando o que o headless já fazia — com early-return no `entry-gate.mjs` antes do hand-routing rail (escopado a `role === "test-author"`; executor/sniper seguem gateados, sem enfraquecimento). Seus controles de segurança são o olho `compliance` (step 1b) + o content-hash do freeze (step 1c). O `fidelity-pass` segue intocado (veredito do compliance).

### Removed

## [0.15.0] - 2026-06-28

### Added

- **Hook de version-check (SessionStart/startup) — tira do operador o fardo de lembrar de atualizar o harness vendored**: novo `core/hooks/version-check.mjs`, wired em `core/settings.json` **apenas no matcher `startup`** (nunca `compact` — sem re-nag no meio de uma entrega). No início da sessão compara a versão vendored (`.claude/.harness-version`) com a última GitHub Release; se estiver atrás, emite um `systemMessage` (operator-facing, top-level) em pt-br oferecendo rodar `/updating-harness` e reiniciar. **Fail-open total**: sem rede / `gh` ausente / 404 / parse → exit 0, zero ruído. **No-op em headless** (`$CLAUDE_CODE_REMOTE` setado — a versão no cloud é pinada de propósito), checado antes de qualquer disco/rede. **Anti-falso-positivo**: normalização semver numérica que trata `vX.Y.Z`, git-describe `vX.Y.Z-N-gSHA` e SHA puro — "igual ou à frente da última tag" é em-dia (alarme falso treina o operador a ignorar o único sinal). Rede com `AbortSignal`/`--max-time 2` e cache `{tag}` gitignored com TTL de 6h (≤1 hit no GitHub por janela, protege o limite de 60 req/h). **Chicken-and-egg conhecido**: projetos vendorados ANTES deste hook só recebem o check após um `updating-harness` manual.
- **`npx @orobsonn/claude-harness init` — primeira adoção num projeto novo em UM comando**: novo pacote npm scoped `@orobsonn/claude-harness` (público, zero-dep, node builtins only) cujo `init` ENVOLVE (não reimplementa) o `vendor-core.mjs` — resolve a última release tag (gh→curl) e vendora o harness no `.claude/` do diretório atual, idempotente e non-clobber (memory/kaizen/settings preservados), estampando `.harness-version`. O guard do bin resolve symlink (`realpathSync`) porque o bin npm é symlinkado — sem isso o `init` rodaria como no-op.

### Changed

- **`vendor-core` ignora o cache do version-check nos consumidores**: o `.claude/.gitignore` gerado passa a incluir `.harness-version-check-cache`, então o arquivo de cache do hook nunca é commitado em projetos vendorados.
- **`detect-stack` reconhece node-test mesmo com `package.json` presente**: antes, qualquer `package.json` sem `vitest`/`jest` caía em `skip`; agora um `scripts.test` que invoca `node --test` é detectado como runner `node-test`. Necessário porque o próprio repo passou a ter `package.json` (pelo bin do npm) sem deixar de ser um projeto `node:test`.

## [0.14.4] - 2026-06-27

### Added

- **Disciplina de conserto na raiz (bug fix audita todos os chamadores)**: ao planejar uma correção de bug, o planner passa a confirmar que `scope_paths` cobre **todos os chamadores** da função compartilhada — dimensiona o conserto na raiz, não no call site nomeado pelo ticket. O adversary ganha um alvo explícito: o **ponto cego de chamador irmão** (fix que arruma um caminho e deixa outro chamador da mesma função quebrado). Fecha o gap onde nenhuma rule/agente cobria o diagnóstico sintoma × raiz para bug fix — só roles Opus (planner + adversary), mãos baratas intocadas.
- **Alvos de detecção de over-engineering no `code-quality.md`**: novo gotcha nomeando as formas clássicas de excesso para o compliance pegar — stdlib reimplementada à mão, dep que duplica feature nativa da plataforma (`Intl`/`URL`/`crypto`/`fetch`), flag/config morto. Fecha os degraus stdlib/nativo que a regra não tornava explícitos; fraseado como alvo de **detecção**, nunca ordem de corte por cota. Origem: análise multi-modelo do repo `ponytail` (2 de 8 candidatos sobreviveram à crítica adversarial).

## [0.14.3] - 2026-06-27

### Fixed

- **entry-gate: piso de branch protegida agora cobre o default branch real do origin, não só main/master**: ao entregar (`git push`/`gh pr create`/`gh pr merge`) direto do branch default do repo, o gate só barrava quando o default era `main` ou `master`. Em repo cujo default é `develop`/`trunk`, a entrega direta escapava do piso e reaparecia como o falso "zero commits ahead" (após push, `origin/<default>==HEAD`). `computeGitState` passa a derivar e retornar `defaultBranch` (nome bare de `origin/HEAD`, com fallback `origin/main`→`origin/master`), e o piso barra `main`, `master` ou o default real resolvido. Match exato (não substring), `typeof` guard para back-compat, fail-open preservado (default não-resolvível → piso volta a só main/master). Limitação conhecida documentada no JSDoc: quando `origin/HEAD` não está setado e o default real difere de main/master, o fallback por existência pode mis-derivar — resolução via `git ls-remote --symref` deixada como follow-up (evita rede num gate quente).

### Removed

## [0.14.2] - 2026-06-27

### Added

- **Convenção de issue form sempre carregada + advisory determinístico**: nova rule universal `core/rules/creating-issues.md` (carrega toda sessão, sem `paths:`) instrui a criar issues pelo form do repo (`.github/ISSUE_TEMPLATE/harness-task.yml`) — título `[harness] <slug>`, label `harness:ready`, campos `#uj`/`#ac`/scope/sensitive/priority/size que viram spec/locked_tests/scope_paths — em vez de `gh issue create` com corpo manual (o `gh` CLI ignora issue forms silenciosamente). Reforço determinístico dobrado no `entry-gate.mjs`: ao detectar `gh issue create` bare num repo que vendora o form, emite um aviso não-bloqueante (`additionalContext`, sem `permissionDecision` — nunca barra, nunca auto-aprova) apontando pro form. O advisory anexa só no caminho de allow não-delivery, então um comando composto com `git push` continua caindo nos trilhos de delivery. Propaga automático no re-vendor (rules/ e hooks/ são framework-owned), sem mudança em `settings.json`.

## [0.14.1] - 2026-06-27

### Fixed

- **entry-gate: falso "zero commits ahead of base" bloqueava delivery legítimo**: `defaultGitState()` resolvia a base do cálculo de "commits à frente" como o upstream do próprio feature branch (`@{u}`). Após `git push`, o upstream aponta para o mesmo commit que `HEAD`, zerando `@{u}..HEAD` e produzindo um deny falso que travava `git push` / `gh pr create` mesmo com commits reais à frente da main. A base passa a ser sempre o default branch do origin (`origin/HEAD` → `origin/main` → `origin/master`), contada via `rev-list --count <base>..HEAD`; nunca mais `@{u}`. Contrato fail-open preservado (base não-resolvível → `commitsAhead` null → nunca barra). Lógica de resolução extraída para `computeGitState(git)` puro/exportado e coberta por locked tests (AC-CORE: `upstream==HEAD` mas ahead-of-default > 0 → permite).

### Removed

## [0.14.0] - 2026-06-27

### Added

- **CI por projeto + gate de CI verde antes do release**: geração de `.github/workflows/ci.yml` com detecção de stack (node-test/vitest/jest); helper de branch protection (GET-then-merge, `enforce_admins=false`, sem review, required check = nome do job gerado) aplicado de forma operator-gated (`--apply`) para exigir o job de CI como check obrigatório; gate no fluxo de release que recusa tag enquanto CI estiver vermelho ou pendente (`gh pr checks --json state`). Modelo de 2 jobs fork-safe (job obrigatório sem secret + job de secret que pula em fork/Dependabot). Regra global aditiva (mandatory para projetos novos, advisory para existentes). Dogfooded no próprio harness com workflow real (CI verde no PR).

### Changed

### Fixed

### Removed

## [0.13.0] - 2026-06-26

### Added

- **Trilho de fidelidade (fidelity rail)**: o executor (mão barata) só é despachado depois que existe um teste escrito pela mão-de-teste e validado pelo compliance — congelado. Vale no modo local (spawn-hand) e na nuvem (headless). Fecha o furo em que a mão barata escrevia o próprio gate.
- **brief-serializer**: o briefing do executor passa a ser montado deterministicamente a partir da fatia do plano (spec, decisões, escopo, critérios, asserções) + fatos validados de tarefas anteriores — sem o orquestrador escrever código ou teste à mão.
- **descriptor-emitter**: a "ordem de serviço" da mão barata e o SHA do freeze são emitidos automaticamente no freeze-commit, eliminando a tentativa-e-erro de montar o descriptor na mão.
- **Marcador `fidelity-pass`**: sinal em disco que o gate consome para liberar o executor após o teste congelado passar pela validação de fidelidade.

### Changed

- **Princípio de relay no orquestrador**: a regra "o orquestrador não gera nada" foi substituída pela regra real e estreita — ele não autora código nem teste, apenas repassa a fatia do plano já validada por olhos/mãos mais fortes. O teste congelado é o oráculo concreto.

### Fixed

### Removed

## [0.12.0] - 2026-06-26

### Added

### Changed

- **hand_tiers com modelos Ollama reais**: a escada de exemplo da `creating-plans` passa a `qwen3-coder-next` (low) / `glm-5.2` (medium) / `kimi-k2.7-code` (high) — modelos que existem no endpoint Ollama. A skill agora exige que os ids do `hand_tiers` existam no endpoint (como listar) e avisa pra evitar `gpt-oss:*` (tool-use quebra em loop agêntico).

### Fixed

- **plano no formato legacy (Claude tiers) passava silenciosamente e quebrava no dispatch (404)**: a validação que rejeita o `model_strategy.tiers` legacy não era determinística (dependia do planner rodar `validate-plan`). Agora há cancela em duas camadas: (1) guard no `spawn-hand` — um model que é alias Claude (haiku/sonnet/opus) indo pro Ollama falha com razão clara em vez de 404 críptico; (2) o `plan-write-gate` valida o `model_strategy` no Write do plano e rejeita o shape legacy/sem `hand_tiers` antes de virar arquivo.
- **mão barata acusada de scope violation por arquivos untracked pré-existentes**: o `capture-hand` atribuía ao hand lixo de build pré-existente (dist/, coverage/, *.tsbuildinfo gitignored) que o clean-check (`git status --porcelain`) não enxerga mas o sweep `ls-files --others` enxerga. Agora um snapshot pré-spawn (path+hash) desconta os untracked pré-existentes **inalterados**; um arquivo novo ou um pré-existente **editado** (tamper) segue sinalizado — o controle de segurança fica intacto.
- **planner.md instruía salvar o plano como `plan.json`**, nome que o orquestrador/gate/reinject não leem (todos usam `execution-plan.json`). Reconciliado.

### Removed

## [0.11.0] - 2026-06-26

### Added

### Changed

- **cheap hands é LOCAL-only / HEADLESS roda hands em Claude**: em modo headless (`$CLAUDE_CODE_REMOTE` setado) o orquestrador não invoca o `spawn-hand.mjs`; despacha executor/sniper/test-author como `Agent` Claude normal, e o entry-gate passa a permitir Agent de role HAND nesse modo. Token Ollama ausente no cloud deixa de ser `hand-config-error` (vira não-evento). SKILL.md atualizado.
- **cheap hands (resolução de token)**: a fonte de token local passa a ser a env var `OLLAMA_HAND_TOKEN` (`export` no shell rc). Leituras de env sobrevivem ao command-sandbox; um token só no `.dev.vars` **não** é lido (o sandbox nega leitura de `.dev.vars`). O nome é inerte à auth do próprio Claude Code — `ANTHROPIC_AUTH_TOKEN` sequestraria a sessão-pai. `resolveAuthToken` aceita `OLLAMA_HAND_TOKEN` (preferencial) e `ANTHROPIC_AUTH_TOKEN` (compat/headless); `.dev.vars` segue como fallback; o childEnv mapeia pra `ANTHROPIC_AUTH_TOKEN`. SKILL.md atualizado.
- **entry-gate**: a mensagem de bloqueio de role HAND agora instrui o orquestrador a rodar `spawn-hand.mjs --descriptor` pra obter a `reason` exata do config-error (exit 2) e proíbe explicitamente inventar causa — em especial concluir que "spawn-hand.mjs não existe" (o script é vendored; o que falta quase sempre é o token). Aponta o fix (`export OLLAMA_HAND_TOKEN`).

### Fixed

- **mão barata nunca rodava sob o command-sandbox**: o `spawn-hand` despachado pelo orquestrador roda sob o sandbox, cujo `denyRead: ["**/.dev.vars"]` bloqueava o `resolveAuthToken` de ler o token → exit 2 "no ANTHROPIC_AUTH_TOKEN resolved" → caía em implementação inline silenciosa com mensagem enganosa, mesmo com o token presente no disco. Resolvido movendo a fonte do token pra env (`OLLAMA_HAND_TOKEN`), que o sandbox não bloqueia. Validado end-to-end (sob sandbox: `.dev.vars` falha, env passa).

### Removed

## [0.10.0] - 2026-06-26

### Added

- `triaging-requests`: QUICK ganha a porta `craft` — via rápida para artefatos visuais auto-contidos (página/quiz/landing/componente) roteados ao skill artesanal, pulando o pipeline pesado (executor→compliance→adversary→sniper). Mantém os trilhos determinísticos: glob da lista sensível nos arquivos tocados (substitui o override de `scope_paths`, ausente sem planner) + gates `tsc`/lint/build antes do commit. Override é **só-escala** ("caprichada/revisada" sobe pra LIGHT; "rápido" nunca rebaixa pedido sensível). Captura de lead no padrão do skill é pré-vetada; endpoint/integração nova escala pra LIGHT.

### Changed

### Fixed

### Removed

## [0.9.2] - 2026-06-17

### Added

### Changed

- Resolução de auth da mão barata é responsabilidade exclusiva do `spawn-hand.mjs` (env → projeto `.dev.vars` → global `~/.claude/.dev.vars`). O orquestrador não pré-checa nem inspeciona `.dev.vars`, e o token Ollama passa a ser tratado como precondição de setup (global no local, env secret no HEADLESS) — não algo a descobrir por task.
- Qualquer `exit 2` do `spawn-hand.mjs` vira exceção crítica citando o `reason` verbatim; o orquestrador não classifica a causa.

### Fixed

- `planner.md` dizia que o executor escreve o arquivo de teste (desatualizado no v2). Agora reflete que o `test-author` transcreve o teste e o executor o recebe read-only — eliminando a confusão de dispatch que levava o modelo a tentar `Agent` para criar testes.
- Falha de gate (captura via `capture-hand.mjs`) nunca é dispensada como "ambiental/sandbox" pela mensagem de erro — sempre escala. Fecha o falso-negativo em que uma falha real seria silenciada por um stack-trace que mencionasse `.dev.vars`.

### Removed

## [0.9.1] - 2026-06-15

### Added
- **Nova rule `architecture`** (carrega quando há código em `src/`, `app/` ou `worker/`): guia de fronteira de domínio que o harness não cobria — handler fino, tradução na borda (Anticorruption Layer, ex. integrações Stays/Meta), isolamento de shape (tipo de domínio ≠ linha de banco ≠ payload de terceiro), value object no lugar de obsessão primitiva, e lógica-junto-do-dado (sem modelo anêmico). Modelagem rica é condicional — o default é flat. Auto-carrega nativamente até na mão Ollama barata (`claude -p`).

### Changed
- **`plan-reviewer` audita fronteira de domínio e modelagem no tempo de plano** (keyed por severidade): a tradução de formato externo está isolada num task de borda ou vaza shape de terceiro pro core? Um task de alta severidade com invariante multi-passo está modelado rico ou espalhado num service anêmico? Numa feature flat, há camada especulativa sem core que a justifique?
- **Doc do `executor` corrigida:** descrevia o modo `--bare` aposentado. A mão barata roda como `claude -p` no cwd do projeto, então `CLAUDE.md` e rules do projeto **auto-carregam** nativamente — só skills (sem tool `Skill`) e o config global `~/.claude` (`CLAUDE_CONFIG_DIR` efêmero) não chegam.

## [0.9.0] - 2026-06-14

### Added
- **A mão Ollama barata agora dispara de verdade (wiring do live spawn — Part A).** Novo `runLiveDispatch(descriptor, {…})` em `spawn-hand.mjs` é a costura que faltava entre o andaime e o dispatch real: valida o descriptor, fail-close se o token vazar no descriptor/brief, reconcilia os dois universos git (árvore limpa + HEAD ancorado ao freeze, pra captura unscoped atribuir só o trabalho da mão), sobe `claude -p` ao vivo contra `https://ollama.com` (token só no env, `CLAUDE_CONFIG_DIR` efêmero), roda a captura INDEPENDENTE e grava um run-record sem token keyed por `feature_id/task_id`. Um CLI rodável (`node spawn-hand.mjs --descriptor <descriptor.json>`) + o comando exato e a receita do descriptor no `SKILL.md` (passos 1d/5) substituem o roteamento só-em-prosa que era a causa do bug never-fire (sessão `7fcc1009` do victor: 0 `claude -p`, 15 `escalation-fallback`). **Provado ao vivo:** a mão (`qwen3-coder-next`) autorou o diff in-scope e o teste congelado ficou verde na captura independente (`outcome DONE`).
- **Marker `hand-config-error`** (`mark.mjs` + `stamp-triage.mjs`, com `--reason` opcional) pro orchestrator carimbar um erro de config pré-spawn na rota de exceção crítica. Nunca autoriza uma mão Claude.

### Changed
- **O escape da mão barata agora se apoia em evidência on-disk não-forjável (Part B).** O branch de hand-routing do entry-gate antes liberava um `Agent(executor|sniper|test-author)` Claude no main-loop sempre que QUALQUER ticket `escalation_fallback` não-vazio existisse (forjável por echo). Agora libera o fallback Claude SÓ quando um ticket mapeia para um run-record on-disk (escrito pela captura independente do `runLiveDispatch`) cujo `outcome` é uma run genuína não-DONE (`FAILED` ou `NOT_DONE`), ancorado ao `freeze_commit_sha` e cruzado com o `HEAD` corrente — um record estale não autoriza uma escalação posterior que não falhou.
- **Escape de config-error explícito (contrato de exit-code).** `runLiveDispatch` RETORNA só em run genuína (record gravado) e LANÇA caso contrário, então o CLI classifica: `0` = DONE, `1` = `FAILED`/`NOT_DONE` genuíno (escalação K=1, autorizada pelo record on-disk), `2` = erro de config pré-spawn / exceção crítica (emite `{configError:true}`). O orchestrator roteia exit `2` pra exceção crítica — nunca um fallback Claude calado, nunca trava. Impede que token ausente trave a entrega.

### Fixed
- **Crash latente em `capture-hand.mjs`:** o CLI usava `readFileSync` sem importá-lo de `node:fs` — teria lançado `ReferenceError` no instante em que a captura ao vivo rodasse pelo CLI.

## [0.8.0] - 2026-06-14

### Added

### Changed
- **BREAKING: `hand_tiers` is now the only valid `model_strategy` shape.** The planner emits `hand_tiers` exclusively (cravado ladder `glm-5.1` → `deepseek-v4-pro` → `kimi-k2.7-code`), and `validate-plan` requires it. Previously the legacy Claude-only `tiers` shape was still accepted (validate-plan only warned), which let the executor/sniper silently resolve to expensive Claude and defeated the cheap-hands default — the root cause of plans that never routed hands to Ollama. A Claude hand is still reachable for a sensitive task by putting a Claude alias directly in a `hand_tiers` tier (values are free-form model ids; eyes still must be Claude aliases).

### Fixed
- **`settings.test.mjs` hook-count assertion was stale.** It expected exactly 5 wired hooks, but the `Write|Edit → plan-write-gate.mjs` PreToolUse hook added in the deterministic-rails work (#21) made the real count 6. The test now asserts 6 (it had been failing since #21).

### Removed
- **Legacy Claude-only `tiers` `model_strategy` shape.** `validate-plan` now hard-rejects a plan carrying `tiers` (clear error pointing to `hand_tiers`); `tiers` is dropped from `ALLOWED_MS_KEYS` and the back-compat prose is removed from `creating-plans`/`planner`/memory. Old archived plans authored with `tiers` no longer validate — they are historical artifacts and are not re-validated.

## [0.7.1] - 2026-06-14

### Added
- **Branch/commit delivery rail.** The push-gate (`entry-gate` `decideBash`) now denies a delivery command (`git push` / `gh pr create` / `gh pr merge`) when `HEAD` is on `main`/`master`, or (when a base ref resolves) when there are zero commits ahead of base — forcing the per-task commit series onto a feature branch, off protected `main`. The git probe is injected at the `processInput` (production) layer with a `decide()`-level no-op default, so it's live in the CLI but inert for unit callers; fail-open on any git error or unresolvable base. Closes the "uncommitted work / everything on main, yet still trying to deliver" gap — the rest of the per-task discipline (the freeze/impl split) is already load-bearing via the capture rail.

## [0.7.0] - 2026-06-14

### Added
- **Deterministic delivery rails — pipeline steps that were prose are now state-machine checks.** Four points where the orchestrator could silently skip a pipeline step ("the orchestrator must remember to…") became deterministic gates over `gate-state.json`, the same pattern already used for triage/planner/shipper:
  - **Plan-authorship rail** (`hooks/plan-write-gate.mjs`, new `PreToolUse(Write|Edit)` hook): only the dispatched `planner` subagent may write/edit a feature's `execution-plan.json`; the main-loop orchestrator is denied. Also blocks any tool write to `.claude/plans/.state/*.json` (gate-state/triage are hook-owned).
  - **Ollama hands as default**: `validate-plan` now warns (never rejects) on legacy Claude-only `tiers`, and `creating-plans`/`planner` emit the split `hand_tiers` ladder by default (`glm-5.1` → `deepseek-v4-pro` → `kimi-2.7`).
  - **Hand-routing rail** (`entry-gate.mjs`): a main-loop `Agent(executor|sniper|test-author)` is denied unless an `escalation_fallback` ticket exists — hands must route through `spawn-hand` (Ollama); the Claude `Agent` path is only the K=1 escalation/transcription fallback. New `mark.mjs escalation-fallback` marker stamps the ticket.
  - **Independent-capture rail** (`entry-gate.mjs` delivery-bash-gate): a delivery command is denied while any `hand_finished` task lacks a matching `capture_verified`. New `mark.mjs hand-finished`/`capture-verified` markers, routed through `stamp-triage` so Claude Code supplies the one authoritative `session_id` to producer and consumer.

### Changed
- **`test-author` reconciled as the third Ollama hand** (alongside `executor`/`sniper`): the agent doc and the "Hands vs Eyes" taxonomy now describe a spawn-hand (Ollama) hand resolving from `hand_tiers`, and the hand-routing rail gates it like the other hands.

### Fixed
- `resetGateState` now preserves `hand_finished`/`capture_verified` across a re-triage — the capture rail is a session-level delivery obligation like the re-gate rail, so a mid-session reclassify can no longer launder an un-captured hand.
- `plan-write-gate` path matching is case-insensitive (the operator's darwin FS is case-insensitive), closing an `Execution-Plan.json` / `.Claude/` bypass.

### Removed

## [0.6.2] - 2026-06-13

### Fixed
- **Path-coverage convention unified on git-pathspec (`isPathCovered`).** The pre-spawn baseline guard scopes via `git status --porcelain -- <entry>` (git pathspec = directory prefix by path component), but `isPathCovered`/`checkScope` treated an entry WITHOUT a trailing slash as an **exact file match**. For a no-slash directory entry (e.g. `core/x`) the two diverged — the guard covered files under it by prefix while the capture scope check demanded an exact match — yielding a dispatch that **always** failed in capture (fail-closed, but a confusing latent trap). `isPathCovered` now normalizes every entry to git-pathspec component semantics (`path === base || path.startsWith(base + "/")`), so a directory entry covers identically **with or without** the trailing slash — one source of truth shared by the guard, `checkScope`, `checkAllowedWrites`, and `checkFrozen`. The path-component boundary keeps `core/x` from bleeding into a sibling `core/xyz`, matching git. Out-of-contract pathspec MAGIC (`.`, glob `*`, empty entry) is explicitly **not** honored and fails closed in the violation checks. Adds `locked_test #7` proving consistent coverage of a no-slash directory entry and the fail-closed empty-entry behavior. (#17)

## [0.6.1] - 2026-06-13

### Added
- **Global Ollama token resolution.** A new `resolveAuthToken` resolves the cheap-hand auth token across `env.ANTHROPIC_AUTH_TOKEN` → `<cwd>/.dev.vars` → `~/.claude/.dev.vars` (global), so the operator sets the token **once** in `~/.claude/.dev.vars` and every project's cheap hand finds it — without exporting `ANTHROPIC_AUTH_TOKEN` into the shell (which would hijack Claude Code's own subscription auth). The token is still read-only from disk and injected only into the child process env. Aligns all three readers (dispatch/spawn/capture) on the same resolver.

### Changed

### Fixed

### Removed

## [0.6.0] - 2026-06-13

### Added
- **"Strong eyes, cheap hands" v2 — live Ollama dispatch (the plug is now wired).** v1 shipped the brain + rails; v2 launches the cheap hand for real and proves it end-to-end against ollama.com. Ships:
  - `spawn-hand.mjs` — the live spawn: `claude -p` (NOT `--bare`) against `ANTHROPIC_BASE_URL=https://ollama.com` with the auth token in the **child env only** (never argv/brief/settings), an **isolated ephemeral `CLAUDE_CONFIG_DIR`** seeded from the Stop-hook template, and the brief delivered to the hand via **stdin** (the user prompt). Fail-closed before spawn: refuses without an armed gate (locked_test must exist, be a file, and a dry-run must collect ≥1 test), without a resolved token, or onto a scope-dirty baseline.
  - `capture-hand.mjs` — the **independent capture (gate of record)**: the harness — never the model's prose — builds the child result from `git diff --name-only <freeze_sha>` ∪ `git ls-files --others` (+ a no-exclude sweep so a gitignored write can't escape scope/frozen/allowed-write), an **independent** `node --test` run with a vacuous-green guard (last anchored `# tests N`; 0/missing → FAILED), a `HEAD == freeze_sha` precondition, a required token (redaction is never a silent no-op), and live-tee + on-disk redaction. Feeds the v1 fail-closed `evaluateRun`.
  - `hand-config/` — the Stop-hook `CLAUDE_CONFIG_DIR` template + a pure `resolveHookCommand` (absolute `node --test <path>`, never `${CLAUDE_PROJECT_DIR}`); reaches consumers via vendor-core's recursive `skills/` copy (pinned by an exported `isFrameworkCopyIncluded` predicate).
  - `derisk-metrics.mjs` — pure cost-NDJSON parser (`toolCallErrorCount`, `gpuTimeMs`, `contextTokens`) — the data-driven signal to retire a net-negative cheap tier.
  - `dispatch-hand.mjs` hardened: a benign Ollama `count_tokens` 404 is forgiven across the stdout/json channels while a co-occurring real upstream error (5xx/401/403/429) is never swallowed; captured stdout/stderr are truncated (redact before truncate).
  - **Live-proven (AC v2.1):** a `qwen3-coder-next` hand implemented a real task, landed a correct diff that passed its frozen test with scope respected, and the independent capture stamped `captured:true` → DONE.

### Changed
- `orchestrating-delivery` Phase 2 wiring: **all hand roles route to the live Ollama spawn** — executor (low/medium/**high**) and sniper (all severities) — with only eye roles staying on Claude; Claude is reachable by a hand only via the K=1 escalation fallback. Executor-high resolves to `hand_tiers.high`, with the AC v2.7 de-risk metering as the data-driven revert trigger (supersedes the deferred v3 model A/B by operator decision). The sniper-HIGH mandatory strong-eye re-gate + `regate-pending`/`regate-passed` rails are unchanged. The spec's `--bare` is corrected to `claude -p` + isolated config everywhere (`--bare` skips hooks, which would kill the Stop-hook gate).
- **Model routing:** Fable 5 retired — the two boundary gates (plan-reviewer, final-gate adversary) fall back to opus; `fable` removed from the validator's `CLAUDE_ALIASES`.

### Fixed

### Removed

## [0.5.0] - 2026-06-12

### Added
- **"Strong eyes, cheap hands" v1 — scaffold, rails, gates, and docs.** Code-writing roles (executor, sniper, new `test-author` agent) can be routed to cheap Ollama-cloud models via `claude --bare -p` external dispatch, while judging/review roles stay on Claude. Ships:
  - `model_strategy` split: validator gains `hand_tiers` (Ollama model ids keyed to low/medium/high) vs eye roles (always Claude); back-compat with legacy single-`tiers` plans; unknown keys rejected; eye→Ollama enforced + table-driven test covering all 7 eye roles.
  - `dispatch-hand.mjs` — external-process runner (pure functions + CLI): token redaction, per-dispatch allowed-write set, scope-check (truth = git diff + `captured:true` flag, never model prose), fail-closed on missing capture, frozen-manifest violation = automatic gate failure, upstream errors truncated to 500 chars after redaction.
  - Deterministic test rail: planner pins concrete-observable assertion → `test-author` (cheap hand, tools exactly `[Read, Write]`) transcribes ONE assertion into ONE test file → compliance (Claude eye) validates fidelity pre-freeze → content-hash manifest frozen → executor implements against read-only frozen test → Stop hook gates on green (documented v2 artifact; v1 ships the contract and rail).
  - Sniper → cheap Ollama hand + mandatory strong-eye (Claude) re-gate rail: `mark.mjs` markers → `stamp-triage` persists `regate_pending` → entry-gate blocks both the shipper Agent dispatch and direct Bash delivery while a re-gate is outstanding; survives compaction.
  - Executor escalation: re-dispatches the executor (never sniper), stash-discard the failed attempt; per-task commit series (freeze-commit → impl-commit) makes reset trivially safe.
  - `core/dev.vars.example` placeholder added; `vendor-core` REPO_FILES distributes `.dev.vars.example` to consumer projects; `.dev.vars` gitignored at repo root and ensured-ignored in consumer projects via `ensureDevVarsIgnored`.
  - Migration/SQL rule in `creating-plans/SKILL.md`: locked_test on a cheap hand must spin an ephemeral DB and assert post-migration state — not a text-match.
  - Design decisions (no git worktree in v1; working-tree + per-dispatch allowlist as the containment boundary) documented in `core/CLAUDE.md` compact instructions.
  - **v2 next step:** live `claude --bare -p` spawn integration and the Stop-hook binary are the documented v2 deliverables; v1 ships the contract, rails, scaffold, gates, and docs.

### Changed

### Fixed

### Removed

## [0.4.1] - 2026-06-11

### Added
- **Skill `updating-harness`** — atalho de uma chamada para instalar/atualizar o harness no projeto atual, com a URL do repo-fonte embutida (sem copiar/colar URL). Detecta install-vs-update, fixa na última release do GitHub (`--ref <tag>`), reporta o que mudou e re-vendora via `vendor-core` sem clobberar memória/kaizen/settings.

## [0.4.0] - 2026-06-11

### Added
- **Medidor de custo na entrega** — skill `measuring-cost` (invocada pelo harvester) reporta o custo equivalente-API da sessão com breakdown por modelo + a tendência semanal de consumo do Claude Code (todos os projetos), via `ccusage` sobre o transcript JSONL local. Fail-soft quando ccusage não está acessível (offline / cloud headless). Não persiste números em arquivos commitados — é telemetria de run, não conhecimento durável; o medidor semanal é proxy relativo de consumo real, nunca % da subscription (opaca).

## [0.3.0] - 2026-06-11

### Changed
- **Estado efêmero de sessão movido para `.claude/plans/.state/<session_id>/`** — `gate-state.json` e `triage.json` saem da raiz de `plans/` para uma subpasta pontilhada, deixando a listagem de `.claude/plans/` com apenas as pastas legíveis por feature (`<feature_id>/`). O plano durável continua keyed por `feature_id` na raiz, preservando a resiliência (artefato insubstituível atrás de chave re-derivável, não do `session_id` opaco). O GC do `reinject-state` passa a escanear só `.state/`.
- **Orquestrador Sonnet cravado como default** — removida a marcação "under validation" da tabela de model routing; documentado em `docs/usage.md`. A economia do harness vem do orquestrador barato no alto volume; premium (Opus/Fable) só nos sub-agentes de fronteira, sustentado por trilhos determinísticos.

### Fixed
- **Orquestrador atalhava `creating-plans` em vez de dispatchar o `planner`** — com Sonnet no main loop, a skill interna do agente planner (sempre Opus) era invocada direto, gerando o plano no orquestrador e perdendo o isolamento de contexto e o routing de modelo. Guard `<PLANNER-ONLY>` no topo do `SKILL.md` + `description` marcada INTERNAL forçam o dispatch do agente `planner`.

## [0.2.1] - 2026-06-11

### Fixed
- **Gate silenciosamente inerte em path com espaço/symlink** — o guard de CLI dos hooks comparava `import.meta.url` (URL-encoded, símlinks resolvidos) com `file://${argv[1]}` (cru); num projeto cujo caminho tem espaço (`/Users/x/My Project`) ou está atrás de symlink, `main()` não rodava e o hook liberava tudo (falsa sensação de proteção). Agora usa `fileURLToPath` + `realpathSync`. Coberto por teste de integração que executa o hook como CLI real.
- `triage.json` passa a usar tmp-path com sufixo de pid na escrita atômica (consistência com o `gate-lib`, evita colisão concorrente).

## [0.2.0] - 2026-06-11

### Added
- **Trava determinística de entrada (entry-gate)** — interlock de runtime via hooks do Claude Code que força a cerimônia do harness (triagem → brainstorm → spec-adversary → plano) mesmo com um orquestrador Sonnet mais fraco no comando. Componentes em `core/hooks/`:
  - `entry-gate.mjs` (PreToolUse `Agent`): bloqueia dispatch de papéis de entrega sem `triage.json`; bloqueia o `planner` sem `brainstormed` + `adversary_fired`. Fail-open em erro de infra; só age no main-loop (ignora chamadas com `agent_id`).
  - `stamp-triage.mjs` (PostToolUse `Bash`): carimba `triage.json` com `session_id` autoritativo do payload e registra `brainstormed`; reconhece os marcadores `classify.mjs`/`mark.mjs` (desembrulha `tool_output.stdout`).
  - `classify.mjs` / `mark.mjs`: CLIs de marcador que o modelo roda ao fim da triagem / do brainstorm.
  - `reinject-state.mjs` (SessionStart `compact`/`startup`): re-injeta o estado do plano após compactação (recuperabilidade pro Sonnet) e faz GC conservador de dirs de estado obsoletos.
  - `lib/gate-lib.mjs`: validadores compartilhados (`isSafeFeatureId`, `isSafeSessionId`, `isDeliveryRole`, `bareRole`) + I/O atômico de `gate-state.json` (read-merge-write temp→rename).
- Seção `# Compact instructions` em `core/CLAUDE.md` (compactação harness-aware).
- Hooks vendorados pra projetos adotantes (`vendor-core.mjs` passa a copiar `core/hooks/`, excluindo `*.test.mjs`).
- Baseline de release: `CHANGELOG.md`.

### Changed
- `complexity-scorer.mjs`: recalibrado com a lógica otimizada do harness OpenCode (await-only, sem else/case, dirs ancorados, caps de import/serviço, `LINES_PER_POINT` 50), preservando o contrato de 4 bandas (low/medium/high/x-high) do Claude Code.
- `orchestrating-delivery/SKILL.md`: spec-adversary agora é **obrigatório em ambos LIGHT e FULL** (antes o FULL adiava pro per-task); Phase 0 termina com o marcador `brainstorm-done`.
- `triaging-requests/SKILL.md`: passo final roda `classify.mjs` (carimba o `triage.json`) antes do dispatch de entrega.

## [0.1.0] - 2026-06-10

### Added
- Marco inicial do Claude Harness (entry policy, agents, skills, rules, modelo de memória, model routing barbell).

[Unreleased]: https://github.com/orobsonn/claude-harness/compare/v0.26.0...HEAD
[0.26.0]: https://github.com/orobsonn/claude-harness/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/orobsonn/claude-harness/compare/v0.24.0...v0.25.0
[0.2.0]: https://github.com/orobsonn/claude-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/orobsonn/claude-harness/releases/tag/v0.1.0
