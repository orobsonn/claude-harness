/**
 * @description Testes da peça plan-write-gate da lane Pi. Espelham os casos de
 * core/opencode/plugin/plan-write-gate.test.mjs (metade pura), trocando o prefixo de estado por
 * `.pi/harness/state/` e a autoridade de planner (SDK do OC → dispatch-record do Pi).
 * Onde a mensagem é agnóstica de prefixo, o teste compara literalmente com a reason produzida
 * pelo `decide()` do OC — parity assertion, não string copiada à mão.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { decide as ocDecide } from "../../opencode/plugin/lib/plan-write-decide.mjs";
import {
  decidePiPlanWrite,
  isPiCanonicalPlanPath,
  isPiFrozenToolingPath,
  isPiLiteralCanonicalPlanMutation,
  isPiLiteralStateMutation,
  isPiStateFilePath,
  piAntiForgeDecision,
  resolvePiPlannerIdentity,
} from "./plan-write-decide.mjs";

const GATE_STATE = ".pi/harness/state/ses-1/gate-state.json";
const CANONICAL = ".pi/harness/plans/feat-x/execution-plan.json";

/** @description Dispatch-record armado de mão (vocabulário Pi) para o rail de escopo. */
function handRecord(overrides = {}) {
  return {
    feature_id: "feat-x",
    task_id: "t1",
    role: "harness-executor",
    scope_paths: ["src/a.ts"],
    allowed_writes: [],
    ...overrides,
  };
}

/** @description Prova de planner: sessão filha com dispatch-record de papel harness-planner. */
const PLANNER_PROOF = { isSubagent: true, dispatchRecord: { role: "harness-planner" } };

// --------------------------------------------------------------------------------------------
// Oráculos de caminho
// --------------------------------------------------------------------------------------------

test("oráculo de estado casa .pi/harness/state/**.json, inclusive absoluto e após decoy", () => {
  assert.equal(isPiStateFilePath(GATE_STATE), true);
  assert.equal(isPiStateFilePath("/home/u/proj/.pi/harness/state/ses/other.json"), true);
  assert.equal(isPiStateFilePath("/tmp/.pi/work/proj/.pi/harness/state/s/other.json"), true);
  assert.equal(isPiStateFilePath(".pi/harness/state/ses/notes.md"), false);
  assert.equal(isPiStateFilePath(".pi/harness/plans/feat-x/execution-plan.json"), false);
  assert.equal(isPiStateFilePath(".opencode/plans/.state/s/gate-state.json"), false);
  assert.equal(isPiStateFilePath(null), false);
});

test("oráculo de plano canônico casa .pi/harness/plans/<feat>/execution-plan.json e nunca state", () => {
  assert.equal(isPiCanonicalPlanPath(CANONICAL), true);
  assert.equal(isPiCanonicalPlanPath("/work/proj/.pi/harness/plans/feat-x/execution-plan.json"), true);
  assert.equal(isPiCanonicalPlanPath(".pi/harness/plans/state/execution-plan.json"), false);
  assert.equal(isPiCanonicalPlanPath(".pi/harness/state/ses/execution-plan.json"), false);
  assert.equal(isPiCanonicalPlanPath(".pi/harness/plans/execution-plan.json"), false);
  assert.equal(isPiCanonicalPlanPath("src/execution-plan.json"), false);
});

test("tooling congelado da lane Pi (relativo exato e sufixo absoluto)", () => {
  for (const rel of [
    ".pi/harness/extensions/harness-marker.ts",
    ".pi/harness/lib/marker-authority.mjs",
    "core/pi/extensions/harness-marker.ts",
  ]) {
    assert.equal(isPiFrozenToolingPath(rel), true, rel);
    assert.equal(isPiFrozenToolingPath(`./${rel}`), true, rel);
    assert.equal(isPiFrozenToolingPath(`/work/project/${rel}`), true, rel);
  }
  assert.equal(isPiFrozenToolingPath("core/pi/extensions/harness-policy.ts"), false);
});

// --------------------------------------------------------------------------------------------
// Anti-forja por caminho — mensagens idênticas à lane OC
// --------------------------------------------------------------------------------------------

test("write em .pi/harness/state/<sid>/gate-state.json é negado com a mensagem do OC", () => {
  const r = decidePiPlanWrite({ filePath: GATE_STATE });
  assert.equal(r.allow, false);
  assert.equal(
    r.reason,
    "[plan-write-gate] Blocked: gate-state/triage written ONLY by harness markers, never Write/Edit.",
  );
  // Parity: mesma frase que o OC produz para o seu próprio gate-state.
  assert.equal(
    r.reason,
    ocDecide({ tool_input: { file_path: ".opencode/plans/.state/ses-1/gate-state.json" } }).reason,
  );
});

test("write em triage.json sob .pi/harness/state é negado", () => {
  const r = decidePiPlanWrite({ filePath: ".pi/harness/state/ses-1/triage.json" });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /gate-state\/triage/);
});

test("outros JSONs sob .pi/harness/state levam a mensagem com o prefixo Pi", () => {
  const r = decidePiPlanWrite({ filePath: "/home/u/proj/.pi/harness/state/ses/other.json" });
  assert.equal(r.allow, false);
  assert.equal(
    r.reason,
    "[plan-write-gate] Blocked: .pi/harness/state/ JSONs written ONLY by harness markers.",
  );
  // Mesma frase do OC, trocado só o prefixo de diretório de estado.
  assert.equal(
    r.reason,
    ocDecide({ tool_input: { file_path: "/home/u/proj/.opencode/plans/.state/ses/other.json" } })
      .reason?.replace(".opencode/plans/.state/", ".pi/harness/state/"),
  );
});

test("decoy .pi anterior não engana o oráculo de estado", () => {
  const r = decidePiPlanWrite({ filePath: "/tmp/.pi/work/proj/.pi/harness/state/s/other.json" });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /\.pi\/harness\/state|harness markers/);
});

test("traversal para o estado continua negado (sem bypass por carve)", () => {
  const r = decidePiPlanWrite({ filePath: "../../../__fixtures__/.pi/harness/state/s/gate-state.json" });
  assert.equal(r.allow, false);
});

test("carve-out de fixture passa, mas nunca para o basename vivo do oráculo", () => {
  assert.equal(decidePiPlanWrite({ filePath: "__fixtures__/gate-state.test.json" }).allow, true);
  assert.equal(decidePiPlanWrite({ filePath: "__fixtures__/.pi/harness/state/s/other.json" }).allow, true);
  const live = decidePiPlanWrite({ filePath: ".pi/harness/state/ses.test.x/gate-state.json" });
  assert.equal(live.allow, false);
  assert.match(live.reason ?? "", /gate-state|harness markers/);
});

test("caminho ausente é fail-closed com a mensagem do OC", () => {
  const r = decidePiPlanWrite({ filePath: "" });
  assert.equal(r.allow, false);
  assert.equal(
    r.reason,
    "[plan-write-gate] Blocked: write/edit path missing — cannot validate anti-forge oracle.",
  );
  assert.equal(r.reason, ocDecide({ tool_input: {} }).reason);
});

test("scripts marcadores (mark/classify sob hooks) são somente-leitura", () => {
  for (const filePath of ["core/pi/hooks/mark.mjs", ".pi/hooks/classify.mjs"]) {
    const r = decidePiPlanWrite({ filePath });
    assert.equal(r.allow, false, filePath);
    assert.equal(
      r.reason,
      "[plan-write-gate] Blocked: harness marker scripts (mark/classify) are read-only via Write/Edit.",
    );
  }
});

test("tooling congelado da lane Pi é negado com a mensagem de anti-forgery do OC", () => {
  const r = decidePiPlanWrite({ filePath: "core/pi/extensions/harness-marker.ts" });
  assert.equal(r.allow, false);
  assert.equal(
    r.reason,
    "[plan-write-gate] Blocked: allowlisted tooling scripts are read-only via Write/Edit (anti-forgery).",
  );
  assert.equal(
    r.reason,
    ocDecide({ tool_input: { file_path: "core/opencode/plugin/marker-authority.ts" } }).reason,
  );
});

test("tooling congelado da lane OC segue negado numa sessão Pi (rail importado)", () => {
  const r = decidePiPlanWrite({
    filePath: "core/claude-code/skills/initializing-projects/references/vendor-core.mjs",
  });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /tooling|anti-forgery/);
});

test("write em package.json é permitido", () => {
  assert.equal(decidePiPlanWrite({ filePath: "package.json" }).allow, true);
  assert.equal(decidePiPlanWrite({ filePath: "src/app.ts" }).allow, true);
  assert.equal(decidePiPlanWrite({ filePath: "/tmp/unrelated/notes.json" }).allow, true);
});

// --------------------------------------------------------------------------------------------
// Autoria do plano canônico
// --------------------------------------------------------------------------------------------

test("write no execution-plan.json sem prova de planner é negado", () => {
  const r = decidePiPlanWrite({ filePath: CANONICAL });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /^\[plan-write-gate\] Blocked: official planner identity required \(/);
});

test("write no execution-plan.json com prova de planner é permitido", () => {
  const r = decidePiPlanWrite({ filePath: CANONICAL }, PLANNER_PROOF);
  assert.equal(r.allow, true);
});

test("prova de planner exige sessão filha e papel planner no dispatch-record", () => {
  assert.deepEqual(resolvePiPlannerIdentity({ isSubagent: true, dispatchRecord: { role: "harness-planner" } }), {
    ok: true,
    role: "planner",
  });
  assert.equal(resolvePiPlannerIdentity({ isSubagent: false, dispatchRecord: { role: "harness-planner" } }).ok, false);
  assert.equal(resolvePiPlannerIdentity({ isSubagent: true, dispatchRecord: null }).ok, false);
  assert.equal(resolvePiPlannerIdentity({ isSubagent: true, dispatchRecord: { role: "harness-executor" } }).ok, false);
  assert.equal(resolvePiPlannerIdentity().ok, false);
});

test("prova inválida no plano canônico carrega o motivo dentro da mensagem", () => {
  const r = decidePiPlanWrite(
    { filePath: CANONICAL },
    { isSubagent: true, dispatchRecord: { role: "harness-executor" } },
  );
  assert.equal(r.allow, false);
  assert.equal(
    r.reason,
    "[plan-write-gate] Blocked: official planner identity required (active dispatch role is not planner).",
  );
});

test("nenhum papel de mão vira planner: executor com escopo largo não escreve o plano canônico", () => {
  const r = decidePiPlanWrite(
    { filePath: CANONICAL },
    {
      isSubagent: true,
      actingRole: "harness-executor-high",
      dispatchRecord: handRecord({ scope_paths: [".pi/harness/plans/"] }),
    },
  );
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /planner identity required/);
});

test("piAntiForgeDecision isolado usa a frase planner-only do OC", () => {
  const denied = piAntiForgeDecision({ filePath: CANONICAL });
  assert.equal(denied.allow, false);
  assert.equal(denied.reason, "[plan-write-gate] Blocked: canonical plan authorship is planner-only.");
  assert.equal(
    denied.reason,
    ocDecide({ tool_input: { file_path: ".opencode/plans/feat-x/execution-plan.json" } }).reason,
  );
  assert.equal(piAntiForgeDecision({ filePath: CANONICAL }, { actingRole: "harness-planner" }).allow, true);
  assert.equal(piAntiForgeDecision({ filePath: CANONICAL }, { actingRole: "planner" }).allow, true);
});

// --------------------------------------------------------------------------------------------
// Fricção literal de Bash
// --------------------------------------------------------------------------------------------

test("mutação literal do estado Pi via Bash é negada; leituras seguem livres", () => {
  const absolute = `/work/project/${GATE_STATE}`;
  for (const command of [
    `echo x > ${GATE_STATE}`,
    `node -e 'require("fs").writeFileSync("${GATE_STATE}", "{}")'`,
    `python3 -c 'open("${GATE_STATE}", "w").write("{}")'`,
    `sed -i 's/false/true/' ${GATE_STATE}`,
    `printf '{}' | tee ${GATE_STATE}`,
    `rm -f ${GATE_STATE}`,
    `truncate -s 0 ${GATE_STATE}`,
    `mv /tmp/new.json ${GATE_STATE}`,
    `cp /tmp/new.json ${GATE_STATE}`,
    `python3 - <<'PY'\nopen("${absolute}", "w").write("{}")\nPY`,
    `cd .pi/harness && python3 -c 'open("state/ses-1/gate-state.json", "w").write("{}")'`,
    `cd .pi/harness && printf '{}' | tee state/ses-1/gate-state.json`,
    `cd .pi/harness/state/ses-1 && tee gate-state.json`,
  ]) {
    const decision = decidePiPlanWrite({ command });
    assert.equal(decision.allow, false, command);
    assert.equal(
      decision.reason,
      "[plan-write-gate] Blocked: literal Bash mutation of harness state is denied (anti-forge rail).",
      command,
    );
  }
  for (const command of [
    `cat ${GATE_STATE}`,
    `git diff -- ${GATE_STATE}`,
    `cp ${GATE_STATE} /tmp/state-copy.json`,
    `ls .pi/harness/state`,
  ]) {
    assert.equal(decidePiPlanWrite({ command }).allow, true, command);
  }
});

test("mutação literal do plano canônico Pi via Bash é frictionada; leituras passam", () => {
  const absolute = `/work/project/${CANONICAL}`;
  for (const command of [
    `echo '{}' > ${CANONICAL}`,
    `tee ${CANONICAL}`,
    `rm ${CANONICAL}`,
    `sed -i 's/a/b/' ${CANONICAL}`,
    `mv ${CANONICAL} /tmp/archive.json`,
    `mv /tmp/new.json ${CANONICAL}`,
    `cp /tmp/new-plan.json ${absolute}`,
    `rsync /tmp/new-plan.json ${CANONICAL}`,
    `truncate -s 0 ${absolute}`,
    `echo x | tee ${CANONICAL}`,
  ]) {
    const decision = decidePiPlanWrite({ command });
    assert.equal(decision.allow, false, command);
    assert.equal(
      decision.reason,
      "[plan-write-gate] Blocked: literal Bash mutation of canonical plan is denied (best-effort friction).",
      command,
    );
  }
  for (const command of [
    `cat ${CANONICAL}`,
    `cp ${CANONICAL} /tmp/plan-copy.json`,
    `rsync ${absolute} /tmp/plan-copy.json`,
    `git diff -- ${CANONICAL} > /tmp/plan.diff`,
    `cat ${CANONICAL} | tee /tmp/plan-copy.json`,
    `tee /tmp/plan-copy.json < ${CANONICAL}`,
    `echo tee && cat ${CANONICAL}`,
  ]) {
    assert.equal(decidePiPlanWrite({ command }).allow, true, command);
  }
});

test("oráculos literais nus concordam com a decisão composta", () => {
  assert.equal(isPiLiteralStateMutation(`echo x > ${GATE_STATE}`), true);
  assert.equal(isPiLiteralStateMutation(`cat ${GATE_STATE}`), false);
  assert.equal(isPiLiteralStateMutation(null), false);
  assert.equal(isPiLiteralCanonicalPlanMutation(`echo '{}' > ${CANONICAL}`), true);
  assert.equal(isPiLiteralCanonicalPlanMutation(`cat ${CANONICAL}`), false);
  assert.equal(isPiLiteralCanonicalPlanMutation(42), false);
});

test("comando Bash da lane Pi ainda não forja o estado da lane OC (backstop importado)", () => {
  const decision = decidePiPlanWrite({
    command: "printf '{}' | tee .opencode/plans/.state/session/gate-state.json",
  });
  assert.equal(decision.allow, false);
  assert.match(decision.reason ?? "", /literal Bash mutation of harness state/);
});

test("comando comum passa", () => {
  assert.equal(decidePiPlanWrite({ command: "npm test" }).allow, true);
  assert.equal(decidePiPlanWrite({ command: "node --test core/pi/lib" }).allow, true);
});

// --------------------------------------------------------------------------------------------
// Rail de escopo (importado do OC, exercitado com vocabulário Pi)
// --------------------------------------------------------------------------------------------

test("write de executor fora do escopo é negado", () => {
  const r = decidePiPlanWrite(
    { filePath: "src/b.ts" },
    { actingRole: "harness-executor-high", isSubagent: true, dispatchRecord: handRecord() },
  );
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /src\/b\.ts/);
  assert.match(r.reason ?? "", /OUTSIDE its dispatch scope/);
  assert.match(r.reason ?? "", /feat-x\/t1/);
});

test("write de executor dentro do escopo é permitido (arquivo e prefixo de diretório)", () => {
  assert.equal(
    decidePiPlanWrite(
      { filePath: "src/a.ts" },
      { actingRole: "harness-executor-high", isSubagent: true, dispatchRecord: handRecord() },
    ).allow,
    true,
  );
  assert.equal(
    decidePiPlanWrite(
      { filePath: "src/lib/foo.ts" },
      {
        actingRole: "harness-executor",
        isSubagent: true,
        dispatchRecord: handRecord({ scope_paths: ["src/lib"] }),
      },
    ).allow,
    true,
  );
  assert.equal(
    decidePiPlanWrite(
      { filePath: "docs/x.md" },
      {
        actingRole: "harness-executor",
        isSubagent: true,
        dispatchRecord: handRecord({ allowed_writes: ["docs/x.md"] }),
      },
    ).allow,
    true,
  );
});

test("entrada de escopo que é arquivo não vira prefixo de diretório", () => {
  const r = decidePiPlanWrite(
    { filePath: "src/a.ts/evil.ts" },
    { actingRole: "harness-executor-high", isSubagent: true, dispatchRecord: handRecord() },
  );
  assert.equal(r.allow, false);
});

test("oráculo congelado do dispatch nega antes do escopo largo permitir", () => {
  for (const role of ["harness-executor-high", "harness-sniper-high"]) {
    const r = decidePiPlanWrite(
      { filePath: "src/oracle.test.mjs" },
      {
        actingRole: role,
        isSubagent: true,
        dispatchRecord: handRecord({
          role,
          scope_paths: ["src/"],
          frozen_paths: ["src/oracle.test.mjs"],
        }),
      },
    );
    assert.equal(r.allow, false, role);
    assert.match(r.reason ?? "", /frozen acceptance oracle/, role);
  }
});

test("subagente sob dispatch armado sem identidade de mão é negado (sem fail-open)", () => {
  const r = decidePiPlanWrite(
    { filePath: "src/b.ts" },
    { actingRole: "", isSubagent: true, dispatchRecord: handRecord() },
  );
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /cannot verify acting role identity/);
});

test("família de mão diferente continua fail-open", () => {
  const r = decidePiPlanWrite(
    { filePath: "src/b.ts" },
    {
      actingRole: "harness-executor",
      isSubagent: true,
      dispatchRecord: handRecord({ role: "harness-sniper", scope_paths: ["src/fix.ts"] }),
    },
  );
  assert.equal(r.allow, true);
});

test("sem dispatch-record o rail fica desarmado (fail-open)", () => {
  assert.equal(
    decidePiPlanWrite(
      { filePath: "src/anywhere.ts" },
      { actingRole: "harness-executor-high", isSubagent: true, dispatchRecord: null },
    ).allow,
    true,
  );
  assert.equal(
    decidePiPlanWrite(
      { filePath: "src/anywhere.ts" },
      { actingRole: "harness-executor-high", isSubagent: false, dispatchRecord: handRecord() },
    ).allow,
    true,
  );
  assert.equal(
    decidePiPlanWrite(
      { filePath: "src/anywhere.ts" },
      { actingRole: "harness-executor-high", isSubagent: true, dispatchRecord: handRecord({ scope_paths: [] }) },
    ).allow,
    true,
  );
});

test("anti-forja vence um escopo armado que inclua o caminho de estado", () => {
  const r = decidePiPlanWrite(
    { filePath: GATE_STATE },
    {
      actingRole: "harness-executor-high",
      isSubagent: true,
      dispatchRecord: handRecord({ scope_paths: [GATE_STATE] }),
    },
  );
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /gate-state\/triage/);
});

test("alvo malformado nunca lança e é fail-closed por caminho ausente", () => {
  for (const target of [null, undefined, 42, [], {}]) {
    const r = decidePiPlanWrite(target);
    assert.equal(r.allow, false);
    assert.match(r.reason ?? "", /path missing/);
  }
  assert.equal(decidePiPlanWrite("src/app.ts").allow, true);
});

test("planner provado autoriza SOMENTE o plano canônico (frase do gate do OC)", () => {
  const r = decidePiPlanWrite({ filePath: "src/app.ts" }, PLANNER_PROOF);
  assert.equal(r.allow, false);
  assert.equal(
    r.reason,
    "[plan-write-gate] Blocked: planner may author only canonical execution plans.",
  );
  const spec = decidePiPlanWrite({ filePath: ".pi/harness/plans/feat-x/spec.md" }, PLANNER_PROOF);
  assert.equal(spec.allow, false);
  assert.match(spec.reason ?? "", /planner may author only canonical execution plans/);
  // O mesmo caminho sem prova de planner segue permitido (o rail é da identidade, não do arquivo).
  assert.equal(decidePiPlanWrite({ filePath: "src/app.ts" }).allow, true);
  // E a prova segue autorizando o plano canônico.
  assert.equal(decidePiPlanWrite({ filePath: CANONICAL }, PLANNER_PROOF).allow, true);
});

test("plannerIdentity injetado pelo adaptador tem a mesma força da prova resolvida", () => {
  assert.equal(
    decidePiPlanWrite({ filePath: CANONICAL }, { plannerIdentity: { ok: true, role: "planner" } }).allow,
    true,
  );
  const denied = decidePiPlanWrite(
    { filePath: CANONICAL },
    { plannerIdentity: { ok: false, reason: "pi dispatch records unavailable" } },
  );
  assert.equal(denied.allow, false);
  assert.equal(
    denied.reason,
    "[plan-write-gate] Blocked: official planner identity required (pi dispatch records unavailable).",
  );
});
